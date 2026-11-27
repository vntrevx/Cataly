//! A fake Discord on loopback only (DISC-OUT-27): the REST calls Cataly makes (bot and application
//! identity, the Gateway URL, channels, history, single messages, active threads, message create and
//! edit, reactions, typing, interaction callbacks; for setup the bot account with its avatar and
//! banner, the intent flags, the bot's servers, a server's channels and channel create) and a
//! Gateway WebSocket server. It records
//! every request, deduplicates creates by their enforced nonce as Discord does, keeps a history per
//! channel, answers a reply with message type 19 and its reference, and lets a test script the next
//! create statuses, fail every read of a path, start a thread from a message, push dispatches, and
//! send op 7, op 9 or a close code. With a token set, any other token gets 401.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt as _, StreamExt as _};
use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;

pub const BOT: &str = "500000000000000001";
pub const APP: &str = "500000000000000002";
pub const GUILD: &str = "500000000000000003";
/// The user who owns the fake application.
pub const APP_OWNER: &str = "500000000000000004";

/// One request as the server saw it.
#[derive(Debug, Clone)]
pub struct Seen {
    pub method: String,
    pub path: String,
    pub query: String,
    pub authorization: Option<String>,
    /// A JSON body, or a multipart body's `payload_json`.
    pub body: Value,
    /// A multipart body's files, by name, each with its size.
    pub files: Vec<(String, usize)>,
}

