//! Telegram and Slack through the real hub, the fake Telegram Bot API and the fake Slack
//! (`tests/support/telegram.rs`, `tests/support/slack.rs`) and the fake OMP lead in its turn mode.
//! Milestone 4 acceptance checks 1-5; check 5 against stock OMP is in `tests/contract_relays.rs`.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use support::TestHub;
use support::slack::{self as fake_slack, FakeSlack};
use support::telegram::{self as fake_tg, FakeTelegram};

const WAIT: Duration = Duration::from_secs(30);
const DM: &str = "D0OWNER";
const GEN: &str = "C0GEN";

/// A hub with the fake OMP lead and the given relays; `extra` is appended to the config.
fn relay_hub(tg: Option<&FakeTelegram>, slack: Option<&FakeSlack>, extra: &str) -> TestHub {
    let hub = TestHub::new("");
    let omp = hub.install_fake("omp");
    for f in ["rpc", "turns"] {
        hub.fixture("omp", f, Some(""));
    }
    hub.fixture("omp", "answer.json", Some("\"the answer\""));
    let work = hub.root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    let mut config = format!(
        "[omp]\npath = \"{}\"\n[lead]\nmodel = \"fake/primary\"\ncwd = \"{}\"\n",
        omp.display(),
        work.display()
    );
    if let Some(tg) = tg {
        let token = hub.private_file("telegram-token", fake_tg::TOKEN);
        config.push_str(&tg.config(&token));
    }
    if let Some(slack) = slack {
        let tokens = hub.private_file("slack-tokens", &FakeSlack::tokens());
        config.push_str(&slack.config(&tokens));
    }
    config.push_str(extra);
    hub.write_config(&config);
    hub
}

fn status(hub: &TestHub, relay: &str) -> Value {
    hub.json(&[relay, "status", "--json"])
}

/// Waits until the named relays are healthy and the lead is live.
fn ready(hub: &TestHub, relays: &[&str]) {
    hub.until(WAIT, || {
        let lead = hub.json(&["lead", "status", "--json"]);
        let all = relays.iter().all(|r| status(hub, r)["healthy"] == true);
        (all && lead["phase"] == "live").then_some(())
    });
}

/// Waits until a fresh readback shows the lead idle with nothing sent or waiting, so the next
/// request wakes it. Between a turn's end and that readback the lead's status is unknown: a request
/// handed off then waits for the readback and is not measured as a wake.
fn lead_idle(hub: &TestHub) {
    hub.until(WAIT, || {
        let lead = hub.json(&["lead", "status", "--json"]);
        (lead["session"]["status"] == "idle" && lead["sent"] == 0 && lead["waiting"] == 0)
            .then_some(())
    });
}

fn session_file(hub: &TestHub) -> PathBuf {
    let lead = hub.json(&["lead", "status", "--json"]);
    PathBuf::from(lead["session"]["session_file"].as_str().unwrap())
}

/// User entries of the lead's session file that carry a request tag starting with `tag`.
fn requests(hub: &TestHub, tag: &str) -> Vec<String> {
    let text = std::fs::read_to_string(session_file(hub)).unwrap_or_default();
    text.lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|e| e["message"]["role"] == "user")
        .map(|e| {
            e["message"]["content"][0]["text"]
                .as_str()
                .unwrap_or_default()
                .to_string()
        })
        .filter(|t| t.contains(tag))
        .collect()
}

fn tg_replies_to(tg: &FakeTelegram, message: i64) -> Vec<fake_tg::Seen> {
    tg.calls("sendMessage")
        .into_iter()
        .filter(|s| s.body["reply_parameters"]["message_id"] == message)
        .collect()
}

fn slack_posts_in(slack: &FakeSlack, channel: &str, thread: &str) -> Vec<fake_slack::Seen> {
    slack
        .calls("chat.postMessage")
        .into_iter()
        .filter(|s| s.body["channel"] == channel && s.body["thread_ts"] == thread)
        .collect()
}

