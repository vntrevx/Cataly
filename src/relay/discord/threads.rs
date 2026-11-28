//! Lane threads on Discord (DISC-OUT-11 to 13, DISC-IN-22, OJ-28, EVR-14; DESIGN 12.2 C17): report
//! posts with deterministic nonces, the hub-set status word in the title (read fresh each time,
//! never from a saved copy) with archive on done, and thread creation from an owner message after
//! its source is proven. Thread discovery for intake stays in `intake` (DISC-IN req. 8-10).

use std::sync::Arc;

use hyper::Method;
use serde_json::{Value, json};
use tokio::sync::watch;

use super::{ChannelRef, Rest, Sent, Snowflake};
use crate::config::Config;
use crate::lanes::{BoxFut, Posted, Threads};
use crate::relay::http::Kind;

/// Status words the hub puts in front of a lane thread's title.
const WORDS: [&str; 3] = ["[working] ", "[waiting] ", "[done] "];
const TITLE_MAX: usize = 100;

/// Builds the Discord client from the config in force.
pub(crate) type MakeRest = Arc<dyn Fn(&Config) -> Result<Arc<Rest>, String> + Send + Sync>;

pub(crate) struct DiscordThreads {
    pub(crate) config: watch::Receiver<Arc<Config>>,
    pub(crate) rest: MakeRest,
}

fn id(text: &str) -> Result<Snowflake, String> {
    Snowflake::parse(text).ok_or_else(|| format!("'{text}' is not a Discord ID"))
}

/// The title with the status word: earlier words removed, `None` when the result would be empty or
/// over 100 characters (DISC-OUT req. 51).
pub(crate) fn titled(current: &str, word: &str) -> Option<String> {
    let mut base = current;
    while let Some(rest) = WORDS.iter().find_map(|w| base.strip_prefix(w)) {
        base = rest;
    }
    let title = format!("[{word}] {base}");
    (!base.trim().is_empty() && title.chars().count() <= TITLE_MAX).then_some(title)
}

/// Where a lane thread from a message in `room` goes: `None` for a thread on the message itself in a
/// listed channel, else the listed parent beside the source thread with the sibling thread type
/// (`None` for a forum or media post).
async fn beside(
    rest: &Rest,
    config: &Config,
    room: Snowflake,
) -> Result<Option<(Snowflake, Option<u64>)>, (bool, String)> {
    // The source channel's type is always looked up, listed or not (DISC-OUT req. 49). A
    // message inside a thread under a listed channel: Discord nests no threads, so the new
    // thread starts beside it in that listed channel without a starter message; a forum or
    // media parent takes a post with a starter message instead.
    let channel = rest.channel(room).await.map_err(|e| (false, e.why))?;
    let thread = matches!(channel.get("type").and_then(Value::as_u64), Some(10..=12));
    if thread {
        let parent = channel
            .get("parent_id")
            .and_then(Value::as_str)
            .and_then(Snowflake::parse)
            .filter(|p| config.discord.channels.contains(p))
            .ok_or((
                false,
                "the source message's channel is not in scope".to_string(),
            ))?;
        let home = rest.channel(parent).await.map_err(|e| (false, e.why))?;
        let kind = home.get("type").and_then(Value::as_u64);
        let forum = matches!(kind, Some(15 | 16));
        // REQUIRE_TAG (1 << 4): the product never picks a tag itself.
        if forum && home.get("flags").and_then(Value::as_u64).unwrap_or(0) & (1 << 4) != 0 {
            return Err((
                false,
                "the forum requires a tag on every post; no lane thread was made".into(),
            ));
        }
        // An announcement channel takes announcement threads (10), others public threads (11).
        let sibling = (!forum).then_some(if kind == Some(5) { 10 } else { 11 });
        Ok(Some((parent, sibling)))
    } else if config.discord.channels.contains(&room) {
        Ok(None)
    } else {
        Err((
            false,
            "the source message's channel is not in scope".to_string(),
        ))
    }
}

impl DiscordThreads {
    fn client(&self) -> Result<(Arc<Rest>, Arc<Config>), String> {
        let config = Arc::clone(&self.config.borrow());
        Ok(((self.rest)(&config)?, config))
    }

