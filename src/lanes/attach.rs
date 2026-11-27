//! Files posted as Discord attachments (EVR-42; EVR req. 64-69): a lane's report carries them into
//! its thread, the lead's `post` into a channel or thread. Each file is checked when named (inside a
//! directory the session may post from, the publish path and extension rules, a regular file, the
//! size caps, no secret-shaped text) and read again when posted, so a file that changed in between
//! is left out rather than posted unseen. A lead post is recorded before it is sent and never sent
//! twice.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::docs::{self, POST};
use super::publish::{ALLOWED, part_refused, read_stable};
use super::record::Record;
use super::{Lanes, Posted};
use crate::host::Runtime;
use crate::sys::now_ms;

/// Files one message carries at most (Discord's limit).
pub(crate) const COUNT_MAX: usize = 10;
/// One file at most: Discord's default upload limit per file.
const FILE_MAX: u64 = 20 * 1024 * 1024;
/// All files of one message together: Discord takes 25 MiB per request, the text included.
const TOTAL_MAX: u64 = 24 * 1024 * 1024;
/// Extensions read as text and scanned for secret-shaped strings before they are posted.
const TEXT_KINDS: [&str; 11] = [
    "html", "htm", "css", "js", "mjs", "json", "svg", "md", "markdown", "txt", "csv",
];

/// One checked attachment as recorded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Attachment {
    /// The canonical path.
    pub(crate) path: String,
    /// The name it posts under.
    pub(crate) name: String,
    pub(crate) sha256: String,
    pub(crate) size: u64,
}

/// A file's bytes, ready to post.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct File {
    pub(crate) name: String,
    pub(crate) mime: &'static str,
    pub(crate) bytes: Vec<u8>,
}

/// The record of one lead post, kept so the same text and files in the same place post once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Post {
    room: String,
    files: Vec<Attachment>,
    /// `pending` (sent or about to be, outcome unknown), `posted`, `failed` or `uncertain`.
    state: String,
    why: Option<String>,
    at_ms: i64,
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map_or_default(str::to_ascii_lowercase)
}

/// The content type Discord gets for an allowed extension.
fn mime(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" => "text/javascript",
        "md" | "markdown" => "text/markdown",
        "txt" => "text/plain",
        "csv" => "text/csv",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => "application/octet-stream",
    }
}

/// The name a file posts under: its own, with anything but ASCII letters, digits, `.`, `-` and `_`
/// replaced, so it is safe in a form header and in `attachment://`; a long one keeps its last 100.
fn post_name(real: &Path) -> String {
    let name: Vec<char> = real
        .file_name()
        .map_or_default(|n| n.to_string_lossy())
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let skip = name.len().saturating_sub(100);
    name.into_iter().skip(skip).collect()
}

/// The longest of `roots` holding `path`.
fn root_of<'a>(roots: &'a [PathBuf], path: &Path) -> Option<&'a PathBuf> {
    roots
        .iter()
        .filter(|r| path.starts_with(r))
        .max_by_key(|r| r.as_os_str().len())
}

/// The bytes of an allowed file, refused when a text kind holds a secret-shaped string.
fn read_checked(real: &Path) -> Result<Vec<u8>, String> {
    let bytes = read_stable(real, FILE_MAX, "20 MiB")?;
    if TEXT_KINDS.contains(&extension(real).as_str())
        && let Some(rule) = crate::sys::secrets::find_rule(&bytes)
    {
        return Err(format!("it holds a secret-shaped string ({rule})"));
    }
    Ok(bytes)
}

