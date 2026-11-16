import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  readSessionRecency,
  recordSessionInteraction,
  recentInteractionAt,
  sortSessionsByRecentInteraction,
  writeSessionRecency,
  createStableOrderSnapshot,
  applyStableOrder,
  pruneStableOrder,
} = await jiti.import("./recent-sessions.ts");

function session(id, modified, overrides = {}) {
  return {
    path: `/sessions/${id}.jsonl`,
    id,
    cwd: `/work/${id}`,
    created: "2026-01-01T00:00:00.000Z",
    modified,
    messageCount: 1,
    firstMessage: id,
    ...overrides,
  };
}

function storage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

test("orders sessions by newest file activity", () => {
  const sessions = [
    session("old", "2026-01-01T00:00:00.000Z"),
    session("new", "2026-03-01T00:00:00.000Z"),
    session("mid", "2026-02-01T00:00:00.000Z"),
  ];
  const sorted = sortSessionsByRecentInteraction(sessions, new Map()).map((s) => s.id);
  assert.deepEqual(sorted, ["new", "mid", "old"]);
});

test("a locally visited session outranks a newer file it never touched", () => {
  const sessions = [
    session("newer-file", "2026-03-01T00:00:00.000Z"),
    session("just-read", "2026-01-01T00:00:00.000Z"),
  ];
  const recency = new Map([["just-read", Date.parse("2026-04-01T00:00:00.000Z")]]);
  const sorted = sortSessionsByRecentInteraction(sessions, recency).map((s) => s.id);
  assert.deepEqual(sorted, ["just-read", "newer-file"]);
});

test("file activity wins when it is later than the recorded visit", () => {
  const sessions = [session("a", "2026-05-01T00:00:00.000Z")];
  const recency = new Map([["a", Date.parse("2026-01-01T00:00:00.000Z")]]);
  assert.equal(
    recentInteractionAt(sessions[0], recency),
    Date.parse("2026-05-01T00:00:00.000Z"),
  );
});

test("unparsable timestamps do not poison the order", () => {
  const sessions = [session("broken", "not-a-date"), session("good", "2026-01-01T00:00:00.000Z")];
  const sorted = sortSessionsByRecentInteraction(sessions, new Map()).map((s) => s.id);
  assert.deepEqual(sorted, ["good", "broken"]);
});

test("ties fall back to a deterministic id order", () => {
  const stamp = "2026-01-01T00:00:00.000Z";
  const sorted = sortSessionsByRecentInteraction([session("b", stamp), session("a", stamp)], new Map()).map((s) => s.id);
  assert.deepEqual(sorted, ["b", "a"]);
});

test("interaction records round-trip through storage", () => {
  const store = storage();
  const recency = recordSessionInteraction(new Map(), "s1", 1000);
  writeSessionRecency(recency, store);
  assert.deepEqual([...readSessionRecency(store)], [["s1", 1000]]);
});

test("recording keeps storage bounded and drops the oldest entries", () => {
  const store = storage();
  let recency = new Map();
  for (let i = 0; i < 260; i++) recency = recordSessionInteraction(recency, `s${i}`, 1000 + i);
  writeSessionRecency(recency, store);
  const loaded = readSessionRecency(store);
  assert.equal(loaded.size, 200);
  assert.equal(loaded.has("s0"), false);
  assert.equal(loaded.has("s259"), true);
});

test("clearing every entry removes the storage key", () => {
  const store = storage({ "omp-web:session-recency": '{"s1":5}' });
  writeSessionRecency(new Map(), store);
  assert.equal(store.getItem("omp-web:session-recency"), null);
});

test("corrupt or foreign storage shapes degrade to empty", () => {
  assert.equal(readSessionRecency(storage({ "omp-web:session-recency": "nope" })).size, 0);
  assert.equal(readSessionRecency(storage({ "omp-web:session-recency": '["a"]' })).size, 0);
  assert.equal(readSessionRecency(storage({ "omp-web:session-recency": '{"a":"x"}' })).size, 0);
});

test("stable order seeds from recency on first pass", () => {
  const snapshot = createStableOrderSnapshot();
  const sessions = [
    session("old", "2026-01-01T00:00:00.000Z"),
    session("new", "2026-03-01T00:00:00.000Z"),
    session("mid", "2026-02-01T00:00:00.000Z"),
  ];
  const sorted = applyStableOrder(sessions, new Map(), snapshot).map((s) => s.id);
  assert.deepEqual(sorted, ["new", "mid", "old"]);
});

