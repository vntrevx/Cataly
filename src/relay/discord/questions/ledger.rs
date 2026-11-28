//! Buttons on the questions the lead records with `question.ask` (EVR req. 34-40; DISC-OUT req.
//! 67-69): one per option when buttons arrive over the Gateway, the recommended one styled primary
//! but never chosen by itself. The owner's press answers the question like a reply naming the
//! option and tells the lead; anyone else's is refused. However the question is settled, its
//! message then says so and loses its buttons.

use std::fmt::Write as _;
use std::sync::Arc;

use serde_json::{Value, json};

use super::super::intake::Intake;
use super::super::types::Press;
use super::super::{Rest, Snowflake};
use super::{LABEL_MAX, neutral};
use crate::host::Runtime;
use crate::jobs::event::{Emit, EventKind, Severity};
use crate::log;
use crate::relay::intake::Health;
use crate::relay::text::DISCORD_LIMIT;
use crate::store::lead::{LeadDone, LeadWrite, QuestionRow, UNTOLD_PAGE};
use crate::sys::secrets;

/// The question as posted: its ID, text, numbered options with the recommended one marked, and how
/// to answer it.
pub(crate) fn body(id: &str, text: &str, options: &[String], recommended: Option<i64>) -> String {
    let mut body = format!("**Question {id}**\n{}", neutral(text));
    for (n, o) in options.iter().enumerate() {
        let mark = if recommended == i64::try_from(n + 1).ok() {
            " (recommended)"
        } else {
            ""
        };
        let _ = write!(body, "\n{}. {}{mark}", n + 1, neutral(o));
    }
    body.push_str("\nReply to this message with a number or your answer.");
    body
}

/// Buttons can be pressed: Discord intake runs and presses reach it over the Gateway (DISC-OUT
/// req. 68), as for the lead's dialogs.
pub(crate) fn buttons_ready(discord: &Health) -> bool {
    discord.buttons && matches!(discord.state.as_str(), "connecting" | "connected")
}

/// One button per option, labelled with its number and cut to Discord's limit; the recommended one
/// primary. Button IDs carry the question ID.
pub(crate) fn buttons(id: &str, options: &[String], recommended: Option<i64>) -> Value {
    let labels: Vec<String> = options
        .iter()
        .enumerate()
        .map(|(n, o)| {
            format!("{}. {}", n + 1, secrets::mask(o))
                .chars()
                .take(LABEL_MAX)
                .collect()
        })
        .collect();
    let recommended = recommended
        .and_then(|r| usize::try_from(r).ok())
        .and_then(|r| r.checked_sub(1));
    super::buttons(id, &labels, recommended, false, "")
}

fn option(q: &QuestionRow, n: usize) -> &str {
    n.checked_sub(1)
        .and_then(|i| q.options.get(i))
        .map_or("", String::as_str)
}

/// Option `n` (from 1) as the ledger records it.
pub(crate) fn picked(q: &QuestionRow, n: usize) -> String {
    format!("option {n} ({})", option(q, n))
}

/// Option `n` (from 1) as the question's message lists it.
pub(crate) fn shown(q: &QuestionRow, n: usize) -> String {
    format!("{n}. {}", neutral(option(q, n)))
}

/// The question's text in the lead's event is cut to this many characters, so the event's one line
/// (`jobs::event::TEXT_MAX`) always holds the question ID and the whole chosen option first.
const EXCERPT_MAX: usize = 100;

/// A press whose event went missing is told at start if it was recorded within this window, well
/// inside the event log's 7-day retention.
const UNTOLD_WINDOW_MS: i64 = 24 * 3_600_000;

/// Told privately when a press was acknowledged but could not be recorded.
const NOT_RECORDED: &str = "Your answer could not be recorded. Press the button again.";
/// Told privately when a press was acknowledged but the question was settled a moment earlier.
const ALREADY: &str = "This question was already answered.";

/// How a press's answer starts in the ledger, before the interaction ID; a reply's starts with
/// "owner message".
const PRESS: &str = "owner press ";

/// The ledger outcome of press `interaction` choosing option `n` (from 1).
fn press_outcome(interaction: &str, q: &QuestionRow, n: usize) -> String {
    format!("{PRESS}{interaction}: {}", picked(q, n))
}

/// The option a press's recorded outcome names, read back with the same words it was written
/// with ([`press_outcome`]); `None` when it names none of the question's options.
fn pressed_option(q: &QuestionRow, outcome: &str) -> Option<usize> {
    let (_, choice) = outcome.strip_prefix(PRESS)?.split_once(": ")?;
    (1..=q.options.len()).find(|n| picked(q, *n) == choice)
}

