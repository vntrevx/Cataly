//! Milestone 3b acceptance checks 1-6 through the real hub with the fake OMP, the fake `gh` and,
//! for the board post, the fake Discord.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use support::TestHub;
use support::discord::{FakeDiscord, Seen};

const WAIT: Duration = Duration::from_secs(40);
const HEAD: &str = "1111111111111111111111111111111111111111";
const OWNER: &str = "400000000000000001";

/// A hub with the fake OMP, the fake `gh` on PATH and lane settings; `extra` adds config lines.
fn coord_hub(extra: &str) -> (TestHub, PathBuf) {
    let mut hub = TestHub::new("");
    let omp = hub.install_fake("omp");
    hub.install_fake("gh");
    for f in ["rpc", "turns"] {
        hub.fixture("omp", f, Some(""));
    }
    let bin = hub.root.join("bin");
    let mut path = bin.into_os_string();
    path.push(":");
    path.push(support::path_without_omp());
    hub.env.push(("PATH".into(), PathBuf::from(path)));
    let work = hub.root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    hub.write_config(&format!(
        "[omp]\npath = \"{}\"\n[lanes]\nmodel = \"fake/primary\"\ncwd = \"{}\"\nobjection = \"2s\"\n{extra}",
        omp.display(),
        work.display()
    ));
    (hub, work)
}

fn start(hub: &mut TestHub) -> Instant {
    let at = Instant::now();
    hub.start();
    hub.until(WAIT, || {
        hub.json(&["status", "--json"])["omp"]
            .is_object()
            .then_some(())
    });
    at
}

fn lane(hub: &TestHub, op: &str, params: &Value) -> Result<Value, String> {
    let out = hub.cli(&["lane", op, "--json", "--params", &params.to_string()]);
    if out.status.success() {
        Ok(serde_json::from_slice(&out.stdout).unwrap())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
}

fn open_params(key: &str) -> Value {
    json!({
        "key": key,
        "title": format!("Work {key}"),
        "brief": "Do the work.",
        "checks": [{ "kind": "command", "argv": ["true"] }],
    })
}

fn record(hub: &TestHub, key: &str) -> Value {
    lane(hub, "list", &json!({ "all": true }))
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["key"] == key)
        .cloned()
        .unwrap_or(Value::Null)
}

