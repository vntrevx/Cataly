//! OMP session-file reader (DESIGN 3.3, 7.1; PATCH-01 rules 8-10, HOST req. 9-10): whether a saved
//! session file may be resumed exactly and which model OMP will restore from it, and the search for
//! a delivery marker in a user entry. Session files belong to OMP; the hub only reads them, with
//! no symlink followed, no FIFO opened, a 64 KiB header (1 MiB for a reopen check), and 2 s for a
//! reply read from retained request/search offsets or the last 8 MiB. Missing tags resume beyond
//! searched prefixes; a spent head-search budget leaves complete tail results usable. Marker searches
//! read the whole file within 10 s. Nothing over 64 MiB is read. Every read here blocks; callers use
//! the async wrappers, which run on the blocking pool.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs::{self, File};
use std::io::{BufRead as _, BufReader, Read as _, Seek as _, SeekFrom};
use std::os::unix::fs::MetadataExt as _;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde_json::Value;

/// Header search window for a delivery check.
const HEADER_BYTES: u64 = 64 * 1024;
/// Header search window when a transcript is reopened.
const REOPEN_HEADER_BYTES: u64 = 1024 * 1024;
/// Largest session file read at all.
const FILE_LIMIT: u64 = 64 * 1024 * 1024;
/// The initial reply-search window and the longest entry a reply or marker search parses.
const SEARCH_TAIL: u64 = 8 * 1024 * 1024;
/// The total reply-read budget, including a search outside the tail.
const SEARCH_BUDGET: Duration = Duration::from_secs(2);
/// A marker search reads the whole file within this time, or proves nothing.
pub(crate) const MARKER_BUDGET: Duration = Duration::from_secs(10);

/// A session file could not be read safely.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TranscriptError {
    Io(String),
    /// Over the size limit, or a line over it.
    TooLarge,
    /// Not valid JSON lines.
    Malformed,
    Verification(VerificationCheck),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum VerificationCheck {
    Path,
    FileNameIdentity,
    CanonicalLocation,
    DirectorySafety,
    FileSafety,
    Header,
    WorkingDirectory,
    HeaderIdentity,
    SiblingSafety,
    Continuation,
    Departed,
    RemoteUnverified,
}

impl fmt::Display for TranscriptError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(e) => write!(f, "session file: {e}"),
            Self::TooLarge => f.write_str("session file exceeds 64 MiB"),
            Self::Malformed => f.write_str("session file is not valid JSON lines"),
            Self::Verification(check) => write!(f, "exact resume check failed: {check:?}"),
        }
    }
}

impl std::error::Error for TranscriptError {}

impl From<std::io::Error> for TranscriptError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}

impl From<rustix::io::Errno> for TranscriptError {
    fn from(e: rustix::io::Errno) -> Self {
        Self::Io(e.to_string())
    }
}

type Result<T, E = TranscriptError> = std::result::Result<T, E>;

/// What a verified saved session file says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Transcript {
    /// The model OMP restores on resume (`provider/id`), when the file names one.
    pub(crate) model: Option<String>,
    /// The real working folder the header records; a resume runs there.
    pub(crate) cwd: PathBuf,
}

/// The working folder a saved session may resume in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Folder {
    /// Exactly this real folder (a lane's recorded worktree).
    Exactly(PathBuf),
    /// The folder the session recorded: this real default, or another real folder the user owns. OMP
    /// resumes a session in the folder its header records, so a changed default never blocks a resume.
    Recorded(PathBuf),
}

/// The session ID in an OMP session file name `<stamp>Z_<uuid>.jsonl`.
pub(crate) fn session_file_id(name: &str) -> Option<&str> {
    let stem = name.strip_suffix(".jsonl")?;
    let (stamp, id) = stem.split_once("Z_")?;
    let valid_id = id.len() == 36
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-');
    // 2026-01-02T03-04-05-678
    let bytes = stamp.as_bytes();
    let shape = bytes.len() == 23
        && bytes.iter().enumerate().all(|(at, b)| match at {
            4 | 7 | 13 | 16 | 19 => *b == b'-',
            10 => *b == b'T',
            _ => b.is_ascii_digit(),
        });
    if !valid_id || !shape {
        return None;
    }
    let iso = format!(
        "{}:{}:{}.{}Z",
        stamp.get(..13)?,
        stamp.get(14..16)?,
        stamp.get(17..19)?,
        stamp.get(20..23)?
    );
    iso.parse::<jiff::Timestamp>().ok().map(|_| id)
}

struct BranchEntry {
    parent: Option<String>,
    model: Option<(String, String)>,
    assistant_model: Option<String>,
}

fn branch_entry(entry: &Value) -> Option<BranchEntry> {
    let parent = match entry.get("parentId") {
        Some(Value::Null) => None,
        Some(Value::String(parent)) => Some(parent.clone()),
        _ => return None,
    };
    if entry.get("type").and_then(Value::as_str) == Some("model_change")
        && let Some(model) = entry
            .get("model")
            .and_then(Value::as_str)
            .filter(|m| !m.is_empty())
    {
        let role = entry
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("default");
        return Some(BranchEntry {
            parent,
            model: Some((role.to_owned(), model.to_owned())),
            assistant_model: None,
        });
    }
    if entry.get("type").and_then(Value::as_str) == Some("message")
        && let Some(message) = entry.get("message").filter(|m| m.is_object())
        && message.get("role").and_then(Value::as_str) == Some("assistant")
        && let (Some(provider), Some(model)) = (
            message.get("provider").and_then(Value::as_str),
            message.get("model").and_then(Value::as_str),
        )
        && model != "<synthetic>"
    {
        return Some(BranchEntry {
            parent,
            model: None,
            assistant_model: Some(format!("{provider}/{model}")),
        });
    }
    Some(BranchEntry {
        parent,
        model: None,
        assistant_model: None,
    })
}

/// `provider/id`, neither part empty, no whitespace or control characters.
pub(crate) fn model_selector(selector: &str) -> bool {
    let Some((provider, id)) = selector.split_once('/') else {
        return false;
    };
    let bad = |c: char| c.is_whitespace() || c.is_control();
    !provider.is_empty() && !id.is_empty() && !provider.chars().any(bad) && !id.chars().any(bad)
}

/// The active branch's last model role, never "fallback".
fn saved_model(entries: &HashMap<String, BranchEntry>, leaf: Option<&str>) -> Option<String> {
    let mut role: Option<&str> = None;
    let mut preferred: Option<&str> = None;
    let mut default_model: Option<&str> = None;
    let mut legacy: Option<&str> = None;
    let mut seen = HashSet::new();
    let mut id = leaf;
    while let Some(at) = id {
        let entry = entries.get(at)?;
        if !seen.insert(at) {
            return None;
        }
        if let Some((entry_role, selector)) = &entry.model {
            let current = *role.get_or_insert(entry_role.as_str());
            if current != "fallback" && entry_role == current {
                preferred = preferred.or(Some(selector.as_str()));
            }
            if entry_role == "default" {
                default_model = default_model.or(Some(selector.as_str()));
            }
        }
        legacy = legacy.or(entry.assistant_model.as_deref());
        id = entry.parent.as_deref();
    }
    preferred
        .or(default_model)
        .or(legacy)
        .filter(|selector| model_selector(selector))
        .map(str::to_owned)
}

