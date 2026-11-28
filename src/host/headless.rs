//! The headless runtime (DESIGN 4.2): OMP as the hub's child in rpc-ui mode. One event task per
//! session owns the event stream and applies every change to the session state in order; operations
//! (deliver, interrupt, model, answer, close) run one at a time, refuse a second at once as busy, and
//! publish the new snapshot on a watch channel so status reads never wait (HOST-21).
//!
//! The state mutex is only ever held for synchronous updates, never across an await.

#[path = "lead/local_cleanup.rs"]
mod local_cleanup;

#[cfg(test)]
#[path = "lead/startup_tests.rs"]
mod startup_tests;

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::sync::{Mutex as AsyncMutex, broadcast, mpsc, watch};

use super::bridge::Links;
use super::dialogs::{
    self, AnswerFrame, Dialog, Entry, Facts, ReadState, Status, UiFrame, read_state, same_model,
    spend_offer,
};
use super::model::{Proof, Resolution};
use super::startup::{Cleanup, STARTUP_BUDGET, StartupOutcome, StartupStage};
use super::{
    Control, DeliverOutcome, Delivery, EventPage, Role, Runtime, SessionEvent, Snapshot,
    StartError, StartSpec, Started, StopRecord, Timing,
};
use crate::log;
use crate::omp::launch::{Launch, Target, session_env};
use crate::omp::rpc::{self, RESPONSE_TIMEOUT, Rpc, RpcError};
use crate::sys::command::{self, Attached, Exit, KILL_GRACE, Step};
use crate::sys::latency::Latency;
use crate::sys::now_ms;

/// After end of input before TERM (DESIGN 4.2, decision 8).
const CLOSE_WAIT: Duration = Duration::from_secs(15);
/// A forced close waits this long for the interrupted turn to stop (HOST req. 66).
const FORCE_IDLE_WAIT: Duration = Duration::from_secs(15);
/// The part of the startup deadline the model query leaves for binding after it: a bridge that
/// has not connected by then leaves the model unverified instead of failing the start.
const BIND_MARGIN: Duration = Duration::from_secs(2);
/// Child stderr kept per session (HOST req. 2).
const STDERR_CAP: u64 = 1024 * 1024;
/// Events queued between OMP's reader and the session's event task. A full queue drops frames, which
/// ends trust in the stream (a dropped frame could hide an approval).
const EVENT_QUEUE: usize = 4096;
/// Output ring entries (HOST req. 40).
const RING: usize = 40;
/// Numbered events kept per session (HOST req. 76).
const EVENT_KEEP: usize = 256;
/// Event page size on demand (HOST req. 76).
pub(crate) const EVENT_PAGE: usize = 40;
/// Message text in events (HOST req. 77).
const MESSAGE_CUT: usize = 1536;
/// Largest delivery (HOST req. 50).
const TEXT_MAX: usize = 256 * 1024;
/// Spend offers within this window fence the session at the limit (DESIGN 9.2, check 8).
const SPEND_WINDOW_MS: i64 = 10 * 60 * 1000;
const SPEND_LIMIT: usize = 3;
/// Cancelled spend offers remembered to tell a repeat, newest kept. The fence at three offers in
/// 10 minutes allows at most two per window, so this covers more than five hours.
const CANCELLED_KEEP: usize = 64;

/// How the hub launches headless sessions.
#[derive(Clone, Debug)]
pub(crate) struct Headless {
    pub(crate) exe: PathBuf,
    /// The state directory, which holds the overlay of each session kind.
    pub(crate) state: PathBuf,
    pub(crate) socket: PathBuf,
    /// Directory of the per-session stderr logs.
    pub(crate) logs: PathBuf,
    pub(crate) credentials: Vec<String>,
    pub(crate) extra_flags: Vec<String>,
    pub(crate) spend_phrases: Vec<String>,
    /// Prompt line written to the turn's `agent_start`.
    pub(crate) agent_start: Latency,
    /// Launch tokens for the bridge hello (EXT req. 5).
    pub(crate) links: Arc<super::bridge::Links>,
}

impl Runtime for Headless {
    type Session = Session;

    fn kind(&self) -> &'static str {
        "headless"
    }

    async fn start_supervised(
        &self,
        spec: StartSpec,
        cancel: watch::Receiver<bool>,
    ) -> Result<(Arc<Session>, Started), StartError> {
        if *cancel.borrow() {
            return Err(StartError::Startup {
                stage: StartupStage::Spawn,
                outcome: StartupOutcome::Cancelled,
                cleanup: Cleanup::NotSpawned,
                detail: "startup cancelled before spawn".into(),
            });
        }
        let deadline = tokio::time::Instant::now() + STARTUP_BUDGET;
        let token = super::random_hex(16);
        self.links.issue(&token, &spec);
        if let Some(worker) = spec.worker.clone() {
            return self
                .start_remote(spec, &worker, &token, deadline, cancel)
                .await;
        }
        self.start_local(spec, &token, deadline, cancel).await
    }
}

impl Headless {
    /// What every session of this runtime is bound with: its own deadline, cancellation and
    /// local ownership, and the hub's spend phrases, latency ring and bridge registry.
    fn settings(
        &self,
        deadline: tokio::time::Instant,
        cancel: watch::Receiver<bool>,
        ownership: Option<super::lead::ownership::Ownership>,
    ) -> Settings {
        Settings {
            spend_phrases: self.spend_phrases.clone(),
            agent_start: self.agent_start.clone(),
            links: Arc::clone(&self.links),
            deadline: Some(deadline),
            cancel: Some(cancel),
            ownership,
        }
    }

    /// The start on this machine: OMP as the hub's own child, with its stderr logged and its PID
    /// adopted by the session's role. Spawn, the rpc stream and binding spend the one deadline.
    async fn start_local(
        &self,
        spec: StartSpec,
        token: &str,
        deadline: tokio::time::Instant,
        mut cancel: watch::Receiver<bool>,
    ) -> Result<(Arc<Session>, Started), StartError> {
        let overlay = crate::omp::launch::overlay_path(&self.state, spec.tool_role());
        let argv = Launch {
            exe: &self.exe,
            model: &spec.model,
            thinking: spec.thinking.as_deref(),
            target: &spec.target,
            overlay: &overlay,
            instructions: spec.instructions.as_deref(),
            extra: &self.extra_flags,
            max_cost: spec.max_cost,
            role: spec.tool_role(),
        }
        .argv();
        let env = session_env(&self.credentials, &self.socket, token, spec.tool_role());
        let env: Vec<(&str, &str)> = env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        crate::sys::fs::ensure_private_dir(&self.logs)
            .map_err(|e| StartError::Refused(e.to_string()))?;
        let stderr = self.logs.join(format!("session-{}.err", spec.handle));
        let ownership = super::lead::ownership::Ownership::prepare(&self.state, &spec.handle)
            .map_err(StartError::Refused)?;
        ownership
            .identify(spec.expected_id.as_deref(), None)
            .map_err(StartError::Refused)?;
        let mut child =
            match command::attach(&argv, Some(&spec.cwd), &env, Some(&stderr), STDERR_CAP) {
                Ok(child) => child,
                Err(error) => {
                    ownership
                        .finished(Cleanup::NotSpawned)
                        .map_err(StartError::Refused)?;
                    return Err(StartError::Refused(error.to_string()));
                }
            };
        if let Err(detail) = ownership.spawned(child.pid()).await {
            return Err(local_cleanup::finish(
                child,
                &ownership,
                local_cleanup::Failure {
                    stage: StartupStage::Spawn,
                    outcome: StartupOutcome::Rejected,
                    detail,
                },
            )
            .await);
        }
        // Its shell and tools act in this session's role on the control socket (DESIGN 8).
        if let Some(pid) = child.pid() {
            self.links.adopt(pid, &spec.handle, spec.role);
        }
        let (Some(stdin), Some(stdout)) = (child.take_stdin(), child.take_stdout()) else {
            return Err(local_cleanup::finish(
                child,
                &ownership,
                local_cleanup::Failure {
                    stage: StartupStage::Spawn,
                    outcome: StartupOutcome::Rejected,
                    detail: "OMP's pipes are not available".into(),
                },
            )
            .await);
        };
        let (tx, rx) = mpsc::channel(EVENT_QUEUE);
        let rpc = match Rpc::connect_supervised(
            stdout,
            stdin,
            deadline.saturating_duration_since(tokio::time::Instant::now()),
            Some(tx),
            cancel.clone(),
        )
        .await
        {
            Ok(rpc) => rpc,
            Err(e) => {
                let cancelled = *cancel.borrow_and_update();
                return Err(local_cleanup::finish(
                    child,
                    &ownership,
                    local_cleanup::Failure::rpc(&e, cancelled),
                )
                .await);
            }
        };
        let settings = self.settings(deadline, cancel, Some(ownership));
        Session::bind(rpc, rx, Proc::Child(Box::new(child)), spec, settings).await
    }

    /// The same start on a worker (design 2.1): its own OMP, spawned over the worker stream for the
    /// spec's handle as its attempt token, with the overlay and instructions copied to its root, its
    /// session under `<root>/sessions`, no hub credentials, and its bridge on the worker's socket.
    /// No PID is adopted: nothing of a remote session acts on this machine. The shared deadline and
    /// cancellation govern it end to end; a failure after the spawn waits for the worker's exit
    /// acknowledgement, which alone proves the attempt ended.
    async fn start_remote(
        &self,
        spec: StartSpec,
        worker: &str,
        token: &str,
        deadline: tokio::time::Instant,
        cancel: watch::Receiver<bool>,
    ) -> Result<(Arc<Session>, Started), StartError> {
        let owner = super::lead::ownership::Ownership::prepare(&self.state, &spec.handle)
            .map_err(StartError::Refused)?;
        owner
            .identify(spec.expected_id.as_deref(), Some(worker))
            .map_err(StartError::Refused)?;
        let result = self
            .bind_remote(spec, worker, token, deadline, cancel)
            .await;
        if let Err(error) = &result {
            let cleanup = match error {
                StartError::Startup { cleanup, .. } => *cleanup,
                StartError::Refused(_) => Cleanup::NotSpawned,
            };
            owner.finished(cleanup).map_err(StartError::Refused)?;
        }
        result
    }

