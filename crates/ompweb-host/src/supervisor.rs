//! R8: Rust OMP Supervisor (doc 15 / v4 P12/R8).
//!
//! Owns the OMP child process lifecycle for RPC sessions — spawn, stdin
//! writes with protocol-v2 chunking, stdout NDJSON line reads with the
//! 1 MiB frame cap, crash recovery (restart with backoff), and per-session
//! event streaming. This is the first production Authority cutover target:
//! when feature flag backend.agent=rust is on, NO Node code spawns OMP.
//!
//! Wire compatibility with lib/omp/rpc-frame.ts:
//!   - physical layer: JSONL lines, max 1 MiB
//!   - logical frames > 1 MiB are split into rpc_chunk records (chunkId /
//!     index / count / byteLength / base64 data), reassembled on read,
//!     64 MiB reassembly cap.

use crate::mini_json::JsonValue;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::{Arc, Mutex};

use crate::process_visibility::hide_console_window;

pub const MAX_RPC_FRAME_BYTES: usize = 1024 * 1024;
pub const MAX_RPC_REASSEMBLED_BYTES: usize = 64 * 1024 * 1024;
const RPC_CHUNK_PAYLOAD_BYTES: usize = 256 * 1024;
const MAX_RESTARTS: u32 = 3;

#[derive(Clone)]
pub enum SessionEvent {
    /// A complete logical RPC frame (JSON text) from the child, tagged with
    /// the session-scoped broadcast sequence so a reattaching client can
    /// dedupe replayed frames it already delivered.
    Frame { seq: u64, frame: String },
    /// Child exited (after restarts exhausted or graceful).
    Exited {
        code: Option<i32>,
        signal: Option<i32>,
    },
}

struct Session {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    subscribers: Vec<SyncSender<SessionEvent>>,
    restarts: u32,
    killed: bool,
    /// Extra CLI args the child was spawned with (--resume/--tools/...).
    /// Replayed verbatim on crash restart so a recovered session resumes the
    /// same conversation (doc 16 route 4: args 完整传递 + restart 保真).
    args: Vec<String>,
    /// Bounded replay ring: frames emitted before a subscriber attaches are
    /// replayed so late attach (fast omp startup) still sees ready/init
    /// frames. Keeps the ring tight (64 x up-to-1MiB is bounded by the frame
    /// cap; normal frames are far smaller). Each entry carries the
    /// session-scoped sequence so a reattaching client can dedupe replayed
    /// frames it already delivered live.
    ring: std::collections::VecDeque<(u64, String)>,
    /// Monotonic per-session frame sequence, assigned at broadcast time.
    next_seq: u64,
}

pub struct Supervisor {
    sessions: Mutex<HashMap<String, Session>>,
    omp_bin: String,
    omp_env: Vec<(String, String)>,
    /// Sessions whose last subscriber was dropped by a full channel: the
    /// subscriber's stream closed while the child kept streaming, so frames
    /// were lost. The next agent.attach reattaches (replay + gap notice)
    /// instead of silently resuming mid-stream.
    gapped: Mutex<std::collections::HashSet<String>>,
}

impl Supervisor {
    pub fn new(omp_bin: String, env: Vec<(String, String)>) -> Arc<Supervisor> {
        Arc::new(Supervisor {
            sessions: Mutex::new(HashMap::new()),
            omp_bin,
            omp_env: env,
            gapped: Mutex::new(std::collections::HashSet::new()),
        })
    }

    pub fn list(&self) -> Vec<(String, u32, u32)> {
        let guard = self.sessions.lock().unwrap();
        guard
            .iter()
            .map(|(id, s)| (id.clone(), s.child.id(), s.restarts))
            .collect()
    }

    /// Spawn `omp --mode rpc-ui` for one session. Returns (pid, restarts).
    /// `extra_args` mirror the Node spawn order (--resume/--tools/--advisor/
    /// ... appended after `--cwd`); replayed verbatim on crash restart.
    pub fn spawn(
        self: &Arc<Self>,
        session_id: &str,
        cwd: &str,
        extra_args: &[String],
    ) -> Result<(u32, u32), String> {
        let mut guard = self.sessions.lock().unwrap();
        if let Some(existing) = guard.get(session_id) {
            // Alive already — idempotent spawn.
            return Ok((existing.child.id(), existing.restarts));
        }
        let mut child = self
            .spawn_child(cwd, extra_args)
            .map_err(|e| format!("spawn omp: {e}"))?;
        let pid = child.id();
        let stdin = child.stdin.take().ok_or("child stdin unavailable")?;
        let session = Session {
            child,
            stdin: Arc::new(Mutex::new(stdin)),
            subscribers: vec![],
            restarts: 0,
            killed: false,
            args: extra_args.to_vec(),
            ring: std::collections::VecDeque::new(),
            next_seq: 0,
        };
        guard.insert(session_id.to_string(), session);
        drop(guard);
        self.start_reader(session_id.to_string(), cwd.to_string(), 0);
        Ok((pid, 0))
    }

