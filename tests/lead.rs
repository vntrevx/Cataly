//! The lead through the real hub with the fake OMP in its rpc-ui mode (`tests/support/fake-omp`).

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use std::process::Command;
use std::time::{Duration, Instant};

use serde_json::Value;
use support::TestHub;

fn kill(pid: &Value) {
    let status = Command::new("kill")
        .args(["-KILL", &pid.to_string()])
        .status()
        .unwrap();
    assert!(status.success());
}

/// Waits until the lead is live on a running process other than `not`.
fn live(hub: &TestHub, not: &Value) -> Value {
    hub.until(Duration::from_secs(20), || {
        let v = hub.json(&["lead", "status", "--json"]);
        let pid = &v["session"]["pid"];
        (v["phase"] == "live" && pid.is_u64() && pid != not).then_some(v)
    })
}

/// DESIGN 2.2 supervision for the lead: when its OMP exits by itself the hub resumes the same session
/// after 1 s, then 2 s; the owner is alerted at the first exit only and the lead gets one resume
/// note; `lead stop` cancels a planned restart.
#[test]
fn lead_restarts_on_its_session_after_omp_exits() {
    let mut hub = TestHub::new("");
    let omp = hub.install_fake("omp");
    hub.fixture("omp", "rpc", Some(""));
    let work = hub.root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    hub.write_config(&format!(
        "[omp]\npath = \"{}\"\n[lead]\nmodel = \"fake/primary\"\ncwd = \"{}\"\n",
        omp.display(),
        work.display()
    ));
    hub.start();
    let first = live(&hub, &Value::Null);
    let session = first["session"]["session_id"].clone();
    let file = first["session"]["session_file"].clone();
    assert!(session.is_string(), "{first}");

    kill(&first["session"]["pid"]);
    let exited = Instant::now();
    let second = live(&hub, &first["session"]["pid"]);
    assert!(
        exited.elapsed() >= Duration::from_secs(1),
        "the first retry waits 1 s"
    );
    assert_eq!(second["session"]["session_id"], session, "{second}");
    assert_eq!(second["session"]["session_file"], file);

    kill(&second["session"]["pid"]);
    let exited = Instant::now();
    let third = live(&hub, &second["session"]["pid"]);
    assert!(
        exited.elapsed() >= Duration::from_secs(2),
        "the second retry waits 2 s"
    );
    assert_eq!(third["session"]["session_id"], session, "{third}");

    // Events are recorded after the phase they report turns live: wait for the third start's record.
    let resumed = |events: &[Value]| {
        events
            .iter()
            .filter(|e| {
                e["kind"] == "lead.started" && e["text"].as_str().unwrap().contains("resumed")
            })
            .count()
    };
    let events = hub.until(Duration::from_secs(10), || {
        let events = hub.events();
        (resumed(&events) == 2).then_some(events)
    });
    let stopped: Vec<&Value> = events
        .iter()
        .filter(|e| e["kind"] == "session.stopped")
        .collect();
    assert_eq!(stopped.len(), 2, "{events:?}");
    assert_eq!(
        (stopped[0]["urgent"].clone(), stopped[1]["urgent"].clone()),
        (Value::Bool(true), Value::Bool(false)),
        "the owner is alerted once per series"
    );
    assert!(
        stopped[0]["text"]
            .as_str()
            .unwrap()
            .contains("restarting in 1 s")
    );
    assert!(
        stopped[1]["text"]
            .as_str()
            .unwrap()
            .contains("restarting in 2 s")
    );
    let inbox = hub.json(&["lead", "inbox", "--json"]);
    let notes: Vec<&Value> = inbox
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["preview"].as_str().unwrap().contains("resume note"))
        .collect();
    assert_eq!(notes.len(), 1, "the lead is told once: {inbox}");

    // A third exit plans a restart in 4 s; `lead stop` cancels it.
    kill(&third["session"]["pid"]);
    hub.until(Duration::from_secs(10), || {
        let v = hub.json(&["lead", "status", "--json"]);
        v["reason"]
            .as_str()
            .is_some_and(|r| r.contains("restarting in 4 s"))
            .then_some(())
    });
    let stopped = hub.json(&["lead", "stop", "--json"]);
    assert_eq!(stopped["reason"], "the automatic restart was cancelled");
    assert!(hub.stop().success());
    let pids = std::fs::read_to_string(hub.root.join("bin/omp-data/pids")).unwrap();
    // The probe, then three lead processes; nothing started after the cancel.
    assert_eq!(pids.lines().count(), 4, "{pids}");
}

/// From PR #299 (Momentum96): a resume that never gets ready (`slow-resume` reads input until it
/// closes) fails at the 60 s startup deadline; after proven cleanup it is retried on the same
/// transcript and the waiting message is delivered once.
#[test]
fn hub_restart_recovers_from_a_lead_ready_timeout_on_the_same_transcript() {
    let mut hub = TestHub::new("");
    let omp = hub.install_fake("omp");
    hub.fixture("omp", "rpc", Some(""));
    hub.fixture("omp", "turns", Some(""));
    let work = hub.root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    hub.write_config(&format!(
        "[omp]\npath = \"{}\"\n[lead]\nmodel = \"fake/primary\"\ncwd = \"{}\"\n",
        omp.display(),
        work.display()
    ));
    hub.start();
    let first = live(&hub, &Value::Null);
    assert!(hub.stop().success());
    hub.fixture("omp", "slow-resume", Some(""));
    hub.start();
    assert!(hub.cli(&["lead", "send", "after-restart"]).status.success());
    let resumed = hub.until(Duration::from_secs(120), || {
        let v = lead_view(&hub);
        (v["phase"] == "live" && v["session"]["pid"].is_u64()).then_some(v)
    });
    assert_eq!(
        resumed["session"]["session_id"],
        first["session"]["session_id"]
    );
    let file = resumed["session"]["session_file"].as_str().unwrap();
    assert_eq!(file, first["session"]["session_file"].as_str().unwrap());
    let pids = std::fs::read_to_string(hub.root.join("bin/omp-data/resume-pids")).unwrap();
    assert_eq!(pids.lines().count(), 2, "one failed start and one retry");
    let failed: Value = pids.lines().next().unwrap().parse::<u64>().unwrap().into();
    assert!(!running(&failed), "failed OMP {failed} is still running");
    hub.until(Duration::from_secs(5), || {
        (user_entries(&Value::from(file), "after-restart") == 1).then_some(())
    });
    assert!(hub.stop().success());
    assert_eq!(user_entries(&Value::from(file), "after-restart"), 1);
}

/// Just after an OMP update the first probe can outlast its bound under load. A failed probe is
/// tried again by itself after 5 s, with no change to the executable; status, health and the
/// sessions refusal name the retry, and the lead starts as soon as a probe works.
#[test]
fn a_failed_probe_is_retried_and_the_lead_starts() {
    let mut hub = TestHub::new("");
    let omp = hub.install_fake("omp");
    hub.fixture("omp", "rpc", Some(""));
    hub.fixture("omp", "slow-start", Some(""));
    let work = hub.root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    hub.write_config(&format!(
        "[omp]\npath = \"{}\"\n[lead]\nmodel = \"fake/primary\"\ncwd = \"{}\"\n",
        omp.display(),
        work.display()
    ));
    hub.start();
    let status = hub.until(Duration::from_secs(40), || {
        let s = hub.json(&["status", "--json"]);
        s["omp"]["retry"].is_object().then_some(s)
    });
    let report = &status["omp"];
    assert!(report["error"].is_string(), "{status}");
    assert_eq!(report["retry"]["attempt"], 2, "{status}");
    assert_eq!(report["retry"]["after_s"], 5, "{status}");
    let refused = status["sessions_refused"].as_str().unwrap();
    assert!(
        refused.starts_with("OMP probe failed: ")
            && refused.ends_with("; probing again in 5 s (attempt 2)"),
        "{refused}"
    );
    let health = String::from_utf8(hub.cli(&["health"]).stdout).unwrap();
    assert!(
        health
            .lines()
            .any(|l| l.contains("omp") && l.contains("probing again")),
        "{health}"
    );

    let lead = live(&hub, &Value::Null);
    assert!(lead["session"]["session_id"].is_string(), "{lead}");
    let status = hub.json(&["status", "--json"]);
    assert!(
        status["omp"]["error"].is_null() && status["omp"]["retry"].is_null(),
        "{status}"
    );
    assert!(hub.root.join("bin/omp-data/slow-start.used").exists());
    assert!(hub.stop().success());
}

