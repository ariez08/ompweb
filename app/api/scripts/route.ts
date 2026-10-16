import { NextResponse } from "next/server";
import { resolveProject } from "@/lib/worktree";
import { listQuickScripts, saveProjectScripts, validateQuickScripts } from "@/lib/project-scripts";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { PROFILE_SCOPED_HEADERS, requestProfileContext } from "@/lib/omp/profile-cookie";

export const dynamic = "force-dynamic";

/** Resolve the project and enforce the file allowlist (same rule as run). */
async function resolveAllowedProject(cwd: string): Promise<{ projectRoot: string } | { response: NextResponse }> {
  const project = await resolveProject(cwd);
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(project.projectRoot, allowedRoots)) {
    return { response: NextResponse.json({ error: "Path not allowed", code: "path_not_allowed" }, { status: 403, headers: { ...PROFILE_SCOPED_HEADERS } }) };
  }
  return { projectRoot: project.projectRoot };
}

/**
 * GET /api/scripts?cwd=<dir>  → merged quick scripts (global + project)
 * PUT /api/scripts?cwd=<dir>  → replace the PROJECT scripts (body { scripts })
 */
export async function GET(req: Request) {
  const ctx = requestProfileContext(req);
  const cwd = new URL(req.url).searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "Missing cwd", code: "missing_cwd" }, { status: 400, headers: { ...PROFILE_SCOPED_HEADERS } });
  try {
    const resolved = await resolveAllowedProject(cwd);
    if ("response" in resolved) return resolved.response;
    return NextResponse.json({ scripts: listQuickScripts(resolved.projectRoot, ctx) }, { headers: { ...PROFILE_SCOPED_HEADERS } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list scripts";
    return NextResponse.json({ error: message, code: "scripts_list_failed" }, { status: 500, headers: { ...PROFILE_SCOPED_HEADERS } });
  }
}

export async function PUT(req: Request) {
  const cwd = new URL(req.url).searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "Missing cwd", code: "missing_cwd" }, { status: 400, headers: { ...PROFILE_SCOPED_HEADERS } });
  try {
    const body = await req.json().catch(() => ({})) as { scripts?: unknown };
    const scripts = validateQuickScripts(body.scripts);
    if (!scripts) {
      return NextResponse.json({ error: "scripts must be an array of {name, command}", code: "invalid_scripts" }, { status: 400, headers: { ...PROFILE_SCOPED_HEADERS } });
    }
    const resolved = await resolveAllowedProject(cwd);
    if ("response" in resolved) return resolved.response;
    saveProjectScripts(resolved.projectRoot, scripts);
    return NextResponse.json({ ok: true, scripts }, { headers: { ...PROFILE_SCOPED_HEADERS } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save scripts";
    return NextResponse.json({ error: message, code: "scripts_save_failed" }, { status: 500, headers: { ...PROFILE_SCOPED_HEADERS } });
  }
}