fn excerpt(text: &str) -> String {
    if text.chars().count() <= EXCERPT_MAX {
        return text.to_string();
    }
    let mut out: String = text.chars().take(EXCERPT_MAX - 1).collect();
    out.push('…');
    out
}

/// The question's body followed by `status`, within one Discord message: a body too long to leave
/// room for the status is cut at its end and marked with "…", so the status always shows.
fn closed(body: &str, status: &str) -> String {
    const CUT: &str = "…";
    let tail = format!("\n\n{status}");
    let full = body.encode_utf16().count() + tail.encode_utf16().count();
    if full <= DISCORD_LIMIT {
        return format!("{body}{tail}");
    }
    let room =
        DISCORD_LIMIT.saturating_sub(tail.encode_utf16().count() + CUT.encode_utf16().count());
    let mut used = 0;
    let head: String = body
        .chars()
        .take_while(|c| {
            used += c.len_utf16();
            used <= room
        })
        .collect();
    // A cut right after an escaping backslash would escape the mark instead.
    let escaping = head.chars().rev().take_while(|c| *c == '\\').count() % 2 == 1;
    let head = if escaping {
        head.strip_suffix('\\').unwrap_or(&head)
    } else {
        &head
    };
    format!("{head}{CUT}{tail}")
}

/// Edits a settled question's message to end with `status` and drop its buttons; best effort,
/// in the background.
pub(crate) fn close(rest: Arc<Rest>, q: &QuestionRow, status: &str) {
    let (Some(room), Some(message)) = (
        q.room.as_deref().and_then(Snowflake::parse),
        q.message.as_deref().and_then(Snowflake::parse),
    ) else {
        return;
    };
    let content = closed(&body(&q.id, &q.text, &q.options, q.recommended), status);
    tokio::spawn(async move {
        super::edit_closed(&rest, (room, message), &content).await;
    });
}

impl<T: Runtime> Intake<T> {
    /// A press on a message bound to an open recorded question; `false` when there is none. The
    /// owner's press records the option, tells the lead and closes the buttons; anyone else's, or
    /// a button the question does not have, is refused. The press counts only once acknowledged,
    /// and only the first answer settles the question.
    pub(super) async fn ledger_press(&self, press: &Press) -> bool {
        let (room, message) = (press.channel.to_string(), press.message.to_string());
        let Ok(Some(q)) = self
            .store
            .read(move |r| r.question_at(&room, &message))
            .await
        else {
            return false;
        };
        if !press.by_owner(self.application, self.owner) {
            self.refuse(press, "Only Master can answer this.").await;
            return true;
        }
        let Some(n) = press
            .custom_id
            .strip_prefix(&format!("cy:{}:", q.id))
            .and_then(|i| i.parse::<usize>().ok())
            .filter(|i| *i < q.options.len())
        else {
            self.refuse(press, "This button is not part of the question.")
                .await;
            return true;
        };
        let ack = json!({ "type": 6 });
        if let Err(e) = self.rest.callback(&press.id, &press.token, ack).await {
            log::info("press not acknowledged", &[("error", &e)]);
            return true;
        }
        let write = LeadWrite::QuestionSettle {
            id: q.id.clone(),
            state: "answered".into(),
            outcome: press_outcome(&press.id, &q, n + 1),
        };
        let unsettled = match self.store.lead(write).await {
            Ok(LeadDone::Done) => None,
            // Settled a moment earlier by another press, a reply or the lead, which closed it.
            Ok(_) => Some(ALREADY),
            Err(e) => {
                log::warn("question answer not recorded", &[("error", &e)]);
                // Acknowledged but not recorded: the owner may press again.
                Some(NOT_RECORDED)
            }
        };
        if let Some(text) = unsettled {
            // The acknowledgement showed nothing; the owner hears privately why nothing changed.
            let note = json!({ "content": text, "flags": 64 });
            if let Err(e) = self
                .rest
                .follow_up(self.application, &press.token, note)
                .await
            {
                log::info("unsettled press not reported", &[("error", &e)]);
            }
            return true;
        }
        self.tell_pressed(&q, picked(&q, n + 1), &shown(&q, n + 1));
        true
    }

    /// Tells the lead what the owner's press chose (`outcome`) and closes the question with the
    /// choice as its message lists it (`shown`; empty when unknown).
    fn tell_pressed(&self, q: &QuestionRow, outcome: String, shown: &str) {
        (self.events)(
            Emit::new(EventKind::QuestionAnswered, Severity::Info, true, &q.id)
                .with("question", &q.id)
                .with("outcome", outcome)
                .with("text", excerpt(&q.text)),
        );
        let status = if shown.is_empty() {
            "Answered by Master.".to_string()
        } else {
            format!("Answered by Master: {shown}")
        };
        close(Arc::clone(&self.rest), q, &status);
    }

