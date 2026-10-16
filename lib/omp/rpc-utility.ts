import { homedir } from "os";
import { RpcProcess } from "./rpc-process";
import { defaultProfileContext, hostEnvFor, type ProfileContext } from "./profile-context";

/**
 * Short-lived `omp` utility processes for global registry/auth queries
 * (get_available_models, get_login_providers, get_state). These commands do
 * not belong to any user session, so they run against a lazily-started RPC
 * process PER PROFILE that is killed after ~5 minutes of inactivity. Access is
 * serialized within a profile: the omp RPC loop handles one command at a time
 * anyway, and serialization lets lazy start/idle-kill stay race-free.
 *
 * Per profile and not per server: the model registry and the credential store
 * live in the agent dir, so one shared process would answer every profile with
 * the models and providers of whichever profile started it first — the
 * split-brain the profile switcher exists to remove. Same shape as the Rust
 * host multiplexing: one single-tenant child per profile.
 *
 * Real user sessions must use lib/rpc-manager.ts instead — these processes run
 * with --no-session and their agent state is throwaway.
 */

// Extensions stay ENABLED: they can register models and login providers, and
// omitting them made the web UI's model/provider lists disagree with the CLI's.
// Measured against a real install (omp/17.1.3): ready-frame latency is the same
// either way (~3.6s with vs ~4.0s without over 4 runs each).
const UTILITY_EXTRA_ARGS = ["--no-session", "--no-skills", "--no-lsp"];
const READY_TIMEOUT_MS = 60_000;
// Longer than the 60s models-cache TTL on purpose: with idle-kill == TTL every
// pause past a minute paid a cold multi-second respawn on top of the stale
// cache. Cost of the longer window is one idle omp process per live profile.
const IDLE_KILL_MS = 300_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

/** Minimal mirror of omp's Model (packages/catalog/src/types.ts) — only the
 * fields the models/auth routes read. Everything else passes through opaque. */
export interface OmpModel {
  id: string;
  name: string;
  provider: string;
  api?: string;
  reasoning?: boolean;
  thinking?: {
    mode?: string;
    efforts?: string[];
    defaultLevel?: string;
    effortMap?: Record<string, string>;
  };
  input?: string[];
  contextWindow?: number | null;
  maxTokens?: number | null;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

/** Entry of the get_login_providers response (modes/rpc/rpc-types.ts). */
export interface OmpLoginProvider {
  id: string;
  name: string;
  available: boolean;
  authenticated: boolean;
}

interface UtilityRpcState {
  proc: RpcProcess | null;
  // `undefined`, not `null`: clearTimeout() takes Timeout | undefined, so the
  // handle can be cleared unconditionally without a redundant truthiness guard.
  idleTimer: NodeJS.Timeout | undefined;
  queue: Promise<void>;
}

declare global {
  var __ompUtilityRpcStates: Map<string, UtilityRpcState> | undefined;
}

function getState(ctx: ProfileContext): UtilityRpcState {
  if (!globalThis.__ompUtilityRpcStates) {
    globalThis.__ompUtilityRpcStates = new Map();
    // Mirror the session registry in lib/rpc-manager.ts: dispose the utility
    // omp processes on server shutdown so they do not outlive the server.
    // Idempotent and safe to call any time (clears idle timers + disposes).
    const cleanup = () => disposeUtilityRpc();
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  const states = globalThis.__ompUtilityRpcStates;
  let state = states.get(ctx.key);
  if (!state) {
    state = { proc: null, idleTimer: undefined, queue: Promise.resolve() };
    states.set(ctx.key, state);
  }
  return state;
}

/**
 * Tear down utility omp processes immediately (skip the idle timers). With a
 * context, only that profile's process is dropped — a model/config change in
 * one profile must not cold-start another profile's registry query. Without
 * one (the server-shutdown hook) every profile is settled.
 * Registered as a shutdown hook in getState() above, mirroring the session
 * registry in lib/rpc-manager.ts; also safe to call any time.
 */
export function disposeUtilityRpc(ctx?: ProfileContext): void {
  const states = globalThis.__ompUtilityRpcStates;
  if (!states) return;
  const targets = ctx ? [ctx.key] : [...states.keys()];
  for (const key of targets) {
    const state = states.get(key);
    if (!state) continue;
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
    }
    const proc = state.proc;
    state.proc = null;
    if (proc) void proc.dispose();
    states.delete(key);
  }
}

function scheduleIdleKill(state: UtilityRpcState): void {
  clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    state.idleTimer = undefined;
    const proc = state.proc;
    state.proc = null;
    if (proc) void proc.dispose();
  }, IDLE_KILL_MS);
  state.idleTimer.unref?.();
}

async function startProcess(state: UtilityRpcState, ctx: ProfileContext): Promise<RpcProcess> {
  const proc = new RpcProcess({
    cwd: homedir(),
    extraArgs: UTILITY_EXTRA_ARGS,
    // Pin the profile: the registry and credentials are read from the agent dir
    // this process inherits, so an unpinned child answers with whatever
    // profile the server was launched under.
    env: hostEnvFor(ctx),
    onExit: () => {
      if (state.proc === proc) state.proc = null;
    },
  });
  try {
    const ready = await proc.waitReady(READY_TIMEOUT_MS);
    await proc.negotiateProtocol(ready);
  } catch (error) {
    void proc.dispose();
    throw error;
  }
  return proc;
}

/** Run one RPC command on the profile's utility process (lazy start,
 * serialized, idle-killed). Rejections from earlier commands never poison the
 * queue. */
export function runUtilityCommand<T = unknown>(
  command: { type: string; [key: string]: unknown },
  timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS,
  ctx: ProfileContext = defaultProfileContext(),
): Promise<T> {
  const state = getState(ctx);
  const run = state.queue.then(async () => {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
    }
    try {
      if (!state.proc || !state.proc.isAlive) {
        state.proc = await startProcess(state, ctx);
      }
      return await state.proc.sendCommand<T>(command, timeoutMs);
    } finally {
      scheduleIdleKill(state);
    }
  });
  state.queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Run one RPC command on a dedicated throwaway process. Used where the shared
 * process must not be reused — e.g. the models-config connectivity test, which
 * points PI_CODING_AGENT_DIR at a temp dir via `env`. */
export async function runIsolatedUtilityCommand<T = unknown>(
  command: { type: string; [key: string]: unknown },
  options: { env?: Record<string, string | undefined>; cwd?: string; timeoutMs?: number } = {},
): Promise<T> {
  const proc = new RpcProcess({
    cwd: options.cwd ?? homedir(),
    extraArgs: UTILITY_EXTRA_ARGS,
    env: options.env,
  });
  try {
    const ready = await proc.waitReady(READY_TIMEOUT_MS);
    await proc.negotiateProtocol(ready);
    return await proc.sendCommand<T>(command, options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
  } finally {
    // Await the child's exit (not fire-and-forget): callers like the
    // models-config test remove their throwaway temp dir right after this
    // resolves, and on Windows a still-exiting child holding handles on that
    // dir makes rmSync fail (EBUSY, only suppressed by force: true).
    await proc.dispose();
  }
}
