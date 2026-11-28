//! Fresh allocation and exact-session resume have different rollback authority.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use super::record::{Record, State};
use super::{Lanes, record, supervisor};
use crate::config::Config;
use crate::host::inbox::ReceiptState;
use crate::host::{Role, Runtime, StartError, StartSpec};
use crate::jobs::event::{Emit, EventKind, Severity};
use crate::omp::launch::Target;
use crate::store::lanes::Revision;

pub(super) enum Ownership {
    FreshAttempt,
    ResumeExisting((String, PathBuf)),
}

impl Ownership {
    fn identity(&self) -> Option<&(String, PathBuf)> {
        match self {
            Self::FreshAttempt => None,
            Self::ResumeExisting(identity) => Some(identity),
        }
    }
}

impl<R: Runtime> Lanes<R> {
    /// The session directory, made private, and the start spec for a fresh or resumed session.
    fn start_spec(
        &self,
        rec: &Record,
        handle: String,
        resume: Option<&(String, PathBuf)>,
    ) -> Result<StartSpec, crate::sys::fs::FsError> {
        let sessions = self.env.state_dir.join("sessions");
        let dir = sessions.join("lanes").join(&rec.key);
        crate::sys::fs::ensure_private_dir(&sessions)?;
        crate::sys::fs::ensure_private_dir(&sessions.join("lanes"))?;
        crate::sys::fs::ensure_private_dir(&dir)?;
        let (target, expected) = match resume {
            Some((id, file)) => (Target::Resume(file.clone()), Some(id.clone())),
            None => (Target::Fresh(dir), None),
        };
        Ok(StartSpec {
            handle,
            role: Role::Lane,
            cwd: PathBuf::from(&rec.cwd),
            model: rec.model.clone(),
            thinking: rec.thinking.clone(),
            target,
            expected_id: expected,
            instructions: None,
            max_cost: rec.ceilings.cost,
            look_only: rec.look_only,
            worker: rec.worker.clone(),
            quota_blocked: None,
        })
    }

    /// The kickoff with the learned rules; the lead hears which eligible rules were left out
    /// (EVR req. 47).
    async fn kickoff_text(&self, rec: &Record) -> String {
        let (rules, left) = self.rules_for(rec).await;
        if !left.is_empty() {
            self.alert(
                &rec.key,
                "learned rules left out",
                &format!("over the limit at launch: {}", left.join(", ")),
                false,
            );
        }
        record::kickoff(rec, &rules, &[])
    }

