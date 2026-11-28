//! The hub's side of a worker (design 2.1, 2.2, 2.9): one `ssh` child per worker in use, closed
//! after 5 minutes with no remote lane and no pending operation; the channel-0 client; and the table
//! of every configured worker with its state, as `worker list`, `status` and the panel show it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncWriteExt, BufReader, DuplexStream};
use tokio::sync::{mpsc, oneshot, watch};

use super::attempt::{AttemptState, QUERY_MAX, Report};
use super::enrol::{self, Destination};
use super::mux::{Accepted, Mux, Timing};
use super::{Hello, LINE_MAX, PROTOCOL, method};
use crate::config::workers::WorkerSettings;
use crate::config::{Config, Language};
use crate::jobs::event::{Emit, EventKind, Severity};
use crate::log;
use crate::proto::{Line, Request, Response};
use crate::store::Store;
use crate::store::coord::CoordWrite;
use crate::sys::command::{self, Attached, Exit, Finished};
use crate::sys::now_ms;

/// `ssh` connects within this time (`ConnectTimeout`), and `hello` answers within this time.
const CONNECT: Duration = Duration::from_secs(10);
const HELLO: Duration = Duration::from_secs(10);
/// A connection with no remote lane and no pending operation closes after this time (design 2.1).
pub(crate) const IDLE: Duration = Duration::from_mins(5);
/// How often idle connections are looked for.
const SWEEP: Duration = Duration::from_secs(30);
/// `ssh` stderr kept per connection, for the refusal reason.
const STDERR_CAP: u64 = 64 * 1024;
/// The store kind of worker records.
const KIND: &str = "worker";

/// The `ssh` argument vector (design 2.2): no config file, only this key and this pin, no agent, no
/// forwarding, batch mode, keepalives; the command asked for is the marker.
pub(crate) fn ssh_argv(key: &Path, known_hosts: &Path, dest: &Destination) -> Vec<String> {
    let mut argv: Vec<String> = vec![
        "ssh".into(),
        "-F".into(),
        "none".into(),
        "-T".into(),
        "-i".into(),
        key.display().to_string(),
        "-p".into(),
        dest.port.to_string(),
    ];
    for option in [
        "IdentitiesOnly=yes".to_string(),
        "IdentityAgent=none".into(),
        format!("UserKnownHostsFile={}", known_hosts.display()),
        "GlobalKnownHostsFile=/dev/null".into(),
        "StrictHostKeyChecking=yes".into(),
        "CheckHostIP=no".into(),
        "UpdateHostKeys=no".into(),
        "BatchMode=yes".into(),
        "ClearAllForwardings=yes".into(),
        format!("ConnectTimeout={}", CONNECT.as_secs()),
        "ServerAliveInterval=15".into(),
        "ServerAliveCountMax=3".into(),
    ] {
        argv.push("-o".into());
        argv.push(option);
    }
    argv.push("--".into());
    argv.push(dest.target());
    argv.push(super::MARKER.into());
    argv
}

/// Why a connection did not come up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ConnectError {
    /// The pinned host key does not match, or there is no pin (design 2.9).
    HostKey,
    /// The marker command ran: the forced command is not applied (design 2.2).
    NoForcedCommand,
    /// The worker refused the hub's key.
    Denied,
    /// Speaks another protocol (design 2.8); the worker's `hello`, which says what it runs.
    Incompatible(String, Box<Hello>),
    /// Anything else: the network, the worker's sshd, a timeout.
    Unreachable(String),
}

impl ConnectError {
    /// A refusal stays until the owner acts; the rest may pass on its own.
    pub(crate) fn refused(&self) -> bool {
        !matches!(self, Self::Unreachable(_))
    }
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::HostKey => f.write_str(
                "refused: host key changed or not pinned; run `cataly worker init` on the worker \
                 again to see its fingerprint, then `cataly worker add … --host-key SHA256:…` here",
            ),
            Self::NoForcedCommand => f.write_str(
                "refused: no forced command: the worker ran the hub's command itself. When Tailscale \
                 SSH takes port 22 of the tailnet, run OpenSSH on another port bound to the tailnet \
                 address (for example 2222) and enrol user@host:2222",
            ),
            Self::Denied => f.write_str(
                "refused: the worker did not accept this hub's key; run the `cataly worker init` \
                 line `worker add` printed on the worker",
            ),
            Self::Incompatible(why, _) | Self::Unreachable(why) => f.write_str(why),
        }
    }
}

/// Reads `ssh`'s stderr after a failed connection.
pub(crate) fn classify(stderr: &str, exit: Option<Exit>) -> ConnectError {
    let has = |needle: &str| stderr.contains(needle);
    if has("Host key verification failed")
        || has("REMOTE HOST IDENTIFICATION HAS CHANGED")
        || has("host key is known for")
        || has("No ED25519 host key is known")
    {
        return ConnectError::HostKey;
    }
    if has(super::MARKER) || exit == Some(Exit::Code(127)) {
        return ConnectError::NoForcedCommand;
    }
    if has("Permission denied") {
        return ConnectError::Denied;
    }
    let last = stderr
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map_or_else(
            || "the connection ended before the worker answered".to_string(),
            str::to_string,
        );
    ConnectError::Unreachable(format!("unreachable: {last}"))
}

/// What `exec` returns on the wire: the same facts as a local [`Finished`].
pub(crate) fn exec_reply(done: &Finished) -> Value {
    let exit = match done.exit {
        Exit::Code(c) => json!({ "code": c }),
        Exit::Signal(s) => json!({ "signal": s }),
        Exit::Unknown => Value::Null,
    };
    json!({
        "exit": exit,
        "timed_out": done.timed_out,
        "stdout": crate::sys::base64::encode(&done.stdout),
        "stderr": crate::sys::base64::encode(&done.stderr),
        "stdout_bytes": done.stdout_bytes,
        "stdout_sha256": done.stdout_sha256.map(|h| crate::sys::hex(&h)),
        "truncated": done.truncated,
        "pipes_held": done.pipes_held,
    })
}

/// The hub's copy of a worker's `exec` result.
pub(crate) fn finished_of(value: &Value) -> Result<Finished, String> {
    let bytes = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .and_then(crate::sys::base64::decode)
            .ok_or_else(|| format!("exec reply without {key}"))
    };
    let flag = |key: &str| value.get(key).and_then(Value::as_bool).unwrap_or(false);
    let exit = match value.get("exit") {
        Some(e) if e.get("code").is_some() => Exit::Code(
            e.get("code")
                .and_then(Value::as_i64)
                .and_then(|c| i32::try_from(c).ok())
                .unwrap_or(-1),
        ),
        Some(e) if e.get("signal").is_some() => Exit::Signal(
            e.get("signal")
                .and_then(Value::as_i64)
                .and_then(|c| i32::try_from(c).ok())
                .unwrap_or(0),
        ),
        _ => Exit::Unknown,
    };
    let sha = value
        .get("stdout_sha256")
        .and_then(Value::as_str)
        .and_then(|h| {
            let raw: Vec<u8> = (0..h.len())
                .step_by(2)
                .filter_map(|i| u8::from_str_radix(h.get(i..i + 2)?, 16).ok())
                .collect();
            <[u8; 32]>::try_from(raw).ok()
        });
    Ok(Finished {
        exit,
        timed_out: flag("timed_out"),
        cancelled: false,
        stdout: bytes("stdout")?,
        stderr: bytes("stderr")?,
        stdout_bytes: value
            .get("stdout_bytes")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        stdout_sha256: sha,
        truncated: flag("truncated"),
        pipes_held: flag("pipes_held"),
    })
}

/// The channel-0 client: one request per call, answers matched by ID.
pub(crate) struct Client {
    lines: mpsc::Sender<String>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Response>>>>,
    next: AtomicU64,
}

impl Client {
    fn start(stream: DuplexStream) -> Self {
        let (read, mut write) = tokio::io::split(stream);
        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Response>>>> = Arc::default();
        let (lines, mut rx) = mpsc::channel::<String>(16);
        tokio::spawn(async move {
            while let Some(line) = rx.recv().await {
                if write.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
            }
        });
        let answers = Arc::clone(&pending);
        tokio::spawn(async move {
            let mut reader = BufReader::new(read);
            while let Line::Text(line) = crate::proto::read_line(&mut reader, LINE_MAX).await {
                let Ok(reply) = serde_json::from_str::<Response>(&line) else {
                    continue;
                };
                let waiter = answers
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .remove(&reply.id);
                if let Some(w) = waiter {
                    let _ = w.send(reply);
                }
            }
            // Every caller still waiting learns the connection ended.
            answers
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clear();
        });
        Self {
            lines,
            pending,
            next: AtomicU64::new(1),
        }
    }

