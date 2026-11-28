//! Shell rules (LANE-30, EXT-31; LANE req. 72-75; DESIGN 9.1-9.2): the one shell tokeniser, the
//! built-in rule 0 every session's shell obeys (the lead's, each lane's and their subagents'), and
//! for lanes the snapshot taken at open, the verdict on one command and one-attempt grants. Rule 0
//! cannot be granted: no `omp usage reset`, no `omp config set` of a reset setting, and no `cataly`
//! verb beyond the read-only ones and usage requests (`--help`, `-h`). Rule 0 judges the words that
//! run: command words, the words after a runner, command substitutions, and code given to a shell
//! or interpreter (its arguments, here-documents and piped input). Arguments of other commands,
//! quoted here-document bodies and comments are text. A line that runs the session's own bridge
//! tool by name (`cataly_lead`, `cataly_lane`), which OMP offers only as a direct call, is refused
//! with a pointer to that call. Rule 0 guards against mistakes, not against deliberate escape; the
//! control socket's roles are the boundary (DESIGN 8).

use std::collections::HashMap;

use super::record::Grant;
use crate::cli::args::Invocation;

/// `cataly` verbs a session's shell may run (DESIGN 8).
const READ_ONLY: [&str; 5] = ["status", "events", "stats", "version", "help"];
/// `cataly` verbs that change something; after a command word the hub cannot resolve, one of them
/// fails closed.
const WRITES: [&str; 19] = [
    "config",
    "discord",
    "hub",
    "install",
    "job",
    "lane",
    "lead",
    "pr",
    "quota",
    "rollback",
    "service",
    "setup",
    "slack",
    "slot",
    "telegram",
    "uninstall",
    "update",
    "voice",
    "home",
];
/// Shell keywords after which the next word stands in command position.
const KEYWORDS: [&str; 9] = [
    "if", "then", "else", "elif", "while", "until", "do", "!", "{",
];
/// Commands that run another command named among their arguments: after one of them every later
/// word of the segment is judged as a possible command.
const RUNNERS: [&str; 25] = [
    "env", "command", "exec", "nohup", "sudo", "doas", "time", "nice", "ionice", "timeout",
    "stdbuf", "setsid", "xargs", "find", "watch", "flock", "parallel", "eval", "sh", "bash", "zsh",
    "dash", "ksh", "su", "ssh",
];
/// Commands that run code they are given: shells, `eval`, runners that take a command line, `ssh`,
/// containers, `tmux` and script interpreters. Their phrases (words with spaces), here-documents
/// and piped input are judged as command lines, and inside that code every phrase is judged too.
const CODE: [&str; 21] = [
    "eval", "sh", "bash", "zsh", "dash", "ksh", "su", "ssh", "watch", "flock", "parallel",
    "docker", "podman", "kubectl", "tmux", "python", "python3", "node", "perl", "ruby", "awk",
];
/// Nesting depth for quoted commands and command substitutions.
const NESTING: usize = 4;

/// A simple command as the shell splits it: its words, with quotes removed and backslash escapes
/// applied (`${…}` and `$(…)` stay in their word, which leaves it unresolved), and the bodies of
/// its here-documents.
#[derive(Debug, Default)]
struct Segment {
    words: Vec<String>,
    input: Vec<String>,
}

/// One shell line as pipelines of segments joined by `|`. `;`, `&`, `&&`, `||`, `(`, `)` and line
/// breaks end a pipeline; a `#` that starts a word comments out the rest of its line. Every command
/// substitution (`$(…)` or backquotes, bare, in double quotes or in an unquoted here-document) adds
/// the pipelines of its own command line; single-quoted text, quoted here-document bodies and
/// comments add none.
#[derive(Debug, Default)]
struct Line {
    pipelines: Vec<Vec<Segment>>,
    /// A substitution nested deeper than [`NESTING`]; the rest of the line was not read.
    deep: bool,
}

/// A here-document whose body starts after the next line break.
#[derive(Debug)]
struct Heredoc {
    delimiter: String,
    /// The delimiter was quoted, so the body is text without substitutions.
    quoted: bool,
    /// `<<-`: leading tabs are stripped.
    strip: bool,
    /// The segment it feeds, as indexes into the line's pipelines.
    pipeline: usize,
    segment: usize,
}

