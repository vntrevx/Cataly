//! Opens the thread for substantive work the lead is doing itself (OPC req. 18).

use serde_json::Value;

use super::Hub;
use crate::relay::discord::Snowflake;
use crate::store::lead::{LeadDone, LeadWrite};

/// Marks an admitted Discord request as substantive and binds it to its work thread.
pub(super) async fn open(hub: &Hub, id: i64, title: &str) -> Result<String, String> {
    let request = hub
        .store
        .read(move |r| r.request(id))
        .await
        .map_err(|e| e.to_string())?
        .filter(|r| r.closed_ms.is_none())
        .ok_or("no open request-log item with that ID")?;
    if !request.admitted {
        return Err("no retained proof of an admitted owner request for this source".into());
    }
    let (room, message) = request
        .source
        .strip_prefix("discord:")
        .and_then(|source| source.split_once(':'))
        .and_then(|(room, message)| Some((Snowflake::parse(room)?, Snowflake::parse(message)?)))
        .ok_or("the request has no Discord source")?;

    let config = hub.config();
    let rest = hub.jobs.ctx().discord(&config)?;
    let info = rest.channel(room).await.map_err(|e| e.why)?;
    let field_id = |info: &Value, field: &str| info.get(field)?.as_str().and_then(Snowflake::parse);
    if field_id(&info, "id") != Some(room) {
        return Err("Discord did not identify the source channel".into());
    }
    let settings = &config.discord;
    let listed = |channel| settings.channels.contains(&channel);
    let follows_parent =
        settings.follow_threads && field_id(&info, "parent_id").is_some_and(listed);
    let target = match info.get("type").and_then(Value::as_u64) {
        Some(10..=12) if listed(room) || follows_parent => room,
        Some(0 | 5) if listed(room) && settings.follow_threads => message,
        _ => {
            return Err(
                "the request is not in a watched Discord channel that supports work threads".into(),
            );
        }
    };
    let expected = format!("discord:{target}");
    if let Some(thread) = request.thread {
        if thread != expected {
            return Err("the request already has a different work thread".into());
        }
        if target != room {
            // A manually entered request-log binding is not proof that Discord created a thread.
            let bound = rest.channel(target).await.map_err(|e| e.why)?;
            if field_id(&bound, "id") != Some(target)
                || field_id(&bound, "parent_id") != Some(room)
                || !matches!(bound.get("type").and_then(Value::as_u64), Some(10 | 11))
            {
                return Err("Discord did not confirm the recorded work thread".into());
            }
        }
        return Ok(format!("request {id}: work thread {thread}"));
    }
    let thread = if target == room {
        expected
    } else {
        hub.lanes
            .thread_for_request(id, title, &format!("discord:{room}/{message}"))
            .await?
    };
    let receipt = format!("request {id}: work thread {thread}");
    let failure = |why| format!("{receipt} exists, but it was not bound to the request: {why}");
    let write = LeadWrite::RequestThread { id, thread };
    match hub
        .store
        .lead(write)
        .await
        .map_err(|e| failure(e.to_string()))?
    {
        LeadDone::Done => Ok(receipt),
        LeadDone::Refused(why) => Err(failure(why)),
        other => Err(failure(format!("unexpected store answer {other:?}"))),
    }
}
