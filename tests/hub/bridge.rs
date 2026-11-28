//! Role transitions on a real hub connection, with fake OMP sessions.

use std::io::{BufRead as _, BufReader, Write as _};
use std::os::unix::net::UnixStream;
use std::time::Duration;

use serde_json::{Value, json};

use super::support::TestHub;

struct Bridge {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
    next: u64,
}

impl Bridge {
    fn connect(hub: &TestHub, session: &Value, role: &str) -> Self {
        let writer = UnixStream::connect(hub.socket()).unwrap();
        writer
            .set_read_timeout(Some(Duration::from_secs(20)))
            .unwrap();
        let mut bridge = Self {
            reader: BufReader::new(writer.try_clone().unwrap()),
            writer,
            next: 0,
        };
        let answer = bridge.call(
            "bridge.hello",
            &json!({
                "ext": 1, "marker": true, "session": session["session_id"],
                "file": session["session_file"], "agent": "main",
            }),
        );
        assert_eq!(answer["ok"]["role"], role, "{answer}");
        bridge
    }

    fn call(&mut self, method: &str, params: &Value) -> Value {
        self.next += 1;
        writeln!(
            self.writer,
            "{}",
            json!({"v":1,"id":self.next,"method":method,"params":params})
        )
        .unwrap();
        loop {
            let mut line = String::new();
            assert!(
                self.reader.read_line(&mut line).unwrap() > 0,
                "bridge closed"
            );
            let reply: Value = serde_json::from_str(&line).unwrap();
            if reply["id"] == self.next {
                return reply;
            }
        }
    }

    fn switch(&mut self, session: &Value, reason: &str) -> Value {
        self.call(
            "bridge.switch",
            &json!({
                "session": session["session_id"], "file": session["session_file"], "reason": reason,
            }),
        )["ok"]
            .clone()
    }
}

fn lead_hub() -> (TestHub, Value) {
    let mut hub = TestHub::new("");
    let omp = hub.install_fake("omp");
    hub.fixture("omp", "rpc", Some(""));
    let work = hub.root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    hub.write_config(&format!(
        "[omp]\npath = \"{}\"\n[lead]\nmodel = \"fake/primary\"\ncwd = \"{}\"\n\
         [lanes]\nmodel = \"fake/primary\"\ncwd = \"{}\"\n",
        omp.display(),
        work.display(),
        work.display(),
    ));
    hub.start();
    let session = hub.until(Duration::from_secs(20), || {
        let status = hub.json(&["lead", "status", "--json"]);
        (status["phase"] == "live").then(|| status["session"].clone())
    });
    (hub, session)
}

fn open_lane(hub: &TestHub) -> Value {
    let params = json!({"key":"switch-lane","title":"Switch lane","brief":"Inspect only.",
        "look_only":true,"checks":[{"kind":"command","argv":["true"]}]})
    .to_string();
    hub.json(&["lane", "open", "--params", &params, "--json"]);
    hub.until(Duration::from_secs(20), || {
        let lanes = hub.json(&["lane", "list", "--json"]);
        lanes
            .as_array()
            .unwrap()
            .iter()
            .find(|lane| lane["session_id"].is_string())
            .cloned()
    })
}

#[test]
fn bridge_switch_keeps_branch_and_fork_roles() {
    let (mut hub, lead) = lead_hub();
    let lane = open_lane(&hub);
    let mut bridge = Bridge::connect(&hub, &lead, "lead");
    for (role, original) in [("lead", &lead), ("lane", &lane)] {
        assert_eq!(bridge.switch(original, "resume")["role"], role);
        for (reason, branch) in [
            ("session_branch", "rewind"),
            ("session_branch", "btw"),
            ("fork", "fork"),
        ] {
            let fresh = json!({
                "session_id": format!("{role}-{branch}"),
                "session_file": format!("/{role}-{branch}.jsonl"),
            });
            let answer = bridge.switch(&fresh, reason);
            assert_eq!(answer["role"], role, "{role} {branch}: {answer}");
            assert_eq!(answer["tools"][0]["name"], format!("cataly_{role}"));
        }
    }
    drop(bridge);
    hub.stop();
}

