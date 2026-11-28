//! Done checks (EVR-32, EVR-39; EVR req. 54-58; LANE req. 4, 55): a lane's completion condition as a
//! non-empty list of typed signals, parsed at open and read back live at every claim and close.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::time::Instant;

use crate::jobs::owner::gh_list;
use crate::sys::command::{self, Output, Spec};
use crate::worker::Place;

/// GitHub reads and commands (EVR req. 57).
pub(super) const LIMIT: Duration = Duration::from_secs(120);
const WEB_LIMIT: Duration = Duration::from_secs(30);
const OUTPUT_CAP: u64 = 2 * 1024 * 1024;
const DETAIL: usize = 120;
const FILES_MAX: usize = 3000;

/// One machine-checkable signal (EVR req. 54).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Signal {
    PrMerged {
        repo: String,
        number: u64,
    },
    IssueClosed {
        repo: String,
        number: u64,
    },
    Command {
        argv: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pattern: Option<String>,
    },
    File {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sha256: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        field: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<Value>,
    },
    Web {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<u16>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pattern: Option<String>,
    },
    PrPolicy {
        repo: String,
        number: u64,
    },
}

/// One signal's result (EVR req. 56).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct Outcome {
    pub(crate) signal: String,
    pub(crate) pass: bool,
    pub(crate) detail: String,
}

fn repo_ok(repo: &str) -> bool {
    let mut parts = repo.split('/');
    let ok = |p: Option<&str>| {
        p.is_some_and(|p| {
            !p.is_empty()
                && p.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        })
    };
    ok(parts.next()) && ok(parts.next()) && parts.next().is_none()
}

impl Signal {
    fn name(&self) -> String {
        match self {
            Self::PrMerged { repo, number } => format!("pr_merged {repo}#{number}"),
            Self::IssueClosed { repo, number } => format!("issue_closed {repo}#{number}"),
            Self::Command { argv, .. } => format!("command {}", argv.first().map_or("", |a| a)),
            Self::File { path, .. } => format!("file {path}"),
            Self::Web { url, .. } => format!("web {url}"),
            Self::PrPolicy { repo, number } => format!("pr_policy {repo}#{number}"),
        }
    }

    fn invalid(&self) -> Option<String> {
        match self {
            Self::PrMerged { repo, number }
            | Self::IssueClosed { repo, number }
            | Self::PrPolicy { repo, number } => (!repo_ok(repo) || *number == 0)
                .then(|| "expected repo owner/name and a positive number".into()),
            Self::Command { argv, pattern } => {
                if argv.is_empty() || argv.iter().any(String::is_empty) {
                    Some("argv must be a non-empty list of non-empty strings".into())
                } else {
                    pattern
                        .as_deref()
                        .and_then(|p| regex::Regex::new(p).err())
                        .map(|e| format!("bad pattern: {e}"))
                }
            }
            Self::File { path, sha256, .. } => {
                if path.is_empty() {
                    Some("path is empty".into())
                } else if sha256
                    .as_ref()
                    .is_some_and(|h| h.len() != 64 || !h.chars().all(|c| c.is_ascii_hexdigit()))
                {
                    Some("sha256 must be 64 hex digits".into())
                } else {
                    None
                }
            }
            Self::Web { url, pattern, .. } => split_url(url).err().or_else(|| {
                pattern
                    .as_deref()
                    .and_then(|p| regex::Regex::new(p).err())
                    .map(|e| format!("bad pattern: {e}"))
            }),
        }
    }
}

