//! The lead's stream jobs (WS-02, WS-04; WS req. 71-75): a long-running command whose output lines
//! that match a filter become events for the lead. Restart policy with backoff, an optional silence
//! alert, oversized lines to a private file. The hub owns them: they outlive the lead's OMP process,
//! are kept in the store and start again with the hub. The lead's tool forwards start, stop and list.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::AsyncReadExt;
use tokio::sync::watch;

use crate::jobs::Jobs;
use crate::jobs::event::{Emit, EventKind, Severity, one_line};
use crate::log;
use crate::params as p;
use crate::store::Store;
use crate::store::lead::LeadWrite;
use crate::sys::command::{self, Exit, KILL_GRACE};

/// A line longer than this is not filtered; it goes to a private file (WS req. 72).
const LINE_MAX: usize = 64 * 1024;
const JOBS_MAX: usize = 16;
const ARGV_MAX: usize = 64;
const STDERR_CAP: u64 = 256 * 1024;
/// How much output one read takes; a line in memory never exceeds `LINE_MAX` plus this.
const CHUNK: usize = 8 * 1024;
/// The most of one long line its file keeps (WS req. 72); the rest is counted, not saved.
const SPILL_MAX: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Spec {
    name: String,
    argv: Vec<String>,
    filter: String,
    restarts: u32,
    delay_s: u64,
    silence_m: Option<u64>,
    low: bool,
}

#[derive(Debug, Clone)]
struct State {
    phase: &'static str,
    restarts: u32,
    last_exit: Option<String>,
    next_restart: Option<Instant>,
    stop: watch::Sender<bool>,
}

/// Running stream jobs.
pub(crate) struct Streams {
    jobs: Jobs,
    store: Store,
    cwd: PathBuf,
    files: PathBuf,
    running: Mutex<HashMap<String, State>>,
}

fn spec_of(input: &Value) -> Result<Spec, String> {
    let name = p::NAME.text(input).unwrap_or_default();
    let valid = !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    if !valid {
        return Err("name: 1 to 64 letters, digits, '-', '_' or '.'".into());
    }
    let argv: Vec<String> = p::ARGV.list(input);
    if argv.is_empty() || argv.len() > ARGV_MAX {
        return Err("argv: the command and its arguments, 1 to 64 words (no shell)".into());
    }
    let filter = p::FILTER.text(input).unwrap_or(".").to_string();
    regex::RegexBuilder::new(&filter)
        .size_limit(1 << 20)
        .build()
        .map_err(|e| format!("filter: {e}"))?;
    let restarts = p::RESTARTS.uint(input).unwrap_or(5);
    let delay_s = p::DELAY.uint(input).unwrap_or(10);
    let silence_m = p::SILENCE.uint(input);
    if restarts > 100
        || !(1..=3600).contains(&delay_s)
        || silence_m.is_some_and(|m| !(1..=1440).contains(&m))
    {
        return Err("restarts 0 to 100, delay 1 to 3600 s, silence 1 to 1440 minutes".into());
    }
    Ok(Spec {
        name: name.to_string(),
        argv,
        filter,
        restarts: u32::try_from(restarts).unwrap_or(5),
        delay_s,
        silence_m,
        low: p::LOW.flag(input),
    })
}

