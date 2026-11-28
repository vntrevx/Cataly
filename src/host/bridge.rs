//! The bridge registry (DESIGN 8 "Bridge link", EXT req. 2-5): single-use launch tokens issued to
//! the hub's own OMP children, the reconnect key of each accepted connection, and what the hub knows
//! about each session's bridge. Roles are assigned here, never claimed by the bridge.
//!
//! It also carries the one query the hub may send any accepted session's bridge, headless or not:
//! the read-only `model.resolve` (HOST req. 27). It never changes the model or the effort; a
//! terminal session's other commands stay with its port.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::{Notify, mpsc, oneshot};
use tokio::time::Instant;

use super::model::{Proof, Resolution};
use super::{Role, StartSpec};
use crate::omp::launch::Target;
use crate::proto::Response;
use crate::sys::now_ms;
use crate::{log, proto::ToolCapabilities};

/// A launch token is good for one hello identity within this time of the launch.
const TOKEN_LIFE_MS: i64 = 10 * 60 * 1000;
/// Tokens kept at most (a hub starts few sessions).
const TOKENS_MAX: usize = 64;
/// Tool answers kept per hub for repeated call IDs (EXT req. 18).
const ANSWERS_MAX: usize = 256;
/// Session processes kept at most, oldest dropped first (a hub starts few sessions).
const PIDS_MAX: usize = 256;
/// Bridge links kept at most. Every session start (a lead restart, each lane) gets a new handle, so
/// links of ended sessions are dropped, the longest disconnected first, beyond this many.
const LINKS_MAX: usize = 64;
/// Model queries waiting for their answer at most.
const ASKED_MAX: usize = 64;

/// What the hub shows about one session's bridge.
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
pub(crate) struct LinkView {
    pub(crate) connected: bool,
    pub(crate) session: Option<String>,
    pub(crate) since_ms: Option<i64>,
    pub(crate) last_seq: u64,
    pub(crate) dropped: u64,
}

struct Issued {
    handle: String,
    role: Role,
    /// The launch starts a new conversation; a resume continues one.
    fresh: bool,
    at_ms: i64,
    life_ms: i64,
    /// A token is claimed by one session and its private hello ID until the reply is acknowledged.
    hello: Option<(String, String)>,
}

struct Link {
    key: String,
    role: Role,
    view: LinkView,
    /// What the bridge last proved about the session's model; kept across reconnects.
    resolution: Option<Resolution>,
}

/// An accepted main-agent connection the hub may query.
struct Query {
    key: String,
    session: String,
    /// `Err` with the reason when the hello lacks the model-resolution capability.
    capable: Result<(), String>,
    tx: mpsc::Sender<Response>,
}

#[derive(Default)]
struct Inner {
    tokens: HashMap<String, Issued>,
    links: HashMap<String, Link>,
    answers: VecDeque<(String, String)>,
    /// The control port of each terminal-runtime session (DESIGN 4.3).
    ports: HashMap<String, Arc<super::tern::Port>>,
    /// The OMP process of each session: the hub's own child, or the peer of its accepted bridge.
    pids: VecDeque<(u32, String, Role)>,
    /// The queryable connection of each session.
    queries: HashMap<String, Query>,
    /// Queries sent, by number: the session's handle and the waiter.
    asked: HashMap<u64, (String, oneshot::Sender<Value>)>,
    next: u64,
    /// A lead hello has been accepted in this hub run.
    lead_greeted: bool,
    /// Reports belong to connections, so subagents cannot replace their parent's inventory.
    capabilities: HashMap<String, (String, ToolCapabilities)>,
}

/// Launch tokens and accepted bridge connections of this hub run.
#[derive(Default)]
pub(crate) struct Links {
    inner: Mutex<Inner>,
    /// Wakes a query waiting for its session's bridge to connect.
    arrived: Notify,
}

impl std::fmt::Debug for Links {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Links")
    }
}

