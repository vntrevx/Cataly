//! Embedded, ordered migrations (DESIGN 7.2). `PRAGMA user_version` is the schema version; before
//! migrating an existing store the hub writes `VACUUM INTO <backup>/cataly-v<N>.db`. Each migration
//! says whether it is additive; a non-additive one raises the lowest schema a binary must know to open
//! the store (`meta.min_reader`). No down-migrations.

use std::path::Path;

use rusqlite::{Connection, OptionalExtension};

use super::StoreError;

struct Migration {
    sql: &'static str,
    additive: bool,
}

const MIGRATIONS: [Migration; 10] = [
    Migration {
        sql: include_str!("migrations/0001_init.sql"),
        additive: false,
    },
    Migration {
        sql: include_str!("migrations/0002_sessions.sql"),
        additive: true,
    },
    Migration {
        sql: include_str!("migrations/0003_relay.sql"),
        additive: true,
    },
    Migration {
        sql: include_str!("migrations/0004_lead.sql"),
        additive: true,
    },
    Migration {
        sql: include_str!("migrations/0005_lanes.sql"),
        additive: true,
    },
    Migration {
        sql: include_str!("migrations/0006_coord.sql"),
        additive: true,
    },
    Migration {
        sql: include_str!("migrations/0007_relays.sql"),
        additive: true,
    },
    Migration {
        sql: include_str!("migrations/0008_event_fields.sql"),
        additive: true,
    },
    Migration {
        sql: include_str!("migrations/0009_receipt_sessions.sql"),
        additive: true,
    },
    Migration {
        sql: include_str!("migrations/0010_request_admission.sql"),
        additive: true,
    },
];

/// The newest schema this binary knows.
pub(crate) fn latest() -> i64 {
    i64::try_from(MIGRATIONS.len()).unwrap_or(i64::MAX)
}

pub(crate) fn migrate(conn: &mut Connection, backup_dir: &Path) -> Result<(), StoreError> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let latest = latest();
    if current >= latest {
        return check_reader(conn, current, latest, backup_dir);
    }
    if current > 0 {
        backup(conn, current, backup_dir)?;
    }
    for (index, migration) in MIGRATIONS.iter().enumerate() {
        let version = i64::try_from(index).unwrap_or(i64::MAX) + 1;
        if version <= current {
            continue;
        }
        let tx = conn.transaction()?;
        tx.execute_batch(migration.sql)?;
        if !migration.additive {
            tx.execute(
                "INSERT INTO meta (key, value) VALUES ('min_reader', ?1) \
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                [version.to_string()],
            )?;
        }
        tx.execute_batch(&format!("PRAGMA user_version = {version}"))?;
        tx.commit()?;
    }
    Ok(())
}

fn check_reader(
    conn: &Connection,
    current: i64,
    latest: i64,
    backup_dir: &Path,
) -> Result<(), StoreError> {
    let min_reader: i64 = conn
        .query_row("SELECT value FROM meta WHERE key = 'min_reader'", [], |r| {
            r.get::<_, String>(0)
        })
        .optional()?
        .and_then(|v| v.parse().ok())
        .unwrap_or(current);
    if min_reader > latest {
        return Err(StoreError::TooNew {
            found: current,
            known: latest,
            backup: backup_dir.join(format!("cataly-v{latest}.db")),
        });
    }
    Ok(())
}

fn backup(conn: &Connection, version: i64, backup_dir: &Path) -> Result<(), StoreError> {
    crate::sys::fs::ensure_private_dir(backup_dir).map_err(|e| StoreError::Io(e.to_string()))?;
    let target = backup_dir.join(format!("cataly-v{version}.db"));
    if target.exists() {
        return Ok(());
    }
    let text = target
        .to_str()
        .ok_or_else(|| StoreError::Io("backup path is not UTF-8".into()))?;
    conn.execute("VACUUM INTO ?1", [text])?;
    crate::sys::fs::set_owner_only(&target).map_err(|e| StoreError::Io(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sys::fs::tests::scratch;

    #[test]
    fn fresh_store_reaches_latest_and_reopens() {
        let dir = scratch("schema");
        let path = dir.join("s.db");
        let mut conn = Connection::open(&path).unwrap();
        migrate(&mut conn, &dir.join("backup")).unwrap();
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, latest());
        migrate(&mut conn, &dir.join("backup")).unwrap();
        assert!(!dir.join("backup").exists(), "no backup for a fresh store");
    }

    #[test]
    fn newer_incompatible_store_is_refused_with_backup_name() {
        let dir = scratch("schema-new");
        let mut conn = Connection::open(dir.join("s.db")).unwrap();
        migrate(&mut conn, &dir.join("backup")).unwrap();
        conn.execute_batch(
            "PRAGMA user_version = 99; UPDATE meta SET value = '99' WHERE key = 'min_reader';",
        )
        .unwrap();
        let err = migrate(&mut conn, &dir.join("backup")).unwrap_err();
        assert!(matches!(err, StoreError::TooNew { found: 99, .. }));
        assert!(
            err.to_string()
                .contains(&format!("cataly-v{}.db", latest()))
        );
        // A newer store whose changes were additive stays readable.
        conn.execute_batch("UPDATE meta SET value = '1' WHERE key = 'min_reader';")
            .unwrap();
        migrate(&mut conn, &dir.join("backup")).unwrap();
    }

    #[test]
    fn legacy_work_request_admission_survives_handoff_retention() {
        let dir = scratch("schema-admission");
        let mut conn = Connection::open(dir.join("s.db")).unwrap();
        for migration in MIGRATIONS.iter().take(9) {
            conn.execute_batch(migration.sql).unwrap();
        }
        conn.execute_batch(
            "PRAGMA user_version = 9;
             INSERT INTO requests (id, title, source, created_ms, updated_ms)
                 VALUES (1, 'confirmed', 'discord:1:2', 1, 1),
                        (2, 'manual', 'discord:1:3', 1, 1);
             INSERT INTO handoffs (relay, room, message, seq, target, request_id, digest,
                                    state, answer, created_ms, updated_ms)
                 VALUES ('discord', '1', '2', 2, 'lead', 'discord:1:2', 'digest',
                         'delivered', 'posted', 1, 1);
             INSERT INTO positions (relay, room, position, updated_ms)
                 VALUES ('discord', '1', 2, 1);",
        )
        .unwrap();

        let backup = dir.join("backup");
        migrate(&mut conn, &backup).unwrap();
        let tx = conn.transaction().unwrap();
        super::super::relay::maintain(&tx, 8 * 24 * 60 * 60 * 1000).unwrap();
        tx.commit().unwrap();

        assert!(backup.join("cataly-v9.db").exists());
        let reads = super::super::Reads(conn);
        assert!(reads.handoff("discord", "1", "2").unwrap().is_none());
        assert!(reads.request(1).unwrap().unwrap().admitted);
        assert!(!reads.request(2).unwrap().unwrap().admitted);
    }

    #[test]
    fn backup_is_written_before_migrating_an_older_store() {
        let dir = scratch("schema-old");
        let conn = Connection::open(dir.join("s.db")).unwrap();
        // Simulate a store at v1 that this binary would move forward: pretend it is v0 with data.
        conn.execute_batch("CREATE TABLE t (x); PRAGMA user_version = 0;")
            .unwrap();
        backup(&conn, 0, &dir.join("backup")).unwrap();
        assert!(dir.join("backup").join("cataly-v0.db").exists());
    }
}