impl Streams {
    pub(crate) fn new(jobs: Jobs, store: Store, cwd: PathBuf, files: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            jobs,
            store,
            cwd,
            files,
            running: Mutex::new(HashMap::new()),
        })
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, State>> {
        self.running.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Starts the stream jobs kept in the store (WS-04: the hub restores its own jobs).
    pub(crate) async fn resume(self: &Arc<Self>) {
        let kept = self
            .store
            .read(crate::store::Reads::stream_jobs)
            .await
            .unwrap_or_default();
        for (name, spec) in kept {
            match serde_json::from_str::<Spec>(&spec) {
                Ok(spec) => self.spawn(spec),
                Err(e) => log::warn("stream job not restored", &[("job", &name), ("error", &e)]),
            }
        }
    }

    pub(crate) async fn start(self: &Arc<Self>, input: &Value) -> Result<String, String> {
        let spec = spec_of(input)?;
        {
            let running = self.lock();
            if running.contains_key(&spec.name) {
                return Err(format!(
                    "a stream job named {} exists; stop it first",
                    spec.name
                ));
            }
            if running.len() >= JOBS_MAX {
                return Err(format!("at most {JOBS_MAX} stream jobs"));
            }
        }
        let saved = serde_json::to_string(&spec).map_err(|e| e.to_string())?;
        self.store
            .lead(LeadWrite::StreamSave {
                name: spec.name.clone(),
                spec: saved,
            })
            .await
            .map_err(|e| e.to_string())?;
        let name = spec.name.clone();
        self.spawn(spec);
        Ok(format!(
            "stream job {name} started; matching lines arrive as [event stream.line]"
        ))
    }

    pub(crate) async fn stop(&self, name: &str) -> Result<String, String> {
        let state = self
            .lock()
            .remove(name)
            .ok_or(format!("no stream job named {name}"))?;
        let _ = state.stop.send(true);
        self.store
            .lead(LeadWrite::StreamRemove { name: name.into() })
            .await
            .map_err(|e| e.to_string())?;
        Ok(format!("stream job {name} stopped"))
    }

    pub(crate) fn list(&self) -> String {
        let running = self.lock();
        if running.is_empty() {
            return "no stream jobs".into();
        }
        let mut names: Vec<&String> = running.keys().collect();
        names.sort();
        let mut out = String::new();
        for name in names {
            let Some(s) = running.get(name) else { continue };
            let _ = write!(
                out,
                "- {name}: {}, {} restart(s), last exit {}",
                s.phase,
                s.restarts,
                s.last_exit.as_deref().unwrap_or("none")
            );
            if let Some(at) = s.next_restart {
                let _ = write!(
                    out,
                    ", next restart in {} s",
                    at.saturating_duration_since(Instant::now()).as_secs()
                );
            }
            out.push('\n');
        }
        out.trim_end().to_string()
    }

    fn spawn(self: &Arc<Self>, spec: Spec) {
        let (stop, stopped) = watch::channel(false);
        self.lock().insert(
            spec.name.clone(),
            State {
                phase: "running",
                restarts: 0,
                last_exit: None,
                next_restart: None,
                stop,
            },
        );
        let me = Arc::clone(self);
        tokio::spawn(async move { me.run(spec, stopped).await });
    }

    fn update(&self, name: &str, f: impl FnOnce(&mut State)) {
        if let Some(s) = self.lock().get_mut(name) {
            f(s);
        }
    }

    async fn emit(&self, kind: EventKind, spec: &Spec, urgent: bool, value: &str) {
        let field = if kind == EventKind::StreamLine {
            "line"
        } else {
            "reason"
        };
        let emit = Emit::new(kind, Severity::Info, urgent, &spec.name)
            .with("job", &spec.name)
            .with(field, value);
        if let Err(e) = self.jobs.hub_event(emit).await {
            log::warn(
                "stream event not recorded",
                &[("job", &spec.name), ("error", &e)],
            );
        }
    }

    /// Runs the command until it is stopped or its restarts are used up (WS req. 73).
    async fn run(self: Arc<Self>, spec: Spec, mut stopped: watch::Receiver<bool>) {
        let Ok(filter) = regex::RegexBuilder::new(&spec.filter)
            .size_limit(1 << 20)
            .build()
        else {
            return;
        };
        let stderr = self
            .files
            .join("streams")
            .join(format!("{}.err", spec.name));
        let _ = crate::sys::fs::ensure_private_dir(&self.files.join("streams"));
        let mut attempt: u32 = 0;
        loop {
            let ended = match command::attach(
                &spec.argv,
                Some(&self.cwd),
                &[],
                Some(&stderr),
                STDERR_CAP,
            ) {
                Ok(child) => self.watch_output(&spec, &filter, child, &mut stopped).await,
                Err(e) => Some(format!("not started: {e}")),
            };
            let Some(exit) = ended else {
                return;
            };
            self.update(&spec.name, |s| s.last_exit = Some(exit.clone()));
            if attempt >= spec.restarts {
                self.update(&spec.name, |s| s.phase = "exhausted");
                let reason = format!("exited ({exit}) and no restart is left");
                self.emit(EventKind::StreamEnded, &spec, !spec.low, &reason)
                    .await;
                return;
            }
            let wait =
                Duration::from_secs(spec.delay_s.saturating_mul(1 << attempt.min(10)).min(3600));
            attempt += 1;
            self.update(&spec.name, |s| {
                s.restarts = attempt;
                s.phase = "waiting";
                s.next_restart = Some(Instant::now() + wait);
            });
            tokio::select! {
                () = tokio::time::sleep(wait) => {}
                _ = stopped.changed() => return,
            }
            self.update(&spec.name, |s| {
                s.phase = "running";
                s.next_restart = None;
            });
        }
    }

    /// Reads one child's output; `None` when the job was stopped, else how the child ended.
    async fn watch_output(
        &self,
        spec: &Spec,
        filter: &regex::Regex,
        mut child: command::Attached,
        stopped: &mut watch::Receiver<bool>,
    ) -> Option<String> {
        let mut stdout = child.take_stdout()?;
        let mut chunk = vec![0u8; CHUNK];
        let mut line = Line::new(self.files.join("streams"), &spec.name);
        let silence = spec.silence_m.map(|m| Duration::from_secs(m * 60));
        let mut quiet_since = Instant::now();
        let mut alerted = false;
        loop {
            let wait = silence.map_or(Duration::from_secs(3600), |s| {
                s.saturating_sub(quiet_since.elapsed())
                    .max(Duration::from_secs(1))
            });
            let read = tokio::select! {
                read = stdout.read(&mut chunk) => read,
                () = tokio::time::sleep(wait) => {
                    if let Some(s) = silence && !alerted && quiet_since.elapsed() >= s {
                        alerted = true;
                        let text = format!("no output for {} minute(s); still running", s.as_secs() / 60);
                        self.emit(EventKind::StreamLine, spec, !spec.low, &text).await;
                    }
                    continue;
                }
                _ = stopped.changed() => {
                    line.discard();
                    child.close(Duration::ZERO, KILL_GRACE).await;
                    return None;
                }
            };
            let Some(output) = read.ok().filter(|&n| n > 0).and_then(|n| chunk.get(..n)) else {
                break;
            };
            quiet_since = Instant::now();
            alerted = false;
            let mut parts = output.split(|&b| b == b'\n');
            if let Some(first) = parts.next() {
                line.push(first);
            }
            for part in parts {
                self.line_ended(spec, filter, line.finish()).await;
                line.push(part);
            }
        }
        if !line.is_empty() {
            // Only LF makes a pending CR part of a line ending; at EOF it is data.
            line.flush_cr();
            self.line_ended(spec, filter, line.finish()).await;
        }
        let (exit, _) = child.close(Duration::from_secs(5), KILL_GRACE).await;
        Some(match exit {
            Exit::Code(c) => format!("status {c}"),
            Exit::Signal(s) => format!("signal {s}"),
            Exit::Unknown => "unknown status".into(),
        })
    }

    async fn line_ended(&self, spec: &Spec, filter: &regex::Regex, ended: Ended) {
        match ended {
            Ended::Text(text) if filter.is_match(&text) => {
                self.emit(
                    EventKind::StreamLine,
                    spec,
                    !spec.low,
                    &one_line(&text, 300),
                )
                .await;
            }
            Ended::Text(_) => {}
            Ended::Saved(note) => {
                self.emit(EventKind::StreamLine, spec, !spec.low, &note)
                    .await;
            }
        }
    }
}