    /// Subscribe to a session's event stream. Returns (receiver, replay
    /// snapshot, has_gap). The subscription and the snapshot are taken under
    /// one lock so a frame arriving concurrently is either in both (the
    /// subscriber dedupes by seq) or in neither — the initial attach can
    /// never miss ready/init frames, and replay is never duplicated.
    ///
    /// `since_seq` filters the snapshot to frames the client has not yet
    /// delivered (reattach dedupe); 0 = replay everything.
    ///
    /// `has_gap` is true when the session's last subscriber was dropped by a
    /// full channel: frames were lost between subscribers and the client
    /// must be told (rpc_stream_gap) rather than silently resuming.
    pub fn subscribe_from(
        &self,
        session_id: &str,
        since_seq: u64,
    ) -> Result<(Receiver<SessionEvent>, Vec<(u64, String)>, bool), String> {
        let mut guard = self.sessions.lock().unwrap();
        let session = guard.get_mut(session_id).ok_or("no such session")?;
        let (tx, rx) = sync_channel(64);
        session.subscribers.push(tx);
        let replay: Vec<(u64, String)> = session
            .ring
            .iter()
            .filter(|(seq, _)| *seq > since_seq)
            .cloned()
            .collect();
        let mut gapped = self.gapped.lock().unwrap();
        let has_gap = gapped.remove(session_id);
        drop(guard);
        Ok((rx, replay, has_gap))
    }

    /// Mark a session as having lost frames: its last subscriber was dropped
    /// because the channel was full, so live frames after the drop never
    /// reached any client.
    fn mark_gapped(&self, session_id: &str) {
        self.gapped.lock().unwrap().insert(session_id.to_string());
    }

