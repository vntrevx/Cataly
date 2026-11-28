//! What the owner hears directly while the lead cannot start: once when a start passes the 15 s
//! notice, and once per hold. Both go to his home room as hub events, never only through the lead,
//! which is the session that is not available. The words are in his language and say that the
//! conversation and work are kept and how to go on after fixing the cause; a fresh lead is never
//! the suggested repair. What was said survives a hub restart, so a hold that a restart or an
//! update finds again is not told again. `cataly lead status` and `cataly health` show the same
//! hold text.

use tokio::sync::{mpsc, watch};

use super::{AnchorView, Events, LEAD};
use crate::config::{Config, Language};
use crate::jobs::event::{Emit, EventKind, Severity};
use crate::log;
use crate::store::host::episode::Episode;
use crate::store::{Apply, MemoryWrite, Store};

/// The memory that keeps what the owner was told; no configured job has this name.
const JOB: &str = "@lead";
const SUBJECT: &str = "notice";
const HELD: &str = "held";
const SLOW: &str = "slow";
const UNVERIFIED: &str = "unverified";

/// What the notice task is asked to do, in order.
#[derive(Debug)]
pub(super) enum Notice {
    /// A start passed the 15 s notice: the attempt's handle and the session it resumes.
    Slow {
        handle: String,
        session: Option<String>,
    },
    /// The lead is held, with the reason the hub gave.
    Held(String),
    /// The lead bound a session: a later hold is a new one.
    Bound,
    /// The lead bound with a model its bridge could not check: told once per reason, not again
    /// on a later start or after a hub restart (HOST req. 27).
    Unverified(String),
}

/// The sending side, kept by the lead; the task takes the receiver once.
pub(super) struct Notices {
    tx: mpsc::UnboundedSender<Notice>,
    rx: std::sync::Mutex<Option<mpsc::UnboundedReceiver<Notice>>>,
}

impl Default for Notices {
    fn default() -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        Self {
            tx,
            rx: std::sync::Mutex::new(Some(rx)),
        }
    }
}

impl Notices {
    pub(super) fn send(&self, notice: Notice) {
        // Closed only when the hub's runtime shuts down.
        let _ = self.tx.send(notice);
    }

    pub(super) fn take(&self) -> Option<mpsc::UnboundedReceiver<Notice>> {
        self.rx
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
    }
}

/// A hold as the owner hears it: what identifies it across hub restarts, and its reason. A hold
/// of the recovery episode (a rejected start, the retries spent, the owner's stop) is that
/// episode's, whose reason is the first cause, not the "recovery is held" a restart finds; any
/// other hold is its reason.
pub(crate) fn hold(episode: Option<&Episode>, reason: &str) -> (String, String) {
    match episode {
        Some(e) if e.state != "active" && e.state != "bound" => (
            format!("episode:{}:{}:{}", e.session_id, e.started_ms, e.state),
            e.detail.clone().unwrap_or_else(|| reason.to_string()),
        ),
        _ => (format!("reason:{reason}"), reason.to_string()),
    }
}

/// What a hold is about, as the owner hears it: every hold reason the hub gives is one of these,
/// told as a plain sentence in his language. The raw reason stays in the log, the hold event's
/// `reason` and `cataly lead status --json`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Cause {
    /// The 300 s recovery or its five retries were spent.
    Exhausted,
    /// A start ended before it was ready (an early exit, a protocol or identity mismatch).
    Rejected,
    /// The owner stopped the recovery.
    Stopped,
    /// Whether an earlier lead process ended is not known.
    Ownership,
    /// More than the restart limit within 10 minutes.
    Restarts,
    /// One session ID with more than one transcript.
    Ambiguous,
    /// The bound session could not be recorded.
    Binding,
    /// The conversation's transcript is missing or did not verify.
    Transcript,
    /// A requested fresh conversation did not bind.
    Fresh,
    /// Another OMP holds the session, or its lease is unknown.
    InUse,
    /// The configured or recorded target changed or conflicts.
    Target,
    /// No proven conversation to resume.
    NoAnchor,
    /// The conversation's runtime is one this Cataly does not run.
    Runtime,
    /// The hub cannot start a session now (memory, session cap, OMP, configuration, stopping).
    Admission,
    /// Any reason not recognized above.
    Other,
}

