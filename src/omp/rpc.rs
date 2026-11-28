//! The OMP rpc-ui transport (DESIGN 3.3, 10.1): newline-framed JSON within the advertised physical
//! frame limit, protocol v2 `rpc_chunk` reassembly within the advertised reassembly limit, and
//! request correlation by one reader task that owns stdout and a map of pending request IDs.
//! Events are forwarded to an optional bounded queue; when it is full they are dropped and counted.

use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde_json::{Map, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{Mutex as AsyncMutex, mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::timeout;

/// Largest physical frame accepted, newline included (OMP's own cap).
pub(crate) const PHYSICAL_LIMIT: usize = 1024 * 1024;
/// Largest reassembled v2 frame.
pub(crate) const LOGICAL_LIMIT: usize = 64 * PHYSICAL_LIMIT;
/// Bound for one response and for one write to stdin (DESIGN 9.4).
pub(crate) const RESPONSE_TIMEOUT: Duration = Duration::from_secs(15);
const WRITE_TIMEOUT: Duration = Duration::from_secs(15);

/// A transport failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RpcError {
    /// Reading or writing the pipe failed.
    Io(String),
    /// OMP sent something that breaks the protocol.
    Protocol(String),
    /// OMP closed its stdout.
    Closed,
    /// No answer in time.
    Timeout(&'static str),
    /// A command would exceed the advertised frame limit.
    TooLarge,
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(e) => write!(f, "rpc pipe: {e}"),
            Self::Protocol(e) => write!(f, "rpc protocol: {e}"),
            Self::Closed => f.write_str("OMP closed its rpc output"),
            Self::Timeout(what) => write!(f, "no {what} from OMP in time"),
            Self::TooLarge => f.write_str("rpc command exceeds OMP's frame limit"),
        }
    }
}

impl std::error::Error for RpcError {}

fn protocol(message: &str) -> RpcError {
    RpcError::Protocol(message.to_string())
}

/// What a frame is, from its `type` field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    Ready,
    Response,
    Chunk,
    /// Anything else: session events, dialogs, `rpc_frame_error`.
    Event,
}

/// One logical frame.
#[derive(Debug, Clone)]
pub(crate) struct Frame {
    pub(crate) kind: Kind,
    pub(crate) value: Value,
}

fn kind_of(value: &Value) -> Kind {
    match value.get("type").and_then(Value::as_str) {
        Some("ready") => Kind::Ready,
        Some("response") => Kind::Response,
        Some("rpc_chunk") => Kind::Chunk,
        _ => Kind::Event,
    }
}

/// Reads logical frames from OMP's stdout.
pub(crate) struct Frames<R> {
    reader: BufReader<R>,
    physical: usize,
    logical: usize,
    chunking: bool,
}

impl<R: AsyncRead + Unpin> Frames<R> {
    pub(crate) fn new(reader: R) -> Self {
        Self {
            reader: BufReader::new(reader),
            physical: PHYSICAL_LIMIT,
            logical: LOGICAL_LIMIT,
            chunking: false,
        }
    }

    /// Applies the limits the ready frame advertised; never above OMP's documented caps.
    pub(crate) fn set_limits(&mut self, physical: usize, logical: usize) -> Result<(), RpcError> {
        if physical == 0 || logical == 0 {
            return Err(protocol("OMP advertised invalid frame limits"));
        }
        self.physical = PHYSICAL_LIMIT.min(physical);
        self.logical = LOGICAL_LIMIT.min(logical);
        Ok(())
    }

    /// Accepts `rpc_chunk` sequences from now on (after protocol 2 was negotiated).
    pub(crate) fn enable_chunking(&mut self) {
        self.chunking = true;
    }

