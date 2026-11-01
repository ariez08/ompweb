import { NextResponse } from "next/server";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getWorkspaceCapabilitiesCatalog,
  saveProfileCustomPreset,
  deleteProfileCustomPreset,
  listProfileCustomPresets,
} from "@/lib/capabilities-service";
import { CAPABILITY_PRESETS } from "@/lib/capabilities-types";
import { PROFILE_SCOPED_HEADERS, requestProfileContext } from "@/lib/omp/profile-cookie";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const ctx = requestProfileContext(req);
  const { searchParams } = new URL(req.url);
  const rawCwd = searchParams.get("cwd");
  const cwd = rawCwd && existsSync(rawCwd) ? rawCwd : homedir();

  try {
    const catalog = await getWorkspaceCapabilitiesCatalog(cwd, ctx);
    return NextResponse.json(
      {
        catalog,
        presets: CAPABILITY_PRESETS,
      },
      { headers: { ...PROFILE_SCOPED_HEADERS } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: message, code: "capabilities_fetch_failed" },
      { status: 500, headers: { ...PROFILE_SCOPED_HEADERS } },
    );
  }
}

export async function POST(req: Request) {
  const ctx = requestProfileContext(req);
  try {
    const body = (await req.json()) as {
      cwd?: string;
      capabilities?: {
        preset: string;
        tools?: string[];
        skills?: string[];
        disabledMcp?: string[];
      };
      savePreset?: {
        id?: string;
        name: string;
        description?: string;
        tools?: string[];
        skills?: string[];
        disabledMcp?: string[];
      };
    };

    // Mode 1: Save custom preset to profile
    if (body.savePreset) {
      if (!body.savePreset.name || !body.savePreset.name.trim()) {
        return NextResponse.json(
          { error: "Preset name is required", code: "preset_name_required" },
          { status: 400, headers: { ...PROFILE_SCOPED_HEADERS } },
        );
      }
      const saved = saveProfileCustomPreset(body.savePreset, ctx);
      const customPresets = listProfileCustomPresets(ctx);
      return NextResponse.json(
        { success: true, savedPreset: saved, customPresets },
        { headers: { ...PROFILE_SCOPED_HEADERS } },
      );
    }

    // Mode 2: Save capabilities to workspace .omp/config.yml
    if (!body.cwd || !existsSync(body.cwd)) {
      return NextResponse.json(
        { error: "Valid cwd is required", code: "cwd_required" },
        { status: 400, headers: { ...PROFILE_SCOPED_HEADERS } },
      );
    }

    const ompDir = join(body.cwd, ".omp");
    mkdirSync(ompDir, { recursive: true });
    const configPath = join(ompDir, "config.yml");

    let yamlContent = "";
    if (body.capabilities?.preset === "chat_only") {
      yamlContent = "skills:\n  enabled: false\n";
    } else if (body.capabilities?.skills && body.capabilities.skills.length > 0) {
      const patterns = body.capabilities.skills.map((p) => `    - "${p}"`).join("\n");
      yamlContent = `skills:\n  enabled: true\n  includeSkills:\n${patterns}\n`;
    }

    if (yamlContent) {
      writeFileSync(configPath, yamlContent, "utf8");
    }

    return NextResponse.json(
      { success: true, configPath },
      { headers: { ...PROFILE_SCOPED_HEADERS } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: message, code: "capabilities_save_failed" },
      { status: 500, headers: { ...PROFILE_SCOPED_HEADERS } },
    );
  }
}

export async function DELETE(req: Request) {
  const ctx = requestProfileContext(req);
  try {
    const { searchParams } = new URL(req.url);
    let id = searchParams.get("id");
    if (!id) {
      const body = (await req.json().catch(() => ({}))) as { id?: string };
      id = body.id ?? null;
    }

    if (!id) {
      return NextResponse.json(
        { error: "Preset id is required", code: "preset_id_required" },
        { status: 400, headers: { ...PROFILE_SCOPED_HEADERS } },
      );
    }

    const deleted = deleteProfileCustomPreset(id, ctx);
    const customPresets = listProfileCustomPresets(ctx);
    return NextResponse.json(
      { success: deleted, customPresets },
      { headers: { ...PROFILE_SCOPED_HEADERS } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: message, code: "preset_delete_failed" },
      { status: 500, headers: { ...PROFILE_SCOPED_HEADERS } },
    );
  }
}
