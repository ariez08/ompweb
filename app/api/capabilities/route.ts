import { NextResponse } from "next/server";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  getWorkspaceCapabilitiesCatalog,
  saveProfileCustomPreset,
  deleteProfileCustomPreset,
  listProfileCustomPresets,
} from "@/lib/capabilities-service";
import { writeUserMcpDisabledServers } from "@/lib/omp/mcp-config";
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

    // Mode 2: Apply capabilities durably.
    //
    // MCP toggles belong in the profile's mcp.json `disabledServers`, which is
    // the list OMP itself honours on every spawn — so they survive reloads and
    // apply to both web and CLI sessions. Skills keep using the workspace
    // `.omp/config.yml`, but merged (never overwritten) so unrelated settings
    // the user put there survive.
    const mcp = body.capabilities?.disabledMcp
      ? writeUserMcpDisabledServers(body.capabilities.disabledMcp, ctx)
      : null;

    let configPath: string | null = null;
    if (body.cwd && existsSync(body.cwd)) {
      const ompDir = join(body.cwd, ".omp");
      const target = join(ompDir, "config.yml");
      const skillsEnabled = body.capabilities?.preset === "chat_only"
        ? false
        : body.capabilities?.skills && body.capabilities.skills.length > 0
          ? true
          : undefined;
      const includeSkills = skillsEnabled === true ? body.capabilities?.skills : undefined;

      if (skillsEnabled !== undefined || includeSkills) {
        let current: Record<string, unknown> = {};
        if (existsSync(target)) {
          try {
            const parsed = parseYaml(readFileSync(target, "utf8"));
            if (typeof parsed === "object" && parsed !== null) current = parsed as Record<string, unknown>;
          } catch {
            // An unreadable config must never be silently replaced.
            return NextResponse.json(
              { error: "Existing .omp/config.yml could not be parsed", code: "config_parse_failed" },
              { status: 409, headers: { ...PROFILE_SCOPED_HEADERS } },
            );
          }
        }
        const currentSkills = typeof current.skills === "object" && current.skills !== null
          ? (current.skills as Record<string, unknown>)
          : {};
        current.skills = {
          ...currentSkills,
          ...(skillsEnabled !== undefined ? { enabled: skillsEnabled } : {}),
          ...(includeSkills ? { includeSkills } : {}),
        };
        mkdirSync(ompDir, { recursive: true });
        writeFileSync(target, stringifyYaml(current), "utf8");
        configPath = target;
      }
    }

    return NextResponse.json(
      { success: true, configPath, mcpConfigPath: mcp?.path ?? null, disabledMcp: mcp?.disabledServers ?? null },
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
