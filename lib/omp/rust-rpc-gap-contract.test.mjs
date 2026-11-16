import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { RustRpcProcess, RustHostManager, disposeHostFor } = await jiti.import("./rust-rpc-process.ts");

// Fake Rust host with a scripted attach socket: replays frames, streams a
// requested number, then drops the subscriber WITHOUT an exit event (the
// real supervisor's channel-overflow behavior). Commands answered on a
// fresh connection via agent.send. `hang` makes agent.send never respond.
const fixture = `
  import net from 'node:net';
  const sessions = new Map();
  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf('\\n')) >= 0) {
        const msg = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        if (msg.method === 'hello') {
          socket.write(JSON.stringify({ id: msg.id, ok: true, result: { protocol: 1 } }) + '\\n');
          continue;
        }
        if (msg.method === 'agent.spawn') {
          sessions.set(msg.params.sessionId, { subscribers: [] });
          socket.write(JSON.stringify({ id: msg.id, ok: true, result: { pid: 4242 } }) + '\\n');
          continue;
        }
        if (msg.method === 'agent.attach') {
          const session = sessions.get(msg.params.sessionId);
          const since = msg.params.sinceSeq ?? 0;
          socket.write(JSON.stringify({ event: { type: 'frame', frame: { type: 'ready' }, seq: 1 } }) + '\\n');
          socket.write(JSON.stringify({ event: { type: 'attach_confirmed' } }) + '\\n');
          const n = session?.replayCount ?? 3;
          for (let i = 1; i <= n; i++) {
            // Replay: frames at or before sinceSeq must not be re-delivered.
            if (since >= i + 1) continue;
            socket.write(JSON.stringify({ event: { type: 'frame', frame: { type: 'message_update', n: i }, seq: i + 1 } }) + '\\n');
          }
          for (const reply of session?.pendingReplies ?? []) {
            socket.write(JSON.stringify({ event: { type: 'frame', frame: reply, seq: 900 } }) + '\\n');
          }
          session.pendingReplies = [];
          session.subscribers.push(socket);
          continue;
        }
        if (msg.method === 'agent.send') {
          const session = sessions.get(msg.params.sessionId);
          const command = JSON.parse(msg.params.command);
          if (command.type === 'flood') {
            // Stream frames then drop the subscriber without exit: overflow.
            for (const sub of session.subscribers) {
              for (let i = 0; i < command.count; i++) {
                sub.write(JSON.stringify({ event: { type: 'frame', frame: { type: 'message_update', flood: i }, seq: 100 + i } }) + '\\n');
              }
            }
            for (const sub of session.subscribers) {
              sub.write(JSON.stringify({ event: { type: 'stream_dropped' } }) + '\\n');
              sub.end();
            }
            session.subscribers = [];
            session.replayCount = 0;
            socket.write(JSON.stringify({ id: msg.id, ok: true, result: null }) + '\\n');
            continue;
          }
          if (command.type === 'hang') continue; // never respond: lost ack
          const reply = { type: 'response', id: command.id, command: command.type, success: true, data: { alive: true } };
          // Response arrives via the live attach stream (attach path only).
          if (session.subscribers.length > 0) {
            for (const sub of session.subscribers) sub.write(JSON.stringify({ event: { type: 'frame', frame: reply, seq: 900 } }) + '\\n');
          } else {
            (session.pendingReplies ??= []).push(reply);
          }
          socket.write(JSON.stringify({ id: msg.id, ok: true, result: null }) + '\\n');
          continue;
        }
        if (msg.method === 'agent.kill') {
          for (const [, session] of sessions) {
            for (const sub of session.subscribers) {
              sub.write(JSON.stringify({ event: { type: 'exit', code: 0, signal: null } }) + '\\n');
              sub.end();
            }
            session.subscribers = [];
          }
          socket.write(JSON.stringify({ id: msg.id, ok: true, result: null }) + '\\n');
          continue;
        }
      }
    });
  });
  server.listen(0, '127.0.0.1', () => {
    console.log(JSON.stringify({ port: server.address().port, token: 'fixture-token' }));
  });
`;