    async fn bind_remote(
        &self,
        spec: StartSpec,
        worker: &str,
        token: &str,
        deadline: tokio::time::Instant,
        mut cancel: watch::Receiver<bool>,
    ) -> Result<(Arc<Session>, Started), StartError> {
        let not_spawned = |outcome, detail: String| StartError::Startup {
            stage: StartupStage::Spawn,
            outcome,
            cleanup: Cleanup::NotSpawned,
            detail,
        };
        // Nothing runs on the worker before `spawn`, so either ends the preparation outright.
        let prepared = tokio::select! {
            biased;
            () = super::startup::cancelled(&mut cancel) => Err(not_spawned(
                StartupOutcome::Cancelled,
                "startup cancelled before spawn".into(),
            )),
            prepared = tokio::time::timeout_at(deadline, self.prepare_remote(&spec, worker, token)) => {
                prepared.unwrap_or_else(|_| Err(not_spawned(
                    StartupOutcome::Timeout,
                    format!("{worker}: the startup deadline passed before spawn"),
                )))
            }
        };
        let PreparedRemote { link, argv, env } = prepared?;
        let cwd = spec.cwd.display().to_string();
        // Once the request may have reached the worker, a deadline or cancellation is unknown
        // ownership, not a refusal. The durable token remains available for reconciliation.
        let unanswered = |outcome| StartError::Startup {
            stage: StartupStage::Spawn,
            outcome,
            cleanup: Cleanup::Unknown,
            detail: format!(
                "{worker}: spawn of attempt {} was not acknowledged; held for reconciliation",
                spec.handle
            ),
        };
        let spawned = tokio::select! {
            biased;
            () = super::startup::cancelled(&mut cancel) => Err(unanswered(StartupOutcome::Cancelled)),
            result = tokio::time::timeout_at(deadline, link.spawn(&argv, &cwd, &env, &spec.handle, spec.expected_id.as_deref())) =>
                result.map_err(|_| unanswered(StartupOutcome::Timeout))?
                    .map_err(|error| spawn_failed(worker, error)),
        }?;
        let crate::worker::link::Spawned {
            channel,
            stream,
            hold,
            exit,
        } = spawned;
        let remote = Remote {
            worker: worker.to_string(),
            channel,
            hold,
            exit,
        };
        let (read, write) = tokio::io::split(stream);
        let (tx, rx) = mpsc::channel(EVENT_QUEUE);
        let rpc = match Rpc::connect_supervised(
            read,
            write,
            deadline.saturating_duration_since(tokio::time::Instant::now()),
            Some(tx),
            cancel.clone(),
        )
        .await
        {
            Ok(rpc) => rpc,
            Err(e) => {
                let cancelled = *cancel.borrow_and_update();
                return Err(remote
                    .finish(local_cleanup::Failure::rpc(&e, cancelled))
                    .await);
            }
        };
        let settings = self.settings(deadline, cancel, None);
        Session::bind(rpc, rx, Proc::Remote(Box::new(remote)), spec, settings).await
    }

    /// What a start on `worker` runs. Nothing runs on the worker yet, so a failure is a refusal.
    async fn prepare_remote(
        &self,
        spec: &StartSpec,
        worker: &str,
        token: &str,
    ) -> Result<PreparedRemote, StartError> {
        let refused = |e: String| StartError::Refused(format!("{worker}: {e}"));
        let link = crate::worker::link::connect(worker)
            .await
            .map_err(refused)?;
        let root = PathBuf::from(&link.hello.root);
        // The overlay and instructions go to the worker root's `settings`, under the same names.
        let there = |local: &Path| {
            root.join("settings")
                .join(local.file_name().unwrap_or_default())
        };
        let overlay = crate::omp::launch::overlay_path(&self.state, spec.tool_role());
        let (overlay_there, instructions_there) =
            (there(&overlay), spec.instructions.as_deref().map(there));
        let copies = std::iter::once((&overlay, &overlay_there))
            .chain(spec.instructions.iter().zip(instructions_there.iter()));
        for (local, remote) in copies {
            let bytes =
                std::fs::read(local).map_err(|e| refused(format!("{}: {e}", local.display())))?;
            link.write(&remote.display().to_string(), &bytes)
                .await
                .map_err(refused)?;
        }
        let target = match &spec.target {
            Target::Fresh(dir) => {
                let remote = root
                    .join("sessions")
                    .join(dir.file_name().unwrap_or_default());
                let mkdir = [
                    "mkdir".to_string(),
                    "-p".into(),
                    remote.display().to_string(),
                ];
                link.exec(&mkdir, None, &[], Duration::from_secs(10))
                    .await
                    .map_err(refused)?;
                Target::Fresh(remote)
            }
            Target::Resume(file) => match crate::worker::split_remote(file) {
                Some((w, path)) if w == worker => Target::Resume(PathBuf::from(path)),
                _ => return Err(refused("the session file is not on this worker".into())),
            },
        };
        let argv = Launch {
            exe: Path::new("omp"),
            model: &spec.model,
            thinking: spec.thinking.as_deref(),
            target: &target,
            overlay: &overlay_there,
            instructions: instructions_there.as_deref(),
            extra: &self.extra_flags,
            max_cost: spec.max_cost,
            role: spec.tool_role(),
        }
        .argv();
        // The worker's own OMP profile and logins: nothing of this machine's environment goes along,
        // and the role's policy pins outrank the worker's own `.env` files (DESIGN 12.2 A13).
        let env = worker_env(token, spec.tool_role());
        Ok(PreparedRemote { link, argv, env })
    }
}

/// A remote start before its spawn: the connection, OMP's argument vector on the worker and its
/// environment there.
struct PreparedRemote {
    link: Arc<crate::worker::link::Link>,
    argv: Vec<String>,
    env: Vec<(String, String)>,
}

/// The start error of a `spawn` that gave no attempt to talk to, with what its answer proves about
/// a process for the attempt token.
fn spawn_failed(worker: &str, error: crate::worker::link::SpawnError) -> StartError {
    use crate::worker::link::SpawnError;
    match error {
        SpawnError::Refused(why) => StartError::Refused(format!("{worker}: {why}")),
        SpawnError::Ended { detail, state } => StartError::Startup {
            stage: StartupStage::Spawn,
            outcome: StartupOutcome::Rejected,
            cleanup: super::lead::ownership::worker_cleanup(&state),
            detail: format!("{worker}: {detail} ({state:?})"),
        },
        SpawnError::Unanswered(why) => StartError::Startup {
            stage: StartupStage::Spawn,
            outcome: StartupOutcome::Rejected,
            cleanup: Cleanup::Unknown,
            detail: format!("{worker}: {why}; only the attempt token can tell whether OMP runs"),
        },
    }
}

/// Per-session settings that are not part of the start spec.
#[derive(Debug, Default)]
pub(crate) struct Settings {
    pub(crate) spend_phrases: Vec<String>,
    pub(crate) agent_start: Latency,
    /// The bridge registry, which carries the session's model query (HOST req. 27).
    pub(crate) links: Arc<Links>,
    deadline: Option<tokio::time::Instant>,
    cancel: Option<watch::Receiver<bool>>,
    ownership: Option<super::lead::ownership::Ownership>,
}

#[derive(Default)]
struct State {
    bound: Option<(String, String)>,
    latest: Option<ReadState>,
    fresh: bool,
    fault: Option<String>,
    held: Option<String>,
    stopping: bool,
    stop: Option<StopRecord>,
    dialogs: Vec<Dialog>,
    ring: VecDeque<Entry>,
    turn_started_ms: Option<i64>,
    /// When a readback last showed a turn over.
    turn_ended_ms: Option<i64>,
    /// A turn completed since the last idle readback (HOST req. 25).
    turn_done: bool,
    quota_blocked: Option<String>,
    spend_offers: VecDeque<i64>,
    cancelled_offers: VecDeque<String>,
    /// The fallback model OMP moved to and the hub reported, until the requested model is back.
    fallback_to: Option<String>,
    /// OMP's latest fallback report, until a readback shows its model in use.
    fallback_report: Option<FallbackReport>,
    /// The model the hub asked for with `set_model`, which replaces the start model as expected.
    asked_model: Option<String>,
    /// What OMP resolved the expected selector to, as the bridge proved it.
    resolution: Option<Resolution>,
    /// The unexpected model already reported, so one model is reported once (DESIGN 6.1).
    unexpected: Option<String>,
    /// When the last delivery's line was written, until its turn starts.
    wake_written: Option<Instant>,
    seq: u64,
    log: VecDeque<(u64, SessionEvent)>,
    updated_ms: i64,
}

/// One `retry_fallback_applied` report.
struct FallbackReport {
    from: String,
    to: String,
    reason: String,
}

/// Who ended the child.
pub(crate) enum Proc {
    Child(Box<Attached>),
    /// OMP on a worker: the end of its channel's input closes it there by the same rule.
    Remote(Box<Remote>),
    /// Tests: the transport is in-process and ends with the fake.
    #[cfg(test)]
    Fake,
}

/// A session's OMP on a worker.
pub(crate) struct Remote {
    worker: String,
    channel: u32,
    /// Keeps the worker connection in use while the session lives.
    hold: crate::worker::link::LaneHold,
    /// The worker's acknowledgement once it reaped the OMP: the only proof it ended.
    exit: crate::worker::link::ExitWait,
}

impl Remote {
    /// How the worker says the OMP ended, its input already closed: the acknowledgement within the
    /// stop budget (end of input, 15 s, TERM, 5 s, KILL on the worker), else KILL from here and
    /// [`KILL_GRACE`] more. Returns the state and whether KILL was needed. A disconnect, an EOF or
    /// silence is never a reap.
    async fn reaped(&mut self) -> (crate::worker::attempt::AttemptState, bool) {
        // Reserve the stdin-shutdown second. Signal delivery and the final acknowledgement
        // consume the same remaining cleanup budget, never independent trailing timers.
        let until = tokio::time::Instant::now()
            + super::startup::STARTUP_CLEANUP_BUDGET.saturating_sub(Duration::from_secs(1));
        let grace = until - KILL_GRACE;
        if let Ok(state) = tokio::time::timeout_at(grace, self.exit.wait()).await {
            return (state, false);
        }
        let _ = tokio::time::timeout_at(until, self.hold.link().signal(self.channel, "KILL")).await;
        let state = tokio::time::timeout_at(until, self.exit.wait())
            .await
            .unwrap_or_else(|_| crate::worker::attempt::AttemptState::Unknown {
                reason: format!(
                    "no exit acknowledgement from {} within the cleanup budget",
                    self.worker
                ),
            });
        (state, true)
    }

    /// A startup failure after the spawn, once the worker answered for the attempt.
    async fn finish(mut self, failure: local_cleanup::Failure) -> StartError {
        let (state, _) = self.reaped().await;
        StartError::Startup {
            stage: failure.stage,
            outcome: failure.outcome,
            cleanup: super::lead::ownership::worker_cleanup(&state),
            detail: format!(
                "{} on {} (worker cleanup of attempt {}: {state:?})",
                failure.detail,
                self.worker,
                self.exit.attempt()
            ),
        }
    }
}

/// The view token: changes with every child start (HOST req. 78).
static VIEWS: AtomicU64 = AtomicU64::new(0);

struct Inner {
    handle: String,
    role: Role,
    cwd: String,
    started_ms: i64,
    requested_model: String,
    view: u64,
    pid: Option<u32>,
    /// The worker the OMP runs on: its session file is recorded as `worker:<name>:<path>`.
    worker: Option<String>,
    rpc: Rpc,
    proc: AsyncMutex<Option<Proc>>,
    state: Mutex<State>,
    snapshot: watch::Sender<Arc<Snapshot>>,
    events: broadcast::Sender<(u64, SessionEvent)>,
    busy: AtomicBool,
    readback_gate: AsyncMutex<()>,
    readbacks: AtomicU64,
    readback_queued: AtomicBool,
    settings: Settings,
}