/// Check 5: a Telegram and a Slack request each get the lead's answer in place with a seen mark,
/// then a done mark. Also measures intake latency per relay and Telegram receive lag.
#[test]
fn telegram_and_slack_requests_are_answered_in_place_with_seen_marks() {
    let tg = FakeTelegram::start();
    let slack = FakeSlack::start();
    let mut hub = relay_hub(Some(&tg), Some(&slack), "");
    hub.start();
    ready(&hub, &["telegram", "slack"]);
    lead_idle(&hub);
    tg.push(
        "message",
        FakeTelegram::message(11, FakeTelegram::dm(), 7, "hello from telegram"),
    );
    let answer = tg.wait(WAIT, |f| tg_replies_to(f, 11).pop());
    assert_eq!(answer.body["chat_id"], 7);
    assert_eq!(answer.body["text"], "the answer");
    assert_eq!(
        answer.body["reply_parameters"]["allow_sending_without_reply"],
        false
    );
    // The done mark replaces the seen mark: ✅ is not a reaction bots may set, 👌 is.
    let marks = tg.wait(WAIT, |f| {
        let m = f.calls("setMessageReaction");
        (m.len() >= 2).then_some(m)
    });
    assert_eq!(marks.len(), 2, "one seen mark, one done mark");
    assert_eq!(marks[0].body["message_id"], 11);
    assert_eq!(marks[0].body["reaction"][0]["emoji"], "\u{1F440}");
    assert_eq!(marks[1].body["message_id"], 11);
    assert_eq!(
        marks[1].body["reaction"],
        json!([{"type": "emoji", "emoji": "\u{1F44C}"}])
    );
    lead_idle(&hub);
    let ts = slack.say(DM, fake_slack::OWNER, "hello from slack", None);
    let posted = slack.wait(WAIT, |f| slack_posts_in(f, DM, &ts).pop());
    assert_eq!(posted.body["text"], "the answer");
    // The seen mark, replaced by the done mark once the answer is posted: added first, then the
    // eyes go.
    let replaced = [
        "reactions.add eyes",
        "reactions.add white_check_mark",
        "reactions.remove eyes",
    ];
    let marks = |f: &FakeSlack| -> Vec<String> {
        f.seen()
            .into_iter()
            .filter(|s| s.method.starts_with("reactions."))
            .inspect(|s| assert_eq!(s.body["timestamp"], ts.as_str()))
            .map(|s| format!("{} {}", s.method, s.body["name"].as_str().unwrap()))
            .collect()
    };
    slack.wait(WAIT, |f| (marks(f) == replaced).then_some(()));
    assert!(
        slack
            .acks()
            .iter()
            .all(|(_, d)| *d < Duration::from_secs(3))
    );
    let asked = requests(&hub, "[telegram 7/11]");
    assert_eq!(asked.len(), 1, "{asked:?}");
    assert!(
        asked[0].contains("request from the owner (authenticated)")
            && asked[0].contains("> hello from telegram")
    );
    assert_eq!(requests(&hub, &format!("[slack {DM}/{ts}]")).len(), 1);
    // The answers settle the owed replies.
    for relay in ["telegram", "slack"] {
        hub.until(WAIT, || {
            let s = status(&hub, relay);
            (s["counts"]["owed_settled"] == 1 && s["counts"]["queued"] == 0).then_some(())
        });
    }
    // An edit is delivered as kind "edit" labelled with the message it edits, and gets no seen
    // mark (TELE req. 26, MSG req. 6).
    let mut edit = FakeTelegram::message(11, FakeTelegram::dm(), 7, "hello again, edited");
    edit["edit_date"] = json!(2_000_000_000);
    tg.push("edited_message", edit);
    let edited = hub.until(WAIT, || {
        requests(&hub, "[telegram 7/11")
            .into_iter()
            .find(|r| r.contains("hello again, edited"))
    });
    assert!(
        edited.contains("this edits the owner's earlier message 11"),
        "{edited}"
    );
    assert_eq!(
        tg.calls("setMessageReaction").len(),
        2,
        "no seen mark on an edit"
    );
    // Its answer replies to the edited message.
    tg.wait(WAIT, |f| (tg_replies_to(f, 11).len() == 2).then_some(()));
    let stats = hub.json(&["stats", "--json"]);
    for key in [
        "telegram_wake_latency",
        "slack_wake_latency",
        "telegram_receive_lag",
    ] {
        assert!(
            stats[key]["count"].as_u64().unwrap_or(0) >= 1,
            "{key} is {}; all stats: {stats}",
            stats[key]
        );
        eprintln!("measure {key}: {}", stats[key]);
    }
    assert!(hub.stop().success());
}