test("stable order does NOT reshuffle when an old session's mtime bumps", () => {
  const snapshot = createStableOrderSnapshot();
  const first = [
    session("a", "2026-03-01T00:00:00.000Z"),
    session("b", "2026-02-01T00:00:00.000Z"),
    session("c", "2026-01-01T00:00:00.000Z"),
  ];
  const initial = applyStableOrder(first, new Map(), snapshot).map((s) => s.id);
  assert.deepEqual(initial, ["a", "b", "c"]);

  // "c" just got fresh activity (its file mtime jumps to the newest). Without
  // the stable snapshot it would leap to the top; with it, the order holds.
  const second = [
    session("a", "2026-03-01T00:00:00.000Z"),
    session("b", "2026-02-01T00:00:00.000Z"),
    session("c", "2026-09-01T00:00:00.000Z"),
  ];
  const held = applyStableOrder(second, new Map(), snapshot).map((s) => s.id);
  assert.deepEqual(held, ["a", "b", "c"]);
});

test("a brand-new session appears at the top exactly once, then stays put", () => {
  const snapshot = createStableOrderSnapshot();
  const first = [
    session("a", "2026-03-01T00:00:00.000Z"),
    session("b", "2026-02-01T00:00:00.000Z"),
  ];
  applyStableOrder(first, new Map(), snapshot);

  // A new session shows up — it must land at the very top the first time.
  const second = [
    session("a", "2026-03-01T00:00:00.000Z"),
    session("b", "2026-02-01T00:00:00.000Z"),
    session("fresh", "2026-01-01T00:00:00.000Z"),
  ];
  const withNew = applyStableOrder(second, new Map(), snapshot).map((s) => s.id);
  assert.deepEqual(withNew, ["fresh", "a", "b"]);

  // Even after "a" gets activity, nothing re-orders on later refreshes.
  const third = [
    session("a", "2026-12-01T00:00:00.000Z"),
    session("b", "2026-02-01T00:00:00.000Z"),
    session("fresh", "2026-01-01T00:00:00.000Z"),
  ];
  const stillHeld = applyStableOrder(third, new Map(), snapshot).map((s) => s.id);
  assert.deepEqual(stillHeld, ["fresh", "a", "b"]);
});

test("pruneStableOrder drops ranks for sessions that disappear", () => {
  const snapshot = createStableOrderSnapshot();
  applyStableOrder([session("a", "2026-03-01T00:00:00.000Z"), session("b", "2026-02-01T00:00:00.000Z")], new Map(), snapshot);
  assert.equal(snapshot.ranks.size, 2);
  pruneStableOrder(snapshot, [session("a", "2026-03-01T00:00:00.000Z")]);
  assert.equal(snapshot.ranks.size, 1);
  assert.equal(snapshot.ranks.has("b"), false);
});

test("filtering to a subset keeps the hidden sessions' frozen slots", () => {
  const snapshot = createStableOrderSnapshot();
  const all = [
    session("a", "2026-03-01T00:00:00.000Z"),
    session("b", "2026-02-01T00:00:00.000Z"),
    session("c", "2026-01-01T00:00:00.000Z"),
  ];
  assert.deepEqual(applyStableOrder(all, new Map(), snapshot).map((s) => s.id), ["a", "b", "c"]);

  // A search narrows the list to one row; the other ranks must survive.
  assert.deepEqual(applyStableOrder([all[1]], new Map(), snapshot).map((s) => s.id), ["b"]);
  assert.equal(snapshot.ranks.size, 3);

  // Clearing the filter restores the original order instead of re-ranking.
  assert.deepEqual(applyStableOrder(all, new Map(), snapshot).map((s) => s.id), ["a", "b", "c"]);
});

test("a fresh snapshot (page reload) re-derives the order from current activity", () => {
  // Simulate the first page load freezing an order...
  const first = createStableOrderSnapshot();
  applyStableOrder([
    session("a", "2026-01-01T00:00:00.000Z"),
    session("b", "2026-02-01T00:00:00.000Z"),
  ], new Map(), first);

  // ...then a reload with new snapshot: order reflects current mtimes again.
  const reloaded = createStableOrderSnapshot();
  const sorted = applyStableOrder([
    session("a", "2026-05-01T00:00:00.000Z"),
    session("b", "2026-02-01T00:00:00.000Z"),
  ], new Map(), reloaded).map((s) => s.id);
  assert.deepEqual(sorted, ["a", "b"]);
});
