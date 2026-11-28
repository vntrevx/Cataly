//! The shared relay pipeline (DESIGN 5.1): after a relay's owner gate has queued a message durably,
//! this hands it to the lead through the lead's inbox (owner messages, `owner: true`, the relay
//! message ID as request ID), adds the seen mark in parallel (DESIGN 12.2 C9), records the owed
//! reply, finishes the queue item in one transaction once the session file confirms the hand-off
//! (DISC-IN req. 49), holds the room when the hand-off is in doubt and tells the owner (DESIGN 9.3),
//! and posts the lead's final answer as a linked reply in parts from a durable outbox (DISC-OUT req.
//! 20-29, DESIGN 12.2 A16).

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Instant;

use tokio::sync::{Notify, watch};

use super::context::{self, Context};
use super::{Inbound, PartOutcome, Relay};
use crate::config::Config;
use crate::host::inbox::{self, Message, ReceiptState};
use crate::host::lead::{Events, Lead};
use crate::host::{Runtime, SessionEvent, Status};
use crate::jobs::event::{Emit, EventKind, Severity};
use crate::log;
use crate::omp::transcript::{self, Reply};
use crate::store::Store;
use crate::store::relay::{
    Arrived, HandoffRow, OWED_WINDOW_MS, PartRow, QueueRow, RelayDone, RelayWrite, done_mark,
};
use crate::sys::latency::Latency;
use crate::sys::now_ms;

/// Delivered text over this size goes to a private file (DISC-IN req. 45).
const SPILL_BYTES: usize = 64 * 1024;
/// The owed reply keeps this much of the request (DISC-OUT req. 32).
const OWED_UNITS: usize = 500;
/// Lookups of an answer room that may fail per request before its answer stays in the request's
/// room (DISC-OUT req. 25).
const LOOKUP_TRIES: usize = 3;

/// Where a hand-off stands after a step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Step {
    /// Confirmed in the session file and finished.
    Done,
    /// In the lead's inbox or written; not confirmed yet.
    Waiting,
    /// In doubt, failed or conflicting: the room is held.
    Held(String),
    /// Not handed yet and to be tried again next round; later messages of its room wait behind it.
    Deferred,
}

/// An owner message for the arrival queue, live or found by a catch-up read.
pub(crate) struct Arrival {
    pub(crate) room: String,
    pub(crate) message: String,
    pub(crate) seq: i64,
    pub(crate) parent: Option<String>,
    pub(crate) raw: String,
}

/// A message by room and message ID.
type Key = (String, String);

/// A live message not handed off yet.
enum Live {
    /// Its arrival commit runs and may not queue it: a round that finds the message queued
    /// meanwhile waits for the commit instead of handing it off as not read live.
    Committing(Instant),
    /// Its queue item, which goes to the round while its arrival commits (decision 15).
    Early(Instant, QueueRow),
    /// Queued by its arrival: its hand-off takes the read time.
    Queued(Instant),
}

/// A message whose live arrival still commits: its hand-off waits for the commit.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Committing;

/// Live messages not handed off yet, with the time each frame or poll response was read, for the
/// wake latency. No entry outlives its message: its hand-off takes it, an arrival that did not
/// queue the message or was cancelled before its commit told drops it, and a round drops a queued
/// one whose queue item left without a hand-off.
#[derive(Default)]
struct LiveMessages(HashMap<Key, Live>);

impl LiveMessages {
    /// A live read starts its arrival. `false` when the message has an entry already (an earlier
    /// read of it), which stays as it is.
    fn begin(&mut self, key: Key, at: Instant) -> bool {
        match self.0.entry(key) {
            Entry::Occupied(_) => false,
            Entry::Vacant(v) => {
                v.insert(Live::Committing(at));
                true
            }
        }
    }

    /// Decision 15: the arrival's queue item goes to the round before its commit.
    fn early(&mut self, key: &Key, row: QueueRow) {
        if let Some(live) = self.0.get_mut(key)
            && let Live::Committing(at) = *live
        {
            *live = Live::Early(at, row);
        }
    }

    /// The arrival committed: queued by it, the hand-off takes the read time; otherwise (or when
    /// the store failed) the entry goes. A round that took its early item already left none.
    fn settle(&mut self, key: &Key, queued: bool) {
        let at = match self.0.get(key) {
            Some(Live::Committing(at) | Live::Early(at, _)) if queued => *at,
            Some(Live::Committing(_) | Live::Early(..)) => {
                self.0.remove(key);
                return;
            }
            Some(Live::Queued(_)) | None => return,
        };
        self.0.insert(key.clone(), Live::Queued(at));
    }

    /// The arrival was cancelled before its commit told: its entry goes, unless the round still
    /// takes its early item.
    fn abandon(&mut self, key: &Key) {
        if matches!(self.0.get(key), Some(Live::Committing(_))) {
            self.0.remove(key);
        }
    }

    /// The hand-off takes the read time: `None` when the message was not read live in this run.
    fn take(&mut self, key: &Key) -> Result<Option<Instant>, Committing> {
        match self.0.get(key) {
            None => Ok(None),
            Some(Live::Committing(_)) => Err(Committing),
            Some(Live::Early(..) | Live::Queued(_)) => {
                Ok(self.0.remove(key).map(|live| match live {
                    Live::Committing(at) | Live::Early(at, _) | Live::Queued(at) => at,
                }))
            }
        }
    }

    /// The messages queued by their arrival now: each is in a queue read after this, unless it
    /// left the queue since.
    fn queued(&self) -> Vec<Key> {
        self.0
            .iter()
            .filter(|(_, live)| matches!(live, Live::Queued(_)))
            .map(|(key, _)| key.clone())
            .collect()
    }

    /// Drops the entries of `queued` (taken before `queue` was read) whose message is not in
    /// `queue`: it left without a hand-off (dropped out of scope, a reset).
    fn prune(&mut self, queued: &[Key], queue: &[QueueRow]) {
        for key in queued {
            if !queue.iter().any(|q| q.room == key.0 && q.message == key.1) {
                self.0.remove(key);
            }
        }
    }

    /// The early queue items not in `queue` yet (decision 15).
    fn early_rows(&self, queue: &[QueueRow]) -> Vec<QueueRow> {
        self.0
            .values()
            .filter_map(|live| match live {
                Live::Early(_, row) => Some(row),
                Live::Committing(_) | Live::Queued(_) => None,
            })
            .filter(|row| {
                !queue
                    .iter()
                    .any(|q| q.room == row.room && q.message == row.message)
            })
            .cloned()
            .collect()
    }
}

/// Drops a live read's entry when its arrival is cancelled before its commit told.
struct Arriving<'a> {
    live: &'a Mutex<LiveMessages>,
    key: Option<Key>,
}

impl Drop for Arriving<'_> {
    fn drop(&mut self) {
        if let Some(key) = self.key.take() {
            self.live
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .abandon(&key);
        }
    }
}

/// Where one answer goes (DISC-OUT req. 25).
#[derive(Debug, Clone, Default)]
struct Target {
    /// The room bound to the request that takes the whole answer ([`Relay::answer_room`]); `None`
    /// for the linked reply in the request's room.
    room: Option<String>,
    /// The rest moved to the request's room from this room after a part was out there: the next
    /// part posted in the request's room is the reply to the request, after a note pointing back
    /// here ([`Relay::moved_note`]).
    moved_from: Option<String>,
    /// The note for `moved_from` was tried (once per delivery, whatever came of it).
    noted: bool,
}

/// The answer room of one request, shared by typing and posting: a found room (or none) is kept,
/// a failed one is tried again, [`LOOKUP_TRIES`] lookups in all.
type Lookup = Arc<tokio::sync::Mutex<LookupState>>;

