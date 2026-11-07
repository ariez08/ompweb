import { randomUUID } from "node:crypto";
import { createWriteStream, lstatSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { NextResponse } from "next/server";
import { resolveSessionPathOr404 } from "@/lib/api-utils";
import { validateUploadFileNames } from "@/lib/file-upload";
import { getRpcSession } from "@/lib/rpc-manager";
import { PROFILE_SCOPED_HEADERS, readRequestedProfile, requestProfileContext } from "@/lib/omp/profile-cookie";
import { DEFAULT_PROFILE, isKnownProfile } from "@/lib/omp/profile-context";
import { siblingDirForSession } from "@/lib/subagent-history";

export const runtime = "nodejs";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_SESSION_BYTES = 100 * 1024 * 1024;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requested = readRequestedProfile(request);
  if (requested && requested !== DEFAULT_PROFILE && !isKnownProfile(requested)) {
    return NextResponse.json({ error: "Unknown profile" }, { status: 409, headers: { ...PROFILE_SCOPED_HEADERS } });
  }
  const ctx = requestProfileContext(request);
  const { id } = await params;
  const live = getRpcSession(id, ctx);
  const livePath = live?.isAlive() && live.sessionId === id ? live.sessionFile : "";
  const inside = livePath ? relative(ctx.sessionsDir, livePath) : "";
  const filePath = livePath && extname(livePath) === ".jsonl" && inside && !isAbsolute(inside)
    && inside !== ".." && !inside.startsWith(`..${sep}`) ? livePath : null;
  const resolved = filePath ? { filePath } : await resolveSessionPathOr404(id, ctx);
  if ("response" in resolved) return resolved.response;

  let name: string;
  try {
    name = decodeURIComponent(request.headers.get("x-file-name") ?? "");
  } catch {
    return NextResponse.json({ error: "Invalid file name" }, { status: 400, headers: { ...PROFILE_SCOPED_HEADERS } });
  }
  const invalidName = validateUploadFileNames([name]);
  if (invalidName || !request.body) {
    return NextResponse.json({ error: invalidName ?? "Empty upload" }, { status: 400, headers: { ...PROFILE_SCOPED_HEADERS } });
  }

  const directory = join(siblingDirForSession(resolved.filePath), "attachments");
  let destination = "";
  try {
    mkdirSync(directory, { recursive: true });
    if (lstatSync(directory).isSymbolicLink()) throw new Error("Attachment directory is a symlink");
    const used = readdirSync(directory, { withFileTypes: true }).reduce((size, entry) =>
      size + (entry.isFile() ? statSync(join(directory, entry.name)).size : 0), 0);
    const remaining = Math.min(MAX_FILE_BYTES, MAX_SESSION_BYTES - used);
    const declared = Number(request.headers.get("content-length"));
    if (remaining <= 0 || (Number.isFinite(declared) && declared > remaining)) {
      return NextResponse.json({ error: "Attachment size limit exceeded" }, { status: 413, headers: { ...PROFILE_SCOPED_HEADERS } });
    }

    const extension = extname(name).toLowerCase();
    destination = join(directory, randomUUID() + (/^\.[a-z0-9]{1,12}$/.test(extension) ? extension : ".bin"));
    let received = 0;
    await pipeline(
      Readable.fromWeb(request.body as Parameters<typeof Readable.fromWeb>[0]),
      new Transform({ transform(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        done(received > remaining ? new Error("Attachment size limit exceeded") : null, chunk);
      } }),
      createWriteStream(destination, { flags: "wx" }),
      { signal: request.signal },
    );
    if (received === 0) {
      unlinkSync(destination);
      return NextResponse.json({ error: "Empty upload" }, { status: 400, headers: { ...PROFILE_SCOPED_HEADERS } });
    }
    return NextResponse.json({ path: destination, name }, { headers: { ...PROFILE_SCOPED_HEADERS } });
  } catch (error) {
    if (destination) {
      try { unlinkSync(destination); } catch { /* No file to remove. */ }
    }
    const tooLarge = error instanceof Error && error.message === "Attachment size limit exceeded";
    return NextResponse.json(
      { error: tooLarge ? "Attachment size limit exceeded" : "Attachment upload failed" },
      { status: tooLarge ? 413 : 500, headers: { ...PROFILE_SCOPED_HEADERS } },
    );
  }
}