    pub(crate) async fn read(&mut self) -> Result<Frame, RpcError> {
        let line = read_line(&mut self.reader, self.physical).await?;
        let value: Value =
            serde_json::from_slice(&line).map_err(|_| protocol("a frame is not JSON"))?;
        let kind = kind_of(&value);
        if kind != Kind::Chunk {
            return Ok(Frame { kind, value });
        }
        if !self.chunking {
            return Err(protocol(
                "rpc_chunk frames before protocol 2 was negotiated",
            ));
        }
        let first = Chunk::from(&value)?;
        if first.byte_length > self.logical
            || first.id.is_empty()
            || first.index != 0
            || first.count == 0
            || first.count > first.byte_length
        {
            return Err(protocol("rpc_chunk sequence bounds"));
        }
        let mut bytes = Vec::new();
        first.append(&mut bytes)?;
        for index in 1..first.count {
            let line = read_line(&mut self.reader, self.physical).await?;
            let value: Value =
                serde_json::from_slice(&line).map_err(|_| protocol("a chunk is not JSON"))?;
            if kind_of(&value) != Kind::Chunk {
                return Err(protocol("interleaved rpc_chunk sequence"));
            }
            let chunk = Chunk::from(&value)?;
            if chunk.index != index
                || chunk.id != first.id
                || chunk.count != first.count
                || chunk.byte_length != first.byte_length
            {
                return Err(protocol("inconsistent rpc_chunk sequence"));
            }
            chunk.append(&mut bytes)?;
        }
        if bytes.len() != first.byte_length {
            return Err(protocol("incomplete rpc_chunk data"));
        }
        let text = std::str::from_utf8(&bytes).map_err(|_| protocol("chunks are not UTF-8"))?;
        let value: Value =
            serde_json::from_str(text).map_err(|_| protocol("reassembled frame is not JSON"))?;
        let kind = kind_of(&value);
        if kind == Kind::Chunk {
            return Err(protocol("nested rpc_chunk sequence"));
        }
        Ok(Frame { kind, value })
    }
}

struct Chunk<'a> {
    id: &'a str,
    index: usize,
    count: usize,
    byte_length: usize,
    data: &'a str,
}

impl<'a> Chunk<'a> {
    fn from(value: &'a Value) -> Result<Self, RpcError> {
        let number = |key: &str| {
            value
                .get(key)
                .and_then(Value::as_u64)
                .and_then(|n| usize::try_from(n).ok())
                .ok_or_else(|| protocol("rpc_chunk fields"))
        };
        Ok(Self {
            id: value
                .get("chunkId")
                .and_then(Value::as_str)
                .ok_or_else(|| protocol("rpc_chunk fields"))?,
            index: number("index")?,
            count: number("count")?,
            byte_length: number("byteLength")?,
            data: value
                .get("data")
                .and_then(Value::as_str)
                .ok_or_else(|| protocol("rpc_chunk fields"))?,
        })
    }

    fn append(&self, bytes: &mut Vec<u8>) -> Result<(), RpcError> {
        let segment = crate::sys::base64::decode(self.data)
            .ok_or_else(|| protocol("invalid base64 chunk"))?;
        if segment.is_empty() || bytes.len() + segment.len() > self.byte_length {
            return Err(protocol("rpc_chunk exceeds its declared length"));
        }
        bytes.extend_from_slice(&segment);
        Ok(())
    }
}

async fn read_line(
    reader: &mut (impl AsyncBufRead + Unpin),
    max: usize,
) -> Result<Vec<u8>, RpcError> {
    let mut bytes = Vec::new();
    loop {
        let available = reader
            .fill_buf()
            .await
            .map_err(|e| RpcError::Io(e.to_string()))?;
        if available.is_empty() {
            return Err(RpcError::Closed);
        }
        let end = available.iter().position(|b| *b == b'\n');
        let consumed = end.map_or(available.len(), |i| i + 1);
        if bytes.len() + consumed > max {
            return Err(protocol("a frame exceeds the physical frame limit"));
        }
        bytes.extend_from_slice(available.get(..end.unwrap_or(consumed)).unwrap_or_default());
        reader.consume(consumed);
        if end.is_some() {
            return Ok(bytes);
        }
    }
}

/// The ready frame's advertised facts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Ready {
    pub(crate) protocol_version: u64,
    pub(crate) supported: Vec<u64>,
    pub(crate) max_frame_bytes: Option<u64>,
    pub(crate) max_reassembled_frame_bytes: Option<u64>,
    pub(crate) bash_exclude_from_context: bool,
}

