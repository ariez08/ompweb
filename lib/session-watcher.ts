import { statSync, watch, type FSWatcher } from "fs";
import { join } from "path";
import { defaultProfileContext, type ProfileContext } from "./omp/profile-context";
import {
  invalidateSessionListCache,
  listAllSessions,
  resolveSessionIdByPath,
  resolveSessionPath,
} from "./session-reader";
// omp owns the writes to a session's JSONL. ompweb streams RPC events only for
// the sessions it spawned itself, so a session started outside the web UI — by
// `omp` in a terminal, or by a harness that launches omp — never updated while
// it was open: the file grew and nothing told the browser. This watches the
// session tree and reports which session ids changed, which the running-events
// stream forwards to the client.

type Listener = (sessionIds: string[]) => void;

const DEBOUNCE_MS = 250;

interface ProfileWatcherState {
  ctx: ProfileContext;
  listeners: Set<Listener>;
  watcher: FSWatcher | null;
  pendingPaths: Set<string>;
  pendingUnknown: boolean;
  flushTimer: NodeJS.Timeout | null;
  retryTimer: NodeJS.Timeout | null;
}

const watchers = new Map<string, ProfileWatcherState>();
const RETRY_MS = 5000;

function getOrCreateWatcherState(ctx: ProfileContext): ProfileWatcherState {
  let state = watchers.get(ctx.key);
  if (!state) {
    state = {
      ctx,
      listeners: new Set(),
      watcher: null,
      pendingPaths: new Set(),
      pendingUnknown: false,
      flushTimer: null,
      retryTimer: null,
    };
    watchers.set(ctx.key, state);
  }
  return state;
}

function flushState(state: ProfileWatcherState): void {
  state.flushTimer = null;
  const paths = [...state.pendingPaths];
  state.pendingPaths = new Set();
  const hadUnknown = state.pendingUnknown;
  state.pendingUnknown = false;
  if (paths.length === 0 && !hadUnknown) return;

  // A changed file means the cached list's mtimes and message counts are stale.
  invalidateSessionListCache();

  if (hadUnknown) {
    // filename was null — fs.watch coalesced the event or overflowed. We
    // don't know which file changed, so rescan the whole tree.
    void listAllSessions(state.ctx)
      .then((sessions) => {
        const sessionIds = sessions.map((s) => s.id);
        if (sessionIds.length === 0) return;
        recordExternalActivity(sessionIds, state.ctx);
        for (const listener of state.listeners) {
          try {
            listener(sessionIds);
          } catch {
            // a failing subscriber must not stop the others
          }
        }
      })
      .catch(() => {
        // resolution failures are not worth tearing the watcher down for
      });
    return;
  }

  void Promise.all(paths.map((path) => resolveSessionIdByPath(path).catch(() => undefined)))
    .then((ids) => {
      const sessionIds = [...new Set(ids.filter((id): id is string => Boolean(id)))];
      if (sessionIds.length === 0) return;
      recordExternalActivity(sessionIds, state.ctx);
      for (const listener of state.listeners) {
        try {
          listener(sessionIds);
        } catch {
          // a failing subscriber must not stop the others
        }
      }
    })
    .catch(() => {
      // resolution failures are not worth tearing the watcher down for
    });
}

function scheduleRetry(state: ProfileWatcherState): void {
  if (state.retryTimer || state.listeners.size === 0) return;
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    ensureWatcher(state);
  }, RETRY_MS);
}

function ensureWatcher(state: ProfileWatcherState): void {
  if (state.watcher || state.retryTimer) return;
  const sessionsDir = state.ctx.sessionsDir;
  try {
    state.watcher = watch(sessionsDir, { recursive: true, persistent: false }, (_event, filename) => {
      if (!filename) {
        state.pendingUnknown = true;
        if (!state.flushTimer) state.flushTimer = setTimeout(() => flushState(state), DEBOUNCE_MS);
        return;
      }
      const name = filename.toString();
      if (!name.endsWith(".jsonl")) return;
      state.pendingPaths.add(join(sessionsDir, name));
      if (!state.flushTimer) state.flushTimer = setTimeout(() => flushState(state), DEBOUNCE_MS);
    });
    state.watcher.on("error", () => {
      state.watcher?.close();
      state.watcher = null;
      scheduleRetry(state);
    });
  } catch {
    // No sessions directory yet, or the platform refused a recursive watch.
    // Schedule a retry while subscribers remain; otherwise degrade silently.
    state.watcher = null;
    scheduleRetry(state);
  }
}

export function subscribeSessionFileChanges(
  listener: Listener,
  ctx: ProfileContext = defaultProfileContext(),
): () => void {
  const state = getOrCreateWatcherState(ctx);
  state.listeners.add(listener);
  ensureWatcher(state);
  return () => {
    state.listeners.delete(listener);
    if (state.listeners.size > 0) return;
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    if (state.retryTimer) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    state.pendingPaths = new Set();
    state.pendingUnknown = false;
    state.watcher?.close();
    state.watcher = null;
    watchers.delete(ctx.key);
  };
}

// ── External-activity tracking ──────────────────────────────────────────────
// A session file that changes while its owning RPC process is idle means
// something else — a terminal `omp`, a harness — is writing it. The web UI
// must then treat the session as externally running: read-only file mode,
// no RPC attach, and a "running" badge driven by file activity.

const externalActivityByProfile = new Map<string, Map<string, number>>();

function getProfileActivityMap(profileKey: string): Map<string, number> {
  let map = externalActivityByProfile.get(profileKey);
  if (!map) {
    map = new Map();
    externalActivityByProfile.set(profileKey, map);
  }
  return map;
}

/** Record that these sessions' files were observed to change. */
export function recordExternalActivity(
  sessionIds: string[],
  ctx: ProfileContext = defaultProfileContext(),
): void {
  const map = getProfileActivityMap(ctx.key);
  const now = Date.now();
  for (const id of sessionIds) {
    map.set(id, now);
  }
}

/**
 * True when the session file changed within `withinMs`. Unlike the activity
 * table (fed by the watcher, which only runs while a browser is connected),
 * this stats the file directly so it works even with no SSE subscribers —
 * the state route needs it to decide whether to attach an RPC process.
 */
export async function isExternallyActive(
  sessionId: string,
  withinMs = 5000,
  ctx: ProfileContext = defaultProfileContext(),
): Promise<boolean> {
  const filePath = await resolveSessionPath(sessionId, ctx);
  if (!filePath) return false;
  try {
    const st = statSync(filePath);
    return Date.now() - st.mtimeMs <= withinMs;
  } catch {
    return false;
  }
}

/** Stop treating a session as externally active (e.g. after a user action). */
export function clearExternalActivity(
  sessionId: string,
  ctx: ProfileContext = defaultProfileContext(),
): void {
  getProfileActivityMap(ctx.key).delete(sessionId);
}

/** Snapshot of externally-active session ids (for badges and cleanup). */
export function getExternallyActiveIds(
  withinMs = 5000,
  ctx: ProfileContext = defaultProfileContext(),
): string[] {
  const map = getProfileActivityMap(ctx.key);
  const now = Date.now();
  const ids: string[] = [];
  for (const [id, last] of map) {
    if (now - last <= withinMs) ids.push(id);
  }
  return ids;
}