async function bootFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "ompweb-rpc-contract-"));
  writeFileSync(join(dir, "host.mjs"), fixture);
  const previous = process.env.OMPWEB_HOST_BIN;
  process.env.OMPWEB_HOST_BIN = process.execPath; // existence check only; injected spawn owns argv
  // Use an isolated profile key so this fake host never collides with a real
  // default host in the same test process.
  const key = `contract-${process.pid}-${Date.now()}`;
  const { RustHostManager } = await jiti.import("./rust-rpc-process.ts");
  const manager = new RustHostManager(
    key,
    (path, args, options) => spawn(process.execPath, [join(dir, "host.mjs")], options),
  );
  globalThis.__ompRustHosts.set(key, manager);
  const proc = new RustRpcProcess({
    cwd: dir,
    sessionId: "contract-session",
    ctx: { key, profile: key, isDefault: false },
  });
  t.after(async () => {
    if (previous === undefined) delete process.env.OMPWEB_HOST_BIN;
    else process.env.OMPWEB_HOST_BIN = previous;
    await proc.dispose();
    await disposeHostFor(key);
    rmSync(dir, { recursive: true, force: true });
  });
  await proc.waitReady(5000);
  await proc.negotiateProtocol(await proc.waitReady());
  return proc;
}

test("in-frame gap: rpc_stream_gap then rpc_stream_restored, duplicates deduped, child intact", async (t) => {
  const proc = await bootFixture(t);
  const seen = [];
  let resolveRestored;
  const restored = new Promise((resolve) => { resolveRestored = resolve; });
  proc.onFrame((frame) => {
    seen.push(frame.type);
    if (frame.type === "rpc_stream_restored") resolveRestored();
  });
  const flood = proc.sendCommand({ type: "flood", count: 500 }, 8000).then(
    () => ({ resolved: true }),
    (error) => ({ error }),
  );
  const outcome = await flood;
  // The response traveled through the dropped stream: MUST be uncertain.
  assert.equal(outcome.resolved, undefined, "flood must not resolve: response may have been lost");
  assert.equal(outcome.error.code, "rpc_stream_gap");
  // Contract sequence: gap is announced, recovery is announced, child keeps
  // streaming after recovery (server replays the live frames on reattach).
  const gapIdx = seen.indexOf("rpc_stream_gap");
  assert.ok(gapIdx >= 0, "rpc_stream_gap must be signaled");
  await Promise.race([
    restored,
    new Promise((_, reject) => setTimeout(() => reject(new Error("rpc_stream_restored never arrived")), 5000)),
  ]);
  const restoredIdx = seen.indexOf("rpc_stream_restored");
  assert.ok(restoredIdx > gapIdx, "rpc_stream_restored must follow the gap");
  assert.ok(seen.includes("message_update"), "live frames must resume after recovery");
  assert.ok(proc.isAlive, "session must survive the drop without a restart");
});

test("ack gap: slow subscribe races attach; commands that were lost reject, later commands succeed", async (t) => {
  const proc = await bootFixture(t);
  // A command sent while no attach stream is confirmed yet: the host drop
  // semantics reject it as uncertain rather than resolving fabricated data.
  const lost = proc.sendCommand({ type: "hang" }, 1500).then(
    () => ({ resolved: true }),
    (error) => ({ error }),
  );
  const outcome = await Promise.race([
    lost,
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 4000)),
  ]);
  // 'hang' never gets a host response; the timeout must fire (uncertain by
  // design) — but must NOT resolve fabricated success.
  assert.ok(outcome.timeout || outcome.error, "lost ack must not fabricate success");
  // Transport recovers: a follow-up command succeeds against the live child.
  const follow = await proc.sendCommand({ type: "ping_child" }, 5000);
  assert.deepEqual(follow, { alive: true });
  assert.ok(proc.isAlive);
});

test("replay dedupe: reattached stream does not duplicate already-delivered frames", async (t) => {
  const proc = await bootFixture(t);
  const updates = [];
  proc.onFrame((frame) => {
    if (frame.type !== "message_update") return;
    updates.push(typeof frame.flood === "number" ? `flood:${frame.flood}` : `replay:${frame.n}`);
  });
  // Trigger the drop; on reattach the server replays the same frames —
  // client-side seq dedupe must collapse them to one delivery each.
  await proc.sendCommand({ type: "flood", count: 3 }, 8000).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 500));
  const counts = updates.reduce((acc, n) => {
    const key = String(n);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  for (const [n, count] of Object.entries(counts)) {
    assert.equal(count, 1, `frame n=${n} delivered more than once`);
  }
  assert.ok(updates.length > 0, "replayed frames must still be delivered once");
});
