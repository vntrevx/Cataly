use super::*;
use crate::store::host::{HostWrite, maintain, write};
use rusqlite::Connection;

fn database() -> Connection {
    let mut db = Connection::open_in_memory().unwrap();
    crate::store::schema::migrate(&mut db, std::path::Path::new("/unused")).unwrap();
    db
}

fn attempt(db: &mut Connection, handle: &str, mode: &str, now: i64) {
    let tx = db.transaction().unwrap();
    write(
        &tx,
        &HostWrite::Record(SessionRow {
            handle: handle.into(),
            role: "lead".into(),
            runtime: "headless".into(),
            cwd: "/work".into(),
            name: "lead".into(),
            model: "fake/primary".into(),
            thinking: None,
            mode: mode.into(),
            expected_id: None,
            expected_file: None,
            state: "failed".into(),
            session_id: None,
            session_file: None,
            pid: None,
            started_ms: now,
            updated_ms: now,
            stop_how: None,
            stop_detail: None,
            stop_ms: None,
            fault: None,
        }),
        now,
    )
    .unwrap();
    tx.commit().unwrap();
}

fn bind(db: &mut Connection, handle: &str, id: &str, now: i64) {
    let tx = db.transaction().unwrap();
    bound(
        &tx,
        &SessionUpdate {
            handle: handle.into(),
            state: Some("stopped".into()),
            session_id: Some(id.into()),
            session_file: Some(format!("/sessions/{id}.jsonl")),
            ..SessionUpdate::default()
        },
        now,
    )
    .unwrap();
    tx.commit().unwrap();
}

#[test]
fn a_continued_identity_moves_the_anchor_and_its_pin_together() {
    let mut db = database();
    attempt(&mut db, "lead", "fresh", 1);
    bind(&mut db, "lead", "original", 2);
    let tx = db.transaction().unwrap();
    continued(
        &tx,
        &SessionUpdate {
            handle: "lead".into(),
            session_id: Some("fork".into()),
            session_file: Some("/sessions/fork.jsonl".into()),
            ..SessionUpdate::default()
        },
        3,
    )
    .unwrap();
    tx.commit().unwrap();
    let reads = Reads(db);
    for pin in [None, Some("fork")] {
        let selected = reads.lead_target(pin).unwrap();
        assert!(selected.hold.is_none(), "{selected:?}");
        let row = selected.row.unwrap();
        assert_eq!(row.session_id.as_deref(), Some("fork"));
        assert_eq!(row.session_file.as_deref(), Some("/sessions/fork.jsonl"));
    }
}

#[test]
fn a_moved_identity_keeps_binding_history_unambiguous() {
    let mut db = database();
    attempt(&mut db, "old", "fresh", 1);
    bind(&mut db, "old", "original", 2);
    attempt(&mut db, "current", "resume", 3);
    bind(&mut db, "current", "original", 4);
    let tx = db.transaction().unwrap();
    continued(
        &tx,
        &SessionUpdate {
            handle: "current".into(),
            session_id: Some("original".into()),
            session_file: Some("/moved/original.jsonl".into()),
            ..SessionUpdate::default()
        },
        5,
    )
    .unwrap();
    tx.commit().unwrap();
    // The moved identity must remain selectable after a later fresh launch, not look like two files.
    attempt(&mut db, "fresh", "fresh", 6);
    bind(&mut db, "fresh", "other", 7);
    let selected = Reads(db).lead_target(Some("original")).unwrap();
    assert!(selected.hold.is_none(), "{selected:?}");
    let row = selected.row.unwrap();
    assert_eq!(row.handle, "current");
    assert_eq!(row.session_file.as_deref(), Some("/moved/original.jsonl"));
}

