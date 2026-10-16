import assert from "node:assert/strict";
import test from "node:test";
import { findCliSessionLock, listCliLockedSessions, invalidateCliLockCache } from "./session-cli-lock.ts";

test("findCliSessionLock returns null for empty or non-existent session ID", async () => {
  invalidateCliLockCache();
  assert.equal(await findCliSessionLock(""), null);
  assert.equal(await findCliSessionLock("00000000-0000-0000-0000-000000000000"), null);
});

test("listCliLockedSessions caches results for repeated calls", async () => {
  invalidateCliLockCache();
  const m1 = await listCliLockedSessions();
  const m2 = await listCliLockedSessions();
  assert.equal(m1, m2);
});