    /// One request, bounded by `limit`.
    pub(crate) async fn call(
        &self,
        name: &str,
        params: Value,
        limit: Duration,
    ) -> Result<Value, CallError> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let mut line = serde_json::to_string(&Request {
            v: crate::proto::VERSION,
            id,
            method: name,
            params,
            launch: None,
        })
        .map_err(|e| CallError::Refused(e.to_string()))?;
        line.push('\n');
        if line.len() > LINE_MAX {
            return Err(CallError::Refused("request too large".into()));
        }
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id, tx);
        let ended = || "the worker connection ended".to_string();
        if self.lines.send(line).await.is_err() {
            self.forget(id);
            return Err(CallError::Refused(ended()));
        }
        let reply = match tokio::time::timeout(limit, rx).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => return Err(CallError::Unanswered(ended())),
            Err(_) => {
                self.forget(id);
                return Err(CallError::Unanswered(format!(
                    "{name} took longer than {} s",
                    limit.as_secs()
                )));
            }
        };
        match (reply.ok, reply.err) {
            (Some(v), _) => Ok(v),
            (None, Some(e)) => Err(CallError::Refused(e.message)),
            (None, None) => Err(CallError::Unanswered("an empty answer".into())),
        }
    }

    fn forget(&self, id: u64) {
        self.pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&id);
    }
}

/// Why a channel-0 call has no result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CallError {
    /// Never sent, or answered with an error: the worker did not carry it out.
    Refused(String),
    /// Sent and not answered (the connection ended, or the limit passed): the worker may have
    /// carried it out.
    Unanswered(String),
}

impl std::fmt::Display for CallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused(why) | Self::Unanswered(why) => f.write_str(why),
        }
    }
}

/// What connects to one worker.
#[derive(Debug, Clone)]
pub(crate) struct Target {
    pub(crate) name: String,
    pub(crate) dest: Destination,
    pub(crate) key: PathBuf,
    pub(crate) known_hosts: PathBuf,
    /// `ssh`'s stderr of the latest connection.
    pub(crate) stderr: PathBuf,
}

impl Target {
    pub(crate) fn of(
        name: &str,
        settings: &WorkerSettings,
        config_dir: &Path,
        logs: &Path,
    ) -> Result<Self, String> {
        Ok(Self {
            name: name.to_string(),
            dest: Destination::parse(&format!("{}:{}", settings.destination, settings.port))?,
            key: enrol::key_path(config_dir, name),
            known_hosts: enrol::known_hosts(config_dir),
            stderr: logs.join(format!("worker-{name}.err")),
        })
    }
}

/// One live connection to a worker.
pub(crate) struct Link {
    pub(crate) name: String,
    pub(crate) hello: Hello,
    pub(crate) mux: Mux,
    client: Client,
    child: tokio::sync::Mutex<Option<Attached>>,
    used: Mutex<Instant>,
    /// Operations in flight.
    pending: AtomicUsize,
    /// Remote lanes running on it; a [`LaneHold`] counts one.
    pub(crate) lanes: AtomicUsize,
    /// Active spawn waiters, keyed by attempt, and any channel waiting for its answer. Removing a
    /// waiter drops its channel; a channel arriving without a waiter is dropped by `accept`.
    spawned: Mutex<HashMap<String, Option<Accepted>>>,
    spawned_ready: tokio::sync::Notify,
}

/// One OMP attempt the worker started: its channel, the stream to its stdin and from its stdout,
/// the hold on the connection, and the wait for its exit acknowledgement.
pub(crate) struct Spawned {
    pub(crate) channel: u32,
    pub(crate) stream: DuplexStream,
    pub(crate) hold: LaneHold,
    pub(crate) exit: ExitWait,
}

/// Why a `spawn` gave no attempt to talk to, and what that proves about a process for its token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SpawnError {
    /// Not sent, or refused before the worker recorded the attempt: no process was started.
    Refused(String),
    /// Recorded, then failed: the state the worker recorded (never started, or how it ended).
    Ended { detail: String, state: AttemptState },
    /// No usable answer: a process may run for the token; only reconciling it can tell.
    Unanswered(String),
}

impl std::fmt::Display for SpawnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused(why) | Self::Unanswered(why) | Self::Ended { detail: why, .. } => {
                f.write_str(why)
            }
        }
    }
}

/// The wait for one attempt's exit acknowledgement: the worker sends it once it reaped the OMP and
/// recorded how it ended. The end of the channel's output, or of the connection, is no such proof.
pub(crate) struct ExitWait {
    attempt: String,
    rx: oneshot::Receiver<Value>,
    got: Option<AttemptState>,
}

impl ExitWait {
    /// The attempt token it waits for.
    pub(crate) fn attempt(&self) -> &str {
        &self.attempt
    }

    /// The acknowledged state: [`AttemptState::Reaped`] with the exit, or
    /// [`AttemptState::Unknown`] when the worker could not reap it. A connection that ended first
    /// (an SSH drop, EOF) gives [`AttemptState::Unknown`]: the attempt is then reconciled with
    /// [`Link::attempts`] after a reconnect. Cancel-safe; once answered it answers the same again.
    pub(crate) async fn wait(&mut self) -> AttemptState {
        if let Some(got) = &self.got {
            return got.clone();
        }
        let state = match (&mut self.rx).await {
            Ok(value) => acknowledged(&self.attempt, value),
            Err(_) => AttemptState::Unknown {
                reason: "the worker connection ended before the exit acknowledgement".into(),
            },
        };
        self.got = Some(state.clone());
        state
    }
}

/// The state an `exit` frame's payload acknowledges for `attempt`; anything that is not this
/// attempt's well-formed report is unknown.
fn acknowledged(attempt: &str, value: Value) -> AttemptState {
    match serde_json::from_value::<Report>(value) {
        Ok(report) if report.attempt == attempt => report.state,
        Ok(report) => AttemptState::Unknown {
            reason: format!(
                "the exit acknowledgement names attempt {}, not {attempt}",
                report.attempt
            ),
        },
        Err(e) => AttemptState::Unknown {
            reason: format!("a malformed exit acknowledgement: {e}"),
        },
    }
}

/// One remote lane's hold on its connection: it is not idle while a lane runs on it.
pub(crate) struct LaneHold(Arc<Link>);

impl LaneHold {
    pub(crate) fn link(&self) -> &Arc<Link> {
        &self.0
    }
}

impl Drop for LaneHold {
    fn drop(&mut self) {
        self.0.lanes.fetch_sub(1, Ordering::AcqRel);
        self.0.touch();
    }
}

/// One request's hold on the connection, released even when its future is cancelled.
struct PendingRequest<'a>(&'a Link);

impl Drop for PendingRequest<'_> {
    fn drop(&mut self) {
        self.0.pending.fetch_sub(1, Ordering::AcqRel);
        self.0.touch();
    }
}

/// A spawn owns its unclaimed channel only while its caller still waits for it.
struct WaitingSpawn<'a> {
    link: &'a Link,
    attempt: &'a str,
}

impl<'a> WaitingSpawn<'a> {
    fn new(link: &'a Link, attempt: &'a str) -> Result<Self, SpawnError> {
        let mut spawned = link.spawned.lock().unwrap_or_else(PoisonError::into_inner);
        match spawned.entry(attempt.to_string()) {
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(None);
            }
            std::collections::hash_map::Entry::Occupied(_) => {
                return Err(SpawnError::Unanswered(format!(
                    "a spawn is already waiting for attempt {attempt}"
                )));
            }
        }
        Ok(Self { link, attempt })
    }
}

impl Drop for WaitingSpawn<'_> {
    fn drop(&mut self) {
        self.link
            .spawned
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(self.attempt);
    }
}

impl Link {
    /// Starts `ssh`, the stream and `hello`. The channels the worker opens arrive on the receiver.
    pub(crate) async fn connect(
        target: &Target,
    ) -> Result<(Arc<Self>, mpsc::Receiver<Accepted>), ConnectError> {
        let argv = ssh_argv(&target.key, &target.known_hosts, &target.dest);
        if let Some(dir) = target.stderr.parent() {
            crate::sys::fs::ensure_private_dir(dir)
                .map_err(|e| ConnectError::Unreachable(e.to_string()))?;
        }
        let mut child = command::attach(&argv, None, &[], Some(&target.stderr), STDERR_CAP)
            .map_err(|e| ConnectError::Unreachable(format!("cannot start ssh: {e}")))?;
        let (Some(stdin), Some(stdout)) = (child.take_stdin(), child.take_stdout()) else {
            child.close(Duration::ZERO, Duration::from_secs(1)).await;
            return Err(ConnectError::Unreachable(
                "ssh's pipes are not available".into(),
            ));
        };
        let (mux, control, accepted) = Mux::start(stdout, stdin, Timing::STANDARD);
        let client = Client::start(control);
        let hello = client
            .call(method::HELLO, json!({}), CONNECT + HELLO)
            .await
            .map_err(|e| e.to_string())
            .and_then(|v| serde_json::from_value::<Hello>(v).map_err(|e| e.to_string()));
        let hello = match hello {
            Ok(h) => h,
            Err(why) => {
                mux.close();
                let (exit, _) = child
                    .close(Duration::from_secs(2), Duration::from_secs(1))
                    .await;
                let stderr = std::fs::read_to_string(&target.stderr).unwrap_or_default();
                let mut error = classify(&stderr, Some(exit));
                if let ConnectError::Unreachable(text) = &mut error
                    && stderr.trim().is_empty()
                {
                    *text = format!("unreachable: {why}");
                }
                return Err(error);
            }
        };
        if let Some(why) = hello.incompatible(&target.name) {
            mux.close();
            child
                .close(Duration::from_secs(2), Duration::from_secs(1))
                .await;
            return Err(ConnectError::Incompatible(why, Box::new(hello)));
        }
        Ok((
            Self::assemble(&target.name, hello, mux, client, Some(child)),
            accepted,
        ))
    }

