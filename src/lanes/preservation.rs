//! The only worktree removal boundary. Durable authority is necessary, never sufficient.

use std::path::{Path, PathBuf};
use std::time::Duration;

use super::record::Record;
use super::{Lanes, git};
use crate::host::Runtime;
use crate::worker::Place;

/// Resolve paths where they are used, never against the hub's filesystem for a worker lane.
pub(super) async fn canonical_path(place: &Place, path: &str) -> Result<PathBuf, String> {
    match place {
        Place::Local => std::fs::canonicalize(path).map_err(|e| format!("{path}: {e}")),
        Place::Worker(worker) => {
            let answer: serde_json::Value = crate::worker::link::connect(worker)
                .await?
                .call(
                    crate::worker::method::STAT,
                    serde_json::json!({ "path": path }),
                    Duration::from_secs(10),
                )
                .await?;
            answer
                .get("real")
                .and_then(serde_json::Value::as_str)
                .map(PathBuf::from)
                .ok_or_else(|| format!("cannot resolve {path} on worker {worker}"))
        }
    }
}

impl<R: Runtime> Lanes<R> {
    /// Re-read authority and preservation immediately before non-forced Git removal, locally
    /// or on the worker. Every unknown is a keep, including ignored files and stale ownership.
    pub(super) async fn remove_worktree(&self, rec: &Record, path: &str) -> Result<(), String> {
        let _worktree_use = self.worktree_use.lock().await;
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
        // One resolution where the worktree lives serves both preservation checks below.
        let Ok(tree) = canonical_path(&place, path).await else {
            return Err("its path cannot be resolved".into());
        };
        if self.holds_published(path, &tree).await {
            return Err("it holds a published file".into());
        }
        if let Some(id) = &saved.session_id
            && self.lease_free(saved.worker.as_deref(), id).await != Some(true)
        {
            return Err("session lease is held or unknown".into());
        }
        self.worktree_unused(&saved, &place, &tree).await?;
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

    /// Caller holds `worktree_use` until removal finishes, fencing new path reservations.
    async fn worktree_unused(
        &self,
        rec: &Record,
        place: &Place,
        tree: &Path,
    ) -> Result<(), String> {
        let rows = self
            .env
            .store
            .read(|r| r.lanes(true))
            .await
            .map_err(|e| format!("open lanes unreadable: {e}"))?;
        for row in rows {
            if row.key == rec.key {
                continue;
            }
            let Record {
                key,
                cwd,
                worktrees,
                worker,
                ..
            } = serde_json::from_str(&row.record)
                .map_err(|e| format!("lane {} unreadable: {e}", row.key))?;
            if worker != rec.worker {
                continue;
            }
            for used in std::iter::once(&cwd).chain(worktrees.iter().filter(|p| *p != &cwd)) {
                let real = canonical_path(place, used)
                    .await
                    .map_err(|e| format!("lane {key} path unreadable: {e}"))?;
                if real.starts_with(tree) {
                    return Err(format!("in use by lane {key}"));
                }
            }
        }
        Ok(())
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