impl Ready {
    fn parse(value: &Value) -> Result<Self, RpcError> {
        let protocol_version = value
            .get("protocolVersion")
            .and_then(Value::as_u64)
            .ok_or_else(|| protocol("ready frame without protocolVersion"))?;
        Ok(Self {
            protocol_version,
            supported: value
                .get("supportedProtocolVersions")
                .and_then(Value::as_array)
                .map_or_else(Vec::new, |a| a.iter().filter_map(Value::as_u64).collect()),
            max_frame_bytes: value.get("maxFrameBytes").and_then(Value::as_u64),
            max_reassembled_frame_bytes: value
                .get("maxReassembledFrameBytes")
                .and_then(Value::as_u64),
            bash_exclude_from_context: value
                .get("supportsBashExcludeFromContext")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    }
}

/// A command's answer.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Reply {
    pub(crate) success: bool,
    pub(crate) data: Option<Value>,
    pub(crate) error: Option<String>,
    /// The command name OMP echoed.
    pub(crate) command: Option<String>,
}

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Reply, RpcError>>>>>;
type Writer = Box<dyn AsyncWrite + Send + Unpin>;

/// An rpc-ui connection.
pub(crate) struct Rpc {
    writer: AsyncMutex<Option<Writer>>,
    pending: Pending,
    next_id: AtomicU64,
    physical: usize,
    reader: JoinHandle<()>,
    ready: Ready,
    negotiated: u64,
    dropped_events: Arc<AtomicU64>,
}

impl Rpc {
    /// Reads the ready frame (within `ready_within`), which must offer protocol 1, starts the reader
    /// task and negotiates protocol 2 when offered. Events go to `events` when given.
    pub(crate) async fn connect<R, W>(
        reader: R,
        writer: W,
        ready_within: Duration,
        events: Option<mpsc::Sender<Value>>,
    ) -> Result<Self, RpcError>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (_keep, cancel) = tokio::sync::watch::channel(false);
        Self::connect_supervised(reader, writer, ready_within, events, cancel).await
    }