/// A headless session.
pub(crate) struct Session {
    inner: Arc<Inner>,
}

/// Clears the busy flag when an operation ends.
struct Busy<'a>(&'a AtomicBool);

impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn cut(text: &str) -> (String, bool) {
    let clean = dialogs::clean(text);
    let kept = dialogs::last_units(&clean, MESSAGE_CUT);
    (kept.to_string(), kept.len() < clean.len())
}

fn is_usage_limit(error: &Value) -> bool {
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if code == "cost_cap" {
        return false;
    }
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_lowercase();
    matches!(
        code,
        "usage_limit" | "usage_limit_exceeded" | "quota_exceeded" | "insufficient_quota"
    ) || ["usage limit", "quota", "limit reached", "limit exceeded"]
        .iter()
        .any(|p| message.contains(p))
}

/// Whether an OMP model selector (`provider/id`, optionally `:<thinking>`) names `model`.
fn names_model(selector: &str, model: &str) -> bool {
    let rest = selector.as_bytes().get(model.len()..).unwrap_or_default();
    matches!(rest.first(), None | Some(b':'))
        && selector
            .get(..model.len())
            .is_some_and(|base| same_model(base, model))
}

enum BindFailure {
    Rpc(RpcError),
    Invalid(String),
    Cancelled,
}

impl Session {
    /// Runs the start handshake over a connected rpc stream (HOST req. 23-28) and starts the event
    /// task. On failure the child is closed.
    pub(crate) async fn bind(
        rpc: Rpc,
        events: mpsc::Receiver<Value>,
        proc: Proc,
        spec: StartSpec,
        settings: Settings,
    ) -> Result<(Arc<Self>, Started), StartError> {
        let (pid, worker) = match &proc {
            Proc::Child(c) => (c.pid(), None),
            Proc::Remote(r) => (None, Some(r.worker.clone())),
            #[cfg(test)]
            Proc::Fake => (None, None),
        };
        let now = now_ms();
        let inner = Arc::new(Inner {
            handle: spec.handle.clone(),
            role: spec.role,
            cwd: spec.cwd.display().to_string(),
            started_ms: now,
            requested_model: spec.model.clone(),
            view: VIEWS.fetch_add(1, Ordering::Relaxed) + 1,
            pid,
            worker,
            rpc,
            proc: AsyncMutex::new(Some(proc)),
            state: Mutex::new(State {
                updated_ms: now,
                ..State::default()
            }),
            snapshot: watch::channel(Arc::new(placeholder(&spec, now))).0,
            events: broadcast::channel(EVENT_KEEP).0,
            busy: AtomicBool::new(false),
            readback_gate: AsyncMutex::new(()),
            readbacks: AtomicU64::new(0),
            readback_queued: AtomicBool::new(false),
            settings,
        });
        tokio::spawn(event_loop(Arc::clone(&inner), events));
        let session = Arc::new(Self { inner });
        let deadline = session
            .inner
            .settings
            .deadline
            .unwrap_or_else(|| tokio::time::Instant::now() + STARTUP_BUDGET);
        let (_keep, never_cancel) = watch::channel(false);
        let mut cancel = session
            .inner
            .settings
            .cancel
            .clone()
            .unwrap_or(never_cancel);
        let bound = tokio::select! {
            biased;
            () = super::startup::cancelled(&mut cancel) => Err(BindFailure::Cancelled),
            result = tokio::time::timeout_at(deadline, session.handshake(&spec, deadline)) => result
                .unwrap_or(Err(BindFailure::Rpc(RpcError::Timeout("startup deadline")))),
        };
        let bound = bound.and_then(|started| {
            if tokio::time::Instant::now() < deadline {
                Ok(started)
            } else {
                Err(BindFailure::Rpc(RpcError::Timeout("startup deadline")))
            }
        });
        match bound {
            Ok(started) => Ok((session, started)),
            Err(failure) => {
                let (outcome, reason) = match failure {
                    BindFailure::Rpc(error) => (
                        if matches!(error, RpcError::Timeout(_)) {
                            StartupOutcome::Timeout
                        } else {
                            StartupOutcome::Rejected
                        },
                        error.to_string(),
                    ),
                    BindFailure::Invalid(reason) => (StartupOutcome::Rejected, reason),
                    BindFailure::Cancelled => (
                        StartupOutcome::Cancelled,
                        "startup cancelled; owned process closed".into(),
                    ),
                };
                session.inner.fault(&reason);
                let stopped = session.inner.end("failed", Some(reason.clone())).await;
                Err(StartError::Startup {
                    stage: StartupStage::Binding,
                    outcome,
                    cleanup: stopped.cleanup,
                    detail: reason,
                })
            }
        }
    }

    async fn handshake(
        &self,
        spec: &StartSpec,
        deadline: tokio::time::Instant,
    ) -> Result<Started, BindFailure> {
        let inner = &self.inner;
        let call = |kind, fields: &[(&str, Value)]| {
            inner.rpc.call(
                rpc::command(kind, fields),
                deadline.saturating_duration_since(tokio::time::Instant::now()),
            )
        };
        let _ = call("set_ask_dialog", &[("enabled", json!(true))]).await;
        let state = async || {
            let reply = call("get_state", &[]).await.map_err(BindFailure::Rpc)?;
            if !reply.success {
                return Err(BindFailure::Invalid(format!(
                    "OMP refused get_state: {}",
                    reply.error.unwrap_or_default()
                )));
            }
            read_state(reply.data.as_ref()).ok_or_else(|| {
                BindFailure::Invalid("get_state answered without a session identity".into())
            })
        };
        let first = state().await?;
        let second = state().await?;
        if (first.session_id.as_str(), first.session_file.as_str())
            != (second.session_id.as_str(), second.session_file.as_str())
        {
            return Err(BindFailure::Invalid(
                "two get_state answers named different sessions".into(),
            ));
        }
        if first.model != second.model || first.thinking != second.thinking {
            return Err(BindFailure::Invalid(
                "two get_state answers named different model/thinking settings".into(),
            ));
        }
        if !Path::new(&first.session_file).is_absolute() {
            return Err(BindFailure::Invalid(
                "OMP reported a transcript path that is not absolute".into(),
            ));
        }
        // A worker's session file is recorded with its worker; the worker resolved its paths.
        let reported_file = inner.recorded(&first.session_file);
        if let (Some(expected), Target::Resume(file)) = (&spec.expected_id, &spec.target) {
            let same = if inner.worker.is_some() {
                Path::new(&reported_file) == file.as_path()
            } else {
                let reported = std::fs::canonicalize(&first.session_file).ok();
                reported.is_some() && reported == std::fs::canonicalize(file).ok()
            };
            if &first.session_id != expected || !same {
                return Err(BindFailure::Invalid(format!(
                    "OMP resumed a different session: expected {expected} at {}, got {} at {}",
                    file.display(),
                    first.session_id,
                    reported_file
                )));
            }
        }
        // What OMP makes of the selector, from the session's own bridge, within the same deadline
        // (HOST req. 23, 27), less the moment binding needs after it. A bridge that cannot tell, or
        // never connects, leaves the model unverified and the session bound and fenced, never
        // retried.
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        let connect_by = deadline - BIND_MARGIN.min(left);
        let proof = inner
            .settings
            .links
            .resolve_model(
                &inner.handle,
                &spec.model,
                spec.thinking.as_deref(),
                (connect_by, deadline),
            )
            .await
            .map_err(|e| {
                if tokio::time::Instant::now() >= deadline {
                    BindFailure::Rpc(RpcError::Timeout("startup deadline"))
                } else {
                    BindFailure::Invalid(format!("model resolution: {e}"))
                }
            })?;
        let held = proof.hold(first.model.as_deref(), first.thinking.as_deref());
        {
            let mut st = inner.lock();
            st.bound = Some((first.session_id.clone(), reported_file.clone()));
            st.held.clone_from(&held);
            if let Proof::Resolved(r) = proof {
                inner.settings.links.resolved(&inner.handle, r.clone());
                st.resolution = Some(r);
            }
            st.latest = Some(first.clone());
            st.fresh = true;
            inner.publish(&mut st);
        }
        Ok(Started {
            session_id: first.session_id,
            file: reported_file,
            model: first.model,
            pid: inner.pid,
            held,
        })
    }

    fn begin(&self) -> Result<Busy<'_>, String> {
        if self.inner.busy.swap(true, Ordering::AcqRel) {
            return Err("busy: another change is in flight".into());
        }
        Ok(Busy(&self.inner.busy))
    }

    async fn deliver_now(&self, d: Delivery) -> DeliverOutcome {
        let inner = &self.inner;
        // A readback the caller made after asking stands unless an event made it stale since.
        let fresh = if d.fresh && inner.lock().fresh {
            Ok(())
        } else {
            inner.readback().await
        };
        let (status, checks) = {
            let st = inner.lock();
            (Inner::status_of(&st).0, ready_for(&st, &d.expected_session))
        };
        if let Err(why) = fresh.map_err(|e| format!("no fresh readback: {e}")) {
            return DeliverOutcome::NotReady(status, why);
        }
        if let Err(why) = checks {
            return DeliverOutcome::NotReady(status, why);
        }
        if d.text.trim().is_empty() {
            return DeliverOutcome::NotReady(status, "the text is blank".into());
        }
        if d.text.len() > TEXT_MAX {
            return DeliverOutcome::Refused("text over 256 KiB".into());
        }
        let timing_ok = match d.timing {
            Timing::Idle => status == Status::Idle,
            Timing::Working => status == Status::Working,
            Timing::Any => matches!(status, Status::Idle | Status::Working),
        };
        if !timing_ok {
            return DeliverOutcome::wrong_timing(status);
        }
        // Text starting with "/" would run as an OMP command (HOST req. 53).
        let text = if d.text.trim_start().starts_with('/') {
            format!("[message]\n{}", d.text)
        } else {
            d.text
        };
        let idle = status == Status::Idle;
        let command = if d.steer {
            if idle {
                return DeliverOutcome::Refused("no running turn to steer".into());
            }
            rpc::command("steer", &[("message", json!(text))])
        } else if idle {
            rpc::command(
                "prompt",
                &[
                    ("message", json!(text)),
                    ("streamingBehavior", json!("followUp")),
                ],
            )
        } else {
            rpc::command("follow_up", &[("message", json!(text))])
        };
        let (result, written) = inner.rpc.call_at(command, RESPONSE_TIMEOUT).await;
        match result {
            Ok(reply) if reply.success => {
                if idle && !d.steer {
                    inner.lock().wake_written = written;
                }
                DeliverOutcome::Delivered {
                    turn_started: idle && !d.steer,
                    written,
                }
            }
            Ok(reply) => DeliverOutcome::Refused(
                reply
                    .error
                    .unwrap_or_else(|| "OMP refused the input".into()),
            ),
            Err(RpcError::TooLarge) => DeliverOutcome::Refused("over OMP's frame limit".into()),
            Err(e) if written.is_none() && matches!(e, RpcError::Closed) => {
                DeliverOutcome::NotReady(Status::Error, format!("nothing was written: {e}"))
            }
            Err(e) => {
                let reason = format!("delivery unconfirmed, do not resend: {e}");
                inner.fault(&reason);
                DeliverOutcome::InDoubt(reason)
            }
        }
    }
}