    /// A connection whose `hello` was answered and found compatible.
    fn assemble(
        name: &str,
        hello: Hello,
        mux: Mux,
        client: Client,
        child: Option<Attached>,
    ) -> Arc<Self> {
        Arc::new(Self {
            name: name.to_string(),
            hello,
            mux,
            client,
            child: tokio::sync::Mutex::new(child),
            used: Mutex::new(Instant::now()),
            pending: AtomicUsize::new(0),
            lanes: AtomicUsize::new(0),
            spawned: Mutex::new(HashMap::new()),
            spawned_ready: tokio::sync::Notify::new(),
        })
    }

    /// Takes a channel the worker opened: a spawned OMP's waits, with its exit acknowledgement, for
    /// its `spawn` answer, or is dropped if that caller no longer waits; any other is handed back.
    fn accept(&self, channel: Accepted) -> Option<Accepted> {
        if channel.header.get("kind").and_then(Value::as_str) != Some("spawn") {
            return Some(channel);
        }
        let mut spawned = self.spawned.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(slot) = channel
            .header
            .get("attempt")
            .and_then(Value::as_str)
            .and_then(|attempt| spawned.get_mut(attempt))
            && slot.is_none()
        {
            *slot = Some(channel);
            self.spawned_ready.notify_waiters();
        }
        None
    }

    /// One worker-protocol call; counts as use.
    pub(crate) async fn call(
        &self,
        name: &str,
        params: Value,
        limit: Duration,
    ) -> Result<Value, String> {
        self.request(name, params, limit)
            .await
            .map_err(|e| e.to_string())
    }

    /// [`Link::call`], telling a refusal from a call the worker may have carried out.
    async fn request(
        &self,
        name: &str,
        params: Value,
        limit: Duration,
    ) -> Result<Value, CallError> {
        self.pending.fetch_add(1, Ordering::AcqRel);
        let _pending = PendingRequest(self);
        self.client.call(name, params, limit).await
    }

    fn touch(&self) {
        *self.used.lock().unwrap_or_else(PoisonError::into_inner) = Instant::now();
    }

    /// Whether the connection has had no lane and no operation for `idle`.
    fn idle_for(&self, idle: Duration) -> bool {
        self.pending.load(Ordering::Acquire) == 0
            && self.lanes.load(Ordering::Acquire) == 0
            && self
                .used
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .elapsed()
                >= idle
    }

    /// One bounded command on the worker, as [`command::run`] runs one here.
    pub(crate) async fn exec(
        &self,
        argv: &[String],
        cwd: Option<&str>,
        env: &[(&str, &str)],
        timeout: Duration,
    ) -> Result<Finished, String> {
        let env: HashMap<&str, &str> = env.iter().copied().collect();
        let params = json!({
            "argv": argv,
            "cwd": cwd,
            "env": env,
            "timeout_ms": u64::try_from(timeout.as_millis()).unwrap_or(u64::MAX),
        });
        let reply = self
            .call(method::EXEC, params, timeout + Duration::from_secs(15))
            .await?;
        finished_of(&reply)
    }

    /// A file under the worker root, at most `max` bytes.
    pub(crate) async fn read(&self, path: &str, max: u64) -> Result<Vec<u8>, String> {
        let reply = self
            .call(
                method::READ,
                json!({ "path": path, "max": max }),
                Duration::from_secs(30),
            )
            .await?;
        reply
            .get("data")
            .and_then(Value::as_str)
            .and_then(crate::sys::base64::decode)
            .ok_or_else(|| "read answer without data".into())
    }

    /// Writes a file under the worker root.
    pub(crate) async fn write(&self, path: &str, bytes: &[u8]) -> Result<(), String> {
        self.call(
            method::WRITE,
            json!({ "path": path, "data": crate::sys::base64::encode(bytes) }),
            Duration::from_secs(30),
        )
        .await
        .map(|_| ())
    }

    /// Starts the worker's OMP with `argv` (the first word `omp`) for the hub's attempt token
    /// (protocol 2); `session` names the OMP session it is to bind, for the worker's lease check once
    /// it ended. The worker records the attempt before the process exists and refuses a token it
    /// already recorded. Ending the stream's input closes the child. A failure says what it proves
    /// about a process for the token.
    pub(crate) async fn spawn(
        self: &Arc<Self>,
        argv: &[String],
        cwd: &str,
        env: &[(String, String)],
        attempt: &str,
        session: Option<&str>,
    ) -> Result<Spawned, SpawnError> {
        let _waiting = WaitingSpawn::new(self, attempt)?;
        let env: HashMap<&str, &str> = env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        let reply = self
            .request(
                method::SPAWN,
                json!({
                    "argv": argv,
                    "cwd": cwd,
                    "env": env,
                    "attempt": attempt,
                    "session": session,
                }),
                Duration::from_secs(30),
            )
            .await
            .map_err(|e| match e {
                CallError::Refused(why) => SpawnError::Refused(why),
                CallError::Unanswered(why) => SpawnError::Unanswered(why),
            })?;
        if reply.get("attempt").and_then(Value::as_str) != Some(attempt) {
            return Err(SpawnError::Unanswered(format!(
                "the spawn answer does not name attempt {attempt}"
            )));
        }
        if let Some(why) = reply.get("failed") {
            let state = reply
                .get("state")
                .cloned()
                .and_then(|s| serde_json::from_value(s).ok())
                .unwrap_or_else(|| AttemptState::Unknown {
                    reason: "the failed spawn answer has no attempt state".into(),
                });
            return Err(SpawnError::Ended {
                detail: why.as_str().unwrap_or_default().to_string(),
                state,
            });
        }
        let Some(channel) = reply
            .get("channel")
            .and_then(Value::as_u64)
            .and_then(|c| u32::try_from(c).ok())
        else {
            return Err(SpawnError::Unanswered(
                "spawn answer without a channel".into(),
            ));
        };
        // The open frame came first on the stream; its hand-over may still be on its way.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let ready = self.spawned_ready.notified();
            if let Some(opened) = self
                .spawned
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get_mut(attempt)
                .and_then(Option::take)
            {
                if opened.channel != channel {
                    return Err(SpawnError::Unanswered(
                        "the spawn answer names a different channel".into(),
                    ));
                }
                self.lanes.fetch_add(1, Ordering::AcqRel);
                return Ok(Spawned {
                    channel,
                    stream: opened.stream,
                    hold: LaneHold(Arc::clone(self)),
                    exit: ExitWait {
                        attempt: attempt.to_string(),
                        rx: opened.exit,
                        got: None,
                    },
                });
            }
            if tokio::time::timeout_at(deadline, ready).await.is_err() {
                // The process runs with nobody to talk to it: end it; its token answers for it.
                let killed = self.signal(channel, "KILL").await;
                return Err(SpawnError::Unanswered(format!(
                    "the spawned OMP's channel did not arrive (KILL: {killed:?})"
                )));
            }
        }
    }

    /// What the worker knows of each attempt token, answered within its 10 s bound: running (the
    /// recorded process still lives; it is never killed or adopted), reaped with its exit, or
    /// unknown. A token the answer leaves out is unknown.
    pub(crate) async fn attempts(
        &self,
        tokens: &[&str],
    ) -> Result<HashMap<String, AttemptState>, String> {
        if tokens.len() > QUERY_MAX {
            return Err(format!("at most {QUERY_MAX} attempt tokens per question"));
        }
        let reply = self
            .call(
                method::ATTEMPTS,
                json!({ "attempts": tokens }),
                Duration::from_secs(15),
            )
            .await?;
        let answered = reply
            .get("attempts")
            .and_then(Value::as_object)
            .ok_or("attempts answer without attempts")?;
        Ok(tokens
            .iter()
            .map(|token| {
                let state = match answered.get(*token) {
                    Some(value) => serde_json::from_value(value.clone()).unwrap_or_else(|e| {
                        AttemptState::Unknown {
                            reason: format!("a malformed attempt state: {e}"),
                        }
                    }),
                    None => AttemptState::Unknown {
                        reason: "the worker did not answer for it".into(),
                    },
                };
                ((*token).to_string(), state)
            })
            .collect())
    }

    /// Acknowledges tokens no durable hub state references. The worker retains unknown/live
    /// writers; callers keep their journals on an error so a later reconciliation can retry.
    pub(crate) async fn forget_attempts(&self, tokens: &[&str]) -> Result<(), String> {
        if tokens.len() > QUERY_MAX {
            return Err(format!(
                "at most {QUERY_MAX} attempt tokens per acknowledgement"
            ));
        }
        self.call(
            method::FORGET_ATTEMPTS,
            json!({ "attempts": tokens }),
            Duration::from_secs(15),
        )
        .await
        .map(|_| ())
    }

    /// TERM or KILL to a spawned child.
    pub(crate) async fn signal(&self, channel: u32, signal: &str) -> Result<(), String> {
        self.call(
            method::SIGNAL,
            json!({ "channel": channel, "signal": signal }),
            Duration::from_secs(5),
        )
        .await
        .map(|_| ())
    }

    /// A delivery marker in a session file on the worker: its whole-file budget plus the round trip.
    pub(crate) async fn find(&self, path: &str, marker: &str) -> Result<Value, String> {
        self.call(
            method::FIND,
            json!({ "path": path, "marker": marker }),
            crate::omp::transcript::MARKER_BUDGET + Duration::from_secs(10),
        )
        .await
    }

    /// The resume check of a session file on the worker.
    pub(crate) async fn verify(&self, params: Value) -> Result<Value, String> {
        self.call(method::VERIFY, params, Duration::from_secs(20))
            .await
    }
    /// Ends the connection: the stream, then `ssh`.
    pub(crate) async fn close(&self) {
        self.mux.close();
        if let Some(child) = self.child.lock().await.take() {
            child
                .close(Duration::from_secs(5), Duration::from_secs(2))
                .await;
        }
    }
}