/// Parses a completion condition; every invalid signal is named (LANE req. 4, EVR req. 55).
pub(crate) fn parse(value: &Value) -> Result<Vec<Signal>, String> {
    let list = value
        .as_array()
        .ok_or("the done checks must be a list of signals")?;
    if list.is_empty() {
        return Err("the done checks list no signal".into());
    }
    let mut out = Vec::new();
    let mut errors = Vec::new();
    for (i, item) in list.iter().enumerate() {
        match serde_json::from_value::<Signal>(item.clone()) {
            Ok(signal) => match signal.invalid() {
                None => out.push(signal),
                Some(why) => errors.push(format!("signal {}: {why}", i + 1)),
            },
            Err(e) => errors.push(format!("signal {}: {e}", i + 1)),
        }
    }
    if errors.is_empty() {
        Ok(out)
    } else {
        Err(errors.join("; "))
    }
}

fn cut(text: &str) -> String {
    let flat: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let mut out: String = flat.chars().take(DETAIL).collect();
    if flat.chars().count() > DETAIL {
        out.pop();
        out.push('…');
    }
    out
}

/// Origin plus path-and-query of an http(s) URL.
fn split_url(url: &str) -> Result<(String, String), String> {
    let scheme = if url.starts_with("https://") {
        "https://"
    } else if url.starts_with("http://") {
        "http://"
    } else {
        return Err("the URL must start with https://".into());
    };
    let rest = url.get(scheme.len()..).unwrap_or_default();
    let at = rest.find(['/', '?']).unwrap_or(rest.len());
    let (authority, path) = rest.split_at(at);
    if authority.is_empty() || authority.contains('@') || url.contains('#') {
        return Err("the URL needs a host and no credentials or fragment".into());
    }
    let path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    Ok((format!("{scheme}{authority}"), path))
}

/// Git and gh run with their redirecting variables removed and the C locale (LANE req. 60).
pub(crate) const CLEAN_ENV: [(&str, &str); 2] = [("LC_ALL", "C"), ("GIT_TERMINAL_PROMPT", "0")];

async fn run(
    place: &Place,
    argv: &[String],
    cwd: &Path,
    limit: Duration,
) -> Result<(bool, String), String> {
    let finished = place
        .run(&Spec {
            argv,
            cwd: Some(cwd),
            env: &CLEAN_ENV,
            timeout: limit,
            kill_grace: command::KILL_GRACE,
            output_cap: OUTPUT_CAP,
            output: Output::Capture,
        })
        .await?;
    if finished.timed_out {
        return Err(format!("no answer within {} s", limit.as_secs()));
    }
    Ok((
        finished.success(),
        String::from_utf8_lossy(&finished.stdout).into_owned(),
    ))
}

/// One GitHub read, spoken as the owner jobs speak to `gh` (`jobs::owner::gh_api`), bounded here.
pub(crate) async fn gh(path: &str, cwd: &Path) -> Result<Value, String> {
    gh_args(&crate::jobs::owner::gh_api(path), cwd).await
}

/// One bounded `gh` call with the shared environment; the answer is read as JSON.
pub(crate) async fn gh_args(args: &[&str], cwd: &Path) -> Result<Value, String> {
    gh_command("gh", args, cwd, LIMIT).await
}

async fn gh_command(
    program: &str,
    args: &[&str],
    cwd: &Path,
    limit: Duration,
) -> Result<Value, String> {
    let words: Vec<String> = std::iter::once(program)
        .chain(args.iter().copied())
        .map(str::to_string)
        .collect();
    let env: Vec<(&str, &str)> = CLEAN_ENV
        .iter()
        .chain(&crate::jobs::owner::GH_ENV)
        .copied()
        .collect();
    let done = command::run(&Spec {
        argv: &words,
        cwd: Some(cwd),
        env: &env,
        timeout: limit,
        kill_grace: command::KILL_GRACE,
        output_cap: OUTPUT_CAP,
        output: Output::Capture,
    })
    .await
    .map_err(|e| e.to_string())?;
    if done.timed_out {
        return Err(format!("no answer within {} s", limit.as_secs()));
    }
    crate::jobs::owner::gh_answer(args, &done)
}

fn resolve(path: &str, cwd: &Path) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        std::env::var_os("HOME").map_or_else(|| cwd.join(path), |h| PathBuf::from(h).join(rest))
    } else {
        cwd.join(path)
    }
}

