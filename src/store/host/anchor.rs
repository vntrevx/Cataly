//! Positive lead binding registry; attempts cannot select or replace an identity.

use rusqlite::{OptionalExtension, Transaction, params};

use super::{HostDone, Reads, SESSION_COLUMNS, SessionRow, SessionUpdate, session_from_row};

#[derive(Debug)]
pub(crate) struct Selection {
    pub(crate) row: Option<SessionRow>,
    pub(crate) ever_started: bool,
    pub(crate) ever_bound: bool,
    pub(crate) intent: String,
    pub(crate) hold: Option<String>,
    pub(crate) provenance: Option<String>,
}

/// The opening of the hold 0011/0013 put on an anchored session ID recorded with more than one
/// transcript. An owner's `cataly lead start` lifts it once the anchored transcript verifies.
const AMBIGUOUS: &str = "ambiguous lead binding history";

/// Whether `hold` is only the ambiguity of the anchored session ID's transcripts.
pub(crate) fn ambiguous(hold: &str) -> bool {
    hold.starts_with(AMBIGUOUS)
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum Intent {
    Fresh,
    Resume,
}

pub(super) fn intent(tx: &Transaction<'_>, intent: Intent) -> rusqlite::Result<HostDone> {
    tx.execute(
        "UPDATE lead_anchor SET intent = ?1, hold = CASE WHEN ?1 = 'fresh' THEN NULL ELSE hold END WHERE singleton = 1",
        [match intent {
            Intent::Fresh => "fresh",
            Intent::Resume => "resume",
        }],
    )?;
    Ok(HostDone::Done)
}

pub(super) fn bound(
    tx: &Transaction<'_>,
    update: &SessionUpdate,
    now: i64,
) -> rusqlite::Result<HostDone> {
    let (Some(id), Some(file)) = (&update.session_id, &update.session_file) else {
        return Err(rusqlite::Error::InvalidQuery);
    };
    if update.fault.is_some() {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let done = super::update(tx, update, now)?;
    tx.execute(
        "UPDATE sessions SET fault = NULL WHERE handle = ?1",
        [&update.handle],
    )?;
    // One session ID names one transcript. A changed folder or runtime for it is a resume in a new
    // place, not another identity; a second transcript conflicts unless the owner confirmed the
    // anchored one by resuming it.
    let written = tx.execute(
        "INSERT INTO lead_bindings(handle, session_id, session_file, cwd, runtime, provenance, bound_ms) \
         SELECT handle, ?2, ?3, cwd, runtime, \
         CASE runtime WHEN 'headless' THEN 'two exact get_state identities and accepted model' \
         ELSE 'validated terminal bridge identity and accepted model' END, ?4 \
         FROM sessions WHERE handle = ?1 AND role = 'lead' AND NOT EXISTS ( \
             SELECT 1 FROM lead_bindings b WHERE b.session_id = ?2 AND b.session_file <> ?3 \
             AND NOT EXISTS(SELECT 1 FROM lead_anchor a JOIN lead_bindings x ON x.handle = a.handle \
                 WHERE x.session_id = ?2 AND x.session_file = ?3))",
        params![update.handle, id, file, now])?;
    if written != 1 {
        return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
            std::io::Error::other("lead binding conflicts with previously proven identity"),
        )));
    }
    tx.execute("UPDATE lead_anchor SET handle = ?1, ever_started = 1, intent = 'resume', hold = NULL WHERE singleton = 1", [&update.handle])?;
    tx.execute(
        "UPDATE startup_episodes SET state = 'bound', next_ms = NULL WHERE target = 'lead'",
        [],
    )?;
    Ok(done)
}

/// A continuation replaces the current anchor's identity, never a newer launch's anchor.
/// The binding and session row move together, including selection by a configured session ID.
/// The original launch's ownership provenance, runtime and binding time stay unchanged.
pub(super) fn continued(
    tx: &Transaction<'_>,
    update: &SessionUpdate,
    now: i64,
) -> rusqlite::Result<HostDone> {
    let (Some(id), Some(file)) = (&update.session_id, &update.session_file) else {
        return Err(rusqlite::Error::InvalidQuery);
    };
    let changed = tx.execute(
        "UPDATE lead_bindings SET session_id = ?2, session_file = ?3 WHERE handle = ?1 \
         AND EXISTS(SELECT 1 FROM lead_anchor WHERE handle = ?1) \
         AND NOT EXISTS(SELECT 1 FROM lead_bindings WHERE session_id = ?2 AND session_file <> ?3)",
        params![update.handle, id, file],
    )?;
    if changed != 1 {
        // A verified move keeps the ID. Relocate its earlier bindings too, so a later pin does
        // not mistake launch history for multiple transcripts. Never touch another identity.
        let previous: String = tx.query_row(
            "SELECT session_file FROM lead_bindings WHERE handle = ?1 AND session_id = ?2 \
             AND EXISTS(SELECT 1 FROM lead_anchor WHERE handle = ?1)",
            params![update.handle, id],
            |row| row.get(0),
        )?;
        let changed = tx.execute(
            "UPDATE lead_bindings SET session_file = ?2 WHERE session_id = ?1 AND session_file = ?3 \
             AND NOT EXISTS(SELECT 1 FROM lead_bindings WHERE session_id = ?1 \
                 AND session_file NOT IN (?2, ?3))",
            params![id, file, previous],
        )?;
        if changed == 0 {
            return Err(rusqlite::Error::InvalidQuery);
        }
        tx.execute(
            "UPDATE sessions SET session_file = ?2 WHERE session_id = ?1 AND session_file = ?3 \
             AND handle IN (SELECT handle FROM lead_bindings WHERE session_id = ?1 AND session_file = ?2)",
            params![id, file, previous],
        )?;
    }
    super::update(tx, update, now)
}