#[derive(Debug, Default)]
struct Lexer<'a> {
    chars: &'a [char],
    at: usize,
    depth: usize,
    /// Inside `$(…)`: the `(` opened since, which decide the `)` that closes it.
    parens: Option<usize>,
    line: Line,
    /// Pipelines of the substitutions read so far, added after the line's own.
    subs: Vec<Vec<Segment>>,
    pipe: Vec<Segment>,
    words: Vec<String>,
    word: String,
    started: bool,
    /// The word being read has a quoted or escaped part.
    quoted: bool,
    /// The open quote, `'` or `"`.
    quote: Option<char>,
    /// After `<<` (`Some(false)`) or `<<-` (`Some(true)`): the next word is a delimiter.
    delimiter: Option<bool>,
    pending: Vec<Heredoc>,
}

fn lex(command: &str, depth: usize) -> Line {
    let chars: Vec<char> = command.chars().collect();
    Lexer::new(&chars, 0, depth, None).run().0
}

impl<'a> Lexer<'a> {
    fn new(chars: &'a [char], at: usize, depth: usize, parens: Option<usize>) -> Self {
        Lexer {
            chars,
            at,
            depth,
            parens,
            ..Lexer::default()
        }
    }

    /// Reads to the end of the text, or up to the `)` that closes a substitution; returns the line
    /// and the index where reading stopped.
    fn run(mut self) -> (Line, usize) {
        let chars = self.chars;
        while let Some(&c) = chars.get(self.at) {
            self.at += 1;
            let next = chars.get(self.at).copied();
            if self.quote == Some('\'') {
                if c == '\'' {
                    self.quote = None;
                } else {
                    self.word.push(c);
                }
                continue;
            }
            match (self.quote.is_some(), c) {
                (true, '"') => self.quote = None,
                (true, '\\')
                    if next.is_some_and(|n| matches!(n, '"' | '\\' | '$' | '`' | '\n')) =>
                {
                    self.at += 1;
                    self.word.extend(next.filter(|n| *n != '\n'));
                }
                (_, '$') if next == Some('(') => {
                    self.at = self.substitution(chars, self.at + 1);
                    self.push_substitution();
                }
                (_, '`') => {
                    self.at = self.backquoted(chars, self.at);
                    self.push_substitution();
                }
                (true, c) => self.word.push(c),
                (false, '\'' | '"') => {
                    self.quote = Some(c);
                    self.started = true;
                    self.quoted = true;
                }
                (false, '\\') => self.escape(next),
                (false, '$') if next == Some('{') => self.braced(),
                (false, '#') if !self.started => {
                    while chars.get(self.at).is_some_and(|c| *c != '\n') {
                        self.at += 1;
                    }
                }
                (false, '<') if next == Some('<') => self.double_less(),
                (false, '&' | '|')
                    if self.word.ends_with(['<', '>']) || (c == '&' && next == Some('>')) =>
                {
                    self.word.push(c);
                    self.started = true;
                }
                (false, '|') if next == Some('|') => {
                    self.at += 1;
                    self.end_pipeline();
                }
                (false, '|') => {
                    if next == Some('&') {
                        self.at += 1;
                    }
                    self.end_segment();
                }
                (false, '&') => {
                    if next == Some('&') {
                        self.at += 1;
                    }
                    self.end_pipeline();
                }
                (false, '(') => {
                    if let Some(open) = self.parens.as_mut() {
                        *open += 1;
                    }
                    self.end_pipeline();
                }
                (false, ')') if self.parens == Some(0) => {
                    self.at -= 1;
                    break;
                }
                (false, ')') => {
                    self.parens = self.parens.map(|open| open.saturating_sub(1));
                    self.end_pipeline();
                }
                (false, ';') => self.end_pipeline(),
                (false, '\n') => self.line_break(),
                (false, c) if c.is_whitespace() => self.end_word(),
                (false, c) => {
                    self.word.push(c);
                    self.started = true;
                }
            }
        }
        self.end_pipeline();
        let stop = self.at;
        self.line.pipelines.append(&mut self.subs);
        (self.line, stop)
    }

    /// An unquoted backslash before `next`: escapes it, or joins lines.
    fn escape(&mut self, next: Option<char>) {
        if let Some(n) = next {
            self.at += 1;
            if n != '\n' {
                self.word.push(n);
                self.started = true;
                self.quoted = true;
            }
        }
    }

    /// `${…}` stays in its word.
    fn braced(&mut self) {
        self.word.push('$');
        while let Some(&inner) = self.chars.get(self.at) {
            self.at += 1;
            self.word.push(inner);
            if inner == '}' {
                break;
            }
        }
        self.started = true;
    }