/// One file: resolved against `base` when relative, inside one of `roots` before and after
/// resolving links, with the publish path and extension rules (EVR req. 65).
fn one(
    given: &str,
    base: Option<&Path>,
    roots: &[PathBuf],
    real_roots: &[PathBuf],
) -> Result<Attachment, String> {
    let named = Path::new(given.trim());
    let joined = if named.is_absolute() {
        named.to_path_buf()
    } else {
        base.ok_or("the path must be absolute")?.join(named)
    };
    if let Some(root) = root_of(roots, &joined)
        && let Ok(below) = joined.strip_prefix(root)
        && let Some(part) = part_refused(below)
    {
        return Err(format!("the path part '{part}' may not be posted"));
    }
    let real = std::fs::canonicalize(&joined).map_err(|e| e.to_string())?;
    let root = root_of(real_roots, &real)
        .ok_or("the file is not inside a directory this session may post from")?;
    let below = real
        .strip_prefix(root)
        .map_err(|_| "the file is not inside its directory")?;
    if let Some(part) = part_refused(below) {
        return Err(format!("the path part '{part}' may not be posted"));
    }
    let ext = extension(&real);
    if !ALLOWED.contains(&ext.as_str()) {
        return Err(format!("the extension '{ext}' is not on the allow list"));
    }
    let bytes = read_checked(&real)?;
    Ok(Attachment {
        path: real.display().to_string(),
        name: post_name(&real),
        sha256: crate::config::sha256_hex(&bytes),
        size: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
    })
}

/// Checks the files one message attaches, all or nothing (EVR req. 65): at most 10, each inside one
/// of `roots`, together at most 24 MiB. Relative paths are read against `base`.
pub(crate) fn check(
    given: &[String],
    base: Option<&Path>,
    roots: &[PathBuf],
) -> Result<Vec<Attachment>, String> {
    if given.len() > COUNT_MAX {
        return Err(format!("attach: at most {COUNT_MAX} files"));
    }
    let real_roots: Vec<PathBuf> = roots
        .iter()
        .filter_map(|r| std::fs::canonicalize(r).ok())
        .collect();
    let mut out: Vec<Attachment> = Vec::with_capacity(given.len());
    let mut total = 0u64;
    for g in given {
        let a = one(g, base, roots, &real_roots).map_err(|e| format!("attach {g}: {e}"))?;
        if out.iter().any(|o| o.path == a.path) {
            return Err(format!("attach {g}: named twice"));
        }
        total = total.saturating_add(a.size);
        if total > TOTAL_MAX {
            return Err("attach: the files are larger than 24 MiB together".into());
        }
        out.push(a);
    }
    Ok(out)
}

/// Recorded attachments read again for the post (EVR req. 66): a file that went away or changed
/// since it was checked is left out, named with the reason.
pub(crate) fn load(list: &[Attachment]) -> (Vec<File>, Vec<String>) {
    let mut files = Vec::with_capacity(list.len());
    let mut left_out = Vec::new();
    for a in list {
        let path = Path::new(&a.path);
        match read_checked(path) {
            Ok(bytes) if crate::config::sha256_hex(&bytes) == a.sha256 => files.push(File {
                name: a.name.clone(),
                mime: mime(&extension(path)),
                bytes,
            }),
            Ok(_) => left_out.push(format!("{} (changed since it was named)", a.name)),
            Err(e) => left_out.push(format!("{} ({e})", a.name)),
        }
    }
    (files, left_out)
}

/// The attachments a report's stored evidence names; none when it names none.
pub(crate) fn of_evidence(evidence: &str) -> Vec<Attachment> {
    serde_json::from_str::<Value>(evidence)
        .ok()
        .and_then(|v| v.get("attach").cloned())
        .and_then(|a| serde_json::from_value(a).ok())
        .unwrap_or_default()
}

/// The note under a post naming the files left out; empty when none were.
pub(crate) fn left_out_note(left_out: &[String]) -> String {
    if left_out.is_empty() {
        String::new()
    } else {
        format!("\n(not attached: {})", left_out.join("; "))
    }
}

