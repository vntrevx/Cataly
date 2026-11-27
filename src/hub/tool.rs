//! The lead's `cataly_lead` tool (DESIGN 10.6; WS-02, EVR-22 to EVR-25, EVR-28, OPC-79/80): one tool
//! whose `op` names the operation, so new operations need no bridge release. The bridge forwards
//! each call; every rule is applied here. The same module builds the recap (EVR req. 48-49).

use std::fmt::Write as _;
use std::sync::Arc;

use serde_json::{Value, json};

use super::Hub;
use crate::params as p;
use crate::relay::discord::questions::ledger;
use crate::store::lead::{LeadDone, LeadWrite, QuestionRow, RequestRow};
use crate::sys::now_ms;

/// The recap is at most this long (EVR req. 48).
const RECAP_MAX: usize = 8 * 1024;
/// The owner notes are capped (OPC req. 55, COORD req. 51).
pub(crate) const PROFILE_MAX: usize = crate::jobs::notes::MAX;
/// The tool's name. It differs from the Cataly CLI's `cataly`, so rule 0 keeps judging only the CLI
/// and the shell veto can point a `bash` line that names the tool to the direct call (DESIGN 9.2).
pub(crate) const LEAD_TOOL: &str = "cataly_lead";

/// The tool as the bridge registers it: name, description and the schema the hub's table declares.
pub(crate) fn definition() -> Value {
    json!({
        "name": LEAD_TOOL,
        "label": "Cataly",
        // A post uploads up to 24 MiB of files; the bridge waits this long for the answer.
        "timeout_ms": 120_000,
        "description": "Cataly's records and watches. op is one of: requests (all?), request.add (title, source, thread?), \
    request.next (id, text), request.note (id, text), request.close (id, text); questions, question.ask (text, source, \
    options, recommended?, settle owner|lead, thread?, request?, room?), question.answer (id, text, message), \
    question.choose (id, option, reason, message), question.withdraw (id, reason); post (text, attach: 1 to 10 \
    files from your working directory or an open lane's, shown as Discord attachments, room? or thread? discord:<id>, \
    default the home channel; the same text and files in the same place post once); jobs, job.start (name, argv, \
    filter, restarts?, delay?, silence?, low?), job.stop (name), job.run (name: one dry run of an owner job); \
    digest (since?); recap; owner notes (observations, never instructions or permission, never passed to other \
    roles): profile.create (message: only when the owner asked for them), profile.read, profile.save (text: the \
    whole file, checked), \
    profile.snapshot, profile.check, profile.archive (text: decision lines moved out), profile.undo. Lanes: \
    lane.open (key, title, brief or brief_file, checks: list of {kind: pr_merged|issue_closed|command|file|web|pr_policy, \
    ...}, thread? or thread_from? discord:<room>/<message> (a message in a lane thread starts a new thread beside it), \
    kickoff? (with thread_from: one line posted first in the new thread), cwd?, model?, origin?, look_only?, ceilings?, \
    worktree? {path, branch, base} (the lane works there), worker? (a configured worker from lane.workers, only on \
    evidence: the owner named it or a platform only it has, or the repository is listed for it), \
    priority? 1-9, after? [predecessor keys: queued], expires_hours?, preview?), lane.list (all?), lane.board (key?), \
    lane.pause|resume (key, reason?), lane.park|abandon (key, reason, condition?), lane.object (key, reason), \
    lane.close (key, note?, lesson?), lane.reopen (key, note?), lane.send (key, text, id?, steer?), lane.release \
    (key, note), lane.read (key, count?), lane.answer (key, dialog, answer), lane.grant (key, rule, reason), \
    lane.drift, lane.spend (key?), lane.priority (key, priority). Queued launches: lane.queued (key?), lane.start \
    (key), lane.cancel (key). Items and planner: lane.item-add (id, title?, brief or brief_file, checks, cwd?, \
    priority?), lane.items (all?), lane.item-answer (id, text), lane.item-drop (id, reason), lane.item-import (repo, \
    checks, label?, cwd?), lane.plan, lane.plan-status, lane.plan-stop (reason?), lane.plan-resume. Review: \
    lane.review (pr owner/name#N, model?), lane.merge (pr, dry_run?; only with the owner's authorisation). Files and \
    rules: lane.publish (key, path, title?, visibility private|public), lane.files (key?), lane.rule-add (text, \
    evidence, scope global|repo, key?), lane.rule-retire (id), lane.rules, lane.board-found (destination, message). \
    Host: lane.admission (cwd?, worker?), lane.slots, lane.workers (name, OS and arch, state, lanes in use, repos). \
    Onboarding (read-only while it runs: posts, questions, lanes and jobs are \
    refused): onboarding (state), onboarding.start (reopen?, message?: only when the owner raised it again), \
    onboarding.consent (reply yes|no, message), onboarding.tool (name, reply allowed|declined, reads, message), \
    onboarding.finish (text: short summary of what is known, tools used or skipped, and gaps).",
        "parameters": crate::params::parameters(crate::params::Tool::Lead),
    })
}