    /// At start: every press recorded in the last day whose event is missing (the hub stopped
    /// between the two writes) is told to the lead now, and its question closed. A recorded
    /// outcome that names none of the options is passed on as it was recorded.
    pub(in super::super) async fn tell_untold_presses(&self) {
        let since = crate::sys::now_ms() - UNTOLD_WINDOW_MS;
        let mut after = String::new();
        loop {
            let from = after.clone();
            let page = match self
                .store
                .read(move |r| r.pressed_untold(since, PRESS, &from))
                .await
            {
                Ok(rows) => rows,
                Err(e) => return log::warn("untold presses not read", &[("error", &e)]),
            };
            let Some(last) = page.last() else {
                return;
            };
            after.clone_from(&last.id);
            let full = page.len() == UNTOLD_PAGE;
            for q in page {
                let outcome = q.outcome.clone().unwrap_or_default();
                if let Some(n) = pressed_option(&q, &outcome) {
                    self.tell_pressed(&q, picked(&q, n), &shown(&q, n));
                } else {
                    let raw = outcome.strip_prefix(PRESS).unwrap_or(&outcome).to_string();
                    self.tell_pressed(&q, raw, "");
                }
            }
            if !full {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buttons_number_every_option_and_fit_discord() {
        let mut options: Vec<String> = (1..=9).map(|n| format!("choice {n}")).collect();
        options[6] = "x".repeat(200);
        let rows = buttons("0a1b2c3d", &options, Some(3));
        let rows = rows.as_array().unwrap();
        assert_eq!(rows.len(), 2, "5 per row");
        assert_eq!(rows[0]["components"].as_array().unwrap().len(), 5);
        assert_eq!(rows[1]["components"].as_array().unwrap().len(), 4);
        let third = &rows[0]["components"][2];
        assert_eq!(third["label"], "3. choice 3");
        assert_eq!(third["style"], 1, "recommended is primary");
        assert_eq!(third["custom_id"], "cy:0a1b2c3d:2");
        assert_eq!(rows[0]["components"][0]["style"], 2);
        let long = rows[1]["components"][1]["label"].as_str().unwrap();
        assert!(long.starts_with("7. x"), "{long}");
        assert_eq!(long.chars().count(), LABEL_MAX);
    }

    #[test]
    fn a_long_question_is_cut_so_its_status_shows() {
        let options = vec!["o".repeat(200); 4];
        let body = body("0a1b2c3d", &"q".repeat(1000), &options, Some(2));
        let status = format!("Answered by Master: 2. {}", "o".repeat(200));
        let short = closed("short", &status);
        assert_eq!(short, format!("short\n\n{status}"));
        let cut = closed(&body, &status);
        assert!(cut.encode_utf16().count() <= DISCORD_LIMIT);
        assert!(cut.starts_with("**Question 0a1b2c3d**"), "{cut}");
        assert!(cut.ends_with(&format!("…\n\n{status}")), "{cut}");
        let escaped = closed(
            &format!("{}\\*{}", "a".repeat(1986), "b".repeat(10)),
            "Withdrawn.",
        );
        assert!(!escaped.contains("\\…"), "{escaped}");
        assert_eq!(excerpt(&"q".repeat(900)).chars().count(), EXCERPT_MAX);
    }

    #[test]
    fn a_press_outcome_reads_back_as_its_option() {
        let q = QuestionRow {
            id: "0a1b2c3d".into(),
            text: "Which?".into(),
            source: "discord:1/2".into(),
            thread: None,
            options: vec!["a".into(), "b: or c".into()],
            recommended: None,
            lead_may: false,
            request: None,
            room: None,
            message: None,
            state: "answered".into(),
            outcome: None,
            created_ms: 0,
        };
        // The recorded words: restart recovery and the ledger's readers depend on them.
        let outcome = press_outcome("700000000000000001", &q, 2);
        assert_eq!(
            outcome,
            "owner press 700000000000000001: option 2 (b: or c)"
        );
        assert_eq!(pressed_option(&q, &outcome), Some(2));
        assert_eq!(pressed_option(&q, &press_outcome("7", &q, 1)), Some(1));
        assert_eq!(pressed_option(&q, "owner press 7: option 3 (c)"), None);
        assert_eq!(pressed_option(&q, "owner press 7: chose b"), None);
        assert_eq!(pressed_option(&q, "owner message 7: option 1 (a)"), None);
    }

    #[test]
    fn buttons_need_intake_with_gateway_presses() {
        let mut h = Health {
            state: "connected".into(),
            buttons: true,
            ..Health::default()
        };
        assert!(buttons_ready(&h));
        h.state = "stopped".into();
        assert!(!buttons_ready(&h));
        h.state = "connecting".into();
        h.buttons = false;
        assert!(!buttons_ready(&h));
    }
}