#[test]
fn bridge_continuations_round_trip_through_the_other_role() {
    let (mut hub, lead) = lead_hub();
    let lane = open_lane(&hub);
    let mut bridge = Bridge::connect(&hub, &lead, "lead");
    let mut sessions = [lead, lane];
    for reason in ["new", "fork", "session_branch"] {
        for index in 0..2 {
            let role = ["lead", "lane"][index];
            assert_eq!(bridge.switch(&sessions[index], "resume")["role"], role);
            let continued = json!({
                "session_id": format!("{role}-{reason}"),
                "session_file": format!("/{role}-{reason}.jsonl"),
            });
            assert_eq!(bridge.switch(&continued, reason)["role"], role);
            sessions[index] = continued;
            let other = 1 - index;
            assert_eq!(
                bridge.switch(&sessions[other], "resume")["role"],
                ["lead", "lane"][other]
            );
            let returned = bridge.switch(&sessions[index], "resume");
            assert_eq!(returned["role"], role, "{role} {reason}: {returned}");
        }
    }
    drop(bridge);
    // A new marker-based connection must use the stored continued identity as well.
    drop(Bridge::connect(&hub, &sessions[0], "lead"));
    drop(Bridge::connect(&hub, &sessions[1], "lane"));
    hub.stop();
}

#[test]
fn bridge_lane_returns_by_marker_after_an_unrelated_session() {
    let (mut hub, lead) = lead_hub();
    let lane = open_lane(&hub);
    let mut bridge = Bridge::connect(&hub, &lead, "lead");
    assert_eq!(bridge.switch(&lane, "resume")["role"], "lane");
    assert_eq!(
        bridge.switch(
            &json!({"session_id":"other","session_file":"/other.jsonl"}),
            "resume"
        )["role"],
        "none"
    );
    drop(bridge);
    let copied = json!({"session_id":lane["session_id"],"session_file":"/copy.jsonl"});
    drop(Bridge::connect(&hub, &copied, "none"));
    let mut returned = Bridge::connect(&hub, &lane, "lane");
    let steps = returned.call(
        "bridge.tool",
        &json!({"call":"returned-lane", "input":{"op":"steps"}}),
    );
    assert_eq!(steps["ok"]["error"], false, "{steps}");
    drop(returned);
    hub.stop();
}

#[test]
fn bridge_role_identity_matches_canonical_transcript_aliases() {
    let (mut hub, lead) = lead_hub();
    let lane = open_lane(&hub);
    let mut bridge = Bridge::connect(&hub, &lead, "lead");
    for (role, original) in [("lead", lead), ("lane", lane)] {
        let file = std::path::Path::new(original["session_file"].as_str().unwrap());
        let alias = hub.root.join(format!("{role}-alias"));
        std::os::unix::fs::symlink(file.parent().unwrap(), &alias).unwrap();
        let aliased = json!({
            "session_id": original["session_id"],
            "session_file": alias.join(file.file_name().unwrap()),
        });
        let answer = bridge.switch(&aliased, "resume");
        assert_eq!(answer["role"], role, "{answer}");
        drop(Bridge::connect(&hub, &aliased, role));
    }
    drop(bridge);
    hub.stop();
}

#[test]
fn bridge_transcript_moves_keep_roles_and_persist_the_new_path() {
    let (mut hub, lead) = lead_hub();
    let lane = open_lane(&hub);
    for (role, original) in [("lead", lead), ("lane", lane)] {
        let old = std::path::Path::new(original["session_file"].as_str().unwrap());
        let alias = hub.root.join(format!("old-{role}"));
        std::os::unix::fs::symlink(old.parent().unwrap(), &alias).unwrap();
        let mut header =
            json!({"type":"session", "id":original["session_id"], "cwd":hub.root.join("work")});
        std::fs::write(old, format!("{header}\n")).unwrap();
        let mut bridge = Bridge::connect(&hub, &original, role);
        let dir = hub.root.join(format!("moved-{role}"));
        std::fs::create_dir(&dir).unwrap();
        let file = dir.join(old.file_name().unwrap());
        std::fs::rename(old, &file).unwrap();
        // OMP moveTo rewrites the header with its old path, which may use a directory alias.
        header["previousSessionFiles"] = json!([alias.join(old.file_name().unwrap())]);
        std::fs::write(&file, format!("{header}\n")).unwrap();
        let moved = json!({"session_id":original["session_id"], "session_file":file});
        let answer = bridge.switch(&moved, "session_current");
        assert_eq!(answer["role"], role, "{answer}");
        assert_eq!(answer["tools"][0]["name"], format!("cataly_{role}"));
        let recorded = if role == "lead" {
            hub.json(&["lead", "status", "--json"])["anchor"].clone()
        } else {
            hub.json(&["lane", "list", "--json"])[0].clone()
        };
        assert_eq!(recorded["session_id"], original["session_id"]);
        assert_eq!(
            recorded["session_file"],
            json!(std::fs::canonicalize(&file).unwrap())
        );
        drop(bridge);
        let mut returned = Bridge::connect(&hub, &recorded, role);
        // Copying even a previously moved transcript does not link it to the current stored path.
        let copied_file = dir.join("copy.jsonl");
        std::fs::copy(&file, &copied_file).unwrap();
        let copy = json!({"session_id":original["session_id"], "session_file":copied_file});
        assert_eq!(returned.switch(&copy, "resume")["role"], "none");
        drop(returned);
    }
    hub.stop();
}