impl Links {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Records the token handed to a session's OMP child before it is spawned.
    pub(crate) fn issue(&self, token: &str, spec: &StartSpec) {
        self.issue_for(token, spec, TOKEN_LIFE_MS);
    }

    /// A token good for `life_ms`: a terminal block's token is visible in the process list, so it
    /// lives 60 s (DESIGN 4.3).
    pub(crate) fn issue_for(&self, token: &str, spec: &StartSpec, life_ms: i64) {
        let now = now_ms();
        let mut inner = self.lock();
        inner.tokens.retain(|_, t| now - t.at_ms < t.life_ms);
        if inner.tokens.len() >= TOKENS_MAX {
            return;
        }
        inner.tokens.insert(
            token.to_string(),
            Issued {
                handle: spec.handle.clone(),
                role: spec.role,
                fresh: matches!(spec.target, Target::Fresh(_)),
                at_ms: now,
                life_ms,
                hello: None,
            },
        );
    }

    /// Claims a token for one hello (EXT req. 5, 10). Its private ID permits retrying a lost
    /// answer, not a nested process inheriting the token. Older bridges remain single-use.
    pub(crate) fn redeem(
        &self,
        token: &str,
        session: &str,
        hello_id: &str,
    ) -> Option<(String, Role, bool)> {
        let mut inner = self.lock();
        let issued = inner.tokens.get_mut(token)?;
        if now_ms() - issued.at_ms >= issued.life_ms {
            return None;
        }
        if let Some((s, id)) = &issued.hello {
            if s != session || id != hello_id || hello_id.is_empty() || session.is_empty() {
                return None;
            }
        } else if hello_id.is_empty() || session.is_empty() {
            let issued = inner.tokens.remove(token)?;
            return Some((issued.handle, issued.role, issued.fresh));
        } else {
            issued.hello = Some((session.to_string(), hello_id.to_string()));
        }
        Some((issued.handle.clone(), issued.role, issued.fresh))
    }

    /// The bridge sent a request after its welcome, so the launch token is no longer needed.
    pub(crate) fn confirm(&self, token: &str) {
        self.lock().tokens.remove(token);
    }

    /// Whether an accepted lead hello begins the lead's context, so the recap goes in front of it
    /// (EVR req. 48, OPC req. 57): its conversation is new, or it is the lead's first hello since
    /// the hub started. Any later hello of a resumed or woken conversation is a new connection to
    /// a context that already has its recap.
    pub(crate) fn lead_begins(&self, fresh: bool) -> bool {
        let first = !std::mem::replace(&mut self.lock().lead_greeted, true);
        fresh || first
    }

    /// Registers the control port of a terminal session under its handle.
    pub(crate) fn add_port(&self, handle: &str, port: Arc<super::tern::Port>) {
        self.lock().ports.insert(handle.to_string(), port);
    }

    pub(crate) fn port(&self, handle: &str) -> Option<Arc<super::tern::Port>> {
        self.lock().ports.get(handle).cloned()
    }

    pub(crate) fn remove_port(&self, handle: &str) {
        self.lock().ports.remove(handle);
    }

    /// The session a reconnect key belongs to.
    pub(crate) fn by_key(&self, key: &str) -> Option<(String, Role)> {
        self.lock()
            .links
            .iter()
            .find(|(_, l)| !key.is_empty() && l.key == key)
            .map(|(h, l)| (h.clone(), l.role))
    }

    /// An accepted connection; replaces an earlier one of the same session.
    pub(crate) fn connect(&self, handle: &str, role: Role, key: &str, session: &str) {
        let mut inner = self.lock();
        let previous = inner.links.remove(handle);
        if let Some(previous) = &previous {
            inner.capabilities.remove(&previous.key);
        }
        let resolution = previous.and_then(|l| l.resolution);
        inner.links.insert(
            handle.to_string(),
            Link {
                key: key.to_string(),
                role,
                view: LinkView {
                    connected: true,
                    session: Some(session.to_string()).filter(|s| !s.is_empty()),
                    since_ms: Some(now_ms()),
                    last_seq: 0,
                    dropped: 0,
                },
                resolution,
            },
        );
        while inner.links.len() > LINKS_MAX {
            let Some(oldest) = inner
                .links
                .iter()
                .filter(|(_, l)| !l.view.connected)
                .min_by_key(|(_, l)| l.view.since_ms)
                .map(|(h, _)| h.clone())
            else {
                break;
            };
            inner.links.remove(&oldest);
        }
    }

