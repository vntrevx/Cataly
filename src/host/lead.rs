//! The standing lead (COORD-01, COORD-02, HOST-26, HOST-28, HOST-29): one session the hub starts,
//! with its resume rules, crash recovery, the session cap and memory admission, and the API other
//! parts use to reach it:
//!
//! - [`Lead::deliver`] stores a message in the lead's inbox and delivers it when the lead can read;
//!   it returns a [`Receipt`] (slice 2b hands owner messages over with it, 2c urgent events).
//! - [`Lead::receipt`] reads a receipt again by request ID.
//!
//! Resume rule (acceptance check 12): the lead resumes its last session (same ID and file) after a
//! clean close; after an unclean stop with a free lease it resumes with a note; with a held lease it
//! is reported and not started. A configured lead session ID must be resumed exactly. When its OMP
//! exits by itself, the lead is restarted on the same session with bounded backoff. Startup
//! timeouts require verified cleanup and a free lease, with five retries inside one durable
//! 300-second episode. A lead idle for `[lead] idle_sleep` is woken on the same session
//! when a message needs it ([`sleep`]).

pub(crate) mod notice;
pub(crate) mod ownership;
mod sleep;

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tokio::sync::{Mutex as AsyncMutex, Notify, broadcast, watch};

use super::inbox::{self, HUB_SENDER, LEAD, Listed, Mailbox, Message, Note, QUOTA_PREFIX, Receipt};
use super::{Control, Role, Runtime, SessionEvent, Snapshot, StartError, StartSpec, Status};
use crate::config::Config;
use crate::config::session::RuntimeKind;
use crate::jobs::event::{Emit, EventKind, Severity};
use crate::log;
use crate::omp::Omp;
use crate::omp::launch::Target;
use crate::omp::transcript::{self, Folder};
use crate::proto::LeadStart;
use crate::store::Store;
use crate::store::host::{HostWrite, SessionRow, SessionUpdate};
use crate::sys::latency::Latency;
use crate::sys::now_ms;

/// How often the inbox is checked while a written batch waits for its entry.
const CONFIRM_TICK: Duration = Duration::from_secs(5);
/// The sweep that retries anything left (COORD req. 16).
const SWEEP: Duration = Duration::from_mins(5);
/// How often an automatic start that is waiting looks again.
const AUTOSTART_TICK: Duration = Duration::from_secs(30);
/// Bound for a graceful stop at hub shutdown: end of input, 15 s, TERM, 5 s, KILL and 5 s to reap
/// it, with 2 s for the state read before. The lead and every lane get all of it, so a slow exit
/// keeps its TERM grace in full instead of being dropped, and so killed, before its KILL is due.
pub(crate) const STOP_BUDGET: Duration = Duration::from_secs(30);

/// Builds the runtime of one start from the config in force, the resolved OMP executable and the
/// runtime the session runs on: the config's for a new session, the stored one for a resume.
pub(crate) type Factory<R> = Box<dyn Fn(&Config, &Path, RuntimeKind) -> R + Send + Sync>;
/// Records a hub event.
pub(crate) type Events = Arc<dyn Fn(Emit) + Send + Sync>;

/// What the lead needs from the hub.
pub(crate) struct Env<R: Runtime> {
    pub(crate) config: watch::Receiver<Arc<Config>>,
    pub(crate) omp: Arc<Omp>,
    /// Whether the bridge link in OMP's extension folder is current (DESIGN 4.2, 12.2 C19).
    pub(crate) bridge_link: Arc<dyn Fn() -> Result<(), String> + Send + Sync>,
    pub(crate) events: Events,
    pub(crate) store: Store,
    pub(crate) state_dir: PathBuf,
    pub(crate) make: Factory<R>,
}

/// Where the lead stands.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Phase {
    NotStarted,
    Starting,
    Live,
    Stopped,
    /// Not started and not to be started automatically until the owner acts.
    Held,
    /// Its OMP was stopped after a long idle; the session is kept and resumed when a message that
    /// starts a turn arrives.
    Asleep,
}

/// `cataly lead status`.
#[derive(Clone, Debug, Serialize)]
pub(crate) struct View {
    pub(crate) phase: Phase,
    pub(crate) reason: Option<String>,
    pub(crate) session: Option<Snapshot>,
    /// Pending entries that start a turn (urgent or the owner's).
    pub(crate) waiting: usize,
    /// Pending quiet notes; by design they wait for the next wake.
    pub(crate) notes: usize,
    pub(crate) sent: usize,
    pub(crate) in_doubt: usize,
    /// The session kept while the lead is asleep, and since when.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) asleep: Option<Asleep>,
    pub(crate) anchor: Option<AnchorView>,
    pub(crate) recovery: Option<crate::store::host::episode::Episode>,
    /// The attempt starting now and how the last one ended, with the last lease answer.
    pub(crate) attempt: Attempt,
    /// A start is in its recovery: past the 15 s notice, or a retry is planned.
    pub(crate) recovering: bool,
    /// While held: the text the owner was told, in his language.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) notice: Option<String>,
    /// The target, startup and recovery evidence as `cataly lead status` prints it.
    pub(crate) startup: Vec<String>,
}

impl View {
    /// The target's ID and path, the startup phase with its elapsed time, the attempt count and
    /// next retry, how the last attempt ended with its cleanup, and the last lease answer.
    fn startup_lines(&self, now: i64) -> Vec<String> {
        let ago = |ms: i64| (now - ms).max(0) / 1000;
        let until = |ms: i64| ((ms - now).max(0) + 999) / 1000;
        let attempts = 1 + super::startup::RETRY_DELAYS.len();
        let mut lines = Vec::new();
        if let Some(a) = &self.anchor {
            lines.push(format!("target   {} {}", a.session_id, a.session_file));
        }
        let episode = self.recovery.as_ref();
        let attempt = episode
            .filter(|e| e.state == "active")
            .map_or(1, |e| e.retries.saturating_add(1));
        if let (Phase::Starting, Some(started)) = (&self.phase, self.attempt.started_ms) {
            lines.push(format!(
                "startup  starting for {} s, attempt {attempt} of up to {attempts}; notice at {} s, attempt deadline {} s",
                ago(started),
                super::startup::STARTUP_NOTICE.as_secs(),
                super::startup::STARTUP_BUDGET.as_secs()
            ));
        }
        if let Some(e) = episode {
            match e.state.as_str() {
                "active" => {
                    let next = e
                        .next_ms
                        .map_or_else(String::new, |n| format!("; next retry in {} s", until(n)));
                    lines.push(format!(
                        "recovery {} retr{} of {}{next}; the {} s recovery ends in {} s",
                        e.retries,
                        if e.retries == 1 { "y" } else { "ies" },
                        super::startup::RETRY_DELAYS.len(),
                        super::startup::EPISODE_BUDGET.as_secs(),
                        until(e.deadline_ms)
                    ));
                }
                "bound" => {}
                // The held text below says why in plain words; the raw cause is in `--json`.
                state => lines.push(format!(
                    "recovery {state} after {} retr{}",
                    e.retries,
                    if e.retries == 1 { "y" } else { "ies" },
                )),
            }
        }
        let name = |value: serde_json::Result<Value>| {
            value
                .ok()
                .and_then(|v| v.as_str().map(str::to_string))
                .unwrap_or_default()
        };
        if let Some(f) = &self.attempt.failed {
            let how = match (f.stage, f.outcome) {
                (Some(stage), Some(outcome)) => format!(
                    "{} {}",
                    name(serde_json::to_value(stage)),
                    name(serde_json::to_value(outcome))
                ),
                _ => "failed".into(),
            };
            let cleanup = f.cleanup.map_or_else(String::new, |c| {
                format!("; cleanup {}", name(serde_json::to_value(c)))
            });
            lines.push(format!(
                "last     {how} {} s ago{cleanup}: {}",
                ago(f.at_ms),
                f.detail
            ));
        }
        if let Some(l) = &self.attempt.lease {
            lines.push(format!(
                "lease    {} for {}, checked {} s ago",
                name(serde_json::to_value(l.lease)),
                l.session_id,
                ago(l.at_ms)
            ));
        }
        lines
    }
}