/// A worker's state as the hub knows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum State {
    /// Not connected, nothing wrong known: it connects when needed.
    Idle,
    Online,
    /// The latest connection failed or dropped.
    Offline,
    /// Host key, forced command or key refused: needs the owner.
    Refused,
    Incompatible,
}

/// The stored record of a worker (store kind `worker`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Record {
    pub(crate) state: State,
    #[serde(default)]
    pub(crate) reason: Option<String>,
    #[serde(default)]
    pub(crate) hello: Option<Hello>,
    #[serde(default)]
    pub(crate) seen_ms: Option<i64>,
    pub(crate) changed_ms: i64,
}

impl Default for Record {
    fn default() -> Self {
        Self {
            state: State::Idle,
            reason: None,
            hello: None,
            seen_ms: None,
            changed_ms: now_ms(),
        }
    }
}

/// One worker as `worker list`, `status` and the panel show it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct View {
    pub(crate) name: String,
    pub(crate) display: String,
    pub(crate) destination: String,
    pub(crate) port: u16,
    pub(crate) state: State,
    #[serde(default)]
    pub(crate) reason: Option<String>,
    #[serde(default)]
    pub(crate) version: Option<String>,
    /// The worker protocol its last `hello` spoke.
    #[serde(default)]
    pub(crate) protocol: Option<u32>,
    #[serde(default)]
    pub(crate) os: Option<String>,
    #[serde(default)]
    pub(crate) arch: Option<String>,
    #[serde(default)]
    pub(crate) omp: Option<String>,
    pub(crate) lanes: usize,
    pub(crate) lanes_max: u32,
    #[serde(default)]
    pub(crate) seen_ms: Option<i64>,
    #[serde(default)]
    pub(crate) repos: Vec<String>,
    pub(crate) tailscale: bool,
}

/// A worker PC's Cataly against this hub's, as far as the hub knows it: the last `hello` it got,
/// also one it refused. Nothing is asked of the worker for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Standing {
    /// As new as the hub, or newer.
    Current,
    /// Older; `held` when it speaks an older worker protocol, whose lanes are held.
    Behind { held: bool },
    /// Unreachable, or never reached: its version is not known.
    Unknown,
}

impl View {
    /// This worker against the hub running `hub` (its version).
    pub(crate) fn standing(&self, hub: &str) -> Standing {
        if matches!(self.state, State::Offline | State::Refused) {
            return Standing::Unknown;
        }
        let Some(version) = &self.version else {
            return Standing::Unknown;
        };
        let held = self.protocol.is_some_and(|p| p < PROTOCOL);
        let parse = crate::sys::release::Version::parse;
        let older = parse(version).zip(parse(hub)).is_some_and(|(w, h)| w < h);
        if held || older {
            Standing::Behind { held }
        } else {
            Standing::Current
        }
    }

    /// What the owner is told about this worker PC against the hub running `hub`, in his
    /// language; `None` when it is current.
    pub(crate) fn standing_note(
        &self,
        hub: &str,
        language: Language,
    ) -> Option<(Standing, String)> {
        let standing = self.standing(hub);
        let (name, version) = (&self.display, self.version.as_deref().unwrap_or_default());
        let note = match (standing, language) {
            (Standing::Current, _) => return None,
            (Standing::Behind { .. }, Language::Korean) => format!(
                "다른 PC {name}는 아직 {version}이에요. 그 PC에서 `cataly update`를 실행하세요."
            ),
            (Standing::Behind { .. }, Language::English) => format!(
                "The other PC {name} is still on {version}. Run `cataly update` on that PC."
            ),
            (Standing::Unknown, Language::Korean) => {
                format!("다른 PC {name}에 연결되지 않아 버전을 알 수 없어요.")
            }
            (Standing::Unknown, Language::English) => {
                format!("The other PC {name} is not connected, so its version is unknown.")
            }
        };
        Some((standing, note))
    }
}

/// What a bridge channel a worker opens is handed to: the hub's bridge.
pub(crate) type ChannelHook = Arc<dyn Fn(String, Accepted) + Send + Sync>;

/// The hub's one worker table, for the per-machine work of remote lanes (design 2.1 `Place`).
static REGISTRY: OnceLock<Arc<Workers>> = OnceLock::new();

/// The live connection to worker `name`, connecting when there is none.
pub(crate) async fn connect(name: &str) -> Result<Arc<Link>, String> {
    let workers = REGISTRY
        .get()
        .ok_or("no worker table: workers run only under the hub")?;
    workers.connect(name).await
}

/// What worker `name` knows of attempt `token`, connecting when needed: running, reaped with its
/// exit, or unknown. A connection or answer that fails is unknown: never taken for an exit.
pub(crate) async fn reconcile(name: &str, token: &str) -> AttemptState {
    let answered = match connect(name).await {
        Ok(link) => link.attempts(&[token]).await,
        Err(e) => Err(e),
    };
    match answered {
        Ok(mut states) => states
            .remove(token)
            .unwrap_or_else(|| AttemptState::Unknown {
                reason: "the worker did not answer for it".into(),
            }),
        Err(e) => AttemptState::Unknown {
            reason: format!("{name}: {e}"),
        },
    }
}

/// The hub's worker table.
pub(crate) fn registry() -> Option<&'static Arc<Workers>> {
    REGISTRY.get()
}

/// How long a failed connection is not tried again for a reachability question.
const RETRY: Duration = Duration::from_mins(1);

/// Every configured worker: its connection, if any, and its state.
pub(crate) struct Workers {
    config: watch::Receiver<Arc<Config>>,
    config_dir: PathBuf,
    logs: PathBuf,
    store: Store,
    links: Mutex<HashMap<String, Arc<Link>>>,
    records: Mutex<HashMap<String, Record>>,
    gates: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    hook: OnceLock<ChannelHook>,
    /// When a connection last failed, per worker: reachability is asked again only after [`RETRY`].
    failed: Mutex<HashMap<String, Instant>>,
    /// Counts connections made and lost, so lanes hear a worker come or go.
    changed: watch::Sender<u64>,
    /// Set at hub stop: no connection is made any more.
    stopped: std::sync::atomic::AtomicBool,
    /// Where `worker.offline` and `worker.online` go.
    events: OnceLock<crate::host::lead::Events>,
}

impl Workers {
    pub(crate) fn new(
        config: watch::Receiver<Arc<Config>>,
        config_file: &Path,
        logs: PathBuf,
        store: Store,
    ) -> Arc<Self> {
        let workers = Arc::new(Self {
            config,
            config_dir: config_file
                .parent()
                .map_or_else(PathBuf::new, Path::to_path_buf),
            logs,
            store,
            links: Mutex::new(HashMap::new()),
            records: Mutex::new(HashMap::new()),
            gates: Mutex::new(HashMap::new()),
            hook: OnceLock::new(),
            failed: Mutex::new(HashMap::new()),
            changed: watch::channel(0).0,
            stopped: std::sync::atomic::AtomicBool::new(false),
            events: OnceLock::new(),
        });
        let _ = REGISTRY.set(Arc::clone(&workers));
        workers
    }