    /// How many links are kept (the hub's `stats`).
    pub(crate) fn kept(&self) -> usize {
        self.lock().links.len()
    }

    /// The connection with `key` closed; a newer connection of the session is left alone. Its
    /// queries end unanswered.
    pub(crate) fn disconnect(&self, handle: &str, key: &str) {
        let mut inner = self.lock();
        inner.capabilities.remove(key);
        if let Some(link) = inner.links.get_mut(handle)
            && link.key == key
        {
            link.view.connected = false;
            link.view.since_ms = Some(now_ms());
        }
        if inner.queries.get(handle).is_some_and(|q| q.key == key) {
            inner.queries.remove(handle);
            inner.asked.retain(|_, (h, _)| h != handle);
        }
    }

    /// Notes an event: its number, a new session ID, events the bridge had to drop.
    pub(crate) fn observe(&self, handle: &str, seq: u64, session: Option<&str>, dropped: u64) {
        let mut inner = self.lock();
        let session = session.filter(|s| !s.is_empty());
        if let Some(link) = inner.links.get_mut(handle) {
            link.view.last_seq = link.view.last_seq.max(seq);
            link.view.dropped += dropped;
            if let Some(s) = session {
                link.view.session = Some(s.to_string());
            }
        }
        if let (Some(query), Some(s)) = (inner.queries.get_mut(handle), session) {
            s.clone_into(&mut query.session);
        }
    }

    /// Opens an accepted main-agent connection with `key` to the hub's model query; `hello` says
    /// whether its bridge can answer one (`model_resolution_version`).
    pub(crate) fn open_query(
        &self,
        handle: &str,
        key: &str,
        hello: &Value,
        tx: mpsc::Sender<Response>,
    ) {
        let text = |k: &str| hello.get(k).and_then(Value::as_str).unwrap_or_default();
        let capable = match hello
            .get("model_resolution_version")
            .and_then(Value::as_u64)
        {
            Some(super::model::VERSION) => Ok(()),
            _ => Err(super::model::old_bridge(text("version"))),
        };
        let query = Query {
            key: key.to_string(),
            session: text("session").to_string(),
            capable,
            tx,
        };
        self.lock().queries.insert(handle.to_string(), query);
        self.arrived.notify_waiters();
    }

    /// A `bridge.reply` to a query.
    pub(crate) fn answer(&self, params: &Value) {
        let n = params.get("n").and_then(Value::as_u64).unwrap_or(0);
        if let Some((_, waiter)) = self.lock().asked.remove(&n) {
            let _ = waiter.send(params.clone());
        }
    }