/// Pins name a session ID, whose latest row per exact tuple is retained along with the current anchor.
pub(super) fn maintain(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute(
        "DELETE FROM lead_bindings AS old \
         WHERE old.handle NOT IN (SELECT handle FROM lead_anchor WHERE handle IS NOT NULL) \
         AND EXISTS(SELECT 1 FROM lead_bindings newer \
             WHERE newer.session_id = old.session_id AND newer.session_file = old.session_file \
             AND newer.cwd = old.cwd AND newer.runtime = old.runtime \
             AND (newer.bound_ms, newer.rowid) > (old.bound_ms, old.rowid))",
        [],
    )?;
    Ok(())
}

impl Reads {
    /// The only resolver for current and pinned lead identity. Unbound attempts are never candidates.
    pub(crate) fn lead_target(&self, pin: Option<&str>) -> rusqlite::Result<Selection> {
        let (current, ever_started, intent, mut hold): (
            Option<String>,
            bool,
            String,
            Option<String>,
        ) = self.0.query_row(
            "SELECT handle, ever_started, intent, hold FROM lead_anchor WHERE singleton = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
        let handle = match pin {
            None => current,
            Some(id) => {
                let anchored = match &current {
                    Some(handle) => self
                        .0
                        .query_row(
                            "SELECT session_id = ?2 FROM lead_bindings WHERE handle = ?1",
                            params![handle, id],
                            |r| r.get::<_, bool>(0),
                        )
                        .optional()?
                        .unwrap_or(false),
                    None => false,
                };
                if anchored {
                    // The anchor is this ID's newest binding, held or not as the anchor is.
                    current
                } else {
                    let files: i64 = self.0.query_row(
                        "SELECT COUNT(DISTINCT session_file) FROM lead_bindings WHERE session_id = ?1",
                        [id],
                        |r| r.get(0),
                    )?;
                    if files == 1 {
                        hold = None;
                        self.0.query_row("SELECT handle FROM lead_bindings WHERE session_id = ?1 ORDER BY bound_ms DESC, rowid DESC LIMIT 1", [id], |r| r.get(0)).optional()?
                    } else {
                        hold = Some(format!(
                            "required lead session {id} has {files} proven transcripts; held, never substituted"
                        ));
                        None
                    }
                }
            }
        };
        let provenance = match &handle {
            Some(handle) => self
                .0
                .query_row(
                    "SELECT provenance FROM lead_bindings WHERE handle = ?1",
                    [handle],
                    |r| r.get(0),
                )
                .optional()?,
            None => None,
        };
        let row = match handle {
            None => None,
            Some(handle) => self
                .0
                .query_row(
                    &format!("SELECT {SESSION_COLUMNS} FROM sessions WHERE handle = ?1"),
                    [handle],
                    session_from_row,
                )
                .optional()?,
        };
        if self.0.query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions s WHERE s.role = 'lead' AND s.session_id IS NULL \
             AND s.state IN ('starting', 'held', 'orphan_held') AND NOT EXISTS( \
                 SELECT 1 FROM lead_anchor a JOIN sessions b ON b.handle = a.handle \
                 WHERE (b.started_ms, b.rowid) >= (s.started_ms, s.rowid)))",
            [],
            |r| r.get::<_, bool>(0),
        )? {
            hold = Some("an earlier unbound lead attempt has unknown process ownership; held until its exit is reconciled".into());
        }
        let ever_bound = self.0.query_row(
            "SELECT EXISTS(SELECT 1 FROM lead_bindings) OR EXISTS(SELECT 1 FROM sessions WHERE role = 'lead' AND session_id IS NOT NULL)",
            [], |r| r.get(0),
        )?;
        Ok(Selection {
            row,
            ever_started,
            ever_bound,
            intent,
            hold,
            provenance,
        })
    }

    /// Current/pinned bindings, any lane record and the episode containing an attempt retain it.
    pub(crate) fn startup_referenced(
        &self,
        handle: &str,
        session: Option<&str>,
        created_ms: i64,
    ) -> rusqlite::Result<bool> {
        self.0.query_row(
            "SELECT EXISTS(SELECT 1 FROM lead_bindings WHERE handle = ?1) \
             OR EXISTS(SELECT 1 FROM lanes WHERE json_extract(record, '$.handle') = ?1) \
             OR EXISTS(SELECT 1 FROM startup_episodes WHERE session_id = ?2 AND started_ms <= ?3)",
            params![handle, session, created_ms],
            |r| r.get(0),
        )
    }
}

#[cfg(test)]
#[path = "anchor_tests.rs"]
mod tests;