#[derive(Debug, Default)]
struct LookupState {
    /// A lookup answered (or the lookups ran out): `room` is kept for the request.
    settled: bool,
    /// The answer room found; `None` keeps the answer in the request's room.
    room: Option<String>,
    /// Lookups that failed so far.
    failed: usize,
}

/// Following the later turns of the newest answered request (DISC-OUT req. 21): the transcript is
/// read again only when it or the request changed.
#[derive(Debug, Default)]
struct LaterTurns {
    /// The request, session file, its length and whether the session was idle at the last read.
    read: Option<(String, PathBuf, u64, bool)>,
    /// The request whose turns ended (an input followed), so it is not read for them again.
    ended: Option<String>,
    /// The later turn last refused by the outgoing checks, logged once.
    refused: Option<(String, usize)>,
}

/// The pipeline of one relay.
pub(crate) struct Pipeline<R: Relay, T: Runtime> {
    pub(crate) relay: Arc<R>,
    store: Store,
    lead: Arc<Lead<T>>,
    /// The owning lane of a thread takes its owner messages (DISC-IN-14).
    lanes: Arc<crate::lanes::Lanes<T>>,
    spill_dir: PathBuf,
    events: Events,
    /// `[context]` is read from here at each hand-off.
    config: watch::Receiver<Arc<Config>>,
    context: Context,
    /// Sources whose stuck delivery was logged (once per request, DISC-OUT req. 27).
    stuck: Mutex<HashSet<String>>,
    /// Where each answer being posted goes, by source, decided before its first part.
    targets: Mutex<HashMap<String, Target>>,
    /// The answer room looked up per open request, by source.
    lookups: Mutex<HashMap<String, Lookup>>,
    /// The newest answered request's later turns.
    later: Mutex<LaterTurns>,
    /// Request positions retained only while their answer or later turns are being read.
    reply_offsets: Arc<Mutex<transcript::ReplyOffsets>>,
    /// A failed seen mark is logged once per run (MSG-04).
    seen_failed: AtomicBool,
    /// A failed done mark is logged once per run (MSG-04).
    done_failed: AtomicBool,
    /// Requests whose done mark is being added, so it is added once.
    marking: Mutex<HashSet<Key>>,
    /// The done marks owed from before this run were looked for.
    swept: AtomicBool,
    /// Live messages not handed off yet.
    live: Mutex<LiveMessages>,
    /// Frame read time of a wake still waiting for its turn to start.
    wake: Mutex<Option<Instant>>,
    /// Relay frame read to OMP `agent_start` (DESIGN 2.3, wake end to end).
    pub(crate) wake_latency: Latency,
}

/// What a relay's pipeline needs from the hub besides the relay itself.
pub(crate) struct Parts<T: Runtime> {
    pub(crate) store: Store,
    pub(crate) lead: Arc<Lead<T>>,
    pub(crate) lanes: Arc<crate::lanes::Lanes<T>>,
    pub(crate) spill_dir: PathBuf,
    pub(crate) events: Events,
    pub(crate) config: watch::Receiver<Arc<Config>>,
}

impl<R: Relay, T: Runtime> Pipeline<R, T> {
    pub(crate) fn new(relay: Arc<R>, parts: Parts<T>, wake_latency: Latency) -> Self {
        Self {
            relay,
            store: parts.store,
            lead: parts.lead,
            lanes: parts.lanes,
            spill_dir: parts.spill_dir,
            events: parts.events,
            config: parts.config,
            context: Context::default(),
            stuck: Mutex::default(),
            targets: Mutex::default(),
            lookups: Mutex::default(),
            later: Mutex::default(),
            reply_offsets: Arc::default(),
            seen_failed: AtomicBool::new(false),
            done_failed: AtomicBool::new(false),
            marking: Mutex::default(),
            swept: AtomicBool::new(false),
            live: Mutex::default(),
            wake: Mutex::new(None),
            wake_latency,
        }
    }

    fn live(&self) -> MutexGuard<'_, LiveMessages> {
        self.live.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Queues an owner message durably (DISC-IN req. 22, MSG req. 4): its position moves only after
    /// the hand-off. `read_at` is when a live message's frame or poll response was read, `None`
    /// for one found by a catch-up read; `wake` starts the handling round. A live read is known
    /// before its commit, so a round that finds the message queued first waits for the commit
    /// and its hand-off still takes the read time.
    ///
    /// Decision 15: on a relay whose live messages never come back live after a restart
    /// ([`Relay::LIVE_ONCE`]), a live message the store would queue now goes to the round at once
    /// and its arrival commits alongside the hand-off. The arrival is queued in the writer before
    /// the round can see the message, so the hand-off record and the lead's records commit with or
    /// after it, never before. A crash before it commits leaves the room's position below the
    /// message: the catch-up read finds it again, and the lead's transcript decides before any send.
    pub(crate) async fn arrive(
        &self,
        arrival: Arrival,
        read_at: Option<Instant>,
        wake: &Notify,
    ) -> Result<Arrived, String> {
        let Arrival {
            room,
            message,
            seq,
            parent,
            raw,
        } = arrival;
        let key = (room.clone(), message.clone());
        let mut arriving = Arriving {
            live: &self.live,
            key: read_at
                .filter(|at| self.live().begin(key.clone(), *at))
                .map(|_| key.clone()),
        };
        let early = match arriving.key {
            Some(_) if R::LIVE_ONCE && !Self::commit_first() => {
                let (r, m, bytes) = (room.clone(), message.clone(), raw.len());
                self.store
                    .read(move |reads| reads.arrives_at_once(R::NAME, &r, &m, seq, bytes))
                    .await
                    .ok()
                    .flatten()
            }
            _ => None,
        };
        let row = early.map(|position_at| QueueRow {
            room: room.clone(),
            message: message.clone(),
            seq,
            parent: parent.clone(),
            position_at,
            raw: raw.clone(),
            created_ms: now_ms(),
        });
        let write = RelayWrite::Arrive {
            relay: R::NAME.into(),
            room,
            message,
            seq,
            parent,
            raw,
        };
        let done = match row {
            Some(row) => {
                // Debug builds only: the crash test of a hand-off written before its arrival
                // commits holds the arrival back.
                #[cfg(debug_assertions)]
                if crate::sys::fault::named("arrival_after_write") {
                    self.live().early(&key, row);
                    wake.notify_one();
                    return std::future::pending().await;
                }
                let committed = self
                    .store
                    .relay_queued(write)
                    .await
                    .map_err(|e| e.to_string())?;
                self.live().early(&key, row);
                wake.notify_one();
                committed.await
            }
            None => self.store.relay(write).await,
        };
        let arrived = done.map(|d| match d {
            RelayDone::Arrived(a) => a,
            _ => Arrived::Handled,
        });
        // Debug builds only: the crash test of acceptance check 4 stops here, after the arrival
        // commit and before the hand-off.
        #[cfg(debug_assertions)]
        if matches!(arrived, Ok(Arrived::Queued)) {
            crate::sys::fault::point("relay_after_arrival");
        }
        if let Some(key) = arriving.key.take() {
            self.live()
                .settle(&key, matches!(arrived, Ok(Arrived::Queued)));
            // Also for a round that found the message queued and waits for this commit.
            wake.notify_one();
        }
        arrived.map_err(|e| e.to_string())
    }

    /// Debug builds only: the crash test that stops after the arrival commit and before the
    /// hand-off needs that order.
    #[cfg(debug_assertions)]
    fn commit_first() -> bool {
        crate::sys::fault::named("relay_after_arrival")
    }

    #[cfg(not(debug_assertions))]
    const fn commit_first() -> bool {
        false
    }

