//! The model a session runs, judged against what OMP itself makes of the selector the hub started
//! it with (HOST req. 27). The selector is never compared as text: `provider/id:<level>` is OMP's
//! base model with a thinking level, and an ID with a colon part of its own (`ollama/qwen:14b`)
//! stays literal. The bridge answers the read-only `model.resolve` with the model
//! `ctx.models.resolve` returns, the level the selector requests and the level OMP runs now. A
//! bridge older than the hub cannot answer, so the model is unverified. A mismatch and an
//! unverified model both leave the session open and fenced until the owner accepts the model.

use serde_json::Value;

use super::dialogs::same_model;
use crate::config::Language;

/// The `model.resolve` answer this hub reads; the hello announces it as `model_resolution_version`.
pub(crate) const VERSION: u64 = 1;
const MISMATCH: &str = "model mismatch";
const UNVERIFIED: &str = "model unverified";

/// The model OMP resolved a selector to, and the thinking levels it requests and runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Resolution {
    pub(crate) selector: String,
    pub(crate) provider: String,
    pub(crate) id: String,
    /// The level the selector's suffix (or the explicit thinking setting) asks for.
    pub(crate) requested: Option<String>,
    /// The level OMP runs at when it answered.
    pub(crate) observed: Option<String>,
}

/// What the bridge proved about a selector.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Proof {
    Resolved(Resolution),
    /// Why the model could not be checked.
    Unverified(String),
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

impl Resolution {
    /// `provider/id`, as OMP reports a model.
    pub(crate) fn model(&self) -> String {
        format!("{}/{}", self.provider, self.id)
    }

    /// Why a session that reports `model` at `thinking` does not run this resolution, if it
    /// does not: another model, or a level other than the requested one (a clamped one too).
    pub(crate) fn judge(&self, model: Option<&str>, thinking: Option<&str>) -> Option<String> {
        let resolved = self.model();
        match model {
            Some(model) if same_model(model, &resolved) => {}
            other => {
                return Some(format!(
                    "{MISMATCH}: {} resolves to {resolved}, OMP reports {}",
                    self.selector,
                    other.unwrap_or("none")
                ));
            }
        }
        let requested = self.requested.as_deref()?;
        (thinking != Some(requested)).then(|| {
            format!(
                "{MISMATCH}: thinking {requested} requested, OMP reports {}",
                thinking.unwrap_or("none")
            )
        })
    }
}

impl Proof {
    /// Reads a bridge's answer to `model.resolve` or to the `model` command.
    pub(crate) fn from_reply(reply: &Value) -> Result<Self, String> {
        if let Some(r) = reply.get("model_resolution") {
            let version = r.get("version").and_then(Value::as_u64).unwrap_or(0);
            if version != VERSION {
                return Ok(Self::Unverified(format!(
                    "the bridge answered model resolution version {version}, this hub reads {VERSION}"
                )));
            }
            let thinking = r.get("thinking").unwrap_or(&Value::Null);
            return match (text(r, "provider"), text(r, "id")) {
                (Some(provider), Some(id)) => Ok(Self::Resolved(Resolution {
                    selector: text(r, "selector").unwrap_or_default(),
                    provider,
                    id,
                    requested: text(thinking, "requested"),
                    observed: text(thinking, "observed"),
                })),
                _ => Err("the bridge's model resolution names no provider/id".into()),
            };
        }
        if let Some(why) = text(reply, "model_unverified") {
            return Ok(Self::Unverified(why));
        }
        Err(text(reply, "refused").unwrap_or_else(|| "the bridge sent no model resolution".into()))
    }

    /// The hold for a session that reports `model` at `thinking`, if it is held.
    pub(crate) fn hold(&self, model: Option<&str>, thinking: Option<&str>) -> Option<String> {
        match self {
            Self::Resolved(r) => r.judge(model, thinking),
            Self::Unverified(why) => Some(format!("{UNVERIFIED}: {why}")),
        }
    }
}

/// Why a bridge whose hello lacks the capability cannot prove the model; `version` is the
/// extension's own.
pub(crate) fn old_bridge(version: &str) -> String {
    let version = if version.is_empty() {
        String::new()
    } else {
        format!(" ({version})")
    };
    format!(
        "the Cataly extension{version} in this session is older than the hub, so the model OMP runs could not be checked"
    )
}

/// Why a session whose bridge never said hello within the startup deadline is unverified.
pub(crate) const NO_BRIDGE: &str =
    "the Cataly extension didn't connect, so the model OMP runs could not be checked";

/// Whether the owner may accept the model OMP reports for a hold with this reason.
pub(crate) fn accepts(reason: &str) -> bool {
    reason.starts_with(MISMATCH) || reason.starts_with(UNVERIFIED)
}

/// Whether a hold is an unverified model (told to the owner once, not on every start).
pub(crate) fn unverified(reason: &str) -> bool {
    reason.starts_with(UNVERIFIED)
}

