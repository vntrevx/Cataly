//! An accepted reopen outlives its requester and hub: one episode, one run and one ledgered note.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::time::Instant;

use super::record::State;
use super::{Lanes, replies::Reply, startup::Ownership};
use crate::host::Runtime;
use crate::host::inbox::ReceiptState;
use crate::host::startup::Recovery;
use crate::sys::now_ms;

#[path = "reopen_record.rs"]
mod record;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct Pending {
    /// Together with the lane target, this identifies the durable recovery episode.
    pub(super) episode_ms: i64,
    note: Option<String>,
    step: Step,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Step {
    Starting { run_id: String },
    RunCommitted,
}

impl<R: Runtime> Lanes<R> {
    pub(super) async fn reopen_task(
        self: &Arc<Self>,
        key: &str,
        note: Option<&str>,
        reply: &mut Reply,
    ) -> Result<String, String> {
        self.starts.cancel(key);
        self.starts.wait(Some(key)).await;
        let _turn = self.turn(key).await?;
        let (mut rec, rev) = self.load(key).await?;
        let parked_held =
            rec.state == State::Held && rec.intent.as_ref().is_some_and(|i| i.outcome == "parked");
        if rec.state != State::Closed
            && !parked_held
            && rec.lost.is_none()
            && rec.pending_reopen.is_none()
        {
            return Err("only a closed, lost or parked lane is reopened".into());
        }
        if let Some(pending) = &rec.pending_reopen
            && note.is_some()
            && note != pending.note.as_deref()
        {
            return Err("a pending reopen already owns its note; finish or park it before replacing the request".into());
        }
        let (Some(id), Some(file)) = (rec.session_id.clone(), rec.session_file.clone()) else {
            return Err("no recorded session ID".into());
        };
        let verified = crate::omp::transcript::verify(
            PathBuf::from(&file),
            self.session_root(&rec),
            id.clone(),
            crate::omp::transcript::Folder::Exactly(PathBuf::from(&rec.cwd)),
        )
        .await;
        if !matches!(verified, Ok(Some(_))) {
            return Err("the saved session file is missing or its header names another session or directory".into());
        }
        if self.session(key).is_some() {
            return Err("a live session already runs this session".into());
        }
        let worktree_use = self.worktree_use.lock().await;
        super::preservation::canonical_path(&rec.place(), &rec.cwd).await?;
        let config = self.cfg();
        let exe = self.admit_restart(&config, &rec).await?;
        reply.begun = true;
        let target = format!("lane:{key}");
        let episode = Recovery {
            store: &self.env.store,
            target: &target,
        }
        .begin(&id, crate::host::startup::Begin::Reset)
        .await?;
        let pending = rec.pending_reopen.get_or_insert_with(|| Pending {
            episode_ms: episode.started_ms,
            note: note.map(str::to_string),
            step: Step::Starting {
                run_id: crate::host::random_hex(8),
            },
        });
        pending.episode_ms = episode.started_ms;
        rec.intent = None;
        rec.prev = Some(State::Running);
        rec.state = State::Held;
        let rev = self
            .save(
                &rec,
                Some(rev),
                Some("reopen accepted; intent recorded before startup".into()),
            )
            .await?;
        drop(worktree_use);
        let outcome = self
            .start(
                rec,
                rev,
                exe,
                &config,
                Ownership::ResumeExisting((id, PathBuf::from(file))),
                reply,
            )
            .await;
        if outcome != "started" {
            return Err(format!(
                "reopen did not confirm the session ({outcome}); the lane stays held for inspection"
            ));
        }
        self.finish_reopen(key).await
    }

    pub(super) async fn finish_reopen(&self, key: &str) -> Result<String, String> {
        let (_finishing, mut cancel) = self.starts.enter(key)?;
        let (mut rec, mut rev) = self.load(key).await?;
        let pending = rec
            .pending_reopen
            .as_ref()
            .ok_or("no pending reopen intent")?;
        let target = format!("lane:{key}");
        let recovery = Recovery {
            store: &self.env.store,
            target: &target,
        };
        let episode = recovery
            .read()
            .await?
            .ok_or("reopen recovery episode is missing")?;
        if episode.started_ms != pending.episode_ms || episode.state != "active" {
            return Err("the pending reopen does not own an active recovery episode".into());
        }
        if matches!(pending.step, Step::Starting { .. }) {
            rev = self.commit_reopen(&mut rec, rev).await?;
        }
        let reserve = i64::try_from(crate::host::startup::STARTUP_CLEANUP_BUDGET.as_millis())
            .unwrap_or(i64::MAX);
        let remaining = u64::try_from(
            episode
                .deadline_ms
                .saturating_sub(reserve)
                .saturating_sub(now_ms()),
        )
        .unwrap_or(0);
        let deadline = Instant::now() + Duration::from_millis(remaining);
        // Accepted note delivery is cancel-safe at this boundary: its stable request ID and the
        // pending intent survive even if the deadline lands while its ledger commit is in flight.
        let completed = async {
            self.resume_locked(rec, rev).await?;
            let (mut rec, rev) = self.load(key).await?;
            let pending = rec
                .pending_reopen
                .as_ref()
                .ok_or("reopen intent disappeared")?;
            let id = rec
                .session_id
                .as_deref()
                .ok_or("reopened session identity disappeared")?;
            let note_state = if let Some(note) = &pending.note {
                let session = self.session(key).ok_or("the lane's session ended")?;
                Some(
                    self.deliver_wait(
                        key,
                        &session,
                        note,
                        &format!("reopen-note:{}", rec.run_id),
                        deadline
                            .min(Instant::now() + Duration::from_secs(30))
                            .into_std(),
                    )
                    .await?,
                )
            } else {
                None
            };
            let text = match note_state {
                None | Some(ReceiptState::Delivered) => {
                    format!("resumed on session {id} with run {}", rec.run_id)
                }
                Some(state) => format!(
                    "resumed on session {id}; the note is {state:?}; its accepted ledger is kept"
                )
                .to_lowercase(),
            };
            rec.pending_reopen = None;
            self.save(
                &rec,
                Some(rev),
                Some("reopen completed; intent cleared".into()),
            )
            .await?;
            recovery.end("bound", None).await?;
            Ok::<_, String>(text)
        };
        tokio::select! {
            biased;
            () = crate::host::startup::cancelled(&mut cancel) =>
                Err("reopen interrupted; intent and accepted note retained".into()),
            result = tokio::time::timeout_at(deadline, completed) =>
                result.map_err(|_| "300 s reopen episode exhausted; intent and accepted note retained".to_string())?,
        }
    }
}
