//! The hosted OMP launch (DESIGN 4.2; HOST req. 17-22): the command line built from structured
//! config, the child environment allow-list and the settings overlay.
//!
//! The overlays (one for the lead, one for lanes) are written once per hub run, owner-only. They pin
//! `ask.timeout: 0` (questions never time out), goal mode on with continuation in rpc mode for lanes
//! and off for the lead, every per-window saved-reset auto-redeem key to `no` (OJ-13; the five keys
//! OMP 19.1.1 defines, see [`NO_REDEEM`]), and OMP's own model fallback on with `cooldown-expiry`
//! revert (decision 7, OJ-10/11). `retry.fallbackOn` and `retry.fallbackChains` appear only when the
//! owner set them in Cataly's `[fallback]` section; Cataly never invents a chain. Approvals follow
//! the owner's own OMP settings: no approval mode and no shell patterns are set here (decision 19,
//! DESIGN 12.2 A13). Every hidden tool comes from the policy table ([`tools::STOCK`]): eval is
//! hidden by `eval.py: false`, `eval.js: false` and `archive.enabled: false` (its archive prelude),
//! and its approval is denied. OMP ranks a setting's own environment variable (`PI_PY`, `PI_JS`)
//! above `--config` and fills an unset one from `.env` files, so every launch also sets each bound
//! variable to the overlay's value ([`policy_env`], [`tools::ENV`]), last in its environment. JSON
//! is valid YAML, so the overlay is written as JSON.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use super::tools::{self, Class, Role};
use crate::config::session::FallbackSettings;
use crate::sys::fs::{FsError, write_atomic};

/// Fresh session in a known directory, or an exact resume of a session file (HOST req. 9).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Target {
    Fresh(PathBuf),
    Resume(PathBuf),
}

/// One hosted OMP launch.
#[derive(Debug, Clone)]
pub(crate) struct Launch<'a> {
    pub(crate) exe: &'a Path,
    /// `provider/id`.
    pub(crate) model: &'a str,
    pub(crate) thinking: Option<&'a str>,
    pub(crate) target: &'a Target,
    pub(crate) overlay: &'a Path,
    /// Role instructions file (`--append-system-prompt`).
    pub(crate) instructions: Option<&'a Path>,
    /// Owner-approved extra flags, already validated by the config.
    pub(crate) extra: &'a [String],
    /// `--max-cost` (a lane's cost ceiling, WS-18).
    pub(crate) max_cost: Option<f64>,
    /// Tool policy role; transport does not alter the policy.
    pub(crate) role: Role,
}

impl Launch<'_> {
    /// The argument vector: the executable, the owner's extra flags, then the flags the hub always
    /// sets, so a later hub flag wins over anything before it.
    pub(crate) fn argv(&self) -> Vec<String> {
        self.build(true)
    }

    /// The terminal runtime's argument vector: the same flags without the rpc-ui mode, so OMP runs
    /// its TUI (HOST req. 93).
    pub(crate) fn tui_argv(&self) -> Vec<String> {
        self.build(false)
    }

    fn build(&self, rpc: bool) -> Vec<String> {
        let mut argv = vec![self.exe.display().to_string()];
        argv.extend(self.extra.iter().cloned());
        if rpc {
            argv.extend(["--mode", "rpc-ui"].map(String::from));
        }
        argv.extend([
            format!("--config={}", self.overlay.display()),
            format!("--model={}", self.model),
        ]);
        if let Some(level) = self.thinking {
            argv.push(format!("--thinking={level}"));
        }
        match self.target {
            Target::Fresh(dir) => argv.push(format!("--session-dir={}", dir.display())),
            Target::Resume(file) => argv.push(format!("--resume={}", file.display())),
        }
        if let Some(file) = self.instructions {
            argv.push(format!("--append-system-prompt={}", file.display()));
        }
        if let Some(cost) = self.max_cost {
            argv.push(format!("--max-cost={cost}"));
        }
        if let Some(tools) = tools::selection(self.role) {
            argv.push(format!("--tools={tools}"));
        }
        argv
    }
}