fn placeholder(spec: &StartSpec, now: i64) -> Snapshot {
    Snapshot {
        handle: spec.handle.clone(),
        role: spec.role,
        runtime: "headless",
        cwd: spec.cwd.display().to_string(),
        started_ms: now,
        updated_ms: now,
        status: Status::Unknown,
        input_blocked: true,
        fresh: false,
        pid: None,
        session_id: None,
        session_file: None,
        goal: None,
        model: None,
        requested_model: spec.model.clone(),
        turn_started_ms: None,
        turn_ended_ms: None,
        reason: None,
        quota_blocked: None,
        dialogs: Vec::new(),
        recent: Vec::new(),
        view: 0,
        stop: None,
        last_event: 0,
    }
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// A session file OMP reported, as the hub records it: a worker's carries its name.
    fn recorded(&self, file: &str) -> String {
        match &self.worker {
            Some(worker) => crate::worker::remote_path(worker, file),
            None => file.to_string(),
        }
    }

    fn status_of(st: &State) -> (Status, bool) {
        dialogs::status(&Facts {
            bound: st.bound.is_some(),
            state: st.latest.as_ref().filter(|_| st.fresh),
            fault: st.fault.is_some(),
            held: st.held.is_some(),
            stopping: st.stopping || st.stop.is_some(),
            dialogs: !st.dialogs.is_empty(),
        })
    }

    fn publish(&self, st: &mut State) {
        st.updated_ms = now_ms();
        let (status, input_blocked) = Self::status_of(st);
        let identity = st.bound.as_ref().filter(|_| st.fault.is_none());
        let latest = st.latest.as_ref().filter(|_| identity.is_some());
        let snapshot = Snapshot {
            handle: self.handle.clone(),
            role: self.role,
            runtime: "headless",
            cwd: self.cwd.clone(),
            started_ms: self.started_ms,
            updated_ms: st.updated_ms,
            status,
            input_blocked,
            fresh: st.fresh,
            pid: self.pid.filter(|_| st.stop.is_none()),
            session_id: identity.map(|(id, _)| id.clone()),
            session_file: identity.map(|(_, file)| file.clone()),
            goal: latest.map(|s| s.goal.clone()),
            model: latest.and_then(|s| s.model.clone()),
            requested_model: self.requested_model.clone(),
            turn_started_ms: st.turn_started_ms,
            turn_ended_ms: st.turn_ended_ms,
            reason: st.fault.clone().or_else(|| st.held.clone()),
            quota_blocked: st.quota_blocked.clone(),
            dialogs: st.dialogs.clone(),
            recent: st.ring.iter().cloned().collect(),
            view: self.view,
            stop: st.stop.clone(),
            last_event: st.seq,
        };
        self.snapshot.send_replace(Arc::new(snapshot));
    }

    fn emit(&self, st: &mut State, event: SessionEvent) {
        st.seq += 1;
        st.log.push_back((st.seq, event.clone()));
        while st.log.len() > EVENT_KEEP {
            st.log.pop_front();
        }
        let _ = self.events.send((st.seq, event));
    }

    /// Faults the session: its status becomes error and nothing more is delivered (HOST req. 33).
    fn fault(&self, reason: &str) {
        let mut st = self.lock();
        if st.fault.is_some() {
            return;
        }
        log::warn(
            "session faulted",
            &[("handle", &self.handle), ("reason", &reason)],
        );
        st.fault = Some(reason.to_string());
        self.emit(
            &mut st,
            SessionEvent::Fault {
                reason: reason.to_string(),
            },
        );
        self.publish(&mut st);
    }

    async fn call(&self, kind: &str, fields: &[(&str, Value)]) -> Result<rpc::Reply, RpcError> {
        self.rpc
            .call(rpc::command(kind, fields), RESPONSE_TIMEOUT)
            .await
    }

    async fn get_state(&self) -> Result<ReadState, String> {
        match self.call("get_state", &[]).await {
            Ok(reply) if reply.success => read_state(reply.data.as_ref())
                .ok_or_else(|| "get_state answered without a session identity".to_string()),
            Ok(reply) => Err(format!(
                "OMP refused get_state: {}",
                reply.error.unwrap_or_default()
            )),
            Err(e) => Err(format!("get_state: {e}")),
        }
    }

    /// A fresh readback, shared with callers that were already waiting for one (HOST req. 5).
    async fn readback(&self) -> Result<(), String> {
        let seen = self.readbacks.load(Ordering::Acquire);
        let _gate = self.readback_gate.lock().await;
        // A readback that finished while this caller waited is shared, unless an event made the
        // state stale again since.
        if self.readbacks.load(Ordering::Acquire) != seen && self.lock().fresh {
            return Ok(());
        }
        let result = self.get_state().await;
        self.readbacks.fetch_add(1, Ordering::AcqRel);
        match result {
            Ok(state) => self.apply(state),
            Err(e) => {
                if self.rpc.closed() || e.contains("rpc protocol") {
                    self.fault(&e);
                }
                Err(e)
            }
        }
    }

    /// Compares a readback with the bound identity and the spend rules.
    fn apply(&self, state: ReadState) -> Result<(), String> {
        let fault = {
            let mut st = self.lock();
            let mut fault = None;
            if let Some((id, file)) = &st.bound
                && (id != &state.session_id || *file != self.recorded(&state.session_file))
            {
                fault = Some(format!(
                    "OMP switched transcripts: bound {id}, now {} at {}",
                    state.session_id, state.session_file
                ));
            } else if state.extra_usage {
                fault = Some(
                    "the usage limit reports extra usage; fenced before a request could bill overage"
                        .to_string(),
                );
            } else if state.idle()
                && std::mem::take(&mut st.turn_done)
                && self.worker.is_none()
                && !Path::new(&state.session_file).exists()
            {
                fault = Some("the transcript is missing after a completed turn".into());
            }
            if state.idle() && st.turn_started_ms.take().is_some() {
                st.turn_ended_ms = Some(now_ms());
            }
            let previous = st.latest.as_ref().and_then(|s| s.model.clone());
            st.latest = Some(state);
            st.fresh = true;
            self.track_model(&mut st, previous);
            self.publish(&mut st);
            fault
        };
        match fault {
            Some(reason) => {
                self.fault(&reason);
                Err(reason)
            }
            None => Ok(()),
        }
    }

    /// Model events from what readbacks show (HOST req. 77): one `ModelChanged` per change, one
    /// `Fallback` per change OMP reported as a fallback (a repeated report of the same move adds
    /// nothing), one `FallbackRecovered` when the requested model is back, and one
    /// `ModelUnexpected` when a turn is over on a model nobody asked for and OMP did not report as a
    /// fallback (DESIGN 6.1; OMP reports a fallback during the turn, so judging at the turn's end
    /// never mistakes a move whose report is still on its way).
    fn track_model(&self, st: &mut State, previous: Option<String>) {
        let Some(model) = st.latest.as_ref().and_then(|s| s.model.clone()) else {
            return;
        };
        if previous.is_some_and(|p| p != model) {
            self.emit(
                st,
                SessionEvent::ModelChanged {
                    model: model.clone(),
                },
            );
        }
        self.settle_fallback(st);
        if !st.latest.as_ref().is_some_and(ReadState::idle) {
            return;
        }
        let requested = st
            .asked_model
            .clone()
            .unwrap_or_else(|| self.requested_model.clone());
        let expected =
            self.expects(st, &model) || st.fallback_to.as_deref() == Some(model.as_str());
        if expected {
            st.unexpected = None;
        } else if st.unexpected.as_deref() != Some(model.as_str()) {
            st.unexpected = Some(model.clone());
            self.emit(st, SessionEvent::ModelUnexpected { model, requested });
        }
    }

    /// Whether `model` is the one the hub expects: what OMP resolved the selector to once the
    /// bridge proved it (HOST req. 27), else the selector read as `provider/id[:level]`.
    fn expects(&self, st: &State, model: &str) -> bool {
        match &st.resolution {
            Some(r) => same_model(model, &r.model()),
            None => names_model(
                st.asked_model.as_deref().unwrap_or(&self.requested_model),
                model,
            ),
        }
    }

    /// Matches a pending fallback report against the model in use.
    fn settle_fallback(&self, st: &mut State) {
        let Some(model) = st.latest.as_ref().and_then(|s| s.model.clone()) else {
            return;
        };
        if st.fallback_to.is_some() && self.expects(st, &model) {
            st.fallback_to = None;
            self.emit(
                st,
                SessionEvent::FallbackRecovered {
                    model: model.clone(),
                },
            );
        }
        if !st
            .fallback_report
            .as_ref()
            .is_some_and(|r| names_model(&r.to, &model))
        {
            return;
        }
        let Some(report) = st.fallback_report.take() else {
            return;
        };
        if st.fallback_to.as_deref() == Some(model.as_str()) {
            return;
        }
        st.fallback_to = Some(model);
        self.emit(
            st,
            SessionEvent::Fallback {
                from: report.from,
                to: report.to,
                reason: report.reason,
            },
        );
    }

    /// Ends the child: end of input, 15 s, TERM, 5 s, KILL (decision 8), and writes the stop record.
    async fn end(&self, how: &str, detail: Option<String>) -> StopRecord {
        if let Some(record) = self.lock().stop.clone() {
            return record;
        }
        self.lock().stopping = true;
        self.rpc.end_input().await;
        let proc = self.proc.lock().await.take();
        let (how, detail, cleanup) = match proc {
            Some(Proc::Child(child)) => {
                let (exit, step) = child.close(CLOSE_WAIT, KILL_GRACE).await;
                let cleanup = if exit == Exit::Unknown {
                    Cleanup::Unknown
                } else {
                    Cleanup::LocalReaped
                };
                let (how, detail) = match (step, exit) {
                    (Step::Input, Exit::Code(0)) => (how.to_string(), detail),
                    (Step::Input, exit) => ("exited".into(), Some(format!("{exit:?}"))),
                    (Step::Term, exit) => ("term".into(), Some(format!("needed TERM ({exit:?})"))),
                    (Step::Kill, exit) => ("kill".into(), Some(format!("needed KILL ({exit:?})"))),
                };
                (how, detail, cleanup)
            }
            Some(Proc::Remote(mut remote)) => {
                // The worker closes its OMP by the same rule once its input ended and acknowledges
                // the reap; the end of its output proves no exit.
                let (state, killed) = remote.reaped().await;
                let cleanup = super::lead::ownership::worker_cleanup(&state);
                if !cleanup.confirmed() {
                    let state = format!("{state:?}");
                    log::warn(
                        "remote session exit not acknowledged",
                        &[
                            ("handle", &self.handle),
                            ("attempt", &remote.exit.attempt()),
                            ("state", &state),
                        ],
                    );
                }
                if killed {
                    (
                        "kill".into(),
                        Some(format!("needed KILL on {}", remote.worker)),
                        cleanup,
                    )
                } else {
                    (how.to_string(), detail, cleanup)
                }
            }
            #[cfg(test)]
            Some(Proc::Fake) => (how.to_string(), detail, Cleanup::LocalReaped),
            None => (how.to_string(), detail, Cleanup::Unknown),
        };
        self.record_stop(how, detail, cleanup)
    }

    fn record_stop(&self, how: String, detail: Option<String>, cleanup: Cleanup) -> StopRecord {
        let mut st = self.lock();
        if let Some(record) = st.stop.clone() {
            return record;
        }
        if let Some(ownership) = &self.settings.ownership
            && let Err(error) = ownership.finished(cleanup)
        {
            log::warn(
                "startup ownership receipt not persisted",
                &[("error", &error)],
            );
        }
        let record = StopRecord {
            cleanup,
            how,
            detail,
            session_id: st.bound.as_ref().map(|(id, _)| id.clone()),
            at_ms: now_ms(),
        };
        st.stop = Some(record.clone());
        st.dialogs.clear();
        self.emit(
            &mut st,
            SessionEvent::Stopped {
                record: record.clone(),
            },
        );
        self.publish(&mut st);
        record
    }

    fn queue_readback(self: &Arc<Self>) {
        if self.readback_queued.swap(true, Ordering::AcqRel) {
            return;
        }
        let me = Arc::clone(self);
        tokio::spawn(async move {
            me.readback_queued.store(false, Ordering::Release);
            let _ = me.readback().await;
        });
    }

    async fn on_frame(self: &Arc<Self>, frame: &Value) {
        let kind = frame
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match kind {
            "agent_start" => {
                let mut st = self.lock();
                st.fresh = false;
                st.turn_started_ms.get_or_insert_with(now_ms);
                if let Some(written) = st.wake_written.take() {
                    self.settings.agent_start.record(written.elapsed());
                }
                self.emit(&mut st, SessionEvent::TurnStarted);
                self.publish(&mut st);
            }
            "agent_end" => {
                let will_continue = frame.get("isTerminal") == Some(&Value::Bool(false))
                    || frame.get("awaitingAsyncWork") == Some(&Value::Bool(true));
                let mut st = self.lock();
                st.fresh = false;
                st.turn_done = true;
                self.emit(&mut st, SessionEvent::TurnEnded { will_continue });
                self.publish(&mut st);
                drop(st);
                self.queue_readback();
            }
            "message_end" => self.on_message(frame),
            "command_output" => {
                if let Some(entry) = dialogs::entry_of(frame) {
                    let mut st = self.lock();
                    push_ring(&mut st, entry);
                    self.publish(&mut st);
                }
            }
            "extension_ui_request" => self.on_ui(frame).await,
            "prompt_result" => self.on_prompt_result(frame),
            "session_settled" => {
                let mut st = self.lock();
                st.fresh = false;
                self.emit(&mut st, SessionEvent::Quiet);
                drop(st);
                self.queue_readback();
            }
            "retry_fallback_applied" => {
                let text = |k: &str| {
                    frame.get(k).map_or_else(String::new, |v| {
                        v.as_str().map_or_else(|| v.to_string(), str::to_string)
                    })
                };
                // The report is checked against the model in use: OMP may repeat it for one move,
                // and its advisors report their own fallbacks, which do not move the session.
                let mut st = self.lock();
                st.fallback_report = Some(FallbackReport {
                    from: text("from"),
                    to: text("to"),
                    reason: text("reason"),
                });
                self.settle_fallback(&mut st);
                st.fresh = false;
                self.publish(&mut st);
                drop(st);
                self.queue_readback();
            }
            "model_changed" => {
                // OMP 19.1.1 sends this frame without the model; the readback names it.
                let mut st = self.lock();
                st.fresh = false;
                self.publish(&mut st);
                drop(st);
                self.queue_readback();
            }
            "rpc_frame_error" => {
                self.fault("OMP lost a frame (rpc_frame_error); trust in the stream ended");
            }
            _ => {}
        }
        if self.rpc.dropped_events() > 0 {
            self.fault("session events were dropped; trust in the stream ended");
        }
    }

    fn on_message(&self, frame: &Value) {
        let Some(message) = frame.get("message") else {
            return;
        };
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if role != "assistant" && role != "user" {
            return;
        }
        let Some(text) = dialogs::message_text(message).filter(|t| !t.trim().is_empty()) else {
            return;
        };
        let mut st = self.lock();
        if let Some(entry) = dialogs::entry_of(frame) {
            push_ring(&mut st, entry);
        }
        let (text, truncated) = cut(&text);
        self.emit(
            &mut st,
            SessionEvent::Message {
                role: role.to_string(),
                text,
                truncated,
            },
        );
        self.publish(&mut st);
    }

    async fn on_ui(&self, frame: &Value) {
        match dialogs::ui_frame(frame) {
            UiFrame::Open(dialog) if spend_offer(&dialog, &self.settings.spend_phrases) => {
                self.cancel_offer(dialog).await;
            }
            UiFrame::Open(dialog) => {
                let mut st = self.lock();
                match st.dialogs.iter_mut().find(|d| d.id == dialog.id) {
                    Some(same) => *same = dialog.clone(),
                    None => st.dialogs.push(dialog.clone()),
                }
                self.emit(&mut st, SessionEvent::DialogOpened { dialog });
                self.publish(&mut st);
            }
            UiFrame::Cancel(id) => {
                let mut st = self.lock();
                let before = st.dialogs.len();
                st.dialogs.retain(|d| d.id != id);
                if st.dialogs.len() != before {
                    self.emit(&mut st, SessionEvent::DialogClosed { id });
                    self.publish(&mut st);
                }
            }
            UiFrame::Notice(_) => {
                if let Some(entry) = dialogs::entry_of(frame) {
                    let mut st = self.lock();
                    push_ring(&mut st, entry);
                    self.publish(&mut st);
                }
            }
            UiFrame::Ignore => {}
        }
    }

    /// Cancels a spend offer at once (DESIGN 9.2): never "no", never a remembered choice. A repeat of a
    /// cancelled dialog, or the third offer in 10 minutes, fences the session.
    async fn cancel_offer(&self, dialog: Dialog) {
        let sent = self
            .rpc
            .send(&AnswerFrame::cancel(&dialog.id).to_map())
            .await;
        let now = now_ms();
        let (count, repeat) = {
            let mut st = self.lock();
            let repeat = note_cancelled(&mut st.cancelled_offers, &dialog.id);
            st.spend_offers.push_back(now);
            while st
                .spend_offers
                .front()
                .is_some_and(|t| now - t > SPEND_WINDOW_MS)
            {
                st.spend_offers.pop_front();
            }
            let count = st.spend_offers.len();
            let title = dialog
                .title
                .clone()
                .or_else(|| dialog.message.clone())
                .unwrap_or_else(|| dialog.id.clone());
            self.emit(&mut st, SessionEvent::SpendOffer { title, count });
            self.publish(&mut st);
            (count, repeat)
        };
        log::warn(
            "spend offer cancelled",
            &[("handle", &self.handle), ("count", &count)],
        );
        if let Err(e) = sent {
            self.fault(&format!("a spend offer could not be cancelled: {e}"));
        } else if repeat {
            self.fault("a spend offer stayed after it was cancelled");
        } else if count >= SPEND_LIMIT {
            self.fault("three spend offers within 10 minutes");
        }
    }

    fn on_prompt_result(self: &Arc<Self>, frame: &Value) {
        let status = frame
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let error = frame.get("error");
        let message = error
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let mut st = self.lock();
        st.fresh = false;
        if status == "error" && error.is_some_and(is_usage_limit) {
            let text = message
                .clone()
                .unwrap_or_else(|| "usage limit reached".into());
            if st.quota_blocked.is_none() {
                st.quota_blocked = Some(text.clone());
                self.emit(&mut st, SessionEvent::QuotaBlocked { message: text });
            }
        } else if status == "completed" {
            st.quota_blocked = None;
        }
        self.emit(
            &mut st,
            SessionEvent::Settled {
                status,
                error: message,
            },
        );
        self.publish(&mut st);
        drop(st);
        self.queue_readback();
    }
}