    /// Whether `name` answers now: a live connection, or a new one. A failure is not tried again
    /// within a minute, so a queue sweep never waits on an offline worker each time.
    pub(crate) async fn reachable(self: &Arc<Self>, name: &str) -> bool {
        if self.live(name).is_some() {
            return true;
        }
        let recent = self
            .failed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(name)
            .is_some_and(|at| at.elapsed() < RETRY);
        if recent {
            return false;
        }
        let ok = self.connect(name).await.is_ok();
        let mut failed = self.failed.lock().unwrap_or_else(PoisonError::into_inner);
        if ok {
            failed.remove(name);
        } else {
            failed.insert(name.to_string(), Instant::now());
        }
        ok
    }

    /// Changes whenever a connection is made or lost.
    pub(crate) fn changes(&self) -> watch::Receiver<u64> {
        self.changed.subscribe()
    }

    /// Where the workers' state changes are reported.
    pub(crate) fn set_events(&self, events: crate::host::lead::Events) {
        let _ = self.events.set(events);
    }

    /// How long until a worker that failed may be asked again, the soonest of them; lanes that wait
    /// for a worker sweep again then.
    pub(crate) fn next_retry(&self) -> Option<Duration> {
        self.failed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .filter(|at| at.elapsed() < RETRY)
            .map(|at| RETRY.saturating_sub(at.elapsed()) + Duration::from_millis(100))
            .min()
    }

    /// Where channels the workers open go.
    pub(crate) fn set_hook(&self, hook: ChannelHook) {
        let _ = self.hook.set(hook);
    }