/// Telegram takes a background job's later turn through the same pipeline: the answer replies to
/// the request, and the later turn's text follows in the same chat as a plain message (DISC-OUT
/// req. 21).
#[test]
fn a_background_result_follows_the_telegram_answer() {
    let tg = FakeTelegram::start();
    let mut hub = relay_hub(Some(&tg), None, "");
    hub.fixture("omp", "followup", Some("\"the backup finished\""));
    hub.start();
    ready(&hub, &["telegram"]);
    lead_idle(&hub);
    tg.push(
        "message",
        FakeTelegram::message(12, FakeTelegram::dm(), 7, "back up, then answer"),
    );
    let sent = tg.wait(WAIT, |f| {
        let sent = f.calls("sendMessage");
        (sent.len() >= 2).then_some(sent)
    });
    assert_eq!(sent[0].body["text"], "the answer", "{sent:?}");
    assert_eq!(sent[0].body["reply_parameters"]["message_id"], 12);
    assert_eq!(sent[1].body["text"], "the backup finished");
    assert_eq!(sent[1].body["chat_id"], 7);
    assert!(
        sent[1].body.get("reply_parameters").is_none(),
        "{:?}",
        sent[1].body
    );
    hub.until(WAIT, || {
        let s = status(&hub, "telegram");
        (s["counts"]["owed_settled"] == 1 && s["counts"]["answers_waiting"] == 0).then_some(())
    });
    std::thread::sleep(Duration::from_secs(2));
    assert_eq!(tg.calls("sendMessage").len(), 2, "each once");
    assert!(hub.stop().success());
}

/// Check 3: untagged replies in a thread the account posted in are admitted; an unlisted member is
/// dropped; every envelope is acknowledged within 3 s; an upload URL off files.slack.com is refused
/// before any byte is sent.
#[test]
fn slack_threads_allowlist_acks_and_uploads() {
    let slack = FakeSlack::start();
    let mut hub = relay_hub(None, Some(&slack), "");
    hub.start();
    ready(&hub, &["slack"]);
    let stranger = slack.say(DM, "U0OTHER", "do something for me", None);
    let untagged = slack.say(GEN, fake_slack::OWNER, "a remark in the channel", None);
    let root = slack.say(
        GEN,
        fake_slack::OWNER,
        &format!("<@{}> look at this", fake_slack::ACCOUNT),
        None,
    );
    slack.wait(WAIT, |f| slack_posts_in(f, GEN, &root).pop());
    let reply = slack.say(
        GEN,
        fake_slack::OWNER,
        "and also this, untagged",
        Some(&root),
    );
    slack.wait(WAIT, |f| {
        (slack_posts_in(f, GEN, &root).len() >= 2).then_some(())
    });
    assert_eq!(
        requests(&hub, &format!("[slack {GEN}:{root}/{reply}]")).len(),
        1
    );
    for dropped in [&stranger, &untagged] {
        assert!(
            requests(&hub, dropped).is_empty(),
            "{dropped} reached the lead"
        );
        assert!(
            !slack
                .calls("reactions.add")
                .iter()
                .any(|s| s.body["timestamp"] == dropped.as_str()),
            "no seen mark for a dropped message"
        );
    }
    let acks = slack.acks();
    assert!(acks.len() >= 4, "{acks:?}");
    assert!(
        acks.iter().all(|(_, d)| *d < Duration::from_secs(3)),
        "{acks:?}"
    );
    // Uploads: a destination of another workspace is refused before any request (SLACK-04).
    let file = hub.private_file("report.txt", "the report");
    let target = format!("{}/{GEN}", fake_slack::TEAM);
    let before = slack.seen().len();
    let other = hub.cli(&["slack", "upload", "T0OTHER/C0GEN", file.to_str().unwrap()]);
    assert!(!other.status.success());
    assert!(
        String::from_utf8_lossy(&other.stderr).contains("not the workspace"),
        "{other:?}"
    );
    assert_eq!(
        slack.seen().len(),
        before,
        "no request for another workspace"
    );
    // A ticket whose URL is off files.slack.com sends no byte.
    slack.set_upload_url("https://files.slack.com.evil.example/upload/v1/X");
    let refused = hub.cli(&["slack", "upload", &target, file.to_str().unwrap(), "--json"]);
    assert!(!refused.status.success());
    assert!(
        String::from_utf8_lossy(&refused.stderr).contains("files.slack.com"),
        "{refused:?}"
    );
    assert!(
        slack
            .seen()
            .iter()
            .all(|s| !s.method.starts_with("upload/"))
    );
    assert!(slack.calls("files.completeUploadExternal").is_empty());
    slack.set_upload_url("https://files.slack.com/upload/v1/ABC");
    let done = hub.json(&[
        "slack",
        "upload",
        &target,
        file.to_str().unwrap(),
        "--thread",
        &root,
        "--json",
    ]);
    assert_eq!(done["file"], "F0FILE1");
    let sent: Vec<_> = slack
        .seen()
        .into_iter()
        .filter(|s| s.method.starts_with("upload/"))
        .collect();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].bytes, "the report".len());
    let complete = slack.calls("files.completeUploadExternal");
    assert_eq!(complete[0].body["channel_id"], GEN);
    assert_eq!(complete[0].body["thread_ts"], root.as_str());
    assert!(hub.stop().success());
}