#[test]
fn bridge_continuations_store_canonical_transcript_paths() {
    let (mut hub, lead) = lead_hub();
    let lane = open_lane(&hub);
    let mut bridge = Bridge::connect(&hub, &lead, "lead");
    let work = hub.root.join("work");
    let real = std::fs::canonicalize(&work).unwrap();
    let alias = hub.root.join("work-alias");
    std::os::unix::fs::symlink(&work, &alias).unwrap();
    for (role, original) in [("lead", lead), ("lane", lane)] {
        assert_eq!(bridge.switch(&original, "resume")["role"], role);
        let name = format!("{role}-fork.jsonl");
        let continued = json!({"session_id":name,"session_file":alias.join(&name)});
        // Stock OMP may not create the fresh transcript until its first write.
        assert!(!alias.join(&name).exists());
        assert_eq!(bridge.switch(&continued, "fork")["role"], role);
        let recorded = if role == "lead" {
            hub.json(&["lead", "status", "--json"])["anchor"].clone()
        } else {
            hub.json(&["lane", "list", "--json"])[0].clone()
        };
        assert_eq!(recorded["session_id"], name);
        assert_eq!(
            recorded["session_file"],
            json!(real.join(&name)),
            "{recorded}"
        );
        assert_eq!(bridge.switch(&recorded, "resume")["role"], role);
    }
    drop(bridge);
    hub.stop();
}

#[test]
fn bridge_switch_to_unrelated_session_revokes_lead_tools() {
    let (mut hub, lead) = lead_hub();
    let unrelated = json!({"session_id":"unrelated","session_file":"/unrelated.jsonl"});
    let mut bridge = Bridge::connect(&hub, &lead, "lead");
    assert_eq!(bridge.switch(&unrelated, "resume")["role"], "none");
    let refused = bridge.call(
        "bridge.tool",
        &json!({"call":"after-switch","input":{"op":"requests"}}),
    );
    assert_eq!(refused["err"]["code"], "bad_request", "{refused}");
    assert!(
        refused["err"]["message"]
            .as_str()
            .unwrap()
            .contains("no role")
    );
    drop(bridge);
    hub.stop();
}

#[test]
fn bridge_switch_rechecks_lead_and_lane_identity_except_for_new() {
    let (mut hub, lead) = lead_hub();
    let mut bridge = Bridge::connect(&hub, &lead, "lead");
    let fresh = json!({"session_id":"fresh","session_file":"/fresh.jsonl"});
    assert_eq!(bridge.switch(&fresh, "new")["role"], "lead");
    let lead = fresh; // The continuation, not its predecessor, is now the lead anchor.
    assert_eq!(bridge.switch(&lead, "resume")["role"], "lead");

    let lane = open_lane(&hub);
    let answer = bridge.switch(&lane, "resume");
    assert_eq!(answer["role"], "lane", "{answer}");
    assert_eq!(answer["tools"][0]["name"], "cataly_lane");
    let refused = bridge.call(
        "bridge.tool",
        &json!({"call":"lane-not-lead","input":{"op":"requests"}}),
    );
    assert_eq!(refused["ok"]["error"], true, "{refused}");
    let steps = bridge.call(
        "bridge.tool",
        &json!({"call":"lane-steps","input":{"op":"steps"}}),
    );
    assert_eq!(steps["ok"]["error"], false, "{steps}");

    assert_eq!(bridge.switch(&lead, "resume")["role"], "lead");
    let copied = json!({"session_id":lead["session_id"],"session_file":"/a-copy.jsonl"});
    assert_eq!(bridge.switch(&copied, "resume")["role"], "none");
    drop(bridge);
    hub.stop();
}
