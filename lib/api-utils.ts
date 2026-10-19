import { NextResponse } from "next/server";
import { resolveSessionPath, findProfileForSession } from "./session-reader";
import { PROFILE_SCOPED_HEADERS } from "./omp/profile-cookie";
import { defaultProfileContext, type ProfileContext } from "./omp/profile-context";

const SESSION_NOT_FOUND = { error: "Session not found", code: "session_not_found" } as const;

/** Resolve a session id to its file path, or a 404 JSON response. Replaces the
 * repeated `resolveSessionPath(id)` + "Session not found" guard across routes.
 * `ctx` scopes the lookup to the request's profile: session ids are not unique
 * across profiles, so an unscoped resolve could hand profile A profile B's
 * session file. The 404 carries the profile-scoped headers so a miss cannot be
 * cached against the wrong profile either. */
export async function resolveSessionPathOr404(
  id: string,
  ctx: ProfileContext = defaultProfileContext(),
): Promise<{ filePath: string } | { response: NextResponse }> {
  const filePath = await resolveSessionPath(id, ctx);
  if (!filePath) {
    const targetCtx = await findProfileForSession(id);
    if (targetCtx && targetCtx.key !== ctx.key) {
      return {
        response: NextResponse.json(
          {
            error: `Session belongs to profile ${targetCtx.key}`,
            code: "session_wrong_profile",
            profile: targetCtx.key,
          },
          {
            status: 404,
            headers: {
              ...PROFILE_SCOPED_HEADERS,
              "x-omp-profile-target": targetCtx.key,
            },
          },
        ),
      };
    }
    return {
      response: NextResponse.json(SESSION_NOT_FOUND, { status: 404, headers: { ...PROFILE_SCOPED_HEADERS } }),
    };
  }
  return { filePath };
}

/** Uniform JSON error body used by most API routes. Typed errors (e.g.
 * RuntimeUnavailableError) carry a stable `code` so clients can branch on the
 * failure class instead of parsing the message string. Every response is
 * profile-scoped state, so it must never be cached by a shared proxy. */
export function apiErrorResponse(error: unknown, status = 500): NextResponse {
  const code = typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
  return NextResponse.json(code ? { error: String(error), code } : { error: String(error) }, { status, headers: { ...PROFILE_SCOPED_HEADERS } });
}