    /// `<<` or `<<-` opens a here-document whose delimiter is the next word; `<<<` stays a word.
    fn double_less(&mut self) {
        let third = self.chars.get(self.at + 1).copied();
        if third == Some('<') {
            self.word.push_str("<<<");
            self.at += 2;
            self.started = true;
            return;
        }
        let strip = third == Some('-');
        self.end_word();
        self.words
            .push(if strip { "<<-" } else { "<<" }.to_string());
        self.at += 1 + usize::from(strip);
        self.delimiter = Some(strip);
    }

    /// A substitution leaves `$()` in its word: the word stays unresolved, and the command inside,
    /// judged on its own already, is not judged again as part of the word.
    fn push_substitution(&mut self) {
        self.word.push_str("$()");
        self.started = true;
    }

    fn adopt(&mut self, line: Line) {
        self.line.deep |= line.deep;
        self.subs.extend(line.pipelines);
    }

    /// Lexes the command line of a `$(…)` that starts at `from` in `chars` and keeps its
    /// pipelines; returns the index past its `)`.
    fn substitution(&mut self, chars: &[char], from: usize) -> usize {
        if self.depth >= NESTING {
            self.line.deep = true;
            return chars.len();
        }
        let (line, stop) = Lexer::new(chars, from, self.depth + 1, Some(0)).run();
        self.adopt(line);
        (stop + 1).min(chars.len())
    }

    /// Lexes the command line between backquotes that starts at `from` in `chars`, with `` \` ``,
    /// `\\` and `\$` unescaped, and keeps its pipelines; returns the index past the closing
    /// backquote.
    fn backquoted(&mut self, chars: &[char], from: usize) -> usize {
        let mut inner = String::new();
        let mut at = from;
        while let Some(&c) = chars.get(at) {
            at += 1;
            match c {
                '`' => break,
                '\\' if chars.get(at).is_some_and(|n| matches!(n, '`' | '\\' | '$')) => {
                    inner.extend(chars.get(at));
                    at += 1;
                }
                c => inner.push(c),
            }
        }
        if self.depth >= NESTING {
            self.line.deep = true;
            return chars.len();
        }
        self.adopt(lex(&inner, self.depth + 1));
        at
    }

    fn end_word(&mut self) {
        if !self.started {
            return;
        }
        let word = std::mem::take(&mut self.word);
        if let Some(strip) = self.delimiter.take() {
            self.pending.push(Heredoc {
                delimiter: word.clone(),
                quoted: self.quoted,
                strip,
                pipeline: self.line.pipelines.len(),
                segment: self.pipe.len(),
            });
        }
        self.words.push(word);
        self.started = false;
        self.quoted = false;
    }

    fn end_segment(&mut self) {
        self.end_word();
        if !self.words.is_empty() {
            let words = std::mem::take(&mut self.words);
            self.pipe.push(Segment {
                words,
                input: Vec::new(),
            });
        }
    }

    fn end_pipeline(&mut self) {
        self.end_segment();
        if !self.pipe.is_empty() {
            let pipe = std::mem::take(&mut self.pipe);
            self.line.pipelines.push(pipe);
        }
    }

    /// A line break ends the pipeline unless it follows `|`; the bodies of the here-documents
    /// opened on the line follow it.
    fn line_break(&mut self) {
        if self.started || !self.words.is_empty() || self.pipe.is_empty() {
            self.end_pipeline();
        }
        let chars = self.chars;
        for doc in std::mem::take(&mut self.pending) {
            let mut body = String::new();
            while self.at < chars.len() {
                let end = chars
                    .get(self.at..)
                    .and_then(|rest| rest.iter().position(|c| *c == '\n'))
                    .map_or(chars.len(), |i| self.at + i);
                let line: String = chars.get(self.at..end).unwrap_or_default().iter().collect();
                self.at = end + 1;
                let text = if doc.strip {
                    line.trim_start_matches('\t')
                } else {
                    line.as_str()
                };
                if text == doc.delimiter {
                    break;
                }
                body.push_str(text);
                body.push('\n');
            }
            if !doc.quoted {
                self.expansions(&body);
            }
            let segment = if doc.pipeline == self.line.pipelines.len() {
                self.pipe.get_mut(doc.segment)
            } else {
                self.line
                    .pipelines
                    .get_mut(doc.pipeline)
                    .and_then(|pipe| pipe.get_mut(doc.segment))
            };
            if let Some(segment) = segment {
                segment.input.push(body);
            }
        }
    }

