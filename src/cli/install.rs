//! `cataly install | update | rollback | uninstall | check | version | extension | service`, and
//! `cataly status --install` (DESIGN 11; IR req. 13-35, 40). Each operation that changes the
//! program folder holds its lock, verifies before it switches, and ends in one of four outcomes with
//! its own exit status: done, held (nothing changed), switched back, needs attention.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde_json::json;

use super::args::Parsed;
use super::client::{Client, ClientError};
use super::{Failure, exit, out, owner_language};
use crate::config::{Config, Language};
use crate::proto::{Status, method};
use crate::sys::command::{KILL_GRACE, Output, Spec};
use crate::sys::install::{self as layout_ops, Layout, Staged};
use crate::sys::lock::{self, HubLock, LockOutcome};
use crate::sys::package::{Manager, Package};
use crate::sys::paths::Paths;
use crate::sys::release::{self, Version};

mod say;
use say::Say;

/// The daemon socket answer that decides "running" (IR req. 26).
const HUB_ANSWER: Duration = Duration::from_secs(1);
/// The orderly stop: asked until accepted, at most this long (IR req. 33).
const STOP_WAIT: Duration = Duration::from_mins(1);
/// After a voice call's wind-down, the hub's own end (its socket and lock go) takes at most this.
const END_MARGIN: Duration = Duration::from_secs(15);
/// The new hub must answer with its version within this time.
const START_WAIT: Duration = Duration::from_secs(30);
/// `omp --version`: 5 s (IR req. 25).
const OMP_TIMEOUT: Duration = Duration::from_secs(5);
/// Released binaries without `store_reader`, verified from their migration registries.
/// No version-range inference: an unlisted report has unknown compatibility.
const RELEASED_READERS: [(&str, i64); 7] = [
    ("0.2.0", 9),
    ("0.2.1", 9),
    ("0.2.2", 9),
    ("0.2.3", 9),
    ("0.2.4", 9),
    ("0.2.5", 9),
    ("0.2.6", 10),
];

/// The four outcomes (IR req. 34).
enum Outcome {
    Done(String),
    Held(String),
    SwitchedBack(String),
    NeedsAttention(String),
}

impl Outcome {
    /// The command's result; the outcome's prefix in the owner's language.
    fn result(self, say: Say) -> Result<(), Failure> {
        match self {
            Self::Done(m) => {
                out::line(&m);
                Ok(())
            }
            Self::Held(m) => Err(Failure::Status(exit::HELD, format!("{}: {m}", say.held()))),
            Self::SwitchedBack(m) => Err(Failure::Status(
                exit::SWITCHED_BACK,
                format!("{}: {m}", say.switched_back()),
            )),
            Self::NeedsAttention(m) => Err(Failure::Status(
                exit::NEEDS_ATTENTION,
                format!("{}: {m}", say.needs_attention()),
            )),
        }
    }
}

/// The `--help` summary of an install verb in `language`, when it has one other than the command
/// table's English.
pub(super) fn help_summary(language: Language, path: &[&str]) -> Option<&'static str> {
    Say(language).help(path)
}

/// Handles the install verbs; `None` when `p` is not one of them. `install`, `update` and
/// `rollback` speak the owner's language; the other verbs speak English.
pub(crate) fn run(p: &Parsed, paths: &Paths) -> Option<Result<(), Failure>> {
    let owner = || Say(owner_language(paths));
    let english = Say(Language::English);
    let (outcome, say) = match p.spec.path {
        ["version"] => {
            version(p.flag("--json"));
            return Some(Ok(()));
        }
        ["extension"] => {
            out::text(&crate::omp::extension::file());
            return Some(Ok(()));
        }
        ["status"] if p.flag("--install") => return Some(status(p)),
        ["check"] => return Some(block_on(check(p, paths))),
        ["install"] => {
            let say = owner();
            (block_on(install(p, paths, say)), say)
        }
        ["update"] => {
            let say = owner();
            (block_on(update(p, paths, say)), say)
        }
        ["rollback"] => {
            let say = owner();
            (block_on(rollback(p, paths, say)), say)
        }
        ["uninstall"] => (block_on(uninstall(p, paths)), english),
        ["service", verb @ ("enable" | "disable")] => {
            (block_on(service(*verb == "enable", paths)), english)
        }
        ["service", "refresh"] => (block_on(refresh_service(paths)), english),
        _ => return None,
    };
    Some(outcome.result(say))
}

pub(super) fn block_on<T>(work: impl Future<Output = T>) -> T {
    match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt.block_on(work),
        Err(e) => {
            out::error_line(&format!("cataly: no runtime: {e}"));
            std::process::exit(i32::from(exit::INTERNAL));
        }
    }
}

fn version(as_json: bool) {
    let r = release::report();
    if as_json {
        out::json(&serde_json::to_value(&r).unwrap_or_default());
    } else {
        out::line(&format!(
            "cataly {} ({}, commit {}; OMP {} or newer; bridge protocol {})",
            r.version, r.target, r.commit, r.omp_minimum, r.extension_protocol
        ));
    }
}

fn layout(p: &Parsed) -> Result<Layout, String> {
    match p.value("--prefix") {
        Some(prefix) => Layout::from_env(Some(Path::new(prefix))),
        None => Layout::of_running(),
    }
}

/// Takes the one install lock without waiting (IR req. 22).
fn take_lock(l: &Layout, say: Say) -> Result<HubLock, Outcome> {
    layout_ops::prepare_root(l).map_err(Outcome::Held)?;
    match lock::acquire(&l.lock()) {
        Ok(LockOutcome::Acquired(held)) => Ok(held),
        Ok(LockOutcome::Held { .. }) => Err(Outcome::Held(say.locked())),
        Err(e) => Err(Outcome::Held(e.to_string())),
    }
}

/// The running hub's status when one answers on its socket within 1 s.
fn hub_status(paths: &Paths) -> Option<Status> {
    let mut client = Client::connect(&paths.socket).ok()?;
    let reply = client.call(method::STATUS, json!({}), HUB_ANSWER).ok()?;
    serde_json::from_value::<Status>(reply).ok()
}

/// The running hub's version when one answers on its socket within 1 s.
fn hub_version(paths: &Paths) -> Option<String> {
    hub_status(paths).map(|s| s.version)
}