/// The start attempt evidence `cataly lead status` and `cataly health` show.
#[derive(Clone, Debug, Default, Serialize)]
pub(crate) struct Attempt {
    /// When the attempt starting now began (ms); `None` while none starts.
    pub(crate) started_ms: Option<i64>,
    /// How the last attempt that did not bind ended.
    pub(crate) failed: Option<Failed>,
    /// The last lease answer for the lead's session.
    pub(crate) lease: Option<LeaseSeen>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct Failed {
    pub(crate) at_ms: i64,
    pub(crate) stage: Option<super::startup::StartupStage>,
    pub(crate) outcome: Option<super::startup::StartupOutcome>,
    /// The process-ownership evidence of the attempt's cleanup.
    pub(crate) cleanup: Option<super::startup::Cleanup>,
    pub(crate) detail: String,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct LeaseSeen {
    pub(crate) session_id: String,
    pub(crate) lease: Lease,
    pub(crate) at_ms: i64,
}

/// The anchor of a target selection, as status shows it.
fn anchor_view(selected: crate::store::host::anchor::Selection) -> Option<AnchorView> {
    let row = selected.row?;
    Some(AnchorView {
        session_id: row.session_id?,
        session_file: row.session_file?,
        cwd: row.cwd,
        runtime: row.runtime,
        provenance: selected.provenance,
    })
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct AnchorView {
    pub(crate) session_id: String,
    pub(crate) session_file: String,
    pub(crate) cwd: String,
    pub(crate) runtime: String,
    pub(crate) provenance: Option<String>,
}

/// The lead's kept session while it sleeps.
#[derive(Clone, Debug, Serialize)]
pub(crate) struct Asleep {
    #[serde(skip)]
    handle: String,
    pub(crate) session_id: String,
    pub(crate) since_ms: i64,
}

/// How the next start goes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Plan {
    /// A fresh session, why (for the owner), and the reason in full (for the log).
    Fresh(LeadStart, String),
    Resume {
        id: String,
        file: PathBuf,
        note: Option<String>,
        /// The runtime it was started with: a resume stays on it (HOST req. 91).
        runtime: RuntimeKind,
    },
    Refuse(String),
}

/// The session a start opens, and where.
struct Chosen {
    target: Target,
    /// The session ID a resume must bind.
    expected: Option<String>,
    note: Option<String>,
    /// A resumed session's recorded working folder, else the default one.
    cwd: PathBuf,
    how: LeadStart,
    /// A resume's recorded runtime; a fresh session takes the configured one.
    runtime: Option<RuntimeKind>,
}

impl Chosen {
    fn fresh(dir: PathBuf, cwd: PathBuf, how: LeadStart) -> Self {
        Self {
            target: Target::Fresh(dir),
            expected: None,
            note: None,
            cwd,
            how,
            runtime: None,
        }
    }
}

/// The lease answer for one session ID.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Lease {
    Free,
    Held,
    Unknown,
}

/// Decides fresh or resume from the resolver's proven binding (HOST req. 81-82, 86-88).
pub(crate) fn plan(
    last: Option<&SessionRow>,
    required: Option<&str>,
    fresh: bool,
    lease: Lease,
) -> Plan {
    if fresh {
        return match required {
            Some(id) => Plan::Refuse(format!(
                "session_id={id} conflicts with --fresh; remove the pin before requesting a different conversation"
            )),
            None => Plan::Fresh(LeadStart::Asked, "the owner asked for a fresh lead".into()),
        };
    }
    let Some(row) = last else {
        return match required {
            Some(id) => Plan::Refuse(format!("required lead session {id} has no proven binding")),
            None => Plan::Fresh(LeadStart::First, "no earlier lead session".into()),
        };
    };
    let (Some(id), Some(file)) = (&row.session_id, &row.session_file) else {
        return Plan::Refuse(
            "the earlier lead has no proven identity; conversation retained, held for the owner"
                .into(),
        );
    };
    if required.is_some_and(|required| required != id) {
        return Plan::Refuse(format!("required lead identity differs from {id}; held"));
    }
    if !Path::new(file).is_file() {
        return Plan::Refuse(format!(
            "the transcript for lead {id} is missing or is not a regular file: {file}; retained, never replaced"
        ));
    }
    let Some(runtime) = RuntimeKind::from_name(&row.runtime) else {
        return Plan::Refuse(format!(
            "lead session {id} was started on the runtime '{}', which this Cataly does not run; \
             start a fresh lead with `cataly lead start --fresh`",
            row.runtime
        ));
    };
    match lease {
        Lease::Free => Plan::Resume {
            id: id.clone(),
            file: PathBuf::from(file),
            note: unclean(row),
            runtime,
        },
        Lease::Held => Plan::Refuse(format!(
            "lead session {id} is held by a running OMP; conversation retained"
        )),
        Lease::Unknown => Plan::Refuse(format!(
            "lead session {id} has an unknown lease; conversation retained"
        )),
    }
}

/// The lead's start spec: always on this machine, never on a worker.
fn lead_spec(
    handle: String,
    settings: &crate::config::session::LeadSettings,
    cwd: PathBuf,
    target: Target,
    expected_id: Option<String>,
) -> StartSpec {
    StartSpec {
        handle,
        role: Role::Lead,
        cwd,
        model: settings.model.clone(),
        thinking: settings.thinking.clone(),
        target,
        expected_id,
        instructions: settings.instructions.clone(),
        max_cost: None,
        look_only: false,
        worker: None,
    }
}

/// Canonical binding path, including OMP's not-yet-created fresh transcript.
fn binding_file(file: &Path, how: LeadStart) -> Result<PathBuf, String> {
    // Stock OMP creates a fresh transcript on its first write, after reporting the binding.
    // Resolve its existing parent, never create a substitute transcript or relax resume checks.
    match std::fs::canonicalize(file) {
        Ok(path) => Ok(path),
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                && matches!(how, LeadStart::First | LeadStart::Asked) =>
        {
            let parent = file.parent().ok_or("binding transcript has no parent")?;
            let name = file
                .file_name()
                .ok_or("binding transcript has no filename")?;
            std::fs::canonicalize(parent)
                .map(|parent| parent.join(name))
                .map_err(|error| format!("binding transcript parent: {error}"))
        }
        Err(error) => Err(format!("binding transcript: {error}")),
    }
}

/// The recovery of a lead row the hub left starting with no session ID. Every start journals its
/// ownership before it spawns, and an unconfirmed journal is never pruned, so no journal proves
/// nothing was spawned: a 0.2.6 row (it wrote none and marked such rows failed) or a crash before
/// the spawn. That row fails like 0.2.6's (the B1 legacy rule); otherwise only a confirmed exit
/// fails it and anything else holds.
async fn interrupted_startup(state: &Path, handle: &str) -> SessionUpdate {
    let (outcome, detail) = if ownership::recorded(state, handle) == Ok(false) {
        (
            "failed",
            "hub stopped during startup; no startup journal, so nothing was spawned".to_string(),
        )
    } else {
        let cleanup = ownership::reconcile_attempt(state, handle, None).await;
        let confirmed = cleanup.as_ref().is_ok_and(|c| c.confirmed());
        (
            if confirmed { "failed" } else { "held" },
            format!("hub stopped during startup; ownership reconciliation: {cleanup:?}"),
        )
    };
    SessionUpdate {
        state: Some(outcome.into()),
        stop: Some(("failed".into(), Some(detail))),
        ..SessionUpdate::default()
    }
}

/// The note for a resume after anything but a clean close; a sleep records how its close went.
fn unclean(row: &SessionRow) -> Option<String> {
    match (
        row.state.as_str(),
        row.stop_how.as_deref(),
        row.stop_detail.as_deref(),
    ) {
        ("stopped", Some("clean"), _) | ("stopped", Some(sleep::ASLEEP), Some("clean")) => None,
        (_, how, _) => Some(format!(
            "resumed after an unclean stop ({})",
            how.unwrap_or("hub stopped")
        )),
    }
}

/// Automatic restarts after the lead's child exited by itself, by the supervision rule of DESIGN 2.2:
/// 1 s doubling to 60 s; more than 5 within 10 minutes hold the lead until the owner starts it.
const RESTART_FIRST: Duration = Duration::from_secs(1);
const RESTART_MAX: Duration = Duration::from_secs(60);
const RESTART_WINDOW: Duration = Duration::from_mins(10);
const RESTART_LIMIT: usize = 5;

#[derive(Default)]
struct Restarts {
    /// When each restart within the window was planned.
    recent: VecDeque<Instant>,
    /// The next restart: when, and the session (ID, transcript) it resumes.
    due: Option<(Instant, (String, PathBuf))>,
}

impl Restarts {
    /// Plans the next restart: its delay and its number within the window, or `None` at the limit.
    fn plan(&mut self, now: Instant, session: (String, PathBuf)) -> Option<(Duration, usize)> {
        while self
            .recent
            .front()
            .is_some_and(|t| now.saturating_duration_since(*t) >= RESTART_WINDOW)
        {
            self.recent.pop_front();
        }
        if self.recent.len() >= RESTART_LIMIT {
            self.due = None;
            return None;
        }
        let doublings = u32::try_from(self.recent.len()).unwrap_or(u32::MAX);
        let delay = RESTART_FIRST
            .saturating_mul(2u32.saturating_pow(doublings))
            .min(RESTART_MAX);
        self.recent.push_back(now);
        self.due = Some((now + delay, session));
        Some((delay, self.recent.len()))
    }
}

/// Counts a launch attempt when it ends, whichever way it ended.
struct Launched<'a>(&'a AtomicU64);

impl Drop for Launched<'_> {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::AcqRel);
    }
}

/// The standing lead.
pub(crate) struct Lead<R: Runtime> {
    env: Env<R>,
    mailbox: Mailbox,
    current: Mutex<Option<Arc<R::Session>>>,
    status: Mutex<(Phase, Option<String>)>,
    starting: AsyncMutex<()>,
    /// Launch attempts ended, so a start that waited for `starting` sees whether one ran meanwhile.
    launched: AtomicU64,
    startup_cancel: watch::Sender<bool>,
    flushing: AsyncMutex<()>,
    wake: Notify,
    recovered: AtomicBool,
    overlay: OnceLock<PathBuf>,
    restarts: Mutex<Restarts>,
    /// The hub asked the current child to close, so its end is no exit by itself.
    closing: AtomicBool,
    shutting_down: AtomicBool,
    /// Internal `deliver` call to the prompt line written (DESIGN 2.3 wake, hub part).
    pub(crate) wake_latency: Latency,
    /// Prompt line written to the entry found in the session file.
    pub(crate) confirm_latency: Latency,
    /// Every event of the current session, for the relays (answers, typing, questions).
    followers: broadcast::Sender<SessionEvent>,
    /// When the lead last read a turn start, before its followers see it (the relays' wake end).
    turn_started: Mutex<Option<Instant>>,
    /// How the first start of this hub run went (the message after an update).
    came: OnceLock<LeadStart>,
    /// The session put to sleep: set before its close, cleared by any phase change but sleep.
    asleep: Mutex<Option<Asleep>>,
    /// The lead's last activity: a session event, a delivery, a start or a busy idle check.
    active: Mutex<Instant>,
    /// What the owner is told directly ([`notice`]).
    notices: notice::Notices,
    attempt: Mutex<Attempt>,
}