    /// The read time of a live message, taken by its hand-off: `None` for anything else, and
    /// [`Committing`] while its arrival commit runs (the hand-off waits for the next round).
    pub(crate) fn read_at(&self, room: &str, message: &str) -> Result<Option<Instant>, Committing> {
        self.live().take(&(room.to_string(), message.to_string()))
    }

    /// Hands queued messages on, lowest first per room; a room with a held or failed message is
    /// skipped for the rest of the round (DISC-IN req. 26-27, 43). `handle` takes one queue row.
    /// Live messages whose arrival still commits take their place in the queue (decision 15), and a
    /// queued live message no longer in the queue is forgotten.
    pub(crate) async fn drain<F, Fut>(&self, mut handle: F) -> Result<(), String>
    where
        F: FnMut(QueueRow) -> Fut,
        Fut: Future<Output = Result<Step, String>>,
    {
        let queued = self.live().queued();
        let (mut queue, positions) = self
            .store
            .read(|r| Ok((r.queue(R::NAME)?, r.positions(R::NAME)?)))
            .await
            .map_err(|e| e.to_string())?;
        let committing = {
            let mut live = self.live();
            live.prune(&queued, &queue);
            live.early_rows(&queue)
        };
        if !committing.is_empty() {
            queue.extend(committing);
            queue.sort_by_key(|r| r.seq);
        }
        let mut blocked: HashSet<String> = positions
            .into_iter()
            .filter(|p| p.held.is_some())
            .map(|p| p.room)
            .collect();
        for row in queue {
            if blocked.contains(&row.room) {
                continue;
            }
            let room = row.room.clone();
            match handle(row).await {
                Ok(Step::Done | Step::Waiting) => {}
                Ok(Step::Held(_) | Step::Deferred) => {
                    blocked.insert(room);
                }
                Err(e) => {
                    log::warn(
                        "hand-off not made",
                        &[("relay", &R::NAME), ("room", &room), ("error", &e)],
                    );
                    blocked.insert(room);
                }
            }
        }
        Ok(())
    }

    /// A queued message whose hand-off exists: its receipt is read again, it is finished, or it is
    /// handed off again. `None` when it has no hand-off yet.
    pub(crate) async fn resume(
        self: &Arc<Self>,
        row: &QueueRow,
        inbound: &Inbound,
        read_at: Option<Instant>,
    ) -> Result<Option<Step>, String> {
        let found = {
            let (room, message) = (row.room.clone(), row.message.clone());
            self.store
                .read(move |r| r.handoff(R::NAME, &room, &message))
                .await
                .map_err(|e| e.to_string())?
        };
        Ok(Some(match found {
            Some(h) if h.state == "handed" => self.recheck(row, &h, inbound).await?,
            Some(h) if h.state == "delivered" => {
                self.finish(&row.room, &row.message, Some("delivered"))
                    .await?;
                Step::Done
            }
            Some(h) => self.hand_off(row, inbound, read_at, Some(&h)).await?,
            None => return Ok(None),
        }))
    }

    /// The tag that names a request in the envelope and the session file.
    pub(crate) fn tag(room: &str, message: &str) -> String {
        format!("[{} {room}/{message}]", R::NAME)
    }

    fn prefix() -> String {
        format!("[{} ", R::NAME)
    }

    fn request_id(room: &str, message: &str) -> String {
        format!("{}:{room}:{message}", R::NAME)
    }

    /// The envelope with the optional context lines (DISC-IN req. 53-58).
    async fn text_for(&self, inbound: &Inbound) -> String {
        let settings = self.config.borrow().context.clone();
        let mut text = Self::envelope(inbound);
        let mut extra = Vec::new();
        if settings.facts {
            extra.push(
                self.context
                    .facts_line(&*self.relay, &settings, inbound)
                    .await,
            );
        }
        if settings.lookup && context::refers_back(&inbound.text) {
            let (space, since) = (
                context::space(inbound).to_string(),
                now_ms() - settings.lookup_days * 86_400_000,
            );
            let rows = self
                .store
                .read(move |r| r.recall(R::NAME, &space, since, context::RANKED_ROWS))
                .await;
            match rows {
                Ok(rows) => {
                    let picked = context::rank(&inbound.text, &inbound.message, &rows);
                    if let Some(line) = context::recall_line(&picked, &inbound.text) {
                        extra.push(line);
                    }
                }
                Err(e) => extra.push(format!("[earlier] error {e}")),
            }
        }
        for line in extra {
            text.push('\n');
            text.push_str(&line);
        }
        text
    }

    /// Stores one owner message or lead reply for the earlier-conversation lookup when it is on
    /// (DISC-IN req. 55-56); the space is the room's listed parent, else the room.
    async fn remember(&self, room: &str, message: &str, who: &str, text: &str) {
        let settings = self.config.borrow().context.clone();
        if !settings.lookup {
            return;
        }
        let space = {
            let room = room.to_string();
            self.store
                .read(move |r| r.positions(R::NAME))
                .await
                .ok()
                .and_then(|p| p.into_iter().find(|p| p.room == room)?.parent)
                .unwrap_or_else(|| room.clone())
        };
        let write = RelayWrite::Recall {
            relay: R::NAME.into(),
            space,
            who: who.into(),
            conversation: room.into(),
            message: message.into(),
            text: context::stored(text),
            keep_ms: settings.lookup_days * 86_400_000,
        };
        if let Err(e) = self.store.relay(write).await {
            log::warn("earlier conversation not stored", &[("error", &e)]);
        }
    }

    /// The text the lead receives (DISC-IN req. 35-38): the tag and the owner's authenticated
    /// origin, data lines the owner did not write, attachments, then the owner's own words quoted.
    pub(crate) fn envelope(inbound: &Inbound) -> String {
        let mut text = format!(
            "{} request from the owner (authenticated), room {}",
            Self::tag(&inbound.room, &inbound.message),
            inbound.room
        );
        if let Some(parent) = &inbound.parent {
            let _ = write!(text, " (a thread of {parent})");
        }
        for line in &inbound.data {
            text.push_str("\n[data] ");
            text.push_str(line);
        }
        for line in &inbound.attachments {
            text.push_str("\n[file] ");
            text.push_str(line);
        }
        text.push_str("\nThe owner wrote:\n");
        text.push_str(&super::discord::types::quote(&inbound.text));
        text
    }

    /// Writes an oversized text to a private file and says where it is.
    fn spill(&self, inbound: &Inbound, text: String) -> String {
        if text.len() <= SPILL_BYTES {
            return text;
        }
        let path = self.spill_dir.join(format!(
            "{}-{}-{}.txt",
            R::NAME,
            inbound.room,
            inbound.message
        ));
        let written = crate::sys::fs::ensure_private_dir(&self.spill_dir)
            .and_then(|()| crate::sys::fs::write_atomic(&path, text.as_bytes()));
        match written {
            Ok(()) => format!(
                "{} request from the owner (authenticated), room {}\nThe message is {} bytes; read it \
                 from {}",
                Self::tag(&inbound.room, &inbound.message),
                inbound.room,
                text.len(),
                path.display()
            ),
            Err(e) => {
                log::warn("oversized message not saved", &[("error", &e)]);
                let mut cut = text;
                let mut end = SPILL_BYTES;
                while !cut.is_char_boundary(end) {
                    end -= 1;
                }
                cut.truncate(end);
                cut.push_str("\n[cut: the message was too long and could not be saved]");
                cut
            }
        }
    }