/// The delivery checks of HOST req. 50 that read the session state, in order.
fn ready_for(st: &State, expected: &str) -> Result<(), String> {
    let Some((id, _)) = &st.bound else {
        return Err("not bound".into());
    };
    if id != expected {
        return Err(format!("the session is {id}, not the expected {expected}"));
    }
    if let Some(reason) = st.fault.as_ref().or(st.held.as_ref()) {
        return Err(reason.clone());
    }
    if st.stopping || st.stop.is_some() {
        return Err("stopping".into());
    }
    if !st.dialogs.is_empty() {
        return Err("a dialog is pending".into());
    }
    match st.latest.as_ref().map(|s| s.goal.status) {
        Some(dialogs::GoalStatus::Paused) => Err("the goal is paused".into()),
        Some(dialogs::GoalStatus::Blocked) => Err("the goal is blocked by its budget".into()),
        _ => Ok(()),
    }
}

fn push_ring(st: &mut State, entry: Entry) {
    st.ring.push_back(entry);
    while st.ring.len() > RING {
        st.ring.pop_front();
    }
}

/// Applies every event in order. When OMP's output ends without a close request, the child exited
/// by itself: it is reaped and the stop record says so (HOST req. 70).
async fn event_loop(inner: Arc<Inner>, mut events: mpsc::Receiver<Value>) {
    while let Some(frame) = events.recv().await {
        inner.on_frame(&frame).await;
    }
    let asked = inner.lock().stopping;
    if asked {
        return;
    }
    let proc = inner.proc.lock().await.take();
    let (detail, cleanup) = match proc {
        Some(Proc::Child(child)) => {
            let (exit, _) = child.close(Duration::from_secs(1), KILL_GRACE).await;
            (
                format!("{exit:?}"),
                if exit == Exit::Unknown {
                    Cleanup::Unknown
                } else {
                    Cleanup::LocalReaped
                },
            )
        }
        Some(Proc::Remote(mut remote)) => {
            // The worker reaps an OMP whose output ended, and acknowledges it.
            let (state, _) = remote.reaped().await;
            (
                format!("output closed on {}", remote.worker),
                super::lead::ownership::worker_cleanup(&state),
            )
        }
        #[cfg(test)]
        Some(Proc::Fake) => ("output closed".into(), Cleanup::LocalReaped),
        None => ("output closed".into(), Cleanup::Unknown),
    };
    log::warn(
        "session child exited",
        &[("handle", &inner.handle), ("detail", &detail)],
    );
    inner.record_stop("exited".into(), Some(detail), cleanup);
}