impl<R: Runtime> Lead<R> {
    pub(crate) fn new(env: Env<R>) -> Arc<Self> {
        let mailbox = Mailbox {
            target: LEAD.into(),
            store: env.store.clone(),
        };
        Arc::new(Self {
            env,
            mailbox,
            current: Mutex::new(None),
            status: Mutex::new((Phase::NotStarted, None)),
            starting: AsyncMutex::new(()),
            launched: AtomicU64::new(0),
            startup_cancel: watch::channel(false).0,
            flushing: AsyncMutex::new(()),
            wake: Notify::new(),
            recovered: AtomicBool::new(false),
            overlay: OnceLock::new(),
            restarts: Mutex::new(Restarts::default()),
            closing: AtomicBool::new(false),
            shutting_down: AtomicBool::new(false),
            wake_latency: Latency::default(),
            confirm_latency: Latency::default(),
            followers: broadcast::channel(256).0,
            turn_started: Mutex::new(None),
            came: OnceLock::new(),
            asleep: Mutex::new(None),
            active: Mutex::new(Instant::now()),
            notices: notice::Notices::default(),
            attempt: Mutex::new(Attempt::default()),
        })
    }

    fn current(&self) -> Option<Arc<R::Session>> {
        self.current
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Why the lead may not be stopped now, if it may not.
    pub(crate) fn busy(&self) -> Option<&'static str> {
        self.current().and_then(|s| s.snapshot().busy())
    }

    fn phase(&self) -> MutexGuard<'_, (Phase, Option<String>)> {
        self.status.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn set_phase(&self, phase: Phase, reason: Option<String>) {
        match &phase {
            Phase::Held => self
                .notices
                .send(notice::Notice::Held(reason.clone().unwrap_or_default())),
            Phase::Live => self.notices.send(notice::Notice::Bound),
            _ => {}
        }
        if phase != Phase::Starting {
            self.attempt().started_ms = None;
        }
        *self.phase() = (phase, reason);
        *self.sleep() = None;
    }

    fn attempt(&self) -> MutexGuard<'_, Attempt> {
        self.attempt.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// A start is in its recovery: a retry or restart is planned, or the start passed the 15 s
    /// notice. Not final for an update's report.
    pub(crate) fn recovering(&self) -> bool {
        if self.restarts().due.is_some() {
            return true;
        }
        let phase = self.phase();
        phase.0 == Phase::Starting && phase.1.is_some()
    }

    /// Held until the owner acts.
    pub(crate) fn held(&self) -> bool {
        self.phase().0 == Phase::Held
    }

    /// Why the lead is not running, while no session runs and the hub recorded a reason.
    pub(crate) fn refusal(&self) -> Option<String> {
        if self.current().is_some_and(|s| s.alive()) {
            return None;
        }
        self.phase().1.clone()
    }

    fn restarts(&self) -> MutexGuard<'_, Restarts> {
        self.restarts.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn emit(&self, emit: Emit) {
        (self.env.events)(emit);
    }

    /// The supervised task: recovery once, the automatic start when admission allows, then the inbox;
    /// it also carries the idle timer that puts the lead to sleep and wakes it for a message.
    pub(crate) async fn run(
        self: Arc<Self>,
        mut shutdown: watch::Receiver<bool>,
    ) -> Result<(), String> {
        let mut last_refusal: Option<String> = None;
        let mut probed = self.env.omp.report_changes();
        if let Some(rx) = self.notices.take() {
            tokio::spawn(notice::serve(
                rx,
                notice::Env {
                    store: self.env.store.clone(),
                    config: self.env.config.clone(),
                    events: Arc::clone(&self.env.events),
                },
            ));
        }
        loop {
            if *shutdown.borrow() {
                return Ok(());
            }
            let mut waking = false;
            if self.env.omp.report().is_some() {
                if !self.recovered.swap(true, Ordering::AcqRel) {
                    self.recover().await;
                    self.keep_asleep().await;
                }
                if self.restart_wait() == Some(Duration::ZERO) {
                    self.restart().await;
                }
                {
                    let _one = self.starting.lock().await;
                    waking = self.wants_wake().await;
                    if waking || self.wants_autostart() {
                        *self.restarts() = Restarts::default();
                        match self.launch(false, false, None).await {
                            Ok(view) => {
                                if waking {
                                    let session = view.session.and_then(|s| s.session_id);
                                    log::info(
                                        "lead woke",
                                        &[("session", &session.unwrap_or_default())],
                                    );
                                }
                                last_refusal = None;
                            }
                            Err(reason) if last_refusal.as_deref() != Some(&reason) => {
                                log::info("lead not started yet", &[("reason", &reason)]);
                                last_refusal = Some(reason);
                            }
                            Err(_) => {}
                        }
                    }
                }
                let _ = self.flush(None).await;
            }
            self.sleep_if_idle().await;
            // A batch that found the lead between states (a turn just ending) goes when the lead
            // turns idle (see `watch`); the confirm tick is only the backstop.
            let live = self.current().is_some_and(|s| s.alive());
            let mut tick = if self.mailbox.unconfirmed().await
                || (live && self.mailbox.waking_pending().await)
            {
                CONFIRM_TICK
            } else if waking || self.wants_autostart() || self.env.omp.report().is_none() {
                AUTOSTART_TICK.min(SWEEP)
            } else {
                SWEEP
            };
            for wait in [self.restart_wait(), self.sleep_wait()]
                .into_iter()
                .flatten()
            {
                tick = tick.min(wait);
            }
            tokio::select! {
                () = self.wake.notified() => {}
                _ = probed.changed() => {}
                () = tokio::time::sleep(tick) => {}
                _ = shutdown.changed() => {}
            }
        }
    }

    /// An automatic start is due: configured, wanted, nothing running, and not held for the owner.
    fn wants_autostart(&self) -> bool {
        let configured = self
            .env
            .config
            .borrow()
            .lead
            .as_ref()
            .is_some_and(|l| l.autostart);
        configured && self.current().is_none() && matches!(self.phase().0, Phase::NotStarted)
    }

    /// Start-up recovery (HOST req. 85-88): records left starting or live get their lease checked.
    async fn recover(&self) {
        let rows = match self
            .env
            .store
            .read(crate::store::Reads::open_sessions)
            .await
        {
            Ok(rows) => rows,
            Err(e) => {
                log::warn("session recovery skipped", &[("error", &e)]);
                return;
            }
        };
        for row in rows {
            let update = match &row.session_id {
                None => interrupted_startup(&self.env.state_dir, &row.handle).await,
                Some(id) => match self.lease(id).await {
                    Lease::Free => SessionUpdate {
                        state: Some("lost".into()),
                        stop: Some(("lost".into(), Some("the hub stopped while it ran".into()))),
                        ..SessionUpdate::default()
                    },
                    Lease::Held => {
                        self.emit(
                            Emit::new(EventKind::LeadNotStarted, Severity::Warning, true, "lead")
                                .with(
                                    "reason",
                                    format!("session {id} is still held by a running OMP"),
                                ),
                        );
                        SessionUpdate {
                            state: Some("orphan_held".into()),
                            ..SessionUpdate::default()
                        }
                    }
                    Lease::Unknown => SessionUpdate {
                        state: Some("held".into()),
                        fault: Some("lease unknown at recovery".into()),
                        ..SessionUpdate::default()
                    },
                },
            };
            let update = SessionUpdate {
                handle: row.handle.clone(),
                ..update
            };
            if let Err(e) = self.env.store.host(HostWrite::Session(update)).await {
                log::warn("session recovery not recorded", &[("error", &e)]);
            }
        }
        if let Err(error) = ownership::prune(&self.env.state_dir, &self.env.store).await {
            log::warn("startup receipts retained", &[("error", &error)]);
        }
    }

    async fn lease(&self, id: &str) -> Lease {
        let Some(path) = self.env.omp.path() else {
            return Lease::Unknown;
        };
        let lease = match crate::omp::usage::lease(&path, &[id]).await {
            Ok(lease) if lease.held.iter().any(|h| h == id) => Lease::Held,
            Ok(lease) if lease.unknown.iter().any(|u| u == id) => Lease::Unknown,
            Ok(_) => Lease::Free,
            Err(e) => {
                log::warn("lease check failed", &[("error", &e)]);
                Lease::Unknown
            }
        };
        self.attempt().lease = Some(LeaseSeen {
            session_id: id.to_string(),
            lease,
            at_ms: now_ms(),
        });
        lease
    }

    /// Why a start must wait now, if it must (HOST req. 89-90; DESIGN 3.4).
    async fn admission(&self, config: &Config) -> Result<PathBuf, String> {
        let report = self.env.omp.report().ok_or("OMP has not been probed yet")?;
        report.sessions()?;
        let exe = self
            .env
            .omp
            .path()
            .ok_or("the OMP executable was not found")?;
        (self.env.bridge_link)()?;
        let live = usize::from(self.current().is_some_and(|s| s.alive()));
        if live >= usize::try_from(config.sessions.cap).unwrap_or(usize::MAX) {
            return Err(format!(
                "the session cap of {} is reached",
                config.sessions.cap
            ));
        }
        let pressure = config
            .jobs
            .values()
            .find_map(|j| match &j.work {
                crate::config::Work::Owner(crate::config::Owner::Pressure(p)) => Some(p.clone()),
                _ => None,
            })
            .unwrap_or_default();
        let sample = crate::jobs::owner::pressure::sample(&self.env.state_dir).await;
        // Only the memory part of the rule applies to a session start (HOST req. 90); the cap above
        // counts sessions.
        let sample = crate::jobs::owner::pressure::Sample {
            sessions: Some(0),
            disk_free_gb: Some(f64::INFINITY),
            ..sample
        };
        let held = crate::jobs::owner::pressure::admission(&sample, &pressure);
        if !held.is_empty() {
            return Err(format!(
                "memory admission holds the start: {}",
                held.join(", ")
            ));
        }
        Ok(exe)
    }