    async fn post_now(&self, thread: &str, text: &str, seed: &str) -> Posted {
        let (rest, config) = match self.client() {
            Ok(c) => c,
            Err(e) => return Posted::Rejected(e),
        };
        let Ok(thread) = id(thread) else {
            return Posted::Rejected("bad thread ID".into());
        };
        match rest
            .post(&ChannelRef::Id(thread), text, seed, &config.outgoing)
            .await
            .outcome
        {
            Sent::Confirmed => Posted::Confirmed,
            Sent::Rejected(why) => Posted::Rejected(why),
            Sent::Uncertain(why) => Posted::Uncertain(why),
        }
    }

    async fn status_now(&self, thread: &str, word: &str, archive: bool) -> Result<(), String> {
        let (rest, _) = self.client()?;
        let thread = id(thread)?;
        let channel = rest.channel(thread).await.map_err(|e| e.why)?;
        let name = channel
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let archived = channel
            .pointer("/thread_metadata/archived")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let title = titled(name, word)
            .ok_or("the status word would empty the title or make it longer than 100")?;
        let mut body = serde_json::Map::new();
        if title != name {
            body.insert("name".into(), json!(title));
        }
        if archive != archived {
            body.insert("archived".into(), json!(archive));
        }
        if body.is_empty() {
            return Ok(());
        }
        rest.call(
            "PATCH channels",
            Method::PATCH,
            &format!("/channels/{thread}"),
            Some(Value::Object(body)),
            Kind::Idempotent,
        )
        .await
        .map(drop)
        .map_err(|e| e.why)
    }

    async fn create_now(
        &self,
        room: &str,
        message: &str,
        title: &str,
    ) -> Result<String, (bool, String)> {
        let (rest, config) = self.client().map_err(|e| (false, e))?;
        let (room, message) = (
            id(room).map_err(|e| (false, e))?,
            id(message).map_err(|e| (false, e))?,
        );
        let owner = config
            .discord
            .owner
            .ok_or((false, "no [discord] owner".to_string()))?;
        let beside = beside(&rest, &config, room).await?;
        // Proof of source (DISC-IN req. 59): the exact message, written by the owner.
        let source = rest
            .message(room, message)
            .await
            .map_err(|e| (false, e.why))?;
        let author = source
            .pointer("/author/id")
            .and_then(Value::as_str)
            .and_then(Snowflake::parse);
        let bot = source.pointer("/author/bot").and_then(Value::as_bool) == Some(true);
        if author != Some(owner) || bot {
            return Err((false, "the source is not an owner message".into()));
        }
        let (home, call, path, body) = match beside {
            None => (
                room,
                "POST channels/messages/threads",
                format!("/channels/{room}/messages/{message}/threads"),
                json!({ "name": title, "auto_archive_duration": 10080 }),
            ),
            Some((p, None)) => (
                p,
                "POST channels/threads",
                format!("/channels/{p}/threads"),
                json!({ "name": title, "auto_archive_duration": 10080,
                    "message": { "content": title,
                    "allowed_mentions": { "parse": [], "replied_user": false } } }),
            ),
            Some((p, Some(sibling))) => (
                p,
                "POST channels/threads",
                format!("/channels/{p}/threads"),
                json!({ "name": title, "auto_archive_duration": 10080, "type": sibling }),
            ),
        };
        let created = rest
            .call(call, Method::POST, &path, Some(body), Kind::Once)
            .await
            .map_err(|e| (e.uncertain, e.why))?;
        let thread = created
            .get("id")
            .and_then(Value::as_str)
            .and_then(Snowflake::parse);
        let parent = created
            .get("parent_id")
            .and_then(Value::as_str)
            .and_then(Snowflake::parse);
        let Some(thread) = thread.filter(|_| parent == Some(home)) else {
            return Err((
                true,
                "Discord's answer named no thread under the source channel".into(),
            ));
        };
        if config.lanes.thread_member {
            let _ = rest
                .call(
                    "PUT channels/thread-members",
                    Method::PUT,
                    &format!("/channels/{thread}/thread-members/{owner}"),
                    None,
                    Kind::Idempotent,
                )
                .await;
        }
        Ok(thread.to_string())
    }
}