    fn spawn_child(&self, cwd: &str, extra_args: &[String]) -> Result<Child, String> {
        let mut cmd = Command::new(&self.omp_bin);
        // Node path (lib/omp/rpc-process.ts) passes --cwd explicitly; the
        // working directory alone is not enough for omp's rpc-ui mode.
        // extra_args mirror Node's spawn order (appended after --cwd):
        // --resume <file>, --tools, --advisor, ...
        cmd.args(["--mode", "rpc-ui", "--cwd", cwd])
            .current_dir(cwd)
            .env_remove("OMPWEB_PEER_SECRET")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        for arg in extra_args {
            cmd.arg(arg);
        }
        for (key, value) in &self.omp_env {
            cmd.env(key, value);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        hide_console_window(&mut cmd);
        cmd.spawn().map_err(|e| e.to_string())
    }

    /// Send one logical RPC frame (JSON object text) to the child's stdin,
    /// chunking per protocol v2 when above the 1 MiB line cap.
    pub fn send(&self, session_id: &str, frame_json: &str) -> Result<(), String> {
        let stdin = {
            let guard = self.sessions.lock().unwrap();
            let session = guard.get(session_id).ok_or("no such session")?;
            if session.killed { return Err("session stopped".into()); }
            Arc::clone(&session.stdin)
        };
        let lines = encode_rpc_frames(frame_json).map_err(|e| e.to_string())?;
        // A blocked pipe must not hold the registry lock: list, broadcast and
        // kill (including this session's kill) must remain available.
        let mut stdin = stdin.lock().map_err(|_| "stdin writer unavailable")?;
        for line in &lines {
            stdin
                .write_all(line.as_bytes())
                .map_err(|e| format!("stdin: {e}"))?;
        }
        stdin.flush().map_err(|e| format!("flush: {e}"))?;
        Ok(())
    }

    /// Kill a session's child. A user-initiated kill must NOT trigger
    /// crash recovery (v4 P12: restarts are for unexpected exits).
    pub fn kill(&self, session_id: &str) -> Result<(), String> {
        let mut guard = self.sessions.lock().unwrap();
        if let Some(session) = guard.get_mut(session_id) {
            session.killed = true;
            crate::command_service::terminate_process_tree(&mut session.child);
        }
        Ok(())
    }

    #[allow(dead_code)] // lifecycle API for host shutdown
    pub fn remove(&self, session_id: &str) {
        self.sessions.lock().unwrap().remove(session_id);
    }

    fn start_reader(
        self: &Arc<Self>,
        session_id: String,
        cwd: String,
        restarts: u32,
    ) {
        let this = Arc::clone(self);
        std::thread::spawn(move || {
            this.reader_main(session_id, cwd, restarts);
        });
    }

    fn reader_main(
        self: &Arc<Self>,
        session_id: String,
        cwd: String,
        restarts: u32,
    ) {
        // Take the child's stdout under lock; the Session (with stdin and
        // subscribers) stays in the map so agent.send/attach keep working
        // while the reader streams.
        let stdout = {
            let mut guard = self.sessions.lock().unwrap();
            match guard.get_mut(&session_id) {
                Some(session) => match session.child.stdout.take() {
                    Some(out) => out,
                    None => return,
                },
                None => return,
            }
        };
        let mut reader = BufReader::new(stdout);
        let mut decoder = FrameReassembler::new();
        let mut line: Vec<u8> = Vec::new();
        loop {
            line.clear();
            match read_line_capped(&mut reader, &mut line, MAX_RPC_REASSEMBLED_BYTES) {
                Ok(Some(0)) => break,
                Ok(Some(_)) => {
                    // Byte-accurate line; lossy UTF-8 (pipe segments can split
                    // multi-byte characters — a String-based reader would die
                    // on the boundary and stall the stream).
                    let text = String::from_utf8_lossy(&line);
                    match decoder.push_line(&text) {
                        Ok(Some(frame)) => {
                            self.broadcast(&session_id, SessionEvent::Frame { seq: 0, frame });
                        }
                        Ok(None) => {}
                        Err(_) => {
                            // Malformed frame: drop the line (documented loss),
                            // keep reading — a flood must not kill the supervisor.
                        }
                    }
                }
                Ok(None) => decoder.reset(),
                Err(_) => break,
            }
        }
        // stdout EOF does not imply process exit. Poll without retaining the
        // registry lock so a child that closes stdout can still be cancelled.
        let (code, signal) = loop {
            let mut guard = self.sessions.lock().unwrap();
            match guard.get_mut(&session_id) {
                Some(session) => match session.child.try_wait() {
                    Ok(Some(status)) => break (status.code(), signal_of(&status)),
                    Ok(None) => {},
                    Err(_) => break (None, None),
                },
                None => return,
            }
            drop(guard);
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        // Crash recovery: restart only on UNEXPECTED exits (user kills are
        // flagged and must not resurrect the session).
        let user_killed = {
            let guard = self.sessions.lock().unwrap();
            guard.get(&session_id).map(|s| s.killed).unwrap_or(false)
        };
        let should_restart = !user_killed && code != Some(0) && restarts < MAX_RESTARTS;
        if should_restart {
            // Replay the session's spawn args on restart so a recovered child
            // resumes the same conversation (--resume etc. — route 4 parity).
            let restart_args = {
                let guard = self.sessions.lock().unwrap();
                guard
                    .get(&session_id)
                    .map(|s| s.args.clone())
                    .unwrap_or_default()
            };
            std::thread::sleep(std::time::Duration::from_millis(100 * (1 << restarts)));
            if let Ok(mut new_child) = self.spawn_child(&cwd, &restart_args) {
                let new_pid = new_child.id();
                let new_stdin = new_child.stdin.take().expect("piped child stdin");
                {
                    let mut guard = self.sessions.lock().unwrap();
                    if let Some(session) = guard.get_mut(&session_id).filter(|s| !s.killed && s.restarts == restarts) {
                        session.child = new_child;
                        session.stdin = Arc::new(Mutex::new(new_stdin));
                        session.restarts = restarts + 1;
                        session.ring.clear();
                        session.next_seq = 0;
                    } else {
                        drop(guard);
                        crate::command_service::terminate_process_tree(&mut new_child);
                        let _ = new_child.wait();
                        self.broadcast(&session_id, SessionEvent::Exited { code, signal });
                        self.sessions.lock().unwrap().remove(&session_id);
                        return;
                    }
                }
                self.broadcast(&session_id, SessionEvent::Frame { seq: 0, frame: format!(
                    "{{\"type\":\"session_restarted\",\"sessionId\":{},\"pid\":{},\"restarts\":{}}}",
                    crate::ipc_server::json_str(&session_id),
                    new_pid,
                    restarts + 1
                )});
                self.start_reader(session_id.clone(), cwd, restarts + 1);
                return;
            }
        }
        self.broadcast(&session_id, SessionEvent::Exited { code, signal });
        // Remove the dead session (subscribers see Exited and detach).
        self.sessions.lock().unwrap().remove(&session_id);
    }

    fn broadcast(&self, session_id: &str, event: SessionEvent) {
        let mut guard = self.sessions.lock().unwrap();
        if let Some(session) = guard.get_mut(session_id) {
            // Assign the session-scoped sequence under the same lock that
            // publishes to subscribers and the replay ring: a reattaching
            // client either sees a frame in both or neither.
            let seq = if let SessionEvent::Frame { .. } = &event {
                session.next_seq += 1;
                Some(session.next_seq)
            } else {
                None
            };
            let tagged = match (&event, seq) {
                (SessionEvent::Frame { frame, .. }, Some(seq)) => {
                    SessionEvent::Frame { seq, frame: frame.clone() }
                }
                _ => event,
            };
            let mut dropped = false;
            session
                .subscribers
                // Disconnect slow consumers; their attach stream closes once
                // drained and the client reconciles. Never grow an unbounded
                // channel or block another session behind a stalled consumer.
                .retain(|sub| {
                    let sent = sub.try_send(tagged.clone()).is_ok();
                    if !sent { dropped = true; }
                    sent
                });
            if dropped && session.subscribers.is_empty() {
                // Every consumer was dropped: everything after this frame is
                // lost until a client reattaches.
                self.mark_gapped(session_id);
            }
            if let SessionEvent::Frame { frame, .. } = &tagged {
                const REPLAY_BYTES: usize = 4 * 1024 * 1024;
                let seq = seq.unwrap_or_default();
                while !session.ring.is_empty() && (session.ring.len() >= 64 ||
                    session.ring.iter().map(|(_, f)| f.len()).sum::<usize>() + frame.len() > REPLAY_BYTES) {
                    session.ring.pop_front();
                }
                if frame.len() <= REPLAY_BYTES { session.ring.push_back((seq, frame.clone())); }
            }
        }
    }

    /// Frames recorded before this subscriber attached (bounded replay),
    /// each tagged with its session sequence for client-side dedupe.
    #[allow(dead_code)] // legacy replay surface; agent.attach uses subscribe_from
    pub fn recent_frames(&self, session_id: &str) -> Vec<(u64, String)> {
        let guard = self.sessions.lock().unwrap();
        match guard.get(session_id) {
            Some(session) => session.ring.iter().cloned().collect(),
            None => Vec::new(),
        }
    }
}

fn signal_of(status: &std::process::ExitStatus) -> Option<i32> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        status.signal()
    }
    #[cfg(not(unix))]
    {
        let _ = status;
        None
    }
}