    fn links(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Link>>> {
        self.links.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn records(&self) -> std::sync::MutexGuard<'_, HashMap<String, Record>> {
        self.records.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Reads the stored records, then closes idle connections until the hub stops.
    pub(crate) async fn run(
        self: Arc<Self>,
        mut stop: watch::Receiver<bool>,
    ) -> Result<(), String> {
        if let Ok(docs) = self.store.read(|r| r.coord_all(KIND)).await {
            let mut records = self.records();
            for doc in docs {
                if let Ok(mut record) = serde_json::from_str::<Record>(&doc.body) {
                    // No connection survives a hub restart.
                    if record.state == State::Online {
                        record.state = State::Idle;
                    }
                    records.entry(doc.id).or_insert(record);
                }
            }
        }
        loop {
            tokio::select! {
                () = tokio::time::sleep(SWEEP) => {}
                _ = stop.changed() => break,
            }
            let idle: Vec<Arc<Link>> = self
                .links()
                .values()
                .filter(|l| l.idle_for(IDLE))
                .cloned()
                .collect();
            for link in idle {
                log::info(
                    "worker idle, closing its connection",
                    &[("worker", &link.name)],
                );
                self.links().remove(&link.name);
                link.close().await;
                self.set(&link.name, State::Idle, None, None).await;
            }
        }
        Ok(())
    }

    /// Hub stop, after the lanes ended their input: no new connection, and every one closed.
    pub(crate) async fn shutdown(&self) {
        self.stopped.store(true, Ordering::Release);
        let all: Vec<Arc<Link>> = self.links().drain().map(|(_, l)| l).collect();
        for link in all {
            link.close().await;
        }
    }

    async fn set(&self, name: &str, state: State, reason: Option<String>, hello: Option<Hello>) {
        let now = now_ms();
        let (record, before) = {
            let mut records = self.records();
            let record = records.entry(name.to_string()).or_default();
            let before = record.state;
            if record.state != state || record.reason != reason {
                record.changed_ms = now;
            }
            record.state = state;
            record.reason.clone_from(&reason);
            if let Some(h) = hello {
                record.hello = Some(h);
            }
            if state == State::Online {
                record.seen_ms = Some(now);
            }
            (record.clone(), before)
        };
        // One event per change, never repeated while the state holds (design 2.9).
        let event = match (before, state) {
            (State::Offline, State::Offline) | (State::Online, State::Online) => None,
            (_, State::Offline) => Some(
                Emit::new(EventKind::WorkerOffline, Severity::Warning, true, name)
                    .with("worker", name)
                    .with("detail", reason.as_deref().unwrap_or("unreachable")),
            ),
            (State::Offline, State::Online) => Some(
                Emit::new(EventKind::WorkerOnline, Severity::Info, false, name)
                    .with("worker", name),
            ),
            _ => None,
        };
        if let (Some(event), Some(events)) = (event, self.events.get()) {
            events(event);
        }
        let Ok(doc) = serde_json::to_string(&record) else {
            return;
        };
        let write = CoordWrite::Put {
            kind: KIND.into(),
            id: name.into(),
            doc,
            expect: None,
        };
        if let Err(e) = self.store.coord(write).await {
            log::warn(
                "worker record not stored",
                &[("worker", &name), ("error", &e)],
            );
        }
    }

    /// The live connection to `name`, connecting when there is none.
    pub(crate) async fn connect(self: &Arc<Self>, name: &str) -> Result<Arc<Link>, String> {
        let config = Arc::clone(&self.config.borrow());
        let settings = config
            .workers
            .get(name)
            .ok_or_else(|| format!("no worker named {name}"))?;
        let gate = Arc::clone(
            self.gates
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .entry(name.to_string())
                .or_default(),
        );
        let _one = gate.lock().await;
        if self.stopped.load(Ordering::Acquire) {
            return Err(format!("{name}: the hub is stopping"));
        }
        if let Some(link) = self.links().get(name).filter(|l| !l.mux.is_closed()) {
            link.touch();
            return Ok(Arc::clone(link));
        }
        let target = Target::of(name, settings, &self.config_dir, &self.logs)?;
        match Link::connect(&target).await {
            Ok((link, accepted)) => {
                self.links().insert(name.to_string(), Arc::clone(&link));
                self.set(name, State::Online, None, Some(link.hello.clone()))
                    .await;
                log::info("worker connected", &[("worker", &name)]);
                self.failed
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .remove(name);
                self.changed.send_modify(|n| *n += 1);
                tokio::spawn(Arc::clone(self).watch(Arc::clone(&link), accepted));
                Ok(link)
            }
            Err(e) => {
                let (state, hello) = match &e {
                    ConnectError::Incompatible(_, hello) => {
                        (State::Incompatible, Some(Hello::clone(hello)))
                    }
                    e if e.refused() => (State::Refused, None),
                    _ => (State::Offline, None),
                };
                let text = e.to_string();
                log::warn(
                    "worker connection failed",
                    &[("worker", &name), ("reason", &text)],
                );
                self.set(name, state, Some(text.clone()), hello).await;
                Err(format!("{name}: {text}"))
            }
        }
    }

    /// Hands channels the worker opens to the hook, and marks the worker offline when its stream
    /// drops.
    async fn watch(self: Arc<Self>, link: Arc<Link>, mut accepted: mpsc::Receiver<Accepted>) {
        loop {
            tokio::select! {
                got = accepted.recv() => match got {
                    Some(channel) => match (link.accept(channel), self.hook.get()) {
                        (Some(other), Some(hook)) => hook(link.name.clone(), other),
                        (Some(other), None) => drop(other),
                        (None, _) => {}
                    },
                    None => break,
                },
                () = link.mux.closed() => break,
            }
        }
        let current = self
            .links()
            .get(&link.name)
            .is_some_and(|l| Arc::ptr_eq(l, &link));
        if current {
            self.links().remove(&link.name);
            link.close().await;
            self.set(
                &link.name,
                State::Offline,
                Some(format!(
                    "connection lost at {}",
                    crate::jobs::instant_text(now_ms())
                )),
                None,
            )
            .await;
            log::warn("worker connection lost", &[("worker", &link.name)]);
            self.changed.send_modify(|n| *n += 1);
        }
    }

    /// Ends the connection to `name`, if any.
    pub(crate) async fn disconnect(&self, name: &str) {
        let link = self.links().remove(name);
        if let Some(link) = link {
            link.close().await;
        }
    }

    /// The live connection to `name`, without connecting.
    pub(crate) fn live(&self, name: &str) -> Option<Arc<Link>> {
        self.links()
            .get(name)
            .filter(|l| !l.mux.is_closed())
            .cloned()
    }

    /// Every configured worker.
    pub(crate) fn list(&self) -> Vec<View> {
        let config = Arc::clone(&self.config.borrow());
        let links = self.links().clone();
        let records = self.records().clone();
        config
            .workers
            .iter()
            .map(|(name, s)| {
                let record = records.get(name).cloned().unwrap_or_default();
                let link = links.get(name).filter(|l| !l.mux.is_closed());
                let hello = link.map(|l| l.hello.clone()).or(record.hello);
                View {
                    name: name.clone(),
                    display: s.name.clone().unwrap_or_else(|| name.clone()),
                    destination: s.destination.clone(),
                    port: s.port,
                    state: if link.is_some() {
                        State::Online
                    } else {
                        record.state
                    },
                    reason: if link.is_some() { None } else { record.reason },
                    version: hello.as_ref().map(|h| h.version.clone()),
                    protocol: hello.as_ref().map(|h| h.protocol),
                    os: hello.as_ref().map(|h| h.os.clone()),
                    arch: hello.as_ref().map(|h| h.arch.clone()),
                    omp: hello.as_ref().and_then(|h| h.omp.version.clone()),
                    lanes: link.map_or(0, |l| l.lanes.load(Ordering::Acquire)),
                    lanes_max: s.lanes,
                    seen_ms: if link.is_some() {
                        Some(now_ms())
                    } else {
                        record.seen_ms
                    },
                    repos: s.repos.clone(),
                    tailscale: s.tailscale,
                }
            })
            .collect()
    }

    /// `worker doctor`: connects and checks what a lane will need (design 4.2).
    pub(crate) async fn doctor(self: &Arc<Self>, name: &str) -> Result<Vec<Check>, String> {
        let config = Arc::clone(&self.config.borrow());
        let settings = config
            .workers
            .get(name)
            .ok_or_else(|| format!("no worker named {name}"))?
            .clone();
        let mut checks = Vec::new();
        if settings.tailscale {
            let machine = settings.name.clone().unwrap_or_else(|| name.to_string());
            let host = settings
                .destination
                .split_once('@')
                .map_or(settings.destination.as_str(), |(_, h)| h);
            checks.push(match enrol::tailscale_ip(&machine).await {
                Ok(ip) if ip == host => Check::ok("tailnet address", &ip),
                Ok(ip) => Check::fail(
                    "tailnet address",
                    &format!("{machine} is now {ip}, enrolled as {host}; enrol it again"),
                ),
                Err(e) => Check::fail("tailnet address", &e),
            });
        }
        let link = match self.connect(name).await {
            Ok(l) => l,
            Err(e) => {
                checks.push(Check::fail("connection", &e));
                return Ok(checks);
            }
        };
        let h = &link.hello;
        checks.push(Check::ok(
            "connection",
            "host key pinned, forced command applied, key accepted",
        ));
        checks.push(Check::ok(
            "protocols",
            &format!(
                "cataly {} · worker protocol {} · bridge protocol {} ({} {})",
                h.version, h.protocol, h.bridge, h.os, h.arch
            ),
        ));
        checks.push(match &h.omp.version {
            Some(v) => Check::ok("omp", v),
            None => Check::fail("omp", &h.omp.text()),
        });
        checks.push(match &h.bridge_link {
            None => Check::ok("bridge link", "OMP loads this worker's bridge"),
            Some(e) => Check::fail("bridge link", e),
        });
        checks.push(match &h.git.version {
            Some(v) => Check::ok("git", v),
            None => Check::fail("git", &h.git.text()),
        });
        match link
            .call(method::STATUS, json!({}), Duration::from_secs(5))
            .await
        {
            Ok(status) => {
                let free = status
                    .pointer("/disk/available")
                    .and_then(Value::as_u64)
                    .map_or_else(
                        || "unknown".into(),
                        |b| format!("{} GiB free", b / (1 << 30)),
                    );
                checks.push(Check::ok("disk", &free));
            }
            Err(e) => checks.push(Check::fail("status", &e)),
        }
        for repo in &settings.repos {
            let argv = vec![
                "git".to_string(),
                "ls-remote".into(),
                "--exit-code".into(),
                format!("https://{repo}.git"),
                "HEAD".into(),
            ];
            let env = [("GIT_TERMINAL_PROMPT", "0")];
            let done = link.exec(&argv, None, &env, Duration::from_secs(30)).await;
            checks.push(match done {
                Ok(d) if d.success() => Check::ok(&format!("git access {repo}"), "readable"),
                Ok(d) => Check::fail(
                    &format!("git access {repo}"),
                    String::from_utf8_lossy(&d.stderr)
                        .lines()
                        .last()
                        .unwrap_or("refused"),
                ),
                Err(e) => Check::fail(&format!("git access {repo}"), &e),
            });
        }
        Ok(checks)
    }

    /// `worker remove`: refused while lanes live; asks the worker to forget this hub's line when it
    /// answers; drops the key and config section, and the pin if no other worker uses it. Returns
    /// what the owner still has to do on the worker, if anything.
    pub(crate) async fn remove(
        self: &Arc<Self>,
        name: &str,
        config_file: &Path,
    ) -> Result<Option<String>, String> {
        let config = Arc::clone(&self.config.borrow());
        let settings = config
            .workers
            .get(name)
            .ok_or_else(|| format!("no worker named {name}"))?
            .clone();
        if let Some(link) = self.live(name)
            && link.lanes.load(Ordering::Acquire) > 0
        {
            return Err(format!("{name} still runs lanes; close or move them first"));
        }
        let hub = enrol::hub_id(&self.config_dir)?;
        let forgot = match self.connect(name).await {
            Ok(link) => link
                .call(method::FORGET, json!({}), Duration::from_secs(5))
                .await
                .is_ok(),
            Err(_) => false,
        };
        self.disconnect(name).await;
        let dest = Destination::parse(&format!("{}:{}", settings.destination, settings.port))?;
        remove_files(&self.config_dir, name, &dest, &config)?;
        crate::config::file::edit(config_file, "", |text| {
            Ok(crate::config::file::remove_section(
                text,
                &format!("workers.{name}"),
            ))
        })?;
        self.records().remove(name);
        let _ = self
            .store
            .coord(CoordWrite::Delete {
                kind: KIND.into(),
                id: name.into(),
            })
            .await;
        Ok((!forgot).then(|| {
            format!(
                "{name} did not answer: on it, run `cataly worker init --remove --hub-key '{}'`, or \
                 delete the line ending in {} from ~/.ssh/authorized_keys",
                enrol::comment(&hub),
                enrol::comment(&hub)
            )
        }))
    }
}

/// Drops a worker's key pair and its host-key pin unless another configured worker uses the pin.
pub(crate) fn remove_files(
    config_dir: &Path,
    name: &str,
    dest: &Destination,
    config: &Config,
) -> Result<(), String> {
    let key = enrol::key_path(config_dir, name);
    for path in [key.clone(), PathBuf::from(format!("{}.pub", key.display()))] {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("{}: {e}", path.display())),
        }
    }
    // Pins identify hosts and ports, not remote users.
    if config.workers.iter().any(|(other_name, other)| {
        other_name != name
            && other.port == dest.port
            && Destination::parse(&other.destination)
                .is_ok_and(|other| other.host.eq_ignore_ascii_case(&dest.host))
    }) {
        return Ok(());
    }
    let pins = enrol::known_hosts(config_dir);
    if let Ok(text) = std::fs::read_to_string(&pins) {
        let kept = enrol::drop_pin(&text, &dest.pin_name());
        if kept != text {
            crate::sys::fs::write_atomic(&pins, kept.as_bytes()).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// One `worker doctor` finding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Check {
    pub(crate) name: String,
    pub(crate) ok: bool,
    pub(crate) detail: String,
}

impl Check {
    fn ok(name: &str, detail: &str) -> Self {
        Self {
            name: name.into(),
            ok: true,
            detail: detail.into(),
        }
    }

    fn fail(name: &str, detail: &str) -> Self {
        Self {
            name: name.into(),
            ok: false,
            detail: detail.into(),
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::task::{Context, Waker};

    use super::*;

    #[test]
    fn the_ssh_command_reads_no_config_and_asks_for_the_marker() {
        let dest = Destination::parse("dev@100.101.102.103:2222").unwrap();
        let argv = ssh_argv(
            Path::new("/c/secrets/worker-box"),
            Path::new("/c/known_hosts"),
            &dest,
        );
        let line = argv.join(" ");
        assert!(line.starts_with("ssh -F none -T -i /c/secrets/worker-box -p 2222 "));
        for option in [
            "IdentitiesOnly=yes",
            "IdentityAgent=none",
            "UserKnownHostsFile=/c/known_hosts",
            "GlobalKnownHostsFile=/dev/null",
            "StrictHostKeyChecking=yes",
            "CheckHostIP=no",
            "UpdateHostKeys=no",
            "BatchMode=yes",
            "ClearAllForwardings=yes",
            "ConnectTimeout=10",
            "ServerAliveInterval=15",
            "ServerAliveCountMax=3",
        ] {
            assert!(line.contains(&format!("-o {option} ")), "{option}");
        }
        assert!(line.ends_with("-- dev@100.101.102.103 cataly-worker-v1"));
        assert!(!line.contains("ProxyJump") && !line.contains("ControlMaster"));
    }

    #[test]
    fn removing_workers_keeps_a_shared_host_pin_until_the_last_user() {
        for port in [22, 2222] {
            let dir = crate::sys::fs::tests::scratch("worker-shared-pin");
            let mut config = crate::config::parse(&format!(
                "[workers.alice]\ndestination = \"alice@box\"\nport = {port}\n\
                 [workers.bob]\ndestination = \"bob@box\"\nport = {port}\n\
                 [workers.other-port]\ndestination = \"alice@box\"\nport = 2200\n\
                 [workers.other-host]\ndestination = \"alice@elsewhere\"\nport = {port}\n"
            ))
            .unwrap();
            let dest = Destination::parse(&format!("alice@box:{port}")).unwrap();
            let pins = enrol::known_hosts(&dir);
            let unrelated = format!(
                "[box]:2200 ssh-ed25519 OTHERPORT\n{} ssh-ed25519 OTHERHOST\n",
                Destination::parse(&format!("alice@elsewhere:{port}"))
                    .unwrap()
                    .pin_name()
            );
            let all_pins = enrol::set_pin(&unrelated, &dest.pin_name(), "SHARED");
            crate::sys::fs::write_atomic(&pins, all_pins.as_bytes()).unwrap();
            crate::sys::fs::ensure_private_dir(&dir.join("secrets")).unwrap();
            for name in config.workers.keys() {
                let key = enrol::key_path(&dir, name);
                std::fs::write(&key, "private").unwrap();
                std::fs::write(key.with_extension("pub"), "public").unwrap();
            }

            remove_files(&dir, "alice", &dest, &config).unwrap();
            let key = enrol::key_path(&dir, "alice");
            assert!(!key.exists() && !key.with_extension("pub").exists());
            assert_eq!(std::fs::read_to_string(&pins).unwrap(), all_pins);
            config.workers.remove("alice");
            for name in config.workers.keys() {
                let key = enrol::key_path(&dir, name);
                assert!(key.exists() && key.with_extension("pub").exists());
            }

            let dest = Destination::parse(&format!("bob@box:{port}")).unwrap();
            remove_files(&dir, "bob", &dest, &config).unwrap();
            let key = enrol::key_path(&dir, "bob");
            assert!(!key.exists() && !key.with_extension("pub").exists());
            assert_eq!(std::fs::read_to_string(&pins).unwrap(), unrelated);
        }
    }

    #[test]
    fn removing_workers_keeps_a_shared_host_pin_with_mixed_case_hosts() {
        for port in [22, 2222] {
            let config = crate::config::parse(&format!(
                "[workers.alice]\ndestination = \"alice@BoX\"\nport = {port}\n\
                 [workers.bob]\ndestination = \"bob@bOx\"\nport = {port}\n"
            ))
            .unwrap();
            for (name, destination) in [("alice", "alice@BoX"), ("bob", "bob@bOx")] {
                let dir = crate::sys::fs::tests::scratch("worker-shared-pin-case");
                let dest = Destination::parse(&format!("{destination}:{port}")).unwrap();
                let pins = enrol::known_hosts(&dir);
                let all_pins = enrol::set_pin("", &dest.pin_name(), "SHARED");
                crate::sys::fs::write_atomic(&pins, all_pins.as_bytes()).unwrap();

                remove_files(&dir, name, &dest, &config).unwrap();
                assert_eq!(std::fs::read_to_string(&pins).unwrap(), all_pins);
            }
        }
    }

    #[test]
    fn removing_workers_drops_all_shared_host_pin_case_variants() {
        for port in [22, 2222] {
            let dir = crate::sys::fs::tests::scratch("worker-shared-pin-variants");
            let mut config = crate::config::parse(&format!(
                "[workers.alice]\ndestination = \"alice@BoX\"\nport = {port}\n\
                 [workers.bob]\ndestination = \"bob@bOx\"\nport = {port}\n"
            ))
            .unwrap();
            let alice = Destination::parse(&format!("alice@BoX:{port}")).unwrap();
            let bob = Destination::parse(&format!("bob@bOx:{port}")).unwrap();
            let pins = enrol::known_hosts(&dir);
            // Older enrolments can leave one pin for each host-name spelling.
            let all_pins = format!(
                "{} ssh-ed25519 SHARED\n{} ssh-ed25519 SHARED\n",
                alice.pin_name(),
                bob.pin_name()
            );
            crate::sys::fs::write_atomic(&pins, all_pins.as_bytes()).unwrap();

            remove_files(&dir, "alice", &alice, &config).unwrap();
            assert_eq!(std::fs::read_to_string(&pins).unwrap(), all_pins);
            config.workers.remove("alice");
            remove_files(&dir, "bob", &bob, &config).unwrap();
            assert_eq!(std::fs::read_to_string(&pins).unwrap(), "");
        }
    }

    #[test]
    fn ssh_failures_are_named() {
        assert_eq!(
            classify(
                "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.\n",
                Some(Exit::Code(255))
            ),
            ConnectError::HostKey
        );
        assert_eq!(
            classify(
                "No ED25519 host key is known for [h]:2222 and you have requested strict checking.\n",
                None
            ),
            ConnectError::HostKey
        );
        assert_eq!(
            classify(
                "bash: line 1: cataly-worker-v1: command not found\n",
                Some(Exit::Code(127))
            ),
            ConnectError::NoForcedCommand
        );
        assert_eq!(
            classify("", Some(Exit::Code(127))),
            ConnectError::NoForcedCommand
        );
        assert_eq!(
            classify(
                "dev@h: Permission denied (publickey).\n",
                Some(Exit::Code(255))
            ),
            ConnectError::Denied
        );
        let other = classify(
            "ssh: connect to host h port 22: Connection refused\n",
            Some(Exit::Code(255)),
        );
        assert!(matches!(&other, ConnectError::Unreachable(t) if t.contains("Connection refused")));
        assert!(!other.refused() && ConnectError::HostKey.refused());
        assert!(ConnectError::NoForcedCommand.to_string().contains("2222"));
    }

    #[test]
    fn exec_results_cross_the_wire_unchanged() {
        let done = Finished {
            exit: Exit::Signal(9),
            timed_out: true,
            cancelled: false,
            stdout: b"out\xff".to_vec(),
            stderr: b"err".to_vec(),
            stdout_bytes: 4,
            stdout_sha256: Some([7; 32]),
            truncated: true,
            pipes_held: false,
        };
        let back = finished_of(&exec_reply(&done)).unwrap();
        assert_eq!(back.exit, Exit::Signal(9));
        assert!(back.timed_out && back.truncated && !back.success());
        assert_eq!((back.stdout_sha256, back.stdout_bytes), (Some([7; 32]), 4));
        assert_eq!((back.stdout, back.stderr), (done.stdout, done.stderr));
        let ok = finished_of(&json!({"exit": {"code": 0}, "stdout": "", "stderr": ""})).unwrap();
        assert!(ok.success());
        assert!(finished_of(&json!({"exit": {"code": 0}})).is_err());
    }

    /// A worker PC is named when it speaks an older protocol or runs an older version than the
    /// hub; a current or newer one is not; an unreachable or never-reached one is unknown, not
    /// outdated, even with an old `hello` on record.
    #[test]
    fn older_worker_pcs_are_named_and_unreachable_ones_unknown() {
        let view = |state: State, version: Option<&str>, protocol: Option<u32>| View {
            name: "box".into(),
            display: "box".into(),
            destination: "dev@box".into(),
            port: 22,
            state,
            reason: None,
            version: version.map(str::to_string),
            protocol,
            os: None,
            arch: None,
            omp: None,
            lanes: 0,
            lanes_max: 1,
            seen_ms: None,
            repos: Vec::new(),
            tailscale: false,
        };
        let ko = Language::Korean;
        let old = view(State::Incompatible, Some("0.2.6"), Some(1));
        assert_eq!(old.standing("0.2.8"), Standing::Behind { held: true });
        assert_eq!(
            old.standing_note("0.2.8", ko).unwrap().1,
            "다른 PC box는 아직 0.2.6이에요. 그 PC에서 `cataly update`를 실행하세요."
        );
        assert_eq!(
            old.standing_note("0.2.8", Language::English).unwrap().1,
            "The other PC box is still on 0.2.6. Run `cataly update` on that PC."
        );
        let behind = view(State::Idle, Some("0.2.7"), Some(PROTOCOL));
        assert_eq!(behind.standing("0.2.8"), Standing::Behind { held: false });
        for current in [
            view(State::Online, Some("0.2.8"), Some(PROTOCOL)),
            view(State::Online, Some("0.2.9"), Some(PROTOCOL)),
        ] {
            assert_eq!(current.standing_note("0.2.8", ko), None);
        }
        for unknown in [
            view(State::Offline, Some("0.2.6"), Some(1)),
            view(State::Refused, None, None),
            view(State::Idle, None, None),
        ] {
            assert_eq!(
                unknown.standing_note("0.2.8", ko).unwrap(),
                (
                    Standing::Unknown,
                    "다른 PC box에 연결되지 않아 버전을 알 수 없어요.".to_string()
                )
            );
        }
    }

    #[test]
    fn compatibility_needs_both_protocols() {
        let hello = Hello {
            protocol: super::super::PROTOCOL,
            bridge: crate::hub::bridge::PROTOCOL,
            ..Hello::default()
        };
        assert_eq!(hello.incompatible("box"), None);
        // A worker on protocol 1 has no attempt tokens or exit acknowledgements: refused, never
        // misread.
        let older = Hello {
            protocol: 1,
            ..hello.clone()
        };
        assert_eq!(
            older.incompatible("box").unwrap(),
            "incompatible: the cataly on box speaks worker protocol 1 where this hub speaks 2; run \
             cataly update on box"
        );
        let newer = Hello {
            protocol: 3,
            ..hello.clone()
        };
        assert!(
            newer
                .incompatible("box")
                .unwrap()
                .contains("run cataly update on box")
        );
        let bridge = Hello { bridge: 2, ..hello };
        assert!(
            bridge
                .incompatible("box")
                .unwrap()
                .contains("bridge protocol 2")
        );
    }

    /// A connected link whose peer leaves requests unanswered.
    fn unanswered() -> (Arc<Link>, DuplexStream) {
        let (hub, worker) = tokio::io::duplex(256 * 1024);
        let (read, write) = tokio::io::split(hub);
        let (mux, control, _) = Mux::start(read, write, Timing::STANDARD);
        (
            Link::assemble("box", Hello::default(), mux, Client::start(control), None),
            worker,
        )
    }

    #[tokio::test(start_paused = true)]
    async fn cancelled_requests_release_the_link() {
        let (link, _worker) = unanswered();
        let mut cx = Context::from_waker(Waker::noop());
        {
            let request = link.request(method::STATUS, json!({}), Duration::from_secs(30));
            tokio::pin!(request);
            assert!(request.as_mut().poll(&mut cx).is_pending());
            assert_eq!(link.pending.load(Ordering::Acquire), 1);
            assert!(!link.idle_for(Duration::ZERO));
        }
        assert_eq!(link.pending.load(Ordering::Acquire), 0);
        assert!(link.idle_for(Duration::ZERO));
        link.mux.close();
    }

    #[tokio::test(start_paused = true)]
    async fn cancelled_spawns_close_unclaimed_channels() {
        use tokio::io::AsyncReadExt as _;

        // Cancel before the reply, with the channel already accepted or still to arrive, and
        // after the reply while waiting for its channel. None may keep the child's input open.
        for (channel_first, reply_first) in [(false, false), (true, false), (false, true)] {
            let (link, _worker) = unanswered();
            let mut cx = Context::from_waker(Waker::noop());
            let argv = ["omp".to_string()];
            let (stream, mut input) = tokio::io::duplex(64);
            let (_exit, exit) = oneshot::channel();
            let mut channel = Some(Accepted {
                channel: 1,
                header: json!({"kind": "spawn", "attempt": "cancelled"}),
                stream,
                exit,
            });
            {
                let spawning = link.spawn(&argv, "/", &[], "cancelled", None);
                tokio::pin!(spawning);
                assert!(spawning.as_mut().poll(&mut cx).is_pending());
                assert_eq!(link.pending.load(Ordering::Acquire), 1);
                if channel_first {
                    assert!(link.accept(channel.take().unwrap()).is_none());
                }
                if reply_first {
                    // Deliver the fake worker's reply before polling the channel wait.
                    link.client
                        .pending
                        .lock()
                        .unwrap()
                        .remove(&1)
                        .unwrap()
                        .send(Response::ok(
                            1,
                            json!({"channel": 1, "attempt": "cancelled"}),
                        ))
                        .unwrap();
                    assert!(spawning.as_mut().poll(&mut cx).is_pending());
                    assert_eq!(link.pending.load(Ordering::Acquire), 0);
                }
            }
            if let Some(channel) = channel {
                assert!(link.accept(channel).is_none());
            }
            assert!(link.spawned.lock().unwrap().is_empty());
            let mut byte = [0];
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(1), input.read(&mut byte))
                    .await
                    .unwrap()
                    .unwrap(),
                0,
                "channel_first={channel_first}, reply_first={reply_first}"
            );
            assert_eq!(link.pending.load(Ordering::Acquire), 0);
            assert!(link.idle_for(Duration::ZERO));
            link.mux.close();
        }
    }

    /// The real `serve` in this process over an in-memory stream, with `/bin/sh` as its OMP, and
    /// the hub's link to it.
    pub(crate) fn served(root: &Path) -> (Arc<Link>, tokio::task::JoinHandle<u8>) {
        let worker = Arc::new(super::super::serve::Worker {
            hub: "123456".into(),
            root: root.to_path_buf(),
            socket: root.join("w.sock"),
            omp: "/bin/sh".into(),
            path: None,
            attempts: super::super::attempt::Attempts::new(root),
            children: Mutex::new(HashMap::new()),
        });
        crate::sys::fs::ensure_private_dir(worker.attempts.dir()).unwrap();
        crate::sys::fs::ensure_private_dir(&root.join("logs")).unwrap();
        let (hub_end, worker_end) = tokio::io::duplex(256 * 1024);
        let (wr, ww) = tokio::io::split(worker_end);
        let serving = tokio::spawn(super::super::serve::serve(
            worker,
            wr,
            ww,
            Timing::STANDARD,
            std::future::pending(),
        ));
        let (hr, hw) = tokio::io::split(hub_end);
        let (mux, control, mut accepted) = Mux::start(hr, hw, Timing::STANDARD);
        let hello = Hello {
            protocol: super::super::PROTOCOL,
            bridge: crate::hub::bridge::PROTOCOL,
            ..Hello::default()
        };
        let link = Link::assemble("box", hello, mux, Client::start(control), None);
        let router = Arc::clone(&link);
        tokio::spawn(async move {
            while let Some(channel) = accepted.recv().await {
                drop(router.accept(channel));
            }
        });
        (link, serving)
    }

    /// Each attempt is acknowledged once its OMP is reaped, with its exit code or signal; a drop
    /// before the acknowledgement is unknown until the reconnected worker answers for the token.
    #[tokio::test]
    async fn attempts_are_acknowledged_once_reaped_and_reconciled_after_a_drop() {
        use crate::host::lead::Lease;
        use crate::worker::attempt::Reaped;
        use tokio::io::AsyncReadExt as _;
        let root = crate::sys::fs::tests::scratch("worker-ack");
        let cwd = root.display().to_string();
        let sh = |script: &str| vec!["omp".to_string(), "-c".into(), script.into()];
        let reaped = |exit| AttemptState::Reaped {
            exit,
            lease: Lease::Unknown,
        };
        let (link, serving) = served(&root);

        let mut normal = link
            .spawn(
                &sh("echo ready; exec cat >/dev/null"),
                &cwd,
                &[],
                "a1",
                None,
            )
            .await
            .unwrap();
        let mut first = [0u8; 6];
        normal.stream.read_exact(&mut first).await.unwrap();
        assert_eq!(&first, b"ready\n");
        normal.stream.shutdown().await.unwrap();
        assert_eq!(normal.exit.attempt(), "a1");
        assert_eq!(normal.exit.wait().await, reaped(Reaped::Code(0)));
        assert_eq!(normal.exit.wait().await, reaped(Reaped::Code(0)));
        let reused = link.spawn(&sh("true"), &cwd, &[], "a1", None).await;
        assert!(
            matches!(&reused, Err(SpawnError::Refused(e)) if e.contains("already recorded")),
            "{:?}",
            reused.err()
        );
        let tokenless = link.spawn(&sh("true"), &cwd, &[], "", None).await;
        assert!(matches!(tokenless, Err(SpawnError::Refused(_))));

        let mut killed = link
            .spawn(&sh("exec sleep 30"), &cwd, &[], "a2", None)
            .await
            .unwrap();
        link.signal(killed.channel, "KILL").await.unwrap();
        assert_eq!(killed.exit.wait().await, reaped(Reaped::Signal(9)));

        // `cat` keeps its output open: the worker ends a child whose output ended, so a child that
        // closed it (`>/dev/null`) would be reaped and acknowledged before the drop.
        let mut dropped = link
            .spawn(&sh("exec cat"), &cwd, &[], "a3", None)
            .await
            .unwrap();
        let live = link.attempts(&["a3"]).await.unwrap();
        assert!(
            matches!(live["a3"], AttemptState::Running { .. }),
            "{live:?}"
        );
        link.mux.close();
        assert!(matches!(
            dropped.exit.wait().await,
            AttemptState::Unknown { reason } if reason.contains("ended before")
        ));
        // The worker closed the child by the HOST-20 rule and recorded how it ended.
        assert_eq!(serving.await.unwrap(), crate::cli::exit::OK);
        let (again, _serving) = served(&root);
        let states = again.attempts(&["a1", "a2", "a3", "never"]).await.unwrap();
        assert_eq!(states["a1"], reaped(Reaped::Code(0)));
        assert_eq!(states["a2"], reaped(Reaped::Signal(9)));
        assert_eq!(states["a3"], reaped(Reaped::Code(0)));
        assert!(matches!(
            &states["never"],
            AttemptState::Unknown { reason } if reason.contains("no record")
        ));
        again.mux.close();
    }
}