impl<R: Runtime> Lanes<R> {
    /// A lane's attachments for a report (EVR req. 64-65): only with a Discord thread, from the
    /// lane's working directory and worktrees, never from another open lane's worktree.
    pub(super) async fn report_attachments(
        &self,
        rec: &Record,
        given: &[String],
    ) -> Result<Vec<Attachment>, String> {
        if given.is_empty() {
            return Ok(Vec::new());
        }
        if !rec
            .thread
            .as_deref()
            .is_some_and(|t| t.starts_with("discord:"))
        {
            return Err(
                "attach: files post only into the lane's Discord thread, and this lane has none"
                    .into(),
            );
        }
        let mut roots = vec![PathBuf::from(&rec.cwd)];
        roots.extend(rec.worktrees.iter().map(PathBuf::from));
        let found = check(given, Some(Path::new(&rec.cwd)), &roots)?;
        for a in &found {
            self.outside_other_worktrees(&rec.key, Path::new(&a.path))
                .await
                .map_err(|e| format!("attach {}: {e}", a.name))?;
        }
        Ok(found)
    }

    /// The working directories and worktrees of the open lanes: where the lead may post files from,
    /// beside its own working directory (EVR req. 67).
    pub(crate) async fn open_dirs(&self) -> Result<Vec<PathBuf>, String> {
        let rows = self
            .env
            .store
            .read(|r| r.lanes(true))
            .await
            .map_err(|e| e.to_string())?;
        let mut dirs = Vec::new();
        for row in rows {
            if let Ok(rec) = serde_json::from_str::<Record>(&row.record) {
                dirs.push(PathBuf::from(&rec.cwd));
                dirs.extend(rec.worktrees.iter().map(PathBuf::from));
            }
        }
        Ok(dirs)
    }

