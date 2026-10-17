import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPathOr404 } from "@/lib/api-utils";
import { PROFILE_SCOPED_HEADERS, requestProfileContext } from "@/lib/omp/profile-cookie";
import { invalidateCliLockCache } from "@/lib/session-cli-lock";

export const dynamic = "force-dynamic";

/**
 * POST /api/sessions/[id]/release
 *
 * Releases the active Web UI child process and kernel file lock for a session.
 * Once released, the session is idle on disk and can be immediately resumed
 * from a terminal CLI (`omp --resume <id>`) without triggering an open-elsewhere
 * session split.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = requestProfileContext(req);
  const { id } = await params;

  try {
    const resolved = await resolveSessionPathOr404(id, ctx);
    if ("response" in resolved) return resolved.response;

    const rpc = getRpcSession(id, ctx);
    if (rpc?.isAlive()) {
      await rpc.destroyAndWait();
    }

    invalidateCliLockCache();

    return NextResponse.json(
      { success: true, released: true, sessionId: id },
      { headers: { ...PROFILE_SCOPED_HEADERS } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: message, code: "session_release_failed" },
      { status: 500, headers: { ...PROFILE_SCOPED_HEADERS } },
    );
  }
}
