//! The only worktree removal boundary. Durable authority is necessary, never sufficient.

use std::path::Path;
use std::time::Duration;

use super::record::Record;
use super::{Lanes, git};
use crate::host::Runtime;

impl<R: Runtime> Lanes<R> {
    /// Re-read authority and preservation immediately before non-forced Git removal, locally
    /// or on the worker. Every unknown is a keep, including ignored files and stale ownership.
    pub(super) async fn remove_worktree(&self, rec: &Record, path: &str) -> Result<(), String> {
        let (saved, _) = self.load(&rec.key).await?;
        if saved.run_id != rec.run_id || !saved.worktrees.iter().any(|p| p == path) {
            return Err("worktree ownership changed".into());
        }
        let intent = saved
            .intent
            .as_ref()
            .ok_or("no durable removal authority")?;
        match intent.outcome.as_str() {
            "completed" => {}
            "fresh-rollback" if saved.session_id.is_none() => {}
            _ => return Err("the intent does not authorize removal".into()),
        }
        if !intent.quiescence.confirmed() {
            return Err(
                "writer exit is unconfirmed (worker removal requires a reap acknowledgement)"
                    .into(),
            );
        }
        if self
            .session(&rec.key)
            .is_some_and(|s| crate::host::Control::alive(&*s))
        {
            return Err("a lane writer is still live".into());
        }
        if self.delivery_doubt(&saved).await.is_some() || self.undelivered(&rec.key).await > 0 {
            return Err("input is pending or uncertain".into());
        }
        let place = saved.place();
        if self.holds_published(&place, path).await {
            return Err("it holds a published file".into());
        }
        if let Some(id) = &saved.session_id
            && self.lease_free(saved.worker.as_deref(), id).await != Some(true)
        {
            return Err("session lease is held or unknown".into());
        }
        let dir = Path::new(path);
        let limit = Duration::from_secs(60);
        let (ok, status) = git::git(
            &place,
            dir,
            &[
                "status",
                "--porcelain",
                "--untracked-files=all",
                "--ignored",
            ],
            limit,
        )
        .await?;
        if !ok || !status.is_empty() {
            return Err(
                "tracked, untracked or ignored content exists, or status is unreadable".into(),
            );
        }
        let (ok, commits) = git::git(
            &place,
            dir,
            &["rev-list", "--count", "HEAD", "--not", "--remotes"],
            limit,
        )
        .await?;
        if !ok || commits.trim() != "0" {
            return Err("unpushed commits exist or commit preservation is unknown".into());
        }
        let (ok, _) = git::git(&place, dir, &["worktree", "remove", path], limit).await?;
        if ok {
            Ok(())
        } else {
            Err("git worktree remove refused; retained".into())
        }
    }

    pub(super) async fn delivery_doubt(&self, rec: &Record) -> Option<String> {
        match self.mailbox(&rec.key).list().await {
            Ok(rows) => {
                let count = rows
                    .iter()
                    .filter(|(row, _)| row.state == "in_doubt")
                    .count();
                if count == 0 && rec.doubt.is_none() {
                    None
                } else {
                    Some(format!(
                        "{count} delivery(s) in doubt; worktrees kept; {}",
                        rec.doubt
                            .as_deref()
                            .unwrap_or("delivery outcome is unknown")
                    ))
                }
            }
            Err(error) => Some(format!(
                "delivery state unreadable; worktrees kept: {error}"
            )),
        }
    }
}
