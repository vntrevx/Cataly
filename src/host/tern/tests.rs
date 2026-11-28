#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::sync::Mutex as StdMutex;

use super::*;
use crate::host::testing::spec;

type Seen = Arc<StdMutex<Vec<Value>>>;

/// What OMP's resolver answers for `selector` with no literal colon IDs in its catalogue: the
/// base model, the suffix level, and `observed` as the level it runs.
fn resolution(selector: &str, observed: Option<&str>) -> Value {
    const LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    let (base, level) = match selector.rsplit_once(':') {
        Some((base, level)) if LEVELS.contains(&level) => (base, Some(level)),
        _ => (selector, None),
    };
    let (provider, id) = base.split_once('/').unwrap();
    json!({ "model_resolution": { "version": 1, "selector": selector, "provider": provider,
        "id": id, "thinking": { "requested": level, "observed": observed.or(level) } } })
}

/// A bridge stand-in: records each command and answers it with `answer`; the read-only
/// `model.resolve` is answered as OMP resolves the selector and not recorded.
fn fake_bridge(
    port: &Arc<Port>,
    answer: impl Fn(&Value) -> Value + Send + 'static,
) -> (Seen, mpsc::Sender<Response>) {
    let (tx, mut rx) = mpsc::channel::<Response>(64);
    let seen: Seen = Arc::default();
    let (port, log) = (Arc::clone(port), Arc::clone(&seen));
    tokio::spawn(async move {
        while let Some(response) = rx.recv().await {
            let line: Value = serde_json::from_str(response.to_line().trim()).unwrap();
            let cmd = line["item"]["cmd"].clone();
            if cmd.is_null() {
                continue;
            }
            let mut reply = if cmd["op"] == "model.resolve" {
                resolution(cmd["selector"].as_str().unwrap(), None)
            } else {
                log.lock().unwrap().push(cmd.clone());
                answer(&cmd)
            };
            reply["n"] = cmd["n"].clone();
            port.reply(&reply);
        }
    });
    (seen, tx)
}

fn hello(session: &str, pid: u64) -> Value {
    json!({ "session": session, "file": format!("/tmp/{session}.jsonl"), "pid": pid, "idle": true,
        "model": "fake/primary", "goal": { "status": "active" }, "model_resolution_version": 1 })
}

/// The hello of a bridge older than the hub: no model-resolution capability.
fn old_hello(session: &str, pid: u64) -> Value {
    let mut hello = hello(session, pid);
    hello
        .as_object_mut()
        .unwrap()
        .remove("model_resolution_version");
    hello
}

/// A port whose oversized deliveries would spill to the temp folder; tests that spill use
/// `port_in` with a scratch directory.
fn port() -> (Arc<Port>, oneshot::Receiver<()>) {
    port_in(std::env::temp_dir())
}

fn port_in(spill: PathBuf) -> (Arc<Port>, oneshot::Receiver<()>) {
    Port::new(
        &spec("t1", None),
        spill,
        Latency::default(),
        Duration::from_millis(300),
    )
}

async fn bound(answer: impl Fn(&Value) -> Value + Send + 'static) -> (Session, Seen) {
    bound_in(std::env::temp_dir(), answer).await
}

async fn bound_in(
    spill: PathBuf,
    answer: impl Fn(&Value) -> Value + Send + 'static,
) -> (Session, Seen) {
    let (port, attached) = port_in(spill);
    let (seen, tx) = fake_bridge(&port, answer);
    port.attach(&hello("s1", 42), "k1", tx).unwrap();
    attached.await.unwrap();
    let started = port.bind(&spec("t1", None)).await.unwrap();
    assert_eq!(
        (started.session_id.as_str(), started.pid, started.held),
        ("s1", Some(42), None)
    );
    // As a hub start does: the bridge's link is accepted and the bound resolution shared.
    let links = Arc::new(super::super::bridge::Links::default());
    links.connect("t1", Role::Lane, "k1", "s1");
    port.share_resolution(&links);
    (Session { port, links }, seen)
}

fn delivery(text: &str, steer: bool) -> Delivery {
    Delivery {
        expected_session: "s1".into(),
        text: text.into(),
        timing: Timing::Any,
        steer,
        fresh: true,
    }
}

