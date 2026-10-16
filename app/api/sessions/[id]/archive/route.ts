import { NextResponse } from "next/server";
import { archiveSessionFileWithArtifacts } from "@/lib/omp/session-files";
import {
  invalidateSessionListCache,
  invalidateSessionPathCache,
  listAllSessions,
} from "@/lib/session-reader";
import { resolveSessionPathOr404 } from "@/lib/api-utils";
import { getRpcSession } from "@/lib/rpc-manager";
import { PROFILE_SCOPED_HEADERS, readProfileCookie, requestProfileContext } from "@/lib/omp/profile-cookie";
import { DEFAULT_PROFILE, isKnownProfile } from "@/lib/omp/profile-context";

/** POST /api/sessions/[id]/archive — stop the live child, then archive the
 * native OMP JSONL and its sibling artifacts using OMP's gc layout. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = requestProfileContext(req);
  const { id } = await params;
  try {
    // Archiving is a write: an unknown profile cookie must not silently move
    // the session into the default profile's archive root.
    const wanted = readProfileCookie(req);
    if (wanted && wanted !== DEFAULT_PROFILE && !isKnownProfile(wanted)) {
      return NextResponse.json(
        { error: `Unknown profile "${wanted}"`, code: "profile_unknown" },
        { status: 409, headers: { ...PROFILE_SCOPED_HEADERS } },
      );
    }

    const resolved = await resolveSessionPathOr404(id, ctx);
    if ("response" in resolved) return resolved.response;
    const filePath = resolved.filePath;
    // Parent-session paths are native branch metadata. Moving only a parent
    // would leave active children pointing at a path that no longer exists,
    // flattening their tree in the sidebar. Archive leaves first instead.
    const hasChildren = (await listAllSessions(ctx)).some((session) => session.parentSessionId === id);
    if (hasChildren) {
      return NextResponse.json(
        { error: "Archive child sessions before archiving this session", code: "session_has_children" },
        { status: 409, headers: { ...PROFILE_SCOPED_HEADERS } },
      );
    }

    // OMP owns writes while a child is live; wait for its final flush before
    // moving the file so the archive contains the complete native transcript.
    await getRpcSession(id, ctx)?.destroyAndWait?.();
    // Explicit profile roots: never the process default, so an archive from a
    // non-default profile cannot land in (or read) the default profile's dirs.
    const archivedPath = archiveSessionFileWithArtifacts(filePath, { ctx });
    invalidateSessionPathCache(id, ctx);
    invalidateSessionListCache();
    return NextResponse.json({ ok: true, archived: true, archivedPath }, { headers: { ...PROFILE_SCOPED_HEADERS } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message, code: "session_archive_failed" }, { status: 500, headers: { ...PROFILE_SCOPED_HEADERS } });
  }
}