    /// Keeps the command substitutions of an unquoted here-document body.
    fn expansions(&mut self, body: &str) {
        let chars: Vec<char> = body.chars().collect();
        let mut at = 0;
        while let Some(&c) = chars.get(at) {
            at += 1;
            match c {
                '\\' => at += 1,
                '$' if chars.get(at) == Some(&'(') => at = self.substitution(&chars, at + 1),
                '`' => at = self.backquoted(&chars, at),
                _ => {}
            }
        }
    }
}

/// `NAME=value` as (name, value), when `word` is an assignment.
fn assignment(word: &str) -> Option<(&str, &str)> {
    let (name, value) = word.split_once('=')?;
    let mut chars = name.chars();
    let first = chars.next()?;
    ((first.is_ascii_alphabetic() || first == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_'))
    .then_some((name, value))
}

/// Whether `word` is a redirection, and if so whether its target is the next word.
fn redirection(word: &str) -> Option<bool> {
    let op = word.trim_start_matches(|c: char| c.is_ascii_digit());
    let op = op.strip_prefix('&').unwrap_or(op);
    op.starts_with(['<', '>']).then_some(matches!(
        op,
        "<" | ">" | ">>" | ">|" | "<>" | "<<" | "<<-" | "<<<" | "<&" | ">&"
    ))
}

/// `word` with `$NAME` and `${NAME}` replaced from the assignments seen so far; `None` when it still
/// expands something the hub cannot know (another variable, a substitution).
fn resolve(word: &str, vars: &HashMap<String, String>) -> Option<String> {
    let mut out = String::new();
    let mut rest = word;
    while let Some(at) = rest.find('$') {
        out.push_str(rest.get(..at)?);
        let after = rest.get(at + 1..)?;
        let (name, tail) = if let Some(braced) = after.strip_prefix('{') {
            let close = braced.find('}')?;
            (braced.get(..close)?, braced.get(close + 1..)?)
        } else {
            let len = after
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                .unwrap_or(after.len());
            (after.get(..len)?, after.get(len..)?)
        };
        out.push_str(vars.get(name)?);
        rest = tail;
    }
    out.push_str(rest);
    Some(out)
}

fn base(word: &str) -> &str {
    word.rsplit('/').next().unwrap_or(word)
}

fn phrase(word: &str) -> bool {
    word.chars().any(char::is_whitespace)
}

/// Whether the words after `omp` ask it to spend a saved reset: `usage` and `reset` in any order, or
/// `config set` of a `*Resets*` setting.
fn omp_spends(args: &[String]) -> bool {
    let has = |w: &str| args.iter().any(|a| a == w);
    (has("usage") && has("reset"))
        || (has("config") && has("set") && args.iter().any(|a| a.to_lowercase().contains("resets")))
}

/// Whether the words after `cataly` may change anything: any verb but the read-only ones, unless
/// the CLI's own parser reads the words as a usage request (`--help` or `-h` after any verb, not
/// taken as a flag's value), which prints usage and runs nothing. Bare `cataly` counts, because a
/// runner such as `xargs` adds words to it.
fn cataly_writes(args: &[String]) -> bool {
    let read_only = args
        .first()
        .is_some_and(|verb| READ_ONLY.contains(&verb.as_str()));
    !read_only
        && (args.is_empty() || !matches!(crate::cli::args::parse(args), Ok(Invocation::Help(_))))
}

/// A segment as rule 0 reads it: its words past leading assignments, resolved where they can be.
struct Command<'a> {
    raw: &'a [String],
    words: Vec<Option<String>>,
    input: &'a [String],
}

impl<'a> Command<'a> {
    /// Reads `segment`, recording its leading assignments in `vars`.
    fn new(segment: &'a Segment, vars: &mut HashMap<String, String>) -> Self {
        let mut at = 0;
        while let Some((name, value)) = segment.words.get(at).and_then(|w| assignment(w)) {
            if let Some(v) = resolve(value, vars) {
                vars.insert(name.to_string(), v);
            } else {
                vars.remove(name);
            }
            at += 1;
        }
        let raw = segment.words.get(at..).unwrap_or_default();
        Command {
            raw,
            words: raw.iter().map(|w| resolve(w, vars)).collect(),
            input: &segment.input,
        }
    }

    /// The index of the command word: past shell keywords, assignments and redirections.
    fn position(&self) -> usize {
        let mut at = 0;
        while let Some(Some(word)) = self.words.get(at) {
            if KEYWORDS.contains(&word.as_str()) || assignment(word).is_some() {
                at += 1;
            } else if let Some(target) = redirection(word) {
                at += 1 + usize::from(target);
            } else {
                break;
            }
        }
        at
    }

    /// Whether rule 0 refuses the command, and whether it takes code. The command word, and after
    /// a runner every later word, is judged by name, and as a command line when a variable expanded
    /// it to a phrase; a word the hub cannot resolve fails closed on a mutating word after it and
    /// counts as taking code. Inside code (`in_code`) every command takes code.
    fn judge(&self, depth: usize, in_code: bool) -> (bool, bool) {
        let at = self.position();
        let Some(command) = self.words.get(at) else {
            return (false, false);
        };
        let rest = |from: usize| -> Vec<String> {
            self.words
                .iter()
                .skip(from)
                .map(|w| w.clone().unwrap_or_default())
                .collect()
        };
        let runner = command
            .as_deref()
            .is_some_and(|c| RUNNERS.contains(&base(c)));
        let end = if runner { self.words.len() } else { at + 1 };
        let (mut blocked, mut code) = (false, in_code);
        for (i, word) in self.words.iter().enumerate().take(end).skip(at) {
            let args = rest(i + 1);
            if let Some(w) = word {
                blocked |= match base(w) {
                    "cataly" => cataly_writes(&args),
                    "omp" => omp_spends(&args),
                    // A variable holding a phrase splits into words.
                    _ => {
                        phrase(w)
                            && self.raw.get(i).is_some_and(|raw| !phrase(raw))
                            && blocked_at(w, depth + 1, in_code)
                    }
                };
                code |= CODE.contains(&base(w));
            } else {
                blocked |=
                    args.first().is_some_and(|a| WRITES.contains(&a.as_str())) || omp_spends(&args);
                code = true;
            }
        }
        (blocked || (code && self.code_blocked(at, depth)), code)
    }

    /// Whether a phrase among the words from `from` on, or a here-document, is refused as a
    /// command line.
    fn code_blocked(&self, from: usize, depth: usize) -> bool {
        self.words
            .iter()
            .zip(self.raw)
            .skip(from)
            .map(|(w, raw)| w.as_deref().unwrap_or(raw))
            .any(|w| phrase(w) && blocked_at(w, depth + 1, true))
            || self
                .input
                .iter()
                .any(|body| blocked_at(body, depth + 1, true))
    }
}

/// Rule 0 for one command line. A pipeline into a command that takes code also has the phrases
/// and here-documents of the commands before it judged as command lines.
fn blocked_at(command: &str, depth: usize, in_code: bool) -> bool {
    if depth > NESTING {
        return true;
    }
    let line = lex(command, depth);
    let mut vars = HashMap::new();
    line.deep
        || line.pipelines.iter().any(|pipe| {
            let commands: Vec<Command> = pipe.iter().map(|s| Command::new(s, &mut vars)).collect();
            let judged: Vec<(bool, bool)> =
                commands.iter().map(|c| c.judge(depth, in_code)).collect();
            judged.iter().any(|(blocked, _)| *blocked)
                || judged.iter().enumerate().any(|(k, (_, code))| {
                    *code
                        && commands
                            .iter()
                            .take(k)
                            .any(|c| c.code_blocked(c.position() + 1, depth))
                })
        })
}

/// The built-in rule 0 (DESIGN 9.2): whether `command` would spend a saved reset or run a `cataly`
/// verb that changes anything.
pub(crate) fn rule_zero(command: &str) -> bool {
    blocked_at(command, 0, false)
}

/// Whether a segment of `command` runs the session's own bridge tool `tool` by name, past leading
/// assignments. OMP offers that tool only as a direct call (`loadMode: essential`, DESIGN 12.2 A13),
/// so in the shell the name is no command: the shell veto refuses such a line before OMP would ask
/// about it and tells the model to call the tool. A path or a runner in front reaches a program on
/// `PATH` and is judged as usual; the Cataly CLI never matches.
pub(crate) fn runs_tool(command: &str, tool: &str) -> bool {
    lex(command, 0).pipelines.iter().flatten().any(|segment| {
        segment
            .words
            .iter()
            .find(|w| assignment(w).is_none())
            .is_some_and(|w| w == tool)
    })
}

/// The verdict on one command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Verdict {
    pub(crate) allowed: bool,
    /// Rule numbers that matched: 0 built in, 1.. the configured deny patterns.
    pub(crate) rules: Vec<usize>,
    /// SHA-256 of the command; the text itself is never stored.
    pub(crate) digest: String,
    /// Grants this attempt used up.
    pub(crate) used: Vec<usize>,
}

