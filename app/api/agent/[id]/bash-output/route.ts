import { NextResponse } from "next/server";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import {
  MAX_INLINE_BASH_OUTPUT_BYTES,
  openRegularFileNoFollow,
  readUtf8FileWithinLimit,
  resolveBashOutputPath,
} from "@/lib/bash-output";
import { isBashOutputPathReferencedBySession } from "@/lib/session-file-references";
import { PROFILE_SCOPED_HEADERS, requestProfileContext } from "@/lib/omp/profile-cookie";

// GET /api/agent/[id]/bash-output?path=<absPath>[&download=1]
// Serves the full output of a bash execution whose session entry recorded a
// `fullOutputPath` temp file. Inline display is size-limited (413 when the
// file exceeds MAX_INLINE_BASH_OUTPUT_BYTES); `download=1` streams the file
// without buffering it. Access requires the session to actually reference the
// path — a path alone is never enough.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = requestProfileContext(req);
  const { id } = await params;
  let path: string | null = null;
  let download = false;
  try {
    const url = new URL(req.url);
    path = url.searchParams.get("path");
    download = url.searchParams.get("download") === "1";
  } catch {
    return NextResponse.json({ error: "invalid url" }, { status: 400, headers: { ...PROFILE_SCOPED_HEADERS } });
  }

  if (!path) {
    return NextResponse.json({ error: "path required" }, { status: 400, headers: { ...PROFILE_SCOPED_HEADERS } });
  }

  const resolved = resolveBashOutputPath(path, tmpdir());
  if (!resolved) {
    return NextResponse.json({ error: "invalid path" }, { status: 400, headers: { ...PROFILE_SCOPED_HEADERS } });
  }

  // Authorised against the REQUEST profile's transcript: the helper resolves
  // the session id under `ctx`, so a path referenced only by another profile's
  // session never grants access.
  if (!await isBashOutputPathReferencedBySession(resolved, id, ctx)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: { ...PROFILE_SCOPED_HEADERS } });
  }

  try {
    if (download) {
      const { handle } = await openRegularFileNoFollow(resolved);
      const stream = Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array>;
      return new Response(stream, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": "attachment; filename=\"bash-output.log\"",
          ...PROFILE_SCOPED_HEADERS,
        },
      });
    }

    const result = await readUtf8FileWithinLimit(resolved);
    if (result.tooLarge) {
      return NextResponse.json({
        error: `Full output is too large to display (limit ${MAX_INLINE_BASH_OUTPUT_BYTES} bytes)`,
        data: { size: result.size, maxBytes: MAX_INLINE_BASH_OUTPUT_BYTES },
      }, { status: 413, headers: { ...PROFILE_SCOPED_HEADERS } });
    }
    return NextResponse.json({ success: true, data: { output: result.content } }, { headers: { ...PROFILE_SCOPED_HEADERS } });
  } catch {
    return NextResponse.json({ error: "full output unavailable" }, { status: 404, headers: { ...PROFILE_SCOPED_HEADERS } });
  }
}