/// Read one bounded line; None means an oversized line was drained.
/// Byte-based (no UTF-8 validation per segment): pipe reads can split a
/// multi-byte character, and a String-based accumulator would fail on the
/// boundary and stall the whole stream.
fn read_line_capped<R: BufRead>(
    reader: &mut R,
    line: &mut Vec<u8>,
    cap: usize,
) -> std::io::Result<Option<usize>> {
    let mut too_large = false;
    loop {
        let buf = reader.fill_buf()?;
        if buf.is_empty() {
            return Ok(if too_large { None } else { Some(line.len()) });
        }
        let newline = buf.iter().position(|b| *b == b'\n');
        let take = newline.map_or(buf.len(), |idx| idx + 1);
        if !too_large {
            if take > cap.saturating_sub(line.len()) {
                too_large = true;
            } else {
                line.extend_from_slice(&buf[..take]);
            }
        }
        reader.consume(take);
        if newline.is_some() {
            return Ok(if too_large { None } else { Some(line.len()) });
        }
    }
}

/// Protocol-v2 frame reassembler (mirrors RpcFrameDecoder).
struct FrameReassembler {
    pending_chunk_id: Option<String>,
    pending_count: usize,
    pending_byte_length: usize,
    pending_next_index: usize,
    pending_parts: Vec<Vec<u8>>,
    pending_received: usize,
}