fn done(d: LeadDone, ok: String) -> Result<String, String> {
    match d {
        LeadDone::Refused(why) => Err(why),
        _ => Ok(ok),
    }
}

/// `lane.workers`: one line per configured worker, for placement from evidence (design 2.6).
fn workers(views: &[crate::worker::link::View]) -> String {
    if views.is_empty() {
        return "no workers: every lane runs on this machine".into();
    }
    views
        .iter()
        .map(|v| {
            let platform = match (&v.os, &v.arch) {
                (Some(os), Some(arch)) => format!("{os} {arch}"),
                _ => "platform not seen yet".into(),
            };
            let state = serde_json::to_value(v.state)
                .ok()
                .and_then(|s| s.as_str().map(str::to_string))
                .unwrap_or_default();
            let reason = v
                .reason
                .as_deref()
                .map_or_else(String::new, |r| format!(" ({r})"));
            let repos = if v.repos.is_empty() {
                "none listed".into()
            } else {
                v.repos.join(", ")
            };
            format!(
                "- {}: {platform}, {state}{reason}, lanes {}/{}, repos {repos}",
                v.name, v.lanes, v.lanes_max
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// One `lane.*` operation: `lane.workers` from the worker table, the rest by the lanes as the lead.
async fn lane(hub: &Arc<Hub>, op: &str, input: &Value) -> Result<String, String> {
    if op == "workers" {
        return Ok(workers(&hub.workers.list()));
    }
    let mut lane_input = input.clone();
    p::OP.set(&mut lane_input, json!(op));
    hub.lanes
        .call(crate::lanes::Caller::Lead, &lane_input)
        .await
        .map(|v| match v {
            Value::String(s) => s,
            other => other.to_string(),
        })
}

/// Runs one call; `Err` is shown to the model as a tool error.
pub(crate) async fn call(hub: &Arc<Hub>, input: &Value) -> Result<String, String> {
    let op = p::OP.text(input).unwrap_or_default();
    if let Some(reply) = super::onboarding::call(hub, op, input).await {
        return reply;
    }
    if let Some(lane_op) = op.strip_prefix("lane.") {
        return lane(hub, lane_op, input).await;
    }
    match op {
        "requests" => {
            let all = p::ALL.flag(input);
            let rows = hub
                .store
                .read(move |r| r.requests(!all))
                .await
                .map_err(|e| e.to_string())?;
            Ok(list_requests(&rows, usize::MAX))
        }
        "request.add" => {
            let write = LeadWrite::RequestAdd {
                title: p::TITLE.need(input, 200, true)?.into(),
                source: p::SOURCE.need(input, 400, true)?.into(),
                thread: p::THREAD.text(input).map(str::to_string),
            };
            match hub.store.lead(write).await.map_err(|e| e.to_string())? {
                LeadDone::Id(id) => Ok(format!("request-log item {id} open")),
                other => done(other, String::new()),
            }
        }
        "request.next" | "request.note" | "request.close" => {
            let id = p::ID
                .id(input)
                .and_then(|t| t.parse::<i64>().ok())
                .ok_or("id is required")?;
            let text = p::TEXT.need(input, 1000, false)?.to_string();
            let (write, said) = match op {
                "request.next" => (LeadWrite::RequestNext { id, text }, "next step set"),
                "request.note" => (LeadWrite::RequestNote { id, text }, "note added"),
                _ => (LeadWrite::RequestClose { id, result: text }, "closed"),
            };
            let d = hub.store.lead(write).await.map_err(|e| e.to_string())?;
            done(d, format!("item {id}: {said}"))
        }
        "questions" => {
            let rows = hub
                .store
                .read(|r| r.questions(true))
                .await
                .map_err(|e| e.to_string())?;
            Ok(list_questions(&rows, usize::MAX))
        }
        "question.ask" => ask(hub, input).await,
        "post" => post(hub, input).await,
        "question.answer" | "question.choose" | "question.withdraw" => settle(hub, op, input).await,
        "jobs" => Ok(hub.streams.list()),
        "job.start" => hub.streams.start(input).await,
        "job.stop" => hub.streams.stop(p::NAME.need(input, 64, true)?).await,
        "job.run" => {
            let name = p::NAME.need(input, 64, true)?.to_string();
            let events = hub.jobs.run_once(&name).await.map_err(|e| e.to_string())?;
            let lines: Vec<String> = events
                .iter()
                .map(|e| format!("- {} {}", e.kind, e.text))
                .collect();
            Ok(format!(
                "{name}: one dry run, {} event(s)\n{}",
                lines.len(),
                lines.join("\n")
            ))
        }
        "digest" => {
            let since = match p::SINCE.text(input) {
                Some(t) => t
                    .parse::<jiff::Timestamp>()
                    .map_err(|e| format!("since: {e}"))?
                    .as_millisecond(),
                None => now_ms() - 24 * 3_600_000,
            };
            Ok(crate::relay::discord::away::build(
                hub.store.clone(),
                hub.discord_rest(),
                &hub.config(),
                since,
            )
            .await
            .0)
        }
        "recap" => Ok(recap(hub).await),
        profile if profile.starts_with("profile.") => notes(hub, profile, input),
        "" => Err("op is required".into()),
        other => Err(format!("unknown op {other}; see the tool description")),
    }
}

/// The lead's owner-notes operations (COORD-34 to COORD-37, OPC-79).
fn notes(hub: &Hub, op: &str, input: &Value) -> Result<String, String> {
    let notes = crate::jobs::notes::Notes::new(&hub.paths.state_dir);
    let today = crate::jobs::notes::Notes::today();
    match op {
        "profile.read" => notes.show(),
        // Only on the owner's direct request, named by its message (COORD req. 47).
        "profile.create" => {
            let message = p::MESSAGE
                .need(input, 400, true)
                .map_err(|_| "message: the owner's message asking for the owner notes")?;
            notes.create(Some(message))
        }
        "profile.save" => notes.save(p::TEXT.need(input, PROFILE_MAX, false)?),
        "profile.snapshot" => notes.snapshot(today),
        "profile.check" => notes.check_file(today).map(|problems| {
            if problems.is_empty() {
                "the check passes".into()
            } else {
                problems.join("\n")
            }
        }),
        "profile.archive" => notes.archive_add(p::TEXT.need(input, PROFILE_MAX, false)?),
        "profile.undo" => notes.undo(),
        other => Err(format!("unknown op {other}; see the tool description")),
    }
}

/// Records a question and posts it, bound to its message (EVR req. 34-36).
async fn ask(hub: &Arc<Hub>, input: &Value) -> Result<String, String> {
    let text = p::TEXT.need(input, 1000, true)?;
    let source = p::SOURCE.need(input, 400, true)?;
    let options: Vec<String> = p::OPTIONS
        .list(input)
        .iter()
        .map(|o| o.trim().to_string())
        .collect();
    if options.is_empty() || options.len() > 9 {
        return Err("options: 1 to 9 are required".into());
    }
    if options
        .iter()
        .any(|o| o.is_empty() || o.chars().count() > 200 || o.contains('\n'))
    {
        return Err("each option is one line of 1 to 200 characters".into());
    }
    let recommended = p::RECOMMENDED.int(input);
    if recommended.is_some_and(|r| r < 1 || r > i64::try_from(options.len()).unwrap_or(0)) {
        return Err("recommended must name one of the options".into());
    }
    let lead_may = p::SETTLE.text(input) == Some("lead");
    let thread = p::THREAD.text(input).map(str::to_string);
    if lead_may && (options.len() < 2 || thread.is_none()) {
        return Err("a question the lead may settle needs at least 2 options and a thread".into());
    }
    let id = crate::host::random_hex(4);
    let body = ledger::body(&id, text, &options, recommended);
    let config = hub.config();
    let snowflake = crate::relay::discord::Snowflake::parse;
    let named = p::ROOM.text(input).map(str::trim).filter(|r| !r.is_empty());
    let room = match named {
        Some(r) => Some(snowflake(r).ok_or("room: a Discord channel ID is required")?),
        None => thread
            .as_deref()
            .and_then(|t| t.strip_prefix("discord:"))
            .and_then(snowflake)
            .or_else(|| config.discord.home()),
    };
    let mut uncertain = false;
    let posted = match (room, hub.discord_rest()) {
        (Some(room), Some(rest)) => {
            let nonce = crate::relay::discord::nonce(&format!("ledger:{id}"), 0);
            // One button per option when presses reach intake (DISC-OUT req. 67-68).
            let create = if ledger::buttons_ready(&hub.discord.health()) {
                let components = ledger::buttons(&id, &options, recommended);
                json!({ "content": body, "nonce": nonce, "components": components })
            } else {
                json!({ "content": body, "nonce": nonce })
            };
            match rest.create(room, create).await {
                Ok(v) => v
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|m| (room.to_string(), m.to_string())),
                Err(e) => {
                    uncertain = e.uncertain;
                    None
                }
            }
        }
        _ => None,
    };
    // Only a definite rejection permits treating the post as absent (EVR req. 34).
    if !uncertain && let (Some(r), None) = (named, &posted) {
        return Err(format!("room: could not post in {r}; nothing recorded"));
    }
    let row = QuestionRow {
        id: id.clone(),
        text: text.into(),
        source: source.into(),
        thread,
        options,
        recommended,
        lead_may,
        request: p::REQUEST.int(input),
        room: room
            .filter(|_| posted.is_some() || uncertain)
            .map(|room| room.to_string()),
        message: posted.as_ref().map(|(_, message)| message.clone()),
        state: "open".into(),
        outcome: None,
        created_ms: 0,
    };
    let d = hub
        .store
        .lead(LeadWrite::QuestionAsk(Box::new(row)))
        .await
        .map_err(|e| e.to_string())?;
    let said = match &posted {
        Some((room, message)) => {
            format!("question {id} recorded and posted in {room} as message {message}")
        }
        None if uncertain => {
            format!("question {id} recorded; its post is in doubt. Do not post it again.")
        }
        None => format!(
            "question {id} recorded; it could not be posted, so ask it yourself and quote its ID"
        ),
    };
    done(d, said)
}

/// Posts text with files attached in a Discord channel or thread (EVR req. 67-69): the named
/// channel, else the `discord:<id>` thread, else the home channel. Files come from the lead's working
/// directory or an open lane's; Telegram and Slack are refused.
async fn post(hub: &Arc<Hub>, input: &Value) -> Result<String, String> {
    let text = p::TEXT.need(input, 4000, false)?;
    let snowflake = crate::relay::discord::Snowflake::parse;
    let room = match (p::ROOM.text(input), p::THREAD.text(input)) {
        (Some(r), _) => snowflake(r).ok_or("room: a Discord channel ID is required")?,
        (None, Some(t)) => t
            .strip_prefix("discord:")
            .and_then(snowflake)
            .ok_or(
                "thread: files post only on Discord (discord:<id>); Telegram and Slack uploads are not offered",
            )?,
        (None, None) => hub
            .config()
            .discord
            .home()
            .ok_or("name room or thread: there is no Discord home channel")?,
    };
    let cwd = hub
        .lead
        .snapshot()
        .map(|s| std::path::PathBuf::from(&s.cwd));
    let mut roots: Vec<std::path::PathBuf> = cwd.iter().cloned().collect();
    roots.extend(hub.lanes.open_dirs().await?);
    hub.lanes
        .post_files(
            &room.to_string(),
            text,
            &p::ATTACH.list(input),
            cwd.as_deref(),
            &roots,
        )
        .await
}

/// Answer by hand, the lead's own choice, or withdrawal (EVR req. 38-40).
async fn settle(hub: &Arc<Hub>, op: &str, input: &Value) -> Result<String, String> {
    let id = p::ID.need(input, 16, true)?.to_string();
    let q = {
        let id = id.clone();
        hub.store
            .read(move |r| r.question(&id))
            .await
            .map_err(|e| e.to_string())?
    }
    .ok_or(format!("no question {id}"))?;
    let (state, outcome, status) = match op {
        "question.answer" => {
            let message = p::MESSAGE.need(input, 64, true)?;
            let text = p::TEXT.need(input, 1000, false)?;
            (
                "answered",
                format!("owner message {message}: {text}"),
                "Answered by the owner.".to_string(),
            )
        }
        "question.choose" => {
            if !q.lead_may {
                return Err(format!("question {id} is the owner's to settle"));
            }
            let option = p::OPTION.int(input).ok_or("option is required")?;
            let n = usize::try_from(option)
                .ok()
                .filter(|n| (1..=q.options.len()).contains(n))
                .ok_or(format!("option must be 1 to {}", q.options.len()))?;
            let picked = ledger::picked(&q, n);
            let reason = p::REASON.need(input, 1000, false)?;
            let message = p::MESSAGE.need(input, 64, true)?;
            if p::THREAD
                .text(input)
                .is_some_and(|t| Some(t) != q.thread.as_deref())
            {
                return Err("the choice must be announced in the question's own thread".into());
            }
            (
                "chosen",
                format!("{picked} by the lead, announced in {message}: {reason}"),
                format!("Chosen by the lead: {}", ledger::shown(&q, n)),
            )
        }
        _ => (
            "withdrawn",
            p::REASON.need(input, 1000, false)?.to_string(),
            "Withdrawn.".to_string(),
        ),
    };
    let d = hub
        .store
        .lead(LeadWrite::QuestionSettle {
            id: id.clone(),
            state: state.into(),
            outcome,
        })
        .await
        .map_err(|e| e.to_string())?;
    if matches!(d, LeadDone::Done)
        && let Some(rest) = hub.discord_rest()
    {
        ledger::close(rest, &q, &status);
    }
    done(d, format!("question {id} {state}"))
}

fn age_hours(created_ms: i64) -> i64 {
    (now_ms() - created_ms).max(0) / 3_600_000
}

fn list_requests(rows: &[RequestRow], max: usize) -> String {
    if rows.is_empty() {
        return "no open request-log items".into();
    }
    let mut out = String::new();
    for r in rows {
        let line = match &r.closed_ms {
            Some(_) => format!(
                "- {} [closed] {}: {}",
                r.id,
                r.title,
                r.result.as_deref().unwrap_or("")
            ),
            None => format!(
                "- {} {} (from {}, {} h); next: {}",
                r.id,
                r.title,
                r.source,
                age_hours(r.created_ms),
                r.next.as_deref().unwrap_or("not set")
            ),
        };
        if out.len() + line.len() > max {
            let _ = write!(out, "\nand {} more", rows.len() - out.lines().count());
            break;
        }
        out.push_str(&line);
        out.push('\n');
    }
    out.trim_end().to_string()
}

fn list_questions(rows: &[QuestionRow], max: usize) -> String {
    if rows.is_empty() {
        return "no open owner questions".into();
    }
    let mut out = String::new();
    for q in rows {
        let who = if q.lead_may {
            "lead may settle"
        } else {
            "owner only"
        };
        let options: Vec<String> = q
            .options
            .iter()
            .enumerate()
            .map(|(n, o)| {
                let star = if q.recommended == i64::try_from(n + 1).ok() {
                    "*"
                } else {
                    ""
                };
                format!("{}{star}. {o}", n + 1)
            })
            .collect();
        let line = format!(
            "- {} ({} h, {who}{}) {} [{}]",
            q.id,
            age_hours(q.created_ms),
            q.thread
                .as_deref()
                .map_or_default(|t| format!(", thread {t}")),
            q.text,
            options.join("; ")
        );
        if out.len() + line.len() > max {
            let _ = write!(out, "\nand {} more", rows.len() - out.lines().count());
            break;
        }
        out.push_str(&line);
        out.push('\n');
    }
    out.trim_end().to_string()
}

/// The recap (EVR req. 48-49): lanes, open request-log items with next steps, open questions, open
/// owner obligations and damaged records, at most 8 KiB. Producing it changes nothing.
pub(crate) async fn recap(hub: &Hub) -> String {
    let store = &hub.store;
    let requests = store.read(|r| r.requests(true)).await;
    let questions = store.read(|r| r.questions(true)).await;
    let since = now_ms() - crate::store::relay::OWED_WINDOW_MS;
    let owed = store.read(move |r| r.owed_open("discord", since)).await;
    let mut damaged = Vec::new();
    let mut out = String::from(
        "[recap] Cataly's records now (read them before acting on recollection).\nLanes: none (lanes arrive later).\n",
    );
    let budget = RECAP_MAX / 3;
    out.push_str("Open requests:\n");
    match requests {
        Ok(rows) => out.push_str(&list_requests(&rows, budget)),
        Err(e) => damaged.push(format!("request log ({e})")),
    }
    out.push_str("\nOpen owner questions:\n");
    match questions {
        Ok(rows) => out.push_str(&list_questions(&rows, budget)),
        Err(e) => damaged.push(format!("question ledger ({e})")),
    }
    match owed {
        Ok(rows) => {
            let _ = write!(
                out,
                "\nOwner messages without a linked answer: {}",
                rows.len()
            );
        }
        Err(e) => damaged.push(format!("owed replies ({e})")),
    }
    let _ = write!(out, "\n{}", super::onboarding::recap_line(hub).await);
    if !damaged.is_empty() {
        let _ = write!(out, "\nUnreadable records: {}", damaged.join(", "));
    }
    if out.len() > RECAP_MAX {
        let mut end = RECAP_MAX;
        while !out.is_char_boundary(end) {
            end -= 1;
        }
        out.truncate(end);
    }
    out
}