/// A command for the Gateway connection.
#[derive(Debug, Clone)]
pub enum Gw {
    Dispatch(&'static str, Value),
    Op7,
    Op9(bool),
    Close(u16),
}

#[derive(Default)]
struct State {
    seen: Vec<Seen>,
    scripted: VecDeque<u16>,
    /// Channel -> statuses for its next message creates, used before `scripted`.
    scripted_in: HashMap<String, VecDeque<u16>>,
    callbacks: VecDeque<u16>,
    /// Path -> the status a GET of it gets, and for how many GETs more (`None`: every one).
    failing_reads: HashMap<String, (u16, Option<usize>)>,
    nonces: HashMap<(String, String), u64>,
    next_id: u64,
    created: usize,
    /// Channel -> messages, oldest first.
    history: HashMap<String, Vec<Value>>,
    /// Channel -> its object.
    channels: HashMap<String, Value>,
    threads: Vec<Value>,
    /// Gateway: hello interval, whether heartbeats are acknowledged, the resume URL offered.
    interval_ms: u64,
    no_ack: bool,
    resume_url: Option<String>,
    seq: u64,
    /// "identify" or "resume", one per connection.
    connections: Vec<String>,
    gateway: Option<mpsc::UnboundedSender<Gw>>,
    /// Voice: the voice server endpoint answered to op 4, the guild snapshot sent after READY
    /// when the guilds intent is requested, the op 4 frames and the intents of each identify.
    voice_endpoint: Option<String>,
    guild: Option<Value>,
    voice_ops: Vec<Value>,
    intents: Vec<u64>,
    /// Setup: the token the fake accepts (any when unset), the application's flags, the servers
    /// the bot is in, and the bot's avatar and banner hashes with the data each was set from.
    token: Option<String>,
    app_flags: u64,
    /// The application's interactions endpoint URL; set, buttons do not come over the Gateway.
    interactions_url: Option<String>,
    guilds: Vec<Value>,
    profile: HashMap<String, (String, String)>,
    /// Channel -> the Discord error code its reads get (50001 or 50013).
    denied: HashMap<String, u64>,
    /// Setup's permission check: the server's `@everyone` permissions (View Channel, Send
    /// Messages, Connect and Speak when unset).
    everyone: Option<u64>,
}

pub struct FakeDiscord {
    pub port: u16,
    pub gateway_port: u16,
    state: Arc<Mutex<State>>,
}

impl FakeDiscord {
    pub fn start() -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let gw = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        gw.set_nonblocking(true).unwrap();
        let gateway_port = gw.local_addr().unwrap().port();
        let state = Arc::new(Mutex::new(State {
            next_id: 900_000_000_000_000_000,
            interval_ms: 1_000,
            app_flags: 1 << 18,
            ..State::default()
        }));
        let shared = Arc::clone(&state);
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async move {
                let listener = tokio::net::TcpListener::from_std(listener).unwrap();
                let gw = tokio::net::TcpListener::from_std(gw).unwrap();
                let gw_state = Arc::clone(&shared);
                tokio::spawn(async move {
                    loop {
                        let Ok((stream, _)) = gw.accept().await else {
                            continue;
                        };
                        let state = Arc::clone(&gw_state);
                        tokio::spawn(gateway(stream, state, gateway_port));
                    }
                });
                loop {
                    let Ok((stream, _)) = listener.accept().await else {
                        continue;
                    };
                    let state = Arc::clone(&shared);
                    tokio::spawn(async move {
                        let service = service_fn(move |req| answer(req, Arc::clone(&state)));
                        let _ = hyper::server::conn::http1::Builder::new()
                            .serve_connection(TokioIo::new(stream), service)
                            .await;
                    });
                }
            });
        });
        let fake = Self {
            port,
            gateway_port,
            state,
        };
        fake.serve_gateway();
        fake
    }

    pub fn base(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn script(&self, statuses: &[u16]) {
        self.state.lock().unwrap().scripted.extend(statuses);
    }

    /// Statuses for the next message creates in one channel: a 4xx refuses before anything is
    /// stored; any other status is answered after the message is stored (the create may have
    /// happened); `0` answers as usual.
    pub fn script_in(&self, channel: &str, statuses: &[u16]) {
        self.state
            .lock()
            .unwrap()
            .scripted_in
            .entry(channel.to_string())
            .or_default()
            .extend(statuses);
    }

    /// Statuses for interaction acknowledgements; unlike creates these never retry.
    pub fn script_callbacks(&self, statuses: &[u16]) {
        self.state.lock().unwrap().callbacks.extend(statuses);
    }

    /// Drops the statuses still scripted for one channel.
    pub fn unscript_in(&self, channel: &str) {
        self.state.lock().unwrap().scripted_in.remove(channel);
    }

    /// Sets `locked` on a thread started with [`Self::start_thread`], as Discord shows it.
    pub fn lock_thread(&self, channel: &str, thread: &str) {
        let mut s = self.state.lock().unwrap();
        let lock = |t: &mut Value| t["thread_metadata"]["locked"] = json!(true);
        if let Some(t) = s.channels.get_mut(thread) {
            lock(t);
        }
        s.threads
            .iter_mut()
            .filter(|t| t["id"] == thread)
            .for_each(lock);
        if let Some(m) = s
            .history
            .get_mut(channel)
            .and_then(|l| l.iter_mut().find(|m| m["id"] == thread))
        {
            lock(&mut m["thread"]);
        }
    }

    pub fn seen(&self) -> Vec<Seen> {
        self.state.lock().unwrap().seen.clone()
    }

    pub fn messages(&self) -> usize {
        self.state.lock().unwrap().created
    }

    pub fn creates(&self) -> Vec<Seen> {
        self.seen()
            .into_iter()
            .filter(|s| s.method == "POST" && s.path.ends_with("/messages"))
            .collect()
    }

    /// Requests whose method and path match.
    pub fn calls(&self, method: &str, path_part: &str) -> Vec<Seen> {
        self.seen()
            .into_iter()
            .filter(|s| s.method == method && s.path.contains(path_part))
            .collect()
    }

    pub fn wait_creates(&self, n: usize, limit: Duration) -> Vec<Seen> {
        self.wait(limit, |f| {
            let c = f.creates();
            (c.len() >= n).then_some(c)
        })
    }

    /// Polls `f` every 20 ms for at most `limit`.
    pub fn wait<T>(&self, limit: Duration, mut f: impl FnMut(&Self) -> Option<T>) -> T {
        let limit = super::patience(limit);
        let deadline = std::time::Instant::now() + limit;
        loop {
            if let Some(v) = f(self) {
                return v;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "condition not met within {limit:?}; requests: {:?}",
                self.seen()
                    .iter()
                    .map(|s| format!("{} {}", s.method, s.path))
                    .collect::<Vec<_>>()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Declares a channel (type 0 in the guild unless given).
    pub fn channel(&self, id: &str, kind: u64, parent: Option<&str>) {
        let mut v = json!({"id": id, "type": kind, "guild_id": GUILD});
        if let Some(p) = parent {
            v["parent_id"] = json!(p);
        }
        self.state.lock().unwrap().channels.insert(id.into(), v);
    }

    /// Takes the bot's View Channel (`code` 50001) or Read Message History (50013) in `channel`;
    /// 0 gives it back.
    pub fn deny(&self, channel: &str, code: u64) {
        let mut s = self.state.lock().unwrap();
        if code == 0 {
            s.denied.remove(channel);
        } else {
            s.denied.insert(channel.into(), code);
        }
    }

    /// An active thread for the listing.
    pub fn thread(&self, id: &str, parent: &str) {
        self.channel(id, 11, Some(parent));
        self.state
            .lock()
            .unwrap()
            .threads
            .push(json!({"id": id, "parent_id": parent, "type": 11,
            "guild_id": GUILD, "thread_metadata": {"archived": false}}));
    }

    /// Starts a thread from a message as the Discord client does: the thread takes the message's
    /// ID, the message names it in `thread`, the active listing has it and `THREAD_CREATE` is sent.
    pub fn start_thread(&self, channel: &str, message: &str, by: &str) {
        let thread = json!({"id": message, "parent_id": channel, "type": 11, "guild_id": GUILD,
            "owner_id": by, "thread_metadata": {"archived": false, "locked": false}});
        {
            let mut s = self.state.lock().unwrap();
            s.channels.insert(message.into(), thread.clone());
            s.threads.push(thread.clone());
            if let Some(m) = s
                .history
                .get_mut(channel)
                .and_then(|l| l.iter_mut().find(|m| m["id"] == message))
            {
                m["thread"] = thread.clone();
            }
        }
        self.gw(Gw::Dispatch("THREAD_CREATE", thread));
    }

    /// Every GET of `path` gets `status` from now on.
    pub fn fail_reads(&self, path: &str, status: u16) {
        self.state
            .lock()
            .unwrap()
            .failing_reads
            .insert(path.into(), (status, None));
    }

    /// The next `times` GETs of `path` get `status`; later ones are answered as usual.
    pub fn fail_reads_times(&self, path: &str, status: u16, times: usize) {
        self.state
            .lock()
            .unwrap()
            .failing_reads
            .insert(path.into(), (status, Some(times)));
    }

    /// A message object.
    pub fn message(channel: &str, id: u64, author: &str, content: &str) -> Value {
        json!({"id": id.to_string(), "channel_id": channel, "type": 0, "content": content,
            "author": {"id": author}, "attachments": []})
    }

    /// Adds a message to a channel's history only (seen by catch-up reads, not live).
    pub fn put(&self, message: Value) {
        let channel = message["channel_id"].as_str().unwrap().to_string();
        let mut s = self.state.lock().unwrap();
        let list = s.history.entry(channel).or_default();
        list.push(message);
        list.sort_by_key(|m| m["id"].as_str().unwrap().parse::<u64>().unwrap());
    }

    /// Adds a message to its history and sends it live.
    pub fn say(&self, message: Value) {
        self.put(message.clone());
        self.gw(Gw::Dispatch("MESSAGE_CREATE", message));
    }

    pub fn gw(&self, cmd: Gw) {
        let tx = self.state.lock().unwrap().gateway.clone();
        if let Some(tx) = tx {
            let _ = tx.send(cmd);
        }
    }

    /// "identify" or "resume" for each Gateway connection so far.
    pub fn connections(&self) -> Vec<String> {
        self.state.lock().unwrap().connections.clone()
    }

    pub fn wait_connections(&self, n: usize, limit: Duration) -> Vec<String> {
        self.wait(limit, |f| {
            let c = f.connections();
            (c.len() >= n).then_some(c)
        })
    }

    pub fn set_no_ack(&self, on: bool) {
        self.state.lock().unwrap().no_ack = on;
    }

    /// Answers op 4 with voice-state and voice-server updates naming `endpoint`, and sends `guild`
    /// as `GUILD_CREATE` after `READY` when the guilds intent is requested.
    pub fn set_voice(&self, endpoint: &str, guild: Value) {
        let mut s = self.state.lock().unwrap();
        s.voice_endpoint = Some(endpoint.into());
        s.guild = Some(guild);
    }

    /// The op 4 frames the bot sent.
    pub fn voice_ops(&self) -> Vec<Value> {
        self.state.lock().unwrap().voice_ops.clone()
    }

    /// The intents of each identify.
    pub fn intents(&self) -> Vec<u64> {
        self.state.lock().unwrap().intents.clone()
    }

    /// Only this token is accepted from now on; any other gets 401.
    pub fn set_token(&self, token: &str) {
        self.state.lock().unwrap().token = Some(token.into());
    }

    /// The application's flags (default: the Message Content intent for 100 or more servers).
    pub fn set_app_flags(&self, flags: u64) {
        self.state.lock().unwrap().app_flags = flags;
    }

    /// Gives the application an interactions endpoint URL, so presses would not reach the Gateway.
    pub fn set_interactions_url(&self, url: &str) {
        self.state.lock().unwrap().interactions_url = Some(url.into());
    }

    pub fn app_flags(&self) -> u64 {
        self.state.lock().unwrap().app_flags
    }

    /// The bot's avatar or banner as its owner set it by hand: `hash`, from unknown data.
    pub fn set_image(&self, field: &str, hash: &str) {
        self.state
            .lock()
            .unwrap()
            .profile
            .insert(field.into(), (hash.into(), String::new()));
    }

    /// The bot's avatar or banner, or the application's icon: its hash and the data URI it was set
    /// from.
    pub fn image(&self, field: &str) -> Option<(String, String)> {
        self.state.lock().unwrap().profile.get(field).cloned()
    }

    /// The bot joins a server.
    pub fn join(&self, id: &str, name: &str) {
        self.state
            .lock()
            .unwrap()
            .guilds
            .push(json!({ "id": id, "name": name, "owner": false, "permissions": "0" }));
    }

    /// A named channel of a server, as the channel list shows it.
    pub fn named(&self, id: &str, name: &str, kind: u64, guild: &str) {
        self.state.lock().unwrap().channels.insert(
            id.into(),
            json!({ "id": id, "name": name, "type": kind, "guild_id": guild }),
        );
    }

    /// The `@everyone` permissions of every server.
    pub fn everyone_permissions(&self, bits: u64) {
        self.state.lock().unwrap().everyone = Some(bits);
    }

    /// Sets a channel's permission overwrites.
    pub fn overwrites(&self, channel: &str, list: Value) {
        let mut s = self.state.lock().unwrap();
        if let Some(c) = s.channels.get_mut(channel) {
            c["permission_overwrites"] = list;
        }
    }

    pub fn set_resume_url(&self, url: &str) {
        self.state.lock().unwrap().resume_url = Some(url.into());
    }

    /// The messages the bot created in a channel, oldest first.
    pub fn bot_messages(&self, channel: &str) -> Vec<Value> {
        self.state
            .lock()
            .unwrap()
            .history
            .get(channel)
            .map_or_else(Vec::new, |l| {
                l.iter()
                    .filter(|m| m["author"]["id"] == BOT)
                    .cloned()
                    .collect()
            })
    }

    /// The config lines that point the hub at this fake.
    pub fn config(&self, token_file: &std::path::Path, owner: &str, channels: &[&str]) -> String {
        let list: Vec<String> = channels.iter().map(|c| format!("\"{c}\"")).collect();
        format!(
            "[discord]\ntoken_file = \"{}\"\napi_base = \"{}\"\nowner = \"{owner}\"\nchannels = [{}]\n",
            token_file.display(),
            self.base(),
            list.join(", ")
        )
    }
}

async fn gateway(stream: tokio::net::TcpStream, state: Arc<Mutex<State>>, port: u16) {
    let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else {
        return;
    };
    let (tx, mut rx) = mpsc::unbounded_channel();
    let interval = {
        let mut s = state.lock().unwrap();
        s.gateway = Some(tx);
        s.interval_ms
    };
    let hello = json!({"op": 10, "d": {"heartbeat_interval": interval}});
    if ws.send(Message::text(hello.to_string())).await.is_err() {
        return;
    }
    let next_seq = |state: &Arc<Mutex<State>>| {
        let mut s = state.lock().unwrap();
        s.seq += 1;
        s.seq
    };
    loop {
        tokio::select! {
            incoming = ws.next() => {
                let Some(Ok(Message::Text(text))) = incoming else { return };
                let Ok(frame) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                match frame["op"].as_u64() {
                    Some(1) => {
                        if !state.lock().unwrap().no_ack {
                            let _ = ws.send(Message::text(json!({"op": 11}).to_string())).await;
                        }
                    }
                    Some(2) => {
                        let guild = {
                            let mut s = state.lock().unwrap();
                            let intents = frame["d"]["intents"].as_u64().unwrap_or(0);
                            s.intents.push(intents);
                            s.guild.clone().filter(|_| intents & 1 != 0)
                        };
                        let resume = {
                            let mut s = state.lock().unwrap();
                            s.connections.push("identify".into());
                            s.resume_url.clone().unwrap_or(format!("ws://127.0.0.1:{port}"))
                        };
                        let seq = next_seq(&state);
                        let ready = json!({"op": 0, "s": seq, "t": "READY", "d": {"session_id": "fake-session",
                            "resume_gateway_url": resume, "user": {"id": BOT, "bot": true}}});
                        let _ = ws.send(Message::text(ready.to_string())).await;
                        if let Some(g) = guild {
                            let seq = next_seq(&state);
                            let create = json!({"op": 0, "s": seq, "t": "GUILD_CREATE", "d": g});
                            let _ = ws.send(Message::text(create.to_string())).await;
                        }
                    }
                    Some(4) => {
                        let endpoint = {
                            let mut s = state.lock().unwrap();
                            s.voice_ops.push(frame["d"].clone());
                            s.voice_endpoint.clone()
                        };
                        let channel = frame["d"]["channel_id"].clone();
                        let vs = json!({"guild_id": GUILD, "channel_id": channel, "user_id": BOT,
                            "session_id": "fake-voice-session"});
                        let seq = next_seq(&state);
                        let update = json!({"op": 0, "s": seq, "t": "VOICE_STATE_UPDATE", "d": vs});
                        let _ = ws.send(Message::text(update.to_string())).await;
                        if let (Some(endpoint), false) = (endpoint, channel.is_null()) {
                            let seq = next_seq(&state);
                            let server = json!({"op": 0, "s": seq, "t": "VOICE_SERVER_UPDATE",
                                "d": {"guild_id": GUILD, "token": "fake-voice-token", "endpoint": endpoint}});
                            let _ = ws.send(Message::text(server.to_string())).await;
                        }
                    }
                    Some(6) => {
                        state.lock().unwrap().connections.push("resume".into());
                        let seq = next_seq(&state);
                        let resumed = json!({"op": 0, "s": seq, "t": "RESUMED", "d": {}});
                        let _ = ws.send(Message::text(resumed.to_string())).await;
                    }
                    _ => {}
                }
            }
            cmd = rx.recv() => {
                let Some(cmd) = cmd else { return };
                let frame = match cmd {
                    Gw::Dispatch(kind, d) => json!({"op": 0, "s": next_seq(&state), "t": kind, "d": d}),
                    Gw::Op7 => json!({"op": 7, "d": null}),
                    Gw::Op9(resumable) => json!({"op": 9, "d": resumable}),
                    Gw::Close(code) => {
                        let close = CloseFrame { code: code.into(), reason: "fake".into() };
                        let _ = ws.send(Message::Close(Some(close))).await;
                        return;
                    }
                };
                if ws.send(Message::text(frame.to_string())).await.is_err() {
                    return;
                }
            }
        }
    }
}

/// The application object, owned by [`APP_OWNER`].
fn application(s: &State) -> Value {
    json!({ "id": APP, "flags": s.app_flags, "interactions_endpoint_url": s.interactions_url,
        "icon": s.profile.get("icon").map(|(h, _)| h.clone()),
        "owner": { "id": APP_OWNER, "username": "fake-owner" }, "team": null })
}

fn reply(status: u16, body: &Value) -> Response<Full<Bytes>> {
    let bytes = if status == 204 {
        Bytes::new()
    } else {
        Bytes::from(body.to_string())
    };
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Full::new(bytes))
        .unwrap()
}

fn param(query: &str, key: &str) -> Option<u64> {
    query
        .split('&')
        .find_map(|p| p.strip_prefix(&format!("{key}=")))
        .and_then(|v| v.parse().ok())
}

/// Discord rejects out-of-range page sizes with a field-specific 400/50035, not an empty page.
fn invalid_limit(query: &str, minimum: i128) -> Option<Response<Full<Bytes>>> {
    let limit = query
        .split('&')
        .find_map(|p| p.strip_prefix("limit="))?
        .parse::<i128>()
        .ok()?;
    let (code, message) = if limit < minimum {
        (
            "NUMBER_TYPE_MIN",
            format!("int value should be greater than or equal to {minimum}."),
        )
    } else if limit > 100 {
        (
            "NUMBER_TYPE_MAX",
            "int value should be less than or equal to 100.".into(),
        )
    } else {
        return None;
    };
    Some(reply(
        400,
        &json!({ "message": "Invalid Form Body", "code": 50035,
            "errors": { "limit": { "_errors": [{ "code": code, "message": message }] } } }),
    ))
}

/// Reads that depend on the bot's access: a denied channel's (50001, no View Channel: every read
/// of it; 50013, no Read Message History: its history and threads) are refused, and a readable
/// channel's public archived threads are none.
fn access(s: &State, method: &str, parts: &[&str]) -> Option<Response<Full<Bytes>>> {
    let ("GET", ["channels", id, rest @ ..]) = (method, parts) else {
        return None;
    };
    match s.denied.get(*id).copied() {
        Some(code) if code == 50001 || !rest.is_empty() => Some(reply(
            403,
            &json!({ "message": "Missing Access", "code": code }),
        )),
        _ => (rest == ["threads", "archived", "public"]).then(|| {
            reply(
                200,
                &json!({ "threads": [], "members": [], "has_more": false }),
            )
        }),
    }
}

/// The calls `cataly setup` makes: the bot account (its avatar and banner kept and changed), the
/// application's intent flags, the bot's servers, a server's channels and a new channel.
fn setup_route(
    s: &mut State,
    method: &str,
    parts: &[&str],
    body: &Value,
) -> Option<Response<Full<Bytes>>> {
    Some(match (method, parts) {
        ("PATCH", ["applications", "@me"]) => {
            // Only the limited intent flags may be changed by a bot.
            if let Some(asked) = body["flags"].as_u64() {
                let limited = (1 << 13) | (1 << 15) | (1 << 19);
                s.app_flags = (s.app_flags & !limited) | (asked & limited);
            }
            if let Some(data) = body["icon"].as_str() {
                s.next_id += 1;
                let hash = format!("icon-{}", s.next_id);
                s.profile.insert("icon".into(), (hash, data.into()));
            }
            reply(200, &application(s))
        }
        ("GET" | "PATCH", ["users", "@me"]) => {
            for field in ["avatar", "banner"] {
                if let Some(data) = body[field].as_str() {
                    s.next_id += 1;
                    let hash = format!("{field}-{}", s.next_id);
                    s.profile.insert(field.into(), (hash, data.into()));
                }
            }
            let hash = |f: &str| s.profile.get(f).map(|(h, _)| h.clone());
            reply(
                200,
                &json!({"id": BOT, "username": "fake-bot", "bot": true,
                    "avatar": hash("avatar"), "banner": hash("banner")}),
            )
        }
        ("GET", ["users", "@me", "guilds"]) => reply(200, &Value::Array(s.guilds.clone())),
        ("GET", ["guilds", guild]) => {
            let everyone = s
                .everyone
                .unwrap_or((1 << 10) | (1 << 11) | (1 << 20) | (1 << 21));
            reply(
                200,
                &json!({ "id": guild, "owner_id": APP_OWNER, "roles": [
                    { "id": guild, "name": "@everyone", "permissions": everyone.to_string() }
                ]}),
            )
        }
        ("GET", ["guilds", _, "members", user]) => {
            reply(200, &json!({ "user": { "id": user }, "roles": [] }))
        }
        ("GET", ["guilds", guild, "channels"]) => {
            let list: Vec<Value> = s
                .channels
                .values()
                .filter(|c| c["guild_id"] == *guild && c.get("name").is_some())
                .cloned()
                .collect();
            reply(200, &Value::Array(list))
        }
        ("POST", ["guilds", guild, "channels"]) => {
            s.next_id += 1;
            let id = s.next_id.to_string();
            let channel = json!({ "id": id, "type": body["type"], "name": body["name"],
                "topic": body["topic"], "guild_id": guild });
            s.channels.insert(id, channel.clone());
            reply(201, &channel)
        }
        _ => return None,
    })
}

/// The scripted failure of a read (`FakeDiscord::fail_reads`).
fn failed_read(s: &mut State, method: &str, path: &str) -> Option<Response<Full<Bytes>>> {
    if method != "GET" {
        return None;
    }
    let (status, left) = s.failing_reads.get_mut(path)?;
    let status = *status;
    if let Some(left) = left {
        *left -= 1;
        if *left == 0 {
            s.failing_reads.remove(path);
        }
    }
    Some(scripted_failure(status))
}

/// A scripted failure with Discord's code for it: no access, unknown channel (a deleted thread),
/// an invalid body for another 4xx.
fn scripted_failure(status: u16) -> Response<Full<Bytes>> {
    let code = match status {
        403 => 50_001,
        404 => 10_003,
        400..500 => 50_035,
        _ => 0,
    };
    reply(status, &json!({ "message": "scripted", "code": code }))
}

async fn answer(
    req: Request<Incoming>,
    state: Arc<Mutex<State>>,
) -> Result<Response<Full<Bytes>>, std::convert::Infallible> {
    let method = req.method().to_string();
    let path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or_default().to_string();
    let authorization = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let content_type = req.headers().get("content-type").cloned();
    let bytes = req.into_body().collect().await.unwrap().to_bytes();
    let (body, files) = decode(content_type.as_ref().and_then(|v| v.to_str().ok()), &bytes);
    let mut s = state.lock().unwrap();
    let refused = s
        .token
        .as_ref()
        .is_some_and(|t| authorization.as_deref() != Some(format!("Bot {t}").as_str()));
    s.seen.push(Seen {
        method: method.clone(),
        path: path.clone(),
        query: query.clone(),
        authorization,
        body: body.clone(),
        files,
    });
    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    if refused {
        return Ok(reply(
            401,
            &json!({ "message": "401: Unauthorized", "code": 0 }),
        ));
    }
    // The live archived-thread API requires 2; message history permits 1.
    let invalid = match (method.as_str(), parts.as_slice()) {
        ("GET", ["channels", _, "threads", "archived", "public"]) => invalid_limit(&query, 2),
        ("GET", ["channels", _, "messages"]) => invalid_limit(&query, 1),
        _ => None,
    };
    if let Some(r) = invalid {
        return Ok(r);
    }
    let failed = failed_read(&mut s, &method, &path);
    if let Some(r) = failed
        .or_else(|| setup_route(&mut s, &method, &parts, &body))
        .or_else(|| access(&s, &method, &parts))
    {
        return Ok(r);
    }
    let unknown = json!({ "message": "Unknown Message", "code": 10008 });
    let response = match (method.as_str(), parts.as_slice()) {
        ("GET", ["applications", "@me"]) => reply(200, &application(&s)),
        ("GET", ["gateway"]) => {
            let url = s
                .channels
                .get("gateway")
                .and_then(|g| g["url"].as_str())
                .unwrap_or_default()
                .to_string();
            reply(200, &json!({ "url": url }))
        }
        ("GET", ["channels", id]) => {
            let channel = s
                .channels
                .get(*id)
                .cloned()
                .unwrap_or(json!({ "id": id, "type": 0, "guild_id": GUILD }));
            reply(200, &channel)
        }
        ("PATCH", ["channels", id]) => patch_channel(&mut s, id, &body),
        ("GET", ["guilds", _, "threads", "active"]) => {
            reply(200, &json!({ "threads": s.threads, "members": [] }))
        }
        ("GET", ["channels", id, "messages"]) => history_page(&s, id, &query),
        ("GET", ["channels", id, "messages", mid]) => {
            match s
                .history
                .get(*id)
                .and_then(|l| l.iter().find(|m| m["id"] == *mid).cloned())
            {
                Some(m) => reply(200, &m),
                None => reply(404, &unknown),
            }
        }
        ("POST", ["channels", id, "messages"]) => create(&mut s, id, &body),
        ("POST", ["channels", id, .., "threads"]) => start_thread(&mut s, id, &parts, &body),
        ("PATCH", ["channels", id, "messages", mid]) => edit_message(&mut s, id, mid, &body),
        (
            "PUT",
            ["channels", _, "messages", _, "reactions", _, "@me"]
            | ["channels", _, "messages", "pins", _],
        )
        | ("POST", ["channels", _, "typing"]) => reply(204, &Value::Null),
        ("POST", ["interactions", _, _, "callback"]) => {
            reply(s.callbacks.pop_front().unwrap_or(204), &Value::Null)
        }
        _ => reply(404, &json!({ "message": "Unknown", "code": 0 })),
    };
    Ok(response)
}

/// One page of a channel's history, newest first, as `limit` and `before` ask.
fn history_page(s: &State, id: &str, query: &str) -> Response<Full<Bytes>> {
    let limit = usize::try_from(param(query, "limit").unwrap_or(50)).unwrap();
    let before = param(query, "before");
    let list = s.history.get(id).cloned().unwrap_or_default();
    let page: Vec<Value> = list
        .iter()
        .rev()
        .filter(|m| before.is_none_or(|b| m["id"].as_str().unwrap().parse::<u64>().unwrap() < b))
        .take(limit)
        .cloned()
        .collect();
    reply(200, &Value::Array(page))
}

/// A request body: JSON, or a multipart body's `payload_json` with its files.
fn decode(content_type: Option<&str>, bytes: &[u8]) -> (Value, Vec<(String, usize)>) {
    match content_type.and_then(|c| c.strip_prefix("multipart/form-data; boundary=")) {
        Some(boundary) => multipart(bytes, boundary),
        None => (
            serde_json::from_slice(bytes).unwrap_or(Value::Null),
            Vec::new(),
        ),
    }
}

/// A public thread as Discord starts it: from a message (the thread takes the message's ID, one
/// thread per message, none inside a thread, and the message names it in `thread`) or without one.
fn start_thread(
    s: &mut State,
    parent: &str,
    parts: &[&str],
    body: &Value,
) -> Response<Full<Bytes>> {
    let message = match parts {
        [_, _, "messages", m, _] => Some(*m),
        _ => None,
    };
    let in_thread = s
        .channels
        .get(parent)
        .is_some_and(|c| matches!(c["type"].as_u64(), Some(11 | 12)));
    if in_thread {
        let why = json!({ "message": "Cannot execute action on this channel type", "code": 50024 });
        return reply(400, &why);
    }
    let id = match message {
        Some(m) => {
            let found = s
                .history
                .get(parent)
                .is_some_and(|l| l.iter().any(|x| x["id"] == m));
            if !found {
                return reply(404, &json!({ "message": "Unknown Message", "code": 10008 }));
            }
            if s.channels.contains_key(m) {
                let why = json!({ "message": "A thread has already been created for this message", "code": 160_004 });
                return reply(400, &why);
            }
            m.to_string()
        }
        None => (800_000_000_000_001_000u64 + s.threads.len() as u64).to_string(),
    };
    let thread = json!({ "id": id, "type": 11, "parent_id": parent, "guild_id": GUILD,
        "name": body["name"], "thread_metadata": { "archived": false } });
    if let Some(m) = message
        && let Some(source) = s
            .history
            .get_mut(parent)
            .and_then(|l| l.iter_mut().find(|x| x["id"] == m))
    {
        source["thread"] = thread.clone();
    }
    s.channels.insert(id, thread.clone());
    s.threads.push(thread.clone());
    reply(201, &thread)
}

/// A channel edit: a thread's name or archived flag.
fn patch_channel(s: &mut State, id: &str, body: &Value) -> Response<Full<Bytes>> {
    let channel = s
        .channels
        .entry(id.to_string())
        .or_insert_with(|| json!({ "id": id, "type": 11, "guild_id": GUILD }));
    for key in ["name", "archived"] {
        if let Some(v) = body.get(key) {
            if key == "archived" {
                channel["thread_metadata"] = json!({ "archived": v });
            } else {
                channel[key] = v.clone();
            }
        }
    }
    let channel = channel.clone();
    reply(200, &channel)
}

/// The Components V2 message flag.
const COMPONENTS_V2: u64 = 1 << 15;

/// As on Discord, a Components V2 message holds no content and no embeds.
fn v2_invalid(m: &Value) -> bool {
    let flags = m["flags"].as_u64().unwrap_or(0);
    let content = m["content"].as_str().is_some_and(|c| !c.is_empty());
    let embeds = m["embeds"].as_array().is_some_and(|e| !e.is_empty());
    flags & COMPONENTS_V2 != 0 && (content || embeds)
}

/// A message edit: its content, components, embeds and attachments. The Components V2 flag can be
/// set but never removed, and a V2 message must have its content and embeds emptied.
fn edit_message(s: &mut State, id: &str, mid: &str, body: &Value) -> Response<Full<Bytes>> {
    if let Some(m) = s
        .history
        .get_mut(id)
        .and_then(|l| l.iter_mut().find(|m| m["id"] == mid))
    {
        let mut next = m.clone();
        for key in ["content", "components", "embeds", "attachments"] {
            if let Some(c) = body.get(key) {
                next[key] = c.clone();
            }
        }
        let flags = next["flags"].as_u64().unwrap_or(0) | body["flags"].as_u64().unwrap_or(0);
        next["flags"] = json!(flags);
        if v2_invalid(&next) {
            return reply(400, &json!({"message": "Invalid Form Body", "code": 50035}));
        }
        *m = next;
    }
    reply(200, &json!({ "id": mid, "channel_id": id }))
}

/// A message create: deduplicated by enforced nonce (a repeat gets the stored message back), a
/// reply gets type 19 and its reference. A scripted 4xx refuses before anything is stored.
fn create(s: &mut State, id: &str, body: &Value) -> Response<Full<Bytes>> {
    let scripted = s
        .scripted_in
        .get_mut(id)
        .and_then(VecDeque::pop_front)
        .or_else(|| s.scripted.pop_front())
        .filter(|status| *status != 0);
    if let Some(status) = scripted.filter(|s| (400..500).contains(s)) {
        return scripted_failure(status);
    }
    // As on Discord, content over 2000 UTF-16 units is an invalid body.
    if body["content"]
        .as_str()
        .is_some_and(|c| c.encode_utf16().count() > 2000)
    {
        return reply(400, &json!({"message": "Invalid Form Body", "code": 50035}));
    }
    if v2_invalid(body) {
        return reply(400, &json!({"message": "Invalid Form Body", "code": 50035}));
    }
    let nonce = body["nonce"].as_str().unwrap_or_default().to_string();
    let enforced = body["enforce_nonce"] == true;
    let reference = body["message_reference"]["message_id"]
        .as_str()
        .map(str::to_string);
    let source_exists = reference.as_ref().is_none_or(|r| {
        s.history
            .get(id)
            .is_some_and(|l| l.iter().any(|m| m["id"] == r.as_str()))
    });
    if !source_exists && body["message_reference"]["fail_if_not_exists"] == true {
        return reply(400, &json!({"message": "Invalid Form Body", "code": 50035}));
    }
    // A nonce in another destination cannot confirm this post.
    let nonce_key = (id.to_string(), nonce.clone());
    let existing = s.nonces.get(&nonce_key).copied().filter(|_| enforced);
    let message = if let Some(m) = existing {
        m
    } else {
        // As on Discord, a new message's ID is above every message already in the channel.
        let newest = s.history.get(id).map_or(0, |l| {
            l.iter()
                .filter_map(|m| m["id"].as_str()?.parse::<u64>().ok())
                .max()
                .unwrap_or(0)
        });
        s.next_id = s.next_id.max(newest) + 1;
        s.created += 1;
        s.next_id
    };
    if enforced && !nonce.is_empty() {
        s.nonces.insert(nonce_key, message);
    }
    let mut created = json!({ "id": message.to_string(), "channel_id": id, "content": body["content"],
                "author": {"id": BOT, "bot": true}, "type": 0, "components": body["components"],
                "embeds": body["embeds"], "attachments": body["attachments"],
                "flags": body["flags"].as_u64().unwrap_or(0) });
    if let Some(r) = &reference {
        created["type"] = json!(19);
        created["message_reference"] = json!({"message_id": r, "channel_id": id});
    }
    if existing.is_none() {
        s.history
            .entry((id).to_string())
            .or_default()
            .push(created.clone());
    } else if let Some(stored) = s
        .history
        .values()
        .flatten()
        .find(|m| m["id"].as_str() == Some(created["id"].as_str().unwrap_or_default()))
    {
        created = stored.clone();
    }
    if let Some(status) = scripted {
        return reply(status, &json!({ "message": "scripted" }));
    }
    reply(200, &created)
}

/// The `payload_json` part of a multipart body and the name and size of each file part.
fn multipart(bytes: &[u8], boundary: &str) -> (Value, Vec<(String, usize)>) {
    let delimiter = format!("--{boundary}");
    let mut payload = Value::Null;
    let mut files = Vec::new();
    let find = |hay: &[u8], needle: &[u8], from: usize| {
        hay.get(from..)?
            .windows(needle.len())
            .position(|w| w == needle)
            .map(|p| p + from)
    };
    let mut at = 0;
    while let Some(start) = find(bytes, delimiter.as_bytes(), at) {
        let part_start = start + delimiter.len() + 2;
        let Some(end) = find(bytes, delimiter.as_bytes(), part_start) else {
            break;
        };
        let part = &bytes[part_start..end.saturating_sub(2).max(part_start)];
        if let Some(split) = find(part, b"\r\n\r\n", 0) {
            let headers = String::from_utf8_lossy(&part[..split]).to_string();
            let data = &part[split + 4..];
            if headers.contains("name=\"payload_json\"") {
                payload = serde_json::from_slice(data).unwrap_or(Value::Null);
            } else if let Some(name) = headers
                .split("filename=\"")
                .nth(1)
                .and_then(|r| r.split('"').next())
            {
                files.push((name.to_string(), data.len()));
            }
        }
        at = end;
    }
    (payload, files)
}

impl FakeDiscord {
    /// Makes `GET /gateway` name this fake's Gateway.
    pub fn serve_gateway(&self) {
        let url = format!("ws://127.0.0.1:{}", self.gateway_port);
        self.state
            .lock()
            .unwrap()
            .channels
            .insert("gateway".into(), json!({ "url": url }));
    }

    /// A button press interaction from `user` on bot message `message` in `channel` of the guild.
    pub fn press(&self, user: &str, channel: &str, message: &str, custom_id: &str) {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let raw = json!({"id": (700_000_000_000_000_000u64 + n).to_string(), "token": format!("tok{n}"),
            "application_id": APP, "channel_id": channel, "guild_id": GUILD, "type": 3,
            "data": {"component_type": 2, "custom_id": custom_id},
            "message": {"id": message}, "member": {"user": {"id": user}}});
        self.gw(Gw::Dispatch("INTERACTION_CREATE", raw));
    }

    /// Any component or modal interaction in the guild: `kind` 3 with `data` holding
    /// `component_type` and `values`, or 5 (modal submit) with its `components`.
    pub fn interact(&self, user: &str, channel: &str, message: &str, kind: u64, data: &Value) {
        self.interact_in(GUILD, user, channel, message, kind, data);
    }

    /// [`FakeDiscord::interact`] from the server `guild`.
    pub fn interact_in(
        &self,
        guild: &str,
        user: &str,
        channel: &str,
        message: &str,
        kind: u64,
        data: &Value,
    ) {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let raw = json!({"id": (710_000_000_000_000_000u64 + n).to_string(), "token": format!("tik{n}"),
            "application_id": APP, "channel_id": channel, "guild_id": guild, "type": kind, "data": data,
            "message": {"id": message}, "member": {"user": {"id": user}}});
        self.gw(Gw::Dispatch("INTERACTION_CREATE", raw));
    }
}