/// A line that ended: its text, or the note about the private file a long line went to.
enum Ended {
    Text(String),
    Saved(String),
}

/// The output line being read. Up to `LINE_MAX` bytes stay in memory; a longer line continues in a
/// private file (WS req. 72), so output without line ends never grows the hub's memory. The file
/// keeps the first `SPILL_MAX` bytes; the rest is only counted.
struct Line {
    dir: PathBuf,
    name: String,
    bytes: Vec<u8>,
    /// Held outside the length and file until another byte or EOF proves it is not CRLF.
    pending_cr: bool,
    spill: Option<Spill>,
}

struct Spill {
    /// The file and its path; `Err` once it could not be made or written (no file is left then).
    file: Result<(std::fs::File, PathBuf), String>,
    len: usize,
}

impl Line {
    fn new(dir: PathBuf, name: &str) -> Self {
        Self {
            dir,
            name: name.into(),
            bytes: Vec::new(),
            pending_cr: false,
            spill: None,
        }
    }

    fn is_empty(&self) -> bool {
        self.bytes.is_empty() && !self.pending_cr && self.spill.is_none()
    }

    fn push(&mut self, part: &[u8]) {
        if part.is_empty() {
            return;
        }
        self.flush_cr();
        let part = if let Some(prefix) = part.strip_suffix(b"\r") {
            self.pending_cr = true;
            prefix
        } else {
            part
        };
        self.write(part);
    }