impl Cause {
    #[cfg(test)]
    const ALL: [Self; 15] = [
        Self::Exhausted,
        Self::Rejected,
        Self::Stopped,
        Self::Ownership,
        Self::Restarts,
        Self::Ambiguous,
        Self::Binding,
        Self::Transcript,
        Self::Fresh,
        Self::InUse,
        Self::Target,
        Self::NoAnchor,
        Self::Runtime,
        Self::Admission,
        Self::Other,
    ];

    /// The cause of a raw hold reason; checked in order, the first match wins.
    pub(crate) fn of(reason: &str) -> Self {
        let has = |part: &str| reason.contains(part);
        if has("owner stopped recovery") || has("startup retry cancelled") {
            Self::Stopped
        } else if has("ownership is") || has("process ownership") || has("(cleanup: Unknown)") {
            Self::Ownership
        } else if has("300 s recovery episode")
            || has("five-retry ceiling")
            || (has("startup ") && has(" Timeout: "))
        {
            Self::Exhausted
        } else if has("restarts within 10 minutes") {
            Self::Restarts
        } else if has("ambiguous lead binding history") || has("proven transcripts") {
            Self::Ambiguous
        } else if has("binding could not be committed") || has("binding conflicts") {
            Self::Binding
        } else if has("transcript") {
            Self::Transcript
        } else if has("fresh") && has("did not bind") {
            Self::Fresh
        } else if has("unknown lease")
            || has("is held by a running OMP")
            || has("is held by another OMP")
        {
            Self::InUse
        } else if has("changed during recovery") || has("conflicts with --fresh") || has("differs")
        {
            Self::Target
        } else if has("no proven") {
            Self::NoAnchor
        } else if has("runtime '") {
            Self::Runtime
        } else if has("admission")
            || has("session cap")
            || has("OMP has not been probed")
            || has("OMP probe failed")
            || has("no session can start")
            || has("OMP executable")
            || has("bridge link")
            || has("the bridge at ")
            || has("hub is stopping")
            || has("[lead]")
            || has("lead cwd")
        {
            Self::Admission
        } else if has("startup ") || has("refused: ") {
            Self::Rejected
        } else {
            Self::Other
        }
    }

    /// What happened, and what the owner does about it.
    pub(crate) const fn text(self, language: Language) -> (&'static str, &'static str) {
        match language {
            Language::Korean => self.korean(),
            Language::English => self.english(),
        }
    }

    const fn korean(self) -> (&'static str, &'static str) {
        match self {
            Self::Exhausted => (
                "lead를 다시 시작하려 했지만 정해진 시간(5분) 안에 되지 않았어요.",
                "`cataly lead start`로 다시 시도하세요.",
            ),
            Self::Rejected => (
                "lead를 시작했지만 준비되기 전에 멈췄어요.",
                "`cataly lead status`에서 마지막 시도를 확인하고 원인을 고친 뒤 `cataly lead start`를 실행하세요.",
            ),
            Self::Stopped => (
                "요청에 따라 lead 재시작을 멈췄어요.",
                "다시 시작하려면 `cataly lead start`를 실행하세요.",
            ),
            Self::Ownership => (
                "이전 lead 프로세스가 끝났는지 확인할 수 없어서 새로 시작하지 않았어요.",
                "남아 있는 OMP가 없는지 확인한 뒤 `cataly lead start`를 실행하세요.",
            ),
            Self::Restarts => (
                "lead가 10분 안에 너무 여러 번 종료되었어요.",
                "`cataly lead status`로 원인을 확인한 뒤 `cataly lead start`를 실행하세요.",
            ),
            Self::Ambiguous => (
                "lead 대화 기록이 둘 이상이라 어느 쪽으로 이어갈지 정하지 않았어요.",
                "`cataly lead start`를 실행하면 마지막으로 확인된 대화로 이어서 시작해요.",
            ),
            Self::Binding => (
                "lead는 시작됐지만 그 대화를 기록하지 못해서 멈췄어요.",
                "`cataly lead start`로 다시 시도하세요.",
            ),
            Self::Transcript => (
                "lead의 대화 파일이 없거나 확인되지 않았어요.",
                "대화 파일을 되돌린 뒤 `cataly lead start`를 실행하세요.",
            ),
            Self::Fresh => (
                "요청한 새 lead 대화가 시작되지 않았어요.",
                "새 대화를 다시 시도하려면 `cataly lead start --fresh`, 이전 대화로 돌아가려면 `cataly lead start`를 실행하세요.",
            ),
            Self::InUse => (
                "lead 대화를 다른 OMP가 쓰고 있거나, 쓰고 있는지 확인할 수 없어요.",
                "그 OMP를 닫은 뒤 `cataly lead start`를 실행하세요.",
            ),
            Self::Target => (
                "lead가 이어갈 대화 설정이 바뀌었거나 서로 맞지 않아요.",
                "설정의 `[lead] session_id`를 확인한 뒤 `cataly lead start`를 실행하세요.",
            ),
            Self::NoAnchor => (
                "이어서 시작할 lead 대화가 확인되지 않았어요.",
                "`cataly lead start`를 실행하세요.",
            ),
            Self::Runtime => (
                "lead 대화가 이 Cataly에서 실행할 수 없는 방식으로 시작되었어요.",
                "이 대화를 이어가려면 그 방식을 지원하는 Cataly로 `cataly lead start`를 실행하세요.",
            ),
            Self::Admission => (
                "지금은 lead를 시작할 수 없는 상태예요(메모리, 세션 수, OMP 준비 또는 설정).",
                "`cataly health`로 확인한 뒤 `cataly lead start`를 실행하세요.",
            ),
            Self::Other => (
                "lead를 시작하지 못했어요.",
                "자세한 내용은 `cataly lead status --json`에 있어요. 원인을 고친 뒤 `cataly lead start`를 실행하세요.",
            ),
        }
    }