/// Decision 15 writes early only what the caller knows was not written before (a relay message
/// read live, or one its transcript lacks). A `lead send` with a request ID commits first: the
/// crash point after an early write never fires, and a retry with the same ID after a crash finds
/// its receipt, so the lead gets the message once.
#[test]
fn request_id_sends_commit_before_the_write() {
    let mut hub = TestHub::new("");
    let omp = hub.install_fake("omp");
    hub.fixture("omp", "rpc", Some(""));
    hub.fixture("omp", "turns", Some(""));
    let work = hub.root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    hub.write_config(&format!(
        "[omp]\npath = \"{}\"\n[lead]\nmodel = \"fake/primary\"\ncwd = \"{}\"\n",
        omp.display(),
        work.display()
    ));
    hub.env.push((
        "CATALY_FAULT".into(),
        std::path::PathBuf::from("wake_after_write"),
    ));
    hub.start();
    let lead = live(&hub, &Value::Null);
    let file = std::path::PathBuf::from(lead["session"]["session_file"].as_str().unwrap());
    let send = |hub: &TestHub| {
        hub.json(&[
            "lead",
            "send",
            "hello once",
            "--request-id",
            "cli-1",
            "--json",
        ])
    };
    let first = send(&hub);
    assert!(first["inbox_id"].is_i64(), "{first}");
    assert!(
        hub.cli(&["status"]).status.success(),
        "the hub is still up: the write came after the commit"
    );
    hub.crash();
    hub.env.clear();
    hub.start();
    live(&hub, &lead["session"]["pid"]);
    let again = send(&hub);
    assert_eq!(again["inbox_id"], first["inbox_id"], "{again}");
    std::thread::sleep(Duration::from_secs(1));
    let entries = std::fs::read_to_string(&file)
        .unwrap()
        .matches("hello once")
        .count();
    assert_eq!(entries, 1, "written once");
    assert!(hub.stop().success());
}

/// The hub works from the real location of its state directory. On macOS `/tmp` and `/var/folders`
/// sit behind a symlink into `/private`; a transcript path recorded through that symlink differs
/// from its real location, the exact-resume check refused it, and the lead started a fresh session
/// after every hub restart. Here the state directory is reached through a symlink on any system.
#[test]
fn lead_resumes_through_a_symlinked_state_directory() {
    let mut hub = TestHub::new("");
    let omp = hub.install_fake("omp");
    hub.fixture("omp", "rpc", Some(""));
    let work = hub.root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    hub.write_config(&format!(
        "[omp]\npath = \"{}\"\n[lead]\nmodel = \"fake/primary\"\ncwd = \"{}\"\n",
        omp.display(),
        work.display()
    ));
    let link = hub.root.join("state-link");
    std::os::unix::fs::symlink(hub.root.join("state"), &link).unwrap();
    hub.env.push(("XDG_STATE_HOME".into(), link));
    hub.start();
    let first = live(&hub, &Value::Null);
    hub.crash();
    hub.start();
    let second = live(&hub, &first["session"]["pid"]);
    assert_eq!(
        second["session"]["session_id"], first["session"]["session_id"],
        "{second}"
    );
    assert_eq!(
        second["session"]["session_file"],
        first["session"]["session_file"]
    );
    assert!(hub.stop().success());
}

