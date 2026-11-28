//! Milestone 3a acceptance checks 1-10 through the real hub with the fake OMP (`tests/support/
//! fake-omp`, rpc-ui mode with turns and goals) and the fake Discord. A test speaks for a lane's
//! bridge over the hub socket with the launch token the fake OMP recorded.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

#[path = "lanes/recovery.rs"]
mod recovery;

#[path = "lanes/tern_recovery.rs"]
mod tern_recovery;

#[path = "lanes/reopen.rs"]
mod reopen;

use std::io::{BufRead as _, BufReader, Write as _};
use std::os::unix::fs::PermissionsExt as _;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use support::TestHub;
use support::discord::FakeDiscord;

const WAIT: Duration = Duration::from_secs(30);
const OWNER: &str = "400000000000000001";
const CH: &str = "600000000000000001";
const THREAD: &str = "600000000000000009";

/// Lane settings with short oversight timings; `extra` adds config lines.
fn lane_hub(extra: &str) -> (TestHub, PathBuf) {
    let hub = TestHub::new("");
    let omp = hub.install_fake("omp");
    for f in ["rpc", "turns"] {
        hub.fixture("omp", f, Some(""));
    }
    let work = hub.root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    hub.write_config(&format!(
        "[omp]\npath = \"{}\"\n[lanes]\nmodel = \"fake/primary\"\ncwd = \"{}\"\nobjection = \"2s\"\n\
         [lanes.shell]\ndeny = [\"git push\", \"rm -rf\"]\n{extra}",
        omp.display(),
        work.display()
    ));
    (hub, work)
}

fn owner_room(hub: &TestHub) -> FakeDiscord {
    let fake = FakeDiscord::start();
    fake.channel(CH, 0, None);
    let token = hub.private_file("owner-token", "fake-token");
    let config = std::fs::read_to_string(hub.config_path()).unwrap();
    hub.write_config(&format!("{config}{}", fake.config(&token, OWNER, &[CH])));
    fake
}

fn data(hub: &TestHub) -> PathBuf {
    hub.root.join("bin/omp-data")
}

/// Starts the hub and waits until the OMP probe finished (starts need it, DESIGN 3.4).
fn start(hub: &mut TestHub) {
    hub.start();
    hub.until(WAIT, || {
        hub.json(&["status", "--json"])["omp"]
            .is_object()
            .then_some(())
    });
}

/// One lane operation; `Err` is the CLI's refusal.
fn lane(hub: &TestHub, op: &str, params: &Value) -> Result<Value, String> {
    let text = params.to_string();
    let out = hub.cli(&["lane", op, "--json", "--params", &text]);
    if out.status.success() {
        Ok(serde_json::from_slice(&out.stdout).unwrap())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
}

fn open(hub: &TestHub, key: &str, extra: &Value) -> Value {
    let mut p = json!({
        "key": key,
        "title": format!("Work {key}"),
        "brief": "Do the work.",
        "checks": [{ "kind": "command", "argv": ["true"] }],
    });
    for (k, v) in extra.as_object().unwrap() {
        p[k] = v.clone();
    }
    lane(hub, "open", &p).unwrap()
}

fn record(hub: &TestHub, key: &str) -> Value {
    let all = lane(hub, "list", &json!({ "all": true })).unwrap();
    all.as_array()
        .unwrap()
        .iter()
        .find(|l| l["key"] == key)
        .cloned()
        .unwrap_or(Value::Null)
}

fn events_of(hub: &TestHub, kind: &str) -> Vec<Value> {
    hub.events()
        .into_iter()
        .filter(|e| e["kind"] == kind)
        .collect()
}

fn goal(hub: &TestHub, session: &Value) -> String {
    std::fs::read_to_string(data(hub).join(format!("goal-{}", session.as_str().unwrap())))
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// The reconnect key the fake OMP's bridge of this session got: its launch token is used by that
/// bridge's own hello, so a test speaks for the session as a reconnect.
fn bridge_key(hub: &TestHub, session: &Value) -> String {
    let file = data(hub).join(format!("bridge-{}", session.as_str().unwrap()));
    hub.until(WAIT, || std::fs::read_to_string(&file).ok())
}

/// A test-side bridge connection.
struct Bridge {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
    next: u64,
}

impl Bridge {
    fn connect(hub: &TestHub, params: Value) -> (Self, Value) {
        let writer = UnixStream::connect(hub.socket()).unwrap();
        writer
            .set_read_timeout(Some(Duration::from_secs(20)))
            .unwrap();
        let reader = BufReader::new(writer.try_clone().unwrap());
        let mut b = Self {
            reader,
            writer,
            next: 1,
        };
        let answer = b.call("bridge.hello", params);
        (b, answer)
    }

    fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.next;
        self.next += 1;
        let mut line = json!({ "v": 1, "id": id, "method": method });
        line["params"] = params;
        self.writer
            .write_all(format!("{line}\n").as_bytes())
            .unwrap();
        loop {
            let mut reply = String::new();
            self.reader.read_line(&mut reply).unwrap();
            let v: Value = serde_json::from_str(&reply).unwrap();
            if v["id"] == id {
                return v["ok"].clone();
            }
        }
    }

    fn lane_tool(&mut self, call: &str, session: &Value, input: Value) -> Value {
        let mut params = json!({ "call": call, "tool": "cataly_lane", "session": session });
        params["input"] = input;
        self.call("bridge.tool", params)
    }
}

fn hello(hub: &TestHub, rec: &Value) -> (Bridge, Value) {
    let key = bridge_key(hub, &rec["session_id"]);
    Bridge::connect(
        hub,
        json!({ "ext": 1, "key": key, "session": rec["session_id"], "agent": "main" }),
    )
}

/// Check 1: preview writes nothing; bad inputs are refused; request-ID dedupe.
#[test]
fn open_preview_refusals_and_dedupe() {
    let (mut hub, work) = lane_hub("");
    start(&mut hub);
    let pids = || std::fs::read_to_string(data(&hub).join("pids")).unwrap_or_default();
    let before = pids();
    let preview = open(&hub, "web-1", &json!({ "preview": true }));
    assert_eq!(preview["preview"], true);
    assert!(
        preview["brief"]
            .as_str()
            .unwrap()
            .contains("Lane instructions")
    );
    assert_eq!(
        lane(&hub, "list", &json!({ "all": true })).unwrap(),
        json!([])
    );
    assert_eq!(pids(), before, "preview started no process");
    assert!(
        !hub.state().join("sessions/lanes/web-1").exists(),
        "preview made no session directory"
    );
    let base =
        json!({ "title": "t", "brief": "b", "checks": [{ "kind": "command", "argv": ["true"] }] });
    let refused = |patch: Value| {
        let mut p = base.clone();
        for (k, v) in patch.as_object().unwrap() {
            p[k] = v.clone();
        }
        lane(&hub, "open", &p).unwrap_err()
    };
    assert!(refused(json!({ "key": "Bad Key" })).contains("key"));
    assert!(refused(json!({ "key": "lead" })).contains("reserved"));
    assert!(
        refused(json!({ "key": "ok-1", "checks": [{ "kind": "pr_merged" }] })).contains("signal 1")
    );
    assert!(refused(json!({ "key": "ok-1", "checks": "merged" })).contains("list"));
    assert!(refused(json!({ "key": "ok-1", "model": "sonnet" })).contains("exact"));
    assert!(refused(json!({ "key": "ok-1", "model": "fake/*" })).contains("exact"));
    let first = open(
        &hub,
        "web-1",
        &json!({ "request_id": "req-1", "cwd": work }),
    );
    assert_eq!(first["outcome"], "started");
    let again = open(
        &hub,
        "web-1",
        &json!({ "request_id": "req-1", "cwd": work }),
    );
    assert_eq!(
        (again["outcome"].clone(), again["repeat"].clone()),
        (json!("started"), json!(true))
    );
    let other = lane(
        &hub,
        "open",
        &json!({ "key": "web-1", "title": "other", "brief": "b", "checks": base["checks"], "request_id": "req-1" }),
    );
    assert!(other.unwrap_err().contains("other inputs"));
    hub.stop();
}

/// Check 2: a model mismatch at start keeps the process, sends no brief, marks the start held and
/// tells the lead.
#[test]
fn model_mismatch_holds_the_start() {
    let (mut hub, _) = lane_hub("");
    let owner = owner_room(&hub);
    hub.fixture("omp", "model", Some("fake/other"));
    start(&mut hub);
    let out = open(&hub, "m-1", &json!({}));
    assert_eq!(out["outcome"], "start held: model");
    let rec = record(&hub, "m-1");
    assert_eq!(rec["state"], "held");
    assert!(
        rec["status"]
            .as_str()
            .unwrap()
            .contains("start held: model"),
        "{rec}"
    );
    assert_eq!(rec["live"], true, "the process is kept for inspection");
    let file = std::fs::read_to_string(rec["session_file"].as_str().unwrap()).unwrap();
    assert!(!file.contains("Lane instructions"), "no brief was sent");
    assert!(goal(&hub, &rec["session_id"]).is_empty(), "no goal was set");
    let alerts = hub.until(WAIT, || {
        let a = events_of(&hub, "lane.alert");
        (!a.is_empty()).then_some(a)
    });
    assert!(
        alerts[0]["text"]
            .as_str()
            .unwrap()
            .contains("start held: model")
    );
    owner.wait(WAIT, |fake| {
        fake.bot_messages(CH)
            .iter()
            .any(|message| {
                let text = message["content"].as_str().unwrap();
                text.contains("m-1") && text.contains("start held: model")
            })
            .then_some(())
    });
    hub.stop();
}

/// Check 3: report authority and evidence novelty.
#[test]
fn reports_need_the_current_run_and_novelty_counts_only_new_evidence() {
    let (mut hub, work) = lane_hub("");
    start(&mut hub);
    open(&hub, "r-1", &json!({}));
    let rec = record(&hub, "r-1");
    std::fs::write(work.join("out.txt"), "result").unwrap();
    let (mut b, answer) = hello(&hub, &rec);
    assert_eq!(answer["role"], "lane", "{answer}");
    assert_eq!(answer["pin"], "fake/primary");
    let report = |b: &mut Bridge, call: &str, session: &Value| {
        b.lane_tool(
            call,
            session,
            json!({ "op": "report", "kind": "progress", "text": "built it", "files": ["out.txt"] }),
        )
    };
    let first = report(&mut b, "c1", &rec["session_id"]);
    assert!(
        first["text"]
            .as_str()
            .unwrap()
            .contains("1 of 1 attached items count as new"),
        "{first}"
    );
    let again = report(&mut b, "c2", &rec["session_id"]);
    assert!(
        again["text"].as_str().unwrap().contains("seen before"),
        "{again}"
    );
    // Another session's connection is refused: the hello named a session the lane does not own.
    open(&hub, "r-2", &json!({}));
    let other = record(&hub, "r-2");
    let (mut b2, _) = Bridge::connect(
        &hub,
        json!({ "ext": 1, "key": bridge_key(&hub, &other["session_id"]), "session": "not-this-one", "agent": "main" }),
    );
    let refused = report(&mut b2, "c3", &json!("not-this-one"));
    assert_eq!(refused["error"], true);
    assert!(
        refused["text"]
            .as_str()
            .unwrap()
            .contains("the lane moved on")
    );
    // An earlier run: park and reopen; the old connection's run is gone.
    lane(&hub, "park", &json!({ "key": "r-1", "reason": "later" })).unwrap();
    let closed = report(&mut b, "c4", &rec["session_id"]);
    assert!(
        closed["text"]
            .as_str()
            .unwrap()
            .contains("the lane moved on"),
        "a closed lane"
    );
    lane(&hub, "reopen", &json!({ "key": "r-1" })).unwrap();
    let earlier = report(&mut b, "c5", &rec["session_id"]);
    assert!(
        earlier["text"]
            .as_str()
            .unwrap()
            .contains("the lane moved on"),
        "an earlier run"
    );
    hub.stop();
}

/// EVR req. 31: repeating a recorded step does not reopen its file evidence or alter the record.
#[test]
fn repeated_step_with_removed_file_is_unchanged() {
    let (mut hub, work) = lane_hub("");
    start(&mut hub);
    open(&hub, "step-file", &json!({}));
    let rec = record(&hub, "step-file");
    let (mut b, _) = hello(&hub, &rec);
    std::fs::write(work.join("out.txt"), "result").unwrap();
    let input = json!({
        "op": "step", "name": "build", "result": "built", "evidence": "out.txt",
        "receipts": ["build-1"], "files": ["out.txt"]
    });
    let first = b.lane_tool("first", &rec["session_id"], input.clone());
    assert_eq!(first["text"], "step 'build' recorded", "{first}");
    let before = b.lane_tool("before", &rec["session_id"], json!({ "op": "steps" }));

    std::fs::remove_file(work.join("out.txt")).unwrap();
    let again = b.lane_tool("again", &rec["session_id"], input.clone());
    assert_eq!(again["error"], false, "{again}");
    assert_eq!(again["text"], "step 'build' unchanged (recorded before)");
    let after = b.lane_tool("after", &rec["session_id"], json!({ "op": "steps" }));
    assert_eq!(after, before, "the original step stays intact");

    for (field, value) in [
        ("result", json!("different")),
        ("evidence", json!("elsewhere.txt")),
        ("receipts", json!(["build-2"])),
    ] {
        let mut changed = input.clone();
        changed[field] = value;
        let refused = b.lane_tool(field, &rec["session_id"], changed);
        assert_eq!(refused["error"], true, "{refused}");
        assert_eq!(
            refused["text"],
            "step 'build' is recorded with other content"
        );
    }
    let mut fresh = input;
    fresh["name"] = json!("another");
    let refused = b.lane_tool("fresh", &rec["session_id"], fresh);
    assert_eq!(refused["error"], true, "{refused}");
    assert_eq!(refused["text"], "out.txt: missing");
    hub.stop();
}

/// The unchanged reply also survives the bridge no longer having a tool's evidence facts.
#[test]
fn repeated_step_without_tool_facts_is_unchanged() {
    let (mut hub, _) = lane_hub("");
    start(&mut hub);
    open(&hub, "step-tool", &json!({}));
    let rec = record(&hub, "step-tool");
    let (mut b, _) = hello(&hub, &rec);
    let input = json!({
        "op": "step", "name": "build", "result": "built", "evidence": "write-1",
        "calls": ["write-1"]
    });
    let first = b.call(
        "bridge.tool",
        json!({
            "call": "first", "tool": "cataly_lane", "session": rec["session_id"],
            "input": input,
            "facts": [{ "call": "write-1", "tool": "write", "seen": true, "fingerprint": "result" }]
        }),
    );
    assert_eq!(first["text"], "step 'build' recorded", "{first}");
    let again = b.lane_tool("again", &rec["session_id"], input.clone());
    assert_eq!(again["error"], false, "{again}");
    assert_eq!(again["text"], "step 'build' unchanged (recorded before)");
    let mut fresh = input;
    fresh["name"] = json!("another");
    let refused = b.lane_tool("fresh", &rec["session_id"], fresh);
    assert_eq!(refused["error"], true, "{refused}");
    assert_eq!(
        refused["text"],
        "no tool facts from the bridge; nothing was recorded"
    );
    hub.stop();
}

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .output()
        .unwrap()
        .status
        .success();
    assert!(ok, "git {args:?}");
}

