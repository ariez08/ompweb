/**
 * Request → profile scoping (multi-profile live, Opsi C).
 *
 * Transport is a cookie, not a header: the client subscribes to SSE streams
 * (running-status broadcaster in lib/rpc-manager.ts) that cannot attach custom
 * request headers, and `Vary: Cookie` is already the convention on the session
 * list route.
 *
 * The cookie value is untrusted. It is always funnelled through
 * `resolveProfileContext`, which validates against profiles on disk and falls
 * back to the process profile — never to an attacker-chosen directory.
 */
import { resolveProfileContext, type ProfileContext } from "./profile-context";

export const OMP_WEB_PROFILE_COOKIE = "omp_web_profile";

/** Long-lived by design: the choice is a workspace preference, not a session. */
export const OMP_WEB_PROFILE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** Headers every profile-scoped response must carry. */
export const PROFILE_SCOPED_HEADERS = {
  "Cache-Control": "no-store",
  Vary: "Cookie",
} as const;

/** Raw cookie value, or undefined when absent/blank. No validation here. */
export function readProfileCookie(request: Request): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== OMP_WEB_PROFILE_COOKIE) continue;
    const value = decodeURIComponent(part.slice(eq + 1).trim());
    return value || undefined;
  }
  return undefined;
}

/**
 * Resolved profile context for a request. Unknown or malicious values collapse
 * to the process profile rather than erroring, so a stale cookie can never
 * break the UI — it just stops selecting a profile.
 */
export function requestProfileContext(request: Request): ProfileContext {
  return resolveProfileContext(readProfileCookie(request));
}

/** Canonical key for a request; use it in every cache/ETag key. */
export function requestProfileKey(request: Request): string {
  return requestProfileContext(request).key;
}