    /// Adds the seen mark in the background and records it (MSG-04, DISC-OUT req. 30).
    pub(crate) fn mark_seen(self: &Arc<Self>, room: &str, message: &str) {
        let me = Arc::clone(self);
        let (room, message) = (room.to_string(), message.to_string());
        tokio::spawn(async move {
            let marked = me
                .store
                .read({
                    let (room, message) = (room.clone(), message.clone());
                    move |r| r.read_marked(R::NAME, &room, &message)
                })
                .await
                .unwrap_or(false);
            if marked {
                return;
            }
            match me.relay.seen(&room, &message).await {
                Ok(()) => {
                    let write = RelayWrite::ReadMark {
                        relay: R::NAME.into(),
                        room,
                        message,
                    };
                    if let Err(e) = me.store.relay(write).await {
                        log::warn("read mark not recorded", &[("error", &e)]);
                    }
                }
                Err(e) => {
                    if !me.seen_failed.swap(true, Ordering::AcqRel) {
                        log::warn("seen mark failed", &[("relay", &R::NAME), ("error", &e)]);
                    }
                }
            }
        });
    }

    fn marking(&self) -> MutexGuard<'_, HashSet<Key>> {
        self.marking.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Replaces the seen mark with the done mark in the background once the answer to a request
    /// was posted, and records it (MSG-04, DISC-OUT req. 30): after the answer, never holding it
    /// up, and once per request, also across a restart, which repeats both steps when a stop came
    /// before the record. A failure is logged once per run and recorded all the same, so it is
    /// never tried again.
    fn mark_done(self: &Arc<Self>, room: &str, message: &str) {
        let key = (room.to_string(), message.to_string());
        if !self.marking().insert(key.clone()) {
            return;
        }
        let me = Arc::clone(self);
        tokio::spawn(async move {
            let (room, message) = &key;
            let mark = done_mark(message);
            let marked = {
                let (room, mark) = (room.clone(), mark.clone());
                me.store
                    .read(move |r| r.read_marked(R::NAME, &room, &mark))
                    .await
                    .unwrap_or(false)
            };
            if !marked {
                // Debug builds only: the crash test of a restart between the answer and its mark.
                #[cfg(debug_assertions)]
                crate::sys::fault::point("answer_before_done");
                if let Err(e) = me.relay.done(room, message).await
                    && !me.done_failed.swap(true, Ordering::AcqRel)
                {
                    log::warn("done mark failed", &[("relay", &R::NAME), ("error", &e)]);
                }
                let write = RelayWrite::ReadMark {
                    relay: R::NAME.into(),
                    room: room.clone(),
                    message: mark,
                };
                if let Err(e) = me.store.relay(write).await {
                    log::warn("done mark not recorded", &[("error", &e)]);
                }
            }
            me.marking().remove(&key);
        });
    }

    /// A queued message taken by another route (an answer to a question): finished, marked seen.
    pub(crate) async fn taken(self: &Arc<Self>, row: &QueueRow) -> Result<(), String> {
        self.mark_seen(&row.room, &row.message);
        self.finish(&row.room, &row.message, None).await
    }

    /// Removes a queue item and moves the position; `state` sets the hand-off's.
    pub(crate) async fn finish(
        &self,
        room: &str,
        message: &str,
        state: Option<&str>,
    ) -> Result<(), String> {
        self.store
            .relay(RelayWrite::Finish {
                relay: R::NAME.into(),
                room: room.into(),
                message: message.into(),
                state: state.map(str::to_string),
            })
            .await
            .map(drop)
            .map_err(|e| e.to_string())
    }

    /// Hands a queued owner message to the lead (DISC-IN req. 46-47). `read_at` is its frame's read
    /// time when it came live, for the wake latency; `found` is its hand-off record as the caller
    /// just read it (`None`: it has none).
    pub(crate) async fn hand_off(
        self: &Arc<Self>,
        row: &QueueRow,
        inbound: &Inbound,
        read_at: Option<Instant>,
        found: Option<&HandoffRow>,
    ) -> Result<Step, String> {
        let digest = inbox::digest("relay", &inbound.stable);
        if let Some(h) = found {
            if h.digest != digest {
                // The same message with other content: never resent silently (DISC-IN req. 51).
                return self
                    .hold(
                        &row.room,
                        &row.message,
                        "failed",
                        "the message changed since its hand-off",
                    )
                    .await;
            }
            if matches!(h.state.as_str(), "in_doubt" | "failed") {
                return Ok(Step::Held("an earlier hand-off is in doubt".into()));
            }
        }
        let text = self.spill(inbound, self.text_for(inbound).await);
        self.remember(&inbound.room, &inbound.message, "owner", &inbound.text)
            .await;
        let request_id = Self::request_id(&row.room, &row.message);
        let owed: String = {
            let mut units = 0;
            inbound
                .text
                .chars()
                .take_while(|c| {
                    units += c.len_utf16();
                    units <= OWED_UNITS
                })
                .collect()
        };
        // A thread one open lane names goes to that lane; two claimants hold the room (DISC-IN
        // req. 41-42). Lanes never answer the owner, so no reply is owed for it (OPC-57). A reply
        // to the lead's own question goes to the lead even there (EVR req. 37).
        let to_lead = match inbound.reply_to.clone() {
            Some(target) => {
                let (room, reply) = (row.room.clone(), row.message.clone());
                let read = self
                    .store
                    .read(move |r| r.question_reply(&room, &target, &reply))
                    .await;
                match read {
                    Ok(bound) => bound,
                    Err(e) => {
                        let why = format!("the question ledger could not be read: {e}");
                        return self.hold(&row.room, &row.message, "failed", &why).await;
                    }
                }
            }
            None => false,
        };
        let route = if to_lead {
            None
        } else {
            self.lanes.route(R::NAME, &row.room).await
        };
        if let Some(Err(why)) = &route {
            return self.hold(&row.room, &row.message, "failed", why).await;
        }
        let lane = route.and_then(Result::ok);
        let handed = RelayWrite::Handed {
            relay: R::NAME.into(),
            room: row.room.clone(),
            message: row.message.clone(),
            seq: row.seq,
            target: lane.clone().unwrap_or_else(|| inbox::LEAD.into()),
            request_id: request_id.clone(),
            digest,
            owed: lane.is_none().then_some(owed),
        };
        if let Some(key) = lane {
            self.store.relay(handed).await.map_err(|e| e.to_string())?;
            self.mark_seen(&row.room, &row.message);
            let message = Message {
                sender: "owner".into(),
                text,
                urgent: true,
                owner: true,
                identity: None,
                request_id: Some(request_id),
            };
            return match self.lanes.hand_off(&key, message).await {
                Ok(r) => {
                    self.apply(&row.room, &row.message, r.state, r.reason.as_deref())
                        .await
                }
                Err(refused) => self.hold(&row.room, &row.message, "failed", &refused).await,
            };
        }
        self.lead_hand_off(row, handed, text, request_id, read_at)
            .await
    }

    /// The lead's part of a hand-off. Decision 15: the lead's wake can be written before any record
    /// of it lands, so a message not read live in this run (a restart, a catch-up, a hand-off made
    /// again) may already be in the lead's transcript, and the transcript decides before any send.
    /// Otherwise the hand-off record commits alongside the wake instead of before it.
    async fn lead_hand_off(
        self: &Arc<Self>,
        row: &QueueRow,
        handed: RelayWrite,
        text: String,
        request_id: String,
        read_at: Option<Instant>,
    ) -> Result<Step, String> {
        if read_at.is_none() {
            match self.lead.written_earlier(&request_id).await {
                Err(e) => {
                    let why = format!("the lead's transcript could not be searched ({e})");
                    return self.hold(&row.room, &row.message, "in_doubt", &why).await;
                }
                Ok(None) => return Ok(Step::Deferred),
                Ok(Some(true)) => {
                    self.store.relay(handed).await.map_err(|e| e.to_string())?;
                    self.mark_seen(&row.room, &row.message);
                    self.finish(&row.room, &row.message, Some("delivered"))
                        .await?;
                    return Ok(Step::Done);
                }
                Ok(Some(false)) => {}
            }
        }
        self.mark_seen(&row.room, &row.message);
        let (recorded, step) = tokio::join!(
            self.store.relay(handed),
            self.to_lead(row, text, request_id, read_at)
        );
        recorded.map_err(|e| e.to_string())?;
        step
    }