fn field<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.')
        .filter(|p| !p.is_empty())
        .try_fold(value, |v, part| match part.parse::<usize>() {
            Ok(i) => v.get(i),
            Err(_) => v.get(part),
        })
}

/// Where a lane's checks run (docs/design/workers.md 2.7): `command` and `file` where the lane works,
/// in its directory; `pr_merged`, `issue_closed`, `web` and `pr_policy` on the hub, with its `gh`
/// login, from `hub_dir`.
pub(crate) struct Site<'a> {
    pub(crate) place: &'a Place,
    pub(crate) cwd: &'a Path,
    pub(crate) hub_dir: &'a Path,
}

/// This machine, for lanes that run here.
static HERE: Place = Place::Local;

impl Site<'_> {
    /// A lane on this machine: everything runs here, in its directory.
    pub(crate) fn local(cwd: &Path) -> Site<'_> {
        Site {
            place: &HERE,
            cwd,
            hub_dir: cwd,
        }
    }

    /// Where `signal` runs.
    fn of(&self, signal: &Signal) -> &str {
        match signal {
            Signal::Command { .. } | Signal::File { .. } => self.place.name(),
            _ => Place::Local.name(),
        }
    }
}

/// A `file` signal's bytes against its hash and JSON field, checked here wherever they were read.
fn file(
    bytes: &[u8],
    sha256: Option<&str>,
    key: Option<&str>,
    value: Option<&Value>,
) -> Result<String, String> {
    if let Some(want) = sha256 {
        let got = crate::config::sha256_hex(bytes);
        if !got.eq_ignore_ascii_case(want) {
            return Err(format!("hash {}", got.get(..12).unwrap_or_default()));
        }
    }
    if let Some(key) = key {
        let doc: Value = serde_json::from_slice(bytes).map_err(|_| "not JSON".to_string())?;
        let got = field(&doc, key);
        if got != value {
            return Err(format!(
                "{key} is {}",
                got.map_or("absent".into(), Value::to_string)
            ));
        }
    }
    Ok("present".into())
}