/// The quiet claim notice never went out; it belonged to that run and ends with it, so a reopen
/// starts with an empty inbox apart from its own note.
fn reopen_leaves_the_claim_notice_behind(hub: &TestHub, closed: &Value) {
    assert!(
        closed["receipt"]
            .to_string()
            .contains("1 unsent note(s) retired"),
        "{closed}"
    );
    let note = json!({ "key": "c-ok", "note": "one more thing" });
    let reopened = lane(hub, "reopen", &note).unwrap();
    assert!(
        reopened.as_str().unwrap().starts_with("resumed on session"),
        "{reopened}"
    );
    let file = record(hub, "c-ok")["session_file"]
        .as_str()
        .unwrap()
        .to_string();
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(text.contains("one more thing"), "{text}");
    assert!(!text.contains("[claim recorded]"), "{text}");
    lane(hub, "close", &json!({ "key": "c-ok", "note": "done" })).unwrap();
}

/// Check 4: claim, objection window and automatic close; unsent work and a failing check object;
/// a crash after the close intent resumes the close from its step.
#[test]
fn claims_object_on_unsent_work_and_failing_checks_and_close_survives_a_crash() {
    let (mut hub, work) = lane_hub("");
    let repo = work.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    std::fs::write(repo.join("a.txt"), "1").unwrap();
    git(&repo, &["add", "a.txt"]);
    git(&repo, &["commit", "-qm", "one"]);
    start(&mut hub);
    open(
        &hub,
        "c-fail",
        &json!({ "checks": [{ "kind": "command", "argv": ["false"] }] }),
    );
    open(&hub, "c-git", &json!({ "cwd": repo }));
    std::fs::write(repo.join("a.txt"), "2").unwrap();
    for key in ["c-fail", "c-git"] {
        let out = lane(
            &hub,
            "claim",
            &json!({ "key": key, "evidence": "report 1" }),
        )
        .unwrap();
        assert!(out.as_str().unwrap().contains("closes at"));
    }
    let rejected = |key: &str| {
        hub.until(WAIT, || {
            let r = record(&hub, key);
            (r["state"] == "rejected").then_some(r)
        })
    };
    let failed = rejected("c-fail");
    assert!(
        failed["objection"].to_string().contains("check failed"),
        "{failed}"
    );
    let unsent = rejected("c-git");
    assert!(
        unsent["objection"].to_string().contains("unsent work"),
        "{unsent}"
    );
    // An unopposed claim closes by itself after the window.
    open(&hub, "c-ok", &json!({}));
    lane(
        &hub,
        "claim",
        &json!({ "key": "c-ok", "evidence": "report 1" }),
    )
    .unwrap();
    let closed = hub.until(WAIT, || {
        let r = record(&hub, "c-ok");
        (r["state"] == "closed").then_some(r)
    });
    assert_eq!(closed["outcome"], "completed");
    reopen_leaves_the_claim_notice_behind(&hub, &closed);
    // A crash right after the close intent: the next hub finishes the close.
    open(&hub, "c-crash", &json!({}));
    hub.stop();
    hub.env.push((
        "CATALY_FAULT".into(),
        PathBuf::from("lane_after_close_intent"),
    ));
    start(&mut hub);
    hub.until(WAIT, || {
        (record(&hub, "c-crash")["live"] == true).then_some(())
    });
    let _ = lane(&hub, "close", &json!({ "key": "c-crash", "note": "done" }));
    hub.wait_exit(WAIT);
    hub.env.clear();
    start(&mut hub);
    let done = hub.until(WAIT, || {
        let r = record(&hub, "c-crash");
        (r["state"] == "closed").then_some(r)
    });
    assert_eq!(done["outcome"], "completed");
    assert!(
        done["receipt"].to_string().contains("pass command true"),
        "{done}"
    );
    hub.stop();
}

/// Check 5: pause confirms the goal paused first; resume restores; a held lane that starts a turn
/// stays held and the lead hears it once per active stretch. A held lane's goal is paused, so the
/// hub delivers nothing into it (HOST req. 50): the owner's thread message waits in the lane's inbox
/// until the resume, and the turn a held lane starts is its own (a background job's result).
#[test]
fn pause_resume_and_a_held_lane_that_turns() {
    let fake = FakeDiscord::start();
    let (mut hub, work) = lane_hub("");
    let token = hub.private_file("token", "fake-token");
    fake.channel(CH, 0, None);
    fake.thread(THREAD, CH);
    let config = std::fs::read_to_string(hub.config_path()).unwrap();
    hub.write_config(&format!("{config}{}", fake.config(&token, OWNER, &[CH])));
    start(&mut hub);
    open(
        &hub,
        "p-1",
        &json!({ "thread": format!("discord:{THREAD}"), "cwd": work }),
    );
    let rec = record(&hub, "p-1");
    let id = rec["session_id"].as_str().unwrap();
    let session_file = || std::fs::read_to_string(rec["session_file"].as_str().unwrap()).unwrap();
    assert_eq!(goal(&hub, &rec["session_id"]), "active");
    lane(
        &hub,
        "pause",
        &json!({ "key": "p-1", "reason": "owner said wait" }),
    )
    .unwrap();
    let held = record(&hub, "p-1");
    assert_eq!(
        (held["state"].clone(), goal(&hub, &rec["session_id"])),
        (json!("held"), "paused".to_string())
    );
    // The owner writes in the lane's thread: the message is the lane's and waits while it is held.
    hub.until(WAIT, || {
        (hub.json(&["discord", "status", "--json"])["healthy"] == true).then_some(())
    });
    fake.say(FakeDiscord::message(
        THREAD,
        700_000_000_000_000_001,
        OWNER,
        "how is it going?",
    ));
    hub.until(WAIT, || {
        (hub.json(&["discord", "status", "--json"])["counts"]["answers_waiting"] == 1).then_some(())
    });
    // The held lane turns by itself: it stays held, the lead hears it once for the stretch.
    let held_alerts = || {
        events_of(&hub, "lane.alert")
            .into_iter()
            .filter(|e| e["text"].as_str().unwrap().contains("held lane active"))
            .count()
    };
    std::fs::write(data(&hub).join(format!("background-{id}")), "").unwrap();
    hub.until(WAIT, || (held_alerts() == 1).then_some(()));
    hub.until(WAIT, || {
        session_file()
            .contains("background result read")
            .then_some(())
    });
    assert_eq!(record(&hub, "p-1")["state"], "held");
    assert_eq!(goal(&hub, &rec["session_id"]), "paused");
    assert!(
        !session_file().contains("how is it going?"),
        "nothing is delivered into a held lane"
    );
    // The next stretch after it went idle is reported again.
    std::thread::sleep(Duration::from_secs(1));
    std::fs::write(data(&hub).join(format!("background-{id}")), "").unwrap();
    hub.until(WAIT, || (held_alerts() == 2).then_some(()));
    lane(&hub, "resume", &json!({ "key": "p-1" })).unwrap();
    let back = record(&hub, "p-1");
    assert_eq!(
        (back["state"].clone(), goal(&hub, &rec["session_id"])),
        (json!("running"), "active".to_string())
    );
    hub.until(WAIT, || {
        session_file().contains("how is it going?").then_some(())
    });
    hub.stop();
}