    const fn english(self) -> (&'static str, &'static str) {
        match self {
            Self::Exhausted => (
                "Cataly tried to restart the lead, but it did not come up within the set time (5 minutes).",
                "Run `cataly lead start` to try again.",
            ),
            Self::Rejected => (
                "The lead was started but stopped before it was ready.",
                "Check the last attempt with `cataly lead status`, fix the cause, then run `cataly lead start`.",
            ),
            Self::Stopped => (
                "Restarting the lead was stopped, as asked.",
                "Run `cataly lead start` when you want it back.",
            ),
            Self::Ownership => (
                "Cataly could not confirm that the earlier lead process ended, so it started nothing.",
                "Make sure no earlier OMP is still running, then run `cataly lead start`.",
            ),
            Self::Restarts => (
                "The lead exited too many times within 10 minutes.",
                "Check the cause with `cataly lead status`, then run `cataly lead start`.",
            ),
            Self::Ambiguous => (
                "The lead's conversation is recorded in more than one transcript, so Cataly did not pick one.",
                "Run `cataly lead start` to continue the last confirmed conversation.",
            ),
            Self::Binding => (
                "The lead started, but Cataly could not record its conversation, so it stopped it.",
                "Run `cataly lead start` to try again.",
            ),
            Self::Transcript => (
                "The lead's conversation file is missing or could not be verified.",
                "Restore the file, then run `cataly lead start`.",
            ),
            Self::Fresh => (
                "The new lead conversation you asked for did not start.",
                "Run `cataly lead start --fresh` to try it again, or `cataly lead start` to go back to the earlier one.",
            ),
            Self::InUse => (
                "Another OMP is using the lead's conversation, or Cataly could not tell whether one is.",
                "Close that OMP, then run `cataly lead start`.",
            ),
            Self::Target => (
                "The conversation the lead should continue changed or conflicts with the settings.",
                "Check `[lead] session_id` in the settings, then run `cataly lead start`.",
            ),
            Self::NoAnchor => (
                "No confirmed lead conversation was found to continue.",
                "Run `cataly lead start`.",
            ),
            Self::Runtime => (
                "The lead's conversation was started on a runtime this Cataly cannot run.",
                "Run `cataly lead start` with a Cataly that runs it to continue this conversation.",
            ),
            Self::Admission => (
                "The lead cannot be started right now (memory, session limit, OMP readiness or settings).",
                "Check `cataly health`, then run `cataly lead start`.",
            ),
            Self::Other => (
                "The lead could not be started.",
                "Details are in `cataly lead status --json`; after fixing the cause, run `cataly lead start`.",
            ),
        }
    }
}