/// Opens read-only without following a final symlink and without blocking on a FIFO.
fn read_only(path: &Path) -> Result<File> {
    use rustix::fs::{Mode, OFlags};
    let fd = rustix::fs::open(
        path,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    Ok(File::from(fd))
}

/// The first `session` entry, skipping only leading `title` entries in the first `limit` bytes.
fn header(file: &mut File, limit: u64) -> Result<Option<Value>> {
    let mut head = Vec::new();
    file.by_ref().take(limit).read_to_end(&mut head)?;
    let mut rest = head.as_slice();
    while !rest.is_empty() {
        let Some(end) = rest.iter().position(|b| *b == b'\n') else {
            return Ok(None);
        };
        let (line, tail) = rest.split_at(end);
        let entry: Value = serde_json::from_slice(line).map_err(|_| TranscriptError::Malformed)?;
        if !entry.is_object() {
            return Ok(None);
        }
        match entry.get("type").and_then(Value::as_str) {
            Some("session") => return Ok(Some(entry)),
            Some("title") => rest = tail.get(1..).unwrap_or_default(),
            _ => return Ok(None),
        }
    }
    Ok(None)
}

fn real(path: &Path) -> Result<PathBuf> {
    Ok(fs::canonicalize(path)?)
}

/// `file` lies below `root` (not equal to it) without `..` or root components.
fn strictly_inside(root: &Path, file: &Path) -> bool {
    file.strip_prefix(root).is_ok_and(|rel| {
        rel.components().next().is_some()
            && rel.components().all(|c| matches!(c, Component::Normal(_)))
    })
}

/// Verifies a saved session file for an exact resume (HOST req. 9-10). `Ok(None)` is "not verified".
/// Entries next to the file that are not session files (OMP's per-session artifact folder, its lock
/// files) are not looked at.
pub(crate) fn exact(
    path: &Path,
    root: &Path,
    session: &str,
    folder: &Folder,
) -> Result<Option<Transcript>> {
    match exact_checked(path, root, session, folder) {
        Ok(transcript) => Ok(Some(transcript)),
        Err(TranscriptError::Verification(_)) => Ok(None),
        Err(error) => Err(error),
    }
}

fn exact_checked(path: &Path, root: &Path, session: &str, folder: &Folder) -> Result<Transcript> {
    let name = path
        .file_name()
        .and_then(std::ffi::OsStr::to_str)
        .unwrap_or_default();
    if !path.is_absolute() || path.to_string_lossy().chars().any(char::is_control) {
        return Err(TranscriptError::Verification(VerificationCheck::Path));
    }
    if session_file_id(name) != Some(session) {
        return Err(TranscriptError::Verification(
            VerificationCheck::FileNameIdentity,
        ));
    }
    let file = real(path)?;
    let root = real(root)?;
    if file != path || !strictly_inside(&root, &file) {
        return Err(TranscriptError::Verification(
            VerificationCheck::CanonicalLocation,
        ));
    }
    let uid = rustix::process::getuid().as_raw();
    let parent = root.parent().map(fs::metadata).transpose()?;
    // OMP sometimes writes group-writable files beneath its mode-0700 agent directory.
    let write_mask =
        if parent.is_some_and(|p| p.is_dir() && p.uid() == uid && p.mode().trailing_zeros() >= 6) {
            0o002
        } else {
            0o022
        };
    let mut dir = file.parent().map(Path::to_path_buf);
    while let Some(at) = dir {
        let info = fs::metadata(&at)?;
        if !info.is_dir() || info.uid() != uid || info.mode() & write_mask != 0 {
            return Err(TranscriptError::Verification(
                VerificationCheck::DirectorySafety,
            ));
        }
        if at == root {
            break;
        }
        dir = at.parent().map(Path::to_path_buf);
    }
    let mut handle = read_only(&file)?;
    let info = handle.metadata()?;
    if !info.is_file() || info.uid() != uid || info.nlink() != 1 || info.mode() & write_mask != 0 {
        return Err(TranscriptError::Verification(VerificationCheck::FileSafety));
    }
    if info.len() > FILE_LIMIT {
        return Err(TranscriptError::TooLarge);
    }
    let Some(head) = header(&mut handle, REOPEN_HEADER_BYTES)? else {
        return Err(TranscriptError::Verification(VerificationCheck::Header));
    };
    let header_cwd = head.get("cwd").and_then(Value::as_str).map(Path::new);
    let Some(recorded) = header_cwd.filter(|c| c.is_absolute()) else {
        return Err(TranscriptError::Verification(
            VerificationCheck::WorkingDirectory,
        ));
    };
    let recorded = real(recorded)?;
    let allowed = match folder {
        Folder::Exactly(cwd) => recorded == *cwd,
        Folder::Recorded(default) => {
            recorded == *default
                || fs::metadata(&recorded).is_ok_and(|m| m.is_dir() && m.uid() == uid)
        }
    };
    if head.get("id").and_then(Value::as_str) != Some(session) {
        return Err(TranscriptError::Verification(
            VerificationCheck::HeaderIdentity,
        ));
    }
    if !allowed {
        return Err(TranscriptError::Verification(
            VerificationCheck::WorkingDirectory,
        ));
    }
    check_siblings(&file, session, write_mask)?;
    handle.seek(SeekFrom::Start(0))?;
    read_branch(handle, recorded)
}
/// Generated sibling headers can redirect OMP's target; every such sibling must be readable.
fn check_siblings(file: &Path, session: &str, write_mask: u32) -> Result<()> {
    let dir = file.parent().ok_or(TranscriptError::Verification(
        VerificationCheck::CanonicalLocation,
    ))?;
    let uid = rustix::process::getuid().as_raw();
    for sibling in fs::read_dir(dir)? {
        let sibling = sibling?;
        let name = sibling.file_name();
        let Some(name) = name.to_str() else { continue };
        if Some(std::ffi::OsStr::new(name)) == file.file_name() || session_file_id(name).is_none() {
            continue;
        }
        let mut other = read_only(&sibling.path())?;
        let entry = other.metadata()?;
        if !entry.is_file() || entry.uid() != uid || entry.mode() & write_mask != 0 {
            return Err(TranscriptError::Verification(
                VerificationCheck::SiblingSafety,
            ));
        }
        match header(&mut other, HEADER_BYTES)? {
            Some(candidate)
                if candidate.get("continuationOf").and_then(Value::as_str) != Some(session) => {}
            _ => {
                return Err(TranscriptError::Verification(
                    VerificationCheck::Continuation,
                ));
            }
        }
    }
    Ok(())
}

/// Reads every entry for the saved model; `None` when the transcript departed or holds a non-object
/// line.
fn read_branch(handle: File, cwd: PathBuf) -> Result<Transcript> {
    let mut reader = BufReader::new(handle);
    let mut entries: HashMap<String, BranchEntry> = HashMap::new();
    let mut leaf: Option<String> = None;
    let mut last_self_selected: Option<String> = None;
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = reader
            .by_ref()
            .take(FILE_LIMIT + 1)
            .read_until(b'\n', &mut line)?;
        if read == 0 {
            break;
        }
        if u64::try_from(line.len()).unwrap_or(u64::MAX) > FILE_LIMIT {
            return Err(TranscriptError::TooLarge);
        }
        trim_newline(&mut line);
        let entry: Value = serde_json::from_slice(&line).map_err(|_| TranscriptError::Malformed)?;
        if !entry.is_object() {
            return Err(TranscriptError::Malformed);
        }
        if entry.get("type").and_then(Value::as_str) == Some("custom_message")
            && entry.get("customType").and_then(Value::as_str) == Some("session-transfer")
            && entry
                .get("details")
                .is_some_and(|d| d.get("kind").and_then(Value::as_str) == Some("departed"))
        {
            return Err(TranscriptError::Verification(VerificationCheck::Departed));
        }
        let Some(id) = entry.get("id").and_then(Value::as_str).map(str::to_owned) else {
            continue;
        };
        if entry.get("type").and_then(Value::as_str) == Some("session") {
            continue;
        }
        let Some(parsed) = branch_entry(&entry) else {
            continue;
        };
        entries.insert(id.clone(), parsed);
        leaf = match entry.get("activeLeafId") {
            Some(Value::Null) => None,
            Some(Value::String(active)) => Some(active.clone()),
            _ => Some(id.clone()),
        };
        if leaf.as_deref() == Some(id.as_str()) {
            last_self_selected = Some(id);
        }
    }
    let start = match &leaf {
        None => None,
        Some(at) if entries.contains_key(at) => Some(at.as_str()),
        Some(_) => last_self_selected.as_deref(),
    };
    Ok(Transcript {
        model: saved_model(&entries, start),
        cwd,
    })
}

fn trim_newline(line: &mut Vec<u8>) {
    if line.last() == Some(&b'\n') {
        line.pop();
    }
    if line.last() == Some(&b'\r') {
        line.pop();
    }
}

/// What a delivery search proved (PATCH-01 rule 10). Only `Yes` and `Absent` are evidence: anything
/// the search could not read completely is `Unknown`, never absence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Found {
    /// A user message entry carries the marker.
    Yes,
    /// Every entry of the whole file was read and parsed, and none carries the marker.
    Absent,
    /// The file does not exist (yet).
    Missing,
    /// Part of the file could not be checked (a partial or unparsable entry, an entry longer than
    /// 8 MiB, the time budget): whether it holds the marker is not known.
    Unknown(String),
}

/// Looks for `marker` in the text of a user `message` entry anywhere in `path`: the newest 8 MiB
/// first, where a delivery usually is, then the rest. A marker quoted by the assistant or a tool
/// does not count. Absence needs every line of the file read and parsed within [`MARKER_BUDGET`].
pub(crate) fn find_marker(path: &Path, marker: &str) -> Result<Found> {
    let started = Instant::now();
    let mut file = match read_only(path) {
        Ok(f) => f,
        Err(TranscriptError::Io(_)) if !path.exists() => return Ok(Found::Missing),
        Err(e) => return Err(e),
    };
    let info = file.metadata()?;
    if !info.is_file() {
        return Err(TranscriptError::Io("not a regular file".into()));
    }
    if info.len() > FILE_LIMIT {
        return Err(TranscriptError::TooLarge);
    }
    let start = info.len().saturating_sub(SEARCH_TAIL);
    file.seek(SeekFrom::Start(start))?;
    let mut tail = BufReader::new(file);
    // A tail that starts mid-file begins inside a line; the head part reads that line whole.
    let boundary = if start > 0 {
        start + u64::try_from(tail.skip_until(b'\n')?).unwrap_or(u64::MAX)
    } else {
        0
    };
    let mut scan = MarkerScan {
        marker: marker.as_bytes(),
        text: marker,
        started,
        doubt: None,
    };
    if let Some(found) = scan.lines(&mut tail)? {
        return Ok(found);
    }
    if boundary > 0 {
        let mut file = tail.into_inner();
        file.seek(SeekFrom::Start(0))?;
        if let Some(found) = scan.lines(&mut BufReader::new(file.take(boundary)))? {
            return Ok(found);
        }
    }
    Ok(scan.doubt.map_or(Found::Absent, Found::Unknown))
}