impl Control for Session {
    fn snapshot(&self) -> Arc<Snapshot> {
        Arc::clone(&self.inner.snapshot.borrow())
    }

    fn states(&self) -> watch::Receiver<Arc<Snapshot>> {
        self.inner.snapshot.subscribe()
    }

    fn subscribe(&self) -> broadcast::Receiver<(u64, SessionEvent)> {
        self.inner.events.subscribe()
    }

    fn events_after(&self, after: u64, limit: usize) -> EventPage {
        let st = self.inner.lock();
        let oldest = st.log.front().map_or(st.seq + 1, |(n, _)| *n);
        EventPage {
            missed: after + 1 < oldest,
            events: st
                .log
                .iter()
                .filter(|(n, _)| *n > after)
                .take(limit.clamp(1, EVENT_PAGE))
                .cloned()
                .collect(),
        }
    }

    fn alive(&self) -> bool {
        self.inner.lock().stop.is_none()
    }

    async fn refresh(&self) -> Result<(), String> {
        self.inner.readback().await
    }

    async fn deliver(&self, delivery: Delivery) -> DeliverOutcome {
        let _busy = match self.begin() {
            Ok(b) => b,
            Err(reason) => return DeliverOutcome::Refused(reason),
        };
        self.deliver_now(delivery).await
    }

    async fn interrupt(&self) -> Result<String, String> {
        let _busy = self.begin()?;
        let inner = &self.inner;
        inner.readback().await?;
        let running = inner.lock().latest.as_ref().is_some_and(|s| s.foreground);
        if !running {
            return Err("nothing to interrupt".into());
        }
        match inner.call("abort", &[]).await {
            Ok(reply) if reply.success => {}
            Ok(reply) => return Err(reply.error.unwrap_or_else(|| "OMP refused abort".into())),
            Err(e) => {
                inner.fault(&format!("abort unconfirmed: {e}"));
                return Err("abort sent, outcome unknown".into());
            }
        }
        let stopped = inner.readback().await.is_ok()
            && !inner.lock().latest.as_ref().is_some_and(|s| s.foreground);
        if stopped {
            Ok("interrupted; background jobs are not targeted".into())
        } else {
            let mut st = inner.lock();
            inner.emit(&mut st, SessionEvent::InterruptUnconfirmed);
            Err("abort sent, stop unconfirmed".into())
        }
    }

    /// Moves the session to what OMP resolves `selector` to (HOST req. 27): the base model, then
    /// the level its suffix requests, each read back. A bridge that cannot resolve it changes
    /// nothing.
    async fn set_model(&self, selector: &str) -> Result<Resolution, String> {
        let _busy = self.begin()?;
        let inner = &self.inner;
        if selector.len() > 256 || !crate::omp::transcript::model_selector(selector) {
            return Err("expected provider/id without spaces, at most 256 characters".into());
        }
        inner.readback().await?;
        let current = {
            let st = inner.lock();
            if st.fault.is_some() || st.held.is_some() || !st.dialogs.is_empty() {
                return Err("the session is held".into());
            }
            if !st.latest.as_ref().is_some_and(ReadState::idle) {
                return Err("the session is not idle".into());
            }
            st.latest.clone()
        };
        let until = tokio::time::Instant::now() + RESPONSE_TIMEOUT;
        let r = match inner
            .settings
            .links
            .resolve_model(&inner.handle, selector, None, (until, until))
            .await?
        {
            Proof::Resolved(r) => r,
            Proof::Unverified(why) => {
                return Err(format!("model unverified: {why}; nothing was changed"));
            }
        };
        let (model, thinking) = current.map_or((None, None), |s| (s.model, s.thinking));
        let mut calls = Vec::new();
        if !model.as_deref().is_some_and(|m| same_model(m, &r.model())) {
            calls.push((
                "set_model",
                vec![("provider", json!(r.provider)), ("modelId", json!(r.id))],
            ));
        }
        if let Some(level) = r
            .requested
            .as_deref()
            .filter(|l| thinking.as_deref() != Some(*l))
        {
            calls.push(("set_thinking_level", vec![("level", json!(level))]));
        }
        for (kind, fields) in calls {
            match inner.call(kind, &fields).await {
                Ok(reply) if reply.success => {}
                Ok(reply) => {
                    return Err(reply.error.unwrap_or_else(|| format!("OMP refused {kind}")));
                }
                Err(e) => {
                    inner.fault(&format!("model change unconfirmed: {e}"));
                    return Err("model change unconfirmed; check the current model".into());
                }
            }
        }
        {
            // A change asked for here is no fallback and becomes the expected model; the
            // readback after it must be new.
            let mut st = inner.lock();
            st.fallback_report = None;
            st.asked_model = Some(selector.to_string());
            st.resolution = Some(r.clone());
            st.fresh = false;
            inner.publish(&mut st);
        }
        inner.readback().await?;
        let (model, thinking) = inner
            .lock()
            .latest
            .clone()
            .map_or((None, None), |s| (s.model, s.thinking));
        match r.judge(model.as_deref(), thinking.as_deref()) {
            None => {
                // Only a confirmed change moves the pin the lane barrier holds turns to.
                inner.settings.links.resolved(&inner.handle, r.clone());
                Ok(r)
            }
            Some(reason) => Err(format!("model readback: {reason}")),
        }
    }

    async fn goal(&self, op: &str, objective: Option<&str>) -> Result<dialogs::Goal, String> {
        let _busy = self.begin()?;
        let inner = &self.inner;
        let mut fields = vec![("op", json!(op))];
        if let Some(objective) = objective {
            fields.push(("objective", json!(objective)));
        }
        match inner.call("goal", &fields).await {
            Ok(reply) if reply.success => {}
            Ok(reply) => {
                return Err(reply
                    .error
                    .unwrap_or_else(|| format!("OMP refused goal {op}")));
            }
            Err(e) => return Err(format!("goal {op} unconfirmed: {e}")),
        }
        {
            let mut st = inner.lock();
            st.fresh = false;
            inner.publish(&mut st);
        }
        inner.readback().await?;
        inner
            .lock()
            .latest
            .as_ref()
            .map(|s| s.goal.clone())
            .ok_or_else(|| "no goal readback".to_string())
    }

    async fn answer(
        &self,
        session_id: &str,
        dialog_id: &str,
        answer: &Value,
    ) -> Result<(), String> {
        let _busy = self.begin()?;
        let inner = &self.inner;
        let frame = {
            let mut st = inner.lock();
            if st.bound.as_ref().map(|(id, _)| id.as_str()) != Some(session_id) {
                return Err("the answer names another session".into());
            }
            if st.fault.is_some() {
                return Err("the session is faulted".into());
            }
            let Some(dialog) = st.dialogs.iter().find(|d| d.id == dialog_id).cloned() else {
                return Err("no such pending dialog".into());
            };
            let Some(frame) = dialogs::answer_frame(&dialog, answer) else {
                return Err("this answer is not allowed for the dialog".into());
            };
            // Removed before the write (HOST req. 48).
            st.dialogs.retain(|d| d.id != dialog_id);
            inner.emit(
                &mut st,
                SessionEvent::DialogClosed {
                    id: dialog_id.to_string(),
                },
            );
            inner.publish(&mut st);
            frame
        };
        if let Err(e) = inner.rpc.send(&frame.to_map()).await {
            inner.fault(&format!("answer unconfirmed: {e}"));
            return Err("ambiguous; do not resend".into());
        }
        Ok(())
    }

    /// Accepts the model OMP reports after a mismatch or an unverified model: it becomes the
    /// expected one.
    fn accept_model(&self) -> Result<(), String> {
        let mut st = self.inner.lock();
        if !st.held.as_deref().is_some_and(super::model::accepts) {
            return Err(
                "the session is not held for a model mismatch or an unverified model".into(),
            );
        }
        st.held = None;
        st.resolution = None;
        st.asked_model = st.latest.as_ref().and_then(|s| s.model.clone());
        self.inner.publish(&mut st);
        Ok(())
    }

