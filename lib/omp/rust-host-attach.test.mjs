import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { RustHostManager } = await jiti.import("./rust-rpc-process.ts");

// Fake ompweb-host: control socket answers hello/ping; an attach connection
// gets a replayed frame, then a streamed frame whose JSON line contains a
// multi-byte UTF-8 character deliberately split across two TCP writes —
// `buffer += chunk.toString()` would corrupt it; StringDecoder must not.
test("attach decodes UTF-8 split across TCP segments; replay then live frames, no duplication", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ompweb-host-attach-"));
  const fixture = join(dir, "host.mjs");
  writeFileSync(fixture, `
    import net from 'node:net';
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
          if (msg.method !== 'agent.attach') continue;
          // 1) replayed frame first (bounded ring semantics)
          socket.write(JSON.stringify({ event: { type: 'frame', frame: { type: 'ready' } } }) + '\\n');
          // 2) live frame with a multi-byte char, split mid-sequence
          const payload = JSON.stringify({ event: { type: 'frame', frame: { type: 'tool_update', text: '\\u4f60\\u597d' } } });
          const bytes = Buffer.from(payload + '\\n', 'utf8');
          const split = payload.length - 2; // inside the last 3-byte char
          socket.write(bytes.subarray(0, split));
          setTimeout(() => socket.write(bytes.subarray(split)), 20);
          // 3) terminal event closes the attach socket
          setTimeout(() => socket.write(JSON.stringify({ event: { type: 'exit', code: null, signal: null } }) + '\\n'), 60);
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      console.log(JSON.stringify({ port: server.address().port, token: 'fixture-token' }));
    });
  `);
  const previous = process.env.OMPWEB_HOST_BIN;
  process.env.OMPWEB_HOST_BIN = process.execPath; // existence check only; injected spawn owns argv
  const manager = new RustHostManager((_bin, _args, options) => spawn(process.execPath, [fixture], options));
  t.after(async () => {
    await manager.shutdown();
    if (previous === undefined) delete process.env.OMPWEB_HOST_BIN;
    else process.env.OMPWEB_HOST_BIN = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  const frames = [];
  const { closed } = await manager.attach("session-a", (frame) => frames.push(frame));
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("attach did not close")), 3000))]);
  assert.deepEqual(frames, [
    { type: "ready" },
    { type: "tool_update", text: "你好" }, // must be intact, not mojibake
  ]);
});