/// A lane-key glob: only `*` is special (LANE req. 72).
pub(crate) fn glob(pattern: &str, key: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    let (Some(first), Some(last)) = (parts.first(), parts.last()) else {
        return false;
    };
    if parts.len() == 1 {
        return pattern == key;
    }
    if !key.starts_with(first) || key.len() < first.len() + last.len() || !key.ends_with(last) {
        return false;
    }
    let mut at = first.len();
    let end = key.len() - last.len();
    for mid in parts.iter().skip(1).take(parts.len().saturating_sub(2)) {
        match key.get(at..end).and_then(|rest| rest.find(mid)) {
            Some(i) => at += i + mid.len(),
            None => return false,
        }
    }
    true
}

/// Judges one command against the lane's snapshot and grants; marks the grants an allowed attempt
/// uses (LANE req. 74-75).
pub(crate) fn judge(
    command: &str,
    deny: &[regex::Regex],
    allow: &[regex::Regex],
    grants: &mut [Grant],
) -> Verdict {
    let digest = crate::config::sha256_hex(command.as_bytes());
    let mut rules = Vec::new();
    if rule_zero(command) {
        rules.push(0);
    }
    let allowed_whole = allow.iter().any(|re| {
        re.find(command)
            .is_some_and(|m| m.start() == 0 && m.end() == command.len())
    });
    if !allowed_whole {
        rules.extend(
            deny.iter()
                .enumerate()
                .filter(|(_, re)| re.is_match(command))
                .map(|(i, _)| i + 1),
        );
    }
    let granted = |rule: usize, grants: &[Grant]| {
        grants
            .iter()
            .position(|g| !g.used && g.rule == rule && g.digest == digest)
    };
    let covered = !rules.is_empty()
        && !rules.contains(&0)
        && rules.iter().all(|r| granted(*r, grants).is_some());
    let mut used = Vec::new();
    if covered {
        for rule in &rules {
            if let Some(i) = granted(*rule, grants)
                && let Some(g) = grants.get_mut(i)
            {
                g.used = true;
                used.push(*rule);
            }
        }
    }
    Verdict {
        allowed: rules.is_empty() || covered,
        rules,
        digest,
        used,
    }
}