impl FrameReassembler {
    fn new() -> Self {
        FrameReassembler {
            pending_chunk_id: None,
            pending_count: 0,
            pending_byte_length: 0,
            pending_next_index: 0,
            pending_parts: Vec::new(),
            pending_received: 0,
        }
    }

    /// Clears any in-flight chunk sequence so a malformed/interrupted one
    /// cannot poison every later frame.
    fn reset(&mut self) {
        self.pending_chunk_id = None;
        self.pending_count = 0;
        self.pending_byte_length = 0;
        self.pending_next_index = 0;
        self.pending_parts.clear();
        self.pending_received = 0;
    }

    /// Chunk metadata arrives as JSON numbers (JS JSON.stringify) and
    /// historically as strings; accept both. `as_str` on a parsed number
    /// returns None, which silently rejected every v2 chunk.
    fn meta_usize(value: &JsonValue, key: &str) -> usize {
        match value.get(&[key]) {
            Some(JsonValue::Num(n))
                if n.is_finite() && n.fract() == 0.0 && *n >= 0.0 =>
            {
                if *n <= usize::MAX as f64 { *n as usize } else { usize::MAX }
            }
            Some(JsonValue::Str(s)) => s.parse::<usize>().unwrap_or(usize::MAX),
            _ => usize::MAX,
        }
    }

    fn push_line(&mut self, line: &str) -> Result<Option<String>, String> {
        let value = JsonValue::parse(line.trim()).map_err(|e| e.to_string())?;
        let kind = value
            .get(&["type"])
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if kind != "rpc_chunk" {
            self.reset();
            // A normal frame after an interrupted chunk sequence is DELIVERED,
            // not discarded — dropping it would hide agent_end / RPC responses
            // behind one broken chunk.
            return Ok(Some(line.trim().to_string()));
        }
        let chunk_id = value
            .get(&["chunkId"])
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let index = Self::meta_usize(&value, "index");
        let count = Self::meta_usize(&value, "count");
        let byte_length = Self::meta_usize(&value, "byteLength");
        let data = value.get(&["data"]).and_then(|v| v.as_str()).unwrap_or("");
        if chunk_id.is_empty()
            || chunk_id.len() > 128
            || count < 2
            || index >= count
            || byte_length > MAX_RPC_REASSEMBLED_BYTES
        {
            self.reset();
            return Err("invalid chunk metadata".into());
        }
        let bytes = match decode_base64(data) {
            Ok(bytes) => bytes,
            Err(err) => {
                self.reset();
                return Err(err);
            }
        };
        // Mirrors RpcFrameDecoder's transport cap on a single chunk payload.
        if bytes.len() > RPC_CHUNK_PAYLOAD_BYTES {
            self.reset();
            return Err("chunk payload exceeds the transport limit".into());
        }
        if self.pending_chunk_id.is_none() {
            if index != 0 {
                self.reset();
                return Err("chunk sequence must start at index 0".into());
            }
            self.pending_chunk_id = Some(chunk_id.clone());
            self.pending_count = count;
            self.pending_byte_length = byte_length;
            self.pending_next_index = 0;
            self.pending_parts.clear();
            self.pending_received = 0;
        }
        if self.pending_chunk_id.as_deref() != Some(chunk_id.as_str())
            || self.pending_count != count
            || self.pending_byte_length != byte_length
            || self.pending_next_index != index
        {
            self.reset();
            return Err("chunk sequence mismatch".into());
        }
        self.pending_received += bytes.len();
        self.pending_parts.push(bytes);
        self.pending_next_index += 1;
        if self.pending_received > self.pending_byte_length {
            self.reset();
            return Err("chunk exceeds declared length".into());
        }
        if self.pending_next_index < self.pending_count {
            return Ok(None);
        }
        if self.pending_received != self.pending_byte_length {
            self.reset();
            return Err("chunk length mismatch".into());
        }
        self.pending_chunk_id = None;
        let mut bytes_all = Vec::with_capacity(self.pending_received);
        for part in &self.pending_parts {
            bytes_all.extend_from_slice(part);
        }
        self.reset();
        // Strict single decode at reassembly end, matching the TS decoder's
        // TextDecoder(fatal) — lossy per-chunk decoding corrupts multi-byte
        // characters split across chunk boundaries.
        let json = String::from_utf8(bytes_all).map_err(|e| e.to_string())?;
        // Parse to validate, then return the reassembled JSON text.
        JsonValue::parse(&json).map_err(|e| e.to_string())?;
        Ok(Some(json))
    }
}