/// A lane that paused its own goal to wait for an answer is not held: the owner's thread message
/// and the lead's message each resume the goal and are delivered (LANE req. 47). A goal blocked by
/// its budget keeps them out, and the lead hears the real reason.
#[test]
fn a_lane_waiting_with_its_own_paused_goal_gets_the_answer() {
    let fake = FakeDiscord::start();
    let (mut hub, work) = lane_hub("[lanes.oversight]\nsweep = \"1s\"\n");
    let token = hub.private_file("token", "fake-token");
    fake.channel(CH, 0, None);
    fake.thread(THREAD, CH);
    let config = std::fs::read_to_string(hub.config_path()).unwrap();
    hub.write_config(&format!("{config}{}", fake.config(&token, OWNER, &[CH])));
    start(&mut hub);
    open(
        &hub,
        "w-1",
        &json!({ "thread": format!("discord:{THREAD}"), "cwd": work }),
    );
    let rec = record(&hub, "w-1");
    let id = rec["session_id"].as_str().unwrap();
    let session_file = || std::fs::read_to_string(rec["session_file"].as_str().unwrap()).unwrap();
    hub.until(WAIT, || {
        (hub.json(&["discord", "status", "--json"])["healthy"] == true).then_some(())
    });
    // The lane sets its goal to `status` in a turn of its own, as OMP's goal tool does while the
    // lane waits on the owner.
    let set_goal_in_a_turn = |status: &str| {
        let before = session_file().matches("background result read").count();
        std::fs::write(data(&hub).join(format!("goal-{id}")), status).unwrap();
        std::fs::write(data(&hub).join(format!("background-{id}")), "").unwrap();
        hub.until(WAIT, || {
            (session_file().matches("background result read").count() > before).then_some(())
        });
    };
    set_goal_in_a_turn("paused");
    fake.say(FakeDiscord::message(
        THREAD,
        700_000_000_000_000_001,
        OWNER,
        "A, the first design",
    ));
    hub.until(WAIT, || {
        session_file().contains("A, the first design").then_some(())
    });
    assert_eq!(goal(&hub, &rec["session_id"]), "active");
    assert_eq!(record(&hub, "w-1")["state"], "running");
    let resumed = || {
        events_of(&hub, "lane.alert")
            .into_iter()
            .filter(|e| e["text"].as_str().unwrap().contains("goal resumed"))
            .count()
    };
    assert_eq!(resumed(), 1);
    // The lead's message does the same.
    set_goal_in_a_turn("paused");
    lane(
        &hub,
        "send",
        &json!({ "key": "w-1", "text": "the owner picked A" }),
    )
    .unwrap();
    hub.until(WAIT, || {
        session_file().contains("the owner picked A").then_some(())
    });
    assert_eq!(goal(&hub, &rec["session_id"]), "active");
    assert_eq!(resumed(), 2);
    // A goal blocked by its budget is not the lane's to lift: the message waits and the lead
    // hears why.
    set_goal_in_a_turn("budget-limited");
    fake.say(FakeDiscord::message(
        THREAD,
        700_000_000_000_000_002,
        OWNER,
        "any news?",
    ));
    let alert = hub.until(WAIT, || {
        events_of(&hub, "lane.alert")
            .into_iter()
            .find(|e| e["text"].as_str().unwrap().contains("messages undelivered"))
    });
    assert!(
        alert["text"]
            .as_str()
            .unwrap()
            .contains("the goal is blocked by its budget"),
        "{alert}"
    );
    assert!(!session_file().contains("any news?"));
    assert_eq!(resumed(), 2);
    hub.stop();
}

/// Check 6: park, then reopen on the exact file with a new run ID; a header naming another session
/// refuses the reopen.
#[test]
fn park_and_reopen_on_the_exact_session() {
    let (mut hub, _) = lane_hub("");
    start(&mut hub);
    open(&hub, "k-1", &json!({}));
    open(&hub, "k-2", &json!({}));
    let before = record(&hub, "k-1");
    let parked = lane(
        &hub,
        "park",
        &json!({ "key": "k-1", "reason": "waiting for review", "condition": "PR approved" }),
    )
    .unwrap();
    assert_eq!(parked, json!("closed parked"));
    let rec = record(&hub, "k-1");
    assert_eq!(
        (
            rec["state"].clone(),
            rec["outcome"].clone(),
            rec["live"].clone()
        ),
        (json!("closed"), json!("parked"), json!(false))
    );
    lane(
        &hub,
        "reopen",
        &json!({ "key": "k-1", "note": "review is in" }),
    )
    .unwrap();
    let after = record(&hub, "k-1");
    assert_eq!(after["state"], "running");
    assert_eq!(after["session_id"], before["session_id"]);
    assert_eq!(after["session_file"], before["session_file"]);
    assert_ne!(after["run_id"], before["run_id"]);
    lane(&hub, "park", &json!({ "key": "k-2", "reason": "later" })).unwrap();
    let k2 = record(&hub, "k-2");
    let path = k2["session_file"].as_str().unwrap();
    let text = std::fs::read_to_string(path).unwrap();
    let forged = text.replacen(
        k2["session_id"].as_str().unwrap(),
        "00000000-0000-0000-0000-000000000000",
        1,
    );
    std::fs::write(path, forged).unwrap();
    let refused = lane(&hub, "reopen", &json!({ "key": "k-2" })).unwrap();
    let refused = refused.as_str().unwrap();
    assert!(
        refused.starts_with("held:") && refused.contains("another session"),
        "{refused}"
    );
    let held = record(&hub, "k-2");
    assert_eq!(held["state"], "closed");
    assert_eq!(held["session_id"], k2["session_id"]);
    assert_eq!(held["run_id"], k2["run_id"]);
    hub.stop();
}

/// Check 7: shell rules through the bridge link: blocks name rule numbers and a digest only; a
/// one-attempt grant is used up by the next identical command.
#[test]
fn shell_rules_block_and_grants_are_one_attempt() {
    let (mut hub, _) = lane_hub("");
    start(&mut hub);
    open(&hub, "s-1", &json!({}));
    let rec = record(&hub, "s-1");
    let (mut b, answer) = hello(&hub, &rec);
    assert_eq!(answer["shell"], true);
    let shell = |b: &mut Bridge, command: &str| {
        b.call(
            "bridge.shell",
            json!({ "tool": "bash", "command": command, "session": rec["session_id"] }),
        )
    };
    assert_eq!(shell(&mut b, "ls -la")["allow"], true);
    let blocked = shell(&mut b, "git push origin main");
    assert_eq!(blocked["allow"], false);
    let reason = blocked["reason"].as_str().unwrap();
    assert!(
        reason.contains("rule 1") && reason.contains("sha256") && !reason.contains("origin main"),
        "{reason}"
    );
    // The lane's own tool named in bash is refused with a pointer to the direct call (DESIGN 12.2
    // A13); the tool name by path is judged by the rules as usual.
    let report = "cataly_lane report --kind progress --text 'ready' 2>&1 | head -5";
    for line in [report.to_string(), format!("ls; {report}")] {
        let refused = shell(&mut b, &line).to_string();
        let pointer = "\"allow\":false,\"reason\":\"No command ran: cataly_lane is a tool";
        assert!(refused.contains(pointer), "{refused}");
    }
    let by_path = shell(&mut b, "/tmp/cataly_lane report --text 'git push'").to_string();
    assert!(by_path.contains("rule 1"), "{by_path}");
    assert_eq!(shell(&mut b, "omp usage reset")["allow"], false);
    assert!(
        lane(
            &hub,
            "grant",
            &json!({ "key": "s-1", "rule": 0, "reason": "x" })
        )
        .is_err(),
        "rule 0 is never granted"
    );
    shell(&mut b, "git push origin main");
    lane(
        &hub,
        "grant",
        &json!({ "key": "s-1", "rule": 1, "reason": "owner approved the push" }),
    )
    .unwrap();
    assert_eq!(
        shell(&mut b, "git push origin main")["allow"],
        true,
        "the grant allows one attempt"
    );
    assert_eq!(
        shell(&mut b, "git push origin main")["allow"],
        false,
        "and is used up"
    );
    assert_eq!(
        b.call("bridge.shell", json!({ "tool": "bash", "command": 7 }))["allow"],
        false,
        "no command string"
    );
    // A subagent spawn needs the session on disk (EXT req. 34).
    assert_eq!(
        b.call("bridge.shell", json!({ "tool": "task", "saved": false }))["allow"],
        false
    );
    assert_eq!(
        b.call("bridge.shell", json!({ "tool": "task", "saved": true }))["allow"],
        true
    );
    // The model barrier: the pin or the fallback OMP announced passes; anything else holds the turn.
    let model = |b: &mut Bridge, facts: Value| b.call("bridge.model", facts)["allow"].clone();
    assert_eq!(model(&mut b, json!({ "model": "fake/Primary" })), true);
    assert_eq!(model(&mut b, json!({ "model": "fake/other" })), false);
    assert_eq!(
        model(
            &mut b,
            json!({ "model": "fake/other", "fallback": "fake/other:high" })
        ),
        true
    );
    hub.until(WAIT, || {
        events_of(&hub, "lane.alert")
            .iter()
            .any(|e| {
                e["text"]
                    .as_str()
                    .unwrap()
                    .contains("pinned fake/primary; OMP is on fake/other")
            })
            .then_some(())
    });
    // A session that belongs to no open lane is blocked.
    lane(
        &hub,
        "abandon",
        &json!({ "key": "s-1", "reason": "done with it" }),
    )
    .unwrap();
    assert_eq!(shell(&mut b, "ls")["allow"], false);
    hub.stop();
}

/// Check 8: reminders while idle, one stall alert, the cost ceiling holds the lane and reaches OMP as
/// `--max-cost`.
#[test]
fn oversight_reminds_alerts_once_and_holds_at_the_ceiling() {
    let (mut hub, _) = lane_hub(
        "[lanes.oversight]\nfirst_reminder = \"2s\"\nsecond_reminder = \"3s\"\nstall = \"8s\"\nsweep = \"1s\"\n",
    );
    start(&mut hub);
    let opened = Instant::now();
    open(&hub, "o-1", &json!({}));
    let rec = record(&hub, "o-1");
    let file = PathBuf::from(rec["session_file"].as_str().unwrap());
    let reminders = |_: &TestHub| {
        std::fs::read_to_string(&file)
            .unwrap_or_default()
            .matches("[reminder ")
            .count()
    };
    hub.until(WAIT, || (reminders(&hub) >= 2).then_some(()));
    let stall = hub.until(WAIT, || {
        let s: Vec<Value> = events_of(&hub, "lane.alert")
            .into_iter()
            .filter(|e| e["text"].as_str().unwrap().contains(" stall: "))
            .collect();
        (!s.is_empty()).then_some(s)
    });
    assert!(opened.elapsed() >= Duration::from_secs(8));
    std::thread::sleep(Duration::from_secs(4));
    assert_eq!(reminders(&hub), 2, "no third reminder");
    let stalls = events_of(&hub, "lane.alert")
        .into_iter()
        .filter(|e| e["text"].as_str().unwrap().contains(" stall: "))
        .count();
    assert_eq!((stalls, stall.len()), (1, 1), "one stall alert per round");
    // Cost ceiling: on the command line, and reaching it holds the lane.
    open(&hub, "o-2", &json!({ "ceilings": { "cost": 0.5 } }));
    let argv = std::fs::read_to_string(data(&hub).join("argv")).unwrap();
    assert!(argv.contains("--max-cost=0.5"), "{argv}");
    let r2 = record(&hub, "o-2");
    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .open(r2["session_file"].as_str().unwrap())
        .unwrap();
    writeln!(
        f,
        r#"{{"type":"message","id":"u1","message":{{"role":"assistant","content":[],"usage":{{"input":10,"output":5,"cost":{{"total":0.75}}}}}}}}"#
    )
    .unwrap();
    let held = hub.until(WAIT, || {
        let r = record(&hub, "o-2");
        (r["state"] == "held").then_some(r)
    });
    assert_eq!(held["held_by"], "oversight");
    assert!(held["reason"].as_str().unwrap().contains("ceiling reached"));
    assert_eq!(goal(&hub, &r2["session_id"]), "paused");
    hub.stop();
}

/// A step with new evidence starts a new round (COORD req. 7): after one stall alert, a lane that
/// moves on only through steps is alerted again when it stalls again.
#[test]
fn a_step_with_new_evidence_starts_a_new_round() {
    let (mut hub, work) = lane_hub(
        "[lanes.oversight]\nfirst_reminder = \"1s\"\nsecond_reminder = \"2s\"\nstall = \"3s\"\nsweep = \"1s\"\n",
    );
    start(&mut hub);
    open(&hub, "s-1", &json!({}));
    let rec = record(&hub, "s-1");
    let stalls = |hub: &TestHub| {
        events_of(hub, "lane.alert")
            .into_iter()
            .filter(|e| e["text"].as_str().unwrap().contains(" stall: "))
            .count()
    };
    hub.until(WAIT, || (stalls(&hub) == 1).then_some(()));
    std::fs::write(work.join("built.txt"), "result").unwrap();
    let (mut b, _) = hello(&hub, &rec);
    let step = b.lane_tool(
        "c1",
        &rec["session_id"],
        json!({ "op": "step", "name": "build", "result": "built", "evidence": "built.txt",
                "files": ["built.txt"] }),
    );
    assert_eq!(step["text"], "step 'build' recorded", "{step}");
    hub.until(WAIT, || (stalls(&hub) == 2).then_some(()));
    hub.stop();
}