    /// Starts the lead (COORD req. 2): refused when a lead runs; resume or fresh by [`plan`]. Earlier
    /// automatic restarts no longer count.
    pub(crate) async fn start(self: &Arc<Self>, fresh: bool) -> Result<View, String> {
        let launched = self.launched.load(Ordering::Acquire);
        let _one = if let Ok(lock) = self.starting.try_lock() {
            lock
        } else {
            // Only a different, explicit target supersedes an owned startup. A second
            // same-target request must not turn the first fresh attempt into a held failure.
            if fresh {
                self.startup_cancel.send_replace(true);
            }
            let lock = self.starting.lock().await;
            // A start that ran meanwhile answers this one; a stop or the supervisor's own check
            // held the lock without starting anything, and this start goes ahead.
            if !fresh && self.launched.load(Ordering::Acquire) != launched {
                return Err(self
                    .refusal()
                    .unwrap_or_else(|| "a lead is already running".into()));
            }
            lock
        };
        self.startup_cancel.send_replace(true);
        if self.current().is_some_and(|session| session.alive()) {
            return Err("a lead is already running".into());
        }
        self.recover().await;
        if fresh
            && self
                .env
                .config
                .borrow()
                .lead
                .as_ref()
                .is_some_and(|settings| settings.session_id.is_some())
        {
            return Err("a pinned session_id conflicts with --fresh".into());
        }
        let pin = self
            .env
            .config
            .borrow()
            .lead
            .as_ref()
            .and_then(|lead| lead.session_id.clone());
        // An owner retry can repeat the first fresh start only when no identity ever bound.
        // Automatic recovery never takes this path, and a missing pinned identity stays held.
        let fresh = fresh || (pin.is_none() && !self.resolve(None).await?.ever_bound);
        self.env
            .store
            .host(HostWrite::LeadIntent(if fresh {
                crate::store::host::anchor::Intent::Fresh
            } else {
                crate::store::host::anchor::Intent::Resume
            }))
            .await
            .map_err(|e| e.to_string())?;
        *self.restarts() = Restarts::default();
        self.recovery().end("bound", None).await?;
        self.launch(fresh, true, None).await
    }