/// Encode one logical frame into physical lines (v1 single line, v2 chunked).
pub fn encode_rpc_frames(frame_json: &str) -> Result<Vec<String>, String> {
    let single = format!("{frame_json}\n");
    if single.len() <= MAX_RPC_FRAME_BYTES {
        return Ok(vec![single]);
    }
    let bytes = frame_json.as_bytes();
    if bytes.len() > MAX_RPC_REASSEMBLED_BYTES {
        return Err("frame exceeds reassembly limit".into());
    }
    let count = bytes.len().div_ceil(RPC_CHUNK_PAYLOAD_BYTES);
    // Unique per call: two concurrent oversized sends from the same process
    // must not share a chunkId (the receiver would interleave their parts).
    static CHUNK_NONCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let chunk_id = format!(
        "rust-{}-{}",
        std::process::id(),
        CHUNK_NONCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let mut lines = Vec::with_capacity(count);
    for index in 0..count {
        let start = index * RPC_CHUNK_PAYLOAD_BYTES;
        let end = (start + RPC_CHUNK_PAYLOAD_BYTES).min(bytes.len());
        let data = encode_base64(&bytes[start..end]);
        lines.push(format!(
            "{{\"type\":\"rpc_chunk\",\"chunkId\":{},\"index\":{},\"count\":{},\"byteLength\":{},\"data\":{}}}\n",
            crate::ipc_server::json_str(&chunk_id),
            index,
            count,
            bytes.len(),
            crate::ipc_server::json_str(&data)
        ));
    }
    Ok(lines)
}

fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(input.len() * 3 / 4 + 3);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for ch in input.bytes() {
        let value = match ch {
            b'A'..=b'Z' => ch - b'A',
            b'a'..=b'z' => ch - b'a' + 26,
            b'0'..=b'9' => ch - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            _ => return Err("invalid base64".into()),
        };
        acc = (acc << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}

fn encode_base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(triple >> 18) as usize & 63] as char);
        out.push(TABLE[(triple >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(TABLE[(triple >> 6) as usize & 63] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[triple as usize & 63] as char);
        } else {
            out.push('=');
        }
    }
    out
}