/// The blocker text the lane sees: rule numbers and a digest only (LANE req. 74, EXT req. 33).
pub(crate) fn blocker(v: &Verdict) -> String {
    let rules: Vec<String> = v
        .rules
        .iter()
        .map(|r| {
            if *r == 0 {
                "0 (built in)".into()
            } else {
                r.to_string()
            }
        })
        .collect();
    format!(
        "Blocked by shell rule {} (command sha256 {}). No command ran. Report a blocker \
         (kind waiting); only the lead or owner can grant one attempt.",
        rules.join(", "),
        v.digest.get(..16).unwrap_or_default()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn re(s: &str) -> regex::Regex {
        regex::Regex::new(s).unwrap()
    }

    fn words(command: &str) -> Vec<Vec<String>> {
        lex(command, 0)
            .pipelines
            .into_iter()
            .flatten()
            .map(|s| s.words)
            .collect()
    }

    #[test]
    fn deny_allow_built_ins_and_one_attempt_grants() {
        let deny = [re("git push"), re("rm -rf")];
        let allow = [re("git push origin feature")];
        let mut grants = Vec::new();
        assert!(judge("ls -la", &deny, &[], &mut grants).allowed);
        let v = judge("git push --force && rm -rf /", &deny, &[], &mut grants);
        assert!(!v.allowed);
        assert_eq!(v.rules, [1, 2]);
        assert!(!blocker(&v).contains("git push"));
        assert!(judge("git push origin feature", &deny, &allow, &mut grants).allowed);
        assert!(
            !judge(
                "git push origin feature; rm -rf /",
                &deny,
                &allow,
                &mut grants
            )
            .allowed
        );
        for cmd in [
            "omp usage reset",
            "/usr/bin/cataly lane close x",
            "x; cataly lead stop",
        ] {
            assert_eq!(judge(cmd, &deny, &[], &mut grants).rules, [0], "{cmd}");
        }
        assert!(judge("cataly status", &deny, &[], &mut grants).allowed);
        // One grant per matching rule, used up by the next identical attempt.
        let cmd = "git push origin main";
        let digest = judge(cmd, &deny, &[], &mut grants).digest;
        grants.push(Grant {
            rule: 1,
            digest,
            reason: "ok".into(),
            used: false,
        });
        let first = judge(cmd, &deny, &[], &mut grants);
        assert!(first.allowed && first.used == [1]);
        assert!(!judge(cmd, &deny, &[], &mut grants).allowed);
        assert!(glob("web-*", "web-1") && glob("*", "x") && !glob("web-*", "api-1"));
        assert!(glob("a*b*c", "a-b-c") && !glob("a*b*c", "a-c"));
    }

    #[test]
    fn one_tokeniser_splits_like_the_shell() {
        assert_eq!(
            words(r#"a 'b c' "d\"e" x\ y; f|g && $(h i) `j`"#),
            [
                vec!["a", "b c", "d\"e", "x y"],
                vec!["f"],
                vec!["g"],
                vec!["$()", "$()"],
                vec!["h", "i"],
                vec!["j"]
            ]
        );
        assert_eq!(words("echo ${a}b $c"), [vec!["echo", "${a}b", "$c"]]);
        assert_eq!(
            words("echo \"a $(b \"c d\") e\" 'f $(g)' 2>&1 &>/dev/null # h"),
            [
                vec!["echo", "a $() e", "f $(g)", "2>&1", "&>/dev/null"],
                vec!["b", "c d"]
            ]
        );
        // Here-document bodies are the input of their segment; only an unquoted one substitutes.
        let line = lex("cat <<'A' | wc; x <<-B\nso `c d`\nA\n\t$(e f)\n\tB\ng", 0);
        let segments: Vec<&Segment> = line.pipelines.iter().flatten().collect();
        assert_eq!(segments.len(), 5);
        assert_eq!(segments[0].words, ["cat", "<<", "A"]);
        assert_eq!(segments[0].input, ["so `c d`\n"]);
        assert_eq!(segments[1].words, ["wc"]);
        assert_eq!(segments[2].words, ["x", "<<-", "B"]);
        assert_eq!(segments[2].input, ["$(e f)\n"]);
        assert_eq!(segments[3].words, ["g"]);
        assert_eq!(segments[4].words, ["e", "f"]);
    }

    #[test]
    fn rule_zero_ignores_order_and_follows_indirection() {
        for cmd in [
            "omp usage --json reset",
            "omp usage -p anthropic reset",
            "omp config set claudeResets.autoRedeem5h yes",
            "c=cataly; $c lane close x",
            "c=cata; ${c}ly lane close x",
            "$TOOL lane close x",
            "env FOO=1 cataly job disable a",
            "sh -c 'cataly voice restart'",
            "echo \"$(cataly lead send hi)\"",
            "if true; then cataly discord release r; fi",
            "cata\\ly job enable a --ack",
            "x=1 /opt/bin/cataly setup --yes",
            "o=omp; $o usage reset",
            "X=\"cataly lane close x\"; $X",
            "C=\"cataly lane\"; $C close x",
        ] {
            assert!(rule_zero(cmd), "{cmd}");
        }
        for cmd in [
            "cataly status",
            "c=cataly; $c events",
            "omp usage --json",
            "omp config set theme dark",
            "git commit -m \"make cataly faster\"",
            "ls $HOME && $PYTHON -m pip install x",
        ] {
            assert!(!rule_zero(cmd), "{cmd}");
        }
    }

    #[test]
    fn rule_zero_passes_cataly_words_that_are_only_text() {
        for cmd in [
            // A lane's commit message in a quoted here-document.
            "git commit -q -F - <<'EOF'\nfix(update): keep the channel\n\nso `cataly update` still \
             moves to the next official version\nEOF",
            // The lead's searches: a regular expression is an argument.
            "grep -n -iE 'cataly verb|read-only|shell' DESIGN.md src/lanes/shell.rs",
            "sed -n '470,520p' DESIGN.md | grep -n -iE 'role|owner|lead|cataly verb|read-only|shell'",
            // The lead's PR comment body.
            "gh pr comment 42 -R vntrevx/Cataly --body-file - <<'EOF'\nRun `cataly lane \
             profile-create` first.\nEOF",
            "cat > /tmp/body.md <<-\"EOF\"\n\t$(cataly update) stays text\n\tEOF",
            // Usage requests run nothing.
            "cataly --help 2>&1 | grep -n setup",
            "cataly setup --help",
            "cataly lane close -h",
            "cataly job run --help",
            // Arguments and comments.
            "git commit -m \"make cataly update faster\"",
            "git commit -m 'note: $(cataly update) and `cataly update`'",
            "echo 'cataly lane close x'",
            "printf '%s\\n' \"cataly update\" > notes.txt",
            "if grep -q 'cataly update' CHANGELOG.md; then echo yes; fi",
            "while read -r line; do echo \"$line\"; done < 'cataly lane close'",
            "cat <<EOF\ncataly update\nEOF",
            "echo hi # cataly update",
            "xargs grep -l 'cataly update' < files.txt",
            "find . -name '*.rs' -exec grep -l 'cataly lane close' {} +",
            "rg -n 'cataly (update|setup)' docs | head",
            "\"$(git rev-parse --show-toplevel)/run.sh\" 'a b'",
            "bash -c \"$(cat script.sh)\"",
            "docker build -t cataly .",
            "bash -c 'cataly status'",
            "x=$(cataly status --json) && echo \"$x\"",
            "cat <<'EOF' | wc -l\ncataly update\nEOF",
        ] {
            assert!(!rule_zero(cmd), "{cmd}");
        }
    }

    #[test]
    fn rule_zero_judges_code_substitutions_and_runners() {
        for cmd in [
            // Code given to a shell, an interpreter or a runner, nested too.
            "bash -c \"cataly update\"",
            "sh -c \"cataly lane close $X\"",
            "sudo -u me bash -c 'if true; then cataly lead stop; fi'",
            "sh -c \"bash -c 'cataly update'\"",
            "xargs -I{} sh -c 'cataly lane close {}'",
            "find . -exec cataly lane close {} \\;",
            "ls | xargs cataly",
            "timeout 5 cataly update",
            "eval 'cataly update'",
            "ssh worker 'cataly update'",
            "python3 -c \"import subprocess; subprocess.run('cataly update', shell=True)\"",
            "awk 'BEGIN { system(\"cataly update\") }'",
            "docker exec box sh -c 'cataly update'",
            "tmux send-keys -t lane 'cataly lane close x' Enter",
            "sh -c '$(cataly update)'",
            // Substitutions run wherever the shell expands them.
            "echo $(cataly update)",
            "echo \"`cataly update`\"",
            "git commit -m \"see `cataly update`\"",
            "echo \"$(echo \"$(cataly update)\")\"",
            "cat <<EOF\nnow $(cataly lane close x)\nEOF",
            "cat <<EOF\nnow `cataly update`\nEOF",
            // Input a shell reads as code.
            "bash <<'EOF'\ncataly update\nEOF",
            "cat <<'EOF' | sh\ncataly update\nEOF",
            "echo 'cataly lane close x' | bash",
            "printf '%s\\n' 'cataly update' |\n  sudo sh",
            "$SHELL <<< 'cataly update'",
            // Command position past keywords and redirections.
            "! cataly update",
            "{ cataly update; }",
            "while true; do cataly update; done",
            "> /tmp/log cataly update",
            "2>/dev/null cataly update",
            "(cd x && cataly update)",
            "diff <(cataly status) <(cataly lane close x)",
            // A flag's value is not a usage request.
            "cataly config check --file --help",
            // Nesting beyond the limit fails closed.
            "echo $(echo $(echo $(echo $(echo $(echo $(ls))))))",
        ] {
            assert!(rule_zero(cmd), "{cmd}");
        }
    }

    #[test]
    fn a_line_that_runs_the_sessions_own_tool_by_name_is_found() {
        // The owner's lead's lines (DESIGN 12.2 A13), with redirections, pipes and chains.
        for cmd in [
            "cataly_lead onboarding.start 2>&1; echo ---; cataly_lead requests 2>&1",
            "cataly_lead question.ask --help 2>&1 | head -30",
            "cataly_lead --help 2>&1 | head -60",
            "cataly_lead request.close --id 1 --text \"a; b\" 2>&1; cataly_lead request.next --id 2",
            "ls && X=1 cataly_lead requests",
            "cataly_lead requests; cataly lead send hi",
        ] {
            assert!(runs_tool(cmd, "cataly_lead"), "{cmd}");
        }
        assert!(runs_tool(
            "cataly_lane report --kind progress",
            "cataly_lane"
        ));
        for cmd in [
            "cataly lead send hi",
            "cataly onboarding.start",
            "/usr/bin/cataly_lead requests",
            "env cataly_lead requests",
            "grep -rn cataly_lead src",
            "echo 'cataly_lead requests'",
            "cat <<'EOF'\ncataly_lead requests\nEOF",
            "cataly_lane report",
            "",
        ] {
            assert!(!runs_tool(cmd, "cataly_lead"), "{cmd}");
        }
    }
}