/// DESIGN 8: a process inside the lead's session (a child of its OMP) has the lead's role on the
/// control socket, even without its launch token, and is refused every owner-only method; it reads
/// status, and finds the hub through `CATALY_SOCKET` alone. A plain shell is the owner. A caller
/// that carries a launch token but descends from no session fails closed.
#[test]
fn a_session_child_is_refused_owner_methods_and_a_plain_shell_is_the_owner() {
    let mut hub = TestHub::new("");
    let omp = hub.install_fake("omp");
    hub.fixture("omp", "rpc", Some(""));
    let bin = support::BIN;
    hub.fixture(
        "omp",
        "child",
        Some(&format!(
            "{bin} config reload; echo \"reload=$?\"\n\
             {bin} job enable x --ack; echo \"enable=$?\"\n\
             {bin} setup --yes --backup off; echo \"setup=$?\"\n\
             {bin} status --json > /dev/null; echo \"status=$?\"\n\
             env -u CATALY_LAUNCH {bin} voice restart; echo \"untokened=$?\"\n\
             echo done\n"
        )),
    );
    let work = hub.root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    hub.write_config(&format!(
        "[omp]\npath = \"{}\"\n[lead]\nmodel = \"fake/primary\"\ncwd = \"{}\"\n",
        omp.display(),
        work.display()
    ));
    hub.start();
    live(&hub, &Value::Null);
    let out = hub.root.join("bin/omp-data/child.out");
    let text = hub.until(Duration::from_secs(20), || {
        std::fs::read_to_string(&out)
            .ok()
            .filter(|t| t.contains("done"))
    });
    for refused in ["reload=1", "enable=1", "setup=1", "untokened=1"] {
        assert!(text.contains(refused), "{refused}: {text}");
    }
    assert!(text.contains("status=0"), "{text}");
    assert!(text.contains("owner's alone"), "{text}");
    assert!(text.contains("only the owner may run this"), "{text}");

    // The test process is a plain shell of the owner.
    let reloaded = hub.cli(&["config", "reload"]);
    assert!(
        reloaded.status.success(),
        "{}",
        String::from_utf8_lossy(&reloaded.stderr)
    );
    let me = hub.request(r#"{"v":1,"id":1,"method":"whoami"}"#);
    assert_eq!(me["ok"]["role"], "owner", "{me}");
    // A launch token outside every session: reads only.
    let tokened = hub.request(r#"{"v":1,"id":2,"method":"config.reload","launch":"t"}"#);
    assert!(
        tokened["err"]["message"]
            .as_str()
            .unwrap()
            .contains("unplaced"),
        "{tokened}"
    );
    let read = hub.request(r#"{"v":1,"id":3,"method":"status","launch":"t"}"#);
    assert!(read["ok"].is_object(), "{read}");
    assert!(hub.stop().success());
}

/// A lead hub on the fake OMP running turns, with fixtures `extra` and the idle sleep shortened to
/// `sleep` (`CATALY_IDLE_SLEEP`, debug builds only); `lead` adds `[lead]` lines, `config` sections.
fn sleepy_hub(fixtures: &[&str], sleep: &str, lead: &str, config: &str) -> TestHub {
    let mut hub = TestHub::new("");
    let omp = hub.install_fake("omp");
    for f in ["rpc", "turns"].iter().chain(fixtures) {
        hub.fixture("omp", f, Some(""));
    }
    let work = hub.root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    hub.env
        .push(("CATALY_IDLE_SLEEP".into(), std::path::PathBuf::from(sleep)));
    hub.write_config(&format!(
        "[omp]\npath = \"{}\"\n[lead]\nmodel = \"fake/primary\"\ncwd = \"{}\"\n{lead}{config}",
        omp.display(),
        work.display()
    ));
    hub
}

fn lead_view(hub: &TestHub) -> Value {
    hub.json(&["lead", "status", "--json"])
}

fn asleep(hub: &TestHub) -> Value {
    hub.until(Duration::from_secs(20), || {
        let v = lead_view(hub);
        (v["phase"] == "asleep").then_some(v)
    })
}

fn running(pid: &Value) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap()
        .success()
}

fn omp_starts(hub: &TestHub) -> usize {
    std::fs::read_to_string(hub.root.join("bin/omp-data/pids"))
        .unwrap()
        .lines()
        .count()
}

/// The lead stays live and on the same process for `secs` seconds (several idle sleeps).
fn stays_awake(hub: &TestHub, pid: &Value, secs: u64) {
    let until = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < until {
        let v = lead_view(hub);
        assert_eq!(v["phase"], "live", "{v}");
        assert_eq!(&v["session"]["pid"], pid, "{v}");
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// The owner's lines carrying `marker` in a session file.
fn user_entries(file: &Value, marker: &str) -> usize {
    std::fs::read_to_string(file.as_str().unwrap())
        .unwrap()
        .lines()
        .filter(|l| l.contains("\"role\":\"user\"") && l.contains(marker))
        .count()
}

/// An idle lead sleeps: its OMP ends and the session is kept, shown in `lead status`, `status` and
/// `health`. A hub restart (the update path) keeps it asleep without starting OMP; an owner message
/// then wakes it on the same session and is delivered exactly once, and it sleeps again.
#[test]
fn an_idle_lead_sleeps_stays_asleep_over_a_restart_and_wakes_once_on_its_session() {
    let mut hub = sleepy_hub(&[], "2s", "", "");
    hub.start();
    let first = live(&hub, &Value::Null);
    let (session, file) = (
        first["session"]["session_id"].clone(),
        first["session"]["session_file"].clone(),
    );
    let slept = asleep(&hub);
    assert_eq!(slept["asleep"]["session_id"], session, "{slept}");
    assert!(slept["session"].is_null(), "{slept}");
    hub.until(Duration::from_secs(10), || {
        (!running(&first["session"]["pid"])).then_some(())
    });
    let status = hub.json(&["status", "--json"]);
    assert!(
        status["lead"].as_str().unwrap().contains("asleep since"),
        "{status}"
    );
    let health: Value = serde_json::from_slice(&hub.cli(&["health", "--json"]).stdout).unwrap();
    let line = health["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "lead")
        .cloned()
        .unwrap();
    assert_eq!(line["level"], "ok", "{line}");
    assert!(line["detail"].as_str().unwrap().starts_with("asleep since"));
    let starts = omp_starts(&hub);

    // The orderly stop and start an update makes: the new hub keeps the lead asleep.
    assert!(hub.stop().success());
    hub.start();
    let resumed = hub.until(Duration::from_secs(20), || {
        let r = hub.json(&["status", "--json"])["resumed"].clone();
        r.is_object().then_some(r)
    });
    assert_eq!(resumed["lead_start"], "not_running", "{resumed}");
    assert!(resumed["lead_asleep_ms"].is_i64(), "{resumed}");
    std::thread::sleep(Duration::from_secs(3));
    assert_eq!(lead_view(&hub)["phase"], "asleep");
    // The new hub's OMP probe is the only start.
    assert_eq!(
        omp_starts(&hub),
        starts + 1,
        "no OMP started for a sleeping lead"
    );

    let sent = Instant::now();
    let out = hub.cli(&["lead", "send", "WAKE-1", "--json"]);
    assert!(out.status.success(), "{out:?}");
    let receipt: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(receipt["state"], "waiting", "{receipt}");
    let woke = live(&hub, &first["session"]["pid"]);
    assert_eq!(woke["session"]["session_id"], session, "{woke}");
    assert_eq!(woke["session"]["session_file"], file, "{woke}");
    hub.until(Duration::from_secs(20), || {
        (user_entries(&file, "WAKE-1") > 0).then_some(())
    });
    eprintln!(
        "MEASURE fake_omp send_to_entry_ms={}",
        sent.elapsed().as_millis()
    );
    let again = asleep(&hub);
    assert_eq!(again["asleep"]["session_id"], session, "{again}");
    assert_eq!(user_entries(&file, "WAKE-1"), 1, "delivered exactly once");
    assert_eq!(
        (again["waiting"].clone(), again["sent"].clone()),
        (Value::from(0), Value::from(0))
    );
    assert!(
        !hub.events().iter().any(|e| e["kind"] == "lead.refused"),
        "the resume was never refused"
    );
    assert!(hub.stop().success());
}

/// An open question card keeps the lead awake; once it is answered the lead sleeps.
#[test]
fn an_open_card_keeps_the_lead_awake() {
    let mut hub = sleepy_hub(&["ask"], "1s", "", "");
    hub.start();
    let first = live(&hub, &Value::Null);
    assert!(hub.cli(&["lead", "send", "ASK pick one"]).status.success());
    hub.until(Duration::from_secs(10), || {
        let v = lead_view(&hub);
        v["session"]["dialogs"]
            .as_array()
            .is_some_and(|d| !d.is_empty())
            .then_some(())
    });
    stays_awake(&hub, &first["session"]["pid"], 4);
    let answered = hub.cli(&["lead", "answer", "d1", r#"{"data":{"color":"Blue"}}"#]);
    assert!(answered.status.success(), "{answered:?}");
    asleep(&hub);
    assert!(hub.stop().success());
}

/// A delivery in doubt (written, never found in the session file) keeps the lead awake.
#[test]
fn a_delivery_in_doubt_keeps_the_lead_awake() {
    let mut hub = sleepy_hub(&["noentry"], "1s", "", "");
    hub.start();
    let first = live(&hub, &Value::Null);
    assert!(hub.cli(&["lead", "send", "LOST-1"]).status.success());
    hub.until(Duration::from_secs(90), || {
        let v = lead_view(&hub);
        (v["in_doubt"].as_u64() > Some(0)).then_some(())
    });
    stays_awake(&hub, &first["session"]["pid"], 4);
    assert!(hub.stop().success());
}

/// HOST req. 89: the lead cannot start when a live lane already fills the session cap.
#[test]
fn a_live_lane_at_the_session_cap_refuses_a_lead_start() {
    let mut hub = sleepy_hub(
        &[],
        "0s",
        "autostart = false\n",
        "[sessions]\ncap = 1\n[lanes]\nmodel = \"fake/primary\"\ncwd = \"/tmp\"\n",
    );
    hub.start();
    hub.until(Duration::from_secs(20), || {
        hub.json(&["status", "--json"])["omp"]
            .is_object()
            .then_some(())
    });
    let params = serde_json::json!({
        "key": "at-cap",
        "title": "Work",
        "brief": "Do the work.",
        "checks": [{ "kind": "command", "argv": ["true"] }],
    })
    .to_string();
    let opened = hub.cli(&["lane", "open", "--json", "--params", &params]);
    assert!(opened.status.success(), "{opened:?}");
    let lanes = hub.json(&["lane", "list", "--json"]);
    assert_eq!(lanes.as_array().unwrap().len(), 1, "{lanes}");
    assert_eq!(lanes[0]["live"], true, "{lanes}");
    assert!(lead_view(&hub)["session"].is_null());
    // The fake logs probe processes too; refusing the lead must add no process at all.
    let starts = omp_starts(&hub);

    let started = hub.cli(&["lead", "start", "--fresh"]);
    assert!(!started.status.success(), "{started:?}");
    let error = String::from_utf8_lossy(&started.stderr);
    assert!(error.contains("the session cap of 1 is reached"), "{error}");
    assert!(lead_view(&hub)["session"].is_null());
    assert_eq!(omp_starts(&hub), starts, "the lead must not spawn");
    assert!(hub.stop().success());
}

/// An open lane keeps the lead awake, with the lead's inbox empty.
#[test]
fn an_open_lane_keeps_the_lead_awake() {
    let work = "/tmp";
    let mut hub = sleepy_hub(
        &[],
        "1s",
        "",
        &format!("[lanes]\nmodel = \"fake/primary\"\ncwd = \"{work}\"\n"),
    );
    hub.start();
    let first = live(&hub, &Value::Null);
    let params = serde_json::json!({
        "key": "awake-1",
        "title": "Work",
        "brief": "Do the work.",
        "checks": [{ "kind": "command", "argv": ["true"] }],
    })
    .to_string();
    let opened = hub.cli(&["lane", "open", "--json", "--params", &params]);
    assert!(opened.status.success(), "{opened:?}");
    // The lane's start note (quiet: it waits for the lead's next turn, and alone would not keep
    // the lead awake) shows the lane started.
    hub.until(Duration::from_secs(20), || {
        (lead_view(&hub)["notes"].as_u64() > Some(0)).then_some(())
    });
    stays_awake(&hub, &first["session"]["pid"], 4);
    assert!(hub.stop().success());
}

/// Quiet notes wait for the lead's next turn, also through a sleep: a lead with only quiet notes
/// pending sleeps, and the notes go with its first turn after the wake.
#[test]
fn quiet_notes_wait_through_a_sleep_and_go_with_the_first_turn() {
    let mut hub = sleepy_hub(&[], "2s", "", "");
    hub.start();
    let first = live(&hub, &Value::Null);
    // An exit by itself brings the lead back on its session with a quiet resume note. The bridge
    // hello of the resumed session is a connection, not a new conversation: the only recap is the
    // fresh start's, still waiting with the resume note.
    kill(&first["session"]["pid"]);
    let second = live(&hub, &first["session"]["pid"]);
    let file = second["session"]["session_file"].clone();
    let slept = asleep(&hub);
    assert_eq!(slept["notes"], 2, "{slept}");
    assert_eq!(user_entries(&file, "resume note"), 0);
    assert!(hub.cli(&["lead", "send", "WAKE-Q"]).status.success());
    let woke = live(&hub, &second["session"]["pid"]);
    assert_eq!(
        woke["session"]["session_id"],
        first["session"]["session_id"]
    );
    hub.until(Duration::from_secs(20), || {
        (user_entries(&file, "WAKE-Q") > 0).then_some(())
    });
    let text = std::fs::read_to_string(file.as_str().unwrap()).unwrap();
    let turn = text
        .lines()
        .find(|l| l.contains("\"role\":\"user\"") && l.contains("WAKE-Q"))
        .unwrap();
    assert!(
        turn.contains("resume note") && turn.contains("[recap]"),
        "one turn carries all: {turn}"
    );
    assert_eq!(user_entries(&file, "resume note"), 1);
    assert_eq!(
        user_entries(&file, "[recap]"),
        1,
        "the woken hello adds none"
    );
    assert!(hub.stop().success());
}

/// `idle_sleep = "0s"` turns sleep off.
#[test]
fn zero_idle_sleep_never_sleeps() {
    let mut hub = sleepy_hub(&[], "1s", "idle_sleep = \"0s\"\n", "");
    hub.start();
    let first = live(&hub, &Value::Null);
    stays_awake(&hub, &first["session"]["pid"], 5);
    assert!(hub.stop().success());
}

// ---- Lossless resume (docs/design/lead-resume.md): the lead keeps its proven conversation. ----

/// A lead hub whose OMP is the fake behind a private wrapper. The wrapper logs every rpc-ui start
/// to `wrap/starts` (`<pid> resume|fresh`) and obeys control files in `wrap/`, read only by those
/// starts, never by the probe: on a resume, `withhold` (one-shot) reads input until it closes and
/// exits 1 without a ready frame; `delay` (one-shot, seconds) holds the ready frame back that long;
/// `fail` (kept) exits 7. On a fresh start `fail-fresh` (kept) exits 9.
struct Wrapped {
    hub: TestHub,
    wrap: std::path::PathBuf,
    config: String,
}

fn wrapped(lead: &str, sleep: Option<&str>) -> Wrapped {
    let mut hub = TestHub::new("");
    let omp = hub.install_fake("omp");
    hub.fixture("omp", "rpc", Some(""));
    hub.fixture("omp", "turns", Some(""));
    let wrap = hub.root.join("wrap");
    std::fs::create_dir_all(&wrap).unwrap();
    let script = wrap.join("omp");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\n\
             d='{d}'\n\
             case \" $* \" in\n\
             *' --resume='*)\n\
                 echo \"$$ resume\" >> \"$d/starts\"\n\
                 if mv \"$d/withhold\" \"$d/withhold.used\" 2>/dev/null; then cat > /dev/null; exit 1; fi\n\
                 if mv \"$d/delay\" \"$d/delay.used\" 2>/dev/null; then sleep \"$(cat \"$d/delay.used\")\"; fi\n\
                 [ -f \"$d/fail\" ] && exit 7 ;;\n\
             *' --session-dir='*)\n\
                 echo \"$$ fresh\" >> \"$d/starts\"\n\
                 [ -f \"$d/fail-fresh\" ] && exit 9 ;;\n\
             esac\n\
             exec '{real}' \"$@\"\n",
            d = wrap.display(),
            real = omp.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let work = hub.root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    if let Some(sleep) = sleep {
        hub.env
            .push(("CATALY_IDLE_SLEEP".into(), std::path::PathBuf::from(sleep)));
    }
    let config = format!(
        "[omp]\npath = \"{}\"\n[lead]\nmodel = \"fake/primary\"\ncwd = \"{}\"\n{lead}",
        script.display(),
        work.display()
    );
    hub.write_config(&config);
    Wrapped { hub, wrap, config }
}

impl Wrapped {
    fn arm(&self, name: &str, text: &str) {
        std::fs::write(self.wrap.join(name), text).unwrap();
    }

    fn disarm(&self, name: &str) {
        std::fs::remove_file(self.wrap.join(name)).unwrap();
    }

    /// The PIDs of the wrapper's starts of `kind` (`resume` or `fresh`).
    fn starts(&self, kind: &str) -> Vec<String> {
        std::fs::read_to_string(self.wrap.join("starts"))
            .unwrap_or_default()
            .lines()
            .filter(|l| l.ends_with(kind))
            .map(|l| l.split(' ').next().unwrap().to_string())
            .collect()
    }

    /// No started OMP (wrapper or fake) is still running.
    fn no_orphans(&self) {
        let pids = std::fs::read_to_string(self.wrap.join("starts")).unwrap_or_default();
        for line in pids.lines() {
            let pid: Value = line
                .split(' ')
                .next()
                .unwrap()
                .parse::<u64>()
                .unwrap()
                .into();
            assert!(!running(&pid), "OMP {line} is still running");
        }
    }
}

/// Starts the hub, sends ORIGINAL, waits for it in transcript A and returns the live view.
fn original(w: &mut Wrapped) -> Value {
    w.hub.start();
    let first = live(&w.hub, &Value::Null);
    assert!(w.hub.cli(&["lead", "send", "ORIGINAL"]).status.success());
    w.hub.until(Duration::from_secs(20), || {
        (user_entries(&first["session"]["session_file"], "ORIGINAL") == 1).then_some(())
    });
    first
}

fn held(hub: &TestHub, limit: u64) -> Value {
    hub.until(Duration::from_secs(limit), || {
        let v = lead_view(hub);
        (v["phase"] == "held").then_some(v)
    })
}

/// The transcripts in A's folder.
fn transcripts(file: &Value) -> Vec<std::path::PathBuf> {
    let dir = std::path::Path::new(file.as_str().unwrap())
        .parent()
        .unwrap();
    std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .collect()
}

/// Transcripts in A's folder whose owner lines carry `marker`.
fn transcripts_with(file: &Value, marker: &str) -> Vec<String> {
    transcripts(file)
        .into_iter()
        .map(|p| p.display().to_string())
        .filter(|p| user_entries(&Value::from(p.as_str()), marker) > 0)
        .collect()
}

fn session_files(file: &Value) -> usize {
    transcripts(file).len()
}

/// A resume that never becomes ready fails that attempt only. The owner's message waits; after the
/// attempt and a hub restart without the fault the lead is on session A, never a fresh B, and the
/// message reaches A exactly once.
#[test]
fn a_ready_timeout_then_restart_resumes_the_same_conversation() {
    let mut w = wrapped("", None);
    let first = original(&mut w);
    let (id, file) = (
        first["session"]["session_id"].clone(),
        first["session"]["session_file"].clone(),
    );
    assert!(w.hub.stop().success());
    w.arm("withhold", "");
    w.hub.start();
    assert!(w.hub.cli(&["lead", "send", "WAITING"]).status.success());
    // Past the old 15 s limit the attempt is still starting, its input untouched.
    w.hub.until(Duration::from_secs(10), || {
        (!w.starts("resume").is_empty()).then_some(())
    });
    std::thread::sleep(Duration::from_secs(20));
    let during = lead_view(&w.hub);
    assert_eq!(during["phase"], "starting", "{during}");
    assert_eq!(during["waiting"], 1, "{during}");
    assert_eq!(user_entries(&file, "WAITING"), 0);
    // The withheld attempt ends at its deadline; whatever follows, a hub restart resumes A.
    w.hub.until(Duration::from_secs(120), || {
        let v = lead_view(&w.hub);
        (w.starts("resume").len() >= 2 || v["phase"] == "held").then_some(())
    });
    assert!(w.hub.stop().success());
    w.no_orphans();
    w.hub.start();
    let resumed = live(&w.hub, &Value::Null);
    assert_eq!(resumed["session"]["session_id"], id, "{resumed}");
    assert_eq!(resumed["session"]["session_file"], file, "{resumed}");
    assert_eq!(resumed["anchor"]["session_id"], id, "{resumed}");
    w.hub.until(Duration::from_secs(20), || {
        (user_entries(&file, "WAITING") == 1).then_some(())
    });
    assert!(w.hub.stop().success());
    assert_eq!(user_entries(&file, "WAITING"), 1, "delivered once");
    assert_eq!(
        transcripts_with(&file, "WAITING"),
        vec![file.as_str().unwrap().to_string()]
    );
    assert_eq!(session_files(&file), 1, "no fresh conversation was made");
    w.no_orphans();
}

/// A pin selects its exact earlier binding, also behind a newer bound conversation and a newer
/// failed attempt: the restart resumes A.
#[test]
fn a_pinned_session_resumes_behind_newer_attempts() {
    let mut w = wrapped("", None);
    let first = original(&mut w);
    let (id, file) = (
        first["session"]["session_id"].clone(),
        first["session"]["session_file"].clone(),
    );
    // A newer bound conversation B.
    assert!(w.hub.cli(&["lead", "stop"]).status.success());
    let started = w.hub.cli(&["lead", "start", "--fresh"]);
    assert!(started.status.success(), "{started:?}");
    let b = live(&w.hub, &first["session"]["pid"]);
    assert_ne!(b["session"]["session_id"], id, "{b}");
    assert!(w.hub.stop().success());
    // Pin A; its next resume never gets ready and the hub stops under it: a newer unbound attempt.
    let id_str = id.as_str().unwrap();
    w.hub
        .write_config(&format!("{}session_id = \"{id_str}\"\n", w.config));
    w.arm("withhold", "");
    w.hub.start();
    w.hub.until(Duration::from_secs(30), || {
        (!w.starts("resume").is_empty()).then_some(())
    });
    std::thread::sleep(Duration::from_secs(2));
    assert!(w.hub.stop().success());
    w.no_orphans();
    assert!(w.wrap.join("withhold.used").exists());
    w.hub.start();
    let resumed = live(&w.hub, &Value::Null);
    assert_eq!(resumed["session"]["session_id"], id, "{resumed}");
    assert_eq!(resumed["session"]["session_file"], file, "{resumed}");
    assert!(w.hub.cli(&["lead", "send", "PINNED"]).status.success());
    w.hub.until(Duration::from_secs(20), || {
        (user_entries(&file, "PINNED") == 1).then_some(())
    });
    assert!(w.hub.stop().success());
    w.no_orphans();
}

/// Unpinned, a missing or unverified transcript holds the lead: no fresh conversation, the files
/// stay, the owner's message waits, and status names the precise check.
#[test]
fn an_unpinned_lead_with_a_missing_or_unverified_transcript_is_held() {
    for case in ["missing", "unverified"] {
        let mut w = wrapped("", None);
        let first = original(&mut w);
        let (id, file) = (
            first["session"]["session_id"].clone(),
            first["session"]["session_file"].clone(),
        );
        assert!(w.hub.stop().success());
        let path = std::path::PathBuf::from(file.as_str().unwrap());
        let kept = path.with_extension("kept");
        let before = std::fs::read_to_string(&path).unwrap();
        let expected = if case == "missing" {
            std::fs::rename(&path, &kept).unwrap();
            "missing"
        } else {
            let other = before.replacen(
                id.as_str().unwrap(),
                "00000000-0000-0000-0000-000000000000",
                1,
            );
            std::fs::write(&path, &other).unwrap();
            "HeaderIdentity"
        };
        let snapshot = if case == "missing" {
            std::fs::read_to_string(&kept).unwrap()
        } else {
            std::fs::read_to_string(&path).unwrap()
        };
        let files = std::fs::read_dir(path.parent().unwrap()).unwrap().count();
        w.hub.start();
        assert!(w.hub.cli(&["lead", "send", "WAITING"]).status.success());
        let v = held(&w.hub, 30);
        let reason = v["reason"].as_str().unwrap_or_default();
        assert!(reason.contains(expected), "{case}: {v}");
        assert!(reason.contains(id.as_str().unwrap()), "{case}: {v}");
        assert_eq!(v["anchor"]["session_id"], id, "{case}: {v}");
        // It stays held: never fresh.
        std::thread::sleep(Duration::from_secs(3));
        let v = lead_view(&w.hub);
        assert_eq!(v["phase"], "held", "{case}: {v}");
        assert_eq!(v["waiting"], 1, "{case}: {v}");
        assert!(
            w.starts("fresh").len() == 1,
            "{case}: only A's first start was fresh"
        );
        assert!(
            w.starts("resume").is_empty(),
            "{case}: an unverified file is never resumed"
        );
        assert!(w.hub.stop().success());
        assert_eq!(
            std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
            files,
            "{case}: no file added or removed"
        );
        let after = if case == "missing" {
            std::fs::read_to_string(&kept).unwrap()
        } else {
            std::fs::read_to_string(&path).unwrap()
        };
        assert_eq!(after, snapshot, "{case}: the transcript is kept as it was");
    }
}

/// An explicit fresh start that fails keeps A recorded and held, also over a hub restart; then
/// "resume old" (`lead start`) resumes A, and "retry fresh" (`lead start --fresh`) makes B.
#[test]
fn a_failed_fresh_start_keeps_the_old_conversation_held_for_the_owner() {
    let mut w = wrapped("", None);
    let first = original(&mut w);
    let (id, file) = (
        first["session"]["session_id"].clone(),
        first["session"]["session_file"].clone(),
    );
    let fail_fresh = |w: &Wrapped| {
        assert!(w.hub.cli(&["lead", "stop"]).status.success());
        w.arm("fail-fresh", "");
        let out = w.hub.cli(&["lead", "start", "--fresh"]);
        assert!(!out.status.success(), "{out:?}");
        let v = held(&w.hub, 20);
        assert!(v["session"]["pid"].is_null(), "{v}");
        w.disarm("fail-fresh");
    };
    fail_fresh(&w);
    // A hub restart neither revives A nor starts fresh by itself.
    assert!(w.hub.stop().success());
    let fresh = w.starts("fresh").len();
    w.hub.start();
    assert!(w.hub.cli(&["lead", "send", "WAITING"]).status.success());
    let v = held(&w.hub, 20);
    let reason = v["reason"].as_str().unwrap_or_default();
    assert!(
        reason.contains("lead start --fresh") && reason.contains("lead start`"),
        "{v}"
    );
    std::thread::sleep(Duration::from_secs(3));
    let v = lead_view(&w.hub);
    assert_eq!(v["phase"], "held", "{v}");
    assert_eq!(v["anchor"]["session_id"], id, "{v}");
    assert_eq!(v["waiting"], 1, "{v}");
    assert_eq!(w.starts("fresh").len(), fresh);
    assert_eq!(w.starts("resume"), Vec::<String>::new());

    // Resume old.
    let out = w.hub.cli(&["lead", "start"]);
    assert!(out.status.success(), "{out:?}");
    let old = live(&w.hub, &Value::Null);
    assert_eq!(old["session"]["session_id"], id, "{old}");
    assert_eq!(old["session"]["session_file"], file, "{old}");
    w.hub.until(Duration::from_secs(20), || {
        (user_entries(&file, "WAITING") == 1).then_some(())
    });

    // Retry fresh.
    fail_fresh(&w);
    let out = w.hub.cli(&["lead", "start", "--fresh"]);
    assert!(out.status.success(), "{out:?}");
    let b = live(&w.hub, &Value::Null);
    assert_ne!(b["session"]["session_id"], id, "{b}");
    assert_eq!(b["anchor"]["session_id"], b["session"]["session_id"], "{b}");
    assert!(w.hub.stop().success());
    assert!(
        std::path::Path::new(file.as_str().unwrap()).is_file(),
        "A is kept"
    );
    assert_eq!(user_entries(&file, "WAITING"), 1);
    w.no_orphans();
}

/// Rewrites a stopped hub's store as 0.2.7 left a 0.2.6 history: the anchored conversation also
/// bound earlier in another folder on `file`, 0011's ambiguity hold, schema 12.
fn as_0_2_7_held(hub: &TestHub, file: &str) {
    let db = rusqlite::Connection::open(hub.state().join("cataly.db")).unwrap();
    db.busy_timeout(Duration::from_secs(10)).unwrap();
    db.execute(
        "INSERT INTO sessions (handle, role, runtime, cwd, name, model, mode, state, session_id, \
         session_file, started_ms, updated_ms) \
         SELECT 'older', role, runtime, '/elsewhere', name, model, 'fresh', 'stopped', session_id, \
         ?1, 0, 0 FROM sessions WHERE handle = (SELECT handle FROM lead_anchor)",
        [file],
    )
    .unwrap();
    db.execute(
        "INSERT INTO lead_bindings (handle, session_id, session_file, cwd, runtime, provenance, bound_ms) \
         SELECT 'older', session_id, ?1, '/elsewhere', runtime, 'migrated exact binding', 0 \
         FROM lead_bindings WHERE handle = (SELECT handle FROM lead_anchor)",
        [file],
    )
    .unwrap();
    db.execute_batch(
        "UPDATE lead_anchor SET hold = 'ambiguous lead binding history'; PRAGMA user_version = 12;",
    )
    .unwrap();
}

/// A 0.2.7 store held as ambiguous only because the lead's folder changed is repaired when the
/// hub opens it: the lead resumes the same conversation by itself.
#[test]
fn a_0_2_7_store_held_for_a_changed_folder_resumes_the_conversation() {
    let mut w = wrapped("", None);
    let first = original(&mut w);
    let (id, file) = (
        first["session"]["session_id"].clone(),
        first["session"]["session_file"].clone(),
    );
    assert!(w.hub.stop().success());
    as_0_2_7_held(&w.hub, file.as_str().unwrap());
    w.hub.start();
    let resumed = live(&w.hub, &Value::Null);
    assert_eq!(resumed["session"]["session_id"], id, "{resumed}");
    assert_eq!(resumed["session"]["session_file"], file, "{resumed}");
    assert_eq!(resumed["anchor"]["session_id"], id, "{resumed}");
    assert!(w.hub.cli(&["lead", "send", "REPAIRED"]).status.success());
    w.hub.until(Duration::from_secs(20), || {
        (user_entries(&file, "REPAIRED") == 1).then_some(())
    });
    assert!(w.hub.stop().success());
    assert_eq!(session_files(&file), 1, "no fresh conversation was made");
    w.no_orphans();
}

/// Two transcripts recorded for the anchored conversation hold the lead, and the hold names the
/// way back: the owner's plain `lead start` resumes the anchored transcript once it verifies, and
/// later starts need no confirmation.
#[test]
fn two_transcripts_for_the_lead_hold_until_a_plain_lead_start_resumes_the_anchored_one() {
    let mut w = wrapped("", None);
    let first = original(&mut w);
    let (id, file) = (
        first["session"]["session_id"].clone(),
        first["session"]["session_file"].clone(),
    );
    assert!(w.hub.stop().success());
    as_0_2_7_held(&w.hub, "/elsewhere/copy.jsonl");
    w.hub.start();
    assert!(w.hub.cli(&["lead", "send", "WAITING"]).status.success());
    let v = held(&w.hub, 30);
    let reason = v["reason"].as_str().unwrap_or_default();
    assert!(
        reason.contains("`cataly lead start` resumes") && reason.contains(file.as_str().unwrap()),
        "{v}"
    );
    assert_eq!(v["anchor"]["session_id"], id, "{v}");
    std::thread::sleep(Duration::from_secs(3));
    assert_eq!(lead_view(&w.hub)["phase"], "held");
    assert!(w.starts("resume").is_empty(), "never resumed unconfirmed");
    let out = w.hub.cli(&["lead", "start"]);
    assert!(out.status.success(), "{out:?}");
    let resumed = live(&w.hub, &Value::Null);
    assert_eq!(resumed["session"]["session_id"], id, "{resumed}");
    assert_eq!(resumed["session"]["session_file"], file, "{resumed}");
    w.hub.until(Duration::from_secs(20), || {
        (user_entries(&file, "WAITING") == 1).then_some(())
    });
    assert!(w.hub.stop().success());
    w.hub.start();
    let again = live(&w.hub, &Value::Null);
    assert_eq!(again["session"]["session_file"], file, "{again}");
    assert!(w.hub.stop().success());
    assert_eq!(user_entries(&file, "WAITING"), 1, "delivered once");
    assert_eq!(session_files(&file), 1, "no fresh conversation was made");
    w.no_orphans();
}

/// A sleeping lead woken by the owner on a slow resume. Ready after 20 s (past the old 15 s limit,
/// within the 60 s deadline) binds A on that attempt; a resume that never gets ready fails at the
/// deadline and is retried under backoff onto A. Each wake delivers the owner's message, and the
/// quiet notes with the first, once, then the lead sleeps again.
#[test]
fn a_slow_wake_recovers_the_sleeping_session_and_delivers_once() {
    let mut w = wrapped("", Some("2s"));
    w.hub.start();
    let first = live(&w.hub, &Value::Null);
    // An exit by itself brings the lead back on A with a quiet resume note, next to the fresh
    // start's recap; the resumed session's hello adds none.
    kill(&first["session"]["pid"]);
    let second = live(&w.hub, &first["session"]["pid"]);
    let (id, file) = (
        second["session"]["session_id"].clone(),
        second["session"]["session_file"].clone(),
    );
    assert_eq!(id, first["session"]["session_id"]);
    assert_eq!(asleep(&w.hub)["notes"], 2);

    w.arm("delay", "20");
    let resumes = w.starts("resume").len();
    assert!(w.hub.cli(&["lead", "send", "WAKE-SLOW"]).status.success());
    std::thread::sleep(Duration::from_secs(17));
    let during = lead_view(&w.hub);
    assert_eq!(during["phase"], "starting", "{during}");
    assert_eq!(user_entries(&file, "WAKE-SLOW"), 0);
    let woke = live(&w.hub, &second["session"]["pid"]);
    assert_eq!(woke["session"]["session_id"], id, "{woke}");
    assert_eq!(woke["session"]["session_file"], file, "{woke}");
    assert_eq!(w.starts("resume").len(), resumes + 1, "one attempt");
    w.hub.until(Duration::from_secs(20), || {
        (user_entries(&file, "WAKE-SLOW") == 1).then_some(())
    });
    let text = std::fs::read_to_string(file.as_str().unwrap()).unwrap();
    let turn = text
        .lines()
        .find(|l| l.contains("\"role\":\"user\"") && l.contains("WAKE-SLOW"))
        .unwrap();
    assert!(
        turn.contains("resume note"),
        "one turn carries both: {turn}"
    );
    let again = asleep(&w.hub);
    assert_eq!(again["asleep"]["session_id"], id, "{again}");

    w.arm("withhold", "");
    let resumes = w.starts("resume").len();
    assert!(w.hub.cli(&["lead", "send", "WAKE-LATE"]).status.success());
    let woke = w.hub.until(Duration::from_secs(150), || {
        let v = lead_view(&w.hub);
        assert_ne!(v["phase"], "held", "{v}");
        (v["phase"] == "live" && v["session"]["pid"].is_u64()).then_some(v)
    });
    assert_eq!(woke["session"]["session_id"], id, "{woke}");
    assert_eq!(woke["session"]["session_file"], file, "{woke}");
    assert_eq!(
        w.starts("resume").len(),
        resumes + 2,
        "a timed-out attempt and its retry"
    );
    w.hub.until(Duration::from_secs(20), || {
        (user_entries(&file, "WAKE-LATE") == 1).then_some(())
    });
    asleep(&w.hub);
    assert_eq!(user_entries(&file, "WAKE-SLOW"), 1);
    assert_eq!(user_entries(&file, "WAKE-LATE"), 1);
    assert_eq!(user_entries(&file, "resume note"), 1);
    assert_eq!(user_entries(&file, "[recap]"), 1, "no wake added a recap");
    assert_eq!(session_files(&file), 1, "no fresh conversation was made");
    assert!(w.hub.stop().success());
    w.no_orphans();
}

/// From PR #299 (Momentum96), now on a ready timeout: a hub shutdown while a timed-out resume waits
/// for its retry cancels the retry and leaves no OMP running; the next hub resumes A. A start that
/// exits before ready (EOF) is held, not retried, so the fault is a withheld ready.
#[test]
fn hub_shutdown_cancels_a_lead_ready_retry_and_next_hub_can_resume() {
    let mut w = wrapped("", None);
    let first = original(&mut w);
    let id = first["session"]["session_id"].clone();
    assert!(w.hub.stop().success());
    w.arm("withhold", "");
    w.hub.start();
    w.hub.until(Duration::from_secs(120), || {
        let v = lead_view(&w.hub);
        assert_ne!(v["phase"], "held", "{v}");
        v["reason"]
            .as_str()
            .is_some_and(|r| r.contains("restarting in"))
            .then_some(())
    });
    let stopping = Instant::now();
    assert!(w.hub.stop().success());
    assert!(stopping.elapsed() < Duration::from_secs(20));
    let attempts = w.starts("resume").len();
    assert!(attempts <= 2, "{attempts}");
    w.no_orphans();
    std::thread::sleep(Duration::from_secs(3));
    assert_eq!(
        w.starts("resume").len(),
        attempts,
        "nothing started after shutdown"
    );
    w.hub.start();
    let resumed = live(&w.hub, &Value::Null);
    assert_eq!(resumed["session"]["session_id"], id, "{resumed}");
    assert!(w.hub.stop().success());
    w.no_orphans();
}

/// The events of `kind` the hub recorded, across all its runs.
fn told(hub: &TestHub, kind: &str) -> Vec<Value> {
    hub.events()
        .into_iter()
        .filter(|e| e["kind"] == kind)
        .collect()
}

/// A resume that the start rejects (its OMP exits before ready: no timeout, nothing to retry)
/// holds the lead, and the owner is told once, directly, in his language: the reason, that the
/// conversation is kept, `cataly lead start` after the fix, and that an update does not lift the
/// hold. `lead status` and `health` show the same text. Hub restarts (an update's path) keep it
/// held without a start and without telling him again; after the fix `lead start` resumes A.
#[test]
fn a_rejected_resume_stays_held_over_restarts_and_the_owner_is_told_once() {
    let mut w = wrapped("", None);
    let first = original(&mut w);
    let (id, file) = (
        first["session"]["session_id"].clone(),
        first["session"]["session_file"].clone(),
    );
    assert!(w.hub.stop().success());
    w.arm("fail", "");
    w.hub.start();
    let v = held(&w.hub, 60);
    let notice = v["notice"].as_str().unwrap_or_default().to_string();
    for part in [
        "보류",
        "원인:",
        "보존",
        id.as_str().unwrap(),
        file.as_str().unwrap(),
        "`cataly lead start`",
        "업데이트나 허브 재시작만으로는",
    ] {
        assert!(notice.contains(part), "{part}: {v}");
    }
    let notices = w.hub.until(Duration::from_secs(10), || {
        let n = told(&w.hub, "lead.held");
        (!n.is_empty()).then_some(n)
    });
    assert_eq!(notices.len(), 1, "{notices:?}");
    assert_eq!(
        notices[0]["text"].as_str().unwrap(),
        notice,
        "the same text"
    );
    let status = w.hub.cli(&["lead", "status"]);
    let status = String::from_utf8_lossy(&status.stdout);
    assert!(status.contains(&notice), "{status}");
    assert!(
        status.contains(&format!("target   {}", id.as_str().unwrap())),
        "{status}"
    );
    let health = w.hub.cli(&["health"]);
    let health = String::from_utf8_lossy(&health.stdout);
    assert!(
        health.contains(&notice.lines().collect::<Vec<_>>().join(" ")),
        "{health}"
    );
    let attempts = w.starts("resume").len();
    assert_eq!(attempts, 1, "a rejection is not retried");
    for _ in 0..2 {
        assert!(w.hub.stop().success());
        w.hub.start();
        let again = held(&w.hub, 30);
        assert_eq!(again["anchor"]["session_id"], id, "{again}");
        assert_eq!(again["notice"].as_str(), Some(notice.as_str()), "{again}");
        std::thread::sleep(Duration::from_secs(3));
        assert_eq!(told(&w.hub, "lead.held").len(), 1, "told only once");
        assert_eq!(
            w.starts("resume").len(),
            attempts,
            "no start until the owner acts"
        );
    }
    assert!(w.starts("fresh").len() == 1, "never a fresh lead");
    w.disarm("fail");
    let out = w.hub.cli(&["lead", "start"]);
    assert!(out.status.success(), "{out:?}");
    let back = live(&w.hub, &Value::Null);
    assert_eq!(back["session"]["session_id"], id, "{back}");
    assert_eq!(back["session"]["session_file"], file, "{back}");
    assert_eq!(told(&w.hub, "lead.held").len(), 1);
    assert!(w.hub.stop().success());
    w.no_orphans();
}

/// A resume still starting at 15 s tells the owner once, directly: not a failure yet, the
/// conversation and queued input kept; `lead status` shows the target, the elapsed time and the
/// attempt. Ready at 20 s binds A, and no hold is told.
#[test]
fn a_slow_resume_tells_the_owner_at_15_s_once() {
    let mut w = wrapped("", None);
    let first = original(&mut w);
    let id = first["session"]["session_id"].clone();
    assert!(w.hub.stop().success());
    w.arm("delay", "20");
    w.hub.start();
    let began = Instant::now();
    w.hub.until(Duration::from_secs(10), || {
        (!w.starts("resume").is_empty()).then_some(())
    });
    assert_eq!(told(&w.hub, "lead.slow"), Vec::<Value>::new());
    let slow = w.hub.until(Duration::from_secs(25), || {
        let n = told(&w.hub, "lead.slow");
        (!n.is_empty()).then_some(n)
    });
    let at = began.elapsed();
    assert!(at >= Duration::from_secs(15), "{at:?}");
    let text = slow[0]["text"].as_str().unwrap();
    for part in [
        "15초",
        "아직 실패가 아닙니다",
        "보존",
        id.as_str().unwrap(),
        "`cataly lead status`",
    ] {
        assert!(text.contains(part), "{part}: {text}");
    }
    assert!(!text.contains("--fresh"), "{text}");
    let status = w.hub.cli(&["lead", "status"]);
    let status = String::from_utf8_lossy(&status.stdout);
    assert!(status.contains("startup  starting for "), "{status}");
    assert!(status.contains("attempt 1 of up to 6"), "{status}");
    assert!(
        status.contains(&format!("target   {}", id.as_str().unwrap())),
        "{status}"
    );
    let back = live(&w.hub, &Value::Null);
    assert_eq!(back["session"]["session_id"], id, "{back}");
    std::thread::sleep(Duration::from_secs(2));
    assert_eq!(told(&w.hub, "lead.slow").len(), 1, "once");
    assert_eq!(told(&w.hub, "lead.held"), Vec::<Value>::new());
    assert!(w.hub.stop().success());
    w.no_orphans();
}

/// Stock OMP factories run before ready; `session_start` hooks run after ready but before RPC.
/// Both must share the same startup budget and resume without issuing inference.
#[test]
fn stock_omp_delayed_factory_and_session_start_resume_the_exact_anchor() {
    if std::env::var("CATALY_CONTRACT_OMP").as_deref() != Ok("1") {
        return;
    }
    let executable = std::env::var_os("CATALY_CONTRACT_OMP_PATH")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("PATH").and_then(|path| {
                std::env::split_paths(&path)
                    .map(|dir| dir.join("omp"))
                    .find(|path| path.is_file())
            })
        })
        .expect("stock OMP executable");
    for delayed in [
        "await delay();",
        "pi.on('session_start', async () => { await delay(); });",
    ] {
        let mut hub = TestHub::new("");
        let agent = hub.root.join("stock-agent");
        let work = hub.root.join("stock-work");
        std::fs::create_dir_all(&agent).unwrap();
        std::fs::create_dir_all(&work).unwrap();
        let model = support::model::FakeModel::start();
        std::fs::write(
            agent.join("models.yml"),
            support::model::models_yml(model.port, &["primary"]),
        )
        .unwrap();
        let extension = agent.join("extensions/delayed-start.ts");
        std::fs::create_dir_all(extension.parent().unwrap()).unwrap();
        std::fs::write(&extension, format!(
            "export default async function(pi) {{ if (!process.argv.some(a => a.startsWith('--resume'))) return; const delay = () => new Promise(resolve => setTimeout(resolve, 16000)); {delayed} }}\n"
        )).unwrap();
        hub.env.push(("PI_CODING_AGENT_DIR".into(), agent));
        hub.write_config(&format!(
            "[omp]\npath = \"{}\"\n[sessions]\nextra_flags = [\"--no-skills\", \"--no-rules\", \"--no-context-files\", \"--no-title\"]\n[lead]\nmodel = \"fake/primary\"\ncwd = \"{}\"\n",
            executable.display(), work.display()
        ));
        hub.start();
        let first = live(&hub, &Value::Null);
        assert!(
            hub.cli(&["lead", "send", "STOCK-ORIGINAL"])
                .status
                .success()
        );
        hub.until(Duration::from_secs(30), || {
            let view = lead_view(&hub);
            (view["sent"] == 0 && view["waiting"] == 0 && !model.seen().is_empty()).then_some(())
        });
        assert!(hub.stop().success());
        let requests = model.seen().len();
        hub.start();
        let resumed = hub.until(Duration::from_secs(50), || {
            let view = lead_view(&hub);
            (view["phase"] == "live").then_some(view)
        });
        assert_eq!(
            resumed["session"]["session_id"],
            first["session"]["session_id"]
        );
        assert_eq!(
            resumed["session"]["session_file"],
            first["session"]["session_file"]
        );
        assert_eq!(
            model.seen().len(),
            requests,
            "resume invoked model inference"
        );
        assert!(hub.stop().success());
    }
}

/// Refusing a busy stop must not cancel the bound recovery episode used by the next wake.
#[test]
fn refused_stop_preserves_recovery_for_the_next_wake() {
    let mut hub = sleepy_hub(&["ask"], "2s", "", "");
    hub.start();
    live(&hub, &Value::Null);
    assert!(hub.stop().success());
    hub.start();
    let resumed = live(&hub, &Value::Null);
    assert_eq!(resumed["recovery"]["state"], "bound");
    assert!(hub.cli(&["lead", "send", "ASK pick one"]).status.success());
    hub.until(Duration::from_secs(10), || {
        let view = lead_view(&hub);
        view["session"]["dialogs"]
            .as_array()
            .is_some_and(|dialogs| !dialogs.is_empty())
            .then_some(())
    });
    assert!(!hub.cli(&["lead", "stop"]).status.success());
    assert_eq!(lead_view(&hub)["recovery"]["state"], "bound");
    assert!(
        hub.cli(&["lead", "answer", "d1", r#"{"data":{"color":"Blue"}}"#])
            .status
            .success()
    );
    asleep(&hub);
    assert!(
        hub.cli(&["lead", "send", "AFTER-REFUSED-STOP"])
            .status
            .success()
    );
    let awake = live(&hub, &resumed["session"]["pid"]);
    assert_eq!(
        awake["session"]["session_id"],
        resumed["session"]["session_id"]
    );
    hub.until(Duration::from_secs(10), || {
        let view = lead_view(&hub);
        (view["sent"] == 0 && view["waiting"] == 0).then_some(())
    });
    assert_eq!(
        user_entries(&awake["session"]["session_file"], "AFTER-REFUSED-STOP"),
        1
    );
    assert!(hub.stop().success());
}

/// A duplicate same-target start observes the owned startup instead of cancelling it.
#[test]
fn a_duplicate_start_does_not_replace_the_owned_resume_attempt() {
    let mut w = wrapped("", None);
    let first = original(&mut w);
    assert!(w.hub.stop().success());
    w.arm("delay", "2");
    w.hub.start();
    w.hub.until(Duration::from_secs(10), || {
        (w.starts("resume").len() == 1).then_some(())
    });
    assert!(!w.hub.cli(&["lead", "start"]).status.success());
    let resumed = live(&w.hub, &first["session"]["pid"]);
    assert_eq!(
        resumed["session"]["session_id"],
        first["session"]["session_id"]
    );
    assert_eq!(w.starts("resume").len(), 1);
    assert!(w.hub.stop().success());
    w.no_orphans();
}

#[test]
fn first_failed_start_retries_when_no_conversation_was_bound() {
    let mut w = wrapped("", None);
    w.arm("fail-fresh", "");
    w.hub.start();
    held(&w.hub, 20);
    w.disarm("fail-fresh");
    let retried = w.hub.cli(&["lead", "start"]);
    assert!(retried.status.success(), "{retried:?}");
    let started = live(&w.hub, &Value::Null);
    assert!(started["anchor"]["session_id"].is_string(), "{started}");
    assert_eq!(w.starts("fresh").len(), 2);
    assert!(w.hub.stop().success());
}

#[test]
fn a_startup_model_mismatch_keeps_the_session_fenced_until_owner_acceptance() {
    let mut w = wrapped("", Some("1s"));
    let first = original(&mut w);
    assert!(w.hub.cli(&["lead", "stop"]).status.success());
    w.hub.fixture("omp", "model", Some("fake/other"));
    let out = w.hub.cli(&["lead", "start", "--fresh"]);
    assert!(out.status.success(), "{out:?}");
    let fenced = live(&w.hub, &first["session"]["pid"]);
    assert!(fenced["session"]["input_blocked"].as_bool().unwrap());
    stays_awake(&w.hub, &fenced["session"]["pid"], 2);
    assert_eq!(
        fenced["anchor"]["session_id"],
        first["anchor"]["session_id"]
    );
    assert_ne!(
        fenced["session"]["session_id"],
        first["session"]["session_id"]
    );
    assert!(
        w.hub
            .cli(&["lead", "send", "AFTER-MODEL-ACCEPT"])
            .status
            .success()
    );
    assert_eq!(
        user_entries(&fenced["session"]["session_file"], "AFTER-MODEL-ACCEPT"),
        0
    );
    w.hub.until(Duration::from_secs(10), || {
        w.hub
            .events()
            .iter()
            .any(|e| e["kind"] == "session.fenced")
            .then_some(())
    });
    let accepted = w.hub.cli(&["lead", "accept-model"]);
    assert!(accepted.status.success(), "{accepted:?}");
    w.hub.until(Duration::from_secs(10), || {
        (user_entries(&fenced["session"]["session_file"], "AFTER-MODEL-ACCEPT") == 1).then_some(())
    });
    assert_eq!(
        lead_view(&w.hub)["anchor"]["session_id"],
        fenced["session"]["session_id"]
    );
    assert!(w.hub.stop().success());
}

/// A resume fenced for a model mismatch is a recorded startup: its recovery episode ends, so a
/// later exit of the fenced lead gets a fresh retry window instead of the old one.
#[test]
fn a_fenced_resume_ends_its_recovery_episode() {
    let mut w = wrapped("", None);
    let first = original(&mut w);
    assert!(w.hub.cli(&["lead", "stop"]).status.success());
    w.hub.fixture("omp", "model", Some("fake/other"));
    let out = w.hub.cli(&["lead", "start"]);
    assert!(out.status.success(), "{out:?}");
    let fenced = live(&w.hub, &first["session"]["pid"]);
    assert!(
        fenced["session"]["input_blocked"].as_bool().unwrap(),
        "{fenced}"
    );
    let db = rusqlite::Connection::open(w.hub.state().join("cataly.db")).unwrap();
    db.busy_timeout(Duration::from_secs(10)).unwrap();
    let episode: String = db
        .query_row(
            "SELECT state FROM startup_episodes WHERE target = 'lead'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(episode, "bound");
    assert!(w.hub.stop().success());
}

/// HOST req. 27 with a thinking suffix: a fresh install whose bridge matches the hub verifies
/// `fake/primary:high` (OMP runs `fake/primary` at high) and delivers. A bridge older than the hub
/// fences the session as unverified at once, without a retry; the owner is told once, in his
/// language, with the fix and the accept command, also over hub restarts; `lead accept-model`
/// releases it.
#[test]
fn a_suffixed_model_verifies_and_an_old_bridge_is_fenced_unverified_once() {
    let mut w = wrapped("", None);
    w.hub.write_config(
        &w.config
            .replace("\"fake/primary\"", "\"fake/primary:high\""),
    );
    let first = original(&mut w);
    assert_eq!(first["session"]["input_blocked"], false, "{first}");
    assert_eq!(first["session"]["model"], "fake/primary", "{first}");

    assert!(w.hub.cli(&["lead", "stop"]).status.success());
    w.hub.fixture("omp", "old-bridge", Some(""));
    let asked = std::time::Instant::now();
    let out = w.hub.cli(&["lead", "start"]);
    assert!(out.status.success(), "{out:?}");
    let fenced = live(&w.hub, &first["session"]["pid"]);
    assert!(
        asked.elapsed() < Duration::from_secs(15),
        "no deadline spent"
    );
    assert_eq!(fenced["session"]["input_blocked"], true, "{fenced}");
    let reason = fenced["session"]["reason"].as_str().unwrap_or_default();
    assert!(reason.starts_with("model unverified"), "{fenced}");
    assert_eq!(w.starts("resume").len(), 1, "never retried");
    let notices = w.hub.until(Duration::from_secs(10), || {
        let n = told(&w.hub, "lead.held");
        (!n.is_empty()).then_some(n)
    });
    let text = notices[0]["text"].as_str().unwrap();
    for part in [
        "`cataly update`",
        "`cataly lead accept-model`",
        "`cataly lead start`",
    ] {
        assert!(text.contains(part), "{part}: {text}");
    }
    for _ in 0..2 {
        assert!(w.hub.stop().success());
        w.hub.start();
        let again = live(&w.hub, &Value::Null);
        assert_eq!(again["session"]["input_blocked"], true, "{again}");
        std::thread::sleep(Duration::from_secs(2));
        assert_eq!(told(&w.hub, "lead.held").len(), 1, "told only once");
    }
    assert!(
        w.hub
            .cli(&["lead", "send", "AFTER-ACCEPT"])
            .status
            .success()
    );
    let again = lead_view(&w.hub);
    assert_eq!(
        user_entries(&again["session"]["session_file"], "AFTER-ACCEPT"),
        0
    );
    let accepted = w.hub.cli(&["lead", "accept-model"]);
    assert!(accepted.status.success(), "{accepted:?}");
    w.hub.until(Duration::from_secs(10), || {
        (user_entries(&again["session"]["session_file"], "AFTER-ACCEPT") == 1).then_some(())
    });
    assert!(w.hub.stop().success());
}

/// A lead whose extension never connects is not a failed start: when the shared deadline has
/// almost run out, the session binds, fenced as unverified, without a retry; the owner is told
/// once (also after a hub restart finds it again) with the fix and the accept command, and
/// `lead accept-model` lets the same conversation go on.
#[test]
fn a_lead_whose_bridge_never_connects_is_bound_fenced_and_told_once() {
    let mut w = wrapped("", None);
    w.hub.fixture("omp", "no-bridge", Some(""));
    w.hub.start();
    let bound = |hub: &TestHub| {
        hub.until(Duration::from_secs(90), || {
            let v = lead_view(hub);
            (v["phase"] == "live" && v["session"]["pid"].is_u64()).then_some(v)
        })
    };
    let fenced = bound(&w.hub);
    assert_eq!(fenced["session"]["input_blocked"], true, "{fenced}");
    let reason = fenced["session"]["reason"].as_str().unwrap_or_default();
    assert!(
        reason.starts_with("model unverified") && reason.contains("didn't connect"),
        "{fenced}"
    );
    assert_eq!(w.starts("fresh").len(), 1, "never retried");
    let notices = w.hub.until(Duration::from_secs(10), || {
        let n = told(&w.hub, "lead.held");
        (!n.is_empty()).then_some(n)
    });
    let text = notices[0]["text"].as_str().unwrap();
    for part in ["`cataly update`", "`cataly lead accept-model`"] {
        assert!(text.contains(part), "{part}: {text}");
    }
    let file = fenced["session"]["session_file"].clone();
    assert!(
        w.hub
            .cli(&["lead", "send", "AFTER-ACCEPT"])
            .status
            .success()
    );
    assert_eq!(user_entries(&file, "AFTER-ACCEPT"), 0);
    let accepted = w.hub.cli(&["lead", "accept-model"]);
    assert!(accepted.status.success(), "{accepted:?}");
    w.hub.until(Duration::from_secs(10), || {
        (user_entries(&file, "AFTER-ACCEPT") == 1).then_some(())
    });
    assert!(w.hub.stop().success());
    w.hub.start();
    let again = bound(&w.hub);
    assert_eq!(
        again["session"]["session_id"], fenced["session"]["session_id"],
        "{again}"
    );
    assert_eq!(again["session"]["input_blocked"], true, "{again}");
    std::thread::sleep(Duration::from_secs(2));
    assert_eq!(told(&w.hub, "lead.held").len(), 1, "told only once");
    assert!(w.hub.stop().success());
}

fn store(hub: &TestHub) -> rusqlite::Connection {
    let db = rusqlite::Connection::open(hub.state().join("cataly.db")).unwrap();
    db.busy_timeout(Duration::from_secs(10)).unwrap();
    db
}

fn now_ms() -> i64 {
    i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap()
}

/// The lead's episode for `session` as an earlier start left it: `state`, begun two hours ago with
/// its 300 s window, no retry spent. Returns when it began.
fn left_episode(db: &rusqlite::Connection, session: &Value, state: &str) -> i64 {
    let began = now_ms() - 7_200_000;
    db.execute(
        "INSERT INTO startup_episodes(target, session_id, started_ms, deadline_ms, state) \
         VALUES ('lead', ?1, ?2, ?2 + 300000, ?3) ON CONFLICT(target) DO UPDATE SET \
         session_id = excluded.session_id, state = excluded.state, started_ms = excluded.started_ms, \
         deadline_ms = excluded.deadline_ms, retries = 0, next_ms = NULL, detail = NULL",
        rusqlite::params![session.as_str().unwrap(), began, state],
    )
    .unwrap();
    began
}

fn lead_episode(db: &rusqlite::Connection) -> (String, i64) {
    db.query_row(
        "SELECT state, started_ms FROM startup_episodes WHERE target = 'lead'",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .unwrap()
}

/// The owner's 0.2.8 morning: an upgrade's start left the lead's episode active and the hub held
/// the lead at start; the hold was lifted without an owner start (as migration 0013 does), and the
/// lead slept on its conversation. Long after that episode's window an owner message wakes it: the
/// wake begins a fresh episode, resumes the same conversation and delivers the message.
#[test]
fn a_wake_after_a_lifted_hold_begins_a_fresh_episode_and_delivers() {
    let mut hub = sleepy_hub(&[], "2s", "", "");
    hub.start();
    let first = live(&hub, &Value::Null);
    let (session, file) = (
        first["session"]["session_id"].clone(),
        first["session"]["session_file"].clone(),
    );
    asleep(&hub);
    assert!(hub.stop().success());
    let db = store(&hub);
    db.execute(
        "UPDATE lead_anchor SET hold = 'ambiguous lead binding history'",
        [],
    )
    .unwrap();
    let old = left_episode(&db, &session, "active");
    hub.start();
    held(&hub, 20);
    assert!(hub.stop().success());
    db.execute("UPDATE lead_anchor SET hold = NULL", [])
        .unwrap();
    hub.start();
    asleep(&hub);
    assert_eq!(lead_episode(&db), ("active".into(), old), "not read yet");

    assert!(
        hub.cli(&["lead", "send", "WAKE-AFTER-HOLD"])
            .status
            .success()
    );
    let woke = live(&hub, &first["session"]["pid"]);
    assert_eq!(woke["session"]["session_id"], session, "{woke}");
    assert_eq!(woke["session"]["session_file"], file, "{woke}");
    hub.until(Duration::from_secs(20), || {
        (user_entries(&file, "WAKE-AFTER-HOLD") == 1).then_some(())
    });
    let (state, began) = lead_episode(&db);
    assert_eq!(state, "bound");
    assert!(began > old, "a fresh episode");
    assert!(hub.stop().success());
}

/// An episode that ended long ago is nobody's recovery: a crash exit of the bound lead retries
/// normally, whether that episode ended bound or an older start left it active past its window.
#[test]
fn a_crash_exit_long_after_the_episode_ended_retries_normally() {
    for ended in ["bound", "active"] {
        let mut w = wrapped("", None);
        w.hub.start();
        let first = live(&w.hub, &Value::Null);
        let db = store(&w.hub);
        let old = left_episode(&db, &first["session"]["session_id"], ended);
        kill(&first["session"]["pid"]);
        let again = w.hub.until(Duration::from_secs(20), || {
            let v = lead_view(&w.hub);
            assert_ne!(v["phase"], "held", "{ended}: {v}");
            let pid = &v["session"]["pid"];
            (v["phase"] == "live" && pid.is_u64() && pid != &first["session"]["pid"]).then_some(v)
        });
        assert_eq!(
            again["session"]["session_id"], first["session"]["session_id"],
            "{ended}: {again}"
        );
        let (state, began) = lead_episode(&db);
        assert_eq!(state, "bound", "{ended}");
        assert!(began > old, "{ended}: a fresh episode");
        assert!(w.hub.stop().success());
        w.no_orphans();
    }
}
