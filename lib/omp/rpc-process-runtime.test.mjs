import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { RpcProcess } = jiti("./rpc-process.ts");
const { encodeRpcFrames } = jiti("./rpc-frame.ts");

function makeTransport() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 4321,
    kill() {
      queueMicrotask(() => child.emit("exit", 0, null));
      return true;
    },
  });
  const commands = [];
  const spawnCalls = [];
  let partial = "";
  let onCommand = () => {};
  stdin.on("data", (chunk) => {
    partial += chunk.toString("utf8");
    const lines = partial.split("\n");
    partial = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      const command = JSON.parse(line);
      commands.push(command);
      onCommand(command);
    }
  });
  stdin.on("end", () => queueMicrotask(() => child.emit("exit", 0, null)));
  queueMicrotask(() => {
    stdout.write(`${JSON.stringify({ type: "ready", supportedProtocolVersions: [1, 2] })}\n`);
  });

  return {
    commands,
    spawnCalls,
    child,
    set onCommand(callback) { onCommand = callback; },
    send(frame) { stdout.write(`${JSON.stringify(frame)}\n`); },
    sendFrames(frames) { for (const frame of frames) stdout.write(frame); },
    spawn(...args) { spawnCalls.push(args); return child; },
  };
}

function startProcess(transport) {
  return new RpcProcess({
    cwd: process.cwd(),
    dependencies: {
      resolveOmpBin: () => "fake-omp",
      spawn: transport.spawn,
    },
  });
}

test("RpcProcess negotiates v2 and correlates out-of-order command responses", async () => {
  const transport = makeTransport();
  transport.onCommand = (command) => {
    if (command.type === "negotiate_protocol") {
      transport.send({ type: "response", id: command.id, command: command.type, success: true, data: { protocolVersion: 2 } });
    }
  };
  const proc = startProcess(transport);
  const ready = await proc.waitReady();
  assert.equal(await proc.negotiateProtocol(ready), 2);

  const first = proc.sendCommand({ type: "first" });
  const second = proc.sendCommand({ type: "second" });
  // Writes are serialized through a FIFO queue (physical v2 chunk sequences
  // must not interleave), so the commands land asynchronously.
  while (transport.commands.length < 2) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const [firstCommand, secondCommand] = transport.commands.slice(-2);
  transport.send({ type: "response", id: secondCommand.id, command: "second", success: true, data: "second" });
  transport.send({ type: "response", id: firstCommand.id, command: "first", success: true, data: "first" });

  assert.equal(await first, "first");
  assert.equal(await second, "second");
  await proc.dispose(0);
});

test("RpcProcess does not create a separate Windows console", async () => {
  const transport = makeTransport();
  const proc = startProcess(transport);
  assert.equal(transport.spawnCalls[0][2].windowsHide, true);
  if (process.platform === "win32") assert.equal(transport.spawnCalls[0][2].detached, false);
  await proc.dispose(0);
});

test("RpcProcess reassembles v2 events and rejects pending commands when the child crashes", async () => {
  const transport = makeTransport();
  transport.onCommand = (command) => {
    if (command.type === "negotiate_protocol") {
      transport.send({ type: "response", id: command.id, command: command.type, success: true, data: { protocolVersion: 2 } });
    }
  };
  const proc = startProcess(transport);
  const ready = await proc.waitReady();
  await proc.negotiateProtocol(ready);

  const frames = [];
  proc.onFrame((frame) => frames.push(frame));
  const expected = { type: "message_update", content: "x".repeat(1024 * 1024) };
  transport.sendFrames(encodeRpcFrames(expected, 2, "event-1"));
  assert.deepEqual(frames, [expected]);

  const pending = proc.sendCommand({ type: "never_returns" });
  transport.child.emit("exit", 7, null);
  await assert.rejects(pending, /omp exited/);
});

test("steer and abort responses remain correlated during a tool-event burst", async () => {
  const transport = makeTransport();
  transport.onCommand = (command) => {
    const data = command.type === "negotiate_protocol" ? { protocolVersion: 2 } : { accepted: true };
    transport.send({ type: "response", id: command.id, command: command.type, success: true, data });
  };
  const proc = startProcess(transport);
  try {
    await proc.negotiateProtocol(await proc.waitReady());
    const events = [];
    proc.onFrame((event) => events.push(event));
    for (let i = 0; i < 500; i++) {
      transport.send({ type: "tool_execution_start", toolCallId: `call-${i}` });
      transport.send({ type: "tool_execution_end", toolCallId: `call-${i}` });
    }
    const [steer, abort] = await Promise.all([
      proc.sendCommand({ type: "steer", message: "stop changing files" }, 3000),
      proc.sendCommand({ type: "abort" }, 3000),
    ]);
    transport.send({ type: "agent_end", isTerminal: true });
    assert.deepEqual(steer, { accepted: true });
    assert.deepEqual(abort, { accepted: true });
    assert.equal(events.filter((event) => event.type === "tool_execution_end").length, 500);
    assert.equal(events.at(-1)?.type, "agent_end");
  } finally {
    await proc.dispose(0);
  }
});