    /// The start sequence after the record exists (LANE req. 15-16; HOST-19). Returns the outcome
    /// line: `started`, `start held: model`, `unconfirmed: ...` or `failed: ...`.
    pub(super) async fn start(
        self: &Arc<Self>,
        mut rec: Record,
        mut rev: Revision,
        exe: PathBuf,
        config: &Config,
        ownership: Ownership,
        reply: &mut super::replies::Reply,
    ) -> String {
        let began = Instant::now();
        let (_starting, cancel) = match self.starts.enter(&rec.key) {
            Ok(starting) => starting,
            Err(why) => {
                return self
                    .start_failed(
                        rec,
                        rev,
                        &ownership,
                        StartError::Startup {
                            stage: crate::host::startup::StartupStage::Prepare,
                            outcome: crate::host::startup::StartupOutcome::Rejected,
                            cleanup: crate::host::startup::Cleanup::NotSpawned,
                            detail: why,
                        },
                    )
                    .await;
            }
        };
        let spec = match self.start_spec(&rec, crate::host::random_hex(8), ownership.identity()) {
            Ok(spec) => spec,
            Err(e) => {
                return self
                    .start_failed(rec, rev, &ownership, StartError::Refused(e.to_string()))
                    .await;
            }
        };
        let runtime = (self.env.make)(config, &exe, rec.runtime);
        let budget = config.lanes.start_budget.max(
            crate::host::startup::STARTUP_BUDGET + crate::host::startup::STARTUP_CLEANUP_BUDGET,
        );
        let launch = supervisor::Launch {
            record: &mut rec,
            revision: &mut rev,
            spec,
            reply,
        };
        let (session, started) = match self.supervise(&runtime, launch, cancel).await {
            Ok(pair) => pair,
            Err(failure) => return self.start_failed(rec, rev, &ownership, failure).await,
        };
        self.live_map()
            .insert(rec.key.clone(), Arc::clone(&session));
        rec.session_id = Some(started.session_id.clone());
        rec.session_file = Some(started.file.clone());
        rec.pid = started.pid;
        rec.start_note = None;
        if let Some(reason) = &started.held {
            // Never substitute a model; keep the process for inspection (LANE req. 15f).
            rec.state = State::Held;
            rec.held_by = Some("hub".into());
            rec.hold_reason = Some(reason.clone());
            rec.start_note = Some("start held: model".into());
        }
        let note = started
            .held
            .as_ref()
            .map(|reason| format!("start held: {reason}"));
        let persisted = async {
            rev = self.save(&rec, Some(rev), note).await?;
            // A start that came up fenced ends its episode like a bound one, also for a reopen
            // (which otherwise ends it once finished): a later exit gets a fresh window.
            if ownership.identity().is_some()
                && (rec.pending_reopen.is_none() || started.held.is_some())
            {
                self.end_episode(&rec.key).await?;
            }
            Ok::<(), String>(())
        }
        .await;
        if let Err(e) = persisted {
            let stopped = supervisor::stop(&*session).await;
            rec.startup_cleanup = Some(stopped.cleanup);
            return self
                .start_failed(
                    rec,
                    rev,
                    &ownership,
                    StartError::Startup {
                        stage: crate::host::startup::StartupStage::Binding,
                        outcome: crate::host::startup::StartupOutcome::Rejected,
                        detail: format!("{e}; cleanup: {}", stopped.detail),
                        cleanup: stopped.cleanup,
                    },
                )
                .await;
        }
        tokio::spawn(Arc::clone(self).watch(rec.key.clone(), Arc::clone(&session)));
        if let Some(reason) = started.held {
            self.alert(&rec.key, "start held: model", &reason, true);
            return "start held: model".into();
        }
        if ownership.identity().is_some() {
            return "started".into();
        }
        self.finish_fresh_start(&mut rec, rev, &session, began, began + budget)
            .await
    }

    /// Only a freshly bound allocation may receive a kickoff or a new goal.
    async fn finish_fresh_start(
        &self,
        rec: &mut Record,
        rev: Revision,
        session: &Arc<R::Session>,
        began: Instant,
        deadline: Instant,
    ) -> String {
        // OMP's TUI (tern) takes a goal only between turns and starts no turn for it, so a tern
        // lane's goal comes before the kickoff; over rpc (headless) a goal set while idle starts a
        // turn of its own, so it follows the kickoff, whose turn is then running.
        let goal_first = rec.runtime == crate::config::session::RuntimeKind::Tern;
        if goal_first && let Err(why) = Self::set_goal(rec, session).await {
            return self.unconfirmed(rec, rev, &why).await;
        }
        let kickoff = self.kickoff_text(rec).await;
        let delivered = self
            .deliver_wait(
                &rec.key,
                session,
                &kickoff,
                &format!("kickoff:{}", rec.run_id),
                deadline,
            )
            .await;
        let delivered = match delivered {
            Ok(state) => state,
            Err(why) => return self.unconfirmed(rec, rev, &why).await,
        };
        if delivered != ReceiptState::Delivered {
            return self
                .unconfirmed(
                    rec,
                    rev,
                    "the kickoff was not confirmed in the session file",
                )
                .await;
        }
        self.start_latency.record(began.elapsed());
        if !goal_first && let Err(why) = Self::set_goal(rec, session).await {
            return self.unconfirmed(rec, rev, &why).await;
        }
        rec.state = State::Running;
        let note = "started".to_string();
        if let Err(e) = self.save(rec, Some(rev), Some(note)).await {
            return self.unconfirmed(rec, rev, &e).await;
        }
        self.status_word(rec).await;
        self.emit(
            Emit::new(EventKind::LaneStarted, Severity::Info, false, &rec.key)
                .with("lane", &rec.key)
                .with("detail", format!("started on {} in {}", rec.model, rec.cwd)),
        );
        self.nudge.notify_one();
        "started".into()
    }
}