/// What the owner hears once about an unverified lead model: what happened (an extension older
/// than the hub, or none that connected) in plain words, the fix, the accept command. The raw
/// reason stays in the log, the event's `reason` and `cataly lead status --json`.
pub(crate) fn unverified_text(language: Language, reason: &str) -> String {
    let silent = reason.contains(NO_BRIDGE);
    match language {
        Language::Korean => format!(
            "Cataly: OMP가 쓰는 lead 모델을 확인할 수 없습니다. 세션은 열려 있지만 더 이상 아무것도 전달하지 않습니다.\n\
             원인: {}\n\
             해결: `cataly update`를 실행하거나 lead를 다시 시작하세요(`cataly lead stop` 후 `cataly lead start`). \
             OMP가 보고하는 모델을 그대로 쓰려면 `cataly lead accept-model`을 실행하세요.",
            if silent {
                "lead 세션의 Cataly 확장이 연결되지 않았어요."
            } else {
                "lead 세션의 Cataly 확장이 허브보다 오래되었어요."
            }
        ),
        Language::English => format!(
            "Cataly: the model OMP runs for the lead could not be checked. The session stays open, but nothing more is delivered to it.\n\
             Reason: {}\n\
             Fix: run `cataly update`, or restart the lead (`cataly lead stop`, then `cataly lead start`). \
             To keep the model OMP reports, run `cataly lead accept-model`.",
            if silent {
                "The Cataly extension in the lead's session didn't connect."
            } else {
                "The Cataly extension in the lead's session is older than the hub."
            }
        ),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn resolved(reply: &Value) -> Resolution {
        match Proof::from_reply(reply).unwrap() {
            Proof::Resolved(r) => r,
            other @ Proof::Unverified(_) => panic!("{other:?}"),
        }
    }

    fn answer(selector: &str, model: (&str, &str), thinking: (Option<&str>, &str)) -> Value {
        json!({ "model_resolution": { "version": 1, "selector": selector, "provider": model.0,
            "id": model.1, "thinking": { "requested": thinking.0, "observed": thinking.1 } } })
    }

    /// `x:high` is the base model at high; a clamped level, another model or a missing report
    /// is a mismatch; literal colon IDs match literally; an unreadable answer is no proof.
    #[test]
    fn selectors_are_judged_by_what_omp_resolved() {
        let high = resolved(&answer(
            "anthropic/claude-opus-5-5:high",
            ("anthropic", "claude-opus-5-5"),
            (Some("high"), "high"),
        ));
        assert_eq!(high.model(), "anthropic/claude-opus-5-5");
        assert_eq!(
            high.judge(Some("anthropic/Claude-Opus-5-5"), Some("high")),
            None
        );
        let clamped = high
            .judge(Some("anthropic/claude-opus-5-5"), Some("medium"))
            .unwrap();
        assert!(
            accepts(&clamped) && clamped.contains("thinking high requested, OMP reports medium"),
            "{clamped}"
        );
        let other = high.judge(Some("anthropic/other"), Some("high")).unwrap();
        assert!(other.starts_with("model mismatch") && other.contains("anthropic/other"));
        assert!(high.judge(None, Some("high")).unwrap().contains("none"));
        for (selector, provider, id) in [
            ("ollama/qwen:14b", "ollama", "qwen:14b"),
            ("fake/glm:high", "fake", "glm:high"),
        ] {
            let literal = resolved(&answer(selector, (provider, id), (None, "high")));
            assert_eq!(literal.model(), selector);
            assert_eq!(literal.judge(Some(selector), Some("high")), None);
            assert_eq!(literal.judge(Some(selector), Some("off")), None);
        }
        let unverified = Proof::from_reply(&json!({ "model_unverified": "OMP does not know x/y" }))
            .unwrap()
            .hold(Some("x/y"), None)
            .unwrap();
        assert!(
            super::unverified(&unverified) && accepts(&unverified),
            "{unverified}"
        );
        let newer = Proof::from_reply(&json!({ "model_resolution": { "version": 2 } })).unwrap();
        assert!(matches!(newer, Proof::Unverified(_)), "{newer:?}");
        assert!(Proof::from_reply(&json!({ "refused": "not current" })).is_err());
        assert!(!accepts("OMP switched transcripts"));
    }

    #[test]
    fn the_unverified_notice_names_cause_fix_and_accept() {
        let reason = format!("{UNVERIFIED}: {}", old_bridge("0.2.6"));
        assert!(reason.contains("(0.2.6)"), "{reason}");
        for language in [Language::English, Language::Korean] {
            let text = unverified_text(language, &reason);
            for needle in [
                "`cataly update`",
                "`cataly lead accept-model`",
                "`cataly lead start`",
            ] {
                assert!(text.contains(needle), "{needle}: {text}");
            }
            // The raw reason is not quoted: it stays in the log and `lead status --json`.
            assert!(
                !text.contains(UNVERIFIED) && !text.contains("(0.2.6)"),
                "{text}"
            );
        }
        let en = unverified_text(Language::English, &reason);
        assert!(
            en.contains(
                "\nReason: The Cataly extension in the lead's session is older than the hub.\n"
            ),
            "{en}"
        );
        let ko = unverified_text(Language::Korean, &format!("{UNVERIFIED}: {NO_BRIDGE}"));
        assert!(
            ko.contains("\n원인: lead 세션의 Cataly 확장이 연결되지 않았어요.\n"),
            "{ko}"
        );
    }
}
