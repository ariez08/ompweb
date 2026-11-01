/**
 * Capabilities service: discovers and catalogs all tools, MCP servers, and skills
 * available for a workspace or session, and computes preset configurations.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultProfileContext, type ProfileContext } from "./omp/profile-context";
import { readDiscoveredMcpServers } from "./omp/mcp-config";
import { discoverSkills } from "./skills-service";
import type {
  WorkspaceCapabilitiesCatalog,
  WorkspaceCapabilityItem,
  SessionCapabilities,
  CustomPresetDefinition,
} from "./capabilities-types";
import { BUILTIN_TOOLS } from "./capabilities-types";
export { BUILTIN_TOOLS };

export async function getWorkspaceCapabilitiesCatalog(
  cwd: string,
  ctx: ProfileContext = defaultProfileContext(),
): Promise<WorkspaceCapabilitiesCatalog> {
  // 1. Built-in tools
  const builtinTools = [...BUILTIN_TOOLS];

  // 2. Discovered MCP servers (include workspace cwd, user root, and active profile agent dir)
  const mcpServersList = readDiscoveredMcpServers(cwd);
  const profileMcpFile = join(ctx.agentDir, "mcp.json");
  if (existsSync(profileMcpFile)) {
    try {
      const raw = JSON.parse(readFileSync(profileMcpFile, "utf8")) as { mcpServers?: Record<string, unknown> };
      if (raw && typeof raw.mcpServers === "object" && raw.mcpServers !== null) {
        for (const name of Object.keys(raw.mcpServers)) {
          if (!mcpServersList.some((s) => s.name === name)) {
            mcpServersList.push({ name, source: "Profile config", status: "configured" });
          }
        }
      }
    } catch {
      // ignore parse error in profile mcp.json
    }
  }
  const mcpServers = mcpServersList.map((srv) => ({
    name: srv.name,
    status: srv.status,
  }));
  const { skills: discovered } = await discoverSkills(cwd, ctx);
  const skills: WorkspaceCapabilityItem[] = discovered.map((s) => ({
    id: s.name,
    name: s.name,
    description: s.description,
    category: "skill" as const,
  }));

  const defaultCapabilities: SessionCapabilities = {
    preset: "full_agent",
    tools: undefined,
    skills: undefined,
    disabledMcp: [],
  };

  const customPresets = listProfileCustomPresets(ctx);

  return {
    builtinTools,
    mcpServers,
    skills,
    defaultCapabilities,
    customPresets,
  };
}

export function getProfilePresetsFilePath(ctx: ProfileContext = defaultProfileContext()): string {
  return join(ctx.agentDir, "ompweb", "capabilities-presets.json");
}

export function listProfileCustomPresets(ctx: ProfileContext = defaultProfileContext()): CustomPresetDefinition[] {
  const targetPath = getProfilePresetsFilePath(ctx);
  if (!existsSync(targetPath)) return [];
  try {
    const raw = readFileSync(targetPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is CustomPresetDefinition =>
        typeof item === "object" && item !== null && typeof (item as CustomPresetDefinition).name === "string"
      );
    }
    return [];
  } catch {
    return [];
  }
}

export function saveProfileCustomPreset(
  preset: Omit<CustomPresetDefinition, "id" | "createdAt" | "updatedAt"> & { id?: string },
  ctx: ProfileContext = defaultProfileContext(),
): CustomPresetDefinition {
  const presetsDir = join(ctx.agentDir, "ompweb");
  mkdirSync(presetsDir, { recursive: true });
  const targetPath = getProfilePresetsFilePath(ctx);
  const presets = listProfileCustomPresets(ctx);

  const id = preset.id?.trim() || `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const existingIndex = presets.findIndex((item) => item.id === id);
  const nowIso = new Date().toISOString();

  const record: CustomPresetDefinition = {
    id,
    name: preset.name.trim(),
    description: preset.description?.trim(),
    tools: preset.tools,
    skills: preset.skills,
    disabledMcp: preset.disabledMcp,
    createdAt: existingIndex >= 0 ? presets[existingIndex].createdAt ?? nowIso : nowIso,
    updatedAt: nowIso,
  };

  if (existingIndex >= 0) {
    presets[existingIndex] = record;
  } else {
    presets.push(record);
  }

  writeFileSync(targetPath, JSON.stringify(presets, null, 2), "utf8");
  return record;
}

export function deleteProfileCustomPreset(
  id: string,
  ctx: ProfileContext = defaultProfileContext(),
): boolean {
  const targetPath = getProfilePresetsFilePath(ctx);
  if (!existsSync(targetPath)) return false;
  const presets = listProfileCustomPresets(ctx);
  const filtered = presets.filter((item) => item.id !== id);
  if (filtered.length === presets.length) return false;
  writeFileSync(targetPath, JSON.stringify(filtered, null, 2), "utf8");
  return true;
}
