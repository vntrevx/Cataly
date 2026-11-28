use super::*;
use crate::sys::command;
use std::time::Duration;

#[tokio::test]
async fn prebind_crash_reconciliation_requires_the_recorded_process_to_exit() {
    let dir = crate::sys::fs::tests::scratch("startup-owner");
    assert_eq!(reconcile(&dir, "missing").await.unwrap(), Cleanup::Unknown);
    let owner = Ownership::prepare(&dir, "attempt").unwrap();
    let argv = ["sh".into(), "-c".into(), "read line".into()];
    let child = command::attach(&argv, Some(&dir), &[], None, 4096).unwrap();
    owner.spawned(child.pid()).await.unwrap();
    assert_eq!(reconcile(&dir, "attempt").await.unwrap(), Cleanup::Unknown);
    let (exit, _) = child
        .close(Duration::from_secs(1), Duration::from_secs(1))
        .await;
    assert_ne!(exit, command::Exit::Unknown);
    // No finish receipt: this is the hub-crash path, reconciled from process birth identity.
    assert_eq!(
        reconcile(&dir, "attempt").await.unwrap(),
        Cleanup::LocalReaped
    );
}

#[tokio::test]
async fn only_a_worker_reap_confirms_a_remote_attempt() {
    use crate::host::lead::Lease;
    let reaped = |exit| AttemptState::Reaped {
        exit,
        lease: Lease::Unknown,
    };
    for exit in [Reaped::Code(0), Reaped::Signal(9), Reaped::Gone] {
        assert_eq!(worker_cleanup(&reaped(exit)), Cleanup::WorkerReaped);
    }
    assert_eq!(
        worker_cleanup(&reaped(Reaped::NotSpawned)),
        Cleanup::NotSpawned
    );
    assert_eq!(
        worker_cleanup(&AttemptState::Running { pid: 7 }),
        Cleanup::Unknown
    );
    let unknown = AttemptState::Unknown {
        reason: "the worker connection ended before the exit acknowledgement".into(),
    };
    assert_eq!(worker_cleanup(&unknown), Cleanup::Unknown);
    // A worker that cannot be asked is unknown ownership, never an exit.
    let dir = crate::sys::fs::tests::scratch("startup-owner-remote");
    let asked = reconcile_attempt(&dir, "attempt", Some("box")).await;
    assert!(
        asked
            .as_ref()
            .is_err_and(|e| e.contains("ownership of attempt attempt on box is unknown")),
        "{asked:?}"
    );
    assert_eq!(
        reconcile_attempt(&dir, "missing", None).await.unwrap(),
        Cleanup::Unknown
    );
}

/// Tern's close only asks the block to end: a terminal cleanup is confirmed once the recorded
/// process is gone, never while it still runs, and OMP exiting by itself within the grace needs no
/// close at all.
#[tokio::test]
async fn a_terminal_close_is_confirmed_only_by_the_process_exit() {
    use std::os::unix::fs::PermissionsExt as _;
    let dir = crate::sys::fs::tests::scratch("terminal-close");
    let (calls, target) = (dir.join("calls"), dir.join("pid"));
    let tern = dir.join("tern");
    // The stand-in's close signals the block's process and returns at once.
    std::fs::write(
        &tern,
        format!(
            "#!/bin/sh\necho \"$*\" >> '{}'\nread pid < '{}'\nkill -TERM \"$pid\"\n",
            calls.display(),
            target.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&tern, std::fs::Permissions::from_mode(0o700)).unwrap();
    let slow_to_end = "trap 'sleep 0.5; exit 0' TERM; while :; do sleep 0.1; done";
    // The second process ends by itself once its input closes, which happens only after its
    // identity is recorded: a timed one could end first on a loaded runner, leaving no identity.
    for (script, grace, closed) in [
        (slow_to_end, Duration::ZERO, true),
        ("read line", Duration::from_secs(5), false),
    ] {
        let _ = std::fs::remove_file(&calls);
        let mut child = std::process::Command::new("sh")
            .args(["-c", script])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let pid = child.id();
        let input = child.stdin.take();
        std::fs::write(&target, pid.to_string()).unwrap();
        let reaper = std::thread::spawn(move || child.wait());
        let owner = Ownership::prepare(&dir, &format!("terminal-{pid}")).unwrap();
        owner.spawned(Some(pid)).await.unwrap();
        owner.terminal(&tern, "block").unwrap();
        drop(input);
        assert_eq!(
            owner.close_terminal(grace).await.unwrap(),
            Cleanup::LocalReaped
        );
        assert_eq!(birth(pid).await.unwrap(), None, "confirmed while it ran");
        assert_eq!(calls.exists(), closed, "{script}");
        reaper.join().unwrap().unwrap();
    }
}

/// A hub that stopped during a Tern start before the bridge hello recorded only the block: its
/// reconciliation is a confirmed close of that block, or Tern's answer that it has no such block
/// (it already ended), kept once confirmed. Any other refusal stays unknown.
#[tokio::test]
async fn a_block_without_its_process_is_reconciled_by_its_close_or_its_absence() {
    use std::os::unix::fs::PermissionsExt as _;
    let dir = crate::sys::fs::tests::scratch("prehello-block");
    let calls = dir.join("calls");
    // Tern 0.9.36's answers to `tern close BLOCK`.
    let cases = [
        (
            "down",
            "echo 'tern close: no Tern is running (no session daemon on /run/tern.sock)' >&2; exit 1",
            Cleanup::Unknown,
        ),
        (
            "absent",
            "echo 'tern close: no block is called `8589934594`' >&2; exit 1",
            Cleanup::LocalReaped,
        ),
        ("closed", "exit 0", Cleanup::LocalReaped),
    ];
    for (name, answer, expected) in cases {
        let tern = dir.join(format!("tern-{name}"));
        std::fs::write(
            &tern,
            format!(
                "#!/bin/sh\necho \"$*\" >> '{}'\n{answer}\n",
                calls.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&tern, std::fs::Permissions::from_mode(0o700)).unwrap();
        let handle = format!("prehello-{name}");
        let owner = Ownership::prepare(&dir, &handle).unwrap();
        owner.terminal(&tern, "8589934594").unwrap();
        drop(owner);
        assert_eq!(reconcile(&dir, &handle).await.unwrap(), expected, "{name}");
    }
    assert_eq!(
        std::fs::read_to_string(&calls).unwrap(),
        "close 8589934594\n".repeat(3)
    );
    // A confirmed cleanup is kept: no second close.
    for name in ["absent", "closed"] {
        assert_eq!(
            reconcile(&dir, &format!("prehello-{name}")).await.unwrap(),
            Cleanup::LocalReaped
        );
    }
    assert_eq!(std::fs::read_to_string(&calls).unwrap().lines().count(), 3);
}
