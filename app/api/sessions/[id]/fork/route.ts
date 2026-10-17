import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { loadSessionFile, writeSessionFileAtomicSync } from "@/lib/omp/session-files";
import { invalidateSessionListCache } from "@/lib/session-reader";
import { resolveSessionPathOr404 } from "@/lib/api-utils";
import { PROFILE_SCOPED_HEADERS, requestProfileContext } from "@/lib/omp/profile-cookie";

export const dynamic = "force-dynamic";

function isoSessionTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * POST /api/sessions/[id]/fork
 *
 * Forks a session into a brand-new session file on disk without requiring an RPC
 * process spawn. This allows a user in the Web UI to safely branch a session
 * that is currently locked by an external terminal CLI, without triggering an
 * open-elsewhere conflict on the original session file.
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

    const sourcePath = resolved.filePath;
    const { header, entries, error: loadError } = loadSessionFile(sourcePath);
    if (loadError || !header) {
      return NextResponse.json(
        { error: "Source session is malformed or unreadable", code: "session_file_malformed" },
        { status: 400, headers: { ...PROFILE_SCOPED_HEADERS } },
      );
    }

    const newId = randomUUID();
    const timestamp = new Date().toISOString();
    const sessionDir = dirname(sourcePath);
    const newFileName = `${isoSessionTimestamp()}_${newId}.jsonl`;
    const newFilePath = join(sessionDir, newFileName);

    const forkedHeader = {
      ...header,
      id: newId,
      timestamp,
      parentSession: id,
      title: header.title ? `${header.title} (Fork)` : undefined,
    };

    const lines = [
      JSON.stringify(forkedHeader),
      ...entries.map((entry) => JSON.stringify(entry)),
    ];
    writeSessionFileAtomicSync(newFilePath, lines.join("\n") + "\n", "fork");

    invalidateSessionListCache();

    return NextResponse.json(
      { success: true, newSessionId: newId },
      { headers: { ...PROFILE_SCOPED_HEADERS } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: message, code: "session_fork_failed" },
      { status: 500, headers: { ...PROFILE_SCOPED_HEADERS } },
    );
  }
}