    async fn close(&self, force: bool) -> Result<StopRecord, String> {
        let _busy = self.begin()?;
        let inner = &self.inner;
        if let Some(record) = inner.lock().stop.clone() {
            return Ok(record);
        }
        let faulted = inner.lock().fault.is_some();
        if !faulted {
            let _ = inner.readback().await;
            let (idle, dialogs) = {
                let st = inner.lock();
                (
                    st.latest.as_ref().is_some_and(ReadState::idle),
                    !st.dialogs.is_empty(),
                )
            };
            if dialogs {
                return Err("a dialog is pending; answer it first".into());
            }
            if !idle {
                if !force {
                    return Err("the session is working; close with force to interrupt it".into());
                }
                let _ = inner.call("abort", &[]).await;
                let deadline = Instant::now() + FORCE_IDLE_WAIT;
                loop {
                    let _ = inner.readback().await;
                    let (dialog, done) = {
                        let st = inner.lock();
                        (
                            !st.dialogs.is_empty(),
                            st.latest.as_ref().is_some_and(ReadState::idle),
                        )
                    };
                    if dialog {
                        return Err("a dialog appeared while stopping; answer it first".into());
                    }
                    if done || Instant::now() >= deadline {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
            }
        }
        let how = if force || faulted { "forced" } else { "clean" };
        Ok(inner.end(how, None).await)
    }
}

/// Remembers a cancelled offer; `true` when it was cancelled before.
fn note_cancelled(cancelled: &mut VecDeque<String>, id: &str) -> bool {
    if cancelled.iter().any(|c| c == id) {
        return true;
    }
    if cancelled.len() >= CANCELLED_KEEP {
        cancelled.pop_front();
    }
    cancelled.push_back(id.to_string());
    false
}

/// A remote worker's launch environment: nothing of this machine's, then the role's policy pins
/// last so they outrank the worker's own `.env` files (DESIGN 12.2 A13).
fn worker_env(token: &str, role: crate::omp::tools::Role) -> Vec<(String, String)> {
    let mut env = vec![
        ("PI_NOTIFICATIONS".to_string(), "off".to_string()),
        ("CATALY_LAUNCH".to_string(), token.to_string()),
    ];
    env.extend(
        crate::omp::launch::policy_env(role)
            .into_iter()
            .map(|(k, v)| (k.to_string(), v)),
    );
    env
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::testing::{Fake, spec};

    #[test]
    fn worker_env_ends_with_the_policy_pins() {
        use crate::omp::tools::Role as ToolRole;
        for role in [ToolRole::Lead, ToolRole::Lane, ToolRole::LookOnly] {
            let env = worker_env("PI_PY=1", role);
            let tail: Vec<(&str, &str)> = env[env.len() - 2..]
                .iter()
                .map(|(k, v)| (k.as_str(), v.as_str()))
                .collect();
            assert_eq!(tail, [("PI_PY", "0"), ("PI_JS", "0")], "{role:?}");
        }
    }

    #[test]
    fn cancelled_offers_are_bounded_and_repeats_known() {
        let mut cancelled = VecDeque::new();
        for n in 0..1000 {
            assert!(!note_cancelled(&mut cancelled, &format!("o{n}")));
        }
        assert_eq!(cancelled.len(), CANCELLED_KEEP);
        assert!(note_cancelled(&mut cancelled, "o999"));
    }

    /// A failed remote spawn says what its answer proves: a refusal started nothing, a recorded
    /// failure carries the worker's state, and no answer is unknown ownership.
    #[test]
    fn remote_spawn_failures_carry_what_they_prove() {
        use crate::worker::attempt::{AttemptState, Reaped};
        use crate::worker::link::SpawnError;
        assert_eq!(
            spawn_failed("box", SpawnError::Refused("busy".into())),
            StartError::Refused("box: busy".into())
        );
        let ended = |state| SpawnError::Ended {
            detail: "no pipes".into(),
            state,
        };
        let cleanup = |error| match spawn_failed("box", error) {
            StartError::Startup {
                stage: StartupStage::Spawn,
                cleanup,
                ..
            } => cleanup,
            other => panic!("{other:?}"),
        };
        let reaped = |exit| AttemptState::Reaped {
            exit,
            lease: super::super::lead::Lease::Unknown,
        };
        assert_eq!(
            cleanup(ended(reaped(Reaped::NotSpawned))),
            Cleanup::NotSpawned
        );
        assert_eq!(
            cleanup(ended(reaped(Reaped::Signal(9)))),
            Cleanup::WorkerReaped
        );
        let unreaped = AttemptState::Unknown {
            reason: "the worker could not reap its OMP after KILL".into(),
        };
        assert_eq!(cleanup(ended(unreaped)), Cleanup::Unknown);
        assert_eq!(
            cleanup(SpawnError::Unanswered("spawn took longer than 30 s".into())),
            Cleanup::Unknown
        );
    }

    /// A remote session's OMP counts as ended only by the worker's acknowledgement of its reap; a
    /// disconnect before it stays unknown, and is not taken for a timeout needing KILL.
    #[tokio::test]
    async fn a_remote_stop_is_proven_only_by_the_workers_acknowledgement() {
        use crate::worker::attempt::{AttemptState, Reaped};
        let root = crate::sys::fs::tests::scratch("headless-remote");
        let cwd = root.display().to_string();
        let (link, _serving) = crate::worker::link::tests::served(&root);
        let argv = ["omp".into(), "-c".into(), "exec cat >/dev/null".into()];
        let spawned = link.spawn(&argv, &cwd, &[], "r1", None).await.unwrap();
        // The stream's end is the end of the OMP's input, as `end` closes it.
        drop(spawned.stream);
        let mut acknowledged = Remote {
            worker: "box".into(),
            channel: spawned.channel,
            hold: spawned.hold,
            exit: spawned.exit,
        };
        let (state, killed) = acknowledged.reaped().await;
        assert!(!killed);
        assert!(matches!(
            state,
            AttemptState::Reaped {
                exit: Reaped::Code(0),
                ..
            }
        ));
        assert_eq!(
            super::super::lead::ownership::worker_cleanup(&state),
            Cleanup::WorkerReaped
        );
        let argv = ["omp".into(), "-c".into(), "exec sleep 30".into()];
        let spawned = link.spawn(&argv, &cwd, &[], "r2", None).await.unwrap();
        let mut dropped = Remote {
            worker: "box".into(),
            channel: spawned.channel,
            hold: spawned.hold,
            exit: spawned.exit,
        };
        link.mux.close();
        let (state, killed) = dropped.reaped().await;
        assert!(!killed, "a disconnect answers at once");
        assert_eq!(
            super::super::lead::ownership::worker_cleanup(&state),
            Cleanup::Unknown
        );
        drop(spawned.stream);
    }

    async fn started(fake: &Fake) -> Arc<Session> {
        let (session, started) = fake.bind(spec("h1", None)).await.unwrap();
        assert_eq!(started.session_id, fake.session_id());
        assert_eq!(started.held, None);
        session
    }

    #[tokio::test]
    async fn handshake_binds_identity_and_delivers_a_wake() {
        let fake = Fake::start();
        let session = started(&fake).await;
        assert_eq!(session.snapshot().status, Status::Idle);
        let outcome = session
            .deliver(Delivery {
                expected_session: fake.session_id(),
                text: "/help me".into(),
                timing: Timing::Any,
                steer: false,
                fresh: false,
            })
            .await;
        assert!(
            matches!(
                outcome,
                DeliverOutcome::Delivered {
                    turn_started: true,
                    written: Some(_)
                }
            ),
            "{outcome:?}"
        );
        let prompt = fake.seen("prompt").pop().unwrap();
        assert_eq!(prompt["streamingBehavior"], "followUp");
        assert!(
            prompt["message"]
                .as_str()
                .unwrap()
                .starts_with("[message]\n/help")
        );
        let wrong = session
            .deliver(Delivery {
                expected_session: "other".into(),
                text: "x".into(),
                timing: Timing::Any,
                steer: false,
                fresh: false,
            })
            .await;
        assert!(matches!(wrong, DeliverOutcome::NotReady(..)), "{wrong:?}");
    }

    /// A paused goal refuses delivery, and the outcome names the goal, not the idle status.
    #[tokio::test]
    async fn a_paused_goal_is_named_as_the_reason() {
        let fake = Fake::start();
        let session = started(&fake).await;
        fake.set(|s| s.goal = Some("paused"));
        let outcome = session
            .deliver(Delivery {
                expected_session: fake.session_id(),
                text: "x".into(),
                timing: Timing::Any,
                steer: false,
                fresh: false,
            })
            .await;
        assert_eq!(
            outcome,
            DeliverOutcome::NotReady(Status::Idle, "the goal is paused".into())
        );
        assert_eq!(fake.seen("prompt").len(), 0);
    }

    #[tokio::test]
    async fn a_busy_session_gets_a_follow_up_and_steer_needs_a_turn() {
        let fake = Fake::start();
        let session = started(&fake).await;
        let steer = session
            .deliver(Delivery {
                expected_session: fake.session_id(),
                text: "x".into(),
                timing: Timing::Any,
                steer: true,
                fresh: false,
            })
            .await;
        assert_eq!(
            steer,
            DeliverOutcome::Refused("no running turn to steer".into())
        );
        fake.set(|s| s.streaming = true);
        let follow = session
            .deliver(Delivery {
                expected_session: fake.session_id(),
                text: "second".into(),
                timing: Timing::Any,
                steer: false,
                fresh: false,
            })
            .await;
        assert!(
            matches!(
                follow,
                DeliverOutcome::Delivered {
                    turn_started: false,
                    ..
                }
            ),
            "{follow:?}"
        );
        assert_eq!(fake.seen("follow_up").len(), 1);
        let idle_only = session
            .deliver(Delivery {
                expected_session: fake.session_id(),
                text: "x".into(),
                timing: Timing::Idle,
                steer: false,
                fresh: false,
            })
            .await;
        assert_eq!(idle_only, DeliverOutcome::wrong_timing(Status::Working));
    }

    /// Acceptance check 6: a transcript switch, a model mismatch at start and an `rpc_frame_error`
    /// each fence the session; nothing is delivered afterwards.
    #[tokio::test]
    async fn switch_mismatch_and_frame_error_fence() {
        let deliver = |session: Arc<Session>, id: String| async move {
            session
                .deliver(Delivery {
                    expected_session: id,
                    text: "hello".into(),
                    timing: Timing::Any,
                    steer: false,
                    fresh: false,
                })
                .await
        };
        let fake = Fake::start();
        let session = started(&fake).await;
        fake.set(|s| s.session_id = "switched".into());
        let outcome = deliver(Arc::clone(&session), fake.session_id()).await;
        assert!(
            matches!(outcome, DeliverOutcome::NotReady(Status::Error, _)),
            "{outcome:?}"
        );
        assert!(
            session
                .snapshot()
                .reason
                .clone()
                .unwrap()
                .contains("switched transcripts")
        );
        assert_eq!(fake.seen("prompt").len(), 0);

        let fake = Fake::start();
        fake.set(|s| s.model = ("other".into(), "m".into()));
        let (session, bound) = fake.bind(spec("h2", None)).await.unwrap();
        assert!(bound.held.unwrap().contains("model mismatch"));
        let outcome = deliver(Arc::clone(&session), fake.session_id()).await;
        assert!(
            matches!(outcome, DeliverOutcome::NotReady(..)),
            "{outcome:?}"
        );
        assert_eq!(fake.seen("prompt").len(), 0);

        let fake = Fake::start();
        let session = started(&fake).await;
        fake.push(json!({"type": "rpc_frame_error", "error": "too large"}));
        let snapshot = fake.wait_for(&session, |s| s.status == Status::Error).await;
        assert!(snapshot.reason.clone().unwrap().contains("rpc_frame_error"));
        let outcome = deliver(Arc::clone(&session), fake.session_id()).await;
        assert!(
            matches!(outcome, DeliverOutcome::NotReady(Status::Error, _)),
            "{outcome:?}"
        );
        assert_eq!(fake.seen("prompt").len(), 0);
    }

    /// Acceptance check 8: a spend offer is cancelled within 1 s and reported; three in 10 minutes fence.
    #[tokio::test]
    async fn spend_offers_are_cancelled_and_fence_at_three() {
        let fake = Fake::start();
        let session = started(&fake).await;
        let mut events = session.subscribe();
        for n in 1..=3 {
            let opened = Instant::now();
            fake.push(json!({
                "type": "extension_ui_request", "id": format!("offer-{n}"), "method": "select",
                "title": "Usage limit reached", "options": ["Redeem saved reset", "Wait"],
            }));
            let cancel = fake.wait_seen("extension_ui_response", n).await;
            assert!(opened.elapsed() < Duration::from_secs(1));
            assert_eq!(cancel["cancelled"], true);
            assert_eq!(cancel["id"], format!("offer-{n}"));
            assert!(cancel.get("value").is_none());
        }
        let snapshot = fake.wait_for(&session, |s| s.status == Status::Error).await;
        assert!(
            snapshot
                .reason
                .clone()
                .unwrap()
                .contains("three spend offers")
        );
        let mut offers = 0;
        while let Ok((_, event)) = events.try_recv() {
            if matches!(event, SessionEvent::SpendOffer { .. }) {
                offers += 1;
            }
        }
        assert_eq!(offers, 3);
        assert!(snapshot.dialogs.is_empty(), "offers never stay pending");
    }

    /// Acceptance check 9 (session side): one fallback event per move OMP makes, however often it
    /// reports it, and one restore; a usage-limit `prompt_result` marks the session quota-blocked;
    /// `extraUsage` fences.
    #[tokio::test]
    async fn fallback_quota_and_extra_usage() {
        let fake = Fake::start();
        let session = started(&fake).await;
        let mut events = session.subscribe();
        let report = json!({"type": "retry_fallback_applied", "from": "fake/primary:high", "to": "fake/backup:high", "role": "default", "reason": "usage limit"});
        // A message after the reports: once it shows, the reports before it are handled.
        let sync = json!({"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "sync"}]}});
        // OMP switches the model during a turn (a bare `model_changed`), then reports the fallback.
        fake.set(|s| {
            s.streaming = true;
            s.model = ("fake".into(), "backup".into());
        });
        fake.push(json!({"type": "model_changed"}));
        fake.push(report.clone());
        fake.wait_for(&session, |s| s.model.as_deref() == Some("fake/backup"))
            .await;
        // The same move reported again, and an advisor's report that moves nothing.
        fake.push(report);
        fake.push(json!({"type": "model_changed"}));
        fake.push(json!({"type": "retry_fallback_applied", "from": "fake/primary", "to": "fake/other", "role": "advisor", "reason": "usage limit"}));
        fake.push(sync);
        fake.wait_for(&session, |s| s.recent.iter().any(|e| e.text == "sync"))
            .await;
        // OMP restores the requested model; the turn ends.
        fake.set(|s| {
            s.streaming = false;
            s.model = ("fake".into(), "primary".into());
        });
        fake.push(json!({"type": "model_changed"}));
        fake.wait_for(&session, |s| s.model.as_deref() == Some("fake/primary"))
            .await;
        fake.push(json!({"type": "prompt_result", "id": "x", "agentInvoked": true, "status": "error",
            "error": {"message": "You have hit your usage limit", "retryable": false}, "sessionSettled": true}));
        let snapshot = fake.wait_for(&session, |s| s.quota_blocked.is_some()).await;
        assert!(
            snapshot
                .quota_blocked
                .clone()
                .unwrap()
                .contains("usage limit")
        );
        let mut kinds = Vec::new();
        while let Ok((_, event)) = events.try_recv() {
            if matches!(
                event,
                SessionEvent::Fallback { .. }
                    | SessionEvent::FallbackRecovered { .. }
                    | SessionEvent::ModelChanged { .. }
                    | SessionEvent::QuotaBlocked { .. }
                    | SessionEvent::ModelUnexpected { .. }
            ) {
                kinds.push(event);
            }
        }
        assert_eq!(kinds.len(), 5, "{kinds:?}");
        assert!(
            matches!(&kinds[0], SessionEvent::ModelChanged { model } if model == "fake/backup")
        );
        assert!(
            matches!(&kinds[1], SessionEvent::Fallback { from, to, .. } if from == "fake/primary:high" && to == "fake/backup:high")
        );
        assert!(
            matches!(&kinds[2], SessionEvent::ModelChanged { model } if model == "fake/primary")
        );
        assert!(matches!(&kinds[3], SessionEvent::FallbackRecovered { .. }));
        assert!(matches!(&kinds[4], SessionEvent::QuotaBlocked { .. }));
        fake.set(|s| s.extra_usage = true);
        let outcome = session
            .deliver(Delivery {
                expected_session: fake.session_id(),
                text: "owner request".into(),
                timing: Timing::Any,
                steer: false,
                fresh: false,
            })
            .await;
        assert!(
            matches!(outcome, DeliverOutcome::NotReady(Status::Error, _)),
            "{outcome:?}"
        );
        assert!(
            session
                .snapshot()
                .reason
                .clone()
                .unwrap()
                .contains("extra usage")
        );
    }

    #[tokio::test]
    async fn dialogs_are_answered_once_and_close_refuses_while_pending() {
        let fake = Fake::start();
        let session = started(&fake).await;
        fake.push(
            json!({"type": "extension_ui_request", "id": "a1", "method": "select",
            "title": "Run bash?", "options": ["Approve Once", "Approve for this session", "Deny"]}),
        );
        fake.wait_for(&session, |s| s.status == Status::Blocked)
            .await;
        assert!(session.close(false).await.unwrap_err().contains("dialog"));
        let id = fake.session_id();
        assert!(
            session
                .answer(&id, "a1", &json!({"value": "Approve for this session"}))
                .await
                .is_err()
        );
        assert!(
            session
                .answer("other", "a1", &json!({"value": "Deny"}))
                .await
                .is_err()
        );
        session
            .answer(&id, "a1", &json!({"value": "Deny"}))
            .await
            .unwrap();
        assert_eq!(
            fake.wait_seen("extension_ui_response", 1).await["value"],
            "Deny"
        );
        assert!(
            session
                .answer(&id, "a1", &json!({"value": "Deny"}))
                .await
                .is_err()
        );
        let record = session.close(false).await.unwrap();
        assert_eq!(record.how, "clean");
        assert_eq!(record.session_id, Some(id));
        assert!(!session.alive());
    }

    /// A turn that ends on a model nobody asked for and OMP never reported as a fallback is
    /// reported once, urgent for the owner (DESIGN 6.1); a model the hub asked for is not.
    #[tokio::test]
    async fn an_unreported_model_is_reported_once() {
        let fake = Fake::start();
        let session = started(&fake).await;
        let mut events = session.subscribe();
        let sync = |text: &str| json!({"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}});
        fake.set(|s| s.model = ("fake".into(), "other".into()));
        fake.push(json!({"type": "model_changed"}));
        fake.wait_for(&session, |s| s.model.as_deref() == Some("fake/other"))
            .await;
        fake.push(json!({"type": "model_changed"}));
        fake.push(sync("one"));
        fake.wait_for(&session, |s| s.recent.iter().any(|e| e.text == "one"))
            .await;
        assert_eq!(
            session.set_model("fake/backup").await.unwrap().model(),
            "fake/backup"
        );
        fake.push(json!({"type": "model_changed"}));
        fake.push(sync("two"));
        fake.wait_for(&session, |s| s.recent.iter().any(|e| e.text == "two"))
            .await;
        let mut unexpected = Vec::new();
        while let Ok((_, event)) = events.try_recv() {
            if let SessionEvent::ModelUnexpected { model, requested } = event {
                unexpected.push((model, requested));
            }
        }
        assert_eq!(
            unexpected,
            [("fake/other".to_string(), "fake/primary".to_string())]
        );
    }

    #[tokio::test]
    async fn interrupt_and_model_change_read_back() {
        let fake = Fake::start();
        let session = started(&fake).await;
        assert_eq!(
            session.interrupt().await.unwrap_err(),
            "nothing to interrupt"
        );
        fake.set(|s| s.streaming = true);
        assert!(
            session
                .interrupt()
                .await
                .unwrap()
                .starts_with("interrupted")
        );
        assert_eq!(fake.seen("abort").len(), 1);
        assert_eq!(
            session.set_model("fake/primary").await.unwrap().model(),
            "fake/primary"
        );
        assert_eq!(fake.seen("set_model").len(), 0);
        assert_eq!(
            session.set_model("fake/other").await.unwrap().model(),
            "fake/other"
        );
        assert!(session.set_model("bad model").await.is_err());
    }

    /// HOST req. 27 with selectors: `x:high` binds the base model at high; a clamped level
    /// fences; a bridge older than the hub fences as unverified at once and the owner may accept
    /// it; a suffixed change sets the base model and the level separately.
    #[tokio::test]
    async fn selectors_are_verified_by_what_omp_resolved() {
        let high = || {
            let mut s = spec("h1", None);
            s.model = "fake/primary:high".into();
            s
        };
        let fake = Fake::start();
        fake.set(|s| s.thinking = Some("high".into()));
        let (session, bound) = fake.bind(high()).await.unwrap();
        assert_eq!(bound.held, None);
        assert!(!session.snapshot().input_blocked);

        let fake = Fake::start();
        fake.set(|s| s.thinking = Some("medium".into()));
        let held = fake.bind(high()).await.unwrap().1.held.unwrap();
        assert!(
            held.contains("thinking high requested, OMP reports medium"),
            "{held}"
        );

        let fake = Fake::start();
        fake.set(|s| s.resolution_version = None);
        let began = tokio::time::Instant::now();
        let (session, bound) = fake.bind(high()).await.unwrap();
        let held = bound.held.unwrap();
        assert!(began.elapsed() < Duration::from_secs(5));
        assert!(
            held.starts_with("model unverified") && held.contains("older than the hub"),
            "{held}"
        );
        assert!(session.snapshot().input_blocked);
        session.accept_model().unwrap();
        assert!(!session.snapshot().input_blocked);
        let refused = session.set_model("fake/other:low").await.unwrap_err();
        assert!(refused.contains("nothing was changed"), "{refused}");
        assert_eq!(fake.seen("set_model"), Vec::<Value>::new());

        let fake = Fake::start();
        let session = started(&fake).await;
        assert_eq!(
            session.set_model("fake/other:low").await.unwrap().model(),
            "fake/other"
        );
        assert_eq!(fake.seen("set_model")[0]["modelId"], "other");
        assert_eq!(fake.seen("set_thinking_level")[0]["level"], "low");
    }

    /// The lane model barrier pins what the registry holds: only a change read back as asked
    /// moves it, so turns on the new model flow and a refused change keeps the old model flowing.
    #[tokio::test]
    async fn only_a_confirmed_model_change_moves_the_barrier_pin() {
        let fake = Fake::start();
        let session = started(&fake).await;
        let pin = || {
            let r = session.inner.settings.links.resolution("h1").unwrap();
            (r.model(), r.requested)
        };
        assert_eq!(pin(), ("fake/primary".to_string(), None));
        fake.set(|s| s.refuse_model = true);
        let refused = session.set_model("fake/other").await.unwrap_err();
        assert!(refused.contains("model not available"), "{refused}");
        assert_eq!(
            pin(),
            ("fake/primary".to_string(), None),
            "a refused change keeps the old model flowing"
        );
        fake.set(|s| s.refuse_model = false);
        assert_eq!(
            session.set_model("fake/other:low").await.unwrap().model(),
            "fake/other"
        );
        assert_eq!(
            pin(),
            ("fake/other".to_string(), Some("low".to_string())),
            "turns on the confirmed model flow"
        );
    }

    #[tokio::test]
    async fn an_unasked_exit_writes_a_stop_record() {
        let fake = Fake::start();
        let session = started(&fake).await;
        fake.exit();
        let snapshot = fake.wait_for(&session, |s| s.stop.is_some()).await;
        assert_eq!(snapshot.stop.clone().unwrap().how, "exited");
        let page = session.events_after(0, 100);
        assert!(!page.missed);
        assert!(matches!(
            page.events.last(),
            Some((_, SessionEvent::Stopped { .. }))
        ));
    }
}