fn slack_message_stored(hub: &TestHub, ts: &str) -> bool {
    let db = rusqlite::Connection::open_with_flags(
        hub.state().join("cataly.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    db.query_row(
        "SELECT EXISTS (SELECT 1 FROM arrival_queue \
         WHERE relay = 'slack' AND room = ?1 AND message = ?2 UNION ALL \
         SELECT 1 FROM handoffs WHERE relay = 'slack' AND room = ?1 AND message = ?2)",
        [GEN, ts],
        |r| r.get(0),
    )
    .unwrap()
}

/// Uses a later policy-dropped envelope as a socket barrier: once it is acknowledged, an earlier
/// failed admission must already have finished. No negative assertion depends on a sleep.
fn slack_retries_unadmitted(setup: &str, recover: &str, newer_first: bool) {
    let slack = FakeSlack::start();
    let mut hub = relay_hub(None, Some(&slack), "");
    hub.start();
    ready(&hub, &["slack"]);
    assert!(hub.stop().success());
    let db = rusqlite::Connection::open(hub.state().join("cataly.db")).unwrap();
    db.execute_batch(setup).unwrap();
    drop(db);
    hub.start();
    // A queued fixture intentionally makes `healthy` false; wait for the live socket instead.
    hub.until(WAIT, || {
        let slack = status(&hub, "slack");
        let lead = hub.json(&["lead", "status", "--json"]);
        (slack["health"]["state"] == "connected"
            && slack["health"]["caught_up"] == true
            && lead["phase"] == "live")
            .then_some(())
    });

    // A top-level channel mention has no remembered thread or DM history to recover it.
    let ts = slack.ts();
    let event = json!({"type": "message", "channel": GEN, "channel_type": "channel",
        "user": fake_slack::OWNER, "text": format!("<@{}> keep this request", fake_slack::ACCOUNT),
        "ts": ts});
    let failed = slack.push(event.clone());
    let dropped = slack.push(json!({"type": "reaction_added"}));
    let acks = slack.wait(WAIT, |f| {
        let acks = f.acks();
        acks.iter().any(|(id, _)| id == &dropped).then_some(acks)
    });
    assert!(
        !acks.iter().any(|(id, _)| id == &failed),
        "unadmitted envelope {failed} was acknowledged: {acks:?}"
    );
    assert_eq!(
        requests(&hub, &format!("[slack {GEN}/{ts}]")),
        Vec::<String>::new()
    );

    assert!(hub.stop().success());
    let db = rusqlite::Connection::open(hub.state().join("cataly.db")).unwrap();
    db.execute_batch(recover).unwrap();
    drop(db);
    hub.start();
    ready(&hub, &["slack"]);

    if newer_first {
        let newer = slack.say(
            GEN,
            fake_slack::OWNER,
            &format!("<@{}> a newer request", fake_slack::ACCOUNT),
            None,
        );
        slack.wait(WAIT, |f| slack_posts_in(f, GEN, &newer).pop());
        // B's hand-off moves the cursor beyond A. A is still eligible for redelivery, even
        // after the restart above discarded all volatile knowledge of its failed admission.
        let position = newer.replace('.', "");
        hub.until(WAIT, || {
            let s = status(&hub, "slack");
            s["rooms"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["room"] == GEN && r["position"] == position)
                .then_some(())
        });
    }

    // Slack can redeliver the same message after recovery; a subsequent duplicate is safe to ack.
    let retried = slack.push(event.clone());
    slack.wait(WAIT, |f| {
        f.acks().iter().any(|(id, _)| id == &retried).then_some(())
    });
    assert!(
        slack_message_stored(&hub, &ts),
        "redelivered message {ts} was acked without a durable record"
    );
    slack.wait(WAIT, |f| slack_posts_in(f, GEN, &ts).pop());
    let duplicate = slack.push(event);
    slack.wait(WAIT, |f| {
        f.acks()
            .iter()
            .any(|(id, _)| id == &duplicate)
            .then_some(())
    });
    assert_eq!(requests(&hub, &format!("[slack {GEN}/{ts}]")).len(), 1);
    assert!(hub.stop().success());
}

#[test]
fn slack_does_not_ack_a_failed_arrival_write() {
    slack_retries_unadmitted(
        "CREATE TRIGGER fail_slack_arrival BEFORE INSERT ON arrival_queue \
         WHEN NEW.relay = 'slack' AND NEW.room = 'C0GEN' \
         BEGIN SELECT RAISE(FAIL, 'test admission failure'); END;",
        "DROP TRIGGER fail_slack_arrival;",
        false,
    );
}

#[test]
fn slack_redelivers_an_older_unadmitted_message_after_a_newer_one() {
    slack_retries_unadmitted(
        "CREATE TRIGGER fail_slack_arrival BEFORE INSERT ON arrival_queue \
         WHEN NEW.relay = 'slack' AND NEW.room = 'C0GEN' \
         BEGIN SELECT RAISE(FAIL, 'test admission failure'); END;",
        "DROP TRIGGER fail_slack_arrival;",
        true,
    );
}

#[test]
fn slack_does_not_ack_a_full_arrival_queue() {
    slack_retries_unadmitted(
        // The byte count fills the queue without allocating 256 MiB. A held room keeps the
        // fixture queued while the live message tries to enter a different room.
        "INSERT INTO positions (relay, room, position, held, updated_ms) \
         VALUES ('slack', 'D0FULL', 0, 'test queue full', 0); \
         INSERT INTO arrival_queue \
         (relay, room, message, seq, position_at, raw, bytes, created_ms) \
         VALUES ('slack', 'D0FULL', '1.000001', 1000001, 0, '{}', 268435456, 0);",
        "DELETE FROM arrival_queue WHERE relay = 'slack' AND room = 'D0FULL'; \
         DELETE FROM positions WHERE relay = 'slack' AND room = 'D0FULL';",
        false,
    );
}

fn slack_redelivery_after_release(state: &str) {
    let slack = FakeSlack::start();
    let mut hub = relay_hub(None, Some(&slack), "");
    hub.start();
    ready(&hub, &["slack"]);
    let ts = slack.ts();
    let event = json!({"type": "message", "channel": GEN, "channel_type": "channel",
        "user": fake_slack::OWNER, "text": format!("<@{}> original request", fake_slack::ACCOUNT),
        "ts": ts});
    slack.push(event.clone());
    slack.wait(WAIT, |f| slack_posts_in(f, GEN, &ts).pop());
    ready(&hub, &["slack"]);
    assert!(hub.stop().success());

    // Keep a real hand-off's identity and digest, but seed the terminal state and held queue
    // left by an unsuccessful hand-off. The owner gives it up through the real release command.
    let seq: i64 = ts.replace('.', "").parse().unwrap();
    let raw = event.to_string();
    let db = rusqlite::Connection::open(hub.state().join("cataly.db")).unwrap();
    db.execute(
        "UPDATE handoffs SET state = ?1 WHERE relay = 'slack' AND room = ?2 AND message = ?3",
        [state, GEN, ts.as_str()],
    )
    .unwrap();
    db.execute(
        "UPDATE positions SET held = 'test hand-off' WHERE relay = 'slack' AND room = ?1",
        [GEN],
    )
    .unwrap();
    db.execute(
        "INSERT INTO arrival_queue \
         (relay, room, message, seq, position_at, raw, bytes, created_ms) \
         VALUES ('slack', ?1, ?2, ?3, ?3 - 1, ?4, ?5, 0)",
        rusqlite::params![GEN, ts, seq, raw, i64::try_from(raw.len()).unwrap()],
    )
    .unwrap();
    drop(db);
    hub.start();
    hub.until(WAIT, || {
        let s = status(&hub, "slack");
        (s["health"]["state"] == "connected" && s["counts"]["held"] == 1).then_some(())
    });
    assert_eq!(status(&hub, "slack")["counts"]["queued"], 1);
    assert!(hub.cli(&["slack", "release", GEN]).status.success());
    assert_eq!(status(&hub, "slack")["counts"]["queued"], 0);
    assert!(hub.stop().success());
    hub.start();
    ready(&hub, &["slack"]);

    let redelivered = slack.push(event);
    slack.wait(WAIT, |f| {
        f.acks()
            .iter()
            .any(|(id, _)| id == &redelivered)
            .then_some(())
    });
    // The ack follows the arrival transaction, so no sleep is needed to check its queue effect.
    let s = status(&hub, "slack");
    assert_eq!(s["counts"]["queued"], 0, "{state} redelivery requeued: {s}");
    assert_eq!(
        s["counts"]["held"], 0,
        "{state} redelivery held the room: {s}"
    );
    let newer = slack.say(
        GEN,
        fake_slack::OWNER,
        &format!("<@{}> the next request", fake_slack::ACCOUNT),
        None,
    );
    slack.wait(WAIT, |f| slack_posts_in(f, GEN, &newer).pop());
    assert_eq!(requests(&hub, &format!("[slack {GEN}/{ts}]")).len(), 1);
    assert!(hub.stop().success());
}

#[test]
fn slack_does_not_requeue_a_released_in_doubt_handoff() {
    slack_redelivery_after_release("in_doubt");
}

#[test]
fn slack_does_not_requeue_a_released_failed_handoff() {
    slack_redelivery_after_release("failed");
}

/// Check 1, start-up: a webhook or a non-bot identity keeps intake off and nothing is polled.
#[test]
fn telegram_refuses_a_webhook_and_a_non_bot() {
    let tg = FakeTelegram::start();
    tg.set_webhook("https://example.invalid/hook");
    let mut hub = relay_hub(Some(&tg), None, "");
    hub.start();
    let s = hub.until(WAIT, || {
        let s = status(&hub, "telegram");
        (s["health"]["state"] == "stopped").then_some(s)
    });
    assert!(
        s["health"]["reason"].as_str().unwrap().contains("webhook"),
        "{s}"
    );
    assert!(tg.calls("getUpdates").is_empty());
    assert!(tg.calls("setWebhook").is_empty() && tg.calls("deleteWebhook").is_empty());
    tg.set_webhook("");
    tg.set_not_bot();
    assert!(hub.cli(&["telegram", "reset"]).status.success());
    hub.until(WAIT, || {
        let s = status(&hub, "telegram");
        s["health"]["reason"]
            .as_str()
            .is_some_and(|r| r.contains("not belong to a bot"))
            .then_some(())
    });
    assert!(tg.calls("getUpdates").is_empty());
    assert!(hub.stop().success());
}

/// Check 1, polling: 409 shows unhealthy and polls again after 30 s; a 429 is waited out.
#[test]
fn telegram_conflicts_and_rate_limits_are_waited_out() {
    let tg = FakeTelegram::start();
    let mut hub = relay_hub(Some(&tg), None, "");
    hub.start();
    ready(&hub, &["telegram"]);
    tg.script(409, json!({"ok": false, "error_code": 409, "description": "Conflict: terminated by other getUpdates request"}));
    let s = hub.until(WAIT, || {
        let s = status(&hub, "telegram");
        (s["health"]["state"] == "unhealthy").then_some(s)
    });
    assert!(
        s["health"]["reason"].as_str().unwrap().contains("409"),
        "{s}"
    );
    let polls = tg.wait(Duration::from_secs(45), |f| {
        let p = f.calls("getUpdates");
        let n = p.len();
        (n >= 2 && p[n - 1].at.duration_since(p[n - 2].at) >= Duration::from_secs(29)).then_some(p)
    });
    assert!(polls.len() >= 2);
    tg.script(429, json!({"ok": false, "error_code": 429, "description": "Too Many Requests", "parameters": {"retry_after": 3}}));
    let before = tg.calls("getUpdates").len();
    hub.until(WAIT, || {
        let s = status(&hub, "telegram");
        s["health"]["reason"]
            .as_str()
            .is_some_and(|r| r.contains("rate limited"))
            .then_some(())
    });
    let polls = tg.wait(WAIT, |f| {
        let p = f.calls("getUpdates");
        (p.len() >= before + 2).then_some(p)
    });
    let gap = polls[before + 1].at.duration_since(polls[before].at);
    assert!(gap >= Duration::from_secs(3), "{gap:?}");
    tg.push(
        "message",
        FakeTelegram::message(12, FakeTelegram::dm(), 7, "still there?"),
    );
    tg.wait(WAIT, |f| tg_replies_to(f, 12).pop());
    assert!(hub.stop().success());
}

/// Check 1: a 429 longer than a minute is still waited out, never a stop.
#[test]
fn telegram_long_rate_limit_is_waited_out() {
    let tg = FakeTelegram::start();
    let mut hub = relay_hub(Some(&tg), None, "");
    hub.start();
    ready(&hub, &["telegram"]);
    let before = tg.calls("getUpdates").len();
    tg.script(429, json!({"ok": false, "error_code": 429, "description": "Too Many Requests", "parameters": {"retry_after": 62}}));
    let polls = tg.wait(Duration::from_secs(90), |f| {
        let p = f.calls("getUpdates");
        (p.len() >= before + 2).then_some(p)
    });
    let gap = polls[before + 1].at.duration_since(polls[before].at);
    assert!(gap >= Duration::from_secs(62), "{gap:?}");
    assert_ne!(status(&hub, "telegram")["health"]["state"], "stopped");
    assert!(hub.stop().success());
}

/// Check 1: the offset survives a restart and a replayed update is not handed off again.
#[test]
fn telegram_offset_and_replay_guard_hold_across_restarts() {
    let tg = FakeTelegram::start();
    let mut hub = relay_hub(Some(&tg), None, "");
    hub.start();
    ready(&hub, &["telegram"]);
    let update = tg.push(
        "message",
        FakeTelegram::message(21, FakeTelegram::dm(), 7, "remember me"),
    );
    tg.wait(WAIT, |f| tg_replies_to(f, 21).pop());
    hub.until(WAIT, || {
        (status(&hub, "telegram")["counts"]["queued"] == 0).then_some(())
    });
    assert!(hub.stop().success());
    let polls_before = tg.calls("getUpdates").len();
    // Telegram sends the handled update again after the restart.
    tg.replay_from(update);
    hub.start();
    ready(&hub, &["telegram"]);
    let first = tg.wait(WAIT, |f| f.calls("getUpdates").get(polls_before).cloned());
    assert_eq!(first.body["offset"], update + 1, "the saved offset is sent");
    std::thread::sleep(Duration::from_secs(3));
    assert_eq!(tg_replies_to(&tg, 21).len(), 1, "one answer only");
    assert_eq!(requests(&hub, "[telegram 7/21]").len(), 1);
    assert_eq!(
        tg.calls("setMessageReaction").len(),
        2,
        "one seen mark and one done mark, not again after the restart"
    );
    assert!(hub.stop().success());
}

/// Check 2: live-location edits are dropped, topic and General are told apart, and sends outside
/// the owner's DM and the configured group and topic are refused before any request. Job and board
/// posts reach Telegram and Slack destinations.
#[test]
fn telegram_scope_topics_and_destinations() {
    let tg = FakeTelegram::start();
    let slack = FakeSlack::start();
    let extra = format!(
        "[destinations.tgok]\nkind = \"telegram\"\nchat = \"7\"\n[destinations.tgbad]\nkind = \"telegram\"\nchat = \"999\"\n\
         [destinations.sl]\nkind = \"slack\"\nchannel = \"{team}/{GEN}\"\n{}[coord]\nboard = [\"telegram:-100/5\", \"slack:{team}/{GEN}\"]\n",
        support::probe(
            "say",
            r#"["printf", "%s", "job says hi"]"#,
            "destinations = [\"tgok\", \"tgbad\", \"sl\"]\n"
        ),
        team = fake_slack::TEAM,
    );
    let mut hub = relay_hub(Some(&tg), Some(&slack), &extra);
    hub.start();
    ready(&hub, &["telegram", "slack"]);
    // The job's event: the DM and Slack get it; chat 999 never sees a request.
    tg.wait(WAIT, |f| {
        f.calls("sendMessage").into_iter().find(|s| {
            s.body["chat_id"] == 7
                && s.body["text"]
                    .as_str()
                    .unwrap_or("")
                    .contains("job says hi")
        })
    });
    slack.wait(WAIT, |f| {
        f.calls("chat.postMessage").into_iter().find(|s| {
            s.body["channel"] == GEN
                && s.body["text"]
                    .as_str()
                    .unwrap_or("")
                    .contains("job says hi")
        })
    });
    // The board posts in the configured topic and the Slack channel.
    tg.wait(WAIT, |f| {
        f.calls("sendMessage").into_iter().find(|s| {
            s.body["chat_id"] == -100
                && s.body["message_thread_id"] == 5
                && s.body["text"].as_str().unwrap_or("").contains("lane(s)")
        })
    });
    slack.wait(WAIT, |f| {
        f.calls("chat.postMessage").into_iter().find(|s| {
            s.body["channel"] == GEN && s.body["text"].as_str().unwrap_or("").contains("lane(s)")
        })
    });
    let mut live = FakeTelegram::message(31, FakeTelegram::dm(), 7, "");
    live.as_object_mut().unwrap().remove("text");
    live["location"] = json!({"latitude": 1.0, "longitude": 2.0, "live_period": 60});
    live["edit_date"] = json!(1);
    tg.push("edited_message", live);
    // General in a forum (no topic mark) is not the configured topic 5.
    tg.push(
        "message",
        FakeTelegram::message(32, FakeTelegram::forum(), 7, "in general"),
    );
    let mut topic = FakeTelegram::message(33, FakeTelegram::forum(), 7, "in the topic");
    topic["is_topic_message"] = json!(true);
    topic["message_thread_id"] = json!(5);
    tg.push("message", topic);
    let answer = tg.wait(WAIT, |f| tg_replies_to(f, 33).pop());
    assert_eq!(answer.body["chat_id"], -100);
    assert_eq!(answer.body["message_thread_id"], 5);
    std::thread::sleep(Duration::from_secs(2));
    assert!(tg_replies_to(&tg, 31).is_empty() && tg_replies_to(&tg, 32).is_empty());
    assert_eq!(requests(&hub, "[telegram 7/31"), Vec::<String>::new());
    assert_eq!(requests(&hub, "/32]"), Vec::<String>::new());
    assert_eq!(requests(&hub, "[telegram -100:5/33]").len(), 1);
    assert!(
        tg.calls("sendMessage")
            .iter()
            .all(|s| s.body["chat_id"] != 999)
    );
    assert!(hub.stop().success());
}

/// Check 4: a stalled relay never delays another relay's intake.
#[test]
fn a_hung_relay_never_delays_another() {
    let tg = FakeTelegram::start();
    let slack = FakeSlack::start();
    let mut hub = relay_hub(Some(&tg), Some(&slack), "");
    hub.start();
    ready(&hub, &["telegram", "slack"]);
    // Slack's Web API hangs (its socket stays up): Telegram carries on.
    slack.set_hang(true);
    let at = Instant::now();
    tg.push(
        "message",
        FakeTelegram::message(41, FakeTelegram::dm(), 7, "are you there?"),
    );
    tg.wait(WAIT, |f| tg_replies_to(f, 41).pop());
    let tg_took = at.elapsed();
    slack.set_hang(false);
    // Telegram's next poll and every call after it hang: Slack carries on.
    tg.set_hang(true);
    let at = Instant::now();
    let ts = slack.say(DM, fake_slack::OWNER, "and you?", None);
    slack.wait(WAIT, |f| slack_posts_in(f, DM, &ts).pop());
    let slack_took = at.elapsed();
    eprintln!("measure hung-peer answer: telegram {tg_took:?}, slack {slack_took:?}");
    assert!(tg_took < Duration::from_secs(10), "{tg_took:?}");
    assert!(slack_took < Duration::from_secs(10), "{slack_took:?}");
    assert!(
        slack
            .acks()
            .iter()
            .all(|(_, d)| *d < Duration::from_secs(3))
    );
    tg.set_hang(false);
    assert!(hub.stop().success());
}