    fn flush_cr(&mut self) {
        if std::mem::take(&mut self.pending_cr) {
            self.write(b"\r");
        }
    }

    fn write(&mut self, part: &[u8]) {
        if let Some(spill) = &mut self.spill {
            spill.write(part);
            return;
        }
        self.bytes.extend_from_slice(part);
        if self.bytes.len() > LINE_MAX {
            let path = self
                .dir
                .join(format!("{}-{}.txt", self.name, crate::sys::unique_stem()));
            let file = crate::sys::fs::create_private(&path)
                .map(|file| (file, path))
                .map_err(|e| e.to_string());
            let mut spill = Spill { file, len: 0 };
            spill.write(&std::mem::take(&mut self.bytes));
            self.spill = Some(spill);
        }
    }

    /// Ends a line at LF; at EOF the pending CR must be flushed as data first.
    fn finish(&mut self) -> Ended {
        self.pending_cr = false;
        let Some(spill) = self.spill.take() else {
            let bytes = std::mem::take(&mut self.bytes);
            return Ended::Text(String::from_utf8_lossy(&bytes).into_owned());
        };
        let len = spill.len;
        let saved = spill.file.and_then(|(file, path)| {
            let synced = file
                .sync_all()
                .map_err(|e| format!("sync file: {e}"))
                .and_then(|()| {
                    crate::sys::fs::sync_dir(&self.dir).map_err(|e| format!("sync directory: {e}"))
                });
            if let Err(e) = synced {
                let _ = std::fs::remove_file(&path);
                return Err(e);
            }
            Ok(path)
        });
        Ended::Saved(match saved {
            Ok(path) if len > SPILL_MAX => format!(
                "a line of {len} bytes, the first {SPILL_MAX} saved in {}",
                path.display()
            ),
            Ok(path) => format!("a line of {len} bytes, saved in {}", path.display()),
            Err(e) => format!("a line of {len} bytes that could not be saved: {e}"),
        })
    }

    /// Drops a line cut short by a stop, with its unfinished file.
    fn discard(&mut self) {
        if let Some(Spill {
            file: Ok((_, path)),
            ..
        }) = self.spill.take()
        {
            let _ = std::fs::remove_file(path);
        }
    }
}