/// The child environment beyond the runner's pass-through list (HOST req. 21-22): the probe's
/// variables (notifications off, profile overrides), the owner's listed provider credentials that the
/// hub itself has, the hub socket, the single-use launch token and, last, the role's policy pins
/// ([`policy_env`]), which a listed credential of the same name never replaces. Never a relay token
/// or a Cataly secret; nothing secret goes into argv.
pub(crate) fn session_env(
    credentials: &[String],
    socket: &Path,
    token: &str,
    role: Role,
) -> Vec<(String, String)> {
    session_env_with(credentials, socket, token, role, |name| {
        std::env::var(name).ok()
    })
}

/// [`session_env`] with the hub's own variables read through `lookup`, so tests can supply a
/// hostile value for a pinned name.
pub(crate) fn session_env_with(
    credentials: &[String],
    socket: &Path,
    token: &str,
    role: Role,
    lookup: impl Fn(&str) -> Option<String>,
) -> Vec<(String, String)> {
    let pins = policy_env(role);
    let mut env: Vec<(String, String)> = super::child_env()
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
    for name in credentials {
        if pins.iter().any(|(pinned, _)| pinned == name) {
            continue;
        }
        if let Some(value) = lookup(name) {
            env.push((name.clone(), value));
        }
    }
    env.push(("CATALY_SOCKET".into(), socket.display().to_string()));
    env.push(("CATALY_LAUNCH".into(), token.to_string()));
    env.extend(pins.into_iter().map(|(k, v)| (k.to_string(), v)));
    env
}

/// The variables that pin the role's env-bound overlay settings, from the same rendering as the
/// overlay. Every launch sets them after anything it inherits or passes on.
pub(crate) fn policy_env(role: Role) -> Vec<(&'static str, String)> {
    render(&FallbackSettings::default(), role).1
}

/// The overlay file of a session kind in the state directory. Lanes run OMP goals (decision 5);
/// the lead holds no standing goal (OPC-36, DESIGN 9.1), so its overlay turns goal mode off and OMP
/// itself refuses a goal and hides the goal tool there.
pub(crate) fn overlay_path(state: &Path, role: Role) -> PathBuf {
    state.join(match role {
        Role::Lead => "omp-overlay.yml",
        Role::Lane | Role::Subagent => "omp-overlay-lane.yml",
        Role::LookOnly => "omp-overlay-look-only.yml",
        Role::Reviewer => "omp-overlay-reviewer.yml",
    })
}

/// Every saved-reset auto-redeem key of OMP 19.1.1 (`unset | yes | no`, default `unset`), one per
/// provider and reset window. They replaced `codexResets.autoRedeem`, which OMP migrates into the two
/// Codex keys only; without the Claude keys here, an owner's global `yes` would spend saved Claude
/// resets silently in every hosted session. Each is pinned to `no` (DESIGN 9.2).
pub(crate) const NO_REDEEM: [(&str, &str); 5] = [
    ("codexResets", "autoRedeem5h"),
    ("codexResets", "autoRedeemWeekly"),
    ("claudeResets", "autoRedeem5h"),
    ("claudeResets", "autoRedeemWeekly"),
    ("claudeResets", "autoRedeemFable"),
];

/// The role's overlay. Goal continuation is explicit; every hidden capability comes from the table.
pub(crate) fn overlay(fallback: &FallbackSettings, role: Role) -> Value {
    render(fallback, role).0
}

