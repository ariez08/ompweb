/**
 * External CLI session lock detection.
 *
 * An interactive `omp` session in a terminal holds an exclusive lock on its
 * session file (or kernel lock object). When ompweb attempts to resume the same
 * session via `--mode rpc-ui --resume <file>`, omp detects that the session is
 * already open elsewhere and forks it to a brand-new session ID (reason:
 * "open-elsewhere"), causing a session_split failure and leaving the web UI
 * disconnected.
 *
 * This module detects external CLI processes currently running for a given
 * session, allowing ompweb to:
 *   1. Refuse POST /api/agent/[id] before spawning omp (preventing split-file creation).
 *   2. Mark the session as externally locked in GET /api/sessions/[id]/state.
 *   3. Inform the user in the UI with the exact CLI PID holding the session.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CliLockInfo {
  locked: boolean;
  pid: number;
  name: string;
  command: string;
}

const CACHE_TTL_MS = 2500;
let cacheTimestamp = 0;
let cachedMap: Map<string, CliLockInfo> = new Map();
let inflightQuery: Promise<Map<string, CliLockInfo>> | null = null;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Session id held by a matched CLI process, taken ONLY from an explicit UUID in
 * its command line (`--resume <id|path>`). An earlier version also guessed by
 * taking the newest .jsonl in the process's profile/cwd; that guess routinely
 * attributed unrelated sessions (and the ompweb server itself) as "CLI-locked",
 * so it is gone: a real terminal session always carries its id in the args.
 */
function resolveSessionFromCliProcess(cl: string): string | null {
  const directMatch = UUID_RE.exec(cl);
  return directMatch ? directMatch[0].toLowerCase() : null;
}

async function queryLockedSessionsWin32(): Promise<Map<string, CliLockInfo>> {
  const map = new Map<string, CliLockInfo>();
  const psCmd =
    "Get-CimInstance Win32_Process -Filter \"Name like '%bun%' or Name like '%node%' or Name like '%omp%'\" | " +
    "Where-Object { " +
    // Only real interactive CLI entrypoints. `\\bomp(\\.exe)?\\b` used to also
    // match this server's own `node .../omp-web.js` process, which then
    // "locked" whatever session was newest in the default profile.
    "  ($_.CommandLine -match 'omp\\.exe' -or $_.CommandLine -match 'pi-coding-agent[\\\\/]dist[\\\\/]cli\\.js') -and " +
    "  $_.CommandLine -notmatch 'omp-web\\.js' -and " +
    "  $_.CommandLine -notmatch '--mode rpc-ui' -and " +
    "  $_.CommandLine -notmatch '__omp_worker_' " +
    "} | " +
    "Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress";

  try {
    const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", psCmd], {
      timeout: 3000,
      encoding: "utf8",
    });
    const trimmed = stdout.trim();
    if (!trimmed) return map;
    const parsed = JSON.parse(trimmed) as
      | { ProcessId?: number; Name?: string; CommandLine?: string }
      | Array<{ ProcessId?: number; Name?: string; CommandLine?: string }>;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const p of list) {
      const pid = Number(p.ProcessId);
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      const cl = String(p.CommandLine ?? "");
      const sid = resolveSessionFromCliProcess(cl);
      if (!sid) continue;
      if (!map.has(sid)) {
        map.set(sid, {
          locked: true,
          pid,
          name: String(p.Name ?? "omp"),
          command: cl,
        });
      }
    }
  } catch {
    // Return empty on timeout / permissions error
  }
  return map;
}

async function queryLockedSessionsUnix(): Promise<Map<string, CliLockInfo>> {
  const map = new Map<string, CliLockInfo>();
  try {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,args="], {
      timeout: 2000,
      encoding: "utf8",
    });
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.includes("--mode rpc-ui") || trimmed.includes("__omp_worker_")) continue;
      // Keep parity with the Win32 matcher: `\bomp\b` also matches this
      // server's own `omp-web.js` process, which then claims the newest
      // session in the default profile as "CLI-locked".
      if (trimmed.includes("omp-web")) continue;
      if (!/(omp\.exe|pi-coding-agent\/dist\/cli\.js)/.test(trimmed)) continue;
      const match = trimmed.match(/^(\d+)\s+(.+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      const command = match[2];
      const sid = resolveSessionFromCliProcess(command);
      if (!sid) continue;
      if (!map.has(sid)) {
        map.set(sid, {
          locked: true,
          pid,
          name: "omp",
          command,
        });
      }
    }
  } catch {
    // Return empty on error
  }
  return map;
}
/**
 * Returns a map of all session IDs currently held by an external CLI/terminal
 * process, keyed by lowercase session ID. Results are cached for 2.5 seconds to
 * prevent query overhead on frequent polling.
 */
export async function listCliLockedSessions(): Promise<Map<string, CliLockInfo>> {
  const now = Date.now();
  if (now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedMap;
  }
  if (inflightQuery) {
    return inflightQuery;
  }
  inflightQuery = (process.platform === "win32" ? queryLockedSessionsWin32() : queryLockedSessionsUnix())
    .then((result) => {
      cachedMap = result;
      cacheTimestamp = Date.now();
      return result;
    })
    .finally(() => {
      inflightQuery = null;
    });
  return inflightQuery;
}

/**
 * Check whether a specific session ID is held by an active external terminal process.
 */
export async function findCliSessionLock(sessionId: string): Promise<CliLockInfo | null> {
  if (!sessionId) return null;
  const map = await listCliLockedSessions();
  return map.get(sessionId.toLowerCase()) ?? null;
}

/** Invalidate the process scan cache (e.g. after a process spawn or exit). */
export function invalidateCliLockCache(): void {
  cacheTimestamp = 0;
  cachedMap.clear();
}