/// One marker search: the first doubt is kept while the search goes on, since a later entry may
/// still prove the marker there.
struct MarkerScan<'a> {
    marker: &'a [u8],
    text: &'a str,
    started: Instant,
    doubt: Option<String>,
}

impl MarkerScan<'_> {
    /// Reads `reader` to its end: `Some` for a found marker or a spent budget.
    fn lines(&mut self, reader: &mut impl std::io::BufRead) -> Result<Option<Found>> {
        let limit = usize::try_from(SEARCH_TAIL).unwrap_or(usize::MAX);
        let mut line = Vec::new();
        loop {
            if self.started.elapsed() > MARKER_BUDGET {
                return Ok(Some(Found::Unknown(format!(
                    "the search ran out of its {} s budget",
                    MARKER_BUDGET.as_secs()
                ))));
            }
            line.clear();
            if reader
                .by_ref()
                .take(SEARCH_TAIL + 1)
                .read_until(b'\n', &mut line)?
                == 0
            {
                return Ok(None);
            }
            let complete = line.last() == Some(&b'\n');
            if !complete && line.len() > limit {
                reader.skip_until(b'\n')?;
                self.doubt("an entry is longer than 8 MiB and was not checked");
                continue;
            }
            trim_newline(&mut line);
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            if contains(&line, self.marker) {
                match serde_json::from_slice::<Value>(&line) {
                    Ok(entry) if user_text_has(&entry, self.text) => return Ok(Some(Found::Yes)),
                    Ok(_) => {}
                    Err(_) if complete => {
                        self.doubt("an entry carrying the marker is not valid JSON");
                    }
                    Err(_) => self.doubt("the file ends inside an entry carrying the marker"),
                }
            } else if serde_json::from_slice::<serde::de::IgnoredAny>(&line).is_err() {
                self.doubt(if complete {
                    "an entry is not valid JSON"
                } else {
                    "the file ends inside an unfinished entry"
                });
            }
        }
    }

    fn doubt(&mut self, why: &str) {
        self.doubt.get_or_insert_with(|| why.to_string());
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && haystack.windows(needle.len()).any(|w| w == needle)
}

/// A user message, or the custom message the terminal runtime's bridge delivers (EXT req. 25), whose
/// text carries `marker`.
fn user_text_has(entry: &Value, marker: &str) -> bool {
    let content = match entry.get("type").and_then(Value::as_str) {
        Some("custom_message") => entry.get("content"),
        Some("message") => {
            let Some(message) = entry.get("message") else {
                return false;
            };
            match message.get("role").and_then(Value::as_str) {
                Some("user" | "custom") => message.get("content"),
                _ => return false,
            }
        }
        _ => return false,
    };
    match content {
        Some(Value::String(text)) => text.contains(marker),
        Some(Value::Array(parts)) => parts.iter().any(|p| {
            p.get("type").and_then(Value::as_str) == Some("text")
                && p.get("text")
                    .and_then(Value::as_str)
                    .is_some_and(|t| t.contains(marker))
        }),
        _ => false,
    }
}

/// Where the answer to one request stands in a session file (DISC-OUT req. 21-23).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Reply {
    /// No user entry carries the tag in the searched part of the file.
    NotFound,
    /// The turn has not ended yet.
    Pending,
    /// `text` is the final assistant text of the turn the request started; `more` the final text
    /// of each later turn OMP started by itself (a background job's result) before another input,
    /// in order. `open` while no input followed, so more such turns may come.
    Answer {
        text: String,
        more: Vec<String>,
        open: bool,
    },
    /// Another input entered the transcript before an answer: the answer would belong to mixed work.
    Abandoned,
}

/// One message entry: role, visible text, whether it calls a tool, and the stop reason.
struct Said {
    offset: u64,
    user: bool,
    text: String,
    tool_call: bool,
    stop: Option<String>,
}

/// The custom message type the terminal runtime's bridge delivers with (EXT req. 25).
const DELIVERY_TYPE: &str = "cataly-delivery";

/// A message entry, or a delivery of the terminal runtime's bridge, which is an input like a user
/// message.
fn said(entry: &Value, offset: u64) -> Option<Said> {
    let (user, content, stop) = match entry.get("type").and_then(Value::as_str)? {
        "custom_message"
            if entry.get("customType").and_then(Value::as_str) == Some(DELIVERY_TYPE) =>
        {
            (true, entry.get("content"), None)
        }
        "message" => {
            let message = entry.get("message")?;
            let user = match message.get("role").and_then(Value::as_str)? {
                "user" => true,
                "assistant" => false,
                _ => return None,
            };
            (user, message.get("content"), message.get("stopReason"))
        }
        _ => return None,
    };
    let mut text = String::new();
    let mut tool_call = false;
    match content {
        Some(Value::String(t)) => text.push_str(t),
        Some(Value::Array(parts)) => {
            for part in parts {
                match part.get("type").and_then(Value::as_str) {
                    // Commentary is the provider's running narration, not the answer.
                    Some("text")
                        if part.get("phase").and_then(Value::as_str) != Some("commentary") =>
                    {
                        if let Some(t) = part.get("text").and_then(Value::as_str) {
                            if !text.is_empty() {
                                text.push('\n');
                            }
                            text.push_str(t);
                        }
                    }
                    Some("toolCall" | "tool_use" | "toolUse") => tool_call = true,
                    _ => {}
                }
            }
        }
        _ => {}
    }
    Some(Said {
        offset,
        user,
        text,
        tool_call,
        stop: stop.and_then(Value::as_str).map(str::to_string),
    })
}

/// Request positions and searched prefixes for one relay's current session file. Only tags still
/// being read are kept; a replaced or shortened file discards all positions. No text is cached.
#[derive(Debug, Default)]
pub(crate) struct ReplyOffsets {
    identity: Option<(u64, u64)>,
    length: u64,
    tags: HashMap<String, ReplyPosition>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReplyPosition {
    Request(u64),
    /// No complete entry through this offset carries the tag; `complete` means the rest of the
    /// current file was checked too, apart from an unfinished last line.
    Searched {
        through: u64,
        complete: bool,
    },
}

impl ReplyPosition {
    fn start(self, tail: u64) -> u64 {
        match self {
            Self::Request(at) => at,
            Self::Searched { through, complete } => {
                if complete {
                    through
                } else {
                    through.max(tail)
                }
            }
        }
    }