    /// Under the start lock; `again` is the session an already scheduled restart resumes. `owner`
    /// is the owner's own `lead start`, which confirms an ambiguous anchor (see [`Self::target`]).
    async fn launch(
        self: &Arc<Self>,
        fresh: bool,
        owner: bool,
        again: Option<(String, PathBuf)>,
    ) -> Result<View, String> {
        let _ended = Launched(&self.launched);
        self.startup_cancel.send_replace(false);
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("the hub is stopping".into());
        }
        if self.current().is_some_and(|s| s.alive()) {
            return Err("a lead is already running".into());
        }
        let config = Arc::clone(&self.env.config.borrow());
        let Some(settings) = config.lead.clone() else {
            return Err("no [lead] section in the config".into());
        };
        let exe = self.admission(&config).await?;
        // A new session's folder: `[lead] cwd`, else the home folder, never the hub's own.
        let default = settings
            .cwd
            .clone()
            .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
            .ok_or("no working directory: set [lead] cwd")?;
        let default = std::fs::canonicalize(&default).map_err(|e| format!("lead cwd: {e}"))?;
        let Chosen {
            target,
            expected,
            note,
            cwd,
            how,
            runtime,
        } = match again {
            Some((id, file)) => self.again(id, file, default).await?,
            None => self.target(&settings, fresh, owner, default).await?,
        };
        self.overlay(&config)?;
        // Last before the attempt: a refusal above never spends the recovery episode.
        if let Some(id) = &expected
            && let Err(reason) = self
                .recovery()
                .admit(id, self.startup_cancel.subscribe())
                .await
        {
            self.set_phase(Phase::Held, Some(reason.clone()));
            return Err(reason);
        }
        let kind = runtime.unwrap_or(config.sessions.runtime);
        if kind != config.sessions.runtime {
            log::info(
                "the lead resumes on the runtime it was started with",
                &[
                    ("runtime", &kind.name()),
                    ("configured", &config.sessions.runtime.name()),
                ],
            );
        }
        let handle = super::random_hex(8);
        let runtime = (self.env.make)(&config, &exe, kind);
        let spec = lead_spec(handle.clone(), &settings, cwd, target, expected);
        self.record_attempt(&spec, runtime.kind()).await?;
        self.set_phase(Phase::Starting, None);
        self.attempt().started_ms = Some(now_ms());
        let retry = match (&spec.target, &spec.expected_id) {
            (Target::Resume(file), Some(id)) => Some((id.clone(), file.clone())),
            _ => None,
        };
        let result = if self.shutting_down.load(Ordering::Acquire) {
            Err(StartError::Refused("the hub is stopping".into()))
        } else {
            let existing = spec.expected_id.clone();
            let attempt = spec.handle.clone();
            super::startup::with_notice(
                runtime.start_supervised(spec, self.startup_cancel.subscribe()),
                || {
                    let reason = if existing.is_some() {
                        "still starting existing session; conversation and queued input retained"
                    } else {
                        "still starting the requested fresh session; queued input retained"
                    };
                    self.set_phase(Phase::Starting, Some(reason.into()));
                    self.emit(
                        Emit::new(EventKind::LeadNotStarted, Severity::Warning, true, "lead")
                            .with("reason", reason),
                    );
                    self.notices.send(notice::Notice::Slow {
                        handle: attempt,
                        session: existing,
                    });
                },
            )
            .await
        };
        match result {
            Ok((session, started)) => {
                self.bound(handle, session, &started, how, note).await?;
                Ok(self.view().await)
            }
            Err(e) => Err(self.not_started(handle, &e, retry).await),
        }
    }

    async fn record_attempt(&self, spec: &StartSpec, runtime: &str) -> Result<(), String> {
        let now = now_ms();
        let row = SessionRow {
            handle: spec.handle.clone(),
            role: "lead".into(),
            runtime: runtime.into(),
            cwd: spec.cwd.display().to_string(),
            name: "lead".into(),
            model: spec.model.clone(),
            thinking: spec.thinking.clone(),
            mode: match spec.target {
                Target::Fresh(_) => "fresh",
                Target::Resume(_) => "resume",
            }
            .into(),
            expected_id: spec.expected_id.clone(),
            expected_file: match &spec.target {
                Target::Resume(file) => Some(file.display().to_string()),
                Target::Fresh(_) => None,
            },
            state: "starting".into(),
            session_id: None,
            session_file: None,
            pid: None,
            started_ms: now,
            updated_ms: now,
            stop_how: None,
            stop_detail: None,
            stop_ms: None,
            fault: None,
        };
        self.env
            .store
            .host(HostWrite::Record(row))
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// Fresh or exact resume target from the durable binding resolver and owner intent. The owner's
    /// own start resumes an anchor held only as ambiguous once its transcript verifies.
    async fn target(
        &self,
        settings: &crate::config::session::LeadSettings,
        fresh: bool,
        owner: bool,
        default: PathBuf,
    ) -> Result<Chosen, String> {
        let selected = self.resolve(settings.session_id.clone()).await?;
        if !fresh
            && let Some(reason) = selected.hold
            && !(owner && crate::store::host::anchor::ambiguous(&reason))
        {
            self.set_phase(Phase::Held, Some(reason.clone()));
            return Err(reason);
        }
        if !fresh && selected.intent != "resume" {
            let reason = "a fresh lead attempt did not bind; the old conversation is retained and held. Choose `cataly lead start --fresh` to retry fresh or `cataly lead start` to resume old".to_string();
            self.set_phase(Phase::Held, Some(reason.clone()));
            return Err(reason);
        }
        if !fresh && selected.ever_started && selected.row.is_none() {
            let reason = self.refusal().unwrap_or_else(|| {
                "no proven lead anchor; held, never automatically replaced".into()
            });
            self.set_phase(Phase::Held, Some(reason.clone()));
            return Err(reason);
        }
        let last = selected.row;
        let lease = match last.as_ref().and_then(|r| r.session_id.as_deref()) {
            Some(id) => self.lease(id).await,
            None => Lease::Unknown,
        };
        // Both levels owner-only: the resume check tolerates OMP's group-writable files only below a
        // 0700 parent (`omp::transcript::exact`).
        let sessions = self.env.state_dir.join("sessions");
        crate::sys::fs::ensure_private_dir(&sessions).map_err(|e| e.to_string())?;
        let dir = sessions.join("lead");
        crate::sys::fs::ensure_private_dir(&dir).map_err(|e| e.to_string())?;
        match plan(last.as_ref(), settings.session_id.as_deref(), fresh, lease) {
            Plan::Refuse(reason) => {
                self.set_phase(Phase::Held, Some(reason.clone()));
                self.emit(
                    Emit::new(EventKind::LeadNotStarted, Severity::Warning, true, "lead")
                        .with("reason", &reason),
                );
                Err(reason)
            }
            Plan::Fresh(how, reason) => {
                log::info("lead starts fresh", &[("reason", &reason)]);
                Ok(Chosen::fresh(dir, default, how))
            }
            Plan::Resume {
                id,
                file,
                note,
                runtime,
            } => {
                let verified = transcript::verify_exact(
                    file.clone(),
                    dir.clone(),
                    id.clone(),
                    Folder::Recorded(
                        last.as_ref()
                            .map_or(default.clone(), |row| PathBuf::from(&row.cwd)),
                    ),
                )
                .await;
                let detail = match verified {
                    Ok(saved) => {
                        return Ok(Chosen {
                            target: Target::Resume(file),
                            expected: Some(id),
                            note,
                            cwd: saved.cwd,
                            how: LeadStart::Resumed,
                            runtime: Some(runtime),
                        });
                    }
                    Err(e) => e.to_string(),
                };
                let reason = format!(
                    "the transcript of lead session {id} did not verify for an exact resume: {detail}; conversation retained"
                );
                self.set_phase(Phase::Held, Some(reason.clone()));
                Err(reason)
            }
        }
    }

    /// A start bound its identity: record it, follow its events, leave the resume note.
    async fn bound(
        self: &Arc<Self>,
        handle: String,
        session: Arc<R::Session>,
        started: &super::Started,
        how: LeadStart,
        note: Option<String>,
    ) -> Result<(), String> {
        let committed = async {
            let canonical = binding_file(Path::new(&started.file), how)?;
            let update = SessionUpdate {
                handle: handle.clone(),
                state: Some("live".into()),
                session_id: Some(started.session_id.clone()),
                session_file: Some(canonical.display().to_string()),
                pid: started.pid.map(i64::from),
                fault: started.held.clone(),
                stop: None,
            };
            self.env
                .store
                .host(if started.held.is_some() {
                    HostWrite::Session(update)
                } else {
                    HostWrite::BindLead(update)
                })
                .await
                .map_err(|e| e.to_string())
        }
        .await;
        if let Err(error) = committed {
            let stopped = session.close(true).await;
            self.update(SessionUpdate {
                handle: handle.clone(),
                state: Some(
                    if stopped.as_ref().is_ok_and(|stop| stop.cleanup.confirmed()) {
                        "failed"
                    } else {
                        "held"
                    }
                    .into(),
                ),
                stop: Some(("failed".into(), Some(error.clone()))),
                ..SessionUpdate::default()
            })
            .await;
            if let Err(failure) = self.recovery().end("held", Some(error.clone())).await {
                log::warn("binding hold not persisted", &[("error", &failure)]);
            }
            let reason =
                format!("binding could not be committed: {error}; input held; cleanup {stopped:?}");
            self.set_phase(Phase::Held, Some(reason.clone()));
            return Err(reason);
        }
        self.fenced_startup_recorded(started.held.as_deref()).await;
        let _ = self.came.set(how);
        *self.current.lock().unwrap_or_else(PoisonError::into_inner) = Some(Arc::clone(&session));
        self.closing.store(false, Ordering::Release);
        self.set_phase(Phase::Live, started.held.clone());
        self.touch();
        let identity = (started.session_id.clone(), PathBuf::from(&started.file));
        tokio::spawn(Arc::clone(self).watch(
            handle,
            identity,
            session.subscribe(),
            session.states(),
        ));
        self.emit(
            Emit::new(EventKind::LeadStarted, Severity::Info, false, "lead")
                .with("session", &started.session_id)
                .with("model", started.model.as_deref().unwrap_or("unknown"))
                .with(
                    "how",
                    if how == LeadStart::Resumed {
                        "resumed"
                    } else {
                        "fresh"
                    },
                ),
        );
        match &started.held {
            // An unverified model is told once, not on every start (HOST req. 27).
            Some(reason) if super::model::unverified(reason) => self
                .notices
                .send(notice::Notice::Unverified(reason.clone())),
            Some(reason) => self.emit(
                Emit::new(EventKind::SessionFenced, Severity::Warning, true, "lead")
                    .with("role", "lead")
                    .with("reason", reason),
            ),
            None => {}
        }
        if let Some(note) = note {
            let _ = self
                .mailbox
                .admit(&Message {
                    sender: HUB_SENDER.into(),
                    text: format!("[resume note] {note}. Check the last turns before going on."),
                    urgent: false,
                    owner: false,
                    identity: Some(format!("resume-note:{}", started.session_id)),
                    request_id: None,
                })
                .await;
        }
        self.wake.notify_one();
        Ok(())
    }

    /// A start that did not bind: the record says why, and the owner hears it unless the start was
    /// an automatic restart (its retry or hold reports instead).
    async fn not_started(
        &self,
        handle: String,
        e: &StartError,
        resume: Option<(String, PathBuf)>,
    ) -> String {
        let detail = e.to_string();
        self.attempt().failed = Some(match e {
            StartError::Startup {
                stage,
                outcome,
                cleanup,
                detail,
            } => Failed {
                at_ms: now_ms(),
                stage: Some(*stage),
                outcome: Some(*outcome),
                cleanup: Some(*cleanup),
                detail: detail.clone(),
            },
            StartError::Refused(why) => Failed {
                at_ms: now_ms(),
                stage: None,
                outcome: None,
                cleanup: None,
                detail: why.clone(),
            },
        });
        self.update(SessionUpdate {
            handle,
            state: Some(
                if matches!(
                    e,
                    StartError::Startup {
                        cleanup: super::startup::Cleanup::Unknown,
                        ..
                    }
                ) {
                    "held"
                } else {
                    "failed"
                }
                .into(),
            ),
            stop: Some(("failed".into(), Some(detail.clone()))),
            ..SessionUpdate::default()
        })
        .await;
        if let Some(session) = resume
            && e.retryable()
            && !self.shutting_down.load(Ordering::Acquire)
        {
            self.startup_retry(session, e).await;
            if let Some(reason) = self.refusal() {
                self.emit(
                    Emit::new(EventKind::LeadNotStarted, Severity::Warning, true, "lead")
                        .with("reason", &reason),
                );
            }
            return detail;
        }
        if !e.retryable()
            && !self.shutting_down.load(Ordering::Acquire)
            && let Err(error) = self.recovery().end("held", Some(detail.clone())).await
        {
            log::warn("recovery hold not persisted", &[("error", &error)]);
        }
        let phase = Phase::Held;
        self.set_phase(phase, Some(detail.clone()));
        self.emit(
            Emit::new(EventKind::LeadNotStarted, Severity::Warning, true, "lead")
                .with("reason", &detail),
        );
        detail
    }

    /// The target of an automatic restart: exactly the session that exited (HOST req. 81).
    async fn again(&self, id: String, file: PathBuf, default: PathBuf) -> Result<Chosen, String> {
        let mut settings = self
            .env
            .config
            .borrow()
            .lead
            .clone()
            .ok_or("no lead configuration")?;
        if settings.session_id.as_deref().is_some_and(|pin| pin != id) {
            return Err("lead target changed during recovery; scheduled retry cancelled".into());
        }
        settings.session_id = Some(id);
        let chosen = self.target(&settings, false, false, default).await?;
        match &chosen.target {
            Target::Resume(selected) if selected == &file => Ok(chosen),
            Target::Fresh(_) | Target::Resume(_) => {
                Err("lead anchor changed during recovery; held".into())
            }
        }
    }

    async fn resolve(
        &self,
        pin: Option<String>,
    ) -> Result<crate::store::host::anchor::Selection, String> {
        let mut selected = self
            .env
            .store
            .read(move |r| r.lead_target(pin.as_deref()))
            .await
            .map_err(|e| e.to_string())?;
        if selected.provenance.as_deref()
            == Some("two exact get_state identities and accepted model")
            && let Some(row) = &selected.row
            && row.runtime == "headless"
        {
            match ownership::reconcile_attempt(&self.env.state_dir, &row.handle, None).await {
                Ok(cleanup) if cleanup.confirmed() => {}
                evidence => {
                    selected.hold = Some(format!(
                        "lead process ownership is not proven terminated: {evidence:?}; conversation retained"
                    ));
                }
            }
        }
        Ok(selected)
    }

    fn recovery(&self) -> super::startup::Recovery<'_> {
        super::startup::Recovery {
            store: &self.env.store,
            target: LEAD,
        }
    }

    /// A fenced session is recorded unbound, but its startup succeeded: the episode ends, so a
    /// later exit gets a fresh retry window. A bound one ended it with the binding.
    async fn fenced_startup_recorded(&self, held: Option<&str>) {
        let Some(reason) = held else {
            return;
        };
        let detail = format!("startup session recorded, fenced: {reason}");
        if let Err(failure) = self.recovery().end("bound", Some(detail)).await {
            log::warn("fenced startup episode not ended", &[("error", &failure)]);
        }
    }

    async fn startup_retry(&self, session: (String, PathBuf), error: &StartError) {
        let retry = self.recovery().retry(error).await;
        let reason = match retry {
            Ok(Some(delay)) => {
                self.restarts().due = Some((Instant::now() + delay, session));
                self.set_phase(
                    Phase::Stopped,
                    Some(format!("{error}; restarting in {} s", delay.as_secs())),
                );
                self.wake.notify_one();
                return;
            }
            Ok(None) => format!(
                "{error}; 300 s recovery episode or five-retry ceiling exhausted; conversation retained, held"
            ),
            Err(error) => format!("recovery accounting failed: {error}; held"),
        };
        self.set_phase(Phase::Held, Some(reason.clone()));
        self.emit(
            Emit::new(EventKind::LeadNotStarted, Severity::Warning, true, "lead")
                .with("reason", reason),
        );
    }

    /// How long until the planned automatic restart; zero when it is due.
    fn restart_wait(&self) -> Option<Duration> {
        self.restarts()
            .due
            .as_ref()
            .map(|(at, _)| at.saturating_duration_since(Instant::now()))
    }

    /// The automatic restart (DESIGN 2.2): the same session when its lease is free (HOST req. 86-88).
    async fn restart(self: &Arc<Self>) {
        let _one = self.starting.lock().await;
        if self.shutting_down.load(Ordering::Acquire) {
            return;
        }
        if self.current().is_some_and(|s| s.alive()) {
            // The owner started the lead meanwhile.
            self.restarts().due = None;
            return;
        }
        let (id, file) = {
            let mut restarts = self.restarts();
            match restarts.due.take() {
                Some((at, session)) if at <= Instant::now() => {
                    self.set_phase(Phase::Starting, None);
                    session
                }
                due => {
                    restarts.due = due;
                    return;
                }
            }
        };
        let lease = self.lease(&id).await;
        if lease != Lease::Free {
            let reason = format!(
                "the lead's session {id} {}; not restarted, held for the owner",
                if lease == Lease::Held {
                    "is held by another OMP"
                } else {
                    "has an unknown lease"
                }
            );
            self.set_phase(Phase::Held, Some(reason.clone()));
            self.emit(
                Emit::new(EventKind::LeadNotStarted, Severity::Warning, true, "lead")
                    .with("reason", &reason),
            );
            return;
        }
        match self
            .launch(false, false, Some((id.clone(), file.clone())))
            .await
        {
            Ok(_) => log::info("lead restarted", &[("session", &id)]),
            Err(reason) => {
                log::warn("lead restart failed", &[("reason", &reason)]);
                if self.phase().0 != Phase::Stopped {
                    self.set_phase(Phase::Held, Some(reason));
                }
            }
        }
    }

    /// After the child exited by itself (`exit` is its status), or a restart failed: plans the next
    /// restart, or past the limit holds the lead for the owner (DESIGN 2.2). Every exit is an event
    /// (HOST req. 70); the owner is alerted at the first exit of a series and at the hold.
    fn exited(&self, session: (String, PathBuf), why: &str, exit: Option<&str>) {
        let planned = self.restarts().plan(Instant::now(), session);
        let next = match planned {
            Some((delay, _)) => format!("restarting in {} s", delay.as_secs()),
            None => format!(
                "more than {RESTART_LIMIT} restarts within 10 minutes, held until `cataly lead start`"
            ),
        };
        let reason = format!("{why}; {next}");
        if let Some(exit) = exit {
            let urgent = matches!(planned, Some((_, 1)));
            self.emit(
                Emit::new(EventKind::SessionStopped, Severity::Warning, urgent, "lead")
                    .with("role", "lead")
                    .with("how", "exited")
                    .with("detail", format!("{exit}; {next}")),
            );
        }
        if planned.is_some() {
            self.set_phase(Phase::Stopped, Some(reason));
            self.wake.notify_one();
        } else {
            self.set_phase(Phase::Held, Some(reason.clone()));
            self.emit(
                Emit::new(EventKind::SessionFenced, Severity::Warning, true, "lead")
                    .with("role", "lead")
                    .with("reason", &reason),
            );
        }
    }

    /// Writes the lead's overlay once per hub run (DESIGN 4.2): goal mode off (OPC-36).
    fn overlay(&self, config: &Config) -> Result<PathBuf, String> {
        if let Some(path) = self.overlay.get() {
            return Ok(path.clone());
        }
        let path = crate::omp::launch::write_overlay(
            &self.env.state_dir,
            &config.fallback,
            crate::omp::tools::Role::Lead,
        )
        .map_err(|e| e.to_string())?;
        Ok(self.overlay.get_or_init(|| path).clone())
    }

    async fn update(&self, update: SessionUpdate) {
        if let Err(e) = self.env.store.host(HostWrite::Session(update)).await {
            log::warn("session record not updated", &[("error", &e)]);
        }
    }

    /// A turn ended with the quota exhausted: the owner is alerted and the lead told once (OPC-58,
    /// OPC-64).
    async fn quota_blocked(&self, handle: &str, message: &str) {
        self.emit(
            Emit::new(EventKind::QuotaBlocked, Severity::Warning, true, "lead")
                .with("role", "lead")
                .with("message", message),
        );
        let _ = self
            .mailbox
            .admit(&Message {
                sender: HUB_SENDER.into(),
                text: format!(
                    "[quota exhausted] {message}. OMP's configured fallback is exhausted or absent. \
                     Stop, save progress and report; only owner requests reach you until it clears."
                ),
                urgent: false,
                owner: false,
                identity: Some(format!("{QUOTA_PREFIX}{handle}:{}", now_ms() / 3_600_000)),
                request_id: None,
            })
            .await;
    }

    /// Follows one session's events: hub events, inbox wakes, the stop record and the restart.
    async fn watch(
        self: Arc<Self>,
        handle: String,
        identity: (String, PathBuf),
        mut events: broadcast::Receiver<(u64, SessionEvent)>,
        mut states: watch::Receiver<Arc<Snapshot>>,
    ) {
        let mut states_open = true;
        loop {
            let received = tokio::select! {
                received = events.recv() => received,
                changed = states.changed(), if states_open => {
                    // A readback showing the lead idle: a batch that met it between states (a turn
                    // just ending) goes now, not at the next tick; that readback brings no event of
                    // its own. Snapshots change only on events and readbacks, so this never polls.
                    if changed.is_err() {
                        states_open = false;
                        continue;
                    }
                    if states.borrow_and_update().status == Status::Idle {
                        self.wake.notify_one();
                    }
                    continue;
                }
            };
            let event = match received {
                Ok((_, event)) => event,
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    self.wake.notify_one();
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => return,
            };
            self.forward(&event);
            match event {
                SessionEvent::TurnEnded { .. }
                | SessionEvent::Quiet
                | SessionEvent::Settled { .. }
                | SessionEvent::LinkRestored
                | SessionEvent::Message { .. } => self.wake.notify_one(),
                SessionEvent::Fallback { from, to, reason } => self.emit(
                    Emit::new(EventKind::ModelFallback, Severity::Info, false, "lead")
                        .with("role", "lead")
                        .with("from", from)
                        .with("to", to)
                        .with("reason", reason),
                ),
                SessionEvent::FallbackRecovered { model } => self.emit(
                    Emit::new(EventKind::ModelRestored, Severity::Info, false, "lead")
                        .with("role", "lead")
                        .with("model", model),
                ),
                SessionEvent::ModelUnexpected { model, requested } => self.emit(
                    Emit::new(EventKind::ModelUnexpected, Severity::Warning, true, "lead")
                        .with("role", "lead")
                        .with("model", model)
                        .with("requested", requested),
                ),
                SessionEvent::SpendOffer { title, count } => self.emit(
                    Emit::new(EventKind::SpendOffer, Severity::Warning, true, "lead")
                        .with("role", "lead")
                        .with("dialog", title)
                        .with("count", count),
                ),
                SessionEvent::QuotaBlocked { message } => {
                    self.quota_blocked(&handle, &message).await;
                }
                SessionEvent::Fault { reason } => {
                    self.update(SessionUpdate {
                        handle: handle.clone(),
                        fault: Some(reason.clone()),
                        ..SessionUpdate::default()
                    })
                    .await;
                    self.emit(
                        Emit::new(EventKind::SessionFenced, Severity::Warning, true, "lead")
                            .with("role", "lead")
                            .with("reason", reason),
                    );
                }
                SessionEvent::Stopped { record } => {
                    self.ended(&handle, identity, &record).await;
                    self.wake.notify_one();
                    return;
                }
                SessionEvent::TurnStarted
                | SessionEvent::DialogOpened { .. }
                | SessionEvent::DialogClosed { .. }
                | SessionEvent::ModelChanged { .. }
                | SessionEvent::LinkLost
                | SessionEvent::InterruptUnconfirmed => {}
            }
        }
    }

    /// The watched session ended: its record and phase, and a restart when its OMP exited by itself.
    /// A sleep records its own stop, and nothing restarts.
    async fn ended(&self, handle: &str, identity: (String, PathBuf), record: &super::StopRecord) {
        if self.sleeps(handle) {
            return;
        }
        self.update(SessionUpdate {
            handle: handle.to_string(),
            state: Some("stopped".into()),
            stop: Some((record.how.clone(), record.detail.clone())),
            ..SessionUpdate::default()
        })
        .await;
        self.set_phase(Phase::Stopped, Some(format!("stopped: {}", record.how)));
        if record.how == "exited" && !self.closing.load(Ordering::Acquire) {
            if !record.cleanup.confirmed() {
                let reason = "lead exit ownership is unknown; conversation retained, automatic recovery held";
                self.set_phase(Phase::Held, Some(reason.into()));
                self.emit(
                    Emit::new(EventKind::LeadNotStarted, Severity::Warning, true, "lead")
                        .with("reason", reason),
                );
                return;
            }
            let exit = record.detail.as_deref().unwrap_or("no exit status");
            self.exited(
                identity,
                &format!("its OMP exited by itself ({exit})"),
                Some(exit),
            );
        }
    }

    /// Resolves written batches and sends what may go (one flush at a time).
    async fn flush(&self, called: Option<Instant>) -> Result<(), String> {
        let _one = self.flushing.lock().await;
        let session = self.current();
        let blocked = session
            .as_ref()
            .is_some_and(|s| s.snapshot().quota_blocked.is_some());
        let notes = self
            .mailbox
            .flush(session.as_deref(), blocked)
            .await
            .map_err(|e| e.to_string())?;
        self.report(notes, called).await;
        Ok(())
    }

    /// Records what a flush or a delivery found.
    async fn report(&self, notes: Vec<Note>, called: Option<Instant>) {
        for note in notes {
            match note {
                Note::Sent { written } => {
                    if let (Some(called), Some(written)) = (called, written) {
                        self.wake_latency
                            .record(written.saturating_duration_since(called));
                    }
                }
                Note::Confirmed { after_ms } => {
                    self.confirm_latency
                        .record(Duration::from_millis(u64::try_from(after_ms).unwrap_or(0)));
                }
                Note::InDoubt {
                    delivery,
                    rows,
                    reason,
                    notify,
                } => {
                    log::warn(
                        "delivery in doubt",
                        &[("delivery", &delivery), ("reason", &reason)],
                    );
                    self.emit(
                        Emit::new(EventKind::DeliveryInDoubt, Severity::Warning, true, "lead")
                            .with("target", LEAD)
                            .with("count", rows.len())
                            .with("reason", &reason),
                    );
                    if notify {
                        let _ = self
                            .mailbox
                            .admit(&Message {
                                sender: HUB_SENDER.into(),
                                text: inbox::in_doubt_notice(LEAD, &rows, &reason),
                                urgent: true,
                                owner: false,
                                identity: Some(inbox::in_doubt_identity(&delivery)),
                                request_id: None,
                            })
                            .await;
                    }
                }
                Note::Failed {
                    delivery,
                    rows,
                    reason,
                } => {
                    log::warn(
                        "delivery failed",
                        &[("delivery", &delivery), ("reason", &reason)],
                    );
                    self.emit(
                        Emit::new(EventKind::DeliveryFailed, Severity::Warning, true, "lead")
                            .with("target", LEAD)
                            .with("count", rows)
                            .with("reason", &reason),
                    );
                }
                // Text from one conversation reached another: the owner is told once, nothing is
                // resent (PATCH-01 rule 9).
                Note::Misdelivered {
                    delivery,
                    target_session,
                    found_session,
                } => self.emit(
                    Emit::new(EventKind::DeliveryFailed, Severity::Warning, true, "lead")
                        .with("target", LEAD)
                        .with("delivery", delivery)
                        .with(
                            "reason",
                            format!(
                                "misdelivered: a message for session {target_session} reached \
                                 session {found_session}; it is not resent"
                            ),
                        ),
                ),
            }
        }
    }

    /// Hands a message to the lead (COORD-10, COORD-15): stored, then delivered at once when the lead
    /// can read. Accepted even with no lead session; it goes out once a lead exists (COORD req. 24).
    /// The message commits before it is written: a sender's retry after a crash finds its receipt.
    pub(crate) async fn deliver(&self, request: Message) -> Result<Receipt, String> {
        self.deliver_as(request, false).await
    }

    /// [`Lead::deliver`] for an owner request the caller knows was not written to the lead before:
    /// read live in this hub run, or absent from the lead's transcripts. It may be written while
    /// its records commit (decision 15, [`inbox::Mailbox::deliver_as`]).
    pub(crate) async fn deliver_live(&self, request: Message) -> Result<Receipt, String> {
        self.deliver_as(request, true).await
    }

    async fn deliver_as(&self, request: Message, live: bool) -> Result<Receipt, String> {
        let called = Instant::now();
        // Before the lock: a sleep waiting on it sees the lead busy again.
        self.touch();
        let (receipt, stored) = {
            let _one = self.flushing.lock().await;
            let session = self.current();
            let blocked = session
                .as_ref()
                .is_some_and(|s| s.snapshot().quota_blocked.is_some());
            let (receipt, stored, notes) = self
                .mailbox
                .deliver_as(&request, session.as_deref(), blocked, live)
                .await?;
            self.report(notes, Some(called)).await;
            (receipt, stored)
        };
        let Some(id) = stored else {
            return Ok(receipt);
        };
        self.wake.notify_one();
        Ok(self.mailbox.receipt(request.request_id, id).await)
    }

    /// When the lead last read a turn start of its session.
    pub(crate) fn turn_started(&self) -> Option<Instant> {
        *self
            .turn_started
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Passes an event to the relays; a turn start is stamped first. Nobody following is fine; a
    /// slow follower sees `Lagged` and reads the state again.
    fn forward(&self, event: &SessionEvent) {
        self.touch();
        if *event == SessionEvent::TurnStarted {
            *self
                .turn_started
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = Some(Instant::now());
        }
        let _ = self.followers.send(event.clone());
    }

    /// The receipt of an earlier request ID; `None` when the ID is unknown.
    pub(crate) async fn receipt(&self, request_id: &str) -> Result<Option<Receipt>, String> {
        let rid = request_id.to_string();
        let found = self
            .env
            .store
            .read(move |r| r.receipt(LEAD, &rid))
            .await
            .map_err(|e| e.to_string())?;
        Ok(match found {
            None => None,
            Some(crate::store::host::StoredReceipt { inbox_id: None }) => Some(Receipt {
                request_id: Some(request_id.into()),
                inbox_id: None,
                state: inbox::ReceiptState::Duplicate,
                delivery_id: None,
                reason: None,
            }),
            Some(crate::store::host::StoredReceipt { inbox_id: Some(id) }) => {
                Some(self.mailbox.receipt(Some(request_id.into()), id).await)
            }
        })
    }

    /// Decision 15 recovery: whether an owner request that an earlier hub run may have written
    /// to the lead before its record landed ([`inbox::wake_id`]) reached the lead's transcript.
    /// `Some(true)` when a user entry of the current or the previous lead transcript carries its
    /// marker; `Some(false)` when neither does and a lead started by this hub runs, or the lead is
    /// asleep (either way the process an earlier run wrote to has let go of its session, so its
    /// file is final); `None` while no lead runs yet. A transcript that cannot be searched is an
    /// error: the caller fails closed.
    pub(crate) async fn written_earlier(&self, request_id: &str) -> Result<Option<bool>, String> {
        let current = self
            .current()
            .filter(|s| s.alive())
            .and_then(|s| s.snapshot().session_file.clone());
        if current.is_none() && self.asleep().is_none() {
            return Ok(None);
        }
        let earlier = self
            .env
            .store
            .read(|r| r.session_files("lead", 2))
            .await
            .map_err(|e| e.to_string())?;
        let mut files: Vec<String> = current.into_iter().collect();
        for file in earlier {
            if !files.contains(&file) {
                files.push(file);
            }
        }
        let marker = inbox::marker(&inbox::wake_id(LEAD, request_id));
        for file in files {
            match transcript::search(PathBuf::from(&file), marker.clone()).await {
                Ok(transcript::Found::Yes) => return Ok(Some(true)),
                Ok(transcript::Found::Absent | transcript::Found::Missing) => {}
                Ok(transcript::Found::Unknown(why)) => {
                    return Err(format!("{file} could not be searched completely: {why}"));
                }
                Err(e) => return Err(format!("{file}: {e}")),
            }
        }
        Ok(Some(false))
    }

    /// Follows the events of whichever lead session runs, across restarts.
    pub(crate) fn follow(&self) -> broadcast::Receiver<SessionEvent> {
        self.followers.subscribe()
    }

    /// The current session's snapshot without waiting.
    pub(crate) fn snapshot(&self) -> Option<Arc<Snapshot>> {
        self.current().map(|s| s.snapshot())
    }

    /// After start-up recovery and the automatic start: how the lead came back in this hub run.
    /// `None` while it may still come up.
    /// An automatic start the hub refused (memory admission, ...) settles it too:
    /// the lead is not running, and the reason says why.
    pub(crate) fn settled(&self) -> Option<LeadStart> {
        if let Some(how) = self.came.get() {
            return Some(*how);
        }
        if self.restart_wait().is_some() {
            return None;
        }
        let (refused, starting) = {
            let phase = self.phase();
            (phase.1.is_some(), matches!(phase.0, Phase::Starting))
        };
        let coming = (self.wants_autostart() && !refused) || starting;
        (self.recovered.load(Ordering::Acquire) && !coming).then_some(LeadStart::NotRunning)
    }

    pub(crate) async fn view(&self) -> View {
        let (phase, mut reason) = self.phase().clone();
        let recovering = self.recovering();
        let (pin, language) = {
            let config = self.env.config.borrow();
            (
                config
                    .lead
                    .as_ref()
                    .and_then(|settings| settings.session_id.clone()),
                config.hub.language,
            )
        };
        let metadata = self
            .env
            .store
            .read(move |reads| {
                Ok((
                    reads.lead_target(pin.as_deref())?,
                    reads.startup_episode(LEAD)?,
                ))
            })
            .await;
        let (anchor, recovery) = match metadata {
            Ok((selected, recovery)) => (anchor_view(selected), recovery),
            Err(error) => {
                reason = Some(format!("identity/recovery status unavailable: {error}"));
                (None, None)
            }
        };
        let notice = (phase == Phase::Held).then(|| {
            let (_, why) = notice::hold(recovery.as_ref(), reason.as_deref().unwrap_or("held"));
            notice::held_text(language, &why, anchor.as_ref())
        });
        let entries = self.mailbox.list().await.unwrap_or_default();
        let count = |s: &str| entries.iter().filter(|(l, _)| l.state == s).count();
        let pending = |wakes: bool| {
            entries
                .iter()
                .filter(|(l, _)| l.state == "pending" && l.wakes == wakes)
                .count()
        };
        let mut view = View {
            phase,
            reason,
            session: self.current().map(|s| (*s.snapshot()).clone()),
            waiting: pending(true),
            notes: pending(false),
            sent: count("sent"),
            in_doubt: count("in_doubt"),
            asleep: self.asleep(),
            anchor,
            recovery,
            attempt: self.attempt().clone(),
            recovering,
            notice,
            startup: Vec::new(),
        };
        view.startup = view.startup_lines(now_ms());
        view
    }

    pub(crate) async fn inbox(&self) -> Result<Vec<Listed>, String> {
        Ok(self
            .mailbox
            .list()
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|(l, _)| l)
            .collect())
    }

    pub(crate) async fn settle(&self, index: usize, confirm: bool) -> Result<(), String> {
        self.mailbox.settle(index, confirm).await?;
        self.touch();
        self.wake.notify_one();
        Ok(())
    }

    fn live(&self) -> Result<Arc<R::Session>, String> {
        self.current()
            .filter(|s| s.alive())
            .ok_or_else(|| "no lead session is running".to_string())
    }

    pub(crate) async fn interrupt(&self) -> Result<String, String> {
        self.live()?.interrupt().await
    }

    pub(crate) async fn set_model(&self, selector: &str) -> Result<String, String> {
        self.live()?.set_model(selector).await.map(|r| r.model())
    }

    pub(crate) async fn accept_model(&self) -> Result<(), String> {
        let session = self.live()?;
        let snapshot = session.snapshot();
        if !snapshot
            .reason
            .as_deref()
            .is_some_and(super::model::accepts)
        {
            return Err(
                "the session is not held for a model mismatch or an unverified model".into(),
            );
        }
        let file = snapshot
            .session_file
            .as_deref()
            .ok_or("the lead has no bound file")?;
        let canonical = binding_file(Path::new(file), LeadStart::Asked)?;
        self.env
            .store
            .host(HostWrite::BindLead(SessionUpdate {
                handle: snapshot.handle.clone(),
                state: Some("live".into()),
                session_id: snapshot.session_id.clone(),
                session_file: Some(canonical.display().to_string()),
                ..SessionUpdate::default()
            }))
            .await
            .map_err(|e| e.to_string())?;
        // The durable anchor must exist before releasing the session's input fence.
        session.accept_model()?;
        self.set_phase(Phase::Live, None);
        self.wake.notify_one();
        Ok(())
    }

    pub(crate) async fn answer(&self, dialog: &str, answer: &Value) -> Result<(), String> {
        let session = self.live()?;
        let id = session
            .snapshot()
            .session_id
            .clone()
            .ok_or("the lead is not bound")?;
        session.answer(&id, dialog, answer).await
    }

    pub(crate) fn events(&self, after: u64) -> Result<super::EventPage, String> {
        Ok(self
            .current()
            .ok_or("no lead session")?
            .events_after(after, super::headless::EVENT_PAGE))
    }

    /// Stops the lead; refused while it works or has a dialog unless forced (HOST req. 83). With no
    /// lead running it cancels a planned automatic restart, or keeps a sleeping lead stopped.
    pub(crate) async fn stop(&self, force: bool) -> Result<View, String> {
        let starting = self.phase().0 == Phase::Starting;
        self.startup_cancel.send_replace(true);
        let _one = self.starting.lock().await;
        let session = match self.live() {
            Ok(session) => session,
            Err(e) => {
                self.recovery()
                    .end("cancelled", Some("owner stopped recovery".into()))
                    .await?;
                if self.stop_asleep().await {
                    return Ok(self.view().await);
                }
                if self.restarts().due.take().is_none() && !starting {
                    return Err(e);
                }
                self.set_phase(
                    Phase::Stopped,
                    Some("the automatic restart was cancelled".into()),
                );
                return Ok(self.view().await);
            }
        };
        let snapshot = session.snapshot();
        if !force && (snapshot.status == Status::Working || !snapshot.dialogs.is_empty()) {
            return Err("the lead is working or has a pending dialog; use --force".into());
        }
        let handle = snapshot.handle.clone();
        self.closing.store(true, Ordering::Release);
        let record = match session.close(force).await {
            Ok(record) => record,
            Err(e) => {
                self.closing.store(false, Ordering::Release);
                return Err(e);
            }
        };
        // Written before the answer, so an immediate start sees the stop record.
        self.update(SessionUpdate {
            handle,
            state: Some("stopped".into()),
            stop: Some((record.how.clone(), record.detail.clone())),
            ..SessionUpdate::default()
        })
        .await;
        self.set_phase(Phase::Stopped, Some(format!("stopped: {}", record.how)));
        Ok(self.view().await)
    }

    /// Hub shutdown: a clean close so the next start resumes the same session.
    pub(crate) async fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::Release);
        self.startup_cancel.send_replace(true);
        let _one = self.starting.lock().await;
        self.restarts().due = None;
        let Some(session) = self.current().filter(|s| s.alive()) else {
            return;
        };
        let handle = session.snapshot().handle.clone();
        self.closing.store(true, Ordering::Release);
        match tokio::time::timeout(STOP_BUDGET, session.close(true)).await {
            Ok(Ok(record)) => {
                self.update(SessionUpdate {
                    handle,
                    state: Some("stopped".into()),
                    stop: Some((record.how.clone(), record.detail.clone())),
                    ..SessionUpdate::default()
                })
                .await;
            }
            Ok(Err(e)) => log::warn("lead not closed at shutdown", &[("error", &e)]),
            Err(_) => log::warn("lead close timed out at shutdown", &[]),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(state: &str, how: Option<&str>, file: Option<&Path>) -> SessionRow {
        SessionRow {
            handle: "h".into(),
            role: "lead".into(),
            runtime: "headless".into(),
            cwd: "/".into(),
            name: "lead".into(),
            model: "p/m".into(),
            thinking: None,
            mode: "fresh".into(),
            expected_id: None,
            expected_file: None,
            state: state.into(),
            session_id: Some("s1".into()),
            session_file: file.map(|f| f.display().to_string()),
            pid: None,
            started_ms: 1,
            updated_ms: 1,
            stop_how: how.map(Into::into),
            stop_detail: None,
            stop_ms: None,
            fault: None,
        }
    }

    /// Acceptance check 12: clean close resumes; unclean with a free lease resumes with a note; a held
    /// lease is reported and not started; a required ID is never replaced by a fresh lead.
    #[test]
    fn resume_rules() {
        let dir = crate::sys::fs::tests::scratch("lead-plan");
        let file = dir.join("s.jsonl");
        std::fs::write(&file, "{}\n").unwrap();
        let resume = |note: Option<&str>| Plan::Resume {
            id: "s1".into(),
            file: file.clone(),
            note: note.map(Into::into),
            runtime: RuntimeKind::Headless,
        };
        assert!(matches!(
            plan(None, None, false, Lease::Free),
            Plan::Fresh(LeadStart::First, _)
        ));
        let clean = row("stopped", Some("clean"), Some(&file));
        assert_eq!(plan(Some(&clean), None, false, Lease::Free), resume(None));
        assert!(matches!(
            plan(Some(&clean), None, true, Lease::Unknown),
            Plan::Fresh(LeadStart::Asked, _)
        ));
        let crashed = row("stopped", Some("exited"), Some(&file));
        assert_eq!(
            plan(Some(&crashed), None, false, Lease::Free),
            resume(Some("resumed after an unclean stop (exited)"))
        );
        let lost = row("lost", Some("lost"), Some(&file));
        assert!(matches!(
            plan(Some(&lost), None, false, Lease::Free),
            Plan::Resume { note: Some(_), .. }
        ));
        let held = row("orphan_held", None, Some(&file));
        assert!(matches!(
            plan(Some(&held), None, false, Lease::Held),
            Plan::Refuse(_)
        ));
        assert!(matches!(
            plan(Some(&held), None, false, Lease::Unknown),
            Plan::Refuse(_)
        ));
        assert!(matches!(
            plan(Some(&held), None, false, Lease::Free),
            Plan::Resume { note: Some(_), .. }
        ));
        let gone = row("stopped", Some("clean"), Some(&dir.join("missing.jsonl")));
        assert!(matches!(
            plan(Some(&gone), None, false, Lease::Free),
            Plan::Refuse(_)
        ));
        assert!(matches!(
            plan(Some(&clean), Some("s1"), true, Lease::Free),
            Plan::Refuse(_)
        ));
        assert!(matches!(
            plan(Some(&clean), Some("s2"), false, Lease::Free),
            Plan::Refuse(_)
        ));
        assert!(matches!(
            plan(Some(&gone), Some("s1"), false, Lease::Free),
            Plan::Refuse(_)
        ));
        let old = SessionRow {
            runtime: "old".into(),
            ..clean.clone()
        };
        assert!(matches!(
            plan(Some(&old), None, false, Lease::Free),
            Plan::Refuse(r) if r.contains("runtime 'old'")
        ));
    }

    /// DESIGN 2.2: restarts wait 1, 2, 4, 8 and 16 s; a sixth within 10 minutes is refused (the lead
    /// is held); once the oldest restart is 10 minutes old one more is allowed.
    #[test]
    fn restarts_back_off_and_stop_at_the_limit() {
        let mut restarts = Restarts::default();
        let start = Instant::now();
        let session = || ("s1".to_string(), PathBuf::from("/s.jsonl"));
        let mut delays = Vec::new();
        for n in 0..5u64 {
            let (delay, count) = restarts
                .plan(start + Duration::from_secs(n), session())
                .unwrap();
            assert_eq!(count, usize::try_from(n + 1).unwrap());
            delays.push(delay.as_secs());
        }
        assert_eq!(delays, [1, 2, 4, 8, 16]);
        assert!(restarts.due.is_some());
        assert_eq!(
            restarts.plan(start + Duration::from_secs(5), session()),
            None
        );
        assert!(restarts.due.is_none(), "nothing stays planned once held");
        let later = start + RESTART_WINDOW;
        assert_eq!(
            restarts.plan(later, session()),
            Some((Duration::from_secs(16), 5))
        );
    }

    /// A row left starting with no session ID and no startup journal (a 0.2.6 start the hub
    /// crashed in) fails as 0.2.6 marked it; a journaled start of unknown ownership holds.
    #[tokio::test]
    async fn an_unjournaled_interrupted_start_fails_and_a_journaled_one_holds() {
        let dir = crate::sys::fs::tests::scratch("lead-interrupted");
        let legacy = interrupted_startup(&dir, "legacy").await;
        assert_eq!(legacy.state.as_deref(), Some("failed"), "{legacy:?}");
        let _journal = ownership::Ownership::prepare(&dir, "journaled").unwrap();
        let unknown = interrupted_startup(&dir, "journaled").await;
        assert_eq!(unknown.state.as_deref(), Some("held"), "{unknown:?}");
    }
}