    /// What OMP in session `handle` makes of `selector` (with an explicit `thinking`, which wins
    /// over its suffix), asked of the session's bridge with the read-only `model.resolve`. It
    /// waits for the bridge to connect and answer until `until`, the caller's deadline. A bridge
    /// whose hello lacks the capability is unverified at once, without a query, and so is a
    /// session whose bridge never connected by `until`. `Err` when a connected bridge gave no
    /// answer. A bridge that has not connected by `connect_by` counts as never connecting. Nothing
    /// is recorded: the caller records the resolution with `resolved` once OMP runs it.
    pub(crate) async fn resolve_model(
        &self,
        handle: &str,
        selector: &str,
        thinking: Option<&str>,
        (connect_by, until): (Instant, Instant),
    ) -> Result<Proof, String> {
        let (session, tx) = loop {
            let arrived = self.arrived.notified();
            tokio::pin!(arrived);
            arrived.as_mut().enable();
            if let Some(q) = self.lock().queries.get(handle) {
                if let Err(why) = &q.capable {
                    return Ok(Proof::Unverified(why.clone()));
                }
                break (q.session.clone(), q.tx.clone());
            }
            if tokio::time::timeout_at(connect_by.min(until), arrived)
                .await
                .is_err()
            {
                return Ok(Proof::Unverified(super::model::NO_BRIDGE.into()));
            }
        };
        let (waiter, answered) = oneshot::channel();
        let n = {
            let mut inner = self.lock();
            if inner.asked.len() >= ASKED_MAX {
                return Err("too many model queries are waiting".into());
            }
            inner.next += 1;
            let n = inner.next;
            inner.asked.insert(n, (handle.to_string(), waiter));
            n
        };
        let cmd = json!({ "cmd": { "op": "model.resolve", "n": n, "session": session,
            "selector": selector, "thinking": thinking } });
        let closed = "the session's Cataly bridge closed before answering";
        let reply = match tokio::time::timeout_at(until, tx.send(Response::item(0, cmd))).await {
            Ok(Ok(())) => match tokio::time::timeout_at(until, answered).await {
                Ok(Ok(reply)) => Ok(reply),
                Ok(Err(_)) => Err(closed),
                Err(_) => Err("the session's Cataly bridge did not answer in time"),
            },
            _ => Err(closed),
        };
        self.lock().asked.remove(&n);
        Proof::from_reply(&reply?)
    }

    /// Records what a bridge proved about a session's model (also over a terminal port).
    pub(crate) fn resolved(&self, handle: &str, resolution: Resolution) {
        if let Some(link) = self.lock().links.get_mut(handle) {
            link.resolution = Some(resolution);
        }
    }

    /// What the session's bridge last proved about its model.
    pub(crate) fn resolution(&self, handle: &str) -> Option<Resolution> {
        self.lock()
            .links
            .get(handle)
            .and_then(|l| l.resolution.clone())
    }

    pub(crate) fn view(&self, handle: &str) -> LinkView {
        self.lock()
            .links
            .get(handle)
            .map_or_default(|l| l.view.clone())
    }

    /// Records a changed inventory from an accepted connection, including an empty inventory.
    pub(crate) fn report_tools(&self, key: &str, handle: &str, report: ToolCapabilities) {
        let mut inner = self.lock();
        let previous = inner.capabilities.get_mut(key);
        if previous.as_ref().is_some_and(|(_, old)| *old == report) {
            return;
        }
        log::info(
            "session non-stock tools changed",
            &[
                ("session", &report.session),
                ("handle", &handle),
                ("nonstock", &report.nonstock.join(", ")),
            ],
        );
        match previous {
            Some((_, stored)) => *stored = report,
            None => {
                inner
                    .capabilities
                    .insert(key.to_string(), (handle.to_string(), report));
            }
        }
    }

    /// Current reports, optionally restricted to one lead or lane and its subagents.
    pub(crate) fn tool_reports(&self, handle: Option<&str>) -> Vec<ToolCapabilities> {
        let mut reports: Vec<_> = self
            .lock()
            .capabilities
            .values()
            .filter(|(owner, _)| handle.is_none_or(|h| h == owner))
            .map(|(_, report)| report.clone())
            .collect();
        reports.sort_unstable_by(|a, b| a.session.cmp(&b.session));
        reports
    }

    /// The answer already given to a tool call ID, so a retry does nothing twice (EXT req. 18).
    pub(crate) fn answered(&self, call: &str) -> Option<String> {
        self.lock()
            .answers
            .iter()
            .find(|(c, _)| c == call)
            .map(|(_, a)| a.clone())
    }

    pub(crate) fn remember(&self, call: &str, answer: &str) {
        let mut inner = self.lock();
        if inner.answers.len() >= ANSWERS_MAX {
            inner.answers.pop_front();
        }
        inner
            .answers
            .push_back((call.to_string(), answer.to_string()));
    }