    fn through(self) -> u64 {
        match self {
            Self::Request(_) => 0,
            Self::Searched { through, .. } => through,
        }
    }
}

impl ReplyOffsets {
    fn remember(&mut self, tag: &str, position: ReplyPosition) {
        if let Some(old) = self.tags.get_mut(tag) {
            *old = position;
        } else {
            self.tags.insert(tag.to_string(), position);
        }
    }
}

struct MessageScan {
    entries: Vec<Said>,
    /// The first byte of an unfinished last entry, or the end of the scanned range.
    through: u64,
    complete: bool,
}

/// Reads from retained request/search positions or the newest 8 MiB, then searches unread prefixes
/// for missing tags. Both parts share the 2 s budget and the file's bounded length. `None` means the
/// file is missing or the initial read ran out of time; a head timeout holds only unresolved tags.
fn message_entries(
    path: &Path,
    tags: &[String],
    offsets: &mut ReplyOffsets,
) -> Result<Option<Vec<Said>>> {
    let started = Instant::now();
    let file = match read_only(path) {
        Ok(f) => f,
        Err(TranscriptError::Io(_)) if !path.exists() => {
            *offsets = ReplyOffsets::default();
            return Ok(None);
        }
        Err(e) => return Err(e),
    };
    let info = file.metadata()?;
    if !info.is_file() {
        return Err(TranscriptError::Io("not a regular file".into()));
    }
    if info.len() > FILE_LIMIT {
        return Err(TranscriptError::TooLarge);
    }
    let identity = (info.dev(), info.ino());
    if offsets.identity != Some(identity) || info.len() < offsets.length {
        offsets.tags.clear();
        offsets.identity = Some(identity);
    }
    offsets.length = info.len();
    offsets.tags.retain(|tag, _| tags.contains(tag));
    let tail = info.len().saturating_sub(SEARCH_TAIL);
    let mut start = tags
        .iter()
        .map(|tag| offsets.tags.get(tag).map_or(tail, |p| p.start(tail)))
        .min()
        .unwrap_or(tail);
    let mut reader = BufReader::new(file);
    if start > 0 {
        // Include a line beginning exactly at the offset, even at the tail boundary. If a cached
        // offset moved inside a line, the head search below still covers that entire line.
        reader.seek(SeekFrom::Start(start - 1))?;
        start = start - 1
            + reader
                .by_ref()
                .take(info.len() - start + 1)
                .skip_until(b'\n')? as u64;
    }
    let tail = message_lines(
        &mut reader.by_ref().take(info.len() - start),
        start,
        started,
        None,
    )?;
    if !tail.complete {
        return Ok(None);
    }
    finish_messages(&mut reader, start, tail, tags, offsets, started).map(Some)
}

/// A head search may be incomplete without invalidating any complete tail results. Keep only a
/// matching request and its following entries, and retain search progress for every missing tag.
fn finish_messages(
    reader: &mut (impl std::io::BufRead + std::io::Seek),
    start: u64,
    mut tail: MessageScan,
    tags: &[String],
    offsets: &mut ReplyOffsets,
    started: Instant,
) -> Result<Vec<Said>> {
    let missing: Vec<&str> = tags
        .iter()
        .filter(|tag| {
            !tail
                .entries
                .iter()
                .any(|entry| entry.user && entry.text.contains(tag.as_str()))
        })
        .map(String::as_str)
        .collect();
    if missing.is_empty() {
        return Ok(tail.entries);
    }
    let from = missing
        .iter()
        .map(|tag| offsets.tags.get(*tag).map_or(0, |p| p.through()))
        .min()
        .unwrap_or(start)
        .min(start);
    let mut head = if from < start {
        reader.seek(SeekFrom::Start(from))?;
        message_lines(
            &mut reader.take(start - from),
            from,
            started,
            Some(&missing),
        )?
    } else {
        MessageScan {
            entries: Vec::new(),
            through: start,
            complete: true,
        }
    };
    for tag in missing {
        let position = if let Some(request) = head
            .entries
            .iter()
            .rfind(|entry| entry.user && entry.text.contains(tag))
        {
            ReplyPosition::Request(request.offset)
        } else {
            let previous = offsets.tags.get(tag).map_or(0, |p| p.through());
            let complete = head.complete || previous >= start;
            ReplyPosition::Searched {
                through: if complete {
                    tail.through
                } else {
                    previous.max(head.through)
                },
                complete,
            }
        };
        offsets.remember(tag, position);
    }
    if head.complete {
        head.entries.append(&mut tail.entries);
        Ok(head.entries)
    } else {
        Ok(tail.entries)
    }
}

fn message_lines(
    reader: &mut impl std::io::BufRead,
    mut offset: u64,
    started: Instant,
    after: Option<&[&str]>,
) -> Result<MessageScan> {
    let mut line = Vec::new();
    let mut out = MessageScan {
        entries: Vec::new(),
        through: offset,
        complete: false,
    };
    let mut keeping = after.is_none();
    loop {
        if started.elapsed() > SEARCH_BUDGET {
            return Ok(out);
        }
        line.clear();
        let n = reader
            .by_ref()
            .take(SEARCH_TAIL + 1)
            .read_until(b'\n', &mut line)? as u64;
        if n == 0 {
            out.complete = true;
            return Ok(out);
        }
        let at = offset;
        offset += n;
        // Do not advance the searched prefix past an unfinished entry: an append may complete it.
        if line.last() != Some(&b'\n') {
            offset += reader.skip_until(b'\n')? as u64;
            continue;
        }
        out.through = offset;
        trim_newline(&mut line);
        if let Ok(entry) = serde_json::from_slice::<Value>(&line)
            && let Some(s) = said(&entry, at)
        {
            if !keeping {
                keeping = s.user
                    && after.is_some_and(|tags| tags.iter().any(|tag| s.text.contains(*tag)));
            }
            if keeping {
                out.entries.push(s);
            }
        }
    }
}

/// The answer to each request tag. `prefix` starts every request tag, so a later request in the same
/// user entry (one batch) takes the answer; `settled` means the session is idle, so a final message
/// at the end of the file has ended its turn rather than being a step of one still running.
///
/// A turn ends with its final message, so the first final message after the request ends the turn
/// the request started. Every later final message before the next input ends a turn OMP started by
/// itself (a background job's result): it never replaces the answer.
pub(crate) fn replies(
    path: &Path,
    tags: &[String],
    prefix: &str,
    settled: bool,
    offsets: &mut ReplyOffsets,
) -> Result<Vec<Reply>> {
    if tags.is_empty() {
        offsets.tags.clear();
        return Ok(Vec::new());
    }
    let Some(entries) = message_entries(path, tags, offsets)? else {
        return Ok(vec![Reply::Pending; tags.len()]);
    };
    Ok(replies_from_entries(
        &entries, tags, prefix, settled, offsets,
    ))
}

fn replies_from_entries(
    entries: &[Said],
    tags: &[String],
    prefix: &str,
    settled: bool,
    offsets: &mut ReplyOffsets,
) -> Vec<Reply> {
    tags.iter()
        .map(|tag| {
            let Some((at, request)) = entries
                .iter()
                .enumerate()
                .rev()
                .find(|(_, e)| e.user && e.text.contains(tag.as_str()))
            else {
                return match offsets.tags.get(tag) {
                    Some(
                        ReplyPosition::Request(_)
                        | ReplyPosition::Searched {
                            complete: false, ..
                        },
                    ) => Reply::Pending,
                    _ => Reply::NotFound,
                };
            };
            let later_request = request
                .text
                .find(tag.as_str())
                .and_then(|i| request.text.get(i + tag.len()..))
                .is_some_and(|rest| rest.contains(prefix));
            if later_request {
                offsets.tags.remove(tag);
                return Reply::Abandoned;
            }
            let span = entries.get(at + 1..).unwrap_or_default();
            let end = span.iter().position(|e| e.user);
            if end.is_some() {
                offsets.tags.remove(tag);
            } else {
                offsets.remember(tag, ReplyPosition::Request(request.offset));
            }
            let turns = span.get(..end.unwrap_or(span.len())).unwrap_or_default();
            // A final message counts once anything follows it or the session is idle.
            let mut finals: Vec<String> = turns
                .iter()
                .enumerate()
                .filter(|(i, e)| {
                    e.stop.as_deref() == Some("stop")
                        && !e.tool_call
                        && !e.text.trim().is_empty()
                        && (settled || end.is_some() || i + 1 < turns.len())
                })
                .map(|(_, e)| e.text.clone())
                .collect();
            if finals.is_empty() {
                return if end.is_some() {
                    Reply::Abandoned
                } else {
                    Reply::Pending
                };
            }
            let text = finals.remove(0);
            Reply::Answer {
                text,
                more: finals,
                open: end.is_none(),
            }
        })
        .collect()
}

/// [`replies`] on the blocking pool.
pub(crate) async fn read_replies(
    path: PathBuf,
    tags: Vec<String>,
    prefix: String,
    settled: bool,
    offsets: Arc<Mutex<ReplyOffsets>>,
) -> Result<Vec<Reply>> {
    tokio::task::spawn_blocking(move || {
        replies(
            &path,
            &tags,
            &prefix,
            settled,
            &mut offsets.lock().unwrap_or_else(PoisonError::into_inner),
        )
    })
    .await
    .map_err(|e| TranscriptError::Io(format!("reply task: {e}")))?
}

/// [`find_marker`] on the blocking pool; a worker's session file is searched on the worker.
pub(crate) async fn search(path: PathBuf, marker: String) -> Result<Found> {
    if let Some((worker, file)) = crate::worker::split_remote(&path) {
        let link = crate::worker::link::connect(worker)
            .await
            .map_err(TranscriptError::Io)?;
        let answer = link
            .find(file, &marker)
            .await
            .map_err(TranscriptError::Io)?;
        let reason = || {
            answer
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("the worker could not read the whole file")
                .to_string()
        };
        return match answer.get("found").and_then(Value::as_str) {
            Some("yes") => Ok(Found::Yes),
            Some("absent") => Ok(Found::Absent),
            Some("missing") => Ok(Found::Missing),
            Some("unknown") => Ok(Found::Unknown(reason())),
            _ => Err(TranscriptError::Io(
                "the worker's search answer is unknown".into(),
            )),
        };
    }
    tokio::task::spawn_blocking(move || find_marker(&path, &marker))
        .await
        .map_err(|e| TranscriptError::Io(format!("search task: {e}")))?
}

/// [`exact`] on the blocking pool; a worker's session file is verified on the worker, its paths
/// given as the hub records them (`worker:<name>:/path`).
pub(crate) async fn verify(
    path: PathBuf,
    root: PathBuf,
    session: String,
    folder: Folder,
) -> Result<Option<Transcript>> {
    if let Some((worker, file)) = crate::worker::split_remote(&path) {
        let local = |p: &Path| {
            crate::worker::split_remote(p)
                .map_or_else(|| p.display().to_string(), |(_, f)| f.into())
        };
        let (kind, dir) = match &folder {
            Folder::Exactly(d) => ("exactly", d),
            Folder::Recorded(d) => ("recorded", d),
        };
        let params = serde_json::json!({
            "path": file,
            "root": local(&root),
            "session": session,
            kind: local(dir),
        });
        let link = crate::worker::link::connect(worker)
            .await
            .map_err(TranscriptError::Io)?;
        let answer = link.verify(params).await.map_err(TranscriptError::Io)?;
        if answer.is_null() {
            return Ok(None);
        }
        let cwd = answer
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or_default();
        return Ok(Some(Transcript {
            model: answer
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_string),
            cwd: PathBuf::from(cwd),
        }));
    }
    tokio::task::spawn_blocking(move || exact(&path, &root, &session, &folder))
        .await
        .map_err(|e| TranscriptError::Io(format!("verify task: {e}")))?
}