    pub(crate) async fn connect_supervised<R, W>(
        reader: R,
        mut writer: W,
        ready_within: Duration,
        events: Option<mpsc::Sender<Value>>,
        mut cancel: tokio::sync::watch::Receiver<bool>,
    ) -> Result<Self, RpcError>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let deadline = tokio::time::Instant::now() + ready_within;
        let mut frames = Frames::new(reader);
        let first = tokio::select! {
            result = timeout(ready_within, frames.read()) => result.map_err(|_| RpcError::Timeout("ready frame")).and_then(|r| r),
            _ = cancel.wait_for(|stop| *stop) => Err(RpcError::Closed),
        };
        let ready = first.and_then(|first| {
            if first.kind != Kind::Ready {
                return Err(protocol("the first frame is not a ready frame"));
            }
            let ready = Ready::parse(&first.value)?;
            if ready.protocol_version != 1 {
                return Err(RpcError::Protocol(format!(
                    "OMP starts with rpc protocol {}, this hub needs 1",
                    ready.protocol_version
                )));
            }
            let size = |n: Option<u64>, default| {
                n.and_then(|n| usize::try_from(n).ok()).unwrap_or(default)
            };
            frames.set_limits(
                size(ready.max_frame_bytes, PHYSICAL_LIMIT),
                size(ready.max_reassembled_frame_bytes, LOGICAL_LIMIT),
            )?;
            Ok(ready)
        });
        let ready = match ready {
            Ok(ready) => ready,
            Err(error) => {
                // Keep draining even malformed output while the owning caller reaps its process.
                tokio::spawn(async move {
                    let _ = timeout(
                        Duration::from_secs(30),
                        tokio::io::copy(&mut frames.reader, &mut tokio::io::sink()),
                    )
                    .await;
                });
                let _ = timeout(Duration::from_secs(1), writer.shutdown()).await;
                return Err(error);
            }
        };
        let physical = frames.physical;
        let pending: Pending = Arc::default();
        let dropped_events = Arc::new(AtomicU64::new(0));
        let reader = tokio::spawn(read_loop(
            frames,
            Arc::clone(&pending),
            events,
            Arc::clone(&dropped_events),
        ));
        let mut rpc = Self {
            writer: AsyncMutex::new(Some(Box::new(writer))),
            pending,
            next_id: AtomicU64::new(0),
            physical,
            reader,
            negotiated: 1,
            ready,
            dropped_events,
        };
        if rpc.ready.supported.contains(&2) {
            let mut command = Map::new();
            command.insert("type".into(), "negotiate_protocol".into());
            command.insert("protocolVersion".into(), 2.into());
            let reply = tokio::select! {
                reply = rpc.call(command, deadline.saturating_duration_since(tokio::time::Instant::now())) => reply,
                _ = cancel.wait_for(|stop| *stop) => Err(RpcError::Closed),
            };
            let reply = match reply {
                Ok(reply) => reply,
                Err(error) => return Err(rpc.failed_handshake(error).await),
            };
            let confirmed = reply
                .data
                .as_ref()
                .and_then(|d| d.get("protocolVersion"))
                .and_then(Value::as_u64);
            if !reply.success || confirmed != Some(2) {
                return Err(rpc
                    .failed_handshake(protocol("OMP offered protocol 2 but did not confirm it"))
                    .await);
            }
            rpc.negotiated = 2;
        }
        Ok(rpc)
    }

    async fn failed_handshake(mut self, error: RpcError) -> RpcError {
        self.end_input().await;
        tokio::spawn(async move {
            let _ = timeout(Duration::from_secs(30), &mut self.reader).await;
        });
        error
    }

    pub(crate) fn ready(&self) -> &Ready {
        &self.ready
    }

    /// The protocol in use: 1, or 2 after negotiation.
    pub(crate) fn protocol(&self) -> u64 {
        self.negotiated
    }

    /// Events dropped because the queue was full or absent.
    pub(crate) fn dropped_events(&self) -> u64 {
        self.dropped_events.load(Ordering::Relaxed)
    }

    /// Sends one command (an object with its `type`) and waits for the response with its ID.
    pub(crate) async fn call(
        &self,
        command: Map<String, Value>,
        within: Duration,
    ) -> Result<Reply, RpcError> {
        self.call_at(command, within).await.0
    }

    /// Like [`Rpc::call`], and also returns when the command line was completely written, which is
    /// `None` when nothing reached OMP's stdin. A reply whose echoed command differs from the one
    /// sent ends in a protocol error (HOST req. 30).
    pub(crate) async fn call_at(
        &self,
        mut command: Map<String, Value>,
        within: Duration,
    ) -> (Result<Reply, RpcError>, Option<Instant>) {
        let deadline = tokio::time::Instant::now() + within;
        let id = format!(
            "cataly-{}",
            self.next_id.fetch_add(1, Ordering::Relaxed) + 1
        );
        let kind = command
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        command.insert("id".into(), Value::String(id.clone()));
        let line = match encode_line(&command, self.physical) {
            Ok(line) => line,
            Err(e) => return (Err(e), None),
        };
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id.clone(), tx);
        let forget = || {
            self.pending
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(&id);
        };
        if self.reader.is_finished() {
            forget();
            return (Err(RpcError::Closed), None);
        }
        if let Err(e) = timeout(within, self.write(&line, within))
            .await
            .unwrap_or(Err(RpcError::Timeout("write to stdin")))
        {
            forget();
            return (Err(e), None);
        }
        let written = Instant::now();
        let result = match timeout(
            deadline.saturating_duration_since(tokio::time::Instant::now()),
            rx,
        )
        .await
        {
            Ok(Ok(Ok(reply))) if reply.command.as_deref() != Some(kind.as_str()) => Err(protocol(
                "a response echoed a different command than the one sent",
            )),
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(RpcError::Closed),
            Err(_) => {
                forget();
                Err(RpcError::Timeout("response"))
            }
        };
        (result, Some(written))
    }

    /// Writes one frame that has no response, such as an `extension_ui_response`.
    pub(crate) async fn send(&self, frame: &Map<String, Value>) -> Result<(), RpcError> {
        if self.reader.is_finished() {
            return Err(RpcError::Closed);
        }
        let line = encode_line(frame, self.physical)?;
        self.write(&line, WRITE_TIMEOUT).await
    }

    /// Whether OMP's output ended (the reader task stopped).
    pub(crate) fn closed(&self) -> bool {
        self.reader.is_finished()
    }

    async fn write(&self, line: &[u8], within: Duration) -> Result<(), RpcError> {
        let mut guard = self.writer.lock().await;
        let writer = guard.as_mut().ok_or(RpcError::Closed)?;
        timeout(within, async {
            writer.write_all(line).await?;
            writer.flush().await
        })
        .await
        .map_err(|_| RpcError::Timeout("write to stdin"))?
        .map_err(|e| RpcError::Io(e.to_string()))
    }

    /// Closes stdin, OMP's signal to drain and exit. The reader task keeps draining stdout until OMP
    /// closes it.
    pub(crate) async fn end_input(&self) {
        let close = async {
            let mut guard = self.writer.lock().await;
            if let Some(mut writer) = guard.take() {
                writer.shutdown().await?;
            }
            Ok::<(), std::io::Error>(())
        };
        // Includes waiting for a concurrent writer. Process termination, not this write, is the
        // cleanup authority if a pipe or remote connection cannot finish its shutdown.
        let _ = timeout(Duration::from_secs(1), close).await;
    }
}