#[tokio::test]
async fn missing_tern_is_refused_with_an_install_hint() {
    let tern = Tern {
        program: None,
        block_session: None,
        omp: "omp".into(),
        state: std::env::temp_dir(),
        socket: "/tmp/x.sock".into(),
        spill: std::env::temp_dir(),
        extra_flags: Vec::new(),
        agent_start: Latency::default(),
        links: Arc::default(),
    };
    let (_keep, cancel) = tokio::sync::watch::channel(false);
    let Err(StartError::Refused(reason)) = tern.start_supervised(spec("t0", None), cancel).await
    else {
        panic!("a start without Tern must be refused");
    };
    assert!(reason.contains("install Tern"), "{reason}");
}

#[tokio::test]
async fn cancelled_terminal_start_requires_a_confirmed_block_close() {
    use crate::host::startup::Cleanup;
    use std::os::unix::fs::PermissionsExt as _;

    for (exit, expected) in [(0, Cleanup::LocalReaped), (1, Cleanup::Unknown)] {
        let dir = crate::sys::fs::tests::scratch("tern-cleanup");
        let program = dir.join("tern");
        let opened = dir.join("opened");
        std::fs::write(&program, format!(
            "#!/bin/sh\ncase \"$1\" in\nnew) touch '{}'; printf '{{\"session\":1,\"tab\":2,\"block\":3}}\\n';;\nclose) exit {exit};;\nesac\n",
            opened.display(),
        )).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        let tern = Tern {
            program: Some(program),
            block_session: None,
            omp: "omp".into(),
            state: dir.to_path_buf(),
            socket: dir.join("hub.sock"),
            spill: dir.join("spill"),
            extra_flags: Vec::new(),
            agent_start: Latency::default(),
            links: Arc::default(),
        };
        let (cancel, receive) = watch::channel(false);
        let task = tokio::spawn(async move {
            tern.start_supervised(spec("cancelled", None), receive)
                .await
        });
        timeout(Duration::from_secs(10), async {
            while !opened.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        cancel.send_replace(true);
        let Err(error) = task.await.unwrap() else {
            panic!("cancelled startup bound")
        };
        assert!(
            matches!(error, StartError::Startup { cleanup, .. } if cleanup == expected),
            "{error:?}"
        );
        assert_eq!(
            super::super::lead::ownership::reconcile(&dir, "cancelled")
                .await
                .unwrap(),
            expected
        );
    }
}

#[test]
fn the_block_runs_omp_with_the_token_and_without_rpc_flags() {
    let tern = Tern {
        program: Some("/bin/tern".into()),
        block_session: Some("work".into()),
        omp: "/bin/omp".into(),
        state: "/state".into(),
        socket: "/run/hub.sock".into(),
        spill: "/state/files".into(),
        extra_flags: Vec::new(),
        agent_start: Latency::default(),
        links: Arc::default(),
    };
    let s = spec("t2", None);
    let argv = tern.argv(Path::new("/bin/tern"), &s, "tok");
    let head: Vec<&str> = argv.iter().take(5).map(String::as_str).collect();
    assert_eq!(head, ["/bin/tern", "new", "tab", "work", "--json"]);
    let at = argv.iter().position(|a| a == "--").unwrap();
    assert_eq!(argv[at + 1], "/usr/bin/env");
    assert_eq!(argv[at + 2], "CATALY_LAUNCH=tok");
    assert_eq!(argv[at + 3], "CATALY_SOCKET=/run/hub.sock");
    assert_eq!(argv[at + 4], "PI_NOTIFICATIONS=off");
    let exe = argv.iter().position(|a| a == "/bin/omp").unwrap();
    assert!(exe > at + 4);
    // The tab's inherited PI_PY/PI_JS (or a `.env` one) must not re-enable eval: pinned last.
    let pins: Vec<&str> = argv[exe - 2..exe].iter().map(String::as_str).collect();
    assert_eq!(pins, ["PI_PY=0", "PI_JS=0"]);
    assert!(!argv.iter().any(|a| a == "rpc-ui" || a == "--approval-mode"));
    assert!(argv.iter().any(|a| a == "--model=fake/primary"));
    // What Tern 0.9.36 prints for `tern new tab --json`.
    let printed = br#"{"session": 1, "tab": 8589934593, "block": 8589934594}"#;
    assert_eq!(block_id(printed).as_deref(), Some("8589934594"));
}

#[tokio::test]
async fn deliveries_go_through_the_bridge_and_not_current_keeps_them_pending() {
    let spill = crate::sys::fs::tests::scratch("tern-spill");
    let (session, seen) = bound_in(spill.to_path_buf(), |cmd| match cmd["id"].as_str() {
        Some("busy0001") => json!({ "refused": "not current" }),
        _ => json!({ "sent": true }),
    })
    .await;
    assert_eq!(session.snapshot().status, Status::Idle);
    let out = session
        .deliver(delivery("[cataly:ab12cd34] hello", false))
        .await;
    assert!(matches!(
        out,
        DeliverOutcome::Delivered {
            turn_started: true,
            ..
        }
    ));
    let first = seen.lock().unwrap()[0].clone();
    assert_eq!(
        (
            first["op"].as_str(),
            first["id"].as_str(),
            first["mode"].as_str()
        ),
        (Some("deliver"), Some("ab12cd34"), Some("wake"))
    );
    assert_eq!(first["session"], "s1");
    // OMP stores the delivery before its turn starts: working from the reply on, not idle.
    assert_eq!(session.snapshot().status, Status::Working);
    session.port.event(&json!({ "kind": "agent_start" }));
    session.port.event(&json!({ "kind": "agent_end" }));
    assert_eq!(session.snapshot().status, Status::Idle);
    // A user's switch in progress: refused "not current" and kept pending (check 2).
    let out = session
        .deliver(delivery("[cataly:busy0001] later", false))
        .await;
    assert_eq!(
        out,
        DeliverOutcome::NotReady(Status::Idle, "not current".into())
    );
    // Steering needs a running turn; another session is never written.
    assert!(matches!(
        session.deliver(delivery("x", true)).await,
        DeliverOutcome::Refused(_)
    ));
    let mut other = delivery("x", false);
    other.expected_session = "s9".into();
    assert!(matches!(
        session.deliver(other).await,
        DeliverOutcome::NotReady(..)
    ));
    // A turn starts and the session is working: a steer goes as a steer.
    session.port.event(&json!({ "kind": "agent_start" }));
    assert_eq!(session.snapshot().status, Status::Working);
    assert!(matches!(
        session
            .deliver(delivery("[cataly:5e5e5e5e] steer", true))
            .await,
        DeliverOutcome::Delivered {
            turn_started: false,
            ..
        }
    ));
    assert_eq!(seen.lock().unwrap().last().unwrap()["mode"], "steer");
    session
        .port
        .event(&json!({ "kind": "agent_end", "will_continue": false }));
    assert_eq!(session.snapshot().status, Status::Idle);
    // Over 64 KiB goes to a file the agent is pointed at.
    let big = format!("[cataly:b16b16b1]\n{}", "y".repeat(70 * 1024));
    let _ = session.deliver(delivery(&big, false)).await;
    let text = seen.lock().unwrap().last().unwrap()["text"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(text.starts_with("[cataly:b16b16b1]") && text.contains("delivery-b16b16b1.txt"));
    assert!(spill.join("delivery-b16b16b1.txt").exists());
}

#[tokio::test]
async fn interrupt_model_goal_and_shutdown_are_bridge_commands() {
    // A create is refused "busy" once (OMP restoring its saved modes), then enters goal mode.
    let refused = AtomicBool::new(false);
    let (session, seen) = bound(move |cmd| match cmd["op"].as_str() {
        Some("interrupt") => json!({ "idle": true }),
        Some("model") => {
            let mut reply = resolution(cmd["model"].as_str().unwrap(), None);
            reply["model"] = json!("fake/second");
            reply
        }
        Some("goal") if cmd["action"] == "enter" => {
            if refused.swap(true, Ordering::SeqCst) {
                json!({ "goal": { "status": "active", "objective": cmd["objective"] } })
            } else {
                json!({ "refused": "busy: The session's saved modes are still being restored" })
            }
        }
        Some("goal") => json!({ "goal": { "status": "paused" } }),
        Some("state") => json!({ "idle": true, "session": "s1", "file": "/tmp/s1.jsonl",
            "goal": { "status": "paused" } }),
        _ => json!({}),
    })
    .await;
    assert_eq!(session.interrupt().await.unwrap(), "idle");
    assert_eq!(
        session.set_model("fake/second:high").await.unwrap().model(),
        "fake/second"
    );
    assert_eq!(session.snapshot().model.as_deref(), Some("fake/second"));
    let goal = session.goal("pause", None).await.unwrap();
    assert_eq!(goal.status, GoalStatus::Paused);
    assert_eq!(
        session.goal("get", None).await.unwrap().status,
        GoalStatus::Paused
    );
    let goal = session.goal("create", Some("x")).await.unwrap();
    assert_eq!(
        (goal.status, goal.objective.as_deref()),
        (GoalStatus::Active, Some("x"))
    );
    assert!(session.goal("drop", None).await.is_err());
    let ops: Vec<String> = seen
        .lock()
        .unwrap()
        .iter()
        .map(|c| c["op"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(ops, ["interrupt", "model", "goal", "state", "goal", "goal"]);
    // Shutdown: asked, then OMP reports it is going.
    let port = Arc::clone(&session.port);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        port.event(&json!({ "kind": "session_shutdown" }));
    });
    let record = session.close(false).await.unwrap();
    assert_eq!(record.how, "clean");
    assert!(!session.alive());
}

#[tokio::test]
async fn approvals_block_and_are_never_answered_but_mirrored_forms_are() {
    let (session, seen) = bound(|_| json!({})).await;
    session
        .port
        .event(&json!({ "kind": "tool_approval_requested", "call": "c1", "tool": "bash" }));
    let snap = session.snapshot();
    assert_eq!(snap.status, Status::Blocked);
    let err = session
        .answer("s1", "c1", &json!({ "value": "Approve once" }))
        .await
        .unwrap_err();
    assert!(err.contains("person at the terminal"), "{err}");
    session
        .port
        .event(&json!({ "kind": "tool_approval_resolved", "call": "c1" }));
    assert_eq!(session.snapshot().status, Status::Idle);
    // A form the bridge offers becomes an ask dialog the relays may post (check 4).
    let input = json!({ "questions": [{ "id": "q", "question": "Color?",
        "options": [{ "label": "Red" }, { "label": "Blue" }] }] });
    let offer = session.port.form(&json!({ "call": "f1", "input": input }));
    assert_eq!(offer, json!({ "mirrored": true }));
    let snap = session.snapshot();
    assert_eq!(snap.dialogs[0].kind, DialogKind::Ask);
    assert_eq!(
        session
            .port
            .form(&json!({ "call": "f2", "input": { "questions": [] } })),
        json!({ "mirrored": false })
    );
    let answer = json!({ "answers": [{ "id": "q", "selectedOptions": ["Red"] }] });
    session.answer("s1", "f1", &answer).await.unwrap();
    let last = seen.lock().unwrap().last().unwrap().clone();
    assert_eq!(
        (last["op"].as_str(), last["call"].as_str()),
        (Some("form"), Some("f1"))
    );
    assert_eq!(session.snapshot().dialogs, Vec::<Dialog>::new());
    // The local answer won another form: the bridge reports it closed.
    session.port.form(&json!({ "call": "f3", "input": input }));
    session
        .port
        .event(&json!({ "kind": "form_closed", "call": "f3", "by": "the terminal" }));
    assert_eq!(session.snapshot().dialogs, Vec::<Dialog>::new());
}

#[tokio::test]
async fn a_silent_link_is_lost_after_45_s_and_the_same_process_restores_it() {
    let (session, _) = bound(|_| json!({})).await;
    let mut events = session.subscribe();
    session.port.detach("k1");
    assert_eq!(session.snapshot().status, Status::Unknown);
    assert!(matches!(
        session.deliver(delivery("x", false)).await,
        DeliverOutcome::NotReady(Status::Unknown, _)
    ));
    tokio::time::sleep(Duration::from_millis(400)).await;
    let (_, lost) = events.recv().await.unwrap();
    assert_eq!(lost, SessionEvent::LinkLost);
    assert!(session.snapshot().reason.clone().unwrap().contains("lost"));
    // Another process with the same token's session is refused.
    let (tx, _rx) = mpsc::channel(4);
    assert!(session.port.attach(&hello("s1", 99), "k2", tx).is_err());
    // The same process with the same session restores it (check 5).
    let (_, tx) = fake_bridge(&session.port, |_| json!({}));
    session.port.attach(&hello("s1", 42), "k3", tx).unwrap();
    let (_, restored) = events.recv().await.unwrap();
    assert_eq!(restored, SessionEvent::LinkRestored);
    assert_eq!(session.snapshot().status, Status::Idle);
    assert!(session.snapshot().reason.is_none());
    // The same process back with another session: a new identity, the old one is ended.
    session.port.detach("k3");
    let (tx, _rx) = mpsc::channel(4);
    assert!(session.port.attach(&hello("s2", 42), "k4", tx).is_err());
    assert!(!session.alive());
}

#[tokio::test]
async fn a_user_switch_moves_the_current_session_and_deliveries_follow_it() {
    let (session, _) = bound(|_| json!({ "sent": true })).await;
    session
        .port
        .event(&json!({ "kind": "session_switch", "session": "s2", "file": "/tmp/s2.jsonl" }));
    let snap = session.snapshot();
    assert_eq!(snap.session_id.as_deref(), Some("s2"));
    // A delivery recorded for s1 is not written into s2 (PATCH-01 rule 2).
    assert!(matches!(
        session.deliver(delivery("[cataly:aa] x", false)).await,
        DeliverOutcome::NotReady(..)
    ));
}

#[tokio::test]
async fn a_detached_terminal_process_exit_emits_a_confirmed_stop() {
    use crate::host::lead::ownership::Ownership;
    use crate::host::startup::Cleanup;
    let dir = crate::sys::fs::tests::scratch("tern-exited");
    let argv = ["sh".into(), "-c".into(), "read line".into()];
    let child = command::attach(&argv, Some(&dir), &[], None, 4096).unwrap();
    let owner = Arc::new(Ownership::prepare(&dir, "t1").unwrap());
    owner.spawned(child.pid()).await.unwrap();
    let (port, attached) = port();
    *port.ownership.lock().unwrap() = Some(owner);
    let (_seen, tx) = fake_bridge(&port, |_| json!({}));
    port.attach(&hello("s1", u64::from(child.pid().unwrap())), "owned", tx)
        .unwrap();
    attached.await.unwrap();
    port.bind(&spec("t1", None)).await.unwrap();
    let mut states = port.snapshot.subscribe();
    let (exit, _) = child
        .close(Duration::from_secs(1), Duration::from_secs(1))
        .await;
    assert_ne!(exit, command::Exit::Unknown);
    port.detach("owned");
    let stopped = timeout(Duration::from_secs(5), async {
        loop {
            if let Some(stop) = states.borrow_and_update().stop.clone() {
                break stop;
            }
            states.changed().await.unwrap();
        }
    })
    .await
    .expect("a proven process exit must end the session, not leave it lost");
    assert_eq!(stopped.cleanup, Cleanup::LocalReaped);
    assert_eq!(stopped.how, "exited");
}

#[tokio::test]
async fn a_failed_terminal_open_does_not_claim_no_writer_was_spawned() {
    use std::os::unix::fs::PermissionsExt as _;
    let dir = crate::sys::fs::tests::scratch("tern-open-failed");
    let program = dir.join("tern");
    std::fs::write(&program, "#!/bin/sh\nexit 7\n").unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
    let tern = Tern {
        program: Some(program),
        block_session: None,
        omp: "omp".into(),
        state: dir.to_path_buf(),
        socket: dir.join("hub.sock"),
        spill: dir.join("spill"),
        extra_flags: Vec::new(),
        agent_start: Latency::default(),
        links: Arc::default(),
    };
    let (_keep, cancel) = watch::channel(false);
    let Err(error) = tern
        .start_supervised(spec("failed-open", None), cancel)
        .await
    else {
        panic!("the terminal open failed");
    };
    assert!(
        matches!(
            error,
            StartError::Startup {
                cleanup: super::super::startup::Cleanup::Unknown,
                ..
            }
        ),
        "{error:?}"
    );
}

/// A start with a thinking suffix binds the base model at that level (HOST req. 27); a bridge
/// older than the hub leaves the model unverified at once, without a query, and the owner may
/// accept it; no model change is asked of such a bridge.
#[tokio::test]
async fn a_suffixed_selector_verifies_and_an_old_bridge_is_unverified_at_once() {
    let (current, attached) = port();
    let (_seen, tx) = fake_bridge(&current, |_| json!({}));
    current.attach(&hello("s1", 42), "k1", tx).unwrap();
    attached.await.unwrap();
    let mut high = spec("t1", None);
    high.model = "fake/primary:high".into();
    let started = current.bind(&high).await.unwrap();
    assert_eq!(started.held, None);

    let (old, attached) = port();
    let (seen, tx) = fake_bridge(&old, |_| json!({}));
    old.attach(&old_hello("s1", 42), "k1", tx).unwrap();
    attached.await.unwrap();
    let held = old.bind(&high).await.unwrap().held.unwrap();
    assert!(
        held.starts_with("model unverified") && held.contains("older than the hub"),
        "{held}"
    );
    let session = Session {
        port: old,
        links: Arc::default(),
    };
    assert!(session.snapshot().input_blocked);
    session.accept_model().unwrap();
    assert!(!session.snapshot().input_blocked);
    let refused = session.set_model("fake/second").await.unwrap_err();
    assert!(refused.contains("model unverified"), "{refused}");
    assert!(
        seen.lock().unwrap().is_empty(),
        "{:?}",
        seen.lock().unwrap()
    );
}

/// `set_model` judges OMP's resolution, not the selector's text: a literal colon ID matches
/// whole, and a level OMP clamped is a mismatch.
#[tokio::test]
async fn a_model_change_keeps_literal_ids_and_reports_a_clamped_level() {
    let (session, _) = bound(|cmd| match cmd["model"].as_str() {
        Some("ollama/qwen:14b") => json!({ "model": "ollama/qwen:14b", "model_resolution": {
            "version": 1, "selector": "ollama/qwen:14b", "provider": "ollama", "id": "qwen:14b",
            "thinking": { "requested": null, "observed": "high" } } }),
        Some(selector) => {
            let mut reply = resolution(selector, Some("medium"));
            reply["model"] = json!("fake/plain");
            reply
        }
        None => json!({}),
    })
    .await;
    assert_eq!(
        session.set_model("ollama/qwen:14b").await.unwrap().model(),
        "ollama/qwen:14b"
    );
    let clamped = session.set_model("fake/plain:high").await.unwrap_err();
    assert!(
        clamped.contains("thinking high requested, OMP reports medium"),
        "{clamped}"
    );
}

/// The lane model barrier pins what the registry holds: a confirmed change moves it there, so
/// turns on the new model flow; a refused or mismatched change leaves the old model the pin.
#[tokio::test]
async fn only_a_confirmed_model_change_moves_the_barrier_pin() {
    let (session, _) = bound(|cmd| match cmd["model"].as_str() {
        Some("fake/busy") => json!({ "refused": "busy" }),
        Some(selector) if selector.starts_with("fake/plain") => {
            let mut reply = resolution(selector, Some("medium"));
            reply["model"] = json!("fake/plain");
            reply
        }
        Some(selector) => {
            let mut reply = resolution(selector, None);
            reply["model"] = json!(selector.split(':').next().unwrap());
            reply
        }
        None => json!({}),
    })
    .await;
    let pin = |session: &Session| {
        let r = session.links.resolution("t1").unwrap();
        (r.model(), r.requested)
    };
    assert_eq!(pin(&session), ("fake/primary".into(), None));
    session.set_model("fake/second:high").await.unwrap();
    assert_eq!(
        pin(&session),
        ("fake/second".into(), Some("high".into())),
        "turns on the confirmed model flow"
    );
    session.set_model("fake/busy").await.unwrap_err();
    session.set_model("fake/plain:high").await.unwrap_err();
    assert_eq!(
        pin(&session),
        ("fake/second".into(), Some("high".into())),
        "a refused or mismatched change keeps the old model flowing"
    );
}