fn slot(hub: &TestHub, args: &[&str]) -> Child {
    let mut all = vec!["slot"];
    all.extend_from_slice(args);
    hub.command(&all)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

fn order(file: &std::path::Path) -> Vec<String> {
    std::fs::read_to_string(file)
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .collect()
}

/// Check 1: priority then arrival, the exit status passes through, the slot stays held until both
/// client and command exited, and nothing is granted for 5 s after the hub starts.
#[test]
fn slots_order_hold_and_restart_grace() {
    let (mut hub, work) = coord_hub("[coord.slots]\nload = 10000\n");
    let file = work.join("order");
    let started = start(&mut hub);
    let log = |tag: &str, tail: &str| format!("echo {tag} >> {}; {tail}", file.display());
    let first = format!("echo A >> {f}; sleep 2; echo A2 >> {f}", f = file.display());
    let mut a = slot(&hub, &["build", "--", "sh", "-c", &first]);
    hub.until(WAIT, || order(&file).first().cloned().filter(|l| l == "A"));
    assert!(
        started.elapsed() >= Duration::from_millis(4500),
        "granted inside the grace"
    );
    let mut b = slot(
        &hub,
        &[
            "build",
            "--priority",
            "5",
            "--",
            "sh",
            "-c",
            &log("B", "true"),
        ],
    );
    std::thread::sleep(Duration::from_millis(300));
    let mut c = slot(
        &hub,
        &[
            "build",
            "--priority",
            "2",
            "--",
            "sh",
            "-c",
            &log("C", "true"),
        ],
    );
    std::thread::sleep(Duration::from_millis(300));
    let mut d = slot(
        &hub,
        &[
            "build",
            "--priority",
            "2",
            "--",
            "sh",
            "-c",
            &log("D", "exit 7"),
        ],
    );
    std::thread::sleep(Duration::from_millis(300));
    let view = lane(&hub, "slots", &json!({})).unwrap();
    assert_eq!(
        view["slots"][0]["queue"].as_array().unwrap().len(),
        3,
        "{view}"
    );
    // Killing the client does not free the slot while its command runs.
    a.kill().unwrap();
    let _ = a.wait();
    assert!(b.wait().unwrap().success());
    assert!(c.wait().unwrap().success());
    assert_eq!(d.wait().unwrap().code(), Some(7));
    assert_eq!(order(&file), ["A", "A2", "C", "D", "B"]);
    let unknown = hub.cli(&["slot", "bad name", "--", "true"]);
    assert_eq!(unknown.status.code(), Some(1));
    assert!(hub.stop().success());
}

/// Check 2: a queued launch is ready only when every predecessor closed completed with passing
/// checks, and the hub never starts it by itself.
#[test]
fn queued_launch_waits_for_completed_predecessors() {
    let (mut hub, _) = coord_hub("");
    start(&mut hub);
    lane(&hub, "open", &open_params("pre-1")).unwrap();
    let mut queued = open_params("next-1");
    queued["after"] = json!(["pre-1"]);
    assert_eq!(lane(&hub, "open", &queued).unwrap()["outcome"], "queued");
    let mut cycle = open_params("pre-1");
    cycle["after"] = json!(["next-1"]);
    assert!(lane(&hub, "open", &cycle).is_err());
    assert!(
        lane(&hub, "open", &open_params("next-1"))
            .unwrap_err()
            .contains("reserved")
    );
    assert!(
        lane(&hub, "start", &json!({ "key": "next-1" }))
            .unwrap_err()
            .contains("not ready")
    );
    lane(
        &hub,
        "claim",
        &json!({ "key": "pre-1", "evidence": "done" }),
    )
    .unwrap();
    hub.until(WAIT, || {
        (record(&hub, "pre-1")["state"] == "closed").then_some(())
    });
    hub.until(WAIT, || {
        hub.events()
            .iter()
            .any(|e| {
                e["kind"] == "lane.queued" && e["text"].as_str().unwrap_or("").contains("ready")
            })
            .then_some(())
    });
    // Ready, told once, and still not started by the hub.
    std::thread::sleep(Duration::from_secs(2));
    assert_eq!(record(&hub, "next-1"), Value::Null);
    let q = lane(&hub, "queued", &json!({})).unwrap();
    assert_eq!(q["queued"][0]["ready"], true, "{q}");
    let started = lane(&hub, "start", &json!({ "key": "next-1" })).unwrap();
    assert_eq!(started["outcome"], "started", "{started}");
    assert!(lane(&hub, "cancel", &json!({ "key": "next-1" })).is_err());
    assert!(hub.stop().success());
}

fn plan(hub: &TestHub) -> String {
    lane(hub, "plan", &json!({}))
        .unwrap()
        .as_str()
        .unwrap()
        .to_string()
}

/// Check 3: the lane maximum and the per-run limit bound starts, two failed starts make a question,
/// and a claim with a merged PR makes an item done.
#[test]
fn planner_limits_questions_and_merged_items() {
    let (mut hub, work) =
        coord_hub("objection = \"1h\"\n[coord.planner]\nmax_open = 2\nmax_starts = 2\n");
    let text = std::fs::read_to_string(hub.config_path()).unwrap();
    hub.write_config(&text.replace("objection = \"2s\"\n", "").replace(
        "[coord.planner]",
        &format!(
            "[lead]\nmodel = \"fake/primary\"\ncwd = \"{}\"\n[coord.planner]",
            work.display()
        ),
    ));
    start(&mut hub);
    let gone = work.join("gone");
    std::fs::create_dir_all(&gone).unwrap();
    for (id, p) in [("it-a", 1), ("it-b", 2), ("it-c", 3)] {
        let mut add = json!({ "id": id, "brief": "b", "priority": p, "checks": [{ "kind": "command", "argv": ["true"] }] });
        if id == "it-c" {
            add["cwd"] = json!(gone.display().to_string());
        }
        lane(&hub, "item-add", &add).unwrap();
    }
    // The lead must be live before anything starts.
    let first = hub.until(WAIT, || {
        let s = plan(&hub);
        (!s.contains("no lead")).then_some(s)
    });
    assert!(
        first.contains("started: it-a") && first.contains("it-b"),
        "{first}"
    );
    let second = plan(&hub);
    assert!(
        second.contains("held back") && !second.contains("started:"),
        "{second}"
    );
    // A claim whose evidence links a merged PR makes the item done.
    hub.fixture(
        "gh",
        "repos_o_r_pulls_5.json",
        Some(&json!({ "merged": true }).to_string()),
    );
    lane(
        &hub,
        "claim",
        &json!({ "key": "it-a", "evidence": "https://github.com/o/r/pull/5" }),
    )
    .unwrap();
    let third = plan(&hub);
    assert!(third.contains("it-a done (o/r#5 merged"), "{third}");
    // Two failed starts of it-c turn it into a question (its directory is gone).
    // A file where its directory was: the open refuses it, admission still samples the disk.
    std::fs::remove_dir(&gone).unwrap();
    std::fs::write(&gone, "").unwrap();
    lane(&hub, "close", &json!({ "key": "it-b", "note": "stop" })).ok();
    hub.until(WAIT, || {
        (record(&hub, "it-b")["state"] == "closed").then_some(())
    });
    let _ = plan(&hub);
    let fourth = plan(&hub);
    let items = lane(&hub, "items", &json!({})).unwrap();
    let c = items["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["id"] == "it-c")
        .unwrap()
        .clone();
    assert!(
        c["question"]
            .as_str()
            .unwrap_or("")
            .contains("failed to start twice"),
        "{fourth}\n{c}"
    );
    assert!(hub.stop().success());
}

/// COORD req. 37: a done item's id added again starts under a fresh lane key, not as a refused
/// open of its closed lane.
#[test]
fn planner_restarts_a_reused_item_id() {
    let (mut hub, work) = coord_hub("[coord.planner]\nmax_open = 2\nmax_starts = 2\n");
    let text = std::fs::read_to_string(hub.config_path()).unwrap();
    hub.write_config(&text.replace(
        "[coord.planner]",
        &format!(
            "[lead]\nmodel = \"fake/primary\"\ncwd = \"{}\"\n[coord.planner]",
            work.display()
        ),
    ));
    start(&mut hub);
    let add =
        json!({ "id": "it-x", "brief": "b", "checks": [{ "kind": "command", "argv": ["true"] }] });
    lane(&hub, "item-add", &add).unwrap();
    let first = hub.until(WAIT, || {
        let s = plan(&hub);
        (!s.contains("no lead")).then_some(s)
    });
    assert!(first.contains("started: it-x"), "{first}");
    lane(&hub, "close", &json!({ "key": "it-x", "note": "stop" })).unwrap();
    hub.until(WAIT, || {
        (record(&hub, "it-x")["state"] == "closed").then_some(())
    });
    let done = plan(&hub);
    assert!(done.contains("it-x done (lane closed)"), "{done}");
    lane(&hub, "item-add", &add).unwrap();
    let again = plan(&hub);
    assert!(again.contains("started: it-x"), "{again}");
    let items = lane(&hub, "items", &json!({})).unwrap();
    let x = items["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["id"] == "it-x")
        .unwrap()
        .clone();
    assert_eq!(x["status"], "running", "{x}");
    assert_eq!(x["start_failures"], 0, "{x}");
    assert_eq!(x["question"], Value::Null, "{x}");
    assert_eq!(x["lane"], "it-x-2", "{x}");
    assert_eq!(record(&hub, "it-x-2")["state"], "running", "{x}");
    // Done by a merged PR while lane it-x-2 stays open: added again, it waits for that lane.
    hub.fixture(
        "gh",
        "repos_o_r_pulls_5.json",
        Some(&json!({ "merged": true }).to_string()),
    );
    lane(
        &hub,
        "claim",
        &json!({ "key": "it-x-2", "evidence": "https://github.com/o/r/pull/5" }),
    )
    .unwrap();
    let merged = plan(&hub);
    assert!(merged.contains("it-x done (o/r#5 merged"), "{merged}");
    lane(&hub, "item-add", &add).unwrap();
    let held = plan(&hub);
    assert!(!held.contains("started:"), "{held}");
    assert_eq!(record(&hub, "it-x-3"), Value::Null, "{held}");
    assert!(hub.stop().success());
}

/// A reused item's next allocation fails before spawn. When requested, a database refusal keeps
/// the failed lane; otherwise the unused allocation rolls back. Arm the trigger with the hub stopped.
fn planner_failed_start(retain_lane: bool) -> TestHub {
    let (mut hub, work) = coord_hub("[coord.planner]\nmax_open = 2\nmax_starts = 2\n");
    let text = std::fs::read_to_string(hub.config_path()).unwrap();
    hub.write_config(&text.replace(
        "[coord.planner]",
        &format!(
            "[lead]\nmodel = \"fake/primary\"\ncwd = \"{}\"\n[coord.planner]",
            work.display()
        ),
    ));
    start(&mut hub);
    let add = json!({ "id": "it-fail", "brief": "b", "checks": [{ "kind": "command", "argv": ["true"] }] });
    lane(&hub, "item-add", &add).unwrap();
    let first = hub.until(WAIT, || {
        let s = plan(&hub);
        (!s.contains("no lead")).then_some(s)
    });
    assert!(first.contains("started: it-fail"), "{first}");
    lane(&hub, "close", &json!({ "key": "it-fail", "note": "stop" })).unwrap();
    hub.until(WAIT, || {
        (record(&hub, "it-fail")["state"] == "closed").then_some(())
    });
    let done = plan(&hub);
    assert!(done.contains("it-fail done (lane closed)"), "{done}");
    lane(&hub, "item-add", &add).unwrap();
    assert!(hub.stop().success());
    if retain_lane {
        let db = rusqlite::Connection::open(hub.state().join("cataly.db")).unwrap();
        db.execute_batch(
            "CREATE TRIGGER keep_failed_planner_lane BEFORE DELETE ON lanes
             WHEN OLD.key = 'it-fail-2'
             BEGIN SELECT RAISE(FAIL, 'keep failed planner lane'); END;",
        )
        .unwrap();
    }
    let blocked = hub.state().join("sessions/lanes/it-fail-2");
    std::fs::write(&blocked, "not a directory").unwrap();
    start(&mut hub);
    hub.until(WAIT, || {
        let s = plan(&hub);
        (!s.contains("no lead")).then_some(())
    });
    let items = lane(&hub, "items", &json!({})).unwrap();
    let item = &items["items"][0];
    assert_eq!(item["status"], "open", "{item}");
    assert_eq!(item["start_failures"], 1, "{item}");
    assert_eq!(item["question"], Value::Null, "{item}");
    assert_eq!(item["lane"], "it-fail-2", "{item}");
    std::fs::remove_file(blocked).unwrap();
    hub
}

#[test]
fn planner_failed_start_retains_its_lane_key() {
    let mut hub = planner_failed_start(true);
    let failed = record(&hub, "it-fail-2");
    assert_eq!(failed["state"], "held", "{failed}");
    assert!(
        failed["receipt"].to_string().contains("record retained:"),
        "{failed}"
    );
    let next = plan(&hub);
    assert!(!next.contains("started:"), "{next}");
    assert_eq!(record(&hub, "it-fail-3"), Value::Null, "{next}");
    let items = lane(&hub, "items", &json!({})).unwrap();
    let item = &items["items"][0];
    assert_eq!(item["status"], "open", "{item}");
    assert_eq!(item["start_failures"], 1, "{item}");
    assert_eq!(item["question"], Value::Null, "{item}");
    assert_eq!(item["lane"], "it-fail-2", "{item}");
    assert!(hub.stop().success());
}

#[test]
fn planner_failed_start_reuses_rolled_back_key() {
    let mut hub = planner_failed_start(false);
    assert_eq!(record(&hub, "it-fail-2"), Value::Null);
    let next = plan(&hub);
    assert!(next.contains("started: it-fail"), "{next}");
    assert_eq!(record(&hub, "it-fail-2")["state"], "running", "{next}");
    assert_eq!(record(&hub, "it-fail-3"), Value::Null, "{next}");
    let items = lane(&hub, "items", &json!({})).unwrap();
    let item = &items["items"][0];
    assert_eq!(item["status"], "running", "{item}");
    assert_eq!(item["start_failures"], 1, "{item}");
    assert_eq!(item["question"], Value::Null, "{item}");
    assert_eq!(item["lane"], "it-fail-2", "{item}");
    assert!(hub.stop().success());
}

/// Check 4: the merge check refuses without an approving verdict at the current head, with no
/// checks, or with a check neither passed nor skipped; a dry run stops before merging.
#[test]
fn merge_gate_refuses_then_dry_run_passes() {
    let (mut hub, _) =
        coord_hub("[coord.review]\ncommand = [\"/bin/echo\", \"VERDICT: approve\"]\n");
    start(&mut hub);
    let pr = json!({ "pr": "o/r#7", "dry_run": true });
    let fixture = |name: &str, v: Value| hub.fixture("gh", name, Some(&v.to_string()));
    fixture("repos_o_r_pulls_7.json", json!({ "head": { "sha": HEAD } }));
    assert!(
        lane(&hub, "merge", &pr)
            .unwrap_err()
            .contains("no review verdict")
    );
    assert!(
        lane(&hub, "review", &pr)
            .unwrap()
            .as_str()
            .unwrap()
            .contains("approve")
    );
    let runs = format!("repos_o_r_commits_{HEAD}_check-runs.json");
    fixture(&runs, json!({ "total_count": 0, "check_runs": [] }));
    assert!(lane(&hub, "merge", &pr).unwrap_err().contains("no checks"));
    fixture(
        &runs,
        json!({ "total_count": 3, "check_runs": [
        { "name": "test", "conclusion": "success" }, { "name": "lint", "conclusion": "failure" },
        { "name": "slow", "conclusion": null }] }),
    );
    let refused = lane(&hub, "merge", &pr).unwrap_err();
    assert!(
        refused.contains("lint (failure)") && refused.contains("slow (pending)"),
        "{refused}"
    );
    fixture(
        &runs,
        json!({ "total_count": 1, "check_runs": [{ "name": "docs", "conclusion": "skipped" }] }),
    );
    assert!(lane(&hub, "merge", &pr).unwrap_err().contains("skipped"));
    fixture(
        &runs,
        json!({ "total_count": 2, "check_runs": [
        { "name": "test", "conclusion": "success" }, { "name": "docs", "conclusion": "skipped" }] }),
    );
    assert!(
        lane(&hub, "merge", &pr)
            .unwrap()
            .as_str()
            .unwrap()
            .contains("dry run")
    );
    let calls = std::fs::read_to_string(hub.root.join("bin/gh-data/calls.log")).unwrap();
    assert!(!calls.contains("PUT"), "{calls}");
    fixture(
        "repos_o_r_pulls_7.json",
        json!({ "head": { "sha": "2".repeat(40) } }),
    );
    assert!(
        lane(&hub, "merge", &pr)
            .unwrap_err()
            .contains("no review verdict")
    );
    assert!(hub.stop().success());
}

/// The first page cannot hide a later failed check or an incomplete GitHub response.
#[test]
fn merge_gate_checks_later_pages_and_refuses_incomplete_results() {
    let (mut hub, _) =
        coord_hub("[coord.review]\ncommand = [\"/bin/echo\", \"VERDICT: approve\"]\n");
    start(&mut hub);
    let pr = json!({ "pr": "o/r#7", "dry_run": true });
    let fixture = |name: &str, v: Value| hub.fixture("gh", name, Some(&v.to_string()));
    fixture("repos_o_r_pulls_7.json", json!({ "head": { "sha": HEAD } }));
    lane(&hub, "review", &pr).unwrap();
    let runs = format!("repos_o_r_commits_{HEAD}_check-runs");
    let first = format!("{runs}.json");
    let second = format!("{runs}.page-2.json");
    let successes: Vec<Value> = (0..100)
        .map(|n| json!({ "name": format!("test-{n}"), "conclusion": "success" }))
        .collect();
    let last = json!({ "name": "last-check", "conclusion": "success" });
    fixture(
        &first,
        json!({ "total_count": 101, "check_runs": successes }),
    );
    fixture(
        &second,
        json!({ "total_count": 101, "check_runs": [
            { "name": "late-failure", "conclusion": "failure" }
        ] }),
    );
    for dry in [true, false] {
        let refused = lane(&hub, "merge", &json!({ "pr": "o/r#7", "dry_run": dry })).unwrap_err();
        assert!(refused.contains("late-failure (failure)"), "{refused}");
    }
    for incomplete in [
        json!({ "total_count": 101, "check_runs": [] }),
        json!({ "total_count": 102, "check_runs": [last] }),
        json!({ "total_count": 101, "check_runs": [last, last] }),
        json!({ "check_runs": [last] }),
        json!({ "total_count": 101 }),
        json!([]),
    ] {
        fixture(&second, incomplete);
        let refused = lane(&hub, "merge", &pr).unwrap_err();
        assert!(refused.contains("incomplete checks"), "{refused}");
    }
    fixture(&second, json!({ "total_count": 101, "check_runs": [last] }));
    assert!(
        lane(&hub, "merge", &pr)
            .unwrap()
            .as_str()
            .unwrap()
            .contains("dry run")
    );
    // A short first page is incomplete, even if all its checks passed.
    fixture(&first, json!({ "total_count": 101, "check_runs": [last] }));
    assert!(
        lane(&hub, "merge", &pr)
            .unwrap_err()
            .contains("received 1 of 101")
    );
    // An exact full page needs no empty page beyond the reported total.
    fixture(
        &first,
        json!({ "total_count": 100, "check_runs": successes }),
    );
    assert!(
        lane(&hub, "merge", &pr)
            .unwrap()
            .as_str()
            .unwrap()
            .contains("dry run")
    );
    // More than the bounded 30 pages must refuse, not silently use the rows read so far.
    fixture(
        &first,
        json!({ "total_count": 3001, "check_runs": successes }),
    );
    for page in 2..=30 {
        fixture(
            &format!("{runs}.page-{page}.json"),
            json!({ "total_count": 3001, "check_runs": successes }),
        );
    }
    let refused = lane(&hub, "merge", &pr).unwrap_err();
    assert!(refused.contains("more than 3000 rows"), "{refused}");
    let calls = std::fs::read_to_string(hub.root.join("bin/gh-data/calls.log")).unwrap();
    assert!(calls.contains("per_page=100&page=2"), "{calls}");
    assert!(!calls.contains("page=31"), "{calls}");
    assert!(!calls.contains("PUT"), "{calls}");
    assert!(hub.stop().success());
}

/// Check 5: the profile check fails on a lost decision, a future date or a token-shaped string;
/// revert saves a backup.
#[test]
fn profile_check_and_revert() {
    let (mut hub, _) = coord_hub("");
    start(&mut hub);
    assert!(
        lane(&hub, "profile-check", &json!({})).is_err(),
        "off until created"
    );
    lane(&hub, "profile-create", &json!({})).unwrap();
    assert!(lane(&hub, "profile-create", &json!({})).is_err());
    let today = jiff_today(&hub);
    let notes = |decision: &str, topic_date: &str| {
        format!(
            "# Owner notes\n\n## Likes and working style\n\n## Current topics\n- ({topic_date}) the release\n\n\
             ## Standing decisions\n{decision}\n## Dislikes\n\n## Change log\n"
        )
    };
    let file = hub.state().join("profile.md");
    let dir = hub.state().join("files/profile");
    let write = |path: &std::path::Path, text: &str| {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
        std::fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o600))
            .unwrap();
    };
    for d in [dir.parent().unwrap(), dir.as_path()] {
        std::fs::create_dir_all(d).unwrap();
        std::fs::set_permissions(d, std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
    }
    write(
        &dir.join(format!("{today}.md")),
        &notes(&format!("- ({today}) ship on Fridays\n"), &today),
    );
    write(
        &file,
        &notes(&format!("- ({today}) ship on Fridays\n"), &today),
    );
    assert_eq!(
        lane(&hub, "profile-check", &json!({})).unwrap(),
        "the check passes"
    );
    write(&file, &notes("", &today));
    assert!(
        lane(&hub, "profile-check", &json!({}))
            .unwrap_err()
            .contains("decision lost")
    );
    write(
        &file,
        &notes(&format!("- ({today}) ship on Fridays\n"), "2999-01-01"),
    );
    assert!(
        lane(&hub, "profile-check", &json!({}))
            .unwrap_err()
            .contains("future date")
    );
    let token = format!(
        "- ({today}) ship on Fridays\n- ({today}) key ghp_{}\n",
        "a1".repeat(18)
    );
    write(&file, &notes(&token, &today));
    assert!(
        lane(&hub, "profile-check", &json!({}))
            .unwrap_err()
            .contains("GitHub token")
    );
    let reverted = lane(&hub, "profile-revert", &json!({ "name": today })).unwrap();
    assert!(reverted.as_str().unwrap().contains("backup-"), "{reverted}");
    assert_eq!(
        lane(&hub, "profile-check", &json!({})).unwrap(),
        "the check passes"
    );
    let list = lane(&hub, "profile-list", &json!({})).unwrap();
    assert!(list.to_string().contains("backup-"), "{list}");
    assert!(hub.stop().success());
}

const INTAKE: &str = "600000000000000001";
const BOARD_A: &str = "600000000000000101";
const BOARD_B: &str = "600000000000000102";
/// Discord REST attempts per call (`Policy::RELAY`).
const TRIES: usize = 4;

/// The creates and edits of messages in one channel.
fn board_calls(fake: &FakeDiscord, channel: &str) -> (Vec<Seen>, Vec<Seen>) {
    let path = format!("/channels/{channel}/messages");
    (fake.calls("POST", &path), fake.calls("PATCH", &path))
}

/// Check 6: a board post is created once, edited on change at most once a minute (changes inside
/// the minute are folded into one edit), and never recreated after an uncertain create, also not
/// after a hub restart; once the lead names the message it found, the next pass edits that one.
#[test]
fn board_post_created_once_edited_by_the_minute_never_recreated() {
    let fake = FakeDiscord::start();
    let (mut hub, _work) = coord_hub(&format!(
        "[coord]\nboard = [\"discord:{BOARD_A}\", \"discord:{BOARD_B}\"]\n"
    ));
    let token = hub.private_file("token", "fake-token");
    for ch in [INTAKE, BOARD_A, BOARD_B] {
        fake.channel(ch, 0, None);
    }
    // Every attempt of the create in B takes effect, but each answer is a 500: after the relay's
    // four attempts (one message, thanks to the enforced nonce) the hub cannot know.
    fake.script_in(BOARD_B, &[500; TRIES]);
    let config = std::fs::read_to_string(hub.config_path()).unwrap();
    hub.write_config(&format!(
        "{config}{}",
        fake.config(&token, OWNER, &[INTAKE])
    ));
    start(&mut hub);
    fake.wait(WAIT, |f| {
        (!f.bot_messages(BOARD_A).is_empty()).then_some(())
    });
    let created = Instant::now();
    fake.wait(WAIT, |f| {
        (board_calls(f, BOARD_B).0.len() == TRIES).then_some(())
    });
    let first = fake.bot_messages(BOARD_A);
    assert!(
        first[0]["content"]
            .as_str()
            .unwrap()
            .starts_with("0 lane(s)"),
        "{first:?}"
    );

    lane(&hub, "open", &open_params("b-1")).unwrap();
    hub.until(WAIT, || {
        (record(&hub, "b-1")["state"] == "running").then_some(())
    });
    std::thread::sleep(Duration::from_secs(3));
    assert!(
        board_calls(&fake, BOARD_A).1.is_empty(),
        "edited inside the minute"
    );
    lane(&hub, "open", &open_params("b-2")).unwrap();
    let edit = fake.wait(Duration::from_secs(90), |f| {
        board_calls(f, BOARD_A).1.into_iter().next()
    });
    let waited = created.elapsed();
    assert!(waited >= Duration::from_secs(59), "edited after {waited:?}");
    let text = edit.body["content"].as_str().unwrap();
    assert!(
        text.starts_with("2 lane(s)") && text.contains("b-1") && text.contains("b-2"),
        "both changes in one edit: {text}"
    );
    assert!(edit.path.ends_with(first[0]["id"].as_str().unwrap()));
    std::thread::sleep(Duration::from_secs(3));
    let (creates_a, edits_a) = board_calls(&fake, BOARD_A);
    assert_eq!((creates_a.len(), edits_a.len()), (1, 1));
    let (creates_b, edits_b) = board_calls(&fake, BOARD_B);
    assert_eq!(
        (
            creates_b.len(),
            edits_b.len(),
            fake.bot_messages(BOARD_B).len()
        ),
        (TRIES, 0, 1),
        "in doubt: neither recreated nor edited"
    );

    // The doubt and the message survive a restart: no create anywhere afterwards.
    assert!(hub.stop().success());
    start(&mut hub);
    lane(&hub, "open", &open_params("b-3")).unwrap();
    hub.until(WAIT, || {
        (record(&hub, "b-3")["state"] == "running").then_some(())
    });
    std::thread::sleep(Duration::from_secs(3));
    assert_eq!(board_calls(&fake, BOARD_A).0.len(), 1);
    assert_eq!(board_calls(&fake, BOARD_B).0.len(), TRIES);
    assert!(board_calls(&fake, BOARD_B).1.is_empty());
    found_message_takes_the_edits(&hub, &fake);
    assert!(hub.stop().success());
}

/// The lead found the uncertain create's message in B: the next pass edits it, nothing is created.
fn found_message_takes_the_edits(hub: &TestHub, fake: &FakeDiscord) {
    let found = fake.bot_messages(BOARD_B)[0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let wrong = lane(
        hub,
        "board-found",
        &json!({ "destination": format!("discord:{BOARD_A}"), "message": found }),
    );
    assert!(wrong.unwrap_err().contains("not in doubt"));
    lane(
        hub,
        "board-found",
        &json!({ "destination": format!("discord:{BOARD_B}"), "message": found }),
    )
    .unwrap();
    let edit = fake.wait(WAIT, |f| board_calls(f, BOARD_B).1.into_iter().next());
    assert!(edit.path.ends_with(&found));
    assert!(
        edit.body["content"]
            .as_str()
            .unwrap()
            .starts_with("3 lane(s)")
    );
    assert_eq!(board_calls(fake, BOARD_B).0.len(), TRIES);
}

fn pr_policy_fixture(hub: &TestHub, suffix: &str, value: &Value) {
    hub.fixture(
        "gh",
        &format!("repos_o_r_pulls_7{suffix}.json"),
        Some(&value.to_string()),
    );
}

fn pr_policy_counts(hub: &TestHub, commits: usize, files: usize) {
    pr_policy_fixture(
        hub,
        "",
        &json!({ "head": { "sha": HEAD }, "body": "", "commits": commits, "changed_files": files }),
    );
}

fn pr_policy_hub(commits: usize, files: usize) -> (TestHub, Value) {
    let (mut hub, _) = coord_hub("[lanes.identities]\n\"o/r\" = \"owner@example.com\"\n");
    // The lane's empty working directory is not a checkout, even on hosts without git.
    let git = hub.root.join("bin/git");
    std::fs::write(&git, "#!/bin/sh\nexit 128\n").unwrap();
    std::fs::set_permissions(&git, std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
    let commit = json!({ "commit": {
        "author": { "email": "owner@example.com" },
        "committer": { "email": "owner@example.com" },
        "message": "fix: handle the edge case"
    }, "parents": [{ "sha": HEAD }] });
    pr_policy_counts(&hub, commits, files);
    pr_policy_fixture(&hub, "_commits", &json!([commit]));
    pr_policy_fixture(&hub, "_files", &json!([{ "filename": "README.md" }]));
    start(&mut hub);
    let mut params = open_params("policy");
    params["checks"] = json!([{ "kind": "pr_policy", "repo": "o/r", "number": 7 }]);
    lane(&hub, "open", &params).unwrap();
    hub.until(WAIT, || {
        (record(&hub, "policy")["state"] == "running").then_some(())
    });
    (hub, commit)
}

/// EVR req. 58: a bad author or committer on page two cannot hide behind the first 100 commits.
#[test]
fn pr_policy_checks_later_commits() {
    let (mut hub, commit) = pr_policy_hub(101, 1);
    pr_policy_fixture(&hub, "_commits", &json!(vec![commit.clone(); 100]));
    for who in ["author", "committer"] {
        let mut bad = commit.clone();
        bad["commit"][who]["email"] = json!("other@example.com");
        pr_policy_fixture(&hub, "_commits.page-2", &json!([bad]));
        let refused = lane(&hub, "close", &json!({ "key": "policy" })).unwrap_err();
        assert!(
            refused.contains("identity is not the configured one"),
            "{refused}"
        );
    }
    pr_policy_fixture(&hub, "_commits.page-2", &json!([commit]));
    lane(&hub, "close", &json!({ "key": "policy" })).unwrap();
    assert_eq!(record(&hub, "policy")["state"], "closed");
    assert!(hub.stop().success());
}

/// EVR req. 58: source and test files on later pages both participate in the policy decision.
#[test]
fn pr_policy_checks_later_files() {
    let (mut hub, _) = pr_policy_hub(1, 101);
    let docs: Vec<Value> = (0..100)
        .map(|n| json!({ "filename": format!("docs/{n}.md") }))
        .collect();
    pr_policy_fixture(&hub, "_files", &json!(docs));
    pr_policy_fixture(
        &hub,
        "_files.page-2",
        &json!([{ "filename": "src/fix.rs" }]),
    );
    let refused = lane(&hub, "close", &json!({ "key": "policy" })).unwrap_err();
    assert!(
        refused.contains("without a test or a no-test reason"),
        "{refused}"
    );
    pr_policy_counts(&hub, 1, 102);
    pr_policy_fixture(
        &hub,
        "_files.page-2",
        &json!([
            { "filename": "src/fix.rs" }, { "filename": "tests/fix.rs" }
        ]),
    );
    lane(&hub, "close", &json!({ "key": "policy" })).unwrap();
    assert_eq!(record(&hub, "policy")["state"], "closed");
    assert!(hub.stop().success());
}

/// Truncated/malformed lists fail closed; exactly 3000 files are allowed, but 3001 are not.
#[test]
fn pr_policy_requires_complete_lists_and_enforces_file_limit() {
    let (mut hub, commit) = pr_policy_hub(1, 101);
    let docs: Vec<Value> = (0..100)
        .map(|n| json!({ "filename": format!("docs/{n}.md") }))
        .collect();
    pr_policy_fixture(&hub, "_files", &json!(docs));
    let close = || lane(&hub, "close", &json!({ "key": "policy" }));
    let refused = close().unwrap_err();
    assert!(
        refused.contains("incomplete files: read 100, expected 101"),
        "{refused}"
    );
    pr_policy_fixture(&hub, "_files.page-2", &json!({}));
    let refused = close().unwrap_err();
    assert!(refused.contains("not a list"), "{refused}");

    pr_policy_counts(&hub, 101, 100);
    pr_policy_fixture(&hub, "_commits", &json!(vec![commit; 100]));
    let refused = close().unwrap_err();
    assert!(
        refused.contains("incomplete commits: read 100, expected 101"),
        "{refused}"
    );
    pr_policy_fixture(&hub, "_commits.page-2", &json!({}));
    let refused = close().unwrap_err();
    assert!(refused.contains("not a list"), "{refused}");

    for missing in ["commits", "changed_files"] {
        let mut pull =
            json!({ "head": { "sha": HEAD }, "body": "", "commits": 100, "changed_files": 100 });
        pull.as_object_mut().unwrap().remove(missing);
        pr_policy_fixture(&hub, "", &pull);
        let refused = close().unwrap_err();
        assert!(
            refused.contains(&format!("missing or invalid PR {missing} count")),
            "{refused}"
        );
    }
    pr_policy_counts(&hub, 100, 3001);
    let refused = close().unwrap_err();
    assert!(refused.contains("more than 3000 files"), "{refused}");

    pr_policy_counts(&hub, 100, 3000);
    for page in 1..=30 {
        let mut files: Vec<Value> = (0..100)
            .map(|n| json!({ "filename": format!("docs/{page}-{n}.md") }))
            .collect();
        if page == 2 {
            files[0] = json!({ "filename": "src/fix.rs" });
        }
        if page == 30 {
            files[99] = json!({ "filename": "tests/fix.rs" });
        }
        let suffix = if page == 1 {
            "_files".into()
        } else {
            format!("_files.page-{page}")
        };
        pr_policy_fixture(&hub, &suffix, &json!(files));
    }
    hub.fixture("gh", "calls.log", Some(""));
    close().unwrap();
    let calls = std::fs::read_to_string(hub.root.join("bin/gh-data/calls.log")).unwrap();
    assert!(calls.contains("files?per_page=100&page=30"), "{calls}");
    assert!(!calls.contains("files?per_page=100&page=31"), "{calls}");
    assert!(!calls.contains("commits?per_page=100&page=2"), "{calls}");
    assert_eq!(record(&hub, "policy")["state"], "closed");
    assert!(hub.stop().success());
}

/// Today's local date as the hub sees it (the snapshot name).
fn jiff_today(hub: &TestHub) -> String {
    let out = hub.command(&["status", "--json"]).output().unwrap();
    assert!(out.status.success());
    let date = std::process::Command::new("date")
        .arg("+%Y-%m-%d")
        .output()
        .unwrap();
    String::from_utf8_lossy(&date.stdout).trim().to_string()
}

/// The hub's resident memory in bytes.
fn rss(hub: &TestHub) -> u64 {
    hub.json(&["stats", "--json"])["rss_bytes"]
        .as_u64()
        .unwrap()
}

/// The hub's own durations of its stored planner runs (`duration_ms`), oldest first.
fn pass_durations(hub: &TestHub) -> Vec<i64> {
    let db = rusqlite::Connection::open_with_flags(
        hub.state().join("cataly.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let mut q = db
        .prepare("SELECT doc FROM coord WHERE kind = 'plan_run' ORDER BY id")
        .unwrap();
    q.query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .map(|d| {
            serde_json::from_str::<Value>(&d.unwrap()).unwrap()["duration_ms"]
                .as_i64()
                .unwrap()
        })
        .collect()
}

/// Measured (plan milestone 3b): one planner pass over 100 open items with no lead, and the hub's
/// RSS at each step: idle, with 100 items, after 5 passes, every 500 passes up to 6005 (far past the
/// 168 stored runs that are kept), with a held and a waiting slot, and after the slots ended. Growth
/// that levels off is the allocator's and SQLite's cache filling; growth with every pass would be
/// retained memory.
#[test]
#[ignore = "measurement; run with --ignored --nocapture"]
fn planner_pass_with_100_items_and_rss() {
    let (mut hub, work) = coord_hub("[coord.slots]\nload = 10000\n");
    start(&mut hub);
    let base = rss(&hub);
    for n in 0..100 {
        lane(&hub, "item-add", &json!({ "id": format!("m-{n}"), "brief": "b", "checks": [{ "kind": "command", "argv": ["true"] }] })).unwrap();
    }
    let items = rss(&hub);
    let mut runs = Vec::new();
    for _ in 0..5 {
        let at = Instant::now();
        let _ = plan(&hub);
        runs.push(at.elapsed());
    }
    let five = rss(&hub);
    let mut trend = Vec::new();
    // `CATALY_PLAN_ROUNDS` rounds of 500 passes (default 12); each round also prints the hub's
    // anonymous and file-backed resident memory and the store's file sizes.
    let rounds = std::env::var("CATALY_PLAN_ROUNDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(12);
    for round in 1..=rounds {
        for _ in 0..500 {
            let _ = plan(&hub);
        }
        trend.push(rss(&hub));
        let status = std::fs::read_to_string(format!("/proc/{}/status", hub.pid())).unwrap();
        let field = |name: &str| {
            status
                .lines()
                .find(|l| l.starts_with(name))
                .map_or_default(|l| l.split_whitespace().nth(1).unwrap_or("?").to_string())
        };
        let size = |f: &str| std::fs::metadata(hub.state().join(f)).map_or(0, |m| m.len());
        println!(
            "PLAN passes {}: rss {} kB, anon {} kB, file {} kB, database {} B, write-ahead log {} B",
            5 + round * 500,
            field("VmRSS:"),
            field("RssAnon:"),
            field("RssFile:"),
            size("cataly.db"),
            size("cataly.db-wal")
        );
    }
    let status = lane(&hub, "plan-status", &json!({})).unwrap();
    let mut durations = pass_durations(&hub);
    durations.sort_unstable();
    let mut held = slot(&hub, &["m", "--", "sleep", "5"]);
    let mut waiting = slot(&hub, &["m", "--", "true"]);
    std::thread::sleep(Duration::from_secs(2));
    let slots = rss(&hub);
    let _ = held.wait();
    let _ = waiting.wait();
    std::thread::sleep(Duration::from_secs(5));
    let after = rss(&hub);
    println!(
        "planner pass with 100 items, in the hub over the last {} runs: p50 {} ms, max {} ms; CLI round trip of the first five {runs:?}; {status}",
        durations.len(),
        durations[durations.len() / 2],
        durations[durations.len() - 1]
    );
    println!(
        "rss bytes: idle {base}, 100 items {items}, 5 passes {five}, every 500 passes after {trend:?}, slots active {slots}, slots ended {after}"
    );
    let size = |f: &str| std::fs::metadata(hub.state().join(f)).map_or(0, |m| m.len());
    println!(
        "store bytes: database {}, write-ahead log {}",
        size("cataly.db"),
        size("cataly.db-wal")
    );
    drop(work);
    assert!(hub.stop().success());
}
