// Client-side helper for POST /api/agent/[id].
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.

import { formatApiError } from "@/lib/i18n/api-error";

// Sessions whose per-chat advisor toggle is on: their lazily spawned omp
// process must start with --advisor. Keyed by session id because the spawn
// decision happens inside the route, which only sees id + query string.
const advisorSpawnSessions = new Set<string>();

export function setSessionAdvisorSpawn(sessionId: string, enabled: boolean) {
  if (enabled) advisorSpawnSessions.add(sessionId);
  else advisorSpawnSessions.delete(sessionId);
}

/** Tool/skill selection a lazily-spawned child must start with, per session.
 *  Same reason as the advisor flag: the spawn happens in the route, which can
 *  only be told through the request. `undefined` array = unrestricted. */
const capabilitySpawnSelections = new Map<string, { tools?: string[]; skills?: string[] }>();

export function setSessionCapabilitySpawn(
  sessionId: string,
  selection: { tools?: string[]; skills?: string[] },
) {
  capabilitySpawnSelections.set(sessionId, selection);
}

// `undefined` means "unrestricted" (leave omp's full toolset alone), which a
// query string cannot express as an empty value — hence the `*` sentinel.
const UNRESTRICTED = "*";

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
): Promise<T> {
  const params = new URLSearchParams();
  if (advisorSpawnSessions.has(sessionId)) params.set("advisor", "1");
  const caps = capabilitySpawnSelections.get(sessionId);
  if (caps) {
    params.set("tools", caps.tools === undefined ? UNRESTRICTED : caps.tools.join(","));
    params.set("skills", caps.skills === undefined ? UNRESTRICTED : caps.skills.join(","));
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: T;
    error?: string;
    code?: string;
  };
 if (!res.ok || body.error) {
   // Routes attach a stable `code` for well-known failures; these messages are
   // surfaced to the user as notices, so localize before throwing.
    const error = new Error(body.error || body.code ? formatApiError(body) : `HTTP ${res.status}`) as Error & { code?: string };
    if (typeof body.code === "string") error.code = body.code;
    throw error;
 }
  return body.data as T;
}