    /// Records the OMP process of a session, so a control connection from it or from one of its
    /// descendants gets that session's role (DESIGN 8).
    pub(crate) fn adopt(&self, pid: u32, handle: &str, role: Role) {
        let mut inner = self.lock();
        inner.pids.retain(|(p, _, _)| *p != pid);
        if inner.pids.len() >= PIDS_MAX {
            inner.pids.pop_front();
        }
        inner.pids.push_back((pid, handle.to_string(), role));
    }

    /// The session whose OMP process comes first in `chain` (a process, then its ancestors).
    pub(crate) fn place(&self, chain: &[u32]) -> Option<(String, Role)> {
        let inner = self.lock();
        chain.iter().find_map(|pid| {
            inner
                .pids
                .iter()
                .find(|(p, _, _)| p == pid)
                .map(|(_, handle, role)| (handle.clone(), *role))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_single_use_and_keys_find_their_session() {
        let links = Links::default();
        let fresh = super::super::testing::spec("h1", None);
        links.issue("t1", &fresh);
        assert_eq!(
            links.redeem("t1", "s1", ""),
            Some(("h1".into(), Role::Lead, true))
        );
        assert_eq!(links.redeem("t1", "s1", ""), None);
        assert_eq!(links.redeem("nope", "s1", ""), None);
        let resume = super::super::testing::spec("h2", Some(("A", "/x/a.jsonl".into())));
        links.issue("t2", &resume);
        assert_eq!(
            links.redeem("t2", "s2", ""),
            Some(("h2".into(), Role::Lead, false))
        );
        links.connect("h1", Role::Lead, "k1", "s1");
        assert_eq!(links.by_key("k1"), Some(("h1".into(), Role::Lead)));
        assert_eq!(links.by_key(""), None);
        links.observe("h1", 7, Some("s2"), 3);
        let v = links.view("h1");
        assert!(v.connected && v.last_seq == 7 && v.dropped == 3);
        assert_eq!(v.session.as_deref(), Some("s2"));
        links.disconnect("h1", "old");
        assert!(links.view("h1").connected);
        links.disconnect("h1", "k1");
        assert!(!links.view("h1").connected);
        links.remember("c1", "done");
        assert_eq!(links.answered("c1").as_deref(), Some("done"));
        links.adopt(40, "h1", Role::Lead);
        links.adopt(50, "h2", Role::Lane);
        assert_eq!(
            links.place(&[60, 50, 40, 1]),
            Some(("h2".into(), Role::Lane))
        );
        assert_eq!(links.place(&[41, 40]), Some(("h1".into(), Role::Lead)));
        assert_eq!(links.place(&[41, 1]), None);
    }

    #[test]
    fn an_unanswered_hello_reuses_only_its_own_unexpired_launch_identity() {
        let links = Links::default();
        let spec = super::super::testing::spec("h1", None);
        links.issue("t1", &spec);
        let accepted = Some(("h1".into(), Role::Lead, true));
        assert_eq!(links.redeem("t1", "s1", "private-id"), accepted);
        // The welcome can be lost after the hub has already accepted and closed the link.
        links.connect("h1", Role::Lead, "lost-key", "s1");
        links.disconnect("h1", "lost-key");
        assert_eq!(links.redeem("t1", "s1", "private-id"), accepted);
        assert_eq!(links.redeem("t1", "s1", "nested-id"), None);
        assert_eq!(links.redeem("t1", "other-session", "private-id"), None);
        assert_eq!(links.redeem("t1", "s1", ""), None);
        assert_eq!(links.redeem("t1", "s1", "private-id"), accepted);
        links.confirm("t1");
        assert_eq!(links.redeem("t1", "s1", "private-id"), None);

        links.issue("expired", &spec);
        assert_eq!(links.redeem("expired", "s1", "private-id"), accepted);
        // Move issuance back, rather than sleeping: retries never extend the token's lifetime.
        links.lock().tokens.get_mut("expired").unwrap().at_ms -= TOKEN_LIFE_MS;
        assert_eq!(links.redeem("expired", "s1", "private-id"), None);
    }

    /// A hello is a connection, not a new conversation: only a new conversation, or the lead's
    /// first hello since the hub started, begins the lead's context.
    #[test]
    fn only_a_new_conversation_or_the_first_lead_hello_of_a_run_begins_the_lead() {
        let links = Links::default();
        assert!(
            links.lead_begins(false),
            "the first hello since the hub started"
        );
        assert!(!links.lead_begins(false), "a resumed or woken conversation");
        assert!(links.lead_begins(true), "a new conversation");
        assert!(!links.lead_begins(false));
    }

    /// Every session start brings a new handle; ended sessions' links do not pile up, and a
    /// connected link is never dropped.
    #[test]
    fn links_of_ended_sessions_are_bounded() {
        let links = Links::default();
        links.connect("lead", Role::Lead, "k-lead", "s-lead");
        for n in 0..1000 {
            let (handle, key) = (format!("h{n}"), format!("k{n}"));
            links.connect(&handle, Role::Lane, &key, "s");
            links.disconnect(&handle, &key);
        }
        assert!(links.kept() <= LINKS_MAX, "{} links kept", links.kept());
        assert!(links.view("lead").connected);
        assert_eq!(links.by_key("k-lead"), Some(("lead".into(), Role::Lead)));
    }

    /// The model query waits for the session's bridge, goes out on its connection with the
    /// session it names, and comes back by number; an old hello is unverified without a query,
    /// and a closed connection ends the query instead of letting it wait for the deadline.
    #[tokio::test]
    async fn the_model_query_is_answered_by_the_sessions_bridge() {
        let links = Arc::new(Links::default());
        let until = Instant::now() + std::time::Duration::from_secs(5);
        let (tx, mut rx) = mpsc::channel(8);
        let asked = {
            let links = Arc::clone(&links);
            tokio::spawn(async move {
                links
                    .resolve_model("h1", "p/m:high", None, (until, until))
                    .await
            })
        };
        tokio::task::yield_now().await;
        links.connect("h1", Role::Lead, "k1", "s1");
        let hello = json!({ "session": "s1", "model_resolution_version": 1 });
        links.open_query("h1", "k1", &hello, tx);
        let cmd = rx.recv().await.unwrap().item.unwrap()["cmd"].clone();
        assert_eq!(
            (&cmd["op"], &cmd["session"], &cmd["selector"]),
            (&json!("model.resolve"), &json!("s1"), &json!("p/m:high"))
        );
        links.answer(&json!({ "n": cmd["n"], "model_resolution": { "version": 1,
            "selector": "p/m:high", "provider": "p", "id": "m",
            "thinking": { "requested": "high", "observed": "high" } } }));
        let Ok(Ok(Proof::Resolved(r))) = asked.await else {
            panic!("no resolution");
        };
        assert_eq!(
            (r.model(), r.requested.as_deref()),
            ("p/m".into(), Some("high"))
        );
        assert_eq!(links.resolution("h1"), None, "a query records nothing");

        let (tx, _rx) = mpsc::channel(8);
        links.open_query(
            "h2",
            "k2",
            &json!({ "session": "s2", "version": "0.2.6" }),
            tx,
        );
        let old = links
            .resolve_model("h2", "p/m", None, (until, until))
            .await
            .unwrap();
        assert!(
            matches!(&old, Proof::Unverified(why) if why.contains("(0.2.6)")),
            "{old:?}"
        );

        let (tx, _rx) = mpsc::channel(8);
        links.open_query("h3", "k3", &json!({ "model_resolution_version": 1 }), tx);
        let closing = {
            let links = Arc::clone(&links);
            tokio::spawn(
                async move { links.resolve_model("h3", "p/m", None, (until, until)).await },
            )
        };
        while links.lock().asked.is_empty() {
            tokio::task::yield_now().await;
        }
        links.disconnect("h3", "k3");
        let closed = closing.await.unwrap().unwrap_err();
        assert!(closed.contains("closed"), "{closed}");
        assert!(Instant::now() < until);
    }
}
