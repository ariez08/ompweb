import { NextResponse } from "next/server";
import { existsSync, statSync } from "fs";
import { dirname, resolve } from "path";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { AGENT_NAME_RE, MAX_AGENT_BYTES, deleteAgent, discoverAgents, readAgentFile, resolveAgentsScope, unpackBundled, validateAgentFileReference, validateAgentPayload, writeAgent, type AgentPayload } from "@/lib/omp/agents-service";
import { PROFILE_SCOPED_HEADERS, requestProfileContext } from "@/lib/omp/profile-cookie";
import { getProjectAgentsDir } from "@/lib/omp/paths";

export const dynamic = "force-dynamic";

// JSON can expand control characters in a maximum-size agent prompt to six
// bytes each, with room for the envelope fields.
const MAX_AGENT_REQUEST_BYTES = MAX_AGENT_BYTES * 6 + 64 * 1024;

type Scope = "all" | "user" | "project" | "bundled";

async function allowedCwd(value: unknown, required = true): Promise<string | undefined> {
  if (typeof value !== "string" || !value.trim()) {
    if (required) throw new Error("cwd is required");
    return undefined;
  }
  const roots = await getAllowedFileRoots();
  try {
    if (!statSync(value).isDirectory()) throw new Error("Workspace is not allowed");
  } catch {
    throw new Error("Workspace is not allowed");
  }
  if (!isExistingFilePathAllowed(value, roots)) throw new Error("Workspace is not allowed");
  return value;
}

async function allowedProjectScope(value: unknown): Promise<{ cwd: string; dir: string }> {
  const cwd = await allowedCwd(value);
  if (!cwd) throw new Error("cwd is required");
  const dir = getProjectAgentsDir(cwd);
  const roots = await getAllowedFileRoots();
  let probe = resolve(dir);
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) throw new Error("Workspace is not allowed");
    probe = parent;
  }
  if (!isExistingFilePathAllowed(probe, roots)) throw new Error("Workspace is not allowed");
  return { cwd, dir };
}

function parseScope(value: string | null | undefined, allowBundled = true): Scope {
  const scope = value ?? "all";
  if (scope === "user" || scope === "project" || (allowBundled && scope === "bundled") || scope === "all") return scope as Scope;
  throw new Error("scope must be all, user, project, or bundled");
}

export async function GET(request: Request) {
  const ctx = requestProfileContext(request);
  try {
    const params = new URL(request.url).searchParams;
    const scope = parseScope(params.get("scope"));
    const cwdParam = params.get("cwd");
    if (scope === "project" && !cwdParam) throw new Error("cwd is required for project scope");
    // A workspace is needed to discover project agents (and for the default
    // all-scope view), but user/bundled-only reads do not depend on it.
    const project = scope === "project" || (scope === "all" && cwdParam)
      ? await allowedProjectScope(cwdParam)
      : undefined;
    const cwd = project?.cwd;
    const result = await discoverAgents(cwd, ctx);
    const agents = scope === "all" ? result.agents : result.agents.filter((agent) => agent.scope === scope);
    return NextResponse.json({
      agents,
      diagnostics: result.diagnostics,
      userPath: ctx.userAgentsDir,
      projectPath: project?.dir ?? null,
      bundledPath: result.bundledPath,
    }, { headers: { ...PROFILE_SCOPED_HEADERS } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: /not allowed/i.test(message) ? 403 : 400, headers: { ...PROFILE_SCOPED_HEADERS } });
  }
}