/// Exact resume with a diagnostic for the precise failed verification gate.
pub(crate) async fn verify_exact(
    path: PathBuf,
    root: PathBuf,
    session: String,
    folder: Folder,
) -> Result<Transcript> {
    if crate::worker::split_remote(&path).is_some() {
        return verify(path, root, session, folder)
            .await?
            .ok_or(TranscriptError::Verification(
                VerificationCheck::RemoteUnverified,
            ));
    }
    tokio::task::spawn_blocking(move || exact_checked(&path, &root, &session, &folder))
        .await
        .map_err(|e| TranscriptError::Io(format!("verify task: {e}")))?
}

/// A session file larger than this is an issue for spend reading (WS req. 34).
const SPEND_FILE_MAX: u64 = 64 * 1024 * 1024;

/// Token and cost totals of one session file, read incrementally (WS-20; WS req. 30-35): from the
/// last offset while the file identity is unchanged, from the start again when it shrank or was
/// replaced. Only numbers are kept, never content. Any issue makes the totals unknown. Lanes read
/// it through [`SpendTree`].
#[derive(Debug, Default)]
struct Spend {
    identity: Option<(u64, u64)>,
    offset: u64,
    /// Billed calls by record ID: tokens and cost, to tell a repeat from a conflict.
    calls: HashMap<String, (u64, u64)>,
    tokens: u64,
    /// Cost in micro-dollars, so sums stay exact.
    micros: u64,
    issue: Option<String>,
}

impl Spend {
    /// Reads what was appended since the last call. Calls before `since_ms` are not charged.
    pub(crate) fn read(&mut self, path: &Path, since_ms: i64) {
        if let Err(e) = self.step(path, since_ms) {
            self.issue = Some(e);
        }
    }

    fn step(&mut self, path: &Path, since_ms: i64) -> std::result::Result<(), String> {
        let meta = fs::symlink_metadata(path).map_err(|e| format!("unreadable: {e}"))?;
        if !meta.is_file() || meta.nlink() != 1 || meta.uid() != rustix::process::getuid().as_raw()
        {
            return Err("not a regular single-link file of this user".into());
        }
        if meta.len() > SPEND_FILE_MAX {
            return Err("larger than 64 MiB".into());
        }
        let identity = (meta.dev(), meta.ino());
        if self.identity != Some(identity) || meta.len() < self.offset {
            *self = Self {
                identity: Some(identity),
                ..Self::default()
            };
        }
        let mut file = File::open(path).map_err(|e| format!("unreadable: {e}"))?;
        file.seek(SeekFrom::Start(self.offset))
            .map_err(|e| format!("unreadable: {e}"))?;
        let mut reader = BufReader::new(file.take(meta.len() - self.offset));
        let mut line = Vec::new();
        loop {
            line.clear();
            let n = reader
                .read_until(b'\n', &mut line)
                .map_err(|e| format!("unreadable: {e}"))?;
            // A line without its end is read again next time.
            if n == 0 || line.last() != Some(&b'\n') {
                break;
            }
            self.offset += n as u64;
            if let Ok(entry) = serde_json::from_slice::<Value>(&line) {
                self.entry(&entry, since_ms)?;
            }
        }
        Ok(())
    }

    fn entry(&mut self, entry: &Value, since_ms: i64) -> std::result::Result<(), String> {
        let usage = match entry.get("type").and_then(Value::as_str) {
            Some("message") => entry
                .get("message")
                .filter(|m| m.get("role").and_then(Value::as_str) == Some("assistant"))
                .and_then(|m| m.get("usage")),
            Some("model_usage") => entry.get("usage").or(Some(entry)),
            _ => None,
        };
        let Some(usage) = usage else {
            return Ok(());
        };
        let at = entry
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(|t| t.parse::<jiff::Timestamp>().ok())
            .map(jiff::Timestamp::as_millisecond);
        if at.is_some_and(|at| at < since_ms) {
            return Ok(());
        }
        let n = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
        let tokens = n("input") + n("output") + n("cacheWrite");
        let cost = usage
            .pointer("/cost/total")
            .or_else(|| usage.get("cost"))
            .and_then(Value::as_f64)
            .filter(|c| c.is_finite() && *c >= 0.0)
            .unwrap_or(0.0);
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let micros = (cost * 1_000_000.0).round() as u64;
        let id = entry
            .get("id")
            .and_then(Value::as_str)
            .map_or_else(|| format!("@{}", self.offset), str::to_string);
        match self.calls.get(&id) {
            Some(seen) if *seen == (tokens, micros) => Ok(()),
            Some(_) => Err(format!("call {id} seen twice with different numbers")),
            None => {
                self.calls.insert(id, (tokens, micros));
                self.tokens += tokens;
                self.micros += micros;
                Ok(())
            }
        }
    }
}

/// Entries a directory of a session's artifact tree may hold before spend reading gives up (WS
/// req. 34), and how deep subagent spawns nest.
const TREE_DIR_MAX: usize = 4096;
const TREE_DEPTH_MAX: usize = 8;

/// Totals of a session file and of every subagent and advisor transcript OMP keeps next to it
/// (WS-20, WS req. 33). OMP stores those in the session's artifact directory, the session file's
/// path without `.jsonl`, as `<agent>.jsonl`, nested in `<agent>/` per spawn; a child is found by
/// its place in that tree, which only its parent session writes. Each file is read incrementally;
/// any issue in any file makes the totals unknown.
#[derive(Debug, Default)]
pub(crate) struct SpendTree {
    files: HashMap<PathBuf, Spend>,
}

impl SpendTree {
    /// Reads what every file of the tree appended since the last call: tokens and US dollars over
    /// all of them, and how many child transcripts there are.
    pub(crate) fn read(
        &mut self,
        main: &Path,
        since_ms: i64,
    ) -> std::result::Result<(f64, f64, usize), String> {
        let mut paths = vec![main.to_path_buf()];
        children(&main.with_extension(""), 0, &mut paths)?;
        self.files.retain(|p, _| paths.contains(p));
        let (mut tokens, mut micros) = (0u64, 0u64);
        for path in &paths {
            let spend = self.files.entry(path.clone()).or_default();
            spend.read(path, since_ms);
            if let Some(issue) = &spend.issue {
                let name = path
                    .file_name()
                    .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
                return Err(format!("{name}: {issue}"));
            }
            tokens += spend.tokens;
            micros += spend.micros;
        }
        #[allow(clippy::cast_precision_loss)]
        Ok((tokens as f64, micros as f64 / 1_000_000.0, paths.len() - 1))
    }
}

