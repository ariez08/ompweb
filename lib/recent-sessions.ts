import type { SessionInfo } from "./types";

/** Locally recorded chat interactions, so the flat session list can order by
 *  "what I was just working on" rather than only by file mtime. Opening a
 *  session is an interaction, but it does not rewrite the session file, so
 *  mtime alone leaves a session you just read sitting in its old position. */

const STORAGE_KEY = "omp-web:session-recency";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Bounded so the map cannot grow forever across archived sessions. */
const MAX_ENTRIES = 200;

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Session id → epoch ms of the last local interaction. */
export function readSessionRecency(storage: StorageLike | null = browserStorage()): Map<string, number> {
  const result = new Map<string, number>();
  if (!storage) return result;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return result;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return result;
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) result.set(id, value);
    }
    return result;
  } catch {
    return result;
  }
}

export function writeSessionRecency(entries: Map<string, number>, storage: StorageLike | null = browserStorage()): void {
  if (!storage) return;
  try {
    if (entries.size === 0) {
      storage.removeItem(STORAGE_KEY);
      return;
    }
    const kept = [...entries.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_ENTRIES);
    storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Recency ordering is a convenience; never break the sidebar over storage.
  }
}

/** Record an interaction and return the updated map (new object). */
export function recordSessionInteraction(
  entries: Map<string, number>,
  sessionId: string,
  now: number = Date.now(),
): Map<string, number> {
  const next = new Map(entries);
  next.set(sessionId, now);
  return next;
}

function modifiedMs(session: SessionInfo): number {
  const parsed = Date.parse(session.modified);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Most recent interaction first. "Interaction" = file activity (new messages,
 *  renames) or a local visit recorded by the web UI, whichever is later. */
export function recentInteractionAt(session: SessionInfo, recency: Map<string, number>): number {
  return Math.max(modifiedMs(session), recency.get(session.id) ?? 0);
}

export function sortSessionsByRecentInteraction(
  sessions: SessionInfo[],
  recency: Map<string, number>,
): SessionInfo[] {
  return [...sessions].sort((a, b) => {
    const delta = recentInteractionAt(b, recency) - recentInteractionAt(a, recency);
    if (delta !== 0) return delta;
    return b.id.localeCompare(a.id);
  });
}

/** Mutable snapshot that pins each session id to a stable sort rank for the
 *  lifetime of a page load. Higher rank sorts earlier (newer/top). */
export interface StableOrderSnapshot {
  /** session id → frozen rank (bigger = closer to the top). */
  ranks: Map<string, number>;
  /** Monotonic counter handing out ever-larger ranks, so a session that
   *  appears mid-session lands ABOVE everything already frozen (at the top)
   *  exactly once and then stays put. */
  nextNewRank: number;
}

export function createStableOrderSnapshot(): StableOrderSnapshot {
  return { ranks: new Map(), nextNewRank: 1 };
}

/**
 * Order sessions so their relative position stays PERSISTENT across live
 * refreshes. The first time a session id is seen it is assigned a frozen rank;
 * every later refresh reuses that frozen rank, so a session whose file mtime
 * bumps from ongoing activity no longer jumps around in the list. A session
 * that appears after the first pass is treated as brand-new and surfaces at
 * the TOP once, then freezes there. The order only resets when the snapshot is
 * recreated — i.e. on a full page reload.
 *
 * Safe to call with a FILTERED subset (search hits, running-only): ranks of
 * the sessions left out are kept, so clearing the filter restores their old
 * slots instead of re-ranking them as newcomers. Prune with
 * `pruneStableOrder` using the full set instead.
 *
 * Pure: mutates only the passed-in `snapshot` (the caller owns its lifetime)
 * and returns a new sorted array; never touches the input `sessions` array.
 */
export function applyStableOrder(
  sessions: SessionInfo[],
  recency: Map<string, number>,
  snapshot: StableOrderSnapshot,
): SessionInfo[] {
  const unranked = sessions.filter((s) => !snapshot.ranks.has(s.id));
  if (unranked.length > 0) {
    // Newest-first among the not-yet-ranked sessions, so a batch appearing at
    // once keeps a sensible internal order before being frozen.
    const ordered = sortSessionsByRecentInteraction(unranked, recency);
    // Freeze them in ascending rank from the bottom up, so the newest of the
    // batch ends with the highest rank. On the first pass this reproduces the
    // natural recency order; afterwards newcomers land above existing rows.
    for (let i = ordered.length - 1; i >= 0; i--) {
      snapshot.ranks.set(ordered[i].id, snapshot.nextNewRank);
      snapshot.nextNewRank += 1;
    }
  }

  return [...sessions].sort((a, b) => {
    const ra = snapshot.ranks.get(a.id) ?? 0;
    const rb = snapshot.ranks.get(b.id) ?? 0;
    if (ra !== rb) return rb - ra;
    return b.id.localeCompare(a.id);
  });
}

/** Drop ranks for sessions that are gone, so a long-lived page cannot grow the
 *  snapshot without limit. MUST be called with the FULL visible set — a
 *  filtered subset would delete ranks the next unfiltered render needs. */
export function pruneStableOrder(snapshot: StableOrderSnapshot, sessions: SessionInfo[]): void {
  if (snapshot.ranks.size <= sessions.length) return;
  const present = new Set(sessions.map((s) => s.id));
  for (const id of [...snapshot.ranks.keys()]) {
    if (!present.has(id)) snapshot.ranks.delete(id);
  }
}