/// Check 9: stuck and finished reports post to the thread at once, progress by the quiet rule;
/// paths are cleaned; each report posts at most once.
#[test]
fn reports_reach_the_thread_by_policy() {
    let fake = FakeDiscord::start();
    let (mut hub, work) = lane_hub("[lanes.oversight]\nthread_quiet = \"3s\"\nsweep = \"1s\"\n");
    let token = hub.private_file("token", "fake-token");
    fake.channel(CH, 0, None);
    fake.thread(THREAD, CH);
    let config = std::fs::read_to_string(hub.config_path()).unwrap();
    hub.write_config(&format!("{config}{}", fake.config(&token, OWNER, &[CH])));
    start(&mut hub);
    open(
        &hub,
        "t-1",
        &json!({ "thread": format!("discord:{THREAD}"), "cwd": work }),
    );
    let rec = record(&hub, "t-1");
    let (mut b, _) = hello(&hub, &rec);
    let home = hub.root.join("home");
    let posts = || fake.bot_messages(THREAD);
    b.lane_tool(
        "p1",
        &rec["session_id"],
        json!({ "op": "report", "kind": "progress", "text": "halfway" }),
    );
    std::thread::sleep(Duration::from_secs(1));
    assert!(posts().is_empty(), "progress waits for the quiet rule");
    let progress = fake.wait(WAIT, |f| {
        let p = f.bot_messages(THREAD);
        (!p.is_empty()).then_some(p)
    });
    assert!(progress[0]["content"].as_str().unwrap().contains("halfway"));
    let stuck = format!(
        "blocked on {}/notes.txt and /etc/hosts, see https://ci.example/run?id=7",
        home.display()
    );
    b.lane_tool(
        "p2",
        &rec["session_id"],
        json!({ "op": "report", "kind": "stuck", "text": stuck }),
    );
    let second = hub.until(WAIT, || {
        let p = posts();
        (p.len() >= 2).then_some(p)
    });
    let text = second[1]["content"].as_str().unwrap();
    assert!(text.starts_with("Lane update:"), "{text}");
    assert!(
        text.contains("~/notes.txt and [path removed], see")
            && text.ends_with("https://ci.example/run"),
        "{text}"
    );
    assert!(!text.contains("id=7"));
    // A progress report a later one superseded is never sent: the quiet rule sends the last (WS req. 14).
    b.lane_tool(
        "p3",
        &rec["session_id"],
        json!({ "op": "report", "kind": "progress", "text": "superseded" }),
    );
    b.lane_tool(
        "p4",
        &rec["session_id"],
        json!({ "op": "report", "kind": "finished", "text": "all done" }),
    );
    hub.until(WAIT, || (posts().len() >= 3).then_some(()));
    std::thread::sleep(Duration::from_secs(4));
    let all = posts();
    assert_eq!(all.len(), 3, "each report posts at most once: {all:?}");
    assert!(all[2]["content"].as_str().unwrap().contains("all done"));
    let reports = lane(&hub, "reports", &json!({ "key": "t-1" })).unwrap();
    let relay: Vec<(String, String)> = reports
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["text"].as_str().unwrap().to_string(),
                r["relay"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(
        relay.iter().filter(|(_, r)| r == "posted").count(),
        3,
        "{reports}"
    );
    assert!(
        relay
            .iter()
            .any(|(t, r)| t == "superseded" && r == "not posted"),
        "{reports}"
    );
    hub.stop();
}

/// Running lanes resume on their exact files; an owner-paused lane stays down with its goal paused.
/// The owner receives the recap of both outcomes.
#[test]
fn hub_restart_brings_lanes_back_on_their_files() {
    let (mut hub, _) = lane_hub("");
    let owner = owner_room(&hub);
    start(&mut hub);
    for key in ["a-1", "a-2", "a-3"] {
        open(&hub, key, &json!({}));
    }
    lane(
        &hub,
        "pause",
        &json!({ "key": "a-3", "reason": "owner said wait" }),
    )
    .unwrap();
    let before: Vec<Value> = ["a-1", "a-2", "a-3"]
        .iter()
        .map(|k| record(&hub, k))
        .collect();
    hub.stop();
    start(&mut hub);
    let after: Vec<Value> = hub.until(WAIT, || {
        let r: Vec<Value> = ["a-1", "a-2", "a-3"]
            .iter()
            .map(|k| record(&hub, k))
            .collect();
        (r[0]["live"] == true && r[1]["live"] == true && r[2]["live"] == false).then_some(r)
    });
    for (b, a) in before.iter().zip(&after) {
        assert_eq!(a["session_id"], b["session_id"], "{a}");
        assert_eq!(a["session_file"], b["session_file"]);
    }
    hub.until(WAIT, || {
        (goal(&hub, &after[1]["session_id"]) == "active").then_some(())
    });
    assert_eq!(goal(&hub, &after[0]["session_id"]), "active");
    assert_eq!(goal(&hub, &after[2]["session_id"]), "paused");
    assert_eq!(after[2]["state"], "held");
    assert_eq!(after[2]["live"], false);
    let recap = hub.until(WAIT, || {
        let r = events_of(&hub, "lane.recap");
        (!r.is_empty()).then_some(r)
    });
    let text = recap[0]["text"].as_str().unwrap();
    assert!(text.contains("a-3: held:"), "{text}");
    assert!(text.contains("a-1: restarted; goal active"), "{text}");
    owner.wait(WAIT, |fake| {
        fake.bot_messages(CH)
            .iter()
            .any(|message| {
                let text = message["content"].as_str().unwrap();
                text.contains("a-1: restarted") && text.contains("a-3: held:")
            })
            .then_some(())
    });
    hub.stop();
}

/// `lane model` pins what OMP resolved the selector to: a literal colon ID stays whole and a level
/// suffix stays the thinking level, so the lane restarts on exactly that model.
#[test]
fn lane_model_keeps_literal_ids_and_levels_over_a_restart() {
    let (mut hub, _) = lane_hub("");
    hub.fixture("omp", "literal", Some("ollama/qwen:14b"));
    start(&mut hub);
    open(&hub, "mc-1", &json!({}));
    let file = record(&hub, "mc-1")["session_file"]
        .as_str()
        .unwrap()
        .to_string();
    let restarted = |hub: &mut TestHub| {
        hub.stop();
        let before = std::fs::read_to_string(data(hub).join("argv")).unwrap();
        start(hub);
        hub.until(WAIT, || {
            let argv = std::fs::read_to_string(data(hub).join("argv")).unwrap();
            let launch = argv[before.len()..]
                .lines()
                .find(|l| l.contains(&file))
                .map(str::to_string)?;
            (record(hub, "mc-1")["live"] == true).then_some(launch)
        })
    };
    let changed = lane(
        &hub,
        "model",
        &json!({ "key": "mc-1", "model": "ollama/qwen:14b" }),
    );
    assert_eq!(changed, Ok(json!("ollama/qwen:14b")));
    let launch = restarted(&mut hub);
    assert!(
        launch.contains("--model=ollama/qwen:14b") && !launch.contains("--thinking"),
        "{launch}"
    );
    let changed = lane(
        &hub,
        "model",
        &json!({ "key": "mc-1", "model": "fake/second:high" }),
    );
    assert_eq!(changed, Ok(json!("fake/second")));
    let launch = restarted(&mut hub);
    assert!(
        launch.contains("--model=fake/second ") && launch.contains("--thinking=high"),
        "{launch}"
    );
    hub.stop();
}

/// Hub CPU time (user plus system clock ticks) from `/proc`.
fn cpu_ticks(pid: u32) -> u64 {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
    let after = stat.rsplit_once(')').unwrap().1;
    let fields: Vec<&str> = after.split_whitespace().collect();
    fields[11].parse::<u64>().unwrap() + fields[12].parse::<u64>().unwrap()
}

/// Slice-3a measurement: hub CPU with eight idle open lanes over two minutes, scaled to an hour
/// (oversight sweeps, spend reads, watches). Run with `cargo test --release --test lanes --
/// --ignored --nocapture oversight_cpu`.
#[test]
#[ignore = "measurement"]
fn oversight_cpu_with_eight_lanes() {
    let (mut hub, _) = lane_hub("");
    start(&mut hub);
    for n in 0..8 {
        open(&hub, &format!("cpu-{n}"), &json!({}));
    }
    std::thread::sleep(Duration::from_secs(5));
    let window = Duration::from_secs(120);
    let before = cpu_ticks(hub.pid());
    std::thread::sleep(window);
    let used = cpu_ticks(hub.pid()) - before;
    // Linux clock ticks are 100 per second.
    let per_hour = f64::from(u32::try_from(used).unwrap()) / 100.0 * 3600.0 / window.as_secs_f64();
    eprintln!("MEASURE oversight_cpu_8_lanes ticks={used} per_hour_s={per_hour:.2}");
    hub.stop();
}

/// The lead's bridge, connected with the lead session's launch token.
fn lead_bridge(hub: &TestHub) -> (Bridge, Value) {
    let session = hub.until(WAIT, || {
        let v = hub.json(&["lead", "status", "--json"]);
        (v["phase"] == "live").then(|| v["session"]["session_id"].clone())
    });
    let (bridge, hello) = Bridge::connect(
        hub,
        json!({ "ext": 1, "key": bridge_key(hub, &session), "session": session, "agent": "main" }),
    );
    (bridge, json!({ "hello": hello, "session": session }))
}

fn lead_tool(bridge: &mut Bridge, session: &Value, call: &str, input: Value) -> (String, bool) {
    let mut params = json!({ "call": call, "tool": "cataly_lead", "session": session });
    params["input"] = input;
    let v = bridge.call("bridge.tool", params);
    (
        v["text"].as_str().unwrap_or_default().to_string(),
        v["error"] == true,
    )
}

/// COORD req. 47: the lead creates the owner notes only with the owner's message, once; a save
/// before that is refused and one after it passes the check.
#[test]
fn lead_creates_owner_notes_on_the_owners_request() {
    let (mut hub, work) = lane_hub("");
    let text = std::fs::read_to_string(hub.config_path()).unwrap();
    hub.write_config(&format!(
        "{text}[lead]\nmodel = \"fake/primary\"\ncwd = \"{}\"\n",
        work.display()
    ));
    start(&mut hub);
    let (mut b, meta) = lead_bridge(&hub);
    let s = meta["session"].clone();
    let save = json!({ "op": "profile.save", "text": "# Owner notes\n" });
    let (why, err) = lead_tool(&mut b, &s, "p1", save);
    assert!(err && why.contains("profile.create"), "{why}");
    let (why, err) = lead_tool(&mut b, &s, "p2", json!({ "op": "profile.create" }));
    assert!(err && why.contains("message"), "{why}");
    assert!(!hub.state().join("profile.md").exists());
    for (n, message) in [
        json!(null),
        json!(42),
        json!(" "),
        json!("first\nsecond"),
        json!("x".repeat(401)),
        json!("someone@example.org"),
        json!(format!("ghp_{}", "a1".repeat(18))),
    ]
    .into_iter()
    .enumerate()
    {
        let (why, err) = lead_tool(
            &mut b,
            &s,
            &format!("invalid-{n}"),
            json!({ "op": "profile.create", "message": message }),
        );
        assert!(err, "invalid citation {n} was accepted: {why}");
        assert!(!hub.state().join("profile.md").exists());
    }
    let create = json!({ "op": "profile.create", "message": "discord:1/2" });
    let (why, err) = lead_tool(&mut b, &s, "p3", create.clone());
    assert!(!err, "{why}");
    let (why, err) = lead_tool(&mut b, &s, "p4", create);
    assert!(err && why.contains("already exist"), "{why}");
    let (shown, err) = lead_tool(&mut b, &s, "p5", json!({ "op": "profile.read" }));
    assert!(!err, "{shown}");
    assert!(
        shown.contains("on the owner's request (message discord:1/2)"),
        "the create keeps the owner's message: {shown}"
    );
    let mut notes = shown.trim_end().to_string();
    notes = notes.replacen(
        "## Standing decisions",
        "## Standing decisions\n\n- (2026-01-01) All pull requests come from one account.",
        1,
    );
    let (why, err) = lead_tool(
        &mut b,
        &s,
        "p6",
        json!({ "op": "profile.save", "text": format!("{notes}\n") }),
    );
    assert!(!err, "{why}");
}

fn question_hub() -> (FakeDiscord, TestHub, PathBuf) {
    let fake = FakeDiscord::start();
    let (mut hub, work) = lane_hub("");
    let token = hub.private_file("token", "fake-token");
    fake.channel(CH, 0, None);
    fake.thread(THREAD, CH);
    let config = std::fs::read_to_string(hub.config_path()).unwrap();
    hub.write_config(&format!(
        "{config}{}[lead]\nmodel = \"fake/primary\"\ncwd = \"{}\"\n",
        fake.config(&token, OWNER, &[CH]),
        work.display()
    ));
    start(&mut hub);
    hub.until(WAIT, || {
        (hub.json(&["discord", "status", "--json"])["healthy"] == true).then_some(())
    });
    (fake, hub, work)
}

fn question_input(thread: Option<String>, room: Option<&str>) -> Value {
    let mut v = json!({ "op": "question.ask", "text": "Which?", "source": "discord:1:2",
        "options": ["a", "b"] });
    if let Some(t) = thread {
        v["thread"] = json!(t);
    }
    if let Some(r) = room {
        v["room"] = json!(r);
    }
    v
}

/// Destination precedence and explicit refusals use the same posting path as lane questions.
#[test]
fn question_destinations_follow_parameters_and_refuse_invalid_rooms() {
    let (fake, mut hub, _work) = question_hub();
    let (mut b, meta) = lead_bridge(&hub);
    let s = meta["session"].clone();
    for (n, (thread, room, expected)) in [
        (Some(format!("discord:{THREAD}")), Some(CH), CH),
        (Some(format!("discord:{THREAD}")), Some(" "), THREAD),
        (Some("telegram:5".into()), None, CH),
        (None, None, CH),
    ]
    .into_iter()
    .enumerate()
    {
        let (said, err) = lead_tool(&mut b, &s, &format!("q{n}"), question_input(thread, room));
        assert!(
            !err && said.contains(&format!("posted in {expected}")),
            "{said}"
        );
    }
    assert_eq!(
        (fake.bot_messages(THREAD).len(), fake.bot_messages(CH).len()),
        (1, 3)
    );
    let (before, _) = lead_tool(&mut b, &s, "before", json!({ "op": "questions" }));
    let denied = "123456789012345678";
    fake.script_in(denied, &[403]);
    for (n, room) in [format!("discord:{CH}"), denied.into()].iter().enumerate() {
        let input = question_input(Some(format!("discord:{THREAD}")), Some(room));
        let (why, err) = lead_tool(&mut b, &s, &format!("bad{n}"), input);
        assert!(err && why.contains("room"), "{why}");
    }
    let (after, _) = lead_tool(&mut b, &s, "after", json!({ "op": "questions" }));
    assert_eq!(before, after, "nothing recorded");
    assert_eq!(
        (fake.bot_messages(THREAD).len(), fake.bot_messages(CH).len()),
        (1, 3)
    );
    drop(b);
    hub.stop();
}

/// Both typed and button answers in a lane's thread reach the lead; later ordinary replies do not.
#[test]
fn question_ask_posts_in_its_thread() {
    let (fake, mut hub, work) = question_hub();
    open(
        &hub,
        "q-1",
        &json!({ "thread": format!("discord:{THREAD}"), "cwd": work }),
    );
    let rec = record(&hub, "q-1");
    let lane_file = || std::fs::read_to_string(rec["session_file"].as_str().unwrap()).unwrap();
    let (mut b, meta) = lead_bridge(&hub);
    let s = meta["session"].clone();
    let lead = hub.json(&["lead", "status", "--json"]);
    let lead_file = PathBuf::from(lead["session"]["session_file"].as_str().unwrap());
    let in_thread = || Some(format!("discord:{THREAD}"));
    let posts = |room: &str| fake.bot_messages(room).len();
    // The thread, when no room is given.
    let (said, err) = lead_tool(&mut b, &s, "q1", question_input(in_thread(), None));
    assert!(
        !err && said.contains(&format!("posted in {THREAD}")),
        "{said}"
    );
    assert_eq!((posts(THREAD), posts(CH)), (1, 0));
    let asked = fake.bot_messages(THREAD)[0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    // The owner answers the lead's question in the lane's thread: the lead gets it, the lane not.
    let mut reply = FakeDiscord::message(THREAD, 700_000_000_000_000_001, OWNER, "1");
    reply["message_reference"] = json!({ "message_id": asked, "channel_id": THREAD });
    fake.say(reply);
    hub.until(WAIT, || {
        std::fs::read_to_string(&lead_file)
            .unwrap()
            .contains("answers question")
            .then_some(())
    });
    assert!(
        !lane_file().contains("answers question"),
        "the lane does not get it"
    );
    // A later reply to the settled question is the lane's again.
    let mut later = FakeDiscord::message(THREAD, 700_000_000_000_000_002, OWNER, "late follow-up");
    later["message_reference"] = json!({ "message_id": asked, "channel_id": THREAD });
    fake.say(later);
    hub.until(WAIT, || {
        lane_file().contains("late follow-up").then_some(())
    });
    // A reply to any other message in the lane's thread is still the lane's.
    let mut other = FakeDiscord::message(THREAD, 700_000_000_000_000_004, OWNER, "lane reply");
    other["message_reference"] =
        json!({ "message_id": "700000000000000001", "channel_id": THREAD });
    fake.say(other);
    hub.until(WAIT, || lane_file().contains("lane reply").then_some(()));
    // A second question in the same lane thread is answered by button, not handed to the lane.
    let (said, err) = lead_tool(&mut b, &s, "q-button", question_input(in_thread(), None));
    assert!(!err, "{said}");
    let id = said.split_whitespace().nth(1).unwrap();
    let message = said.split_whitespace().last().unwrap();
    fake.press(OWNER, THREAD, message, &format!("cy:{id}:1"));
    hub.until(WAIT, || {
        std::fs::read_to_string(&lead_file)
            .unwrap()
            .contains(&format!("question {id}"))
            .then_some(())
    });
    let edited = fake.wait(WAIT, |f| {
        f.bot_messages(THREAD)
            .into_iter()
            .find(|m| m["id"] == message && m["components"].as_array().is_some_and(Vec::is_empty))
    });
    assert!(
        edited["content"].as_str().unwrap().contains("2. b"),
        "{edited}"
    );
    assert!(
        !lane_file().contains(id),
        "the button answer belongs to the lead"
    );
    drop(b);
    hub.stop();
}

/// Owner-facing inventory uses the accepted bridge, not a local OMP session note.
#[test]
fn nonstock_capabilities_reach_status_and_stay_scoped_to_live_connections() {
    let (mut hub, work) = lane_hub("");
    let config = std::fs::read_to_string(hub.config_path()).unwrap();
    hub.write_config(&format!(
        "{config}[lead]\nmodel = \"fake/primary\"\ncwd = \"{}\"\n",
        work.display()
    ));
    start(&mut hub);
    let (mut bridge, meta) = lead_bridge(&hub);
    let session = meta["session"].as_str().unwrap();
    let empty = json!({ "session": session, "nonstock": [] });
    assert_eq!(bridge.call("bridge.capabilities", empty.clone()), json!({}));
    for args in [&["status"][..], &["lead", "status"][..]] {
        let output = hub.cli(args);
        assert!(output.status.success());
        assert!(
            String::from_utf8(output.stdout)
                .unwrap()
                .lines()
                .any(|line| line == format!("tools    {session}: non-stock none"))
        );
    }

    let report = json!({ "session": session, "nonstock": ["owner_tool", "mcp__owner_search", "owner_tool"] });
    assert_eq!(
        bridge.call("bridge.capabilities", report.clone()),
        json!({})
    );
    assert_eq!(bridge.call("bridge.capabilities", report), json!({}));
    let expected = json!([{ "session": session, "nonstock": ["mcp__owner_search", "owner_tool"] }]);
    for args in [&["status", "--json"][..], &["lead", "status", "--json"][..]] {
        assert_eq!(hub.json(args)["tools"], expected);
    }
    for args in [&["status"][..], &["lead", "status"][..]] {
        let output = hub.cli(args);
        assert!(output.status.success());
        assert!(
            String::from_utf8(output.stdout)
                .unwrap()
                .lines()
                .any(|line| line
                    == format!("tools    {session}: non-stock mcp__owner_search, owner_tool"))
        );
    }
    let log = std::fs::read_to_string(hub.state().join("logs/hub.log")).unwrap();
    assert_eq!(
        log.lines()
            .filter(|line| line.contains("session non-stock tools changed"))
            .count(),
        2
    );

    // Malformed and cross-session reports cannot overwrite the accepted connection's inventory.
    for bad in [
        json!({ "session": session, "nonstock": [42] }),
        json!({ "session": "someone-else", "nonstock": ["wrong"] }),
    ] {
        assert_eq!(bridge.call("bridge.capabilities", bad), Value::Null);
    }
    assert_eq!(hub.json(&["status", "--json"])["tools"], expected);

    let (mut sub, welcome) = Bridge::connect(
        &hub,
        json!({
            "ext": 1, "session": "sub-session", "agent": "sub", "parent": session
        }),
    );
    assert_eq!(welcome["role"], "lead");
    assert_eq!(
        sub.call(
            "bridge.capabilities",
            json!({
                "session": "sub-session", "nonstock": ["sub_tool"]
            })
        ),
        json!({})
    );
    let mut both = expected.as_array().unwrap().clone();
    both.push(json!({ "session": "sub-session", "nonstock": ["sub_tool"] }));
    both.sort_by(|a, b| a["session"].as_str().cmp(&b["session"].as_str()));
    assert_eq!(hub.json(&["status", "--json"])["tools"], json!(both));
    assert_eq!(
        hub.json(&["lead", "status", "--json"])["tools"],
        json!(both)
    );
    drop(sub);
    hub.until(WAIT, || {
        (hub.json(&["status", "--json"])["tools"] == expected).then_some(())
    });

    // Reconnects replace the old connection's report; its later close cannot remove the new one.
    let (mut replacement, welcome) = Bridge::connect(
        &hub,
        json!({
            "ext": 1, "session": session, "agent": "main", "key": meta["hello"]["key"]
        }),
    );
    assert_eq!(welcome["role"], "lead");
    assert_eq!(replacement.call("bridge.capabilities", empty), json!({}));
    drop(bridge);
    let expected = json!([{ "session": session, "nonstock": [] }]);
    assert_eq!(hub.json(&["status", "--json"])["tools"], expected);
    drop(replacement);
    hub.until(WAIT, || {
        (hub.json(&["status", "--json"])["tools"] == json!([])).then_some(())
    });
}

/// Milestone 7 check 8: onboarding asks one consent question before reading anything (no tool is
/// recorded before it), a "no" is stored and not asked again (also after a restart), and messenger
/// writes from the lead (tool posts and `cataly` commands in its shell) are refused while it runs.
#[test]
fn onboarding_consent_is_stored_and_writes_wait() {
    let (mut hub, work) = lane_hub("");
    let text = std::fs::read_to_string(hub.config_path()).unwrap();
    hub.write_config(&format!(
        "{text}[lead]\nmodel = \"fake/primary\"\ncwd = \"{}\"\n",
        work.display()
    ));
    start(&mut hub);
    let (mut b, meta) = lead_bridge(&hub);
    assert_eq!(meta["hello"]["role"], "lead");
    assert_eq!(meta["hello"]["shell"], true);
    let s = meta["session"].clone();
    let (state, _) = lead_tool(&mut b, &s, "o1", json!({ "op": "onboarding" }));
    assert!(state.contains("\"phase\":\"new\""), "{state}");
    let (_, err) = lead_tool(&mut b, &s, "o2", json!({ "op": "onboarding.start" }));
    assert!(!err);
    // Nothing is read before the consent answer.
    let early = json!({ "op": "onboarding.tool", "name": "mail", "reply": "allowed", "reads": "subjects", "message": "m1" });
    let (_, err) = lead_tool(&mut b, &s, "o3", early);
    assert!(err, "a tool before consent is refused");
    // Writes wait while onboarding runs.
    let ask = json!({ "op": "question.ask", "text": "Which?", "source": "discord:1:2", "options": ["a", "b"] });
    let (why, err) = lead_tool(&mut b, &s, "o4", ask.clone());
    assert!(err && why.contains("onboarding"), "{why}");
    let (why, err) = lead_tool(&mut b, &s, "o5", json!({ "op": "lane.open", "key": "k" }));
    assert!(err && why.contains("onboarding"), "{why}");
    let (why, _) = lead_tool(&mut b, &s, "o6", json!({ "op": "lane.list" }));
    assert!(!why.contains("onboarding"), "reads stay allowed: {why}");
    let shell = |b: &mut Bridge, command: &str| {
        b.call(
            "bridge.shell",
            json!({ "tool": "bash", "command": command, "session": s }),
        )
    };
    let refused = shell(&mut b, "cataly lead send hello");
    assert_eq!(refused["allow"], false);
    assert!(
        refused["reason"]
            .as_str()
            .unwrap()
            .contains("cataly_lead tool"),
        "{refused}"
    );
    // The lead's own tool named in bash (the owner's line) is refused with a pointer to the direct
    // call, which is the only form OMP offers (DESIGN 12.2 A13).
    let own = shell(
        &mut b,
        "cataly_lead onboarding.start 2>&1; echo ---; cataly_lead requests",
    );
    assert_eq!(own["allow"], false);
    assert!(
        own["reason"]
            .as_str()
            .unwrap()
            .contains("Call cataly_lead directly as a tool call"),
        "{own}"
    );
    assert_eq!(
        shell(&mut b, "/usr/bin/cataly slack upload T1/C1 /tmp/x")["allow"],
        false
    );
    assert_eq!(shell(&mut b, "ls ~/.config")["allow"], true);
    // A "no" is stored and ends onboarding; it is not asked again.
    let no = json!({ "op": "onboarding.consent", "reply": "no", "message": "owner-msg-1" });
    let (_, err) = lead_tool(&mut b, &s, "o7", no);
    assert!(!err);
    let (why, err) = lead_tool(&mut b, &s, "o8", json!({ "op": "onboarding.start" }));
    assert!(err && why.contains("declined"), "{why}");
    let (why, _) = lead_tool(&mut b, &s, "o9", ask);
    assert!(
        !why.contains("onboarding"),
        "writes are allowed again: {why}"
    );
    // Onboarding has ended, but rule 0 still refuses the lead's own mutating `cataly` command
    // (DESIGN 9.2); reads pass.
    assert_eq!(shell(&mut b, "cataly lead send hello")["allow"], false);
    assert_eq!(shell(&mut b, "cataly status")["allow"], true);
    drop(b);
    hub.stop();
    start(&mut hub);
    let (mut b, meta) = lead_bridge(&hub);
    let s = meta["session"].clone();
    let (why, err) = lead_tool(&mut b, &s, "p1", json!({ "op": "onboarding.start" }));
    assert!(
        err && why.contains("declined"),
        "kept across a restart: {why}"
    );
    let (state, _) = lead_tool(&mut b, &s, "p2", json!({ "op": "onboarding" }));
    assert!(state.contains("\"consent\":\"no\""), "{state}");
    let reopen = json!({ "op": "onboarding.start", "reopen": true, "message": "owner-msg-2" });
    let (_, err) = lead_tool(&mut b, &s, "p3", reopen);
    assert!(!err, "the owner may raise it again");
    drop(b);
    hub.stop();
}

/// Whether a file holds `text` (an unreadable file holds nothing).
fn holds(file: &Value, text: &str) -> bool {
    file.as_str()
        .and_then(|f| std::fs::read_to_string(f).ok())
        .is_some_and(|t| t.contains(text))
}

/// Two lanes on one thread: the first completed close leaves the thread open for the other lane
/// (no `[done]`, no archive); the last one marks it done and archives it (LANE req. 42, DESIGN C17).
#[test]
fn a_completed_lane_leaves_a_thread_another_lane_uses_open() {
    let fake = FakeDiscord::start();
    let (mut hub, work) = lane_hub("");
    let token = hub.private_file("token", "fake-token");
    fake.channel(CH, 0, None);
    fake.named_thread(THREAD, CH, "Shared work");
    let config = std::fs::read_to_string(hub.config_path()).unwrap();
    hub.write_config(&format!("{config}{}", fake.config(&token, OWNER, &[CH])));
    start(&mut hub);
    for key in ["shared-a", "shared-b"] {
        open(
            &hub,
            key,
            &json!({ "thread": format!("discord:{THREAD}"), "cwd": work }),
        );
    }
    let ending = |f: &FakeDiscord| {
        f.calls("PATCH", &format!("/channels/{THREAD}"))
            .into_iter()
            .filter(|c| {
                c.body["archived"] == true
                    || c.body["name"]
                        .as_str()
                        .is_some_and(|n| n.starts_with("[done]"))
            })
            .collect::<Vec<_>>()
    };
    // Status words reach the thread.
    fake.wait(WAIT, |f| {
        f.calls("PATCH", &format!("/channels/{THREAD}"))
            .into_iter()
            .find(|c| c.body["name"] == "[working] Shared work")
    });
    lane(&hub, "close", &json!({ "key": "shared-a", "note": "done" })).unwrap();
    let a = record(&hub, "shared-a");
    assert_eq!(
        (a["state"].as_str(), a["outcome"].as_str()),
        (Some("closed"), Some("completed"))
    );
    assert!(
        a["receipt"]
            .to_string()
            .contains("thread left open: 1 other"),
        "{a}"
    );
    assert!(ending(&fake).is_empty(), "{:?}", ending(&fake));
    // The last lane on the thread ends it.
    lane(&hub, "close", &json!({ "key": "shared-b", "note": "done" })).unwrap();
    let done = fake.wait(WAIT, |f| {
        let e = ending(f);
        (!e.is_empty()).then_some(e)
    });
    assert_eq!(
        done[0].body["name"], "[done] Shared work",
        "{:?}",
        done[0].body
    );
    assert_eq!(done[0].body["archived"], true, "{:?}", done[0].body);
    hub.stop();
}

/// The lead delegates: an owner message in a watched channel, the lead's `lane.open` with
/// `thread_from` that message and a worktree, the kickoff first in the thread and the lead's pointer
/// in the channel, the lane's session in its worktree, reports and later owner messages in its
/// thread, and a split opening a separate lane without changing the first lane's scope.
#[test]
#[allow(clippy::too_many_lines)]
fn the_lead_delegates_to_a_lane_in_a_thread_and_a_split_opens_another() {
    let fake = FakeDiscord::start();
    let (mut hub, work) = lane_hub("");
    let repo = work.join("repo");
    let origin = work.join("origin.git");
    std::fs::create_dir_all(&repo).unwrap();
    git(&work, &["init", "-q", "--bare", origin.to_str().unwrap()]);
    git(&repo, &["init", "-q"]);
    std::fs::write(repo.join("a.txt"), "1").unwrap();
    git(&repo, &["add", "a.txt"]);
    git(&repo, &["commit", "-qm", "one"]);
    git(
        &repo,
        &["remote", "add", "origin", origin.to_str().unwrap()],
    );
    git(&repo, &["push", "-q", "origin", "HEAD:refs/heads/main"]);
    let token = hub.private_file("token", "fake-token");
    fake.channel(CH, 0, None);
    let config = std::fs::read_to_string(hub.config_path()).unwrap();
    hub.write_config(&format!(
        "{config}[lead]\nmodel = \"fake/primary\"\ncwd = \"{}\"\n{}",
        work.display(),
        fake.config(&token, OWNER, &[CH])
    ));
    start(&mut hub);
    hub.until(WAIT, || {
        (hub.json(&["discord", "status", "--json"])["healthy"] == true).then_some(())
    });
    let (mut b, meta) = lead_bridge(&hub);
    let s = meta["session"].clone();
    let lead_file = hub.json(&["lead", "status", "--json"])["session"]["session_file"].clone();
    // The owner asks in the channel; the request reaches the lead. Its turn ends only after the
    // lane is open, as a lead's turn that calls `lane.open` does.
    std::fs::write(data(&hub).join("hold"), "fix the login bug").unwrap();
    let asked = 800_000_000_000_000_101u64;
    fake.say(FakeDiscord::message(CH, asked, OWNER, "fix the login bug"));
    hub.until(WAIT, || {
        holds(&lead_file, "fix the login bug").then_some(())
    });
    // The lead opens a lane from that message.
    let wt_a = work.join("wt-a");
    let open_a = json!({
        "op": "lane.open", "key": "login-fix", "title": "Fix login",
        "brief": "Fix the login bug.", "checks": [{ "kind": "command", "argv": ["true"] }],
        "thread_from": format!("discord:{CH}/{asked}"),
        "kickoff": "Fixing the login bug; done when the check true passes.",
        "cwd": repo, "worktree": { "path": wt_a, "branch": "lane-a", "base": "HEAD" },
    });
    let (text, err) = lead_tool(&mut b, &s, "l1", open_a);
    assert!(!err && text.contains("started"), "{text}");
    let thread_a = asked.to_string();
    let made = fake.calls("POST", &format!("/channels/{CH}/messages/{asked}/threads"));
    assert_eq!(made.len(), 1, "one thread under the owner's message");
    assert_eq!(made[0].body["name"], "[working] Fix login");
    let a = record(&hub, "login-fix");
    assert_eq!(a["thread"], format!("discord:{thread_a}"), "{a}");
    let wt_a_real = std::fs::canonicalize(&wt_a).unwrap();
    let header = std::fs::read_to_string(a["session_file"].as_str().unwrap()).unwrap();
    let header: Value = serde_json::from_str(header.lines().next().unwrap()).unwrap();
    assert_eq!(
        header["cwd"],
        wt_a_real.display().to_string(),
        "the lane runs in its worktree"
    );
    let kickoff = fake.bot_messages(&thread_a);
    assert_eq!(
        kickoff[0]["content"], "Fixing the login bug; done when the check true passes.",
        "the kickoff line comes first"
    );
    // The lane owns the thread, so the lead's pointer stays visible in the channel.
    std::fs::write(data(&hub).join("release"), "").unwrap();
    let answer = hub.until(WAIT, || {
        fake.bot_messages(CH)
            .into_iter()
            .find(|m| m["content"] == "ok")
    });
    assert_eq!(answer["message_reference"]["message_id"], asked.to_string());
    assert!(
        fake.bot_messages(&thread_a)
            .iter()
            .all(|m| m["content"] != "ok"),
        "the thread keeps only its kickoff until the lane reports"
    );
    // A lane report reaches the thread.
    let (mut lb, _) = hello(&hub, &a);
    lb.lane_tool(
        "r1",
        &a["session_id"],
        json!({ "op": "report", "kind": "stuck", "text": "the login test needs a fixture" }),
    );
    let posts = hub.until(WAIT, || {
        let p = fake.bot_messages(&thread_a);
        (p.len() >= 2).then_some(p)
    });
    assert_eq!(
        posts[1]["content"],
        "Lane update: the login test needs a fixture"
    );
    // An owner message in the thread reaches the lane, not the lead.
    fake.say(FakeDiscord::message(
        &thread_a,
        800_000_000_000_000_102,
        OWNER,
        "also check logout",
    ));
    hub.until(WAIT, || {
        holds(&a["session_file"], "also check logout").then_some(())
    });
    assert!(!holds(&lead_file, "also check logout"));
    // A split asked for in the thread goes to the lane, which reports it to the lead; the lead
    // opens a second lane with a thread of its own (Discord nests no threads, so it sits beside
    // the first in the channel).
    let split = 800_000_000_000_000_103u64;
    fake.say(FakeDiscord::message(
        &thread_a,
        split,
        OWNER,
        "do the session check in a new thread",
    ));
    hub.until(WAIT, || {
        holds(&a["session_file"], "do the session check in a new thread").then_some(())
    });
    assert!(!holds(&lead_file, "do the session check"));
    lb.lane_tool(
        "r2",
        &a["session_id"],
        json!({ "op": "report", "kind": "waiting",
            "text": format!("split asked: session check, from discord:{thread_a}/{split}") }),
    );
    let wt_b = work.join("wt-b");
    let open_b = json!({
        "op": "lane.open", "key": "session-check", "title": "Check sessions",
        "brief": "Check sessions.", "checks": [{ "kind": "command", "argv": ["true"] }],
        "thread_from": format!("discord:{thread_a}/{split}"),
        "kickoff": "Checking sessions; done when the check true passes.",
        "cwd": repo, "worktree": { "path": wt_b, "branch": "lane-b", "base": "HEAD" },
    });
    let (text, err) = lead_tool(&mut b, &s, "l2", open_b);
    assert!(!err && text.contains("started"), "{text}");
    let bb = record(&hub, "session-check");
    let thread_b = bb["thread"]
        .as_str()
        .unwrap()
        .strip_prefix("discord:")
        .unwrap()
        .to_string();
    assert_ne!(thread_b, thread_a);
    let beside = fake.calls("POST", &format!("/channels/{CH}/threads"));
    assert_eq!(beside.len(), 1);
    assert_eq!(beside[0].body["name"], "[working] Check sessions");
    assert_eq!(
        fake.bot_messages(&thread_b)[0]["content"],
        "Checking sessions; done when the check true passes."
    );
    // The first lane keeps its scope.
    let a_now = record(&hub, "login-fix");
    for field in ["thread", "title", "session_id", "session_file", "state"] {
        assert_eq!(a_now[field], a[field], "{field}");
    }
    fake.say(FakeDiscord::message(
        &thread_b,
        800_000_000_000_002_001,
        OWNER,
        "look at token expiry first",
    ));
    hub.until(WAIT, || {
        holds(&bb["session_file"], "look at token expiry first").then_some(())
    });
    assert!(!holds(&a["session_file"], "look at token expiry first"));
    assert!(!holds(&lead_file, "look at token expiry first"));
    // The lead closes the first lane: its thread is marked done and archived.
    let mut n = 0;
    hub.until(WAIT, || {
        n += 1;
        let close = json!({ "op": "lane.close", "key": "login-fix", "note": "fixed" });
        let (text, err) = lead_tool(&mut b, &s, &format!("c{n}"), close);
        (!err).then_some(text)
    });
    let done = fake.wait(WAIT, |f| {
        f.calls("PATCH", &format!("/channels/{thread_a}"))
            .into_iter()
            .find(|c| c.body["name"] == "[done] Fix login")
    });
    assert_eq!(done.body["archived"], true, "{:?}", done.body);
    assert!(
        fake.calls("PATCH", &format!("/channels/{thread_b}"))
            .iter()
            .all(|c| c.body.get("archived").is_none()),
        "the second lane's thread stays open"
    );
    drop((b, lb));
    hub.stop();
}

/// The lead's answer can be ready while `lane.open` is still making the thread from the request:
/// the thread exists, the lane's record does not yet (on a worker it waits for a push). The
/// answer stays in the channel and the kickoff comes first in the thread.
#[test]
fn an_answer_while_its_lane_thread_is_made_stays_in_the_channel() {
    let fake = FakeDiscord::start();
    let (mut hub, work) = lane_hub("");
    let token = hub.private_file("token", "fake-token");
    fake.channel(CH, 0, None);
    let config = std::fs::read_to_string(hub.config_path()).unwrap();
    hub.write_config(&format!(
        "{config}[lead]\nmodel = \"fake/primary\"\ncwd = \"{}\"\n{}",
        work.display(),
        fake.config(&token, OWNER, &[CH])
    ));
    start(&mut hub);
    hub.until(WAIT, || {
        (hub.json(&["discord", "status", "--json"])["healthy"] == true).then_some(())
    });
    let (mut b, meta) = lead_bridge(&hub);
    let lead_file = hub.json(&["lead", "status", "--json"])["session"]["session_file"].clone();
    std::fs::write(data(&hub).join("hold"), "start the work").unwrap();
    let asked = 800_000_000_000_000_101u64;
    fake.say(FakeDiscord::message(CH, asked, OWNER, "start the work"));
    hub.until(WAIT, || holds(&lead_file, "start the work").then_some(()));
    // Discord makes the thread, but the open has no answer yet.
    fake.hold_thread_starts(true);
    let open = json!({
        "op": "lane.open", "key": "work-1", "title": "Work", "brief": "Do the work.",
        "checks": [{ "kind": "command", "argv": ["true"] }],
        "thread_from": format!("discord:{CH}/{asked}"),
        "kickoff": "Working; done when the check true passes.",
        "cwd": work,
    });
    let session = meta["session"].clone();
    let opening = std::thread::spawn(move || lead_tool(&mut b, &session, "l1", open));
    let made = format!("/channels/{CH}/messages/{asked}/threads");
    fake.wait(WAIT, |f| (!f.calls("POST", &made).is_empty()).then_some(()));
    // Meanwhile the lead's turn ends with its answer.
    std::fs::write(data(&hub).join("release"), "").unwrap();
    let thread = asked.to_string();
    let answer = fake.wait(WAIT, |f| {
        let mut posted = f.bot_messages(CH);
        posted.extend(f.bot_messages(&thread));
        posted.into_iter().find(|m| m["content"] == "ok")
    });
    fake.hold_thread_starts(false);
    let (text, err) = opening.join().unwrap();
    assert!(!err && text.contains("started"), "{text}");
    assert_eq!(
        answer["channel_id"], CH,
        "the lead's pointer stays in the channel"
    );
    assert_eq!(answer["message_reference"]["message_id"], thread);
    let first = fake.wait(WAIT, |f| f.bot_messages(&thread).first().cloned());
    assert_eq!(
        first["content"], "Working; done when the check true passes.",
        "the kickoff comes first in the lane's thread"
    );
    hub.stop();
}

/// A lane the owner opened while the lead sleeps: its start and a progress report are quiet and
/// leave the lead asleep; a stuck report wakes it on the same session, and both reports reach that
/// session (the quiet one with the first turn after the wake).
#[test]
fn a_lane_report_wakes_the_sleeping_lead_on_its_session() {
    let (mut hub, work) = lane_hub("");
    let text = std::fs::read_to_string(hub.config_path()).unwrap();
    hub.write_config(&format!(
        "{text}[lead]\nmodel = \"fake/primary\"\ncwd = \"{}\"\n",
        work.display()
    ));
    hub.env
        .push(("CATALY_IDLE_SLEEP".into(), PathBuf::from("2s")));
    start(&mut hub);
    let lead = |hub: &TestHub| hub.json(&["lead", "status", "--json"]);
    let slept = hub.until(WAIT, || {
        let v = lead(&hub);
        (v["phase"] == "asleep").then_some(v)
    });
    let session = slept["asleep"]["session_id"].clone();
    assert!(session.is_string(), "{slept}");

    open(&hub, "w-1", &json!({}));
    let rec = record(&hub, "w-1");
    let (mut b, _) = hello(&hub, &rec);
    let quiet = b.lane_tool(
        "r1",
        &rec["session_id"],
        json!({ "op": "report", "kind": "progress", "text": "progress-mark-7" }),
    );
    assert_ne!(quiet["error"], true, "{quiet}");
    std::thread::sleep(Duration::from_secs(2));
    assert_eq!(lead(&hub)["phase"], "asleep", "a quiet report waits");

    let urgent = b.lane_tool(
        "r2",
        &rec["session_id"],
        json!({ "op": "report", "kind": "stuck", "text": "stuck-mark-9" }),
    );
    assert_ne!(urgent["error"], true, "{urgent}");
    let woke = hub.until(WAIT, || {
        let v = lead(&hub);
        (v["phase"] == "live").then_some(v)
    });
    assert_eq!(woke["session"]["session_id"], session, "{woke}");
    let file = PathBuf::from(woke["session"]["session_file"].as_str().unwrap());
    hub.until(WAIT, || {
        let text = std::fs::read_to_string(&file).unwrap_or_default();
        (text.contains("stuck-mark-9") && text.contains("progress-mark-7")).then_some(())
    });
    drop(b);
    hub.stop();
}

/// Withhold ready only on resume; probes and fresh launches remain real fake-OMP exchanges.
fn stall_resumes(hub: &TestHub) {
    let bin = hub.root.join("bin");
    std::fs::rename(bin.join("omp"), bin.join("omp-real")).unwrap();
    std::fs::write(
        bin.join("omp"),
        "#!/bin/sh\nfor arg do\n case \"$arg\" in --resume=*) printf 'attempt\\n' >> \"$(dirname \"$0\")/omp-data/resume-started\"; cat >/dev/null; exit 1;; esac\ndone\nexec \"$(dirname \"$0\")/omp-real\" \"$@\"\n",
    )
    .unwrap();
    std::fs::set_permissions(bin.join("omp"), std::fs::Permissions::from_mode(0o700)).unwrap();
}

fn pushed_repo(work: &Path) -> PathBuf {
    let repo = work.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    std::fs::write(repo.join("a.txt"), "original").unwrap();
    std::fs::write(repo.join(".gitignore"), "ignored.txt\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "base"]);
    let origin = work.join("origin.git");
    git(work, &["init", "-q", "--bare", origin.to_str().unwrap()]);
    git(
        &repo,
        &["remote", "add", "origin", origin.to_str().unwrap()],
    );
    git(&repo, &["push", "-q", "origin", "HEAD:main"]);
    repo
}

fn resume_preserves_work(kind: &str, reopen: bool) {
    let (mut hub, work) = lane_hub("");
    let repo = pushed_repo(&work);
    let tree = work.join("lane-tree");
    start(&mut hub);
    open(
        &hub,
        "preserve",
        &json!({
            "cwd": repo, "worktree": {"path": tree, "branch": "lane-work", "base": "HEAD"}
        }),
    );
    let before = record(&hub, "preserve");
    let files: &[(&str, &str)] = match kind {
        "dirty" => &[("a.txt", "tracked work"), ("new.txt", "untracked work")],
        "commit" => &[("a.txt", "unpushed work")],
        "ignored" => &[("ignored.txt", "unique ignored work")],
        _ => panic!("unknown case"),
    };
    for (file, text) in files {
        std::fs::write(tree.join(file), text).unwrap();
    }
    if kind == "commit" {
        git(&tree, &["add", "a.txt"]);
        git(&tree, &["commit", "-qm", "unpublished"]);
    }
    if reopen {
        lane(
            &hub,
            "park",
            &json!({"key":"preserve", "reason":"wait", "condition":"owner"}),
        )
        .unwrap();
        stall_resumes(&hub);
        assert_recovering_reopen(&hub, "preserve");
    } else {
        hub.stop();
        stall_resumes(&hub);
        start(&mut hub);
        hub.until(Duration::from_secs(400), || {
            hub.events()
                .iter()
                .any(|e| e["kind"] == "lane.recap")
                .then_some(())
        });
    }
    let after = record(&hub, "preserve");
    assert_eq!(after["state"], "held", "{after}");
    assert!(
        after["lost"].as_str().unwrap().contains("Timeout"),
        "{after}"
    );
    assert_eq!(after["worktrees"], json!([tree]));
    for field in [
        "session_id",
        "session_file",
        "cwd",
        "worktrees",
        "thread",
        "run_id",
    ] {
        assert_eq!(after[field], before[field], "{field}: {after}");
    }
    assert_eq!(after["live"], false);
    for (file, text) in files {
        assert_eq!(std::fs::read_to_string(tree.join(file)).unwrap(), *text);
    }
    assert_eq!(
        goal(&hub, &before["session_id"]),
        if reopen { "paused" } else { "active" }
    );
    hub.stop();
}

fn assert_recovering_reopen(hub: &TestHub, key: &str) {
    let asked = Instant::now();
    let response = lane(hub, "reopen", &json!({"key":key})).unwrap();
    assert!(
        response.as_str().unwrap().starts_with("recovering:"),
        "{response}"
    );
    assert!(
        asked.elapsed() < Duration::from_secs(120),
        "the response must not wait for the whole episode"
    );
    hub.until(WAIT, || {
        (std::fs::read_to_string(data(hub).join("resume-started"))
            .unwrap()
            .lines()
            .count()
            == 2)
            .then_some(())
    });
    hub.until(Duration::from_secs(400), || {
        record(hub, key)["status"]
            .as_str()
            .is_some_and(|status| status.contains("start failed; work retained"))
            .then_some(())
    });
}

#[test]
fn resume_timeout_keeps_dirty_worktree() {
    resume_preserves_work("dirty", false);
}

#[test]
fn resume_timeout_keeps_unpushed_worktree() {
    resume_preserves_work("commit", false);
}

#[test]
fn resume_timeout_keeps_ignored_worktree() {
    resume_preserves_work("ignored", false);
}

#[test]
fn reopen_timeout_keeps_identity_and_worktree() {
    resume_preserves_work("ignored", true);
}

#[test]
fn completed_close_preserves_ignored_files() {
    let (mut hub, work) = lane_hub("");
    let repo = pushed_repo(&work);
    let tree = work.join("lane-tree");
    start(&mut hub);
    open(
        &hub,
        "ignored-close",
        &json!({
            "cwd": repo, "worktree": {"path": tree, "branch": "lane-work", "base": "HEAD"}
        }),
    );
    std::fs::write(tree.join("ignored.txt"), "irreplaceable").unwrap();
    lane(
        &hub,
        "close",
        &json!({"key":"ignored-close", "note":"done"}),
    )
    .unwrap();
    let rec = record(&hub, "ignored-close");
    assert_eq!(rec["state"], "closed");
    assert_eq!(
        std::fs::read_to_string(tree.join("ignored.txt")).unwrap(),
        "irreplaceable"
    );
    assert!(rec["receipt"].to_string().contains("kept"), "{rec}");
    hub.stop();
}

#[test]
fn completed_close_removes_clean_worktree() {
    let (mut hub, work) = lane_hub("");
    let repo = pushed_repo(&work);
    let tree = work.join("lane-tree");
    start(&mut hub);
    open(
        &hub,
        "clean-close",
        &json!({
            "cwd": repo, "worktree": {"path": tree, "branch": "lane-work", "base": "HEAD"}
        }),
    );
    lane(&hub, "close", &json!({"key":"clean-close", "note":"done"})).unwrap();
    assert!(!tree.exists());
    let rec = record(&hub, "clean-close");
    assert_eq!(rec["state"], "closed");
    assert!(rec["receipt"].to_string().contains("removed"), "{rec}");
    hub.stop();
}

fn close_published_symlink_worktree(legacy: bool, missing_link: bool) {
    let (mut hub, work) = lane_hub("");
    let repo = pushed_repo(&work);
    let link = hub.root.join("work-link");
    std::os::unix::fs::symlink(&work, &link).unwrap();
    let given = link.join("lane-tree");
    let config = std::fs::read_to_string(hub.config_path()).unwrap();
    hub.write_config(&format!(
        "{config}\n[[coord.publish]]\ndir = \"{}\"\n",
        work.canonicalize().unwrap().display()
    ));
    start(&mut hub);
    // Close runs signals after the unsent-work check but before the preservation boundary.
    let argv = if missing_link {
        json!(["rm", link])
    } else {
        json!(["true"])
    };
    open(
        &hub,
        "published-close",
        &json!({
            "cwd": repo, "worktree": {"path": given, "branch": "lane-work", "base": "HEAD"},
            "checks": [{"kind":"command", "argv":argv}]
        }),
    );
    let real = given.canonicalize().unwrap();
    let before = record(&hub, "published-close");
    let published = lane(
        &hub,
        "publish",
        &json!({"key":"published-close", "path":real.join("a.txt")}),
    )
    .unwrap();
    assert_eq!(published["path"], json!(real.join("a.txt")));
    if legacy {
        // Simulate ownership persisted by an older hub, without changing the canonical file path.
        hub.stop();
        assert_eq!(
            recovery::db(&hub).execute(
                "UPDATE lanes SET record = json_set(record, '$.worktrees', json_array(?1)) WHERE key = 'published-close'",
                [given.to_str().unwrap()],
            ).unwrap(),
            1
        );
        start(&mut hub);
        hub.until(WAIT, || {
            (record(&hub, "published-close")["live"] == true).then_some(())
        });
    }
    lane(
        &hub,
        "close",
        &json!({"key":"published-close", "note":"done"}),
    )
    .unwrap();
    if missing_link {
        assert!(!link.exists(), "the close signal removed the symlink");
    }
    let rec = record(&hub, "published-close");
    assert_eq!(rec["state"], "closed", "{rec}");
    assert!(real.is_dir(), "the published worktree was removed: {rec}");
    assert!(
        rec["receipt"]
            .to_string()
            .contains("kept: it holds a published file"),
        "{rec}"
    );
    assert_eq!(
        std::fs::read_to_string(real.join("a.txt")).unwrap(),
        "original"
    );
    if !legacy {
        assert_eq!(before["worktrees"], json!([real]));
    }
    hub.stop();
}

#[test]
fn completed_close_keeps_published_symlink_worktree() {
    close_published_symlink_worktree(false, false);
}

#[test]
fn completed_close_keeps_published_legacy_symlink_worktree() {
    close_published_symlink_worktree(true, false);
}

#[test]
fn completed_close_keeps_published_worktree_when_symlink_is_missing() {
    close_published_symlink_worktree(true, true);
}

/// A pre-spawn failure proves no writer existed. Git locking is an actual removal refusal.
#[test]
fn failed_fresh_worktree_removal_keeps_record() {
    let (mut hub, work) = lane_hub("");
    let repo = pushed_repo(&work);
    let tree = work.join("lane-tree");
    let git_bin = Command::new("which").arg("git").output().unwrap();
    let git_bin = String::from_utf8(git_bin.stdout).unwrap();
    let wrapper = hub.root.join("bin/git");
    std::fs::write(&wrapper, format!(
        "#!/bin/sh\n\"{}\" \"$@\" || exit $?\nif [ \"$1 $2\" = 'worktree add' ]; then \"{}\" worktree lock '{}'; fi\n",
        git_bin.trim(), git_bin.trim(), tree.display()
    )).unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700)).unwrap();
    let path = std::env::join_paths(
        std::iter::once(hub.root.join("bin"))
            .chain(std::env::split_paths(&support::path_without_omp())),
    )
    .unwrap();
    hub.env.push(("PATH".into(), PathBuf::from(path)));
    start(&mut hub);
    std::fs::create_dir_all(hub.state().join("sessions/lanes")).unwrap();
    std::fs::write(
        hub.state().join("sessions/lanes/refused"),
        "not a directory",
    )
    .unwrap();
    let result = lane(
        &hub,
        "open",
        &json!({
            "key":"refused", "title":"Refused allocation", "brief":"Work.",
            "checks":[{"kind":"command","argv":["true"]}], "cwd":repo,
            "worktree":{"path":tree,"branch":"refused","base":"HEAD"}
        }),
    );
    assert!(result.is_err());
    let rec = record(&hub, "refused");
    assert_eq!(rec["state"], "held", "{rec}");
    assert!(
        rec["receipt"]
            .to_string()
            .contains("git worktree remove refused"),
        "{rec}"
    );
    assert!(tree.is_dir());
    hub.stop();
}

#[test]
fn queued_fresh_failure_removes_only_its_unused_worktree() {
    let (mut hub, work) = lane_hub("");
    let repo = pushed_repo(&work);
    let owned = work.join("owned");
    let fresh = work.join("fresh");
    start(&mut hub);
    open(
        &hub,
        "existing",
        &json!({"cwd":repo,
        "worktree":{"path":owned,"branch":"owned","base":"HEAD"}}),
    );
    let before = record(&hub, "existing");
    std::fs::write(owned.join("ignored.txt"), "another run's work").unwrap();
    open(&hub, "predecessor", &json!({}));
    open(
        &hub,
        "queued-fail",
        &json!({"cwd":repo, "after":["predecessor"],
        "worktree":{"path":fresh,"branch":"fresh","base":"HEAD"}}),
    );
    std::fs::write(
        hub.state().join("sessions/lanes/queued-fail"),
        "not a directory",
    )
    .unwrap();
    lane(&hub, "close", &json!({"key":"predecessor","note":"done"})).unwrap();
    assert!(lane(&hub, "start", &json!({"key":"queued-fail"})).is_err());
    let queued = lane(&hub, "queued", &json!({})).unwrap();
    assert!(queued.to_string().contains("failed"), "{queued}");
    assert!(
        !fresh.exists(),
        "only the newly allocated unused worktree is removed"
    );
    assert_eq!(record(&hub, "existing")["run_id"], before["run_id"]);
    assert_eq!(
        std::fs::read_to_string(owned.join("ignored.txt")).unwrap(),
        "another run's work"
    );
    hub.stop();
}

#[test]
fn parking_cancels_an_existing_session_start_without_losing_work() {
    let (mut hub, work) = lane_hub("");
    let repo = pushed_repo(&work);
    let tree = work.join("lane-tree");
    start(&mut hub);
    open(
        &hub,
        "cancel-resume",
        &json!({
            "cwd":repo, "worktree":{"path":tree,"branch":"cancel-resume","base":"HEAD"}
        }),
    );
    std::fs::write(tree.join("ignored.txt"), "retained on cancellation").unwrap();
    let before = record(&hub, "cancel-resume");
    hub.stop();
    stall_resumes(&hub);
    start(&mut hub);
    hub.until(WAIT, || {
        data(&hub).join("resume-started").exists().then_some(())
    });
    let parked = lane(
        &hub,
        "park",
        &json!({
            "key":"cancel-resume", "reason":"owner stopped recovery", "condition":"explicit retry"
        }),
    )
    .unwrap();
    assert_eq!(parked, "closed parked");
    let after = record(&hub, "cancel-resume");
    assert_eq!(after["session_id"], before["session_id"]);
    assert_eq!(after["run_id"], before["run_id"]);
    assert_eq!(after["live"], false);
    assert_eq!(
        std::fs::read_to_string(tree.join("ignored.txt")).unwrap(),
        "retained on cancellation"
    );
    hub.stop();
}

#[test]
fn lane_status_selects_the_positional_key() {
    let (mut hub, _) = lane_hub("");
    start(&mut hub);
    open(&hub, "cli-one", &json!({}));
    open(&hub, "cli-two", &json!({}));
    let status = hub.cli(&["lane", "status", "cli-one"]);
    assert!(status.status.success(), "{status:?}");
    let text = String::from_utf8(status.stdout).unwrap();
    assert!(text.contains("cli-one"), "{text}");
    assert!(!text.contains("cli-two"), "{text}");
    let json_status = hub.json(&["lane", "status", "cli-two", "--json"]);
    let text = json_status.as_str().unwrap();
    assert!(
        text.contains("cli-two") && !text.contains("cli-one"),
        "{text}"
    );
    hub.stop();
}