    /// The lead's post of `text` with files into a Discord channel or thread (EVR req. 67-68). The
    /// post is recorded before it is sent; the same text and files in the same place are posted once,
    /// and one in doubt is never sent again.
    pub(crate) async fn post_files(
        &self,
        room: &str,
        text: &str,
        given: &[String],
        base: Option<&Path>,
        roots: &[PathBuf],
    ) -> Result<String, String> {
        if given.is_empty() {
            return Err("attach: name 1 to 10 files; a message without files is an answer".into());
        }
        let found = check(given, base, roots)?;
        let mut identity = format!("{room}\n{text}");
        for a in &found {
            identity.push('\n');
            identity.push_str(&a.sha256);
        }
        let mut id = crate::config::sha256_hex(identity.as_bytes());
        id.truncate(16);
        let store = &self.env.store;
        let expect = match docs::get::<Post>(store, POST, &id).await? {
            None => Some(0),
            Some((p, v)) if p.state == "failed" => Some(v),
            Some((p, _)) if p.state == "posted" => {
                return Ok(format!("post {id} was posted before; not posted again"));
            }
            Some((p, _)) => {
                return Err(format!(
                    "post {id} is {}: it may exist, so it is not posted again",
                    p.state
                ));
            }
        };
        let (files, left_out) = load(&found);
        if !left_out.is_empty() {
            return Err(format!("not posted: {}", left_out.join("; ")));
        }
        let mut doc = Post {
            room: room.to_string(),
            files: found,
            state: "pending".into(),
            why: None,
            at_ms: now_ms(),
        };
        // Recorded before the external effect: a crash from here on leaves it pending, never resent.
        let version = docs::put(store, POST, &id, &doc, expect).await?;
        let outcome = self
            .env
            .threads
            .post(room, text, &format!("lead-post:{id}"), &files)
            .await;
        let (state, why, answer) = match outcome {
            Posted::Confirmed => (
                "posted",
                None,
                Ok(format!("post {id} posted with {} file(s)", files.len())),
            ),
            Posted::Rejected(why) => (
                "failed",
                Some(why.clone()),
                Err(format!("post {id} refused, nothing was posted: {why}")),
            ),
            Posted::Uncertain(why) => (
                "uncertain",
                Some(why.clone()),
                Err(format!(
                    "post {id} is in doubt and is not posted again: {why}"
                )),
            ),
        };
        doc.state = state.into();
        doc.why = why;
        docs::put(store, POST, &id, &doc, Some(version)).await?;
        answer
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("cataly-attach-{}", crate::host::random_hex(6)));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn checks_paths_kinds_sizes_and_secrets() {
        let root = dir();
        let other = dir();
        std::fs::create_dir_all(root.join("mock")).unwrap();
        std::fs::create_dir_all(root.join(".cache")).unwrap();
        std::fs::write(root.join("mock/a b.png"), b"\x89PNG one").unwrap();
        std::fs::write(root.join("mock/notes.txt"), b"plain words").unwrap();
        std::fs::write(root.join(".cache/c.png"), b"x").unwrap();
        std::fs::write(root.join("run.sh"), b"x").unwrap();
        std::fs::write(
            root.join("leak.txt"),
            format!("token ghp_{}", "a".repeat(36)),
        )
        .unwrap();
        std::fs::write(other.join("o.png"), b"x").unwrap();
        std::os::unix::fs::symlink(other.join("o.png"), root.join("link.png")).unwrap();
        let roots = [root.clone()];
        let s = |v: &[&str]| v.iter().map(|x| (*x).to_string()).collect::<Vec<_>>();

        let ok = check(&s(&["mock/a b.png", "mock/notes.txt"]), Some(&root), &roots).unwrap();
        assert_eq!(ok.len(), 2);
        assert_eq!(ok[0].name, "a_b.png");
        assert_eq!(ok[0].size, 8);
        assert_eq!(ok[0].sha256, crate::config::sha256_hex(b"\x89PNG one"));

        let refused = |v: &[&str], want: &str| {
            let e = check(&s(v), Some(&root), &roots).unwrap_err();
            assert!(e.contains(want), "{v:?}: {e}");
        };
        refused(&[".cache/c.png"], "path part '.cache'");
        refused(&["run.sh"], "extension 'sh'");
        refused(&["leak.txt"], "secret-shaped string (GitHub token)");
        refused(&["link.png"], "not inside a directory");
        refused(&["../x.png"], "path part '..'");
        refused(&["mock/a b.png", "mock/a b.png"], "named twice");
        std::fs::create_dir_all(root.join("shot.png")).unwrap();
        refused(&["shot.png"], "not a regular file");
        let o = other.join("o.png").display().to_string();
        refused(&[o.as_str()], "not inside a directory");
        let eleven: Vec<&str> = std::iter::repeat_n("mock/a b.png", 11).collect();
        refused(&eleven, "at most 10 files");
        assert!(
            check(&s(&["mock/notes.txt"]), None, &roots)
                .unwrap_err()
                .contains("absolute")
        );

        let big = root.join("big.png");
        std::fs::File::create(&big)
            .unwrap()
            .set_len(FILE_MAX + 1)
            .unwrap();
        refused(&["big.png"], "larger than 20 MiB");
        let half = |n: &str| {
            std::fs::File::create(root.join(n))
                .unwrap()
                .set_len(13 * 1024 * 1024)
                .unwrap();
        };
        half("h1.png");
        half("h2.png");
        refused(&["h1.png", "h2.png"], "larger than 24 MiB together");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[test]
    fn a_file_changed_since_it_was_named_is_left_out() {
        let root = dir();
        std::fs::write(root.join("a.png"), b"first").unwrap();
        std::fs::write(root.join("b.webp"), b"second").unwrap();
        let named = check(
            &["a.png".to_string(), "b.webp".to_string()],
            Some(&root),
            std::slice::from_ref(&root),
        )
        .unwrap();
        std::fs::write(root.join("a.png"), b"changed").unwrap();
        let (files, left_out) = load(&named);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, "b.webp");
        assert_eq!(files[0].mime, "image/webp");
        assert_eq!(files[0].bytes, b"second");
        assert_eq!(
            left_out,
            vec!["a.png (changed since it was named)".to_string()]
        );
        assert_eq!(
            left_out_note(&left_out),
            "\n(not attached: a.png (changed since it was named))"
        );
        let evidence = serde_json::json!({ "files": [], "attach": named }).to_string();
        assert_eq!(of_evidence(&evidence), named);
        assert_eq!(of_evidence("{\"files\":[]}"), Vec::new());
        let _ = std::fs::remove_dir_all(&root);
    }
}
