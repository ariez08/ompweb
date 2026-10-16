import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { listArchivedSessions, restoreArchivedSession } from "@/lib/omp/archive";
import { invalidateSessionListCache } from "@/lib/session-reader";
import { PROFILE_SCOPED_HEADERS, readProfileCookie, requestProfileContext } from "@/lib/omp/profile-cookie";
import { DEFAULT_PROFILE, isKnownProfile } from "@/lib/omp/profile-context";
import type { ArchivedSessionInfo } from "@/lib/types";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const ctx = requestProfileContext(req);
  try {
    // Explicit archive root: the request profile's, never the process default.
    const archives = await listArchivedSessions(ctx.archivedSessionsDir, ctx);
    const response: ArchivedSessionInfo[] = archives.map((archive) => ({
      key: archive.key,
      id: archive.id,
      cwd: archive.cwd,
      ...(archive.title ? { name: archive.title } : {}),
      created: archive.created.toISOString(),
      archivedAt: archive.archivedAt.toISOString(),
      messageCount: archive.messageCount,
      firstMessage: archive.firstMessage,
      size: archive.size,
      status: archive.status,
    }));
    return NextResponse.json({ archives: response }, { headers: { ...PROFILE_SCOPED_HEADERS } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  const ctx = requestProfileContext(req);
  try {
    // A restore is a write: an unknown profile cookie must not silently land
    // the archive into the default profile's sessions root.
    const wanted = readProfileCookie(req);
    if (wanted && wanted !== DEFAULT_PROFILE && !isKnownProfile(wanted)) {
      return NextResponse.json(
        { error: `Unknown profile "${wanted}"`, code: "profile_unknown" },
        { status: 409, headers: { ...PROFILE_SCOPED_HEADERS } },
      );
    }
    const body = await req.json() as { key?: unknown };
    if (typeof body.key !== "string" || !body.key.trim()) {
      return NextResponse.json(
        { error: "Archive key is required", code: "archive_key_required" },
        { status: 400, headers: { ...PROFILE_SCOPED_HEADERS } },
      );
    }
    // Restore between the request profile's dirs only.
    const sessionId = restoreArchivedSession(body.key, ctx.sessionsDir, ctx.archivedSessionsDir, ctx);
    invalidateSessionListCache();
    return NextResponse.json({ ok: true, sessionId }, { headers: { ...PROFILE_SCOPED_HEADERS } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("Invalid archive key") || message.includes("required") ? 400 : message.includes("not found") ? 404 : message.includes("already exists") ? 409 : 500;
    return NextResponse.json({ error: message, code: "archive_restore_failed" }, { status, headers: { ...PROFILE_SCOPED_HEADERS } });
  }
}
