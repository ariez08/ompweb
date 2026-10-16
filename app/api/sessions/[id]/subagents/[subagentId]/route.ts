import { NextResponse } from "next/server";
import { resolveSessionPathOr404 } from "@/lib/api-utils";
import { readCompletionArtifact, readSubagentTranscriptPage, resolveSubagentArtifact, subagentTranscriptPath } from "@/lib/subagent-history";
import { PROFILE_SCOPED_HEADERS, requestProfileContext } from "@/lib/omp/profile-cookie";

export const dynamic = "force-dynamic";

// Subagent ids are AdjectiveNoun names, optionally dotted for nested spawns
// (OMP allocates hierarchical ids like `Parent.Child`). The grammar bounds the
// value, rejects empty segments and traversal forms, and guarantees the joined
// path cannot escape the sibling dir; symlink escapes are additionally blocked
// by realpath confinement (resolveSubagentArtifact).
const SUBAGENT_ID_RE = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const SUBAGENT_ID_MAX_LENGTH = 100;

/**
 * GET /api/sessions/[id]/subagents/[subagentId]?fromByte=N
 *
 * Default: paged transcript of one subagent, read directly from the parent
 * session's sibling artifacts dir. Mirrors the RPC get_subagent_messages
 * response shape so the dialog can fall back to it when no live RPC process
 * knows the file.
 *
 * ?mode=completion: the subagent's final output (`<id>.md`), without loading
 * the transcript — works even for transcripts beyond the readable size cap.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; subagentId: string }> }
) {
  const ctx = requestProfileContext(req);
  const { id, subagentId } = await params;
  try {
    if (!SUBAGENT_ID_RE.test(subagentId) || subagentId.length > SUBAGENT_ID_MAX_LENGTH) {
      return NextResponse.json({ error: "Invalid subagent id", code: "invalid_subagent_id" }, { status: 400, headers: { ...PROFILE_SCOPED_HEADERS } });
    }
    const sessionResolved = await resolveSessionPathOr404(id, ctx);
    if ("response" in sessionResolved) return sessionResolved.response;
    const filePath = sessionResolved.filePath;
    const searchParams = new URL(req.url).searchParams;
    if (searchParams.get("mode") === "completion") {
      const resolved = resolveSubagentArtifact(filePath, subagentId, ".md");
      if (!resolved) {
        return NextResponse.json({ error: "Subagent completion not found", code: "transcript_not_found" }, { status: 404, headers: { ...PROFILE_SCOPED_HEADERS } });
      }
      // Read the RESOLVED path: re-deriving from the raw session path here
      // would reopen whatever the symlink points at after the check.
      const completion = readCompletionArtifact(resolved);
      return NextResponse.json({
        sessionFile: subagentTranscriptPath(filePath, subagentId),
        completion: completion?.completion ?? null,
        truncated: completion?.truncated ?? false,
      }, { headers: { ...PROFILE_SCOPED_HEADERS } });
    }
    const resolved = resolveSubagentArtifact(filePath, subagentId, ".jsonl");
    if (!resolved) {
      return NextResponse.json({ error: "Subagent transcript not found", code: "transcript_not_found" }, { status: 404, headers: { ...PROFILE_SCOPED_HEADERS } });
    }
    const fromByteRaw = searchParams.get("fromByte");
    const fromByte = fromByteRaw !== null ? Number(fromByteRaw) : 0;
    const page = readSubagentTranscriptPage(resolved, fromByte);
    return NextResponse.json(page, { headers: { ...PROFILE_SCOPED_HEADERS } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { ...PROFILE_SCOPED_HEADERS } },
    );
  }
}