    /// Delivers a handed-off owner message to the lead and records its receipt. The lead may write
    /// it before its records commit: it was read live in this run, or the transcript showed it was
    /// not written earlier (decision 15).
    async fn to_lead(
        self: &Arc<Self>,
        row: &QueueRow,
        text: String,
        request_id: String,
        read_at: Option<Instant>,
    ) -> Result<Step, String> {
        let idle = self
            .lead
            .snapshot()
            .is_some_and(|s| s.status == Status::Idle);
        let receipt = self
            .lead
            .deliver_live(Message {
                sender: "owner".into(),
                text,
                urgent: true,
                owner: true,
                identity: None,
                request_id: Some(request_id),
            })
            .await;
        let receipt = match receipt {
            Ok(r) => r,
            Err(refused) => {
                return self.hold(&row.room, &row.message, "failed", &refused).await;
            }
        };
        if idle
            && let Some(at) = read_at
            && matches!(receipt.state, ReceiptState::Sent | ReceiptState::Delivered)
        {
            let mut wake = self.wake.lock().unwrap_or_else(PoisonError::into_inner);
            *wake = Some(at);
            // The turn may have started while the delivery's records committed, its event seen
            // before this wake was set.
            self.settle_wake(&mut wake);
        }
        self.apply(
            &row.room,
            &row.message,
            receipt.state,
            receipt.reason.as_deref(),
        )
        .await
    }

    /// Reads a hand-off's receipt again; a hand-off the inbox never got is made again.
    pub(crate) async fn recheck(
        self: &Arc<Self>,
        row: &QueueRow,
        h: &HandoffRow,
        inbound: &Inbound,
    ) -> Result<Step, String> {
        let receipt = if h.target == inbox::LEAD {
            self.lead.receipt(&h.request_id).await?
        } else {
            self.lanes.receipt(&h.target, &h.request_id).await
        };
        match receipt {
            Some(r) => {
                self.apply(&row.room, &row.message, r.state, r.reason.as_deref())
                    .await
            }
            None => self.hand_off(row, inbound, None, Some(h)).await,
        }
    }

    async fn apply(
        &self,
        room: &str,
        message: &str,
        state: ReceiptState,
        reason: Option<&str>,
    ) -> Result<Step, String> {
        match state {
            ReceiptState::Delivered | ReceiptState::Duplicate => {
                self.finish(room, message, Some("delivered")).await?;
                Ok(Step::Done)
            }
            ReceiptState::Waiting | ReceiptState::Sent => Ok(Step::Waiting),
            ReceiptState::InDoubt => {
                self.hold(
                    room,
                    message,
                    "in_doubt",
                    reason.unwrap_or("the lead may or may not have it"),
                )
                .await
            }
            ReceiptState::Failed => {
                self.hold(
                    room,
                    message,
                    "failed",
                    reason.unwrap_or("the hand-off failed"),
                )
                .await
            }
        }
    }

    /// Holds the room and tells the owner once, in the room and as an urgent event (DESIGN 9.3).
    async fn hold(
        &self,
        room: &str,
        message: &str,
        state: &str,
        reason: &str,
    ) -> Result<Step, String> {
        let why = format!("message {message}: {reason}");
        self.store
            .relay(RelayWrite::Doubt {
                relay: R::NAME.into(),
                room: room.into(),
                message: message.into(),
                state: state.into(),
                reason: why.clone(),
            })
            .await
            .map_err(|e| e.to_string())?;
        log::warn(
            "relay room held",
            &[("relay", &R::NAME), ("room", &room), ("reason", &why)],
        );
        (self.events)(
            Emit::new(EventKind::RelayHeld, Severity::Warning, true, R::NAME)
                .with("relay", R::NAME)
                .with("room", room)
                .with("reason", &why),
        );
        let note = format!(
            "This message may not have reached the lead ({reason}). Nothing more from this room goes \
             to the lead until you release it with `cataly {} release {room}`.",
            R::NAME
        );
        let nonce = self.relay.nonce(room, message, 9_999);
        if let PartOutcome::Rejected(e) | PartOutcome::Closed(e) | PartOutcome::Uncertain(e) =
            self.relay.post(room, Some(message), &note, &nonce).await
        {
            log::warn("hold notice not posted", &[("error", &e)]);
        }
        Ok(Step::Held(why))
    }

    /// Follows the lead's events: a turn start after a wake records the wake latency, up to when
    /// the lead read OMP's `agent_start` (this round may follow its events later). A turn start
    /// from before the wake leaves it waiting for the next one.
    pub(crate) fn on_event(&self, event: &SessionEvent) {
        if *event != SessionEvent::TurnStarted {
            return;
        }
        let mut wake = self.wake.lock().unwrap_or_else(PoisonError::into_inner);
        self.settle_wake(&mut wake);
    }

    /// Records the wake latency once the lead's turn started at or after the wake.
    fn settle_wake(&self, wake: &mut Option<Instant>) {
        let Some(at) = *wake else {
            return;
        };
        if let Some(started) = self.lead.turn_started().filter(|s| *s >= at) {
            *wake = None;
            self.wake_latency.record(started - at);
        }
    }

    /// The room and message of the newest request whose answer is still being written, for typing.
    pub(crate) async fn typing_room(&self) -> Option<(String, String)> {
        let open = self.store.read(|r| r.answers_open(R::NAME)).await.ok()?;
        open.into_iter()
            .rev()
            .find(|h| h.answer == "waiting")
            .map(|h| (h.room, h.message))
    }

