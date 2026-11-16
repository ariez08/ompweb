import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET } = await jiti.import("../app/api/agent/[id]/events/route.ts");

async function openStream() {
  let listener;
  let unsubscribed = false;
  const id = `sse-test-${Math.random()}`;
  const registry = globalThis.__ompSessions ??= new Map();
  registry.set(id, {
    isAlive: () => true,
    onEvent(callback) {
      listener = callback;
      return () => { unsubscribed = true; };
    },
  });
  const response = await GET(new Request(`http://localhost/api/agent/${id}/events`), { params: Promise.resolve({ id }) });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  return {
    emit: (event) => listener(event),
    read: async () => {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      return JSON.parse(new TextDecoder().decode(value).trim().slice(5));
    },
    close: async () => {
      await reader.cancel();
      registry.delete(id);
      assert.equal(unsubscribed, true);
    },
  };
}

test("slow SSE consumer receives latest of 20000 updates when it resumes", { timeout: 5000 }, async () => {
  const stream = await openStream();
  try {
    for (let seq = 0; seq < 20000; seq++) stream.emit({ type: "message_update", seq });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await stream.read()).type, "connected");
    assert.deepEqual(await stream.read(), { type: "message_update", seq: 19999 });
    stream.emit({ type: "agent_end", isTerminal: true });
    assert.deepEqual(await stream.read(), { type: "agent_end", isTerminal: true });
  } finally {
    await stream.close();
  }
});

test("SSE delivers the latest pending update before the terminal frame", { timeout: 5000 }, async () => {
  const stream = await openStream();
  try {
    stream.emit({ type: "message_update", seq: 1 });
    stream.emit({ type: "message_update", seq: 2 });
    stream.emit({ type: "agent_end", isTerminal: true });
    assert.equal((await stream.read()).type, "connected");
    assert.deepEqual(await stream.read(), { type: "message_update", seq: 2 });
    assert.deepEqual(await stream.read(), { type: "agent_end", isTerminal: true });
  } finally {
    await stream.close();
  }
});