impl Drop for Rpc {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

async fn read_loop<R: AsyncRead + Unpin>(
    mut frames: Frames<R>,
    pending: Pending,
    events: Option<mpsc::Sender<Value>>,
    dropped: Arc<AtomicU64>,
) {
    let failure = loop {
        let frame = match frames.read().await {
            Ok(frame) => frame,
            Err(e) => break e,
        };
        match frame.kind {
            Kind::Response => {
                let Value::Object(mut value) = frame.value else {
                    continue;
                };
                let Some(Value::String(id)) = value.remove("id") else {
                    continue;
                };
                let success = value.get("success").and_then(Value::as_bool) == Some(true);
                let command = value.get("command").and_then(Value::as_str);
                if success
                    && command == Some("negotiate_protocol")
                    && value
                        .get("data")
                        .and_then(|d| d.get("protocolVersion"))
                        .and_then(Value::as_u64)
                        == Some(2)
                {
                    // OMP chunks only frames written after this response.
                    frames.enable_chunking();
                }
                let reply = Reply {
                    success,
                    data: value.remove("data"),
                    error: match value.remove("error") {
                        Some(Value::String(error)) => Some(error),
                        _ => None,
                    },
                    command: match value.remove("command") {
                        Some(Value::String(command)) => Some(command),
                        _ => None,
                    },
                };
                let waiter = pending
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .remove(&id);
                if let Some(waiter) = waiter {
                    let _ = waiter.send(Ok(reply));
                }
            }
            Kind::Event | Kind::Ready => {
                let delivered = events
                    .as_ref()
                    .is_some_and(|tx| tx.try_send(frame.value).is_ok());
                if !delivered {
                    dropped.fetch_add(1, Ordering::Relaxed);
                }
            }
            Kind::Chunk => {}
        }
    };
    let waiters: Vec<_> = pending
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .drain()
        .collect();
    for (_, waiter) in waiters {
        let _ = waiter.send(Err(failure.clone()));
    }
}

/// One command line: JSON plus newline, within the physical frame limit.
fn encode_line(frame: &Map<String, Value>, physical: usize) -> Result<Vec<u8>, RpcError> {
    let mut line = serde_json::to_vec(frame).map_err(|e| RpcError::Protocol(e.to_string()))?;
    line.push(b'\n');
    if line.len() > physical {
        return Err(RpcError::TooLarge);
    }
    Ok(line)
}

/// Builds a command object from its type and fields.
pub(crate) fn command(kind: &str, fields: &[(&str, Value)]) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert("type".into(), Value::String(kind.into()));
    for (k, v) in fields {
        map.insert((*k).to_string(), v.clone());
    }
    map
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, duplex};

    fn chunks(payload: &[u8], split: usize) -> [String; 2] {
        let (head, tail) = payload.split_at(split);
        [(0, head), (1, tail)].map(|(index, part)| {
            format!(
                "{}\n",
                json!({
                    "type": "rpc_chunk", "chunkId": "proof", "index": index,
                    "count": 2, "byteLength": payload.len(), "data": crate::sys::base64::encode(part),
                })
            )
        })
    }

    #[tokio::test]
    async fn reassembles_utf8_split_inside_a_character() {
        let payload = r#"{"type":"response","text":"한글"}"#.as_bytes();
        let split = payload.iter().position(|b| !b.is_ascii()).unwrap() + 1;
        let stream = chunks(payload, split).concat();
        let mut frames = Frames::new(stream.as_bytes());
        frames.enable_chunking();
        let frame = frames.read().await.unwrap();
        assert_eq!(frame.kind, Kind::Response);
        assert_eq!(frame.value["text"], "한글");
    }

    #[tokio::test]
    async fn rejects_an_event_between_chunks_and_chunks_before_negotiation() {
        let [first, second] = chunks(br#"{"type":"response"}"#, 4);
        let stream = format!("{first}{{\"type\":\"agent_end\"}}\n{second}");
        let mut frames = Frames::new(stream.as_bytes());
        frames.enable_chunking();
        let error = frames.read().await.unwrap_err();
        assert!(error.to_string().contains("interleaved"), "{error}");
        let mut plain = Frames::new(first.as_bytes());
        assert!(
            plain
                .read()
                .await
                .unwrap_err()
                .to_string()
                .contains("negotiated")
        );
    }

    #[tokio::test]
    async fn enforces_physical_and_reassembly_limits() {
        let plain = b"{\"type\":\"response\"}\n";
        let mut frames = Frames::new(plain.as_slice());
        frames.set_limits(plain.len() - 1, 128).unwrap();
        let error = frames.read().await.unwrap_err();
        assert!(error.to_string().contains("physical"), "{error}");
        let stream = chunks(&plain[..plain.len() - 1], 4).concat();
        let mut frames = Frames::new(stream.as_bytes());
        frames.set_limits(1024, plain.len() - 2).unwrap();
        frames.enable_chunking();
        let error = frames.read().await.unwrap_err();
        assert!(error.to_string().contains("sequence bounds"), "{error}");
        assert!(frames.set_limits(0, 1).is_err());
    }

    /// A scripted OMP on the far end of a duplex pipe: answers every command by its type, out of
    /// order when asked, and sends an event before each answer.
    pub(crate) async fn fake_omp(
        server: tokio::io::DuplexStream,
        ready: Value,
        answer: fn(&Value) -> Value,
    ) {
        let (read, mut write) = tokio::io::split(server);
        let mut lines = BufReader::new(read).lines();
        write
            .write_all(format!("{ready}\n").as_bytes())
            .await
            .unwrap();
        let mut held: Option<Value> = None;
        while let Ok(Some(line)) = lines.next_line().await {
            let cmd: Value = serde_json::from_str(&line).unwrap();
            let mut reply = answer(&cmd);
            reply["type"] = "response".into();
            reply["id"] = cmd["id"].clone();
            reply["command"] = cmd["type"].clone();
            write
                .write_all(b"{\"type\":\"agent_start\"}\n")
                .await
                .unwrap();
            if cmd["type"] == "hold" {
                held = Some(reply);
                continue;
            }
            write
                .write_all(format!("{reply}\n").as_bytes())
                .await
                .unwrap();
            if let Some(h) = held.take() {
                write.write_all(format!("{h}\n").as_bytes()).await.unwrap();
            }
        }
    }

    fn ready() -> Value {
        json!({"type": "ready", "protocolVersion": 1, "supportedProtocolVersions": [1, 2],
               "maxFrameBytes": 1_048_576, "maxReassembledFrameBytes": 67_108_864})
    }

    fn answer(cmd: &Value) -> Value {
        match cmd["type"].as_str() {
            Some("negotiate_protocol") => json!({"success": true, "data": {"protocolVersion": 2}}),
            Some("nope") => json!({"success": false, "error": "Unknown command: nope"}),
            _ => json!({"success": true, "data": {"echo": cmd["type"]}}),
        }
    }

    #[tokio::test]
    async fn replies_preserve_absent_null_and_malformed_fields() {
        for (fields, success, data, error, command) in [
            (
                json!({"success": true, "command": "get_state"}),
                true,
                None,
                None,
                Some("get_state"),
            ),
            (
                json!({"success": true, "data": null, "error": null, "command": null}),
                true,
                Some(Value::Null),
                None,
                None,
            ),
            (
                json!({"success": "true", "data": {"nested": [1, "two", null]},
                       "error": 42, "command": ["get_state"]}),
                false,
                Some(json!({"nested": [1, "two", null]})),
                None,
                None,
            ),
            (
                json!({"success": false, "error": "refused", "command": "get_state"}),
                false,
                None,
                Some("refused"),
                Some("get_state"),
            ),
        ] {
            let mut response = fields;
            response["type"] = "response".into();
            response["id"] = "request".into();
            let stream = format!("{response}\n");
            let pending: Pending = Arc::default();
            let (tx, rx) = oneshot::channel();
            pending.lock().unwrap().insert("request".into(), tx);
            read_loop(
                Frames::new(stream.as_bytes()),
                pending,
                None,
                Arc::new(AtomicU64::new(0)),
            )
            .await;
            let reply = rx.await.unwrap().unwrap();
            assert_eq!(reply.success, success);
            assert_eq!(reply.data, data);
            assert_eq!(reply.error.as_deref(), error);
            assert_eq!(reply.command.as_deref(), command);
        }
    }

    #[tokio::test]
    async fn negotiation_enables_chunking_without_a_waiter() {
        let response = json!({"type": "response", "id": "request", "success": true,
                              "command": "get_state", "data": {"nested": [1, 2, 3]}});
        let payload = serde_json::to_vec(&response).unwrap();
        let stream = format!(
            "{}\n{}",
            json!({"type": "response", "id": "gone", "success": true,
                   "command": "negotiate_protocol", "data": {"protocolVersion": 2}}),
            chunks(&payload, payload.len() / 2).concat()
        );
        let pending: Pending = Arc::default();
        let (tx, rx) = oneshot::channel();
        pending.lock().unwrap().insert("request".into(), tx);
        read_loop(
            Frames::new(stream.as_bytes()),
            pending,
            None,
            Arc::new(AtomicU64::new(0)),
        )
        .await;
        let reply = rx.await.unwrap().unwrap();
        assert!(reply.success);
        assert_eq!(reply.data.as_ref(), response.get("data"));
        assert_eq!(reply.command.as_deref(), Some("get_state"));
    }

    #[tokio::test]
    async fn correlates_out_of_order_answers_and_forwards_events() {
        let (client, server) = duplex(1 << 16);
        tokio::spawn(fake_omp(server, ready(), answer));
        let (read, write) = tokio::io::split(client);
        let (tx, mut rx) = mpsc::channel(16);
        let rpc = Arc::new(
            Rpc::connect(read, write, Duration::from_secs(5), Some(tx))
                .await
                .unwrap(),
        );
        assert_eq!(rpc.protocol(), 2);
        assert_eq!(rpc.ready().max_frame_bytes, Some(1_048_576));
        let held = {
            let rpc = Arc::clone(&rpc);
            tokio::spawn(async move { rpc.call(command("hold", &[]), RESPONSE_TIMEOUT).await })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        let second = rpc
            .call(command("get_state", &[]), RESPONSE_TIMEOUT)
            .await
            .unwrap();
        assert_eq!(second.data.unwrap()["echo"], "get_state");
        let first = held.await.unwrap().unwrap();
        assert_eq!(
            first.data.unwrap()["echo"],
            "hold",
            "answered after the later call"
        );
        let refused = rpc
            .call(command("nope", &[]), RESPONSE_TIMEOUT)
            .await
            .unwrap();
        assert!(!refused.success && refused.error.unwrap().contains("Unknown"));
        assert_eq!(rx.recv().await.unwrap()["type"], "agent_start");
    }

    #[tokio::test]
    async fn closed_output_fails_pending_calls_and_v1_stays_v1() {
        let (client, server) = duplex(1 << 16);
        let (read, write) = tokio::io::split(client);
        let (server_read, mut server_write) = tokio::io::split(server);
        server_write
            .write_all(b"{\"type\":\"ready\",\"protocolVersion\":1}\n")
            .await
            .unwrap();
        let rpc = Rpc::connect(read, write, Duration::from_secs(5), None)
            .await
            .unwrap();
        assert_eq!(rpc.protocol(), 1);
        let call = rpc.call(command("get_state", &[]), RESPONSE_TIMEOUT);
        let close = async {
            let mut lines = BufReader::new(server_read).lines();
            lines.next_line().await.unwrap();
            drop(server_write);
        };
        let (result, ()) = tokio::join!(call, close);
        assert_eq!(result.unwrap_err(), RpcError::Closed);
    }

    #[tokio::test]
    async fn a_non_ready_first_frame_or_protocol_two_start_is_refused() {
        for first in [
            r#"{"type":"agent_start"}"#,
            r#"{"type":"ready","protocolVersion":2}"#,
        ] {
            let (client, server) = duplex(1 << 12);
            let (read, write) = tokio::io::split(client);
            let (_r, mut w) = tokio::io::split(server);
            w.write_all(format!("{first}\n").as_bytes()).await.unwrap();
            let result = Rpc::connect(read, write, Duration::from_secs(5), None).await;
            assert!(matches!(result, Err(RpcError::Protocol(_))), "{first}");
        }
        let (client, _server) = duplex(1 << 12);
        let (read, write) = tokio::io::split(client);
        let result = Rpc::connect(read, write, Duration::from_millis(50), None).await;
        assert!(matches!(result, Err(RpcError::Timeout(_))));
    }
}