/// One signal read back live.
async fn check(
    signal: &Signal,
    site: &Site<'_>,
    identities: &[(String, String)],
) -> Result<String, String> {
    let (cwd, hub) = (site.cwd, site.hub_dir);
    match signal {
        Signal::PrMerged { repo, number } => {
            let pr = gh(&format!("repos/{repo}/pulls/{number}"), hub).await?;
            let merged = pr.get("merged").and_then(Value::as_bool) == Some(true);
            match pr.get("merge_commit_sha").and_then(Value::as_str) {
                Some(sha) if merged => Ok(format!("merged as {sha}")),
                _ => Err("not merged".into()),
            }
        }
        Signal::IssueClosed { repo, number } => {
            let issue = gh(&format!("repos/{repo}/issues/{number}"), hub).await?;
            match issue.get("state").and_then(Value::as_str) {
                Some("closed") => Ok("closed".into()),
                other => Err(format!("state {}", other.unwrap_or("unknown"))),
            }
        }
        Signal::Command { argv, pattern } => {
            let (ok, out) = run(site.place, argv, cwd, LIMIT).await?;
            if !ok {
                return Err("exited with a failure".into());
            }
            match pattern.as_deref().map(regex::Regex::new) {
                Some(Ok(re)) if !re.is_match(&out) => Err("output does not match".into()),
                Some(Err(e)) => Err(format!("bad pattern: {e}")),
                _ => Ok("exit 0".into()),
            }
        }
        Signal::File {
            path,
            sha256,
            field: key,
            value,
        } => {
            let bytes = match site.place {
                Place::Local => {
                    std::fs::read(resolve(path, cwd)).map_err(|e| format!("not readable: {e}"))?
                }
                // On a worker the path is the worktree's; its home is not the hub's.
                Place::Worker(_) => site
                    .place
                    .read(&cwd.join(path), crate::worker::FILE_MAX)
                    .await
                    .map_err(|e| format!("not readable: {e}"))?,
            };
            file(&bytes, sha256.as_deref(), key.as_deref(), value.as_ref())
        }
        Signal::Web {
            url,
            status,
            pattern,
        } => {
            let (origin, path) = split_url(url)?;
            let base = crate::relay::http::Base::parse(&origin)?;
            let req = crate::relay::http::Request {
                method: hyper::Method::GET,
                path: &path,
                headers: Vec::new(),
                json: None,
                kind: crate::relay::http::Kind::Read,
            };
            let policy = crate::relay::http::Policy {
                attempt: WEB_LIMIT,
                attempts: 1,
                budget: WEB_LIMIT,
            };
            let resp = match crate::relay::http::call(&base, &req, policy, |_| {}).await {
                crate::relay::http::Outcome::Done(r) | crate::relay::http::Outcome::Rejected(r) => {
                    r
                }
                crate::relay::http::Outcome::RateLimited(_) => return Err("rate limited".into()),
                crate::relay::http::Outcome::Uncertain(e)
                | crate::relay::http::Outcome::Failed(e) => {
                    return Err(e);
                }
            };
            let want = status.unwrap_or(200);
            if resp.status != want {
                return Err(format!("status {}", resp.status));
            }
            match pattern.as_deref().map(regex::Regex::new) {
                Some(Ok(re)) if !re.is_match(&String::from_utf8_lossy(&resp.body)) => {
                    Err("body does not match".into())
                }
                Some(Err(e)) => Err(format!("bad pattern: {e}")),
                _ => Ok(format!("status {want}")),
            }
        }
        Signal::PrPolicy { repo, number } => {
            let gh = PolicyGh {
                program: "gh",
                cwd: hub,
                deadline: Instant::now() + LIMIT,
            };
            policy(repo, *number, &gh, identities).await
        }
    }
}

/// One deadline covers both PR snapshots and every commit/file page (EVR req. 58).
struct PolicyGh<'a> {
    program: &'a str,
    cwd: &'a Path,
    deadline: Instant,
}

impl PolicyGh<'_> {
    async fn read(&self, path: &str) -> Result<Value, String> {
        let limit = self.deadline.saturating_duration_since(Instant::now());
        if !limit.is_zero() {
            let args = crate::jobs::owner::gh_api(path);
            let read = gh_command(self.program, &args, self.cwd, limit);
            // The absolute deadline also bounds process cleanup and pipe draining. Dropping
            // the runner kills its child; neither cleanup nor another page extends the read.
            if let Ok(result) = tokio::time::timeout_at(self.deadline, read).await
                && Instant::now() < self.deadline
            {
                return result;
            }
        }
        Err("pull-request policy read deadline reached".into())
    }
}

fn policy_count(pr: &Value, field: &str) -> Result<usize, String> {
    pr.get(field)
        .and_then(Value::as_u64)
        .and_then(|n| usize::try_from(n).ok())
        .ok_or_else(|| format!("missing or invalid PR {field} count"))
}