/// The hold text: what happened in plain words, what is kept, what to do, and that an update
/// does not lift the hold.
pub(crate) fn held_text(language: Language, reason: &str, anchor: Option<&AnchorView>) -> String {
    let (what, todo) = Cause::of(reason).text(language);
    if anchor.is_none() {
        return match language {
            Language::Korean => format!(
                "Cataly: lead가 보류되어 스스로 시작하지 않습니다.\n원인: {what}\n\
                 보존: 기존 대화 파일과 작업, 대기 중인 메시지. 아무것도 교체하거나 삭제하지 않았습니다.\n\
                 {todo} 이전에 확인된 대화가 없을 때만 최초 시작을 다시 시도합니다. \
                 새 대화를 명시적으로 선택하려면 `cataly lead start --fresh`를 쓰세요.\n\
                 업데이트나 허브 재시작만으로는 이 보류가 풀리지 않습니다."
            ),
            Language::English => format!(
                "Cataly: the lead is held and will not start by itself.\nReason: {what}\n\
                 Kept: existing transcript files, work and queued messages; nothing was replaced or deleted.\n\
                 {todo} It retries the initial start only if no conversation was ever bound. \
                 Choose `cataly lead start --fresh` explicitly for a new conversation.\n\
                 An update or a hub restart does not lift this hold by itself."
            ),
        };
    }
    let which = |ko: bool| {
        anchor.map_or_else(String::new, |a| {
            if ko {
                format!("(세션 {}, {})", a.session_id, a.session_file)
            } else {
                format!(" (session {}, {})", a.session_id, a.session_file)
            }
        })
    };
    match language {
        Language::Korean => format!(
            "Cataly: lead가 보류되어 스스로 시작하지 않습니다.\n\
             원인: {what}\n\
             보존: 대화{}와 작업, 대기 중인 메시지. 아무것도 교체하거나 삭제하지 않았습니다.\n\
             {todo} 새 대화를 원할 때만 `cataly lead start --fresh`를 쓰세요.\n\
             업데이트나 허브 재시작만으로는 이 보류가 풀리지 않습니다.",
            which(true)
        ),
        Language::English => format!(
            "Cataly: the lead is held and will not start by itself.\n\
             Reason: {what}\n\
             Kept: the conversation{}, its work and your queued messages; nothing was replaced or deleted.\n\
             {todo} Use `cataly lead start --fresh` only if you want a new conversation instead.\n\
             An update or a hub restart does not lift this hold by itself.",
            which(false)
        ),
    }
}

/// The 15 s text: not a failure yet, what is kept, the limits, and where to watch.
pub(crate) fn slow_text(language: Language, session: Option<&str>, attempt: u32) -> String {
    match (language, session) {
        (Language::Korean, Some(id)) => format!(
            "Cataly: lead가 기존 대화를 15초째 여는 중입니다(세션 {id}, {attempt}번째 시도). 아직 실패가 아닙니다. 대화와 작업, 대기 중인 메시지는 보존되며 준비되면 그 대화로 전달됩니다.\n\
             한 번의 시도는 최대 60초, 재시도는 최대 5분까지 이어집니다. 진행 상황은 `cataly lead status`로 볼 수 있고, 결국 보류되면 한 번 더 알려드립니다."
        ),
        (Language::Korean, None) => "Cataly: 요청하신 새 lead 대화를 15초째 시작하는 중입니다. 아직 실패가 아닙니다. 대기 중인 메시지는 보존되며 준비되면 전달되고, 이전 대화 기록도 그대로 남아 있습니다.\n\
             한 번의 시도는 최대 60초입니다. 진행 상황은 `cataly lead status`로 볼 수 있고, 결국 보류되면 한 번 더 알려드립니다."
            .into(),
        (Language::English, Some(id)) => format!(
            "Cataly: the lead has been starting its existing conversation for 15 s (session {id}, attempt {attempt}). This is not a failure yet: the conversation, its work and your queued messages are kept, and the messages go to it once it is ready.\n\
             Each attempt may take up to 60 s; retries continue for up to 5 minutes. `cataly lead status` shows progress; you hear once more only if it ends held."
        ),
        (Language::English, None) => "Cataly: the lead has been starting the new conversation you asked for for 15 s. This is not a failure yet: your queued messages are kept and go to it once it is ready, and the earlier conversation stays recorded.\n\
             An attempt may take up to 60 s. `cataly lead status` shows progress; you hear once more only if it ends held."
            .into(),
    }
}

/// What the notice task reads from the hub.
pub(super) struct Env {
    pub(super) store: Store,
    pub(super) config: watch::Receiver<std::sync::Arc<Config>>,
    pub(super) events: Events,
}

