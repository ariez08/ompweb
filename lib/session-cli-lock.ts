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
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { resolveProfileContext } from "./omp/profile-context";

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

function resolveSessionFromCliProcess(
  cl: string,
  procCreatedMs?: number,
): string | null {
  const directMatch = UUID_RE.exec(cl);
  if (directMatch) return directMatch[0].toLowerCase();

  // Extract profile
  const mProf = /--profile[=\s]+(?:"([^"]+)"|([^\s]+))/i.exec(cl);
  const profile = mProf ? (mProf[1] || mProf[2]) : "default";

  // Extract cwd
  const mCwd = /--cwd[=\s]+(?:"([^"]+)"|([^\s]+))/i.exec(cl);
  const cwd = mCwd ? (mCwd[1] || mCwd[2]) : null;

  try {
    const ctx = resolveProfileContext(profile);
    const baseDir = ctx.sessionsDir;

    let targetDir = baseDir;
    if (cwd) {
      // Slugify cwd: e.g. C:\CodeAgent -> --C--CodeAgent--
      const slug = "--" + cwd.replace(/^[/\\]+/, "").replace(/[:/\\]+/g, "-") + "--";
      const candidate = path.join(baseDir, slug);
      try {
        if (statSync(candidate).isDirectory()) {
          targetDir = candidate;
        }
      } catch {
        // Fall back to scanning baseDir
      }
    }

    let latestFile: string | null = null;
    let latestTime = 0;

    const scan = (dir: string, depth = 0) => {
      try {
        const entries = readdirSync(dir);
        for (const e of entries) {
          const full = path.join(dir, e);
          try {
            const st = statSync(full);
            if (st.isDirectory()) {
              if (depth === 0 && targetDir === baseDir) scan(full, depth + 1);
            } else if (e.endsWith(".jsonl")) {
              if (st.mtimeMs > latestTime) {
                latestTime = st.mtimeMs;
                latestFile = e;
              }
            }
          } catch {
            // Ignore stat errors
          }
        }
      } catch {
        // Ignore read errors
      }
    };
    scan(targetDir);

    if (latestFile) {
      // Only attribute if file was active during/near the process lifetime (if known)
      if (procCreatedMs && latestTime < procCreatedMs - 60_000) {
        return null;
      }
      const m = UUID_RE.exec(latestFile);
      if (m) return m[0].toLowerCase();
    }
  } catch {
    // Ignore resolution errors
  }
  return null;
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
    "Select-Object ProcessId,Name,CommandLine,CreationDate | ConvertTo-Json -Compress";

  try {
    const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", psCmd], {
      timeout: 3000,
      encoding: "utf8",
    });
    const trimmed = stdout.trim();
    if (!trimmed) return map;
    const parsed = JSON.parse(trimmed) as
      | { ProcessId?: number; Name?: string; CommandLine?: string; CreationDate?: string }
      | Array<{ ProcessId?: number; Name?: string; CommandLine?: string; CreationDate?: string }>;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const p of list) {
      const pid = Number(p.ProcessId);
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      const cl = String(p.CommandLine ?? "");
      let createdMs: number | undefined;
      if (typeof p.CreationDate === "string") {
        const m = /\/Date\((\d+)\)\//.exec(p.CreationDate);
        if (m) createdMs = Number(m[1]);
      }
      const sid = resolveSessionFromCliProcess(cl, createdMs);
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