/// The sessions the new hub brought back, once they settled; at [`STOP_WAIT`], what it said last,
/// which may still be recovering.
async fn resumed(paths: &Paths) -> Option<crate::proto::Resumed> {
    let deadline = Instant::now() + STOP_WAIT;
    let mut last = None;
    loop {
        if let Some(r) = hub_status(paths).and_then(|s| s.resumed) {
            if r.settled() {
                return Some(r);
            }
            last = Some(r);
        }
        if Instant::now() >= deadline {
            return last;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// The line `cataly update` and `cataly rollback` add about the sessions the new hub brought back:
/// how the lead came back (or what holds it) and the lanes. Sessions still recovering are said so,
/// never as final; the hub posts the final result to the owner's home room.
async fn sessions_note(paths: &Paths, say: Say) -> String {
    let language = say.0;
    let korean = language == Language::Korean;
    match resumed(paths).await {
        Some(r) => {
            let settled = r.settled();
            let text = crate::jobs::update::resumed_text(language, Some(r));
            let watch = match (settled, korean) {
                (true, _) => "",
                (false, true) => " 진행 상황은 `cataly lead status`로 볼 수 있습니다.",
                (false, false) => " `cataly lead status` shows the progress.",
            };
            if text.is_empty() {
                text
            } else {
                format!("\n{text}{watch}")
            }
        }
        None if korean => format!(
            "\n새 허브의 세션은 {}초가 지나도록 아직 복구 중입니다(대화와 작업은 보존됨). \
             최종 결과는 홈 방으로 알려드리며, `cataly lead status`로 lead를 볼 수 있습니다.",
            STOP_WAIT.as_secs()
        ),
        None => format!(
            "\nthe new hub's sessions are still recovering after {} s (conversations and work are kept); \
             the final result goes to your home room, and `cataly lead status` shows the lead",
            STOP_WAIT.as_secs()
        ),
    }
}

/// The lines `cataly update` and `cataly rollback` add about each worker PC older than the new hub,
/// or of unknown version, from what that hub already knows of it; no worker is asked.
fn workers_note(paths: &Paths, say: Say) -> String {
    let Some(status) = hub_status(paths) else {
        return String::new();
    };
    status
        .workers
        .iter()
        .filter_map(|w| w.standing_note(&status.version, say.0))
        .fold(String::new(), |mut text, (_, note)| {
            text.push('\n');
            text.push_str(&note);
            text
        })
}

/// `omp --version` as `(a, b, c)`, or `None` when OMP is absent or says nothing usable.
async fn omp_version() -> Option<(u64, u64, u64)> {
    use crate::sys::command::{KILL_GRACE, Output, Spec};
    let argv = ["omp".to_string(), "--version".to_string()];
    let done = crate::sys::command::run(&Spec {
        argv: &argv,
        cwd: None,
        env: &[],
        timeout: OMP_TIMEOUT,
        kill_grace: KILL_GRACE,
        output_cap: 4096,
        output: Output::Capture,
    })
    .await
    .ok()?;
    let v = crate::omp::Version::parse_output(&String::from_utf8_lossy(&done.stdout))?;
    Some((v.0, v.1, v.2))
}

/// IR req. 25: a first install warns; an update or rollback is held while OMP is too old.
async fn omp_gate(minimum: &str, first: bool, say: Say) -> Result<(), Outcome> {
    let Some(min) = Version::parse(minimum) else {
        return Ok(());
    };
    match omp_version().await {
        None => {
            out::line(&say.warning(&say.omp_missing()));
            Ok(())
        }
        Some(found) if found < min.core => {
            let (a, b, c) = found;
            let why = say.omp_too_old(&format!("{a}.{b}.{c}"), minimum);
            if first {
                out::line(&say.warning(&why));
                Ok(())
            } else {
                Err(Outcome::Held(why))
            }
        }
        Some(_) => Ok(()),
    }
}

fn path_note(l: &Layout) {
    let dir = l.command.parent().map_or_default(Path::to_path_buf);
    let on_path =
        std::env::var_os("PATH").is_some_and(|p| std::env::split_paths(&p).any(|d| d == dir));
    if !on_path {
        out::line(&format!(
            "note: {} is not on PATH; add it in your shell profile to run `cataly` by name",
            dir.display()
        ));
    }
}

/// `cataly install --from <folder>`: a first install, a reinstall (no change) or an update from a
/// local folder of release assets (IR req. 19).
async fn install(p: &Parsed, paths: &Paths, say: Say) -> Outcome {
    if let Some(candidate) = p.value("--preflight") {
        return preflight(Path::new(candidate), paths).await;
    }
    let Some(from) = p.value("--from").map(PathBuf::from) else {
        return Outcome::Held("--from <folder of release assets> is required".into());
    };
    let l = match layout(p) {
        Ok(l) => l,
        Err(e) => return Outcome::Held(e),
    };
    // A foreign file at a link path refuses before anything, the program folder included, exists.
    if let Err(e) = layout_ops::check_links(&l) {
        return Outcome::Held(e);
    }
    let _lock = match take_lock(&l, say) {
        Ok(g) => g,
        Err(o) => return o,
    };
    if let Err(e) = layout_ops::clear_staging(&l) {
        return Outcome::Held(e);
    }
    let source = std::fs::canonicalize(&from)
        .unwrap_or(from)
        .display()
        .to_string();
    from_folder(&l, paths, Path::new(&source), &source, false, say).await
}

/// Verifies the folder, then installs, reinstalls or updates. Holds the lock.
async fn from_folder(
    l: &Layout,
    paths: &Paths,
    from: &Path,
    source: &str,
    restart: bool,
    say: Say,
) -> Outcome {
    if let Err(e) = layout_ops::check_links(l) {
        return Outcome::Held(e);
    }
    let staged = match layout_ops::stage(l, from, source).await {
        Ok(s) => s,
        Err(e) => return Outcome::Held(say.nothing_changed(&e)),
    };
    let Some(current) = l.current_version() else {
        return first_install(l, paths, staged, say).await;
    };
    let (new, old) = (
        Version::parse(&staged.record.version),
        Version::parse(&current),
    );
    match (new, old) {
        (Some(n), Some(o)) if n == o => {
            let result = layout_ops::place(l, staged).and_then(|_| layout_ops::create_links(l));
            match result {
                Ok(()) => Outcome::Done(say.already_installed(&current)),
                Err(e) => Outcome::Held(e),
            }
        }
        (Some(n), Some(o)) if n < o => {
            staged.discard();
            Outcome::Held(say.older_than_installed(&n.to_string(), &o.to_string()))
        }
        _ => switch_to(l, paths, staged, &current, restart, say).await,
    }
}

/// A first install here. State a removed install left behind is kept, so its store is checked too.
async fn first_install(l: &Layout, paths: &Paths, staged: Staged, say: Say) -> Outcome {
    let report = match release::candidate_report(&staged.binary()).await {
        Ok(report) => Some(report),
        Err(error) => match layout_ops::store_floor(&paths.db_file()) {
            Ok(None) => None,
            Ok(Some(_)) => {
                staged.discard();
                return Outcome::Held(format!(
                    "{error}; the retained store cannot be checked; nothing was installed"
                ));
            }
            Err(error) => {
                staged.discard();
                return Outcome::Held(format!("{error}; nothing was installed"));
            }
        },
    };
    if let Some(r) = &report
        && let Err(why) = store_preflight(paths, r, release::VERSION)
    {
        staged.discard();
        return Outcome::Held(why);
    }
    let minimum = report.map_or_default(|r| r.omp_minimum);
    let _ = omp_gate(&minimum, true, say).await;
    let version = staged.record.version.clone();
    let result = layout_ops::place(l, staged)
        .and_then(|_| layout_ops::switch(l, &version))
        .and_then(|()| layout_ops::settle_records(l, None).map(drop))
        .and_then(|()| layout_ops::create_links(l))
        .and_then(|()| layout_ops::retain(l));
    match result {
        Ok(()) => {
            path_note(l);
            Outcome::Done(format!(
                "cataly {version} installed in {}; nothing was started (see `cataly setup`)",
                l.root.display()
            ))
        }
        Err(e) => Outcome::NeedsAttention(format!("{e}; run `cataly status --install`")),
    }
}

/// Activates a newer staged version over `current`. A running hub is restarted on it when `restart`
/// is set, else left on `current` until it next starts.
async fn switch_to(
    l: &Layout,
    paths: &Paths,
    staged: Staged,
    current: &str,
    restart: bool,
    say: Say,
) -> Outcome {
    let report = match release::candidate_report(&staged.binary()).await {
        Ok(r) => r,
        Err(e) => {
            staged.discard();
            return Outcome::Held(e);
        }
    };
    if let Err(o) = omp_gate(&report.omp_minimum, false, say).await {
        staged.discard();
        return o;
    }
    if let Err(why) = store_preflight(paths, &report, current) {
        staged.discard();
        return Outcome::Held(why);
    }
    let answering = hub_version(paths).is_some();
    let running = answering && restart;
    let closed = if running {
        if let Err(why) = stop_hub(paths, say).await {
            staged.discard();
            return Outcome::Held(why);
        }
        Some(Instant::now())
    } else {
        None
    };
    let version = staged.record.version.clone();
    if let Err(e) = layout_ops::place(l, staged) {
        if running && start_and_wait(l, paths, current, say).await.is_err() {
            return Outcome::NeedsAttention(say.not_started_again(&e));
        }
        return Outcome::Held(e);
    }
    if let Some(closed) = closed {
        return restart_switch(l, paths, &version, current, closed, say).await;
    }
    match activate(l, &version, current) {
        Ok(()) => Outcome::Done(say.switched_files(current, &version, answering)),
        Err(e) => Outcome::NeedsAttention(say.see_status_install(&e)),
    }
}

fn activate(l: &Layout, version: &str, was: &str) -> Result<(), String> {
    layout_ops::switch(l, version)?;
    layout_ops::settle_records(l, Some(was))?;
    layout_ops::retain(l)
}

/// IR req. 33: orderly stop (refused while busy, held after 60 s), switch, start the new hub the
/// way the old one ran, and wait 30 s for it to report the new version; else switch back.
async fn restart_switch(
    l: &Layout,
    paths: &Paths,
    version: &str,
    was: &str,
    closed: Instant,
    say: Say,
) -> Outcome {
    if let Err(e) = layout_ops::switch(l, version)
        .and_then(|()| layout_ops::settle_records(l, Some(was)).map(drop))
    {
        return Outcome::NeedsAttention(say.stopped_see_status_install(&e));
    }
    match start_and_wait(l, paths, version, say).await {
        Ok(()) => {
            let _ = layout_ops::retain(l);
            let answered = closed.elapsed().as_millis();
            let sessions = sessions_note(paths, say).await;
            Outcome::Done(format!(
                "{}{sessions}{}",
                say.switched(was, version, answered),
                workers_note(paths, say)
            ))
        }
        Err(why) => {
            let _ = stop_hub(paths, say).await;
            match layout_ops::store_floor(&paths.db_file()) {
                Ok(None) => {}
                Ok(Some(floor)) if floor <= crate::store::latest_schema() => {}
                Ok(Some(floor)) => {
                    return Outcome::NeedsAttention(say.store_moved_on(&why, floor, was));
                }
                Err(error) => {
                    return Outcome::NeedsAttention(say.switch_back_refused(&why, was, &error));
                }
            }
            let back = layout_ops::switch(l, was)
                .and_then(|()| layout_ops::settle_records(l, Some(version)).map(drop));
            if let Err(e) = back {
                return Outcome::NeedsAttention(say.switch_back_failed(&why, was, &e));
            }
            match start_and_wait(l, paths, was, say).await {
                Ok(()) => Outcome::SwitchedBack(say.came_back(version, &why, was)),
                Err(e) => Outcome::NeedsAttention(say.neither_came_up(version, &why, was, &e)),
            }
        }
    }
}

/// Asks the hub to stop until it accepts, then waits for it to end. A busy session (the lead or a
/// lane working or waiting on a dialog) refuses; it is never stopped, and after 60 s the owner is
/// told, in his language, which session the switch waits for. Sessions the owner started with OMP
/// himself are not the hub's and are never asked. A hub that accepts while a voice call runs ends
/// only once the call has wound down, within the bound its answer names: that bound is waited for,
/// and the owner told so.
async fn stop_hub(paths: &Paths, say: Say) -> Result<(), String> {
    stop_hub_within(paths, STOP_WAIT, END_MARGIN, say).await
}

/// [`stop_hub`], given up after `wait`, or after the voice wind-down the accepting hub names plus
/// `margin` when that is later.
async fn stop_hub_within(
    paths: &Paths,
    wait: Duration,
    margin: Duration,
    say: Say,
) -> Result<(), String> {
    let mut deadline = Instant::now() + wait;
    let mut said = String::new();
    let mut voice = None;
    loop {
        let answer = Client::connect(&paths.socket)
            .and_then(|mut c| c.call(method::HUB_STOP, json!({}), Duration::from_secs(5)));
        match answer {
            Ok(reply) => {
                // An older hub answers `null`: no bound beyond `wait`.
                let stopping: crate::proto::Stopping =
                    serde_json::from_value(reply).unwrap_or_default();
                if let Some(seconds) = stopping.voice_wind_down_s {
                    out::line(&say.voice_winding_down(seconds));
                    deadline = deadline.max(Instant::now() + Duration::from_secs(seconds) + margin);
                    voice = Some(seconds);
                }
                break;
            }
            Err(ClientError::NoHub) => break,
            // No answer: the hub may have accepted and ended before its answer was read. Only its
            // end, seen in time, shows that it stopped.
            Err(e @ (ClientError::Closed | ClientError::Io(_))) => {
                return if ended_by(paths, deadline).await {
                    Ok(())
                } else {
                    Err(say.hub_did_not_stop(&e.to_string()))
                };
            }
            Err(ClientError::Remote(body)) => {
                let busy = body.message.trim_start_matches("busy: ").to_string();
                if Instant::now() >= deadline {
                    return Err(say.busy_held(&busy));
                }
                if busy != said {
                    out::line(&say.busy_waiting(&busy));
                    said = busy;
                }
            }
            Err(e) => return Err(say.hub_did_not_stop(&e.to_string())),
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    if ended_by(paths, deadline).await {
        return Ok(());
    }
    Err(match voice {
        Some(seconds) => say.voice_did_not_end(seconds),
        None => say.hub_did_not_end(),
    })
}

/// Waits until the hub has ended or `deadline` has passed; whether it ended.
async fn ended_by(paths: &Paths, deadline: Instant) -> bool {
    loop {
        if hub_gone(paths) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Whether the hub has ended: no process holds its lock (DESIGN 2.1), which goes only as the hub
/// exits, so a new hub can take it. Without a lock file in this command's state directory, the
/// hub's socket being gone shows it.
fn hub_gone(paths: &Paths) -> bool {
    match lock::is_held(&paths.lock_file()) {
        Ok(held) => !held,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            std::fs::symlink_metadata(&paths.socket)
                .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
        }
        Err(_) => false,
    }
}

/// The config file, when it exists and is valid.
fn loaded(paths: &Paths) -> Option<Config> {
    if !paths.config_file.exists() {
        return None;
    }
    crate::config::load(&paths.config_file).ok()
}

/// A reported capability is authoritative; otherwise only an exact known release is admitted.
fn reader(candidate: &release::Report) -> Option<i64> {
    candidate.store_reader.or_else(|| {
        RELEASED_READERS
            .iter()
            .find_map(|(version, reader)| (*version == candidate.version).then_some(*reader))
    })
}

fn reads(candidate: &release::Report, floor: i64) -> bool {
    reader(candidate).is_some_and(|reader| floor <= reader)
}

/// Refuses a switch from `current` to `candidate` when the candidate's hub could not open the store
/// and would refuse to start. Reads the store's reader floor without writing; runs before anything
/// is stopped or switched. A store that cannot be read refuses too.
fn store_preflight(
    paths: &Paths,
    candidate: &release::Report,
    current: &str,
) -> Result<(), String> {
    let floor = match layout_ops::store_floor(&paths.db_file()) {
        Ok(None) => return Ok(()),
        Ok(Some(floor)) => floor,
        Err(e) => return Err(format!("{e}; nothing was stopped or switched")),
    };
    if reads(candidate, floor) {
        return Ok(());
    }
    let copy = layout_ops::store_copies(&paths.backup_dir)
        .into_iter()
        .find(|(_, path)| {
            layout_ops::store_floor(path).is_ok_and(|f| f.is_some_and(|f| reads(candidate, f)))
        })
        .map(|(_, path)| path);
    Err(store_refusal(
        owner_language(paths),
        &Refusal {
            candidate: &candidate.version,
            reader: reader(candidate),
            floor,
            current,
            store: &paths.db_file(),
            copy: copy.as_deref(),
        },
    ))
}

/// What a store refusal names.
struct Refusal<'a> {
    candidate: &'a str,
    reader: Option<i64>,
    floor: i64,
    current: &'a str,
    store: &'a Path,
    copy: Option<&'a Path>,
}

/// Why the switch is refused and the way out, in the owner's language.
fn store_refusal(language: Language, r: &Refusal<'_>) -> String {
    let (candidate, floor, current, store) = (r.candidate, r.floor, r.current, r.store.display());
    match language {
        Language::Korean => {
            let why = r.reader.map_or_else(
                || format!("{candidate} 버전은 어떤 저장소를 읽을 수 있는지 알려주지 않습니다"),
                |reader| {
                    format!("{candidate} 버전은 스키마 {reader}까지 읽고, 이 저장소는 {floor} 이상을 요구합니다")
                },
            );
            let way = r.copy.map_or_else(
                || {
                    format!(
                        "{current} 버전을 그대로 쓰세요. 업그레이드 전 저장소 사본이 없어 되돌릴 저장소가 없습니다."
                    )
                },
                |copy| {
                    format!(
                        "{current} 버전을 그대로 쓰거나, 허브를 멈추고 업그레이드 전에 허브가 만든 저장소 사본 {}을(를) \
                         {store} 자리에 복원한 뒤 다시 시도하세요. 사본 이후의 대화는 사본에 없습니다.",
                        copy.display()
                    )
                },
            );
            format!(
                "대화 보존을 위해 저장소를 업그레이드했습니다. {candidate} 버전은 이 저장소를 읽을 수 없습니다 ({why}). \
                 아무것도 멈추거나 바꾸지 않았습니다. {way}"
            )
        }
        Language::English => {
            let why = r.reader.map_or_else(
                || format!("{candidate} does not say which store it reads"),
                |reader| format!("{candidate} reads schema {reader}; this store needs {floor}"),
            );
            let way = r.copy.map_or_else(
                || {
                    format!(
                        "Stay on {current}; there is no store copy from before the upgrade to restore."
                    )
                },
                |copy| {
                    format!(
                        "Stay on {current}, or stop the hub, restore the store copy the hub made before the \
                         upgrade, {}, in place of {store}, and try again; conversation since that copy is not in it.",
                        copy.display()
                    )
                },
            );
            format!(
                "the store was upgraded for conversation safety; version {candidate} cannot read it ({why}). \
                 Nothing was stopped or switched. {way}"
            )
        }
    }
}

/// `cataly install --preflight <binary>`: whether that binary can read the store; changes nothing.
/// `install.sh` runs it through the installed version before it replaces anything.
async fn preflight(candidate: &Path, paths: &Paths) -> Outcome {
    let report = match release::candidate_report(candidate).await {
        Ok(r) => r,
        Err(e) => return Outcome::Held(format!("{e}; nothing changed")),
    };
    match store_preflight(paths, &report, release::VERSION) {
        Ok(()) => Outcome::Done(format!("cataly {} can read the store", report.version)),
        Err(why) => Outcome::Held(why),
    }
}

/// Starts the hub through the user service Cataly created, else detached, and waits for it.
async fn start_and_wait(l: &Layout, paths: &Paths, version: &str, say: Say) -> Result<(), String> {
    if l.service_marker().exists() {
        rewrite_service(l, version).await?;
        crate::sys::service::start().await?;
    } else {
        use std::os::unix::process::CommandExt;
        std::process::Command::new(l.binary_of(version))
            .arg("hub")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .map_err(|e| say.hub_not_started(&e.to_string()))?;
    }
    let deadline = Instant::now() + START_WAIT;
    while Instant::now() < deadline {
        if hub_version(paths).as_deref() == Some(version) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Err(say.no_hub_reported(version, START_WAIT.as_secs()))
}

/// How long `version`'s binary may take to rewrite the service definition.
const REFRESH_WAIT: Duration = Duration::from_secs(60);
/// What that binary needs to find this user's files and service manager, besides the variables
/// every child gets.
const REFRESH_ENV: [&str; 6] = [
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "PI_CODING_AGENT_DIR",
];

/// Has `version`'s own binary rewrite the service definition and the manager reload it, so the
/// hub starts with the definition that version writes. A binary from before `service refresh`
/// keeps the definition as it is.
async fn rewrite_service(l: &Layout, version: &str) -> Result<(), String> {
    let binary = l.binary_of(version);
    if !release::candidate_report(&binary).await?.service_refresh {
        return Ok(());
    }
    let argv = [
        binary.display().to_string(),
        "service".into(),
        "refresh".into(),
    ];
    let values: Vec<(&str, String)> = REFRESH_ENV
        .iter()
        .filter_map(|k| std::env::var(k).ok().map(|v| (*k, v)))
        .collect();
    let env: Vec<(&str, &str)> = values.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let done = crate::sys::command::run(&Spec {
        argv: &argv,
        cwd: None,
        env: &env,
        timeout: REFRESH_WAIT,
        kill_grace: KILL_GRACE,
        output_cap: 64 * 1024,
        output: Output::Capture,
    })
    .await
    .map_err(|e| format!("the service of {version} was not rewritten: {e}"))?;
    if done.success() {
        return Ok(());
    }
    let said = String::from_utf8_lossy(&done.stderr);
    Err(format!(
        "the service of {version} was not rewritten: {}",
        said.lines().next().unwrap_or("no message")
    ))
}

/// `cataly update [--from <folder> | --tag <tag>] [--no-restart]`.
async fn update(p: &Parsed, paths: &Paths, say: Say) -> Outcome {
    let l = match layout(p) {
        Ok(l) => l,
        Err(e) => return Outcome::Held(e),
    };
    let _lock = match take_lock(&l, say) {
        Ok(g) => g,
        Err(o) => return o,
    };
    if let Some(package) = &l.package {
        return package_update(&l, package, p, paths, say).await;
    }
    let Some(current) = l.current_version() else {
        return Outcome::Held(say.not_installed());
    };
    let restart = !p.flag("--no-restart");
    if let Err(e) = layout_ops::clear_staging(&l) {
        return Outcome::Held(e);
    }
    if let Some(from) = p.value("--from") {
        let source = std::fs::canonicalize(from)
            .map_or_else(|_| from.to_string(), |p| p.display().to_string());
        return from_folder(&l, paths, Path::new(&source), &source, restart, say).await;
    }
    let release = match fetch(paths, p.value("--tag"), say).await {
        Ok(r) => r,
        Err(e) => return Outcome::Held(e),
    };
    if Version::parse(&current).is_some_and(|c| release.version <= c) {
        return Outcome::Done(say.up_to_date(&current, &release.tag));
    }
    let dir = match download(&l, &release).await {
        Ok(d) => d,
        Err(e) => return Outcome::Held(say.nothing_changed(&e)),
    };
    let source = format!(
        "https://github.com/{}/releases/tag/{}",
        release::REPOSITORY,
        release.tag
    );
    let outcome = from_folder(&l, paths, &dir, &source, restart, say).await;
    let _ = std::fs::remove_dir_all(&dir);
    outcome
}

/// `cataly update [--tag <tag>] [--no-restart]` of an npm or Bun install: the package manager
/// that installed this binary installs the release's version over it, with the same ordered stop,
/// restart and wait as a switch. When the new version cannot run here, the earlier one is
/// installed again the same way.
async fn package_update(
    l: &Layout,
    package: &Package,
    p: &Parsed,
    paths: &Paths,
    say: Say,
) -> Outcome {
    let Some(manager) = &package.manager else {
        return Outcome::Held(say.foreign_package(&package.dir.display().to_string()));
    };
    if p.value("--from").is_some() {
        return Outcome::Held(say.package_from(manager.name()));
    }
    let current = release::VERSION;
    let release = match fetch(paths, p.value("--tag"), say).await {
        Ok(r) => r,
        Err(e) => return Outcome::Held(e),
    };
    if Version::parse(current).is_some_and(|c| release.version <= c) {
        return Outcome::Done(say.up_to_date(current, &release.tag));
    }
    let version = release.version.to_string();
    let answering = hub_version(paths).is_some();
    let running = answering && !p.flag("--no-restart");
    let closed = if running {
        if let Err(why) = stop_hub(paths, say).await {
            return Outcome::Held(why);
        }
        Some(Instant::now())
    } else {
        None
    };
    out::line(&say.installing(&version, manager.name()));
    let back = Back {
        l,
        package,
        manager,
        paths,
        current,
        say,
    };
    let installed = match manager.install(&version).await {
        Ok(()) => installed_report(package, &version, say).await,
        Err(e) => Err(e),
    };
    let report = match installed {
        Ok(r) => r,
        Err(why) => return back.go(running, why).await,
    };
    if let Err(Outcome::Held(why)) = omp_gate(&report.omp_minimum, false, say).await {
        return match back.reinstall(running).await {
            Ok(()) => Outcome::Held(say.installed_again(&why, current)),
            Err(e) => Outcome::NeedsAttention(say.install_again_failed(&why, current, &e)),
        };
    }
    let Some(closed) = closed else {
        return Outcome::Done(say.switched_files(current, &version, answering));
    };
    match start_and_wait(l, paths, &version, say).await {
        Ok(()) => {
            let answered = closed.elapsed().as_millis();
            let sessions = sessions_note(paths, say).await;
            Outcome::Done(format!(
                "{}{sessions}{}",
                say.switched(current, &version, answered),
                workers_note(paths, say)
            ))
        }
        Err(why) => {
            let _ = stop_hub(paths, say).await;
            back.go(true, say.did_not_come_up(&version, &why)).await
        }
    }
}

/// The version report of the package's binary, which must be `version`.
async fn installed_report(
    package: &Package,
    version: &str,
    say: Say,
) -> Result<release::Report, String> {
    let report = release::candidate_report(&package.binary()).await?;
    if report.version == version {
        Ok(report)
    } else {
        Err(say.wrong_package_version(&report.version, version))
    }
}

/// The way back to `current` after a failed package update.
struct Back<'a> {
    l: &'a Layout,
    package: &'a Package,
    manager: &'a Manager,
    paths: &'a Paths,
    current: &'a str,
    say: Say,
}

impl Back<'_> {
    /// `current` installed again (unless it is still in place) and, when the hub ran, started
    /// again.
    async fn go(&self, running: bool, why: String) -> Outcome {
        let (say, current) = (self.say, self.current);
        let in_place = installed_report(self.package, current, say).await.is_ok();
        let back = if in_place {
            if running {
                start_and_wait(self.l, self.paths, current, say).await
            } else {
                Ok(())
            }
        } else {
            self.reinstall(running).await
        };
        match back {
            Ok(()) if in_place && running => Outcome::Held(say.runs_again(&why, current)),
            Ok(()) if in_place => Outcome::Held(say.nothing_changed(&why)),
            Ok(()) if running => Outcome::SwitchedBack(say.runs_again(&why, current)),
            Ok(()) => Outcome::SwitchedBack(say.installed_again(&why, current)),
            Err(e) => Outcome::NeedsAttention(say.did_not_come_back(
                &why,
                current,
                &e,
                &self.manager.install_hint(current),
            )),
        }
    }

    /// Installs `current` again through the package manager and, when `start`, starts its hub.
    async fn reinstall(&self, start: bool) -> Result<(), String> {
        self.manager.install(self.current).await?;
        installed_report(self.package, self.current, self.say).await?;
        if start {
            start_and_wait(self.l, self.paths, self.current, self.say).await?;
        }
        Ok(())
    }
}

/// `cataly uninstall` of an npm or Bun install, after the service went: the extension link goes;
/// the package manager removes the files it installed.
fn package_uninstall(package: &Package) -> Outcome {
    if let Err(e) = package.unlink_extension() {
        return Outcome::NeedsAttention(e);
    }
    let then = package.manager.as_ref().map_or_else(
        || {
            format!(
                "remove {} with the package manager that installed it",
                package.dir.display()
            )
        },
        |m| format!("run `{}` to remove the program", m.remove_hint()),
    );
    Outcome::Done(format!(
        "removed the extension link; config and state are kept; {then}"
    ))
}

/// Release metadata through the config's API base (a loopback fake in tests).
async fn fetch(paths: &Paths, tag: Option<&str>, say: Say) -> Result<release::Release, String> {
    let settings = loaded(paths).map_or_default(|c| c.update);
    match release::fetch_release(&settings.api()?, tag).await? {
        Some(r) if r.version.stable() || tag.is_some() => Ok(r),
        _ => Err(say.no_stable_release()),
    }
}

/// Downloads the four assets this host needs into a fresh staging folder.
async fn download(l: &Layout, r: &release::Release) -> Result<PathBuf, String> {
    let dir = layout_ops::fresh_staging(l, "download")?;
    let v = r.version.to_string();
    for (name, cap) in [
        (release::SUMS.to_string(), release::SUMS_MAX),
        (release::SIGNATURE.to_string(), release::SIGNATURE_MAX),
        (release::binary_asset(&v), release::BINARY_MAX),
        (release::extension_asset(&v), release::EXTENSION_MAX),
    ] {
        let url = r.asset(&name)?;
        release::download(url, cap, &dir.join(&name)).await?;
    }
    Ok(dir)
}

/// `cataly rollback [--expect <version>] [--no-restart]` (IR req. 30).
async fn rollback(p: &Parsed, paths: &Paths, say: Say) -> Outcome {
    let l = match layout(p) {
        Ok(l) => l,
        Err(e) => return Outcome::Held(e),
    };
    let _lock = match take_lock(&l, say) {
        Ok(g) => g,
        Err(o) => return o,
    };
    if let Some(manager) = l.package.as_ref().and_then(|p| p.manager.as_ref()) {
        return Outcome::Held(
            say.package_keeps_no_previous(manager.name(), &manager.install_hint("<version>")),
        );
    }
    let (Some(current), Some(previous)) = (l.current_version(), layout_ops::role(&l, "previous"))
    else {
        return Outcome::Held(say.no_previous());
    };
    if let Some(expect) = p.value("--expect")
        && expect.trim_start_matches('v') != previous.version
    {
        return Outcome::Held(say.previous_is(&previous.version, expect));
    }
    if let Err(e) = layout_ops::verify_files(&l, &previous) {
        return Outcome::Held(say.nothing_changed(&e));
    }
    let binary = l.version_dir(&previous.version).join(layout_ops::BINARY);
    let report = match release::candidate_report(&binary).await {
        Ok(r) => r,
        Err(e) => return Outcome::Held(e),
    };
    if let Err(o) = omp_gate(&report.omp_minimum, false, say).await {
        return o;
    }
    if let Err(why) = store_preflight(paths, &report, &current) {
        return Outcome::Held(why);
    }
    let answering = hub_version(paths).is_some();
    let running = answering && !p.flag("--no-restart");
    if running && let Err(why) = stop_hub(paths, say).await {
        return Outcome::Held(why);
    }
    // Only now is the restart known not to be held: the version rolled back from is never
    // announced again (IR req. 37).
    if let Err(e) = crate::sys::fs::write_atomic(&l.silenced(), current.as_bytes()) {
        if running && start_and_wait(&l, paths, &current, say).await.is_err() {
            return Outcome::NeedsAttention(say.not_started_again(&e.to_string()));
        }
        return Outcome::Held(e.to_string());
    }
    if running {
        return restart_switch(&l, paths, &previous.version, &current, Instant::now(), say).await;
    }
    match layout_ops::switch(&l, &previous.version)
        .and_then(|()| layout_ops::settle_records(&l, Some(&current)).map(drop))
    {
        Ok(()) => Outcome::Done(say.rolled_back_files(&current, &previous.version, answering)),
        Err(e) => Outcome::NeedsAttention(say.see_status_install(&e)),
    }
}

/// `cataly uninstall` (IR req. 35).
async fn uninstall(p: &Parsed, paths: &Paths) -> Outcome {
    let l = match layout(p) {
        Ok(l) => l,
        Err(e) => return Outcome::Held(e),
    };
    let lock = match take_lock(&l, Say(Language::English)) {
        Ok(g) => g,
        Err(o) => return o,
    };
    if hub_version(paths).is_some() {
        return Outcome::Held("the hub is running; stop it first".into());
    }
    if let Err(e) = crate::sys::service::disable(&l).await {
        return Outcome::Held(e);
    }
    if let Some(package) = &l.package {
        return package_uninstall(package);
    }
    drop(lock);
    match layout_ops::remove_all(&l) {
        Ok(()) => Outcome::Done(format!(
            "removed {}, the command link and the extension link; config and state are kept",
            l.root.display()
        )),
        Err(e) => Outcome::NeedsAttention(e),
    }
}

/// `cataly service enable|disable` (IR req. 40).
async fn service(enable: bool, paths: &Paths) -> Outcome {
    let l = match Layout::of_running() {
        Ok(l) => l,
        Err(e) => return Outcome::Held(e),
    };
    if !enable {
        return match crate::sys::service::disable(&l).await {
            Ok(Some(path)) => {
                Outcome::Done(format!("service stopped and {} removed", path.display()))
            }
            Ok(None) => Outcome::Done("no service created by Cataly; nothing changed".into()),
            Err(e) => Outcome::Held(e),
        };
    }
    if !l.installed() {
        return Outcome::Held(
            "install Cataly first; the service runs the installed command".into(),
        );
    }
    let config = match crate::config::load(&paths.config_file) {
        Ok(c) => c,
        Err(e) => {
            return Outcome::Held(format!(
                "{} is not a valid config ({}); fix it first",
                paths.config_file.display(),
                crate::config::describe(&e)
            ));
        }
    };
    // The service's PATH is not the shell's: a bare name would not be found there.
    let mut notes = Vec::new();
    if let Some(omp) = crate::omp::resolve(&config.omp.path)
        && !Path::new(&config.omp.path).is_absolute()
    {
        let value = omp.display().to_string();
        let rendered = crate::config::file::toml_string(&value);
        if let Err(e) = super::setup::write_one(paths, "omp", "path", &rendered) {
            return Outcome::Held(e);
        }
        notes.push(format!("[omp] path set to {value}"));
    }
    if !config.setup.service {
        match super::setup::write_one(paths, "setup", "service", "true") {
            Ok(()) => notes.push("[setup] service set to true".into()),
            Err(e) => return Outcome::Held(e),
        }
    }
    match enable_service(&l, paths, &config).await {
        Ok((file, more)) => {
            notes.extend(more);
            Outcome::Done(format!(
                "service written to {} and started\n  {}",
                file.display(),
                notes.join("\n  ")
            ))
        }
        Err(e) => Outcome::Held(e),
    }
}

/// `cataly service refresh`: rewrites the service Cataly created with this version's definition
/// and has the manager read it again, without starting it.
async fn refresh_service(paths: &Paths) -> Outcome {
    let l = match Layout::of_running() {
        Ok(l) => l,
        Err(e) => return Outcome::Held(e),
    };
    if !l.service_marker().exists() {
        return Outcome::Done("no service created by Cataly; nothing changed".into());
    }
    let config = match crate::config::load(&paths.config_file) {
        Ok(c) => c,
        Err(e) => {
            return Outcome::Held(format!(
                "{} is not a valid config ({})",
                paths.config_file.display(),
                crate::config::describe(&e)
            ));
        }
    };
    let done = match service_inputs(paths, &config) {
        Ok((path_line, env_path, _)) => {
            let unit = crate::sys::service::Unit {
                command: &l.service_command(),
                path: &path_line,
                env_file: &env_path,
            };
            crate::sys::service::refresh(&l, &unit).await
        }
        Err(e) => Err(e),
    };
    match done {
        Ok(Some(file)) => Outcome::Done(format!("service rewritten at {}", file.display())),
        Ok(None) => Outcome::Done("no service created by Cataly; nothing changed".into()),
        Err(e) => Outcome::Held(e),
    }
}

/// What the service definition carries for `config`: its PATH (the folders of the tools the hub
/// runs, as found now) and the provider-key file, made if absent.
fn service_inputs(
    paths: &Paths,
    config: &crate::config::Config,
) -> Result<(String, PathBuf, crate::sys::service::EnvFile), String> {
    if crate::omp::resolve(&config.omp.path).is_none() {
        return Err(format!(
            "OMP ('{}') is not an executable file or on PATH; install it or set [omp] path",
            config.omp.path
        ));
    }
    let tools = [
        config.omp.path.as_str(),
        "bun",
        "gh",
        "git",
        &config.sessions.tern,
    ];
    let found: Vec<PathBuf> = tools
        .iter()
        .filter_map(|t| crate::omp::resolve(t))
        .filter_map(|p| p.parent().map(Path::to_path_buf))
        .collect();
    let path_line = crate::sys::service::path_line(found.iter().map(PathBuf::as_path));
    let env_path = service_env_file(paths);
    let keys = crate::sys::service::env_file(&env_path, &config.sessions.credentials, |k| {
        std::env::var(k).ok()
    })?;
    Ok((path_line, env_path, keys))
}

/// Writes and starts the user service that runs the installed hub (the caller checked it is
/// installed) with `config`. Returns the service file and notes on its PATH and provider keys.
pub(super) async fn enable_service(
    l: &Layout,
    paths: &Paths,
    config: &crate::config::Config,
) -> Result<(PathBuf, Vec<String>), String> {
    let (path_line, env_path, keys) = service_inputs(paths, config)?;
    let unit = crate::sys::service::Unit {
        command: &l.service_command(),
        path: &path_line,
        env_file: &env_path,
    };
    let file = crate::sys::service::enable(l, &unit).await?;
    let mut notes = vec![format!("PATH={path_line}")];
    let verb = if keys.created {
        "written to"
    } else {
        "read from"
    };
    notes.push(format!("provider keys {verb} {}", env_path.display()));
    if !keys.missing.is_empty() {
        notes.push(format!(
            "{} not set there: add NAME=value lines, then restart the service",
            keys.missing.join(", ")
        ));
    }
    Ok((file, notes))
}

/// The owner-only environment file the service reads its provider keys from.
fn service_env_file(paths: &Paths) -> PathBuf {
    paths
        .config_file
        .parent()
        .unwrap_or(Path::new("/"))
        .join("secrets")
        .join("service.env")
}

/// `cataly check [--tag <tag>]` (IR req. 18, 32): changes nothing.
async fn check(p: &Parsed, paths: &Paths) -> Result<(), Failure> {
    let installed = Layout::of_running()
        .ok()
        .and_then(|l| l.current_version())
        .unwrap_or_else(|| release::VERSION.to_string());
    let r = fetch(paths, p.value("--tag"), Say(Language::English))
        .await
        .map_err(Failure::Refused)?;
    let mine = Version::parse(&installed)
        .ok_or(Failure::Refused("unreadable installed version".into()))?;
    let verdict = match r.version.cmp(&mine) {
        std::cmp::Ordering::Greater => "newer",
        std::cmp::Ordering::Equal => "same",
        std::cmp::Ordering::Less => "older",
    };
    if p.flag("--json") {
        out::json(
            &json!({ "installed": installed, "release": r.version.to_string(), "verdict": verdict }),
        );
    } else {
        out::line(&format!(
            "installed {installed}; release {}: {verdict}",
            r.version
        ));
        if verdict == "newer" {
            out::line("install it with `cataly update`");
        }
    }
    Ok(())
}

/// `cataly status --install` (IR req. 31): repairs records only; reports the rest with a command.
fn status(p: &Parsed) -> Result<(), Failure> {
    let l = layout(p).map_err(Failure::Refused)?;
    let locked = lock::acquire(&l.lock());
    let (repaired, problems) = match locked {
        Ok(LockOutcome::Acquired(_guard)) => layout_ops::inspect(&l),
        _ => {
            return Err(Failure::Status(
                exit::HELD,
                "held: another install operation is running".into(),
            ));
        }
    };
    let current = layout_ops::role(&l, "current");
    let previous = layout_ops::role(&l, "previous");
    if p.flag("--json") {
        out::json(&json!({
            "root": l.root.display().to_string(),
            "current": current,
            "previous": previous,
            "repaired": repaired,
            "problems": problems,
        }));
    } else {
        out::line(&format!("program folder {}", l.root.display()));
        for (name, r) in [("current", &current), ("previous", &previous)] {
            match r {
                Some(r) => out::line(&format!(
                    "{name:<9}{} (commit {}, from {}, installed {})",
                    r.version,
                    r.commit,
                    r.source,
                    crate::jobs::instant_text(r.installed_ms)
                )),
                None => out::line(&format!("{name:<9}none")),
            }
        }
        for r in &repaired {
            out::line(&format!("repaired record: {r}"));
        }
        for pr in &problems {
            out::line(&format!(
                "problem: {}: {}; repair: {}",
                pr.path, pr.what, pr.repair
            ));
        }
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(Failure::Status(
            exit::NEEDS_ATTENTION,
            format!("{} problem(s) found", problems.len()),
        ))
    }
}

#[cfg(test)]
mod tests {
    use std::io::BufRead as _;
    use std::os::unix::net::UnixListener;

    use super::*;
    use crate::sys::fs::tests::scratch;

    /// A layout under `dir`, its state folder made and its socket in `dir`.
    fn paths_in(dir: &Path) -> Paths {
        let dir = dir.to_path_buf();
        let paths = Paths::resolve(
            |key| match key {
                "HOME" => Some(dir.clone().into_os_string()),
                "CATALY_SOCKET" => Some(dir.join("hub.sock").into_os_string()),
                _ => None,
            },
            crate::sys::own_uid(),
        )
        .unwrap();
        crate::sys::fs::ensure_private_dir(&paths.state_dir).unwrap();
        paths
    }

    /// Binds the socket and takes the lock, as a hub does.
    fn fake_hub(paths: &Paths) -> (UnixListener, HubLock) {
        let listener = UnixListener::bind(&paths.socket).unwrap();
        match lock::acquire(&paths.lock_file()).unwrap() {
            LockOutcome::Acquired(held) => (listener, held),
            LockOutcome::Held { .. } => panic!("the lock is taken"),
        }
    }

    /// Reads one request and closes its connection unanswered, as a hub that ended before its
    /// answer was written; returns the request.
    fn close_unanswered(listener: &UnixListener) -> String {
        let (stream, _) = listener.accept().unwrap();
        let mut request = String::new();
        std::io::BufReader::new(&stream)
            .read_line(&mut request)
            .unwrap();
        request
    }

    /// 0.2.2's race: the hub accepted the stop and ended before its answer was written. Here the
    /// connection closes unanswered and the hub goes away 200 ms later: the stop counts.
    #[tokio::test]
    async fn a_stop_closed_unanswered_counts_once_the_hub_has_ended() {
        let dir = scratch("stop");
        let paths = paths_in(&dir);
        let (listener, held) = fake_hub(&paths);
        let socket = paths.socket.clone();
        let hub = std::thread::spawn(move || {
            let request = close_unanswered(&listener);
            std::thread::sleep(Duration::from_millis(200));
            std::fs::remove_file(&socket).unwrap();
            drop(held);
            request
        });
        stop_hub_within(
            &paths,
            Duration::from_secs(10),
            END_MARGIN,
            Say(Language::English),
        )
        .await
        .unwrap();
        assert!(hub.join().unwrap().contains(method::HUB_STOP));
    }

    /// A connection closed unanswered by a hub that stays is never taken for a stop.
    #[tokio::test]
    async fn a_stop_closed_unanswered_is_held_while_the_hub_stays() {
        let dir = scratch("stop");
        let paths = paths_in(&dir);
        let (listener, _held) = fake_hub(&paths);
        let hub = std::thread::spawn(move || close_unanswered(&listener));
        let started = Instant::now();
        let english = Say(Language::English);
        let held = stop_hub_within(&paths, Duration::from_millis(500), END_MARGIN, english)
            .await
            .unwrap_err();
        assert!(started.elapsed() >= Duration::from_millis(500));
        assert_eq!(
            held,
            "the hub did not stop: control socket: the hub closed the connection; nothing changed"
        );
        assert!(hub.join().unwrap().contains(method::HUB_STOP));
    }

    /// Accepts the stop as a hub does while a voice call runs: its answer names the call's
    /// wind-down bound. Returns the request.
    fn accept_with_voice(listener: &UnixListener, seconds: u64) -> String {
        use std::io::Write as _;
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = String::new();
        std::io::BufReader::new(&stream)
            .read_line(&mut request)
            .unwrap();
        let reply = json!({
            "v": crate::proto::VERSION,
            "id": 1,
            "ok": crate::proto::Stopping { voice_wind_down_s: Some(seconds) },
        });
        writeln!(stream, "{reply}").unwrap();
        request
    }

    /// A hub stopped during a voice call ends only once the call has wound down. The update waits
    /// for the bound the hub named, not its own shorter wait: an end 1.2 s after the stop, within
    /// a 1 s wind-down and its margin, completes the stop.
    #[tokio::test]
    async fn a_voice_wind_down_within_its_bound_completes_the_stop() {
        let dir = scratch("stop-voice");
        let paths = paths_in(&dir);
        let (listener, held) = fake_hub(&paths);
        let socket = paths.socket.clone();
        let hub = std::thread::spawn(move || {
            let request = accept_with_voice(&listener, 1);
            std::thread::sleep(Duration::from_millis(1200));
            std::fs::remove_file(&socket).unwrap();
            drop(held);
            request
        });
        let wait = Duration::from_millis(100);
        stop_hub_within(&paths, wait, Duration::from_secs(1), Say(Language::Korean))
            .await
            .unwrap();
        assert!(hub.join().unwrap().contains(method::HUB_STOP));
    }

    /// A wind-down beyond the hub's bound holds the update with nothing changed, saying why.
    #[tokio::test]
    async fn a_voice_wind_down_beyond_its_bound_holds_the_update() {
        let dir = scratch("stop-voice");
        let paths = paths_in(&dir);
        let (listener, _held) = fake_hub(&paths);
        let hub = std::thread::spawn(move || accept_with_voice(&listener, 1));
        let started = Instant::now();
        let margin = Duration::from_millis(300);
        let held = stop_hub_within(
            &paths,
            Duration::from_millis(100),
            margin,
            Say(Language::Korean),
        )
        .await
        .unwrap_err();
        assert!(started.elapsed() >= Duration::from_millis(1300));
        assert_eq!(
            held,
            "허브가 멈추기로 했지만 음성 통화 정리 시간(1초)이 지나도 끝나지 않았습니다. 아무것도 \
             바뀌지 않았습니다. 허브가 멈춘 뒤 다시 실행하세요."
        );
        assert!(hub.join().unwrap().contains(method::HUB_STOP));
        let english = Say(Language::English);
        assert_eq!(
            english.voice_did_not_end(90),
            "the hub accepted the stop but had not ended after its voice call's 90 s wind-down; \
             nothing changed. Run it again once the hub has stopped."
        );
        assert_eq!(
            Say(Language::Korean).voice_winding_down(90),
            "음성 통화를 정리하는 중이에요 (최대 90초)"
        );
        assert_eq!(
            english.voice_winding_down(90),
            "winding down the voice call (up to 90 s)"
        );
    }

    /// A candidate's report: version 0.2.5, reading up to `reader` (none: a report from before the
    /// capability).
    fn candidate(reader: Option<i64>) -> release::Report {
        release::Report {
            version: "0.2.5".into(),
            store_reader: reader,
            ..release::report()
        }
    }

    /// A store migrated as the hub migrates it, then its reader floor set to `floor` as a later
    /// non-additive schema would set it.
    fn store_at(paths: &Paths, floor: i64) {
        let (store, writer) =
            crate::store::Store::open(&paths.db_file(), &paths.backup_dir).unwrap();
        drop(store);
        writer.join().unwrap().unwrap();
        raise_floor(&paths.db_file(), floor);
    }

    fn raise_floor(db: &Path, floor: i64) {
        rusqlite::Connection::open(db)
            .unwrap()
            .execute(
                "UPDATE meta SET value = ?1 WHERE key = 'min_reader'",
                [floor.to_string()],
            )
            .unwrap();
    }

    #[test]
    fn a_candidate_that_reads_the_store_passes() {
        let dir = scratch("preflight");
        let paths = paths_in(&dir);
        // No store yet: nothing to protect, and none is made.
        store_preflight(&paths, &candidate(None), "0.2.7").unwrap();
        assert!(!paths.db_file().exists());
        store_at(&paths, 1);
        let before = std::fs::read(paths.db_file()).unwrap();
        store_preflight(&paths, &candidate(None), "0.2.7").unwrap();
        store_preflight(&paths, &candidate(Some(9)), "0.2.7").unwrap();
        assert_eq!(
            std::fs::read(paths.db_file()).unwrap(),
            before,
            "the check changes nothing"
        );
        raise_floor(&paths.db_file(), 11);
        store_preflight(&paths, &candidate(Some(11)), "0.2.7").unwrap();
    }

    #[test]
    fn a_candidate_too_old_for_the_store_floor_is_refused() {
        let dir = scratch("preflight");
        let paths = paths_in(&dir);
        store_at(&paths, 99);
        let held = store_preflight(&paths, &candidate(Some(9)), "0.2.7").unwrap_err();
        assert!(
            held.contains("version 0.2.5 cannot read it")
                || held.contains("0.2.5 버전은 이 저장소를 읽을 수 없습니다"),
            "{held}"
        );
        let english = store_refusal(
            Language::English,
            &Refusal {
                candidate: "0.2.5",
                reader: Some(9),
                floor: 99,
                current: "0.2.7",
                store: &paths.db_file(),
                copy: None,
            },
        );
        assert_eq!(
            english,
            "the store was upgraded for conversation safety; version 0.2.5 cannot read it (0.2.5 \
             reads schema 9; this store needs 99). Nothing was stopped or switched. Stay on 0.2.7; \
             there is no store copy from before the upgrade to restore."
        );
    }

    #[test]
    fn a_known_capability_less_release_is_refused_above_its_released_schema() {
        let dir = scratch("preflight");
        let paths = paths_in(&dir);
        store_at(&paths, 9);
        store_preflight(&paths, &candidate(None), "0.2.7").unwrap();
        // The copy the hub made before a migration, readable by a capability-less release.
        crate::sys::fs::ensure_private_dir(&paths.backup_dir).unwrap();
        let copy = paths.backup_dir.join("cataly-v10.db");
        rusqlite::Connection::open(paths.db_file())
            .unwrap()
            .execute("VACUUM INTO ?1", [copy.to_str().unwrap()])
            .unwrap();
        raise_floor(&paths.db_file(), 11);
        let held = store_preflight(&paths, &candidate(None), "0.2.7").unwrap_err();
        assert!(held.contains(&copy.display().to_string()), "{held}");
        let refusal = |language| {
            store_refusal(
                language,
                &Refusal {
                    candidate: "0.2.5",
                    reader: None,
                    floor: 11,
                    current: "0.2.7",
                    store: &paths.db_file(),
                    copy: Some(&copy),
                },
            )
        };
        let korean = refusal(Language::Korean);
        assert!(
            korean.starts_with(
                "대화 보존을 위해 저장소를 업그레이드했습니다. 0.2.5 버전은 이 저장소를 읽을 수 \
                 없습니다 (0.2.5 버전은 어떤 저장소를 읽을 수 있는지 알려주지 않습니다). 아무것도 \
                 멈추거나 바꾸지 않았습니다. 0.2.7 버전을 그대로 쓰거나,"
            ),
            "{korean}"
        );
        let english = refusal(Language::English);
        assert!(
            english.contains("0.2.5 does not say which store it reads")
                && english.contains(&format!("{}, in place of", copy.display())),
            "{english}"
        );
        // A copy the candidate cannot read either is never offered.
        raise_floor(&copy, 50);
        raise_floor(&paths.db_file(), 40);
        let held = store_preflight(&paths, &candidate(None), "0.2.7").unwrap_err();
        assert!(!held.contains("cataly-v10.db"), "{held}");
    }

    #[tokio::test]
    async fn first_install_protects_retained_state_without_blocking_an_empty_home() {
        use std::os::unix::fs::PermissionsExt as _;

        let mut report = candidate(None);
        report.omp_minimum.clear();
        for retained in [true, false] {
            for text in ["unreadable".into(), serde_json::to_string(&report).unwrap()] {
                let dir = scratch("first-install-floor");
                let paths = paths_in(&dir);
                if retained {
                    store_at(&paths, 11);
                }
                let layout = Layout {
                    root: dir.join("program"),
                    command: dir.join("bin/cataly"),
                    extension: dir.join("extensions/cataly.ts"),
                    package: None,
                };
                layout_ops::prepare_root(&layout).unwrap();
                let staging = layout_ops::fresh_staging(&layout, "test").unwrap();
                let binary = format!("#!/bin/sh\nprintf '%s\\n' '{text}'\n");
                std::fs::write(staging.join("cataly"), &binary).unwrap();
                std::fs::set_permissions(
                    staging.join("cataly"),
                    std::fs::Permissions::from_mode(0o500),
                )
                .unwrap();
                std::fs::write(staging.join("cataly.ts"), "bridge").unwrap();
                let staged = Staged {
                    dir: staging,
                    record: layout_ops::Record {
                        version: report.version.clone(),
                        commit: report.commit.clone(),
                        target: report.target.clone(),
                        binary_sha256: release::sha256(binary.as_bytes()),
                        extension_sha256: release::sha256(b"bridge"),
                        source: "test".into(),
                        installed_ms: 0,
                        role: "kept".into(),
                    },
                };
                let before = std::fs::read(paths.db_file()).ok();
                let outcome = first_install(&layout, &paths, staged, Say(Language::English)).await;
                if retained {
                    let Outcome::Held(reason) = outcome else {
                        panic!("unverified candidate installed over retained state: {text}");
                    };
                    assert!(
                        reason.contains("unreadable")
                            || reason.contains("cannot read")
                            || reason.contains("읽을 수"),
                        "{reason}"
                    );
                    assert!(!layout.version_dir(&report.version).exists());
                    assert_eq!(layout.current_version(), None);
                } else {
                    let Outcome::Done(_) = outcome else {
                        panic!("an empty home has no store compatibility constraint");
                    };
                    assert_eq!(layout.current_version(), Some(report.version.clone()));
                }
                assert_eq!(std::fs::read(paths.db_file()).ok(), before);
            }
        }
    }

    #[test]
    fn released_reader_versions_are_known_but_unknown_versions_fail_closed() {
        let dir = scratch("released-readers");
        let paths = paths_in(&dir);
        store_at(&paths, 10);
        let mut old = candidate(None);
        old.version = "0.2.6".into();
        store_preflight(&paths, &old, "0.2.7").unwrap();
        old.version = "0.2.5".into();
        assert!(store_preflight(&paths, &old, "0.2.7").is_err());
        raise_floor(&paths.db_file(), 1);
        old.version = "0.1.99".into();
        assert!(store_preflight(&paths, &old, "0.2.7").is_err());
    }

    #[tokio::test]
    async fn failed_start_never_switches_back_across_a_migrated_store_floor() {
        let dir = scratch("switch-back-floor");
        let paths = paths_in(&dir);
        store_at(&paths, crate::store::latest_schema() + 1);
        let layout = Layout {
            root: dir.join("program"),
            command: dir.join("bin/cataly"),
            extension: dir.join("extensions/cataly.ts"),
            package: None,
        };
        layout_ops::prepare_root(&layout).unwrap();
        // Missing binaries reproduce the two start errors without running another hub.
        let english = Say(Language::English);
        let outcome = restart_switch(&layout, &paths, "new", "old", Instant::now(), english).await;
        let Outcome::NeedsAttention(reason) = outcome else {
            panic!("an incompatible automatic rollback must need owner attention");
        };
        assert_eq!(layout.current_version().as_deref(), Some("new"), "{reason}");
        assert!(
            reason.contains("store") && reason.contains("old"),
            "{reason}"
        );
    }

    /// The main outcomes of `cataly update` and `cataly rollback`, in both of the owner's
    /// languages: switched, already current, busy then held, switched back, and each outcome's
    /// prefix. The store refusal is pinned above.
    #[test]
    fn update_texts_follow_the_owner_language() {
        let (ko, en) = (Say(Language::Korean), Say(Language::English));
        assert_eq!(
            ko.switched("0.2.7", "0.2.8", 441),
            "cataly 0.2.7 -> 0.2.8 전환을 마쳤습니다. 새 허브가 이전 허브가 닫힌 뒤 441ms 만에 \
             응답했습니다."
        );
        assert_eq!(
            en.switched("0.2.7", "0.2.8", 441),
            "cataly 0.2.7 -> 0.2.8; the new hub answered 441 ms after the old one closed"
        );
        assert_eq!(
            ko.up_to_date("0.2.8", "v0.2.8"),
            "cataly 0.2.8 버전이 최신입니다 (최신 릴리스 v0.2.8)."
        );
        assert_eq!(
            en.up_to_date("0.2.8", "v0.2.8"),
            "cataly 0.2.8 is up to date (v0.2.8 is the release)"
        );
        assert_eq!(
            ko.already_installed("0.2.8"),
            "cataly 0.2.8 버전이 이미 설치되어 있습니다. 아무것도 바뀌지 않았습니다."
        );
        assert_eq!(
            en.already_installed("0.2.8"),
            "cataly 0.2.8 is already installed; nothing changed"
        );
        let busy = "리드가 작업 중";
        assert_eq!(
            ko.busy_waiting(busy),
            "작업 중인 세션을 기다리는 중입니다 (리드가 작업 중). 최대 60초 기다립니다."
        );
        assert!(ko.busy_held(busy).ends_with("아무것도 바뀌지 않았습니다."));
        assert_eq!(
            en.busy_waiting("the lead is working"),
            "waiting for a busy session (the lead is working), up to 60 s"
        );
        assert!(
            en.busy_held("the lead is working")
                .starts_with("the update is waiting for a busy session (the lead is working)")
        );
        assert_eq!(
            ko.came_back("0.2.8", "no answer", "0.2.7"),
            "0.2.8 버전이 올라오지 않아 (no answer) 0.2.7 버전으로 되돌렸습니다. 0.2.7 버전이 \
             다시 실행 중입니다."
        );
        assert_eq!(
            en.came_back("0.2.8", "no answer", "0.2.7"),
            "0.2.8 did not come up (no answer); 0.2.7 runs again"
        );
        for (say, held, back, attention) in [
            (ko, "보류: x", "되돌림: x", "확인 필요: x"),
            (en, "held: x", "switched back: x", "needs attention: x"),
        ] {
            let said = |o: Outcome| match o.result(say) {
                Err(Failure::Status(_, m)) => m,
                _ => panic!("a failure status expected"),
            };
            assert_eq!(said(Outcome::Held("x".into())), held);
            assert_eq!(said(Outcome::SwitchedBack("x".into())), back);
            assert_eq!(said(Outcome::NeedsAttention("x".into())), attention);
        }
    }

    /// `--help` of `update` and `rollback` in both languages; other commands keep the table's
    /// English in both.
    #[test]
    fn update_and_rollback_help_follows_the_owner_language() {
        let spec = |path: &[&str]| {
            super::super::args::COMMANDS
                .iter()
                .find(|c| c.path == path)
                .unwrap()
        };
        let help = |path: &[&str], language| super::super::help(Some(spec(path)), language);
        assert!(
            help(&["update"], Language::Korean).starts_with(
                "cataly update [--from <value>] [--tag <value>] [--prefix <value>] \
                 [--no-restart]\n  최신 안정 릴리스"
            ),
            "{}",
            help(&["update"], Language::Korean)
        );
        assert!(
            help(&["rollback"], Language::Korean)
                .contains("\n  이전 버전으로 되돌리고(--expect <버전>으로 어느 버전인지 확인)")
        );
        for path in [&["update"][..], &["rollback"]] {
            assert_eq!(
                help(path, Language::English),
                super::super::args::usage(Some(spec(path)))
            );
        }
        assert!(help(&["update"], Language::English).contains("\n  install the latest stable"));
        assert_eq!(
            help(&["check"], Language::Korean),
            super::super::args::usage(Some(spec(&["check"])))
        );
    }
}