/// Tells the owner, in order, what the lead asks; runs until the lead is dropped.
pub(super) async fn serve(mut rx: mpsc::UnboundedReceiver<Notice>, env: Env) {
    while let Some(notice) = rx.recv().await {
        if let Err(e) = one(&env, notice).await {
            log::warn("owner notice not given", &[("error", &e)]);
        }
    }
}

async fn one(env: &Env, notice: Notice) -> Result<(), String> {
    let config = std::sync::Arc::clone(&env.config.borrow());
    let language = config.hub.language;
    let pin = config.lead.as_ref().and_then(|l| l.session_id.clone());
    let (selected, episode, said) = env
        .store
        .read(move |r| {
            Ok((
                r.lead_target(pin.as_deref())?,
                r.startup_episode(LEAD)?,
                r.memory(JOB, false)?,
            ))
        })
        .await
        .map_err(|e| e.to_string())?;
    let told = |condition: &str| {
        said.iter()
            .find(|(s, c, _)| s == SUBJECT && c == condition)
            .map(|(_, _, v)| v.clone())
    };
    match notice {
        Notice::Bound => {
            if told(HELD).is_some() {
                remember(env, HELD, None).await?;
            }
        }
        Notice::Slow { handle, session } => {
            let active = episode
                .as_ref()
                .filter(|e| e.state == "active" && session.as_deref() == Some(&e.session_id));
            let key = active.map_or_else(
                || format!("attempt:{handle}"),
                |e| format!("episode:{}:{}", e.session_id, e.started_ms),
            );
            if told(SLOW).as_deref() == Some(key.as_str()) {
                return Ok(());
            }
            remember(env, SLOW, Some(key)).await?;
            let attempt = active.map_or(1, |e| e.retries.saturating_add(1));
            let text = slow_text(language, session.as_deref(), attempt);
            (env.events)(
                Emit::new(EventKind::LeadSlow, Severity::Warning, true, LEAD)
                    .with("notice", text)
                    .with("session", session.unwrap_or_default())
                    .for_owner(),
            );
        }
        Notice::Held(reason) => {
            let (key, reason) = hold(episode.as_ref(), &reason);
            if told(HELD).as_deref() == Some(key.as_str()) {
                return Ok(());
            }
            remember(env, HELD, Some(key)).await?;
            let anchor = super::anchor_view(selected);
            let text = held_text(language, &reason, anchor.as_ref());
            (env.events)(
                Emit::new(EventKind::LeadHeld, Severity::Warning, true, LEAD)
                    .with("notice", text)
                    .with("reason", reason)
                    .with("session", anchor.map_or_default(|a| a.session_id))
                    .for_owner(),
            );
        }
        Notice::Unverified(reason) => {
            if told(UNVERIFIED).as_deref() == Some(reason.as_str()) {
                return Ok(());
            }
            remember(env, UNVERIFIED, Some(reason.clone())).await?;
            let anchor = super::anchor_view(selected);
            (env.events)(
                Emit::new(EventKind::LeadHeld, Severity::Warning, true, LEAD)
                    .with(
                        "notice",
                        crate::host::model::unverified_text(language, &reason),
                    )
                    .with("reason", reason)
                    .with("session", anchor.map_or_default(|a| a.session_id))
                    .for_owner(),
            );
        }
    }
    Ok(())
}