impl Threads for DiscordThreads {
    fn post<'a>(&'a self, thread: &'a str, text: &'a str, seed: &'a str) -> BoxFut<'a, Posted> {
        Box::pin(self.post_now(thread, text, seed))
    }

    fn status<'a>(
        &'a self,
        thread: &'a str,
        word: &'a str,
        archive: bool,
    ) -> BoxFut<'a, Result<(), String>> {
        Box::pin(self.status_now(thread, word, archive))
    }

    fn create<'a>(
        &'a self,
        room: &'a str,
        message: &'a str,
        title: &'a str,
    ) -> BoxFut<'a, Result<String, (bool, String)>> {
        Box::pin(self.create_now(room, message, title))
    }
}

/// The board post (EVR-30): a plain message created with a nonce, then edited in place.
impl crate::lanes::board::Board for DiscordThreads {
    fn board_create<'a>(
        &'a self,
        channel: &'a str,
        text: &'a str,
        nonce: &'a str,
    ) -> BoxFut<'a, Result<String, (bool, String)>> {
        Box::pin(async move {
            let (rest, _) = self.client().map_err(|e| (false, e))?;
            let channel = id(channel).map_err(|e| (false, e))?;
            let nonce: String = crate::config::sha256_hex(nonce.as_bytes())
                .chars()
                .take(25)
                .collect();
            let v = rest
                .create(channel, json!({ "content": text, "nonce": nonce }))
                .await
                .map_err(|e| (e.uncertain, e.why))?;
            v.get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or((true, "no message ID in Discord's answer".to_string()))
        })
    }

    fn board_edit<'a>(
        &'a self,
        channel: &'a str,
        message: &'a str,
        text: &'a str,
    ) -> BoxFut<'a, Result<(), String>> {
        Box::pin(async move {
            let (rest, _) = self.client()?;
            rest.edit(id(channel)?, id(message)?, json!({ "content": text }))
                .await
                .map_err(|e| e.why)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    type Seen = Arc<Mutex<Vec<(String, String, Value)>>>;

    /// A loopback Discord answering `GET`/`POST` by path suffix and recording every request.
    async fn discord(
        routes: Vec<(&'static str, &'static str, Value)>,
    ) -> (super::super::Base, Seen) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen: Seen = Arc::default();
        let log = Arc::clone(&seen);
        tokio::spawn(async move {
            loop {
                let (mut s, _) = listener.accept().await.unwrap();
                let mut buf = Vec::new();
                let mut chunk = [0u8; 8192];
                let (head, body) = loop {
                    let n = s.read(&mut chunk).await.unwrap_or(0);
                    buf.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&buf).to_string();
                    if let Some(end) = text.find("\r\n\r\n") {
                        let head = text[..end].to_string();
                        let len = head
                            .lines()
                            .find_map(|l| {
                                let (k, v) = l.split_once(':')?;
                                k.eq_ignore_ascii_case("content-length")
                                    .then(|| v.trim().parse::<usize>().ok())?
                            })
                            .unwrap_or(0);
                        if buf.len() >= end + 4 + len || n == 0 {
                            break (head, buf[end + 4..].to_vec());
                        }
                    } else if n == 0 {
                        break (text, Vec::new());
                    }
                };
                let mut first = head.split(' ');
                let (method, path) = (
                    first.next().unwrap_or("").to_string(),
                    first.next().unwrap_or("").to_string(),
                );
                let body = serde_json::from_slice(&body).unwrap_or(Value::Null);
                log.lock()
                    .unwrap()
                    .push((method.clone(), path.clone(), body));
                let answer = routes
                    .iter()
                    .find(|(m, p, _)| *m == method && path.ends_with(p))
                    .map(|(_, _, v)| v.to_string());
                let raw = match answer {
                    Some(v) => format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{v}",
                        v.len()
                    ),
                    None => "HTTP/1.1 404 No\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}"
                        .to_string(),
                };
                let _ = s.write_all(raw.as_bytes()).await;
            }
        });
        let base = super::super::Base::parse(&format!("http://127.0.0.1:{port}/api")).unwrap();
        (base, seen)
    }

    fn threads(base: super::super::Base, channels: &[&str]) -> DiscordThreads {
        let mut config = Config::default();
        config.discord.owner = Snowflake::parse("2");
        config.discord.channels = channels
            .iter()
            .filter_map(|c| Snowflake::parse(c))
            .collect();
        config.lanes.thread_member = false;
        let (_tx, rx) = watch::channel(Arc::new(config));
        DiscordThreads {
            config: rx,
            rest: Arc::new(move |_: &Config| Ok(Arc::new(Rest::new(base.clone(), "t", None)?))),
        }
    }

    const OWNER_MSG: &str = r#"{"id":"40","author":{"id":"2"}}"#;

    #[tokio::test]
    async fn a_lane_thread_from_a_listed_thread_sits_beside_it() {
        let owner: Value = serde_json::from_str(OWNER_MSG).unwrap();
        let (base, seen) = discord(vec![
            (
                "GET",
                "/channels/30",
                json!({ "id": "30", "type": 11, "parent_id": "10" }),
            ),
            ("GET", "/channels/10", json!({ "id": "10", "type": 0 })),
            ("GET", "/channels/30/messages/40", owner),
            (
                "POST",
                "/channels/10/threads",
                json!({ "id": "50", "parent_id": "10" }),
            ),
        ])
        .await;
        let made = threads(base, &["10", "30"])
            .create_now("30", "40", "T")
            .await;
        assert_eq!(made, Ok("50".to_string()));
        let seen = seen.lock().unwrap();
        assert!(
            seen.iter()
                .all(|(_, p, _)| !p.contains("/messages/40/threads")),
            "no nested thread"
        );
        let post = seen.iter().find(|(m, _, _)| m == "POST").unwrap();
        assert_eq!(post.2["type"], 11);
    }

    #[tokio::test]
    async fn a_lane_thread_in_a_forum_is_a_post_with_a_starter_message() {
        let owner: Value = serde_json::from_str(OWNER_MSG).unwrap();
        let (base, seen) = discord(vec![
            (
                "GET",
                "/channels/30",
                json!({ "id": "30", "type": 11, "parent_id": "15" }),
            ),
            (
                "GET",
                "/channels/15",
                json!({ "id": "15", "type": 15, "flags": 0 }),
            ),
            ("GET", "/channels/30/messages/40", owner),
            (
                "POST",
                "/channels/15/threads",
                json!({ "id": "50", "parent_id": "15" }),
            ),
        ])
        .await;
        let made = threads(base, &["15"]).create_now("30", "40", "T").await;
        assert_eq!(made, Ok("50".to_string()));
        let seen = seen.lock().unwrap();
        let post = seen.iter().find(|(m, _, _)| m == "POST").unwrap();
        assert_eq!(post.2["message"]["content"], "T");
        assert_eq!(post.2["message"]["allowed_mentions"]["parse"], json!([]));
        assert!(post.2.get("type").is_none());
    }

    #[tokio::test]
    async fn a_forum_that_requires_tags_is_refused_before_any_write() {
        let (base, seen) = discord(vec![
            (
                "GET",
                "/channels/30",
                json!({ "id": "30", "type": 11, "parent_id": "15" }),
            ),
            (
                "GET",
                "/channels/15",
                json!({ "id": "15", "type": 15, "flags": 16 }),
            ),
        ])
        .await;
        let made = threads(base, &["15"]).create_now("30", "40", "T").await;
        assert!(
            matches!(&made, Err((false, why)) if why.contains("tag")),
            "{made:?}"
        );
        assert!(seen.lock().unwrap().iter().all(|(m, _, _)| m == "GET"));
    }

    #[test]
    fn status_words_replace_each_other_and_never_overflow() {
        assert_eq!(
            titled("Fix login", "working").as_deref(),
            Some("[working] Fix login")
        );
        assert_eq!(
            titled("[working] Fix login", "done").as_deref(),
            Some("[done] Fix login")
        );
        assert_eq!(
            titled("[done] [waiting] x", "working").as_deref(),
            Some("[working] x")
        );
        assert_eq!(titled("[done] ", "working"), None);
        assert_eq!(titled(&"x".repeat(95), "working"), None);
    }
}
