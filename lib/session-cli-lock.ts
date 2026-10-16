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

async function queryLockedSessionsWin32(): Promise<Map<string, CliLockInfo>> {
  const map = new Map<string, CliLockInfo>();
  const psCmd =
    "Get-CimInstance Win32_Process -Filter \"Name like '%omp%' or Name like '%bun%' or Name like '%node%'\" | " +
    "Where-Object { $_.CommandLine -match 'resume' -and $_.CommandLine -notmatch '--mode rpc-ui' } | " +
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
      const match = UUID_RE.exec(cl);
      if (!match) continue;
      const sid = match[0].toLowerCase();
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
      if (!trimmed || !trimmed.includes("resume") || trimmed.includes("--mode rpc-ui")) continue;
      const match = trimmed.match(/^(\d+)\s+(.+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      const command = match[2];
      const uuidMatch = UUID_RE.exec(command);
      if (!uuidMatch) continue;
      const sid = uuidMatch[0].toLowerCase();
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
  if (now - cacheTimestamp < CACHE_TTL_MS && cachedMap.size > 0) {
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