/// Records what was told before it is said: a crash in between loses one notice, never repeats one.
async fn remember(env: &Env, condition: &str, value: Option<String>) -> Result<(), String> {
    env.store
        .apply(Apply {
            memory: vec![MemoryWrite {
                job: JOB.into(),
                subject: SUBJECT.into(),
                condition: condition.into(),
                dry: false,
                value,
            }],
            ..Apply::default()
        })
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn episode(state: &str) -> Episode {
        Episode {
            target: LEAD.into(),
            session_id: "s1".into(),
            started_ms: 7,
            deadline_ms: 300_007,
            retries: 0,
            next_ms: None,
            state: state.into(),
            detail: Some("startup Ready Rejected: wrong protocol".into()),
        }
    }

    /// A hold the restart finds again ("recovery is held") is the same hold as the rejection
    /// that made it, with that first cause as its reason; any other hold is its own reason.
    #[test]
    fn a_hold_is_known_again_after_a_restart() {
        let first = hold(
            Some(&episode("held")),
            "startup Ready Rejected: wrong protocol",
        );
        let again = hold(
            Some(&episode("held")),
            "recovery is held; explicit owner retry required",
        );
        assert_eq!(first, again);
        assert_eq!(first.1, "startup Ready Rejected: wrong protocol");
        let other = hold(Some(&episode("bound")), "lease held");
        assert_eq!(other, ("reason:lease held".into(), "lease held".into()));
    }

    #[test]
    fn the_hold_text_says_reason_kept_command_and_update() {
        let anchor = AnchorView {
            session_id: "s1".into(),
            session_file: "/x/s1.jsonl".into(),
            cwd: "/".into(),
            runtime: "headless".into(),
            provenance: None,
        };
        for language in [Language::English, Language::Korean] {
            for bound in [Some(&anchor), None] {
                let text = held_text(language, "startup Ready Rejected: bad", bound);
                assert!(!text.contains("Rejected: bad"), "no raw reason: {text}");
                assert_eq!(text.contains("s1"), bound.is_some(), "{text}");
                assert_eq!(text.contains("/x/s1.jsonl"), bound.is_some(), "{text}");
                assert!(text.contains("`cataly lead start`"), "{text}");
                assert!(text.contains("`cataly lead start --fresh`"), "{text}");
                assert!(text.lines().count() == 5, "{text}");
            }
        }
        let en = held_text(Language::English, "r", None);
        assert!(en.contains("does not lift this hold"), "{en}");
        let ko = held_text(Language::Korean, "r", None);
        assert!(
            ko.contains("보존") && ko.contains("풀리지 않습니다"),
            "{ko}"
        );
        // Fresh is offered only as a different conversation, never as the repair.
        assert!(!en.contains("fix it with --fresh"));
        let slow = slow_text(Language::English, Some("s1"), 2);
        assert!(
            slow.contains("15 s") && slow.contains("attempt 2") && slow.contains("not a failure")
        );
        assert!(slow.contains("kept") && !slow.contains("--fresh"), "{slow}");
        let slow = slow_text(Language::Korean, Some("s1"), 1);
        assert!(slow.contains("15초") && slow.contains("보존"), "{slow}");
    }

    /// The hold-reason producers' code, without their tests.
    const PRODUCERS: [&str; 9] = [
        include_str!("../lead.rs"),
        include_str!("sleep.rs"),
        include_str!("startup.rs"),
        include_str!("../../store/host/anchor.rs"),
        include_str!("../../store/host/episode.rs"),
        include_str!("../../store/migrations/0011_lead_anchor.sql"),
        include_str!("../../store/migrations/0013_lead_anchor_history.sql"),
        include_str!("../../omp/probe.rs"),
        include_str!("../../omp/extension.rs"),
    ];

    /// `cause|reason`, one per line, exactly as the producer's code writes it.
    const WRITTEN: &str = "\
Exhausted|300 s recovery episode has no startup and cleanup budget remaining
Exhausted|300 s recovery episode exhausted; conversation retained
Exhausted|{error}; 300 s recovery episode or five-retry ceiling exhausted; conversation retained, held
Stopped|owner stopped recovery
Stopped|startup retry cancelled
Ownership|lead exit ownership is unknown; conversation retained, automatic recovery held
Ownership|an earlier unbound lead attempt has unknown process ownership; held until its exit is reconciled
Ownership|lead process ownership is not proven terminated: {evidence:?}; conversation retained
Restarts|more than {RESTART_LIMIT} restarts within 10 minutes, held until `cataly lead start`
Ambiguous|ambiguous lead binding history
Ambiguous|'ambiguous lead binding history: lead session '
Ambiguous|required lead session {id} has {files} proven transcripts; held, never substituted
Binding|binding could not be committed: {error}; input held; cleanup {stopped:?}
Binding|lead binding conflicts with previously proven identity
Transcript|the transcript of lead session {id} did not verify for an exact resume: {detail}; conversation retained
Transcript|the transcript for lead {id} is missing or is not a regular file: {file}; retained, never replaced
Fresh|a fresh lead attempt did not bind; the old conversation is retained and held. Choose `cataly lead start --fresh` to retry fresh or `cataly lead start` to resume old
Fresh|fresh start did not bind; choose `lead start --fresh` or `lead start` to resume old
InUse|lead session {id} is held by a running OMP; conversation retained
InUse|lead session {id} has an unknown lease; conversation retained
InUse|is held by another OMP
InUse|has an unknown lease
Target|lead target changed during recovery; scheduled retry cancelled
Target|lead anchor changed during recovery; held
Target|session_id={id} conflicts with --fresh; remove the pin before requesting a different conversation
Target|required lead identity differs from {id}; held
NoAnchor|required lead session {id} has no proven binding
NoAnchor|the earlier lead has no proven identity; conversation retained, held for the owner
NoAnchor|no proven lead anchor; held, never automatically replaced
NoAnchor|no proven lead binding in migrated history
Runtime|lead session {id} was started on the runtime '{}', which this Cataly does not run;
Admission|memory admission holds the start: {}
Admission|the session cap of {} is reached
Admission|OMP has not been probed yet
Admission|OMP probe failed: {e}
Admission|is below the minimum {}; no session can start
Admission|the OMP executable was not found
Admission|the bridge link {} is missing; {hint}
Admission|{} is not the bridge link; {hint}
Admission|the bridge link {} is broken ({e}); {hint}
Admission|the bridge at {} is not this version's; {hint}
Admission|the hub is stopping
Admission|no [lead] section in the config
Admission|no working directory: set [lead] cwd
Admission|lead cwd: {e}
Other|recovery accounting failed: {error}; held
Other|recovery episode was not recorded
Other|a lead is already running";

    /// Every hold reason the hub gives, as its producer's code words it, has a plain cause told in
    /// Korean and English that never quotes the raw reason, also inside the "recovery is held (…)"
    /// a later start reports. Each reason must still be in its producer's code: a reworded or
    /// removed reason fails here instead of quietly falling to `Other`.
    #[test]
    fn every_hold_reason_has_a_plain_korean_and_english_text() {
        use crate::host::StartError;
        use crate::host::startup::{Cleanup, StartupOutcome, StartupStage};
        let code = PRODUCERS.map(|file| file.split("#[cfg(test)]").next().unwrap_or(file));
        let later = "\"recovery is {}{cause}; explicit owner retry required\"";
        assert!(code.iter().any(|c| c.contains(later)), "{later}");
        let mut reasons: Vec<(&str, String)> = [
            ("Exhausted", StartupOutcome::Timeout, Cleanup::LocalReaped),
            ("Ownership", StartupOutcome::Timeout, Cleanup::Unknown),
            ("Rejected", StartupOutcome::Rejected, Cleanup::LocalReaped),
        ]
        .map(|(cause, outcome, cleanup)| {
            let stage = StartupStage::Ready;
            let detail = "d".into();
            let error = StartError::Startup {
                stage,
                outcome,
                cleanup,
                detail,
            };
            (cause, error.to_string())
        })
        .into();
        reasons.push(("Rejected", StartError::Refused("r".into()).to_string()));
        assert_ne!(Cause::of("OMP release notes unavailable"), Cause::InUse);
        for line in WRITTEN.lines() {
            let (cause, reason) = line.split_once('|').unwrap();
            assert!(
                code.iter().any(|c| c.contains(reason)),
                "no producer writes {reason:?} any more"
            );
            reasons.push((cause, reason.to_string()));
        }
        let mut seen = std::collections::BTreeSet::new();
        for (cause, reason) in &reasons {
            let held = format!("recovery is held ({reason}); explicit owner retry required");
            for reason in [reason.as_str(), held.as_str()] {
                assert_eq!(format!("{:?}", Cause::of(reason)), *cause, "{reason}");
                for language in [Language::Korean, Language::English] {
                    let text = held_text(language, reason, None);
                    assert!(!text.contains(reason), "raw reason in {text}");
                }
            }
            seen.insert(cause.to_string());
        }
        for cause in Cause::ALL {
            assert!(
                seen.contains(&format!("{cause:?}")),
                "{cause:?} has no reason"
            );
            let (ko_what, ko_todo) = cause.text(Language::Korean);
            let (en_what, en_todo) = cause.text(Language::English);
            for text in [ko_what, ko_todo] {
                assert!(text.chars().any(|c| ('가'..='힣').contains(&c)), "{text}");
            }
            for text in [en_what, en_todo] {
                assert!(text.is_ascii() && !text.is_empty(), "{text}");
            }
            assert!(ko_todo.contains("`cataly ") && en_todo.contains("`cataly "));
        }
    }
}