/// The pull-request policy (EVR req. 58).
async fn policy(
    repo: &str,
    number: u64,
    gh: &PolicyGh<'_>,
    identities: &[(String, String)],
) -> Result<String, String> {
    let identity = identities
        .iter()
        .find(|(r, _)| r.eq_ignore_ascii_case(repo))
        .map(|(_, e)| e.to_lowercase())
        .ok_or("the repository has no configured identity")?;
    let path = format!("repos/{repo}/pulls/{number}");
    let before = gh.read(&path).await?;
    let commit_count = policy_count(&before, "commits")?;
    let file_count = policy_count(&before, "changed_files")?;
    if file_count > FILES_MAX {
        return Err("more than 3000 files".into());
    }
    // Bounded by the PR's counts; a short page (GitHub lists at most 250 commits) is checked below.
    let read = |p: String| async move { gh.read(&p).await };
    let commits = gh_list(&format!("{path}/commits"), None, Some(commit_count), read).await?;
    let files = gh_list(&format!("{path}/files"), None, Some(file_count), read).await?;
    let after = gh.read(&path).await?;
    if before.pointer("/head/sha") != after.pointer("/head/sha")
        || ["body", "commits", "changed_files"]
            .iter()
            .any(|key| before.get(key) != after.get(key))
    {
        return Err("moved while being checked".into());
    }
    for (name, rows, expected) in [
        ("commits", &commits, commit_count),
        ("files", &files, file_count),
    ] {
        if rows.len() != expected {
            return Err(format!(
                "incomplete {name}: read {}, expected {expected}",
                rows.len()
            ));
        }
    }
    let mut fix = false;
    for c in commits {
        let email = |who: &str| {
            c.pointer(&format!("/commit/{who}/email"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_lowercase()
        };
        let merge = c
            .get("parents")
            .and_then(Value::as_array)
            .is_some_and(|p| p.len() > 1);
        if email("author") != identity
            || (email("committer") != identity
                && !(merge && email("committer") == "noreply@github.com"))
        {
            return Err("a commit's identity is not the configured one".into());
        }
        let message = c
            .pointer("/commit/message")
            .and_then(Value::as_str)
            .unwrap_or_default();
        fix |= message.starts_with("fix");
    }
    let name = |f: &Value| {
        f.get("filename")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let test = |n: &str| n.contains("test") || n.contains("spec");
    let docs = |n: &str| {
        Path::new(n)
            .extension()
            .is_some_and(|x| x.eq_ignore_ascii_case("md"))
    };
    let source = files.iter().map(name).any(|n| !test(&n) && !docs(&n));
    let tested = files.iter().map(name).any(|n| test(&n));
    let reason = after
        .get("body")
        .and_then(Value::as_str)
        .is_some_and(|b| b.to_lowercase().contains("no test:"));
    if fix && source && !tested && !reason {
        return Err("a fix changes source without a test or a no-test reason".into());
    }
    Ok("policy holds".into())
}

/// Reads every signal back live, in parallel (EVR req. 56). A worker lane's signals name where they
/// ran (docs/design/workers.md 2.7).
pub(crate) async fn run_all(
    signals: &[Signal],
    site: &Site<'_>,
    identities: &[(String, String)],
) -> Vec<Outcome> {
    let futures = signals.iter().map(|s| async move {
        let result = check(s, site, identities).await;
        let signal = match site.place {
            Place::Local => s.name(),
            Place::Worker(_) => format!("{} ({})", s.name(), site.of(s)),
        };
        Outcome {
            signal,
            pass: result.is_ok(),
            detail: cut(&result.unwrap_or_else(|e| e)),
        }
    });
    futures_util::future::join_all(futures).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn conditions_parse_or_name_each_bad_signal() {
        let ok = parse(&json!([
            { "kind": "pr_merged", "repo": "o/r", "number": 3 },
            { "kind": "command", "argv": ["true"] },
            { "kind": "file", "path": "a.json", "field": "v", "value": 1 },
            { "kind": "web", "url": "https://example.com/x?y=1", "status": 200 }
        ]))
        .unwrap();
        assert_eq!(ok.len(), 4);
        assert!(parse(&json!([])).is_err());
        assert!(parse(&json!("merged")).is_err());
        let err = parse(&json!([
            { "kind": "pr_merged", "repo": "bad", "number": 3 },
            { "kind": "nope" },
            { "kind": "command", "argv": [] }
        ]))
        .unwrap_err();
        assert!(
            err.contains("signal 1") && err.contains("signal 2") && err.contains("signal 3"),
            "{err}"
        );
    }

    #[tokio::test]
    async fn policy_pages_share_one_deadline() {
        use std::os::unix::fs::PermissionsExt;

        let dir = crate::sys::fs::tests::scratch("policy-deadline");
        let program = dir.join("gh");
        std::fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/fake-gh"),
            &program,
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        let data = dir.join("gh-data");
        std::fs::create_dir(&data).unwrap();
        std::fs::write(data.join("calls.log"), "").unwrap();
        let fixture = |suffix: &str, value: &Value| {
            std::fs::write(
                data.join(format!("repos_o_r_pulls_7{suffix}.json")),
                value.to_string(),
            )
            .unwrap();
        };
        fixture(
            "",
            &json!({
                "head": { "sha": "head" }, "body": "", "commits": 1, "changed_files": 101
            }),
        );
        fixture(
            "_commits",
            &json!([{ "commit": {
            "author": { "email": "owner@example.com" },
            "committer": { "email": "owner@example.com" },
            "message": "fix: the edge case"
        } }]),
        );
        let mut files: Vec<Value> = (0..100)
            .map(|n| json!({ "filename": format!("docs/{n}.md") }))
            .collect();
        files[0] = json!({ "filename": "src/fix.rs" });
        fixture("_files", &json!(files));
        fixture("_files.page-2", &json!([{ "filename": "tests/fix.rs" }]));
        let delays = [
            data.join("repos_o_r_pulls_7_files.json.delay"),
            data.join("repos_o_r_pulls_7_files.page-2.json.delay"),
        ];
        for delay in &delays {
            std::fs::write(delay, "1\n").unwrap();
        }
        // Each real subprocess delays less than the budget, but the two pages together exceed
        // it. No tight wall-clock assertion: the error and skipped final snapshot prove expiry.
        let gh = PolicyGh {
            program: program.to_str().unwrap(),
            cwd: &dir,
            deadline: Instant::now() + Duration::from_millis(1500),
        };
        let identities = [("o/r".into(), "owner@example.com".into())];
        let why = policy("o/r", 7, &gh, &identities).await.unwrap_err();
        assert_eq!(why, "pull-request policy read deadline reached");
        let calls = std::fs::read_to_string(data.join("calls.log")).unwrap();
        // Under load, the deadline may expire before even the first snapshot is logged.
        let snapshots = calls
            .lines()
            .filter(|line| line.ends_with("repos/o/r/pulls/7"))
            .count();
        assert!(
            snapshots <= 1,
            "the final snapshot must not start after the deadline: {calls}"
        );
        assert!(gh.read("repos/o/r/pulls/7").await.is_err());
        assert_eq!(
            std::fs::read_to_string(data.join("calls.log")).unwrap(),
            calls
        );

        // The same complete PR passes without delays under a fresh budget.
        for delay in delays {
            std::fs::remove_file(delay).unwrap();
        }
        let gh = PolicyGh {
            deadline: Instant::now() + Duration::from_secs(5),
            ..gh
        };
        assert_eq!(
            policy("o/r", 7, &gh, &identities).await.unwrap(),
            "policy holds"
        );
    }

    /// Local signals only: a GitHub signal would run the real `gh` with the user's login.
    #[tokio::test]
    async fn signals_read_back_live() {
        let dir = crate::sys::fs::tests::scratch("checks");
        std::fs::write(dir.join("a.json"), r#"{"v":{"n":2}}"#).unwrap();
        let signals = parse(&json!([
            { "kind": "command", "argv": ["true"] },
            { "kind": "command", "argv": ["false"] },
            { "kind": "file", "path": "a.json", "field": "v.n", "value": 2 },
            { "kind": "file", "path": "a.json", "field": "v.n", "value": 3 }
        ]))
        .unwrap();
        let out = run_all(&signals, &Site::local(&dir), &[]).await;
        let pass: Vec<bool> = out.iter().map(|o| o.pass).collect();
        assert_eq!(pass, [true, false, true, false]);
        assert!(out.iter().all(|o| o.detail.chars().count() <= DETAIL));
    }
}