/// Every `*.jsonl` below `dir`, depth first; a missing directory has none. Spill output under
/// `local/` holds no transcripts and is skipped.
fn children(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) -> std::result::Result<(), String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("{}: unreadable: {e}", dir.display())),
    };
    let mut found: Vec<(PathBuf, bool)> = Vec::new();
    for (n, entry) in entries.enumerate() {
        if n >= TREE_DIR_MAX {
            return Err(format!("{}: over {TREE_DIR_MAX} entries", dir.display()));
        }
        let entry = entry.map_err(|e| format!("{}: unreadable: {e}", dir.display()))?;
        let kind = entry
            .file_type()
            .map_err(|e| format!("{}: unreadable: {e}", dir.display()))?;
        let path = entry.path();
        if kind.is_dir() && entry.file_name() != "local" {
            found.push((path, true));
        } else if kind.is_file() && path.extension().is_some_and(|x| x == "jsonl") {
            found.push((path, false));
        }
    }
    found.sort();
    for (path, is_dir) in found {
        if !is_dir {
            out.push(path);
        } else if depth + 1 < TREE_DEPTH_MAX {
            children(&path, depth + 1, out)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replies_follow_the_turn_a_request_started() {
        let dir = crate::sys::fs::tests::scratch("replies");
        let path = dir.join("s.jsonl");
        let user = |t: &str| {
            format!(
                r#"{{"type":"message","message":{{"role":"user","content":[{{"type":"text","text":"{t}"}}]}}}}"#
            )
        };
        let said = |t: &str, stop: &str, tool: bool| {
            let tool = if tool {
                r#",{"type":"toolCall","id":"c","name":"bash","arguments":{}}"#
            } else {
                ""
            };
            format!(
                r#"{{"type":"message","message":{{"role":"assistant","content":[{{"type":"text","text":"{t}"}}{tool}],"stopReason":"{stop}"}}}}"#
            )
        };
        let lines = [
            r#"{"type":"session","id":"x"}"#.to_string(),
            user("[d a] one"),
            said("looking", "toolUse", true),
            said("first answer", "stop", false),
            // A tern delivery is a request; another extension's custom message is not.
            r#"{"type":"custom_message","customType":"cataly-delivery","content":"[d b] two","display":true}"#.to_string(),
            said("thinking", "toolUse", true),
            r#"{"type":"custom_message","customType":"other","content":"[d y] note","display":true}"#.to_string(),
            user("[d c] three [d e] five"),
            said("done", "stop", false),
        ];
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();
        let tags: Vec<String> = ["[d a]", "[d b]", "[d c]", "[d e]", "[d z]"]
            .map(String::from)
            .to_vec();
        let answer = |text: &str, open: bool| Reply::Answer {
            text: text.into(),
            more: Vec::new(),
            open,
        };
        let mut offsets = ReplyOffsets::default();
        let got = replies(&path, &tags, "[d ", false, &mut offsets).unwrap();
        assert_eq!(got[0], answer("first answer", false));
        assert_eq!(got[1], Reply::Abandoned, "steered before an answer");
        assert_eq!(
            got[2],
            Reply::Abandoned,
            "a later request in the same batch takes it"
        );
        assert_eq!(got[3], Reply::Pending, "the session still works");
        assert_eq!(got[4], Reply::NotFound);
        let got = replies(&path, &tags, "[d ", true, &mut offsets).unwrap();
        assert_eq!(got[3], answer("done", true));
    }

    #[test]
    fn a_reply_tag_outside_the_newest_8_mib_keeps_its_answer() {
        use std::io::{Seek as _, Write as _};

        let dir = crate::sys::fs::tests::scratch("reply-old-tag");
        let path = dir.join("s.jsonl");
        let mut file = std::io::BufWriter::new(File::create(&path).unwrap());
        writeln!(file, r#"{{"type":"session","id":"x"}}"#).unwrap();
        writeln!(
            file,
            r#"{{"type":"message","message":{{"role":"user","content":"earlier input"}}}}"#
        )
        .unwrap();
        let request_at = file.stream_position().unwrap();
        writeln!(
            file,
            r#"{{"type":"message","message":{{"role":"user","content":"[d old] request"}}}}"#
        )
        .unwrap();
        let filler = serde_json::json!({
            "type": "message",
            "message": {"role": "toolResult", "content": "x".repeat(64 * 1024)}
        })
        .to_string();
        for _ in 0..144 {
            writeln!(file, "{filler}").unwrap();
        }
        writeln!(
            file,
            r#"{{"type":"message","message":{{"role":"assistant","content":"the answer","stopReason":"stop"}}}}"#
        )
        .unwrap();
        file.flush().unwrap();
        let tags = ["[d old]".into()];
        let mut offsets = ReplyOffsets::default();
        assert_eq!(
            replies(&path, &tags, "[d ", true, &mut offsets).unwrap(),
            vec![Reply::Answer {
                text: "the answer".into(),
                more: Vec::new(),
                open: true,
            }]
        );
        assert_eq!(
            offsets.tags.get("[d old]"),
            Some(&ReplyPosition::Request(request_at))
        );
        let entries = message_entries(&path, &tags, &mut offsets)
            .unwrap()
            .unwrap();
        assert_eq!(entries[0].offset, request_at, "the head is not read again");
        assert_eq!(entries[0].text, "[d old] request");

        writeln!(
            file,
            r#"{{"type":"custom_message","customType":"cataly-delivery","content":"[d new] next"}}"#
        )
        .unwrap();
        file.flush().unwrap();
        let mut cold = ReplyOffsets::default();
        assert_eq!(
            replies(
                &path,
                &["[d old]".into(), "[d new]".into()],
                "[d ",
                false,
                &mut cold,
            )
            .unwrap(),
            vec![
                Reply::Answer {
                    text: "the answer".into(),
                    more: Vec::new(),
                    open: false,
                },
                Reply::Pending,
            ],
            "head and tail entries keep their order"
        );
        assert_eq!(cold.tags.len(), 1, "a closed request leaves the cache");
        assert!(cold.tags.contains_key("[d new]"));
    }

    #[test]
    fn reply_search_resumes_after_absence() {
        use std::io::Write as _;

        let dir = crate::sys::fs::tests::scratch("reply-missing-tag");
        let path = dir.join("s.jsonl");
        let mut file = std::io::BufWriter::new(File::create(&path).unwrap());
        let filler = serde_json::json!({
            "type": "message",
            "message": {"role": "toolResult", "content": "x".repeat(64 * 1024)}
        })
        .to_string();
        for _ in 0..144 {
            writeln!(file, "{filler}").unwrap();
        }
        writeln!(
            file,
            r#"{{"type":"message","message":{{"role":"assistant","content":"earlier answer","stopReason":"stop"}}}}"#
        )
        .unwrap();
        file.flush().unwrap();
        let tags = ["[d queued]".into()];
        let mut offsets = ReplyOffsets::default();
        assert_eq!(
            replies(&path, &tags, "[d ", true, &mut offsets).unwrap(),
            vec![Reply::NotFound]
        );
        assert!(
            message_entries(&path, &tags, &mut offsets)
                .unwrap()
                .unwrap()
                .is_empty(),
            "an unchanged transcript is not searched again for an absent tag"
        );
        file.write_all(
            b"{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"[d que",
        )
        .unwrap();
        file.flush().unwrap();
        assert_eq!(
            replies(&path, &tags, "[d ", true, &mut offsets).unwrap(),
            vec![Reply::NotFound]
        );
        file.write_all(b"ued] request\"}}\n").unwrap();
        writeln!(
            file,
            r#"{{"type":"message","message":{{"role":"assistant","content":"new answer","stopReason":"stop"}}}}"#
        )
        .unwrap();
        file.flush().unwrap();
        assert_eq!(
            replies(&path, &tags, "[d ", true, &mut offsets).unwrap(),
            vec![Reply::Answer {
                text: "new answer".into(),
                more: Vec::new(),
                open: true,
            }],
            "a partial entry is searched again after it is completed"
        );
    }

    #[test]
    fn reply_search_keeps_tail_answers_when_head_budget_expires() {
        let head =
            "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"[d old]\"}}\n";
        let tail = concat!(
            "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"[d ready]\"}}\n",
            "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":\"ready answer\",\"stopReason\":\"stop\"}}\n"
        );
        let text = format!("{head}{tail}");
        let mut reader = std::io::Cursor::new(text.as_bytes());
        let start = head.len() as u64;
        reader.set_position(start);
        let tail = message_lines(&mut reader, start, Instant::now(), None).unwrap();
        assert!(tail.complete);
        let tags = ["[d old]".into(), "[d ready]".into(), "[d absent]".into()];
        let mut offsets = ReplyOffsets::default();
        offsets.remember(
            "[d absent]",
            ReplyPosition::Searched {
                through: text.len() as u64,
                complete: true,
            },
        );
        let expired = Instant::now()
            .checked_sub(SEARCH_BUDGET + Duration::from_millis(1))
            .unwrap();
        let entries =
            finish_messages(&mut reader, start, tail, &tags, &mut offsets, expired).unwrap();
        assert_eq!(
            replies_from_entries(&entries, &tags, "[d ", true, &mut offsets),
            vec![
                Reply::Pending,
                Reply::Answer {
                    text: "ready answer".into(),
                    more: Vec::new(),
                    open: true,
                },
                Reply::NotFound,
            ],
            "only the tag whose head search is unfinished waits"
        );
        assert_eq!(
            offsets.tags.get("[d old]"),
            Some(&ReplyPosition::Searched {
                through: 0,
                complete: false,
            })
        );
    }

    #[test]
    fn reply_search_keeps_only_matched_head_entries() {
        let text = concat!(
            "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"unrelated request\"}}\n",
            "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":\"unrelated answer\"}}\n",
            "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"[d wanted]\"}}\n",
            "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":\"wanted answer\"}}\n"
        );
        let mut reader = std::io::Cursor::new(text);
        let scan = message_lines(&mut reader, 0, Instant::now(), Some(&["[d wanted]"])).unwrap();
        assert!(scan.complete);
        assert_eq!(scan.through, text.len() as u64);
        assert_eq!(scan.entries.len(), 2);
        assert_eq!(scan.entries[0].text, "[d wanted]");
        assert_eq!(scan.entries[1].text, "wanted answer");
    }

    #[test]
    fn reply_offsets_reset_when_the_file_changes_or_requests_leave() {
        let dir = crate::sys::fs::tests::scratch("reply-offsets");
        let path = dir.join("s.jsonl");
        let user = "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"[d a] request\"}}\n";
        let header = "{\"type\":\"session\",\"id\":\"x\"}\n";
        let tags = ["[d a]".into()];
        let mut offsets = ReplyOffsets::default();
        fs::write(&path, format!("{header}{user}")).unwrap();
        assert_eq!(
            replies(&path, &tags, "[d ", false, &mut offsets).unwrap(),
            vec![Reply::Pending]
        );
        assert_eq!(
            offsets.tags.get("[d a]"),
            Some(&ReplyPosition::Request(header.len() as u64))
        );

        fs::write(&path, user).unwrap();
        let entries = message_entries(&path, &tags, &mut offsets)
            .unwrap()
            .unwrap();
        assert!(
            offsets.tags.is_empty(),
            "truncation invalidates the offsets"
        );
        assert_eq!(entries[0].offset, 0);
        replies(&path, &tags, "[d ", false, &mut offsets).unwrap();
        let identity = offsets.identity;

        let replacement = dir.join("replacement.jsonl");
        fs::write(&replacement, format!("{header}{user}")).unwrap();
        fs::rename(&replacement, &path).unwrap();
        let entries = message_entries(&path, &tags, &mut offsets)
            .unwrap()
            .unwrap();
        assert_ne!(offsets.identity, identity);
        assert!(
            offsets.tags.is_empty(),
            "replacement invalidates the offsets"
        );
        assert_eq!(entries[0].offset, header.len() as u64);
        replies(&path, &tags, "[d ", false, &mut offsets).unwrap();
        assert_eq!(offsets.tags.len(), 1);
        assert_eq!(
            replies(&path, &[], "[d ", false, &mut offsets).unwrap(),
            Vec::<Reply>::new()
        );
        assert!(offsets.tags.is_empty(), "unrequested tags are not retained");
    }

    #[test]
    fn reply_reads_keep_the_file_and_time_bounds() {
        let dir = crate::sys::fs::tests::scratch("reply-bounds");
        let path = dir.join("s.jsonl");
        File::create(&path)
            .unwrap()
            .set_len(FILE_LIMIT + 1)
            .unwrap();
        assert_eq!(
            replies(
                &path,
                &["[d a]".into()],
                "[d ",
                true,
                &mut ReplyOffsets::default(),
            ),
            Err(TranscriptError::TooLarge)
        );
        let mut input = std::io::Cursor::new(b"{}\n");
        let started = Instant::now()
            .checked_sub(SEARCH_BUDGET + Duration::from_millis(1))
            .unwrap();
        assert!(
            !message_lines(&mut input, 0, started, None)
                .unwrap()
                .complete
        );
    }

    #[test]
    fn a_turn_omp_starts_itself_never_replaces_the_answer() {
        let dir = crate::sys::fs::tests::scratch("continuations");
        let path = dir.join("s.jsonl");
        let said = |t: &str, stop: &str, tool: bool| {
            let tool = if tool {
                r#",{"type":"toolCall","id":"c","name":"bash","arguments":{}}"#
            } else {
                ""
            };
            format!(
                r#"{{"type":"message","message":{{"role":"assistant","content":[{{"type":"text","text":"{t}"}}{tool}],"stopReason":"{stop}"}}}}"#
            )
        };
        let result = r#"{"type":"custom_message","customType":"async-result","content":"done","display":true}"#;
        let mut lines = vec![
            r#"{"type":"session","id":"x"}"#.to_string(),
            r#"{"type":"message","message":{"role":"user","content":"[d a] back up"}}"#.to_string(),
            said("started the backup", "stop", false),
            result.to_string(),
            said("checking", "toolUse", true),
            said("the backup finished", "stop", false),
            result.to_string(),
            said("cleaned up", "stop", false),
        ];
        let mut offsets = ReplyOffsets::default();
        let mut read = |lines: &[String], settled| {
            std::fs::write(&path, lines.join("\n") + "\n").unwrap();
            replies(&path, &["[d a]".to_string()], "[d ", settled, &mut offsets)
                .unwrap()
                .remove(0)
        };
        let reply = |more: &[&str], open| Reply::Answer {
            text: "started the backup".into(),
            more: more.iter().map(|m| (*m).to_string()).collect(),
            open,
        };
        assert_eq!(
            read(&lines, false),
            reply(&["the backup finished"], true),
            "the last turn may still run"
        );
        assert_eq!(
            read(&lines, true),
            reply(&["the backup finished", "cleaned up"], true)
        );
        lines.push(r#"{"type":"message","message":{"role":"user","content":"[d b] next"}}"#.into());
        lines.push(said("next answer", "stop", false));
        assert_eq!(
            read(&lines, false),
            reply(&["the backup finished", "cleaned up"], false),
            "the next input closes the request's turns"
        );
    }

    #[test]
    fn session_file_names() {
        let id = "0b9e7c1a-1111-4222-8333-444455556666";
        assert_eq!(
            session_file_id(&format!("2026-11-01T10-20-30-400Z_{id}.jsonl")),
            Some(id)
        );
        assert_eq!(
            session_file_id(&format!("2026-13-01T10-20-30-400Z_{id}.jsonl")),
            None
        );
        assert_eq!(session_file_id("x.jsonl"), None);
    }

    #[test]
    fn saved_model_prefers_the_branch_role() {
        let mut entries = HashMap::new();
        let entry = |parent: Option<&str>, model: Option<(&str, &str)>, assistant: Option<&str>| {
            BranchEntry {
                parent: parent.map(str::to_owned),
                model: model.map(|(r, s)| (r.to_owned(), s.to_owned())),
                assistant_model: assistant.map(str::to_owned),
            }
        };
        entries.insert(
            "a".to_owned(),
            entry(None, Some(("default", "p/one")), None),
        );
        entries.insert("b".to_owned(), entry(Some("a"), None, Some("p/legacy")));
        entries.insert(
            "c".to_owned(),
            entry(Some("b"), Some(("fallback", "p/fb")), None),
        );
        assert_eq!(saved_model(&entries, Some("c")).as_deref(), Some("p/one"));
        assert_eq!(saved_model(&entries, Some("b")).as_deref(), Some("p/one"));
        assert_eq!(saved_model(&entries, Some("x")), None);
        assert!(!model_selector("a b/c") && model_selector("a/b/c"));
    }

    #[test]
    fn markers_count_only_in_user_entries() {
        let dir = crate::sys::fs::tests::scratch("transcript");
        let path = dir.join("s.jsonl");
        let user = |text: &str| {
            serde_json::json!({"type": "message", "message": {"role": "user", "content": [{"type": "text", "text": text}]}})
                .to_string()
        };
        let assistant = serde_json::json!({"type": "message", "message": {"role": "assistant", "content": [{"type": "text", "text": "[cataly:bbb] echoed"}]}});
        assert_eq!(find_marker(&path, "[cataly:aaa]").unwrap(), Found::Missing);
        fs::write(
            &path,
            format!(
                "{{\"type\":\"session\",\"id\":\"x\"}}\n{}\n{assistant}\n{{\"type\":\"message\",\"mess",
                user("[cataly:aaa] owner\nhello")
            ),
        )
        .unwrap();
        assert_eq!(find_marker(&path, "[cataly:aaa]").unwrap(), Found::Yes);
        // A file that ends inside an entry proves nothing about a marker it does not show.
        assert!(matches!(
            find_marker(&path, "[cataly:bbb]").unwrap(),
            Found::Unknown(_)
        ));
        let whole = fs::read_to_string(&path).unwrap();
        let complete = &whole[..=whole.rfind('\n').unwrap()];
        fs::write(&path, complete).unwrap();
        assert_eq!(find_marker(&path, "[cataly:bbb]").unwrap(), Found::Absent);
        let string_content = serde_json::json!({"type": "message", "message": {"role": "user", "content": "[cataly:ccc] x"}});
        fs::write(&path, format!("{string_content}\n")).unwrap();
        assert_eq!(find_marker(&path, "[cataly:ccc]").unwrap(), Found::Yes);
    }

    /// A delivery marker older than the newest 8 MiB is found; absence is proved only by reading
    /// the whole file, so a long transcript is not mistaken for one without the entry.
    #[test]
    fn a_marker_outside_the_newest_8_mib_is_found() {
        let dir = crate::sys::fs::tests::scratch("transcript-old-marker");
        let path = dir.join("s.jsonl");
        let user = |text: &str| {
            serde_json::json!({"type": "message", "message": {"role": "user", "content": [{"type": "text", "text": text}]}})
                .to_string()
        };
        let filler = serde_json::json!({"type": "message", "message": {"role": "assistant", "content": [{"type": "text", "text": "x".repeat(64 * 1024)}]}}).to_string();
        let mut text = format!(
            "{{\"type\":\"session\",\"id\":\"x\"}}\n{}\n",
            user("[cataly:old] owner\nhi")
        );
        while u64::try_from(text.len()).unwrap() < SEARCH_TAIL + 2 * 1024 * 1024 {
            text.push_str(&filler);
            text.push('\n');
        }
        text.push_str(&user("[cataly:new] owner\nlater"));
        text.push('\n');
        fs::write(&path, &text).unwrap();
        assert_eq!(find_marker(&path, "[cataly:old]").unwrap(), Found::Yes);
        assert_eq!(find_marker(&path, "[cataly:new]").unwrap(), Found::Yes);
        assert_eq!(find_marker(&path, "[cataly:none]").unwrap(), Found::Absent);
        // The entry the tail starts inside is read whole by the head part.
        let edge = user(&format!("[cataly:edge] {}", "y".repeat(64)));
        let assistant = |text: &str| {
            serde_json::json!({"type": "message", "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}})
                .to_string()
        };
        let suffix = usize::try_from(SEARCH_TAIL).unwrap() - edge.len().div_ceil(2);
        let pad = assistant(&"x".repeat(suffix - 1 - assistant("").len()));
        assert_eq!(pad.len() + 1, suffix);
        fs::write(
            &path,
            format!("{{\"type\":\"session\",\"id\":\"x\"}}\n{edge}\n{pad}\n"),
        )
        .unwrap();
        assert_eq!(find_marker(&path, "[cataly:edge]").unwrap(), Found::Yes);
        assert_eq!(find_marker(&path, "[cataly:none]").unwrap(), Found::Absent);
    }

    /// An unparsable line, an entry over 8 MiB or a partial last entry leaves absence unknown; a
    /// marker found elsewhere is still found.
    #[test]
    fn unreadable_parts_leave_absence_unknown() {
        let dir = crate::sys::fs::tests::scratch("transcript-unknown");
        let path = dir.join("s.jsonl");
        let user = |text: &str| {
            serde_json::json!({"type": "message", "message": {"role": "user", "content": [{"type": "text", "text": text}]}})
                .to_string()
        };
        fs::write(&path, format!("{}\nnot json\n", user("[cataly:a] x"))).unwrap();
        assert_eq!(find_marker(&path, "[cataly:a]").unwrap(), Found::Yes);
        assert!(
            matches!(find_marker(&path, "[cataly:b]").unwrap(), Found::Unknown(r) if r.contains("not valid JSON"))
        );
        let long = format!(
            "{}\n{}\n",
            user("[cataly:a] x"),
            user(&"z".repeat(usize::try_from(SEARCH_TAIL).unwrap() + 16))
        );
        fs::write(&path, long).unwrap();
        assert!(
            matches!(find_marker(&path, "[cataly:b]").unwrap(), Found::Unknown(r) if r.contains("8 MiB"))
        );
        fs::write(
            &path,
            format!(
                "{}\n{{\"type\":\"message\",\"message\":{{\"content\":\"[cataly:b]",
                user("x")
            ),
        )
        .unwrap();
        assert!(
            matches!(find_marker(&path, "[cataly:b]").unwrap(), Found::Unknown(r) if r.contains("ends inside"))
        );
    }

    /// The owner's layout after a 0.1.0 lead: a title line first, the header cwd `<home>/tmp` while the
    /// default is now `<home>`, OMP's per-session folder (with a subagent transcript) and lock file next
    /// to the file, mode 0664 under 0700 parents. The lead resumes in its recorded folder; a lane
    /// still needs its exact folder; a foreign recorded folder and a redirecting sibling still refuse.
    #[test]
    fn a_session_resumes_in_its_recorded_folder_beside_omps_session_folder() {
        use std::os::unix::fs::PermissionsExt;
        let base = crate::sys::fs::tests::scratch("owner-layout");
        // The hub works below its canonical state folder (`sys::paths`); macOS's temporary folder
        // lies below the `/var` symlink.
        let home = fs::canonicalize(&*base).unwrap().join("home");
        let work = home.join("tmp");
        let state = home.join("state/cataly");
        let root = state.join("sessions/lead");
        fs::create_dir_all(&work).unwrap();
        fs::create_dir_all(&root).unwrap();
        for dir in [state.clone(), state.join("sessions"), root.clone()] {
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let id = "01a21383-7906-7055-a149-9cb73150b636";
        let stem = format!("2026-11-25T16-21-53-030Z_{id}");
        let file = root.join(format!("{stem}.jsonl"));
        let write = |cwd: &Path| {
            let lines = [
                serde_json::json!({"type": "title", "title": "lead"}),
                serde_json::json!({"type": "session", "version": 3, "id": id, "timestamp": "2026-11-25T16:21:53.030Z", "cwd": cwd}),
                serde_json::json!({"type": "model_change", "id": "m1", "parentId": null, "model": "anthropic/claude-opus-5-5"}),
            ];
            fs::write(&file, lines.map(|l| l.to_string() + "\n").concat()).unwrap();
            fs::set_permissions(&file, fs::Permissions::from_mode(0o664)).unwrap();
        };
        write(&work);
        let artifacts = root.join(&stem);
        fs::create_dir(&artifacts).unwrap();
        fs::set_permissions(&artifacts, fs::Permissions::from_mode(0o775)).unwrap();
        fs::write(
            artifacts.join("Scout.jsonl"),
            serde_json::json!({"type": "session", "id": "sub", "cwd": work}).to_string() + "\n",
        )
        .unwrap();
        fs::write(root.join(format!(".{stem}.jsonl.lock.os")), "").unwrap();
        let home = fs::canonicalize(&home).unwrap();
        let work = fs::canonicalize(&work).unwrap();

        let resumed = exact(&file, &root, id, &Folder::Recorded(home.clone())).unwrap();
        assert_eq!(
            resumed,
            Some(Transcript {
                model: Some("anthropic/claude-opus-5-5".into()),
                cwd: work.clone(),
            })
        );
        let lane = |cwd: &Path| exact(&file, &root, id, &Folder::Exactly(cwd.to_path_buf()));
        assert_eq!(lane(&home).unwrap(), None, "a lane keeps its exact folder");
        assert!(lane(&work).unwrap().is_some());

        if rustix::process::getuid().as_raw() != 0 {
            write(Path::new("/"));
            assert_eq!(
                exact(&file, &root, id, &Folder::Recorded(home.clone())).unwrap(),
                None,
                "a recorded folder another user owns"
            );
            write(&work);
        }
        let other =
            root.join("2026-11-25T17-00-00-000Z_0b9e7c1a-1111-4222-8333-444455556666.jsonl");
        fs::write(
            &other,
            serde_json::json!({"type": "session", "id": "x", "cwd": work, "continuationOf": id})
                .to_string()
                + "\n",
        )
        .unwrap();
        assert_eq!(
            exact(&file, &root, id, &Folder::Recorded(home)).unwrap(),
            None,
            "a sibling continuing the session redirects the resume"
        );
    }

    #[test]
    fn spend_counts_subagent_and_advisor_transcripts() {
        let dir = crate::sys::fs::tests::scratch("spend-tree");
        let main = dir.join("2026-11-25T00-00-00-000Z_s1.jsonl");
        let call = |id: &str, cost: f64| {
            format!(
                "{}\n",
                serde_json::json!({"type": "message", "id": id, "message": {"role": "assistant", "usage": {"input": 10, "output": 5, "cost": {"total": cost}}}})
            )
        };
        fs::write(&main, call("m1", 0.5)).unwrap();
        let mut tree = SpendTree::default();
        assert_eq!(tree.read(&main, 0).unwrap(), (15.0, 0.5, 0));
        let artifacts = dir.join("2026-11-25T00-00-00-000Z_s1");
        fs::create_dir_all(artifacts.join("Scout/local")).unwrap();
        fs::write(artifacts.join("Scout.jsonl"), call("s1", 0.25)).unwrap();
        fs::write(artifacts.join("Scout/Helper.jsonl"), call("h1", 0.125)).unwrap();
        fs::write(artifacts.join("__advisor.jsonl"), call("a1", 0.0625)).unwrap();
        fs::write(artifacts.join("Scout/local/1.log"), "spill").unwrap();
        fs::write(artifacts.join("Scout/local/2.jsonl"), call("x", 9.0)).unwrap();
        assert_eq!(tree.read(&main, 0).unwrap(), (60.0, 0.9375, 3));
        let mut more = fs::OpenOptions::new()
            .append(true)
            .open(artifacts.join("Scout.jsonl"))
            .unwrap();
        std::io::Write::write_all(&mut more, call("s2", 1.0).as_bytes()).unwrap();
        assert_eq!(tree.read(&main, 0).unwrap(), (75.0, 1.9375, 3));
        std::io::Write::write_all(&mut more, call("s2", 2.0).as_bytes()).unwrap();
        assert!(
            tree.read(&main, 0).unwrap_err().contains("Scout.jsonl"),
            "one bad child makes the total unknown"
        );
    }

    /// Slice-3a measurement: the first read of a 10 MiB session file, then an incremental read of
    /// one appended call. Run with `cargo test --release -- --ignored --nocapture spend_read_cost`.
    #[test]
    #[ignore = "measurement"]
    fn spend_read_cost() {
        let dir = crate::sys::fs::tests::scratch("spend-cost");
        let main = dir.join("2026-11-25T00-00-00-000Z_s1.jsonl");
        let text = "x".repeat(1500);
        let mut body = String::new();
        let mut n = 0;
        while body.len() < 10 << 20 {
            n += 1;
            let line = if n % 2 == 0 {
                serde_json::json!({"type": "message", "id": format!("m{n}"), "timestamp": "2026-11-25T00:00:01Z", "message": {"role": "assistant", "content": [{"type": "text", "text": text}], "usage": {"input": 10, "output": 5, "cost": {"total": 0.001}}}})
            } else {
                serde_json::json!({"type": "message", "id": format!("u{n}"), "message": {"role": "user", "content": [{"type": "text", "text": text}]}})
            };
            body.push_str(&line.to_string());
            body.push('\n');
        }
        fs::write(&main, &body).unwrap();
        let mut tree = SpendTree::default();
        let began = std::time::Instant::now();
        tree.read(&main, 0).unwrap();
        let full = began.elapsed();
        let mut more = fs::OpenOptions::new().append(true).open(&main).unwrap();
        let call = serde_json::json!({"type": "message", "id": "last", "message": {"role": "assistant", "usage": {"input": 1, "output": 1, "cost": {"total": 0.0}}}});
        std::io::Write::write_all(&mut more, format!("{call}\n").as_bytes()).unwrap();
        let began = std::time::Instant::now();
        tree.read(&main, 0).unwrap();
        let step = began.elapsed();
        eprintln!(
            "MEASURE spend_read bytes={} entries={n} first={full:?} incremental={step:?}",
            body.len()
        );
        fs::remove_dir_all(&dir).unwrap();
    }
}