impl Spill {
    fn write(&mut self, part: &[u8]) {
        use std::io::Write as _;
        let room = SPILL_MAX.saturating_sub(self.len);
        self.len += part.len();
        let Ok((file, path)) = &mut self.file else {
            return;
        };
        let Some(kept) = part.get(..part.len().min(room)) else {
            return;
        };
        if let Err(e) = file.write_all(kept) {
            let _ = std::fs::remove_file(&*path);
            self.file = Err(e.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn specs_are_checked() {
        assert!(spec_of(&json!({"name": "x", "argv": ["tail"]})).is_ok());
        assert!(spec_of(&json!({"name": "bad name", "argv": ["tail"]})).is_err());
        assert!(spec_of(&json!({"name": "x", "argv": []})).is_err());
        assert!(spec_of(&json!({"name": "x", "argv": ["a"], "filter": "("})).is_err());
        assert!(spec_of(&json!({"name": "x", "argv": ["a"], "restarts": 101})).is_err());
    }

    fn saved_path(ended: Ended) -> (String, PathBuf) {
        let Ended::Saved(note) = ended else {
            panic!("not saved")
        };
        let path = PathBuf::from(note.rsplit(" saved in ").next().unwrap());
        (note, path)
    }

    #[test]
    fn a_crlf_line_at_the_limit_stays_text() {
        let dir = crate::sys::fs::tests::scratch("streams-crlf-limit");
        let mut input = vec![b'x'; LINE_MAX];
        input.push(b'\r');
        for chunk_size in [LINE_MAX, LINE_MAX + 1] {
            let mut line = Line::new(dir.to_path_buf(), "limit");
            for part in input.chunks(chunk_size) {
                line.push(part);
            }
            // The next read can start with the LF, giving an empty part before finish.
            line.push(b"");
            assert!(line.spill.is_none(), "the CRLF must not force a spill");
            let Ended::Text(text) = line.finish() else {
                panic!("the line should still be filtered")
            };
            assert_eq!(text.len(), LINE_MAX);
            assert!(text.bytes().all(|b| b == b'x'));
            assert!(line.is_empty());
            line.push(b"next");
            assert!(matches!(line.finish(), Ended::Text(text) if text == "next"));
        }
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
    }

    #[test]
    fn a_spilled_crlf_line_drops_only_its_final_cr() {
        let dir = crate::sys::fs::tests::scratch("streams-crlf-spill");
        for len in [LINE_MAX + 1, SPILL_MAX] {
            let mut expected = vec![b'x'; len];
            expected[LINE_MAX - 1] = b'\r';
            *expected.last_mut().unwrap() = b'\r';
            let mut input = expected.clone();
            input.push(b'\r');
            for chunk_size in [CHUNK, len, len + 1] {
                let mut line = Line::new(dir.to_path_buf(), "crlf");
                for part in input.chunks(chunk_size) {
                    line.push(part);
                }
                line.push(b"");
                let (note, path) = saved_path(line.finish());
                assert_eq!(
                    note,
                    format!("a line of {len} bytes, saved in {}", path.display())
                );
                assert_eq!(std::fs::read(path).unwrap(), expected);
            }
        }
    }

    #[test]
    fn a_spill_directory_sync_failure_is_reported() {
        let dir = crate::sys::fs::tests::scratch("streams-dir-sync");
        let mut line = Line::new(dir.to_path_buf(), "sync");
        let len = LINE_MAX + 1;
        line.push(&vec![b'x'; len]);
        let path = line
            .spill
            .as_ref()
            .unwrap()
            .file
            .as_ref()
            .unwrap()
            .1
            .clone();
        // The file can be synced, but opening this path for the directory sync fails.
        line.dir = dir.join("missing");
        let Ended::Saved(note) = line.finish() else {
            panic!("the oversized line needs a note")
        };
        assert!(
            note.starts_with(&format!(
                "a line of {len} bytes that could not be saved: sync directory:"
            )),
            "{note}"
        );
        assert!(!path.exists(), "an unsynced file must not be left behind");
    }

    #[tokio::test]
    async fn a_bare_cr_at_eof_remains_part_of_the_line() {
        let (ctx, _stop, dir) = crate::jobs::tests::ctx_with("", "streams-eof-cr");
        let streams = Streams::new(
            crate::jobs::tests::jobs_of(&ctx),
            ctx.store.clone(),
            dir.to_path_buf(),
            dir.join("files"),
        );
        let spec = spec_of(&json!({
            "name": "eof",
            "argv": ["sh", "-c", "printf 'ignored\\r\\ntail\\r'"],
            "filter": "tail\\r$",
        }))
        .unwrap();
        let filter = regex::Regex::new(&spec.filter).unwrap();
        let child = command::attach(&spec.argv, Some(&dir), &[], None, 0).unwrap();
        let (_stop_tx, mut stop_rx) = watch::channel(false);
        assert_eq!(
            streams
                .watch_output(&spec, &filter, child, &mut stop_rx)
                .await
                .as_deref(),
            Some("status 0")
        );
        let events = ctx.store.read(|r| r.events_after(0, 10)).await.unwrap();
        assert_eq!(events.len(), 1, "{events:?}");
        assert!(format!("{:?}", events[0]).contains("tail"), "{events:?}");
    }

    /// WS req. 72: the file keeps the first `SPILL_MAX` bytes; the event gives the whole length.
    #[test]
    fn a_long_line_file_is_capped() {
        let dir = crate::sys::fs::tests::scratch("streams-cap");
        let mut line = Line::new(dir.to_path_buf(), "cap");
        let chunk = vec![b'x'; CHUNK];
        for _ in 0..(5 * 1024 * 1024 / CHUNK) {
            line.push(&chunk);
        }
        line.push(b"\r");
        let (note, path) = saved_path(line.finish());
        assert!(
            note.starts_with("a line of 5242880 bytes, the first 4194304 saved in "),
            "{note}"
        );
        assert_eq!(std::fs::metadata(path).unwrap().len(), 4_194_304);
    }

    /// A line cut short by a stop leaves no file behind.
    #[test]
    fn a_stopped_line_leaves_no_file() {
        let dir = crate::sys::fs::tests::scratch("streams-stop");
        let mut line = Line::new(dir.to_path_buf(), "cut");
        line.push(&vec![b'z'; LINE_MAX + 1]);
        line.discard();
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
    }

    /// WS req. 72: a line without an end goes to its file while it grows, not into memory first.
    #[tokio::test]
    async fn a_long_line_goes_to_a_file_before_it_ends() {
        let (ctx, _stop, dir) = crate::jobs::tests::ctx_with("", "streams-long-line");
        let files = dir.join("files");
        let streams = Streams::new(
            crate::jobs::tests::jobs_of(&ctx),
            ctx.store.clone(),
            dir.to_path_buf(),
            files.clone(),
        );
        crate::sys::fs::ensure_private_dir(&files.join("streams")).unwrap();
        let gate = dir.join("gate");
        assert!(
            std::process::Command::new("mkfifo")
                .arg(&gate)
                .status()
                .unwrap()
                .success()
        );
        // 200 KiB without a line end, then the line stays open until the test opens the gate.
        let spec = spec_of(&json!({
            "name": "long",
            "argv": ["sh", "-c", "head -c 204800 /dev/zero | tr '\\0' x; cat \"$0\"", gate],
        }))
        .unwrap();
        let filter = regex::Regex::new(&spec.filter).unwrap();
        let child = command::attach(&spec.argv, Some(&dir), &[], None, 0).unwrap();
        let (_stop_tx, mut stop_rx) = watch::channel(false);
        let reader = Arc::clone(&streams);
        let watching = tokio::spawn(async move {
            reader
                .watch_output(&spec, &filter, child, &mut stop_rx)
                .await
        });

        let mut polls = 0;
        let saved = loop {
            let found = std::fs::read_dir(files.join("streams"))
                .unwrap()
                .map(|e| e.unwrap().path())
                .find(|p| std::fs::metadata(p).is_ok_and(|m| m.len() > LINE_MAX as u64));
            if let Some(path) = found {
                break path;
            }
            assert!(!watching.is_finished(), "the job ended early");
            polls += 1;
            assert!(polls < 500, "no file while the line is still open");
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        let events = |ctx: &Arc<crate::jobs::Ctx>| {
            let store = ctx.store.clone();
            async move { store.read(|r| r.events_after(0, 10)).await.unwrap() }
        };
        assert!(
            events(&ctx).await.is_empty(),
            "no event before the line ends"
        );

        let opened = gate.clone();
        tokio::task::spawn_blocking(move || std::fs::write(opened, b"tail\r\n"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(watching.await.unwrap().as_deref(), Some("status 0"));
        let events = events(&ctx).await;
        assert_eq!(events.len(), 1, "{events:?}");
        let note = format!("a line of 204804 bytes, saved in {}", saved.display());
        assert!(format!("{:?}", events[0]).contains(&note), "{events:?}");
        assert_eq!(std::fs::metadata(&saved).unwrap().len(), 204_804);
    }
}