    /// Reads finished answers from the lead's session file and posts them (DISC-OUT req. 21-28),
    /// and after each answer the final text of every later turn OMP started by itself.
    /// `turn_over` is true when the lead's last turn ended and nothing started since, which the
    /// idle readback may not show yet. The first call of a run adds the done marks that a stop
    /// left owed on answers posted within the owed window.
    pub(crate) async fn answers(self: &Arc<Self>, turn_over: bool) -> Result<(), String> {
        if !self.swept.load(Ordering::Acquire) {
            let since = now_ms() - OWED_WINDOW_MS;
            let owed = self
                .store
                .read(move |r| r.done_owed(R::NAME, since))
                .await
                .map_err(|e| e.to_string())?;
            for h in owed {
                self.mark_done(&h.room, &h.message);
            }
            self.swept.store(true, Ordering::Release);
        }
        let open = self
            .store
            .read(|r| r.answers_open(R::NAME))
            .await
            .map_err(|e| e.to_string())?;
        // Lookups are kept while their request's answer is open.
        self.lookups
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|m, _| open.iter().any(|h| h.message == *m));
        let newest = self
            .store
            .read(|r| r.answer_newest(R::NAME, inbox::LEAD))
            .await
            .map_err(|e| e.to_string())?
            .filter(|h| self.later().ended.as_deref() != Some(h.message.as_str()));
        if open.is_empty() && newest.is_none() {
            *self
                .reply_offsets
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = transcript::ReplyOffsets::default();
            return Ok(());
        }
        let waiting: Vec<&HandoffRow> = open
            .iter()
            // A hand-off not yet confirmed by its receipt counts once its tag is in a user entry of
            // the session file: that entry is the confirmation itself.
            .filter(|h| h.answer == "waiting" && matches!(h.state.as_str(), "delivered" | "handed"))
            .collect();
        if let Some(snap) = self.lead.snapshot()
            && let Some(file) = snap.session_file.clone()
        {
            let settled = turn_over || snap.status == Status::Idle;
            let file = PathBuf::from(file);
            // The newest answered request's later turns: read again only when something changed.
            let length = std::fs::metadata(&file).map(|m| m.len()).ok();
            let later = newest.filter(|h| {
                let seen = &self.later().read;
                !matches!((seen, length), (Some((m, f, l, s)), Some(length))
                    if *m == h.message && *f == file && *l == length && *s == settled)
            });
            if !waiting.is_empty() || later.is_some() {
                let tags = waiting
                    .iter()
                    .copied()
                    .chain(later.as_ref())
                    .map(|h| Self::tag(&h.room, &h.message))
                    .collect();
                let mut replies = transcript::read_replies(
                    file.clone(),
                    tags,
                    Self::prefix(),
                    settled,
                    Arc::clone(&self.reply_offsets),
                )
                .await
                .map_err(|e| e.to_string())?;
                let later_reply = later.as_ref().and_then(|_| replies.pop());
                for (h, reply) in waiting.iter().zip(replies) {
                    self.settle_reply(h, reply).await?;
                }
                if let (Some(h), Some(reply)) = (later, later_reply) {
                    self.later_turns(&h, reply).await?;
                    if let Some(length) = length {
                        self.later().read = Some((h.message, file, length, settled));
                    }
                }
            }
        }
        // One delivery at a time, in request order (DISC-OUT req. 28).
        let posting = self
            .store
            .read(|r| r.answers_open(R::NAME))
            .await
            .map_err(|e| e.to_string())?;
        let still: HashSet<&str> = posting
            .iter()
            .filter(|h| h.answer == "posting")
            .map(|h| h.message.as_str())
            .collect();
        keep_only(&self.stuck, &still);
        self.targets
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|m, _| still.contains(m.as_str()));
        for h in posting.iter().filter(|h| h.answer == "posting") {
            if !self.post_parts(h).await? {
                break;
            }
        }
        Ok(())
    }

    async fn settle_reply(&self, h: &HandoffRow, reply: Reply) -> Result<(), String> {
        let answer = |answer: &str| RelayWrite::Answer {
            relay: R::NAME.into(),
            room: h.room.clone(),
            message: h.message.clone(),
            answer: answer.into(),
        };
        match reply {
            Reply::Answer { text, more, .. } => match self.relay.parts(&text) {
                Ok(parts) => {
                    self.remember(&h.room, &format!("{}:answer", h.message), "lead", &text)
                        .await;
                    let parts = parts
                        .into_iter()
                        .enumerate()
                        .map(|(i, p)| (self.relay.nonce(&h.room, &h.message, i), p))
                        .collect();
                    self.store
                        .relay(RelayWrite::Outbox {
                            relay: R::NAME.into(),
                            room: h.room.clone(),
                            source: h.message.clone(),
                            parts,
                        })
                        .await
                        .map_err(|e| e.to_string())?;
                    self.store_later(h, &more).await?;
                }
                Err(why) => {
                    log::warn(
                        "answer not posted",
                        &[("message", &h.message), ("reason", &why)],
                    );
                    self.store
                        .relay(answer("abandoned"))
                        .await
                        .map_err(|e| e.to_string())?;
                }
            },
            Reply::Abandoned => {
                self.store
                    .relay(answer("abandoned"))
                    .await
                    .map_err(|e| e.to_string())?;
            }
            Reply::NotFound | Reply::Pending => {
                if now_ms() - h.created_ms > OWED_WINDOW_MS {
                    self.store
                        .relay(answer("abandoned"))
                        .await
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(())
    }

    fn later(&self) -> MutexGuard<'_, LaterTurns> {
        self.later.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Follows the newest answered request: its later turns not stored yet are stored, until an
    /// input ends them or the request leaves the session file.
    async fn later_turns(&self, h: &HandoffRow, reply: Reply) -> Result<(), String> {
        let ended = match reply {
            Reply::Answer { more, open, .. } => {
                self.store_later(h, &more).await?;
                !open
            }
            Reply::NotFound | Reply::Pending | Reply::Abandoned => true,
        };
        if ended {
            self.later().ended = Some(h.message.clone());
        }
        Ok(())
    }

    /// Stores the final text of each later turn of `h` (DISC-OUT req. 21) not stored yet, as its
    /// own parts after those already stored: posted after the answer where it went, never as the
    /// reply, settling nothing. A turn the outgoing checks refuse is skipped.
    async fn store_later(&self, h: &HandoffRow, more: &[String]) -> Result<(), String> {
        if more.is_empty() {
            return Ok(());
        }
        let stored = {
            let (room, source) = (h.room.clone(), h.message.clone());
            self.store
                .read(move |r| r.parts(R::NAME, &room, &source))
                .await
                .map_err(|e| e.to_string())?
        };
        let (Some(last), Some(done)) = (stored.last(), stored.iter().map(|p| p.turn).max()) else {
            return Ok(());
        };
        let mut start = last.idx + 1;
        let done = usize::try_from(done).unwrap_or(usize::MAX);
        for (turn, text) in (1..).zip(more).skip(done) {
            let split = match self.relay.parts(text) {
                Ok(split) => split,
                Err(why) => {
                    let mut later = self.later();
                    if !matches!(&later.refused, Some((m, t)) if *m == h.message && *t == turn) {
                        log::warn(
                            "later turn not posted",
                            &[("message", &h.message), ("turn", &turn), ("reason", &why)],
                        );
                        later.refused = Some((h.message.clone(), turn));
                    }
                    continue;
                }
            };
            self.remember(
                &h.room,
                &format!("{}:answer:{turn}", h.message),
                "lead",
                text,
            )
            .await;
            let parts: Vec<(String, String)> = (start..)
                .zip(split)
                .map(|(idx, p)| {
                    let idx = usize::try_from(idx).unwrap_or(usize::MAX);
                    (self.relay.nonce(&h.room, &h.message, idx), p)
                })
                .collect();
            let count = i64::try_from(parts.len()).unwrap_or(i64::MAX);
            self.store
                .relay(RelayWrite::Continue {
                    relay: R::NAME.into(),
                    room: h.room.clone(),
                    source: h.message.clone(),
                    turn: i64::try_from(turn).unwrap_or(i64::MAX),
                    start,
                    parts,
                })
                .await
                .map_err(|e| e.to_string())?;
            start = start.saturating_add(count);
        }
        Ok(())
    }

    /// Resume from the last attempted or confirmed destination, never a fresh lookup after a post.
    async fn target(&self, h: &HandoffRow, parts: &[PartRow]) -> Result<Target, String> {
        let known = self
            .targets
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&h.message)
            .cloned();
        if let Some(target) = known {
            return Ok(target);
        }
        let saved = parts
            .iter()
            .rev()
            .find_map(|part| part.destination.as_deref());
        let room = match saved {
            Some(room) => (room != h.room).then(|| room.to_string()),
            None => self.answer_room(&h.room, &h.message).await?,
        };
        // A pending part pinned to the channel after a confirmed thread part is the first moved
        // reply. The note was attempted before its destination was committed.
        let moved_from = if room.is_none() {
            parts
                .iter()
                .rev()
                .find(|part| part.state == "confirmed")
                .and_then(|part| part.destination.as_ref())
                .filter(|previous| previous.as_str() != h.room)
                .cloned()
        } else {
            None
        };
        let target = Target {
            room,
            noted: moved_from.is_some(),
            moved_from,
        };
        if let Some(room) = &target.room {
            log::info(
                "the answer goes to the room bound to its request",
                &[("message", &h.message), ("room", room)],
            );
        }
        self.set_target(&h.message, &target);
        Ok(target)
    }

    fn lookup(&self, source: &str) -> Lookup {
        Arc::clone(
            self.lookups
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .entry(source.to_string())
                .or_default(),
        )
    }

    /// The answer room of a new answer to `source` in `room`; typing and posting share it, so they
    /// agree. A found room (or none) is kept for the request. A failed lookup is `Err` and is
    /// tried again on a later call, until [`LOOKUP_TRIES`] lookups failed: then the answer stays
    /// in `room`.
    pub(crate) async fn answer_room(
        &self,
        room: &str,
        source: &str,
    ) -> Result<Option<String>, String> {
        let lookup = self.lookup(source);
        let mut state = lookup.lock().await;
        if !state.settled {
            match self.relay.answer_room(room, source).await {
                Ok(found) => {
                    state.settled = true;
                    state.room = found;
                }
                Err(why) => {
                    state.failed += 1;
                    if state.failed < LOOKUP_TRIES {
                        log::warn(
                            "answer room lookup failed; looking again on a later round",
                            &[("message", &source), ("reason", &why)],
                        );
                        return Err(why);
                    }
                    log::warn(
                        "answer room lookup failed again; the answer is a reply in the request's room",
                        &[
                            ("message", &source),
                            ("tries", &state.failed),
                            ("reason", &why),
                        ],
                    );
                    state.settled = true;
                }
            }
        }
        // Typing, or the answer while lane.open creates the thread, can find the thread before the
        // lane's record claims it. The kickoff stays first there and the lead's pointer stays
        // visible in the channel.
        if let Some(thread) = &state.room
            && self
                .lanes
                .claims_thread(R::NAME, thread, room, source)
                .await
        {
            state.room = None;
        }
        Ok(state.room.clone())
    }

    /// Where the answer to `source` in `room` goes when that was looked up already (the room bound
    /// to it, else `room`); `None` while it is not (or a lookup runs).
    pub(crate) fn known_answer_room(&self, room: &str, source: &str) -> Option<String> {
        let lookup = self.lookup(source);
        let state = lookup.try_lock().ok()?;
        state
            .settled
            .then(|| state.room.clone().unwrap_or_else(|| room.to_string()))
    }

    /// Marks a delivery stuck; true the first time, so it is logged once (DISC-OUT req. 27).
    fn first_stuck(&self, source: &str) -> bool {
        self.stuck
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(source.to_string())
    }

    fn set_target(&self, source: &str, target: &Target) {
        self.targets
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(source.to_string(), target.clone());
    }

    /// Posts one part where the answer goes: in the room bound to the request without a reply, else
    /// in the request's room with the first part (or the first part moved there, after a note
    /// pointing back to where the answer began) as the reply. A later turn's part is never a reply.
    async fn post_part(
        &self,
        h: &HandoffRow,
        part: &PartRow,
        target: &mut Target,
    ) -> Result<PartOutcome, String> {
        if part.uncertain && !R::REPEATABLE {
            return Ok(PartOutcome::Uncertain("earlier attempt is in doubt".into()));
        }
        loop {
            let moved = target.room.is_none() && target.moved_from.is_some();
            if moved && !target.noted {
                self.post_moved_note(h, &h.message, target).await;
            }
            let (room, reply_to) = target.room.as_deref().map_or_else(
                || {
                    let reply = part.turn == 0 && (part.idx == 0 || moved);
                    (h.room.as_str(), reply.then_some(h.message.as_str()))
                },
                |room| (room, None),
            );
            let state = |uncertain| RelayWrite::PartState {
                relay: R::NAME.into(),
                room: h.room.clone(),
                source: h.message.clone(),
                idx: part.idx,
                destination: room.to_string(),
                uncertain,
            };
            // Commit before the external effect. A crash at any later point keeps this pin.
            if !part.uncertain || part.destination.as_deref() != Some(room) {
                self.store
                    .relay(state(true))
                    .await
                    .map_err(|e| e.to_string())?;
            }
            let outcome = self
                .relay
                .post(room, reply_to, &part.text, &part.nonce)
                .await;
            if !part.uncertain
                && matches!(
                    outcome,
                    PartOutcome::Rejected(_) | PartOutcome::Closed(_) | PartOutcome::SourceGone
                )
            {
                self.store
                    .relay(state(false))
                    .await
                    .map_err(|e| e.to_string())?;
            }
            let bound = target.room.is_some();
            match outcome {
                PartOutcome::Closed(why) | PartOutcome::Rejected(why) if part.uncertain => {
                    return Ok(PartOutcome::Uncertain(format!(
                        "earlier attempt in {room} remains in doubt: {why}"
                    )));
                }
                PartOutcome::SourceGone if part.uncertain => {
                    return Ok(PartOutcome::Uncertain(
                        "the source is gone but the earlier attempt remains in doubt".into(),
                    ));
                }
                // The room bound to the request takes no posts at all (gone, locked, no access):
                // this part and the rest go to the request's room, this part as the reply.
                PartOutcome::Closed(why) if bound => {
                    log::warn(
                        "answer room closed; the rest of the answer goes to the request's room",
                        &[
                            ("message", &h.message),
                            ("part", &part.idx),
                            ("reason", &why),
                        ],
                    );
                    let from = target.room.take().filter(|_| part.idx > 0);
                    *target = Target {
                        room: None,
                        moved_from: from,
                        noted: false,
                    };
                    self.set_target(&h.message, target);
                }
                // Nothing was created there and nothing is in doubt: the first part goes as the
                // linked reply in the request's room after all, with the same nonce.
                PartOutcome::Rejected(why) if bound && part.idx == 0 => {
                    log::warn(
                        "answer room refused the answer; replying in the request's room",
                        &[("message", &h.message), ("reason", &why)],
                    );
                    *target = Target::default();
                    self.set_target(&h.message, target);
                }
                PartOutcome::Posted { id, linked } => {
                    // In the room bound to the request the first part answers it as a linked
                    // reply would (DISC-OUT req. 25, 33).
                    let linked = linked || (bound && part.idx == 0);
                    if !bound && target.moved_from.is_some() {
                        target.moved_from = None;
                        self.set_target(&h.message, target);
                    }
                    return Ok(PartOutcome::Posted { id, linked });
                }
                other => return Ok(other),
            }
        }
    }

    /// Posts the note pointing back to the room the rest of the answer to `h` moved from
    /// ([`Relay::moved_note`]): its own message with its own nonce, tried once per delivery and
    /// never in the place of a part, so no part's text changes and a failed note holds nothing up.
    async fn post_moved_note(&self, h: &HandoffRow, source: &str, target: &mut Target) {
        target.noted = true;
        self.set_target(source, target);
        let Some(note) = target
            .moved_from
            .as_deref()
            .and_then(|from| self.relay.moved_note(from))
        else {
            return;
        };
        let nonce = self.relay.nonce(&h.room, &format!("{source}~moved"), 0);
        let outcome = self.relay.post(&h.room, None, &note, &nonce).await;
        if !matches!(outcome, PartOutcome::Posted { .. }) {
            log::warn(
                "note on the moved answer not posted; the rest goes on",
                &[
                    ("message", &h.message),
                    ("outcome", &format!("{outcome:?}")),
                ],
            );
        }
    }

    /// Posts the pending parts of one answer in order; `false` when it stopped on a failure. The
    /// answer's last part confirmed adds the done mark.
    async fn post_parts(self: &Arc<Self>, h: &HandoffRow) -> Result<bool, String> {
        let parts = {
            let (room, source) = (h.room.clone(), h.message.clone());
            self.store
                .read(move |r| r.parts(R::NAME, &room, &source))
                .await
                .map_err(|e| e.to_string())?
        };
        if !parts.iter().any(|p| p.state == "pending") {
            return Ok(true);
        }
        let mut target = match self.target(h, &parts).await {
            Ok(target) => target,
            Err(why) => {
                if self.first_stuck(&h.message) {
                    log::warn(
                        "where the answer goes is not known yet; retrying",
                        &[("message", &h.message), ("reason", &why)],
                    );
                }
                return Ok(false);
            }
        };
        for part in parts.iter().filter(|p| p.state == "pending") {
            match self.post_part(h, part, &mut target).await? {
                PartOutcome::Posted { id, linked } => {
                    self.store
                        .relay(RelayWrite::PartDone {
                            relay: R::NAME.into(),
                            room: h.room.clone(),
                            source: h.message.clone(),
                            idx: part.idx,
                            remote: id,
                            linked,
                        })
                        .await
                        .map_err(|e| e.to_string())?;
                    if answered(&parts, part.idx) {
                        self.mark_done(&h.room, &h.message);
                    }
                }
                PartOutcome::SourceGone => {
                    log::info(
                        "answer dropped: its request was deleted",
                        &[("message", &h.message)],
                    );
                    self.store
                        .relay(RelayWrite::Answer {
                            relay: R::NAME.into(),
                            room: h.room.clone(),
                            message: h.message.clone(),
                            answer: "dropped".into(),
                        })
                        .await
                        .map_err(|e| e.to_string())?;
                    return Ok(true);
                }
                PartOutcome::Uncertain(why) if !R::REPEATABLE => {
                    // No enforced nonce: a repeat could post the part twice (MSG req. 8).
                    log::warn(
                        "answer part uncertain; not posted again",
                        &[
                            ("relay", &R::NAME),
                            ("message", &h.message),
                            ("part", &part.idx),
                            ("reason", &why),
                        ],
                    );
                    self.store
                        .relay(RelayWrite::Answer {
                            relay: R::NAME.into(),
                            room: h.room.clone(),
                            message: h.message.clone(),
                            answer: "abandoned".into(),
                        })
                        .await
                        .map_err(|e| e.to_string())?;
                    return Ok(true);
                }
                PartOutcome::Rejected(why)
                | PartOutcome::Closed(why)
                | PartOutcome::Uncertain(why) => {
                    if self.first_stuck(&h.message) {
                        log::warn(
                            "answer part not posted; retrying with the same nonce",
                            &[
                                ("message", &h.message),
                                ("part", &part.idx),
                                ("reason", &why),
                            ],
                        );
                    }
                    return Ok(false);
                }
            }
        }
        Ok(true)
    }
}

/// Keeps only the sources still being posted: a delivery that finished or was given up leaves no
/// entry behind.
fn keep_only(stuck: &Mutex<HashSet<String>>, still: &HashSet<&str>) {
    stuck
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .retain(|m| still.contains(m.as_str()));
}

/// Whether the answer is posted once its parts up to `idx` are: none of the answer's parts after it
/// is still pending. A later turn's parts follow the answer and never hold up its done mark.
fn answered(parts: &[PartRow], idx: i64) -> bool {
    !parts
        .iter()
        .any(|p| p.idx > idx && p.state == "pending" && p.turn == 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stuck_deliveries_are_forgotten_once_settled() {
        let stuck = Mutex::new(HashSet::new());
        for n in 0..1000 {
            let message = format!("m{n}");
            stuck.lock().unwrap().insert(message.clone());
            keep_only(&stuck, &HashSet::from([message.as_str()]));
        }
        assert_eq!(stuck.lock().unwrap().len(), 1);
        keep_only(&stuck, &HashSet::new());
        assert!(stuck.lock().unwrap().is_empty());
    }

    fn part(idx: i64, turn: i64) -> PartRow {
        PartRow {
            idx,
            text: String::new(),
            nonce: format!("n{idx}"),
            destination: None,
            state: "pending".into(),
            uncertain: false,
            turn,
        }
    }

    #[test]
    fn the_done_mark_never_waits_behind_a_later_turn() {
        let parts = [part(0, 0), part(1, 0), part(2, 1), part(3, 2)];
        assert!(!answered(&parts, 0), "the answer's second part is pending");
        assert!(answered(&parts, 1), "only later turns are still to post");
        assert!(answered(&parts, 2));
    }

    fn key(message: &str) -> Key {
        ("C1".to_string(), message.to_string())
    }

    fn row(message: &str) -> QueueRow {
        QueueRow {
            room: "C1".into(),
            message: message.into(),
            seq: 1,
            parent: None,
            position_at: 0,
            raw: String::new(),
            created_ms: 0,
        }
    }

    /// The race: a live arrival commits and a round finds the message queued before the arrival
    /// settles. That round waits; the next takes the read time, and no entry is left.
    #[test]
    fn a_round_ahead_of_the_arrival_waits_and_keeps_the_read_time() {
        let mut live = LiveMessages::default();
        for n in 0..1000 {
            let at = Instant::now();
            let k = key(&format!("m{n}"));
            assert!(live.begin(k.clone(), at));
            assert_eq!(live.take(&k), Err(Committing), "the round waits");
            live.settle(&k, true);
            assert_eq!(live.take(&k), Ok(Some(at)));
        }
        assert!(live.0.is_empty());
        // The usual order keeps it too.
        let at = Instant::now();
        assert!(live.begin(key("m"), at));
        live.settle(&key("m"), true);
        assert_eq!(live.take(&key("m")), Ok(Some(at)));
        assert_eq!(live.take(&key("m")), Ok(None));
        assert!(live.0.is_empty());
    }

    #[test]
    fn no_live_entry_outlives_its_message() {
        let at = Instant::now();
        let mut live = LiveMessages::default();
        // Not queued by this read (a duplicate, already handled, a full queue, a store failure).
        assert!(live.begin(key("dup"), at));
        live.settle(&key("dup"), false);
        // Cancelled before its commit told.
        assert!(live.begin(key("cancelled"), at));
        live.abandon(&key("cancelled"));
        assert!(live.0.is_empty());
        // A second read of a message still waiting adds nothing and keeps the first read time.
        assert!(live.begin(key("again"), at));
        live.settle(&key("again"), true);
        assert!(!live.begin(key("again"), at + std::time::Duration::from_millis(5)));
        assert_eq!(live.take(&key("again")), Ok(Some(at)));
        // Decision 15: the round takes the early item before the commit settles, cancelled or not.
        for cancelled in [false, true] {
            assert!(live.begin(key("early"), at));
            live.early(&key("early"), row("early"));
            assert_eq!(live.early_rows(&[]).len(), 1);
            assert_eq!(live.early_rows(&[row("early")]), Vec::<QueueRow>::new());
            if cancelled {
                live.abandon(&key("early"));
            }
            assert_eq!(live.take(&key("early")), Ok(Some(at)));
            if !cancelled {
                live.settle(&key("early"), true);
            }
        }
        assert!(live.0.is_empty());
        // Queued, then gone from the queue without a hand-off (out of scope, a reset): the next
        // round forgets it, but not one queued after that round read its queue.
        assert!(live.begin(key("dropped"), at));
        live.settle(&key("dropped"), true);
        assert!(live.begin(key("kept"), at));
        live.settle(&key("kept"), true);
        let queued = live.queued();
        assert!(live.begin(key("late"), at));
        live.settle(&key("late"), true);
        live.prune(&queued, &[row("kept")]);
        assert_eq!(live.take(&key("dropped")), Ok(None));
        assert_eq!(live.take(&key("kept")), Ok(Some(at)));
        assert_eq!(live.take(&key("late")), Ok(Some(at)));
        assert!(live.0.is_empty());
    }
}