#[test]
fn a_continuation_preserves_launch_ownership_evidence() {
    let mut db = database();
    attempt(&mut db, "lead", "fresh", 1);
    bind(&mut db, "lead", "original", 2);
    let evidence = |db: &Connection| -> (String, String, i64) {
        db.query_row(
            "SELECT runtime, provenance, bound_ms FROM lead_bindings WHERE handle = 'lead'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap()
    };
    let before = evidence(&db);
    let tx = db.transaction().unwrap();
    continued(
        &tx,
        &SessionUpdate {
            handle: "lead".into(),
            session_id: Some("fork".into()),
            session_file: Some("/sessions/fork.jsonl".into()),
            ..SessionUpdate::default()
        },
        3,
    )
    .unwrap();
    tx.commit().unwrap();
    assert_eq!(
        evidence(&db),
        before,
        "a continuation is not a new verified launch"
    );
}

#[test]
fn failed_attempt_and_retention_never_replace_the_anchor() {
    let mut db = database();
    attempt(&mut db, "bound", "fresh", 1);
    bind(&mut db, "bound", "A", 1);
    attempt(&mut db, "timeout", "resume", 2);
    let tx = db.transaction().unwrap();
    maintain(&tx, 32 * 24 * 3600 * 1000).unwrap();
    tx.commit().unwrap();
    let selected = Reads(db).lead_target(None).unwrap();
    assert_eq!(selected.row.unwrap().session_id.as_deref(), Some("A"));
    assert_eq!(selected.intent, "resume");
}

#[test]
fn pins_select_older_bindings_and_failed_fresh_requires_owner_choice() {
    let mut db = database();
    attempt(&mut db, "a", "fresh", 1);
    bind(&mut db, "a", "A", 1);
    attempt(&mut db, "b", "fresh", 1);
    bind(&mut db, "b", "B", 1);
    attempt(&mut db, "failed-fresh", "fresh", 2);
    let reads = Reads(db);
    let pinned = reads.lead_target(Some("A")).unwrap();
    assert_eq!(pinned.row.unwrap().handle, "a");
    let current = reads.lead_target(None).unwrap();
    assert_eq!(current.row.unwrap().session_id.as_deref(), Some("B"));
    assert_eq!(current.intent, "fresh_failed");
    assert!(reads.lead_target(Some("missing")).unwrap().hold.is_some());
}

#[test]
fn a_changed_folder_is_history_and_a_second_transcript_holds_a_pinned_id() {
    let mut db = database();
    attempt(&mut db, "a", "fresh", 1);
    bind(&mut db, "a", "A", 1);
    attempt(&mut db, "b", "resume", 2);
    bind(&mut db, "b", "A", 2);
    db.execute(
        "UPDATE lead_bindings SET cwd = '/other', runtime = 'tern' WHERE handle = 'a'",
        [],
    )
    .unwrap();
    attempt(&mut db, "c", "fresh", 3);
    bind(&mut db, "c", "C", 3);
    let selected = Reads(db).lead_target(Some("A")).unwrap();
    assert!(selected.hold.is_none(), "{selected:?}");
    assert_eq!(selected.row.unwrap().handle, "b");
    let mut db = database();
    attempt(&mut db, "a", "fresh", 1);
    bind(&mut db, "a", "A", 1);
    attempt(&mut db, "b", "resume", 2);
    bind(&mut db, "b", "A", 2);
    db.execute(
        "UPDATE lead_bindings SET session_file = '/other.jsonl' WHERE handle = 'a'",
        [],
    )
    .unwrap();
    attempt(&mut db, "c", "fresh", 3);
    bind(&mut db, "c", "C", 3);
    let tx = db.transaction().unwrap();
    maintain(&tx, 4).unwrap();
    tx.commit().unwrap();
    let selected = Reads(db).lead_target(Some("A")).unwrap();
    assert!(selected.row.is_none());
    assert!(selected.hold.unwrap().contains("2 proven transcripts"));
}

#[test]
fn an_uncommitted_binding_cannot_advance_identity() {
    let mut db = database();
    attempt(&mut db, "a", "fresh", 1);
    bind(&mut db, "a", "A", 1);
    attempt(&mut db, "bad", "fresh", 2);
    let tx = db.transaction().unwrap();
    assert!(
        bound(
            &tx,
            &SessionUpdate {
                handle: "bad".into(),
                session_id: Some("B".into()),
                session_file: Some("/b".into()),
                fault: Some("model mismatch".into()),
                ..SessionUpdate::default()
            },
            2
        )
        .is_err()
    );
    tx.rollback().unwrap();
    assert_eq!(
        Reads(db)
            .lead_target(None)
            .unwrap()
            .row
            .unwrap()
            .session_id
            .as_deref(),
        Some("A")
    );
}

fn migrate_history(db: &Connection) {
    db.execute_batch(
        "DROP TABLE lead_anchor; DROP TABLE lead_bindings; DROP TABLE startup_episodes;",
    )
    .unwrap();
    db.execute_batch(include_str!("../migrations/0011_lead_anchor.sql"))
        .unwrap();
}

#[test]
fn migration_preserves_fresh_intent_behind_a_newer_failed_resume() {
    let mut db = database();
    attempt(&mut db, "a", "fresh", 1);
    bind(&mut db, "a", "A", 1);
    attempt(&mut db, "fresh-request", "fresh", 2);
    attempt(&mut db, "later-timeout", "resume", 3);
    migrate_history(&db);
    let selected = Reads(db).lead_target(None).unwrap();
    assert_eq!(selected.row.unwrap().session_id.as_deref(), Some("A"));
    assert_eq!(selected.intent, "fresh_failed");
}

#[test]
fn migration_orders_equal_timestamps_by_rowid_and_accepts_an_exact_pin() {
    let mut db = database();
    attempt(&mut db, "a", "fresh", 1);
    bind(&mut db, "a", "A", 1);
    attempt(&mut db, "b", "fresh", 1);
    bind(&mut db, "b", "B", 1);
    migrate_history(&db);
    let reads = Reads(db);
    let current = reads.lead_target(None).unwrap();
    assert!(current.hold.is_none());
    assert_eq!(current.row.unwrap().session_id.as_deref(), Some("B"));
    let pinned = reads.lead_target(Some("A")).unwrap();
    assert!(pinned.hold.is_none());
    assert_eq!(pinned.row.unwrap().session_id.as_deref(), Some("A"));
}

#[test]
fn migration_keeps_the_latest_of_successive_conversations() {
    let mut db = database();
    for (handle, id, mode, now) in [
        ("a1", "A", "fresh", 1),
        ("a2", "A", "resume", 2),
        ("b1", "B", "fresh", 3),
        ("b2", "B", "resume", 4),
    ] {
        attempt(&mut db, handle, mode, now);
        bind(&mut db, handle, id, now);
        db.execute(
            "UPDATE sessions SET expected_id = session_id, expected_file = session_file WHERE handle = ?1 AND mode = 'resume'",
            [handle],
        ).unwrap();
    }
    migrate_history(&db);
    let selected = Reads(db).lead_target(None).unwrap();
    assert!(selected.hold.is_none(), "{selected:?}");
    assert_eq!(selected.row.unwrap().handle, "b2");
}

fn fault_model_mismatch(db: &Connection, handle: &str) {
    db.execute(
        "UPDATE sessions SET fault = 'model mismatch: wanted fake/primary:high, got fake/primary' WHERE handle = ?1",
        [handle],
    )
    .unwrap();
}

#[test]
fn migration_binds_conversations_whose_every_start_recorded_a_model_mismatch() {
    let mut db = database();
    for (handle, mode, now) in [("a1", "fresh", 1), ("a2", "resume", 2)] {
        attempt(&mut db, handle, mode, now);
        bind(&mut db, handle, "A", now);
        db.execute(
            "UPDATE sessions SET expected_id = session_id, expected_file = session_file WHERE handle = ?1 AND mode = 'resume'",
            [handle],
        )
        .unwrap();
        fault_model_mismatch(&db, handle);
    }
    migrate_history(&db);
    let reads = Reads(db);
    let current = reads.lead_target(None).unwrap();
    assert!(current.hold.is_none(), "{current:?}");
    assert!(current.ever_bound);
    assert_eq!(
        current.provenance.as_deref(),
        Some("migrated exact binding; model unverified")
    );
    assert_eq!(current.row.unwrap().handle, "a2");
    let pinned = reads.lead_target(Some("A")).unwrap();
    assert!(pinned.hold.is_none(), "{pinned:?}");
    assert_eq!(pinned.row.unwrap().session_id.as_deref(), Some("A"));
}

#[test]
fn migration_keeps_a_fresh_switch_recorded_under_a_model_mismatch() {
    let mut db = database();
    attempt(&mut db, "a", "fresh", 1);
    bind(&mut db, "a", "A", 1);
    attempt(&mut db, "b", "fresh", 2);
    bind(&mut db, "b", "B", 2);
    fault_model_mismatch(&db, "b");
    migrate_history(&db);
    let current = Reads(db).lead_target(None).unwrap();
    assert!(current.hold.is_none(), "{current:?}");
    assert_eq!(current.row.unwrap().session_id.as_deref(), Some("B"));
}

#[test]
fn explicit_fresh_intent_lifts_a_migrated_unbound_hold() {
    let mut db = database();
    attempt(&mut db, "only-failed-resume", "resume", 1);
    migrate_history(&db);
    let mut reads = Reads(db);
    assert!(reads.lead_target(None).unwrap().hold.is_some());
    let tx = reads.0.transaction().unwrap();
    intent(&tx, Intent::Fresh).unwrap();
    tx.commit().unwrap();
    let selected = reads.lead_target(None).unwrap();
    assert!(selected.hold.is_none(), "{selected:?}");
    assert_eq!(selected.intent, "fresh");
    assert!(selected.row.is_none());
}

#[test]
fn explicit_fresh_binding_supersedes_only_older_unknown_attempt_holds() {
    let mut db = database();
    attempt(&mut db, "old", "fresh", 1);
    bind(&mut db, "old", "A", 1);
    attempt(&mut db, "unknown-old", "resume", 2);
    db.execute(
        "UPDATE sessions SET state = 'held' WHERE handle = 'unknown-old'",
        [],
    )
    .unwrap();
    let mut reads = Reads(db);
    assert!(reads.lead_target(None).unwrap().hold.is_some());
    attempt(&mut reads.0, "chosen-fresh", "fresh", 3);
    bind(&mut reads.0, "chosen-fresh", "B", 3);
    assert!(reads.lead_target(None).unwrap().hold.is_none());
    let retained: String = reads
        .0
        .query_row(
            "SELECT state FROM sessions WHERE handle = 'unknown-old'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        retained, "held",
        "the old uncertain ownership record remains"
    );
    attempt(&mut reads.0, "unknown-new", "resume", 4);
    reads
        .0
        .execute(
            "UPDATE sessions SET state = 'held' WHERE handle = 'unknown-new'",
            [],
        )
        .unwrap();
    assert!(reads.lead_target(None).unwrap().hold.is_some());
}

/// 0.2.6 lead start rows `(handle, id, file, cwd, mode)` in order, bound as 0.2.6 recorded them
/// (no `lead_bindings` yet).
fn history(db: &mut Connection, rows: &[(&str, &str, &str, &str, &str)]) {
    for (now, &(handle, id, file, cwd, mode)) in (1..).zip(rows) {
        attempt(db, handle, mode, now);
        db.execute(
            "UPDATE sessions SET session_id = ?2, session_file = ?3, cwd = ?4, state = 'stopped', \
             expected_id = CASE mode WHEN 'resume' THEN ?2 END, \
             expected_file = CASE mode WHEN 'resume' THEN ?3 END WHERE handle = ?1",
            [handle, id, file, cwd],
        )
        .unwrap();
    }
}

/// 0.2.7 migrated the 0.2.6 history (0011 and 0012, schema 12); this binary opens that store.
fn upgrade(db: &mut Connection, name: &str) {
    migrate_history(db);
    db.execute_batch("PRAGMA user_version = 12").unwrap();
    let backups = crate::sys::fs::tests::scratch(name);
    crate::store::schema::migrate(db, &backups).unwrap();
}

/// The owner's history: conversation A, then B started in `~` and resumed 11 times in `~/tmp`
/// (same transcript, same runtime). The upgrade resumes B in `~/tmp`, and B binds again anywhere.
#[test]
fn an_upgrade_resumes_the_newest_binding_of_a_conversation_whose_folder_changed() {
    let mut db = database();
    let tmp: Vec<String> = (0..11).map(|n| format!("b-tmp-{n}")).collect();
    let mut rows = vec![
        ("a", "A", "/sessions/A.jsonl", "/home/o", "fresh"),
        ("b", "B", "/sessions/B.jsonl", "/home/o", "fresh"),
    ];
    let b = "/sessions/B.jsonl";
    for handle in &tmp {
        rows.push((handle.as_str(), "B", b, "/home/o/tmp", "resume"));
    }
    history(&mut db, &rows);
    upgrade(&mut db, "anchor-changed-cwd");
    let mut reads = Reads(db);
    let current = reads.lead_target(None).unwrap();
    assert!(current.hold.is_none(), "{current:?}");
    let row = current.row.unwrap();
    assert_eq!(
        (row.handle.as_str(), row.cwd.as_str()),
        ("b-tmp-10", "/home/o/tmp")
    );
    let pinned = reads.lead_target(Some("B")).unwrap();
    assert!(pinned.hold.is_none(), "{pinned:?}");
    assert_eq!(pinned.row.unwrap().handle, "b-tmp-10");
    // The next resume binds B in yet another folder.
    attempt(&mut reads.0, "b-next", "resume", 20);
    bind(&mut reads.0, "b-next", "B", 20);
    let next = reads.lead_target(None).unwrap();
    assert!(next.hold.is_none(), "{next:?}");
    assert_eq!(next.row.unwrap().handle, "b-next");
}

/// Two transcripts claiming the anchored ID still hold, naming the anchored one; the owner's
/// resume of exactly that transcript binds and lifts the hold, and the other one never binds.
#[test]
fn two_transcripts_for_the_anchored_id_hold_until_its_anchored_transcript_binds() {
    let mut db = database();
    history(
        &mut db,
        &[
            ("a", "A", "/sessions/A.jsonl", "/home/o", "fresh"),
            ("b-old", "B", "/sessions/B-copy.jsonl", "/home/o", "fresh"),
            ("b", "B", "/sessions/B.jsonl", "/home/o/tmp", "resume"),
        ],
    );
    upgrade(&mut db, "anchor-two-files");
    let mut reads = Reads(db);
    let current = reads.lead_target(None).unwrap();
    let hold = current.hold.clone().unwrap();
    assert!(hold.starts_with("ambiguous lead binding history"), "{hold}");
    assert!(
        hold.contains("`cataly lead start` resumes") && hold.contains("/sessions/B.jsonl"),
        "{hold}"
    );
    assert!(!hold.contains("--fresh"), "{hold}");
    assert_eq!(current.row.unwrap().handle, "b");
    let pinned = reads.lead_target(Some("B")).unwrap();
    assert_eq!(pinned.hold.as_deref(), Some(hold.as_str()));
    assert_eq!(pinned.row.unwrap().handle, "b");
    attempt(&mut reads.0, "copy", "resume", 10);
    let tx = reads.0.transaction().unwrap();
    assert!(
        bound(
            &tx,
            &SessionUpdate {
                handle: "copy".into(),
                session_id: Some("B".into()),
                session_file: Some("/sessions/B-copy.jsonl".into()),
                ..SessionUpdate::default()
            },
            10
        )
        .is_err()
    );
    tx.rollback().unwrap();
    attempt(&mut reads.0, "b-resumed", "resume", 11);
    bind(&mut reads.0, "b-resumed", "B", 11);
    let resumed = reads.lead_target(None).unwrap();
    assert!(resumed.hold.is_none(), "{resumed:?}");
    assert_eq!(resumed.row.unwrap().handle, "b-resumed");
}

/// An older conversation's two transcripts never hold the current, unrelated lead.
#[test]
fn an_old_conversations_two_transcripts_do_not_hold_the_current_lead() {
    let mut db = database();
    history(
        &mut db,
        &[
            ("a", "A", "/sessions/A.jsonl", "/home/o", "fresh"),
            ("a-copy", "A", "/sessions/A-copy.jsonl", "/home/o", "fresh"),
            ("b", "B", "/sessions/B.jsonl", "/home/o", "fresh"),
        ],
    );
    upgrade(&mut db, "anchor-old-oddity");
    let reads = Reads(db);
    let current = reads.lead_target(None).unwrap();
    assert!(current.hold.is_none(), "{current:?}");
    assert_eq!(current.row.unwrap().handle, "b");
    assert!(reads.lead_target(Some("A")).unwrap().hold.is_some());
}