/// The overlay and its environment pins, rendered together.
fn render(fallback: &FallbackSettings, role: Role) -> (Value, Vec<(&'static str, String)>) {
    let mut retry = Map::new();
    retry.insert("modelFallback".into(), Value::Bool(true));
    retry.insert("fallbackRevertPolicy".into(), json!("cooldown-expiry"));
    if let Some(on) = &fallback.on {
        retry.insert("fallbackOn".into(), json!(on));
    }
    if !fallback.chains.is_empty() {
        retry.insert("fallbackChains".into(), json!(fallback.chains));
    }
    let mut root = Map::new();
    root.insert("ask".into(), json!({ "timeout": 0 }));
    root.insert(
        "goal".into(),
        json!({
            "enabled": tools::STOCK.iter().any(|t| t.name == "goal" && t.class(role) == Class::Offered),
            "continuationModes": ["interactive", "rpc"],
        }),
    );
    for (section, key) in NO_REDEEM {
        if let Value::Object(keys) = root
            .entry(section)
            .or_insert_with(|| Value::Object(Map::new()))
        {
            keys.insert(key.into(), json!("no"));
        }
    }
    root.insert("retry".into(), Value::Object(retry));
    // A stream that never yields its first event has no deadline of OMP's own (`-1`): one stuck
    // request held the lead's serial session for six hours with no log line. Two minutes is far
    // past a healthy first event and still lets `retry.modelFallback` take over. Every role gets
    // it: any session's stream can stop before its first event.
    root.insert(
        "providers".into(),
        json!({ "streamFirstEventTimeoutSeconds": 120 }),
    );
    let env = tools::apply(&mut root, role);
    (Value::Object(root), env)
}

/// Writes the overlay file of a session kind (mode 0600, atomically) and returns its path.
pub(crate) fn write_overlay(
    state: &Path,
    fallback: &FallbackSettings,
    role: Role,
) -> Result<PathBuf, FsError> {
    let path = overlay_path(state, role);
    let mut text = overlay(fallback, role).to_string();
    text.push('\n');
    write_atomic(&path, text.as_bytes())?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argv_puts_hub_flags_last() {
        let target = Target::Resume(PathBuf::from("/s/a.jsonl"));
        let extra = vec!["--no-skills".to_string()];
        let launch = Launch {
            exe: Path::new("/bin/omp"),
            model: "p/m",
            thinking: Some("low"),
            target: &target,
            overlay: Path::new("/o.yml"),
            instructions: Some(Path::new("/lead.md")),
            extra: &extra,
            max_cost: None,
            role: Role::Lead,
        };
        assert_eq!(
            launch.argv(),
            [
                "/bin/omp",
                "--no-skills",
                "--mode",
                "rpc-ui",
                "--config=/o.yml",
                "--model=p/m",
                "--thinking=low",
                "--resume=/s/a.jsonl",
                "--append-system-prompt=/lead.md"
            ]
        );
    }

    #[test]
    fn overlay_pins_safety_and_carries_only_owner_chains() {
        let plain = overlay(&FallbackSettings::default(), Role::Lead);
        assert_eq!(plain["goal"]["enabled"], false, "the lead holds no goal");
        assert_eq!(
            overlay(&FallbackSettings::default(), Role::Lane)["goal"]["enabled"],
            true
        );
        assert_eq!(plain["ask"]["timeout"], 0);
        for (section, key) in [
            ("codexResets", "autoRedeem5h"),
            ("codexResets", "autoRedeemWeekly"),
            ("claudeResets", "autoRedeem5h"),
            ("claudeResets", "autoRedeemWeekly"),
            ("claudeResets", "autoRedeemFable"),
        ] {
            assert_eq!(plain[section][key], "no", "{section}.{key}");
        }
        assert!(
            plain["codexResets"].get("autoRedeem").is_none(),
            "the replaced key is gone"
        );
        assert_eq!(plain["retry"]["modelFallback"], true);
        assert_eq!(plain["retry"]["fallbackRevertPolicy"], "cooldown-expiry");
        assert_eq!(
            plain["providers"]["streamFirstEventTimeoutSeconds"], 120,
            "a stream without a first event cannot hold the session forever"
        );
        assert!(plain["retry"].get("fallbackChains").is_none());
        assert!(plain["retry"].get("fallbackOn").is_none());
        let mut chains = std::collections::BTreeMap::new();
        chains.insert("default".to_string(), vec!["p/backup".to_string()]);
        let owner = overlay(
            &FallbackSettings {
                on: Some("usage-limit".into()),
                chains,
            },
            Role::Lane,
        );
        assert_eq!(owner["retry"]["fallbackChains"]["default"][0], "p/backup");
        assert_eq!(owner["retry"]["fallbackOn"], "usage-limit");
        let env = session_env(
            &["CATALY_NOT_SET_ANYWHERE".into()],
            Path::new("/s.sock"),
            "t",
            Role::Lead,
        );
        assert!(
            env.iter()
                .any(|(k, v)| k == "PI_NOTIFICATIONS" && v == "off")
        );
        assert!(env.iter().any(|(k, _)| k == "CATALY_LAUNCH"));
        assert!(!env.iter().any(|(k, _)| k == "CATALY_NOT_SET_ANYWHERE"));
    }

    #[test]
    /// #300: hiding and denial must agree for every role, without forcing offered tools on.
    fn overlay_disables_and_denies_eval_in_every_session() {
        for role in [
            Role::Lead,
            Role::Lane,
            Role::Subagent,
            Role::Reviewer,
            Role::LookOnly,
        ] {
            let o = overlay(&FallbackSettings::default(), role);
            assert_eq!(
                o["providers"]["streamFirstEventTimeoutSeconds"], 120,
                "every session's stream needs the first-event deadline, {role:?}"
            );
            assert_eq!(o["eval"], json!({ "py": false, "js": false }), "{role:?}");
            assert_eq!(o["tools"]["approval"]["eval"], "deny", "{role:?}");
            for tool in tools::STOCK
                .iter()
                .filter(|t| t.class(role) == Class::Offered)
            {
                assert!(
                    o["tools"]["approval"].get(tool.name).is_none(),
                    "{} {role:?}",
                    tool.name
                );
            }
            assert!(o.get("debug").is_none());
            assert!(o.get("lsp").is_none());
        }
    }

    #[test]
    fn approvals_are_left_to_the_owners_omp_settings() {
        for role in [Role::Lead, Role::Lane] {
            let o = overlay(&FallbackSettings::default(), role);
            assert!(o.get("bash").is_none(), "no shell patterns, {role:?}");
            assert!(o["tools"].get("approvalMode").is_none(), "{role:?}");
        }
    }

    const ROLES: [Role; 5] = [
        Role::Lead,
        Role::Lane,
        Role::Subagent,
        Role::Reviewer,
        Role::LookOnly,
    ];

    #[test]
    /// Finding 7: denial alone leaves a tool advertised, so a hidden row must have a feature gate.
    fn every_hidden_row_hides_through_feature_settings() {
        for role in ROLES {
            for tool in tools::STOCK
                .iter()
                .filter(|t| t.class(role) == Class::Hidden)
            {
                assert!(
                    matches!(tool.hiding, tools::Hiding::Features(gates) if !gates.is_empty()),
                    "{} is hidden for {role:?} but only deny-only: {:?}",
                    tool.name,
                    tool.hiding
                );
            }
        }
    }

    #[test]
    /// OMP ranks `PI_PY`/`PI_JS` above `--config` and fills them from `.env` when unset: every
    /// launch environment sets them to the overlay's own value, after anything passed on.
    fn every_bound_setting_is_pinned_last_in_every_launch_environment() {
        let mut chains = std::collections::BTreeMap::new();
        chains.insert("default".to_string(), vec!["p/backup".to_string()]);
        let owner = FallbackSettings {
            on: Some("usage-limit".into()),
            chains,
        };
        for role in ROLES {
            let pins = policy_env(role);
            assert_eq!(
                pins,
                [("PI_PY", "0".into()), ("PI_JS", "0".into())],
                "{role:?}"
            );
            assert_eq!(
                render(&owner, role).1,
                pins,
                "owner fallback never moves a pin"
            );
            let o = overlay(&FallbackSettings::default(), role);
            assert_eq!(o["archive"]["enabled"], false, "{role:?}");
            for binding in tools::ENV {
                let value = binding
                    .setting
                    .split('.')
                    .fold(&o, |value, segment| &value[segment]);
                assert_eq!(value, &json!(false), "{} {role:?}", binding.name);
            }
            // The hub itself has every listed name set to "1": the skip, not an empty environment,
            // keeps a pinned name from being passed on.
            let env = session_env_with(
                &["PI_PY".into(), "PI_JS".into(), "CATALY_CRED".into()],
                Path::new("/s.sock"),
                "t",
                role,
                |_| Some("1".into()),
            );
            assert!(
                env.contains(&("CATALY_CRED".into(), "1".into())),
                "an unpinned credential passes: {env:?}"
            );
            let bound = env
                .iter()
                .filter(|(k, _)| tools::ENV.iter().any(|b| b.name == k))
                .count();
            assert_eq!(
                bound, 2,
                "a listed credential never adds a second value: {env:?}"
            );
            let tail: Vec<(&str, &str)> = env[env.len() - 2..]
                .iter()
                .map(|(k, v)| (k.as_str(), v.as_str()))
                .collect();
            assert_eq!(tail, [("PI_PY", "0"), ("PI_JS", "0")], "{role:?}");
        }
    }
}