#[cfg(all(test, unix))]
mod lifecycle_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::time::{Duration, Instant};

    fn fixture(script: &str) -> (std::path::PathBuf, Arc<Supervisor>) {
        let dir = std::env::temp_dir().join(format!("ompweb-supervisor-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("fake-omp");
        std::fs::write(&bin, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();
        let supervisor = Supervisor::new(bin.to_string_lossy().into_owned(), vec![]);
        (dir, supervisor)
    }

    #[test]
    fn restart_replaces_stdin_and_receives_response() {
        let (dir, s) = fixture("if [ ! -f marker ]; then touch marker; exit 3; fi\nwhile IFS= read -r line; do printf '{\"type\":\"response\"}\\n'; done");
        s.spawn("session", dir.to_str().unwrap(), &[]).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while !s.list().iter().any(|(_, _, restarts)| *restarts == 1) {
            assert!(Instant::now() < deadline, "restart did not complete");
            std::thread::sleep(Duration::from_millis(10));
        }
        let rx = s.subscribe("session").unwrap();
        s.send("session", "{\"type\":\"get_state\"}").unwrap();
        let mut responded = false;
        while let Ok(event) = rx.recv_timeout(Duration::from_millis(500)) {
            if let SessionEvent::Frame { frame: text, .. } = event {
                if text.contains("response") { responded = true; break; }
            }
        }
        s.kill("session").unwrap();
        assert!(responded, "new child must read the next command");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn blocked_stdin_does_not_block_list_or_kill() {
        let (dir, s) = fixture("exec sleep 10");
        s.spawn("session", dir.to_str().unwrap(), &[]).unwrap();
        let writer = s.clone();
        let (tx, rx) = sync_channel(1);
        std::thread::spawn(move || {
            let frame = format!("{{\"message\":\"{}\"}}", "x".repeat(2 * 1024 * 1024));
            let result = writer.send("session", &frame);
            let _ = tx.send(result);
        });
        std::thread::sleep(Duration::from_millis(100));
        let start = Instant::now();
        assert_eq!(s.list().len(), 1);
        s.kill("session").unwrap();
        assert!(start.elapsed() < Duration::from_secs(1));
        assert!(rx.recv_timeout(Duration::from_secs(2)).is_ok());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn stdout_eof_does_not_lock_registry_until_child_exit() {
        let (dir, s) = fixture("exec 1>&-\nexec sleep 10");
        s.spawn("session", dir.to_str().unwrap(), &[]).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        let start = Instant::now();
        assert_eq!(s.list().len(), 1);
        s.kill("session").unwrap();
        assert!(start.elapsed() < Duration::from_secs(1));
        std::fs::remove_dir_all(dir).ok();
    }
}

#[cfg(test)]
mod reassembler_tests {
    use super::*;

    #[test]
    fn oversized_line_is_drained_before_reading_terminal_frame() {
        let input = b"0123456789abcdef\n{\"type\":\"agent_end\"}\n";
        let mut reader = BufReader::with_capacity(4, &input[..]);
        let mut line = Vec::new();
        assert_eq!(read_line_capped(&mut reader, &mut line, 8).unwrap(), None);
        assert!(line.len() <= 8);
        line.clear();
        assert!(read_line_capped(&mut reader, &mut line, 64).unwrap().unwrap() > 0);
        assert_eq!(line, b"{\"type\":\"agent_end\"}\n");
    }

    #[test]
    fn unchunked_frame_larger_than_wire_chunk_is_read() {
        let frame = format!("{{\"type\":\"agent_end\",\"data\":\"{}\"}}\n", "x".repeat(MAX_RPC_FRAME_BYTES));
        let mut reader = BufReader::with_capacity(4096, frame.as_bytes());
        let mut line = Vec::new();
        let size = read_line_capped(&mut reader, &mut line, MAX_RPC_REASSEMBLED_BYTES).unwrap();
        assert_eq!(size, Some(frame.len()));
        assert_eq!(line, frame.as_bytes());
    }

    fn chunk_line(id: &str, index: usize, count: usize, byte_length: usize, data: &str) -> String {
        format!(
            "{{\"type\":\"rpc_chunk\",\"chunkId\":{},\"index\":{},\"count\":{},\"byteLength\":{},\"data\":{}}}",
            crate::ipc_server::json_str(id),
            index,
            count,
            byte_length,
            crate::ipc_server::json_str(data)
        )
    }

    #[test]
    fn numeric_chunk_metadata_reassembles() {
        // JS JSON.stringify emits numbers; as_str() would reject these.
        let frame = r#"{"m":"abcd"}"#;
        let mut decoder = FrameReassembler::new();
        let bytes = frame.as_bytes();
        let half = bytes.len() / 2;
        let data0 = encode_base64(&bytes[..half]);
        let data1 = encode_base64(&bytes[half..]);
        assert!(decoder
            .push_line(&chunk_line("n1", 0, 2, bytes.len(), &data0))
            .unwrap()
            .is_none());
        let done = decoder
            .push_line(&chunk_line("n1", 1, 2, bytes.len(), &data1))
            .unwrap()
            .expect("numeric metadata must reassemble");
        assert_eq!(done, frame);
    }

    #[test]
    fn malformed_chunk_does_not_poison_later_frames() {
        let mut decoder = FrameReassembler::new();
        // Invalid metadata (index >= count) arms nothing but must not wedge
        // the decoder.
        assert!(decoder.push_line(&chunk_line("bad", 5, 2, 9, "AAAA")).is_err());
        // A subsequent valid single frame flows through untouched.
        let frame = r#"{"type":"response"}"#;
        assert_eq!(decoder.push_line(frame).unwrap().as_deref(), Some(frame));
    }

    #[test]
    fn interrupted_chunk_sequence_resets_and_delivers_next_frame() {
        let mut decoder = FrameReassembler::new();
        // Start a pending sequence whose first chunk is valid, then interrupt
        // it with a normal frame before the rest arrives. Chunks must respect
        // the 256 KiB per-chunk payload cap, so use a small sequence.
        let big = "z".repeat(512 * 1024);
        let bytes = big.as_bytes();
        let half = bytes.len() / 2;
        decoder
            .push_line(&chunk_line("gone", 0, 2, bytes.len(), &encode_base64(&bytes[..half])))
            .unwrap();
        // A normal frame arrives mid-sequence: it must be DELIVERED (not
        // discarded) even though the pending chunk sequence is aborted.
        let control = r#"{"type":"agent_end"}"#;
        assert_eq!(
            decoder.push_line(control).unwrap().as_deref(),
            Some(control),
            "normal frame after interrupted chunks must not be dropped"
        );
        // And the decoder is usable for a fresh chunk sequence afterwards.
        let frame = r#"{"m":"ok"}"#;
        let fb = frame.as_bytes();
        decoder
            .push_line(&chunk_line("next", 0, 2, fb.len(), &encode_base64(&fb[..fb.len() / 2])))
            .unwrap();
        let done = decoder
            .push_line(&chunk_line("next", 1, 2, fb.len(), &encode_base64(&fb[fb.len() / 2..])))
            .unwrap()
            .expect("fresh sequence after reset must reassemble");
        assert_eq!(done, frame);
    }

    #[test]
    fn mismatched_chunk_resets_and_recovers() {
        let mut decoder = FrameReassembler::new();
        decoder
            .push_line(&chunk_line("a", 0, 2, 4, &encode_base64(b"ab")))
            .unwrap();
        // Wrong chunkId for index 1.
        assert!(decoder
            .push_line(&chunk_line("b", 1, 2, 4, &encode_base64(b"cd")))
            .is_err());
        // Next frames are unaffected.
        let frame = r#"{"k":true}"#;
        assert_eq!(decoder.push_line(frame).unwrap().as_deref(), Some(frame));
    }

    #[test]
    fn chunk_payload_over_transport_cap_rejected() {
        let mut decoder = FrameReassembler::new();
        let oversized = encode_base64(&vec![b'q'; RPC_CHUNK_PAYLOAD_BYTES + 1]);
        assert!(decoder
            .push_line(&chunk_line("big", 0, 2, 1024, &oversized))
            .is_err());
        let frame = r#"{"after":1}"#;
        assert_eq!(decoder.push_line(frame).unwrap().as_deref(), Some(frame));
    }

    #[test]
    fn utf8_split_across_chunk_boundary_survives() {
        // "你好" is 6 bytes; split inside the first character's 3-byte
        // sequence — strict whole-frame decoding must still succeed.
        let frame = "{\"text\":\"你好\"}";
        let bytes = frame.as_bytes();
        let mut decoder = FrameReassembler::new();
        decoder
            .push_line(&chunk_line("u8", 0, 2, bytes.len(), &encode_base64(&bytes[..4])))
            .unwrap();
        let done = decoder
            .push_line(&chunk_line("u8", 1, 2, bytes.len(), &encode_base64(&bytes[4..])))
            .unwrap()
            .expect("CJK split across chunks must reassemble");
        assert_eq!(done, frame);
    }

    #[test]
    fn invalid_utf8_reassembly_rejected_not_lossy() {
        let mut decoder = FrameReassembler::new();
        let bad = [0xFF, 0xFE];
        decoder
            .push_line(&chunk_line("bad", 0, 2, 2, &encode_base64(&bad[..1])))
            .unwrap();
        assert!(decoder
            .push_line(&chunk_line("bad", 1, 2, 2, &encode_base64(&bad[1..])))
            .is_err());
    }

    #[test]
    fn oversized_logical_frame_chunks_with_unique_ids() {
        let big = format!("{{\"blob\":\"{}\"}}", "w".repeat(MAX_RPC_FRAME_BYTES + 42));
        let lines = encode_rpc_frames(&big).expect("v2 encode must chunk oversized frames");
        assert!(lines.len() > 1, "must be split into chunks");
        for (i, line) in lines.iter().enumerate() {
            assert!(line.len() <= MAX_RPC_FRAME_BYTES, "physical line cap");
            let value = JsonValue::parse(line.trim()).unwrap();
            assert_eq!(value.get(&["index"]), Some(&JsonValue::Num(i as f64)));
            assert_eq!(
                value.get(&["count"]),
                Some(&JsonValue::Num(lines.len() as f64))
            );
            // Every chunk shares one id within a frame, unique across frames.
            let id = value.get(&["chunkId"]).unwrap().as_str().unwrap();
            assert!(id.starts_with("rust-"));
        }
        // A second encode produces a different chunkId (no cross-frame collision).
        let lines2 = encode_rpc_frames(&big).unwrap();
        let id1 = JsonValue::parse(lines[0].trim())
            .unwrap()
            .get(&["chunkId"])
            .unwrap()
            .as_str()
            .unwrap()
            .to_string();
        let id2 = JsonValue::parse(lines2[0].trim())
            .unwrap()
            .get(&["chunkId"])
            .unwrap()
            .as_str()
            .unwrap()
            .to_string();
        assert_ne!(id1, id2, "concurrent sends must not share a chunkId");
    }
}