export async function POST(request: Request) {
  const ctx = requestProfileContext(request);
  try {
    const body = await parseJsonWithinLimit<{ action?: unknown; cwd?: unknown; scope?: unknown; name?: unknown; previousName?: unknown; agent?: unknown }>(request, MAX_AGENT_REQUEST_BYTES);
    if (body.action === "unpack") {
      if (body.scope !== "user" && body.scope !== "project") throw new Error("scope must be user or project");
      const project = body.scope === "project" ? await allowedProjectScope(body.cwd) : undefined;
      const cwd = project?.cwd;
      const targetDir = project?.dir ?? resolveAgentsScope(cwd, body.scope, ctx);
      return NextResponse.json({ success: true, ...unpackBundled(targetDir, false) }, { headers: { ...PROFILE_SCOPED_HEADERS } });
    }
    if (body.scope !== "user" && body.scope !== "project") throw new Error("scope must be user or project");
    const project = body.scope === "project" ? await allowedProjectScope(body.cwd) : undefined;
    const cwd = project?.cwd;
    if (typeof body.name !== "string" || !body.name.trim()) throw new Error("name is required");
    if (!AGENT_NAME_RE.test(body.name.trim())) throw new Error(`name must match ${AGENT_NAME_RE.source}`);
    if (body.previousName !== undefined && typeof body.previousName !== "string") throw new Error("previousName must be a string");
    validateAgentPayload({ ...(body.agent as Record<string, unknown>), name: body.name });
    const scopeDir = project?.dir ?? resolveAgentsScope(cwd, body.scope, ctx);
    const written = writeAgent(scopeDir, body.name.trim(), body.agent as AgentPayload, body.previousName);
    const agent = readAgentFile(written.path, ctx);
    return NextResponse.json({ success: true, ...written, agent }, { headers: { ...PROFILE_SCOPED_HEADERS } });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: "Agent request is too large" }, { status: 413, headers: { ...PROFILE_SCOPED_HEADERS } });
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: /not allowed/i.test(message) ? 403 : 400, headers: { ...PROFILE_SCOPED_HEADERS } });
  }
}

export async function PUT(request: Request) {
  const ctx = requestProfileContext(request);
  try {
    const body = await parseJsonWithinLimit<{ cwd?: unknown; scope?: unknown; name?: unknown; previousName?: unknown; agent?: unknown }>(request, MAX_AGENT_REQUEST_BYTES);
    if (body.scope !== "user" && body.scope !== "project") throw new Error("scope must be user or project");
    const project = body.scope === "project" ? await allowedProjectScope(body.cwd) : undefined;
    const cwd = project?.cwd;
    if (typeof body.name !== "string" || !body.name.trim()) throw new Error("name is required");
    if (!AGENT_NAME_RE.test(body.name.trim())) throw new Error(`name must match ${AGENT_NAME_RE.source}`);
    if (body.previousName !== undefined && typeof body.previousName !== "string") throw new Error("previousName must be a string");
    validateAgentPayload({ ...(body.agent as Record<string, unknown>), name: body.name });
    const scopeDir = project?.dir ?? resolveAgentsScope(cwd, body.scope, ctx);
    const written = writeAgent(scopeDir, body.name.trim(), body.agent as AgentPayload, body.previousName);
    return NextResponse.json({ success: true, ...written, agent: readAgentFile(written.path, ctx) }, { headers: { ...PROFILE_SCOPED_HEADERS } });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: "Agent request is too large" }, { status: 413, headers: { ...PROFILE_SCOPED_HEADERS } });
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: /not allowed/i.test(message) ? 403 : 400, headers: { ...PROFILE_SCOPED_HEADERS } });
  }
}

export async function DELETE(request: Request) {
  const ctx = requestProfileContext(request);
  try {
    const body = await parseJsonWithinLimit<{ cwd?: unknown; scope?: unknown; name?: unknown }>(request, MAX_AGENT_REQUEST_BYTES);
    if (body.scope !== "user" && body.scope !== "project") throw new Error("scope must be user or project");
    const project = body.scope === "project" ? await allowedProjectScope(body.cwd) : undefined;
    const cwd = project?.cwd;
    if (typeof body.name !== "string" || !body.name.trim()) throw new Error("name is required");
    const scopeDir = project?.dir ?? resolveAgentsScope(cwd, body.scope, ctx);
    validateAgentFileReference(scopeDir, body.name.trim());
    return NextResponse.json({ success: true, ...deleteAgent(scopeDir, body.name.trim()) }, { headers: { ...PROFILE_SCOPED_HEADERS } });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: "Agent request is too large" }, { status: 413, headers: { ...PROFILE_SCOPED_HEADERS } });
    const message = error instanceof Error ? error.message : String(error);
    const status = /not found/i.test(message) ? 404 : /not allowed/i.test(message) ? 403 : 400;
    return NextResponse.json({ error: message }, { status, headers: { ...PROFILE_SCOPED_HEADERS } });
  }
}
