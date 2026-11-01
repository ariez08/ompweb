import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_PROFILE,
  isKnownProfile,
  listProfileNames,
  profilesRoot,
  resolveProfileContext,
  type ProfileContext,
} from "./profile-context";
import { normalizeProfileName } from "./paths";
import { disposeHostFor } from "./rust-rpc-process";

export interface ProfileDetails {
  profile: string;
  isDefault: boolean;
  agentDir: string;
  configRoot: string;
  configYaml: string;
  modelsYaml: string;
  mcpJson: string;
  agentsMd: string;
  rulesMd: string;
  mcpServersCount: number;
}

export interface ProfileConfigPayload {
  configYaml?: string;
  modelsYaml?: string;
  mcpJson?: string;
  agentsMd?: string;
  rulesMd?: string;
}

export interface ProfileComponentsSelection {
  configYaml?: boolean;
  modelsYaml?: boolean;
  mcpJson?: boolean;
  agentsMd?: boolean;
  rulesMd?: boolean;
}

const PROFILE_NAME_REGEX = /^[a-zA-Z0-9_-]{1,32}$/;

/**
 * Validates whether a profile name is syntactically valid and allowed.
 */
export function validateProfileName(name: string): { valid: boolean; error?: string } {
  const trimmed = name.trim();
  if (!trimmed) {
    return { valid: false, error: "Profile name cannot be empty" };
  }
  if (trimmed === DEFAULT_PROFILE) {
    return { valid: false, error: "'default' is a reserved profile name" };
  }
  if (!PROFILE_NAME_REGEX.test(trimmed)) {
    return {
      valid: false,
      error: "Profile name must be 1-32 characters and contain only letters, numbers, hyphens, and underscores",
    };
  }
  let normalized: string | undefined;
  try {
    normalized = normalizeProfileName(trimmed);
  } catch {
    return { valid: false, error: "Invalid profile name structure" };
  }
  if (!normalized || normalized === DEFAULT_PROFILE) {
    return { valid: false, error: "Profile name is reserved or invalid" };
  }
  if (listProfileNames().includes(normalized)) {
    return { valid: false, error: `Profile "${normalized}" already exists` };
  }
  return { valid: true };
}

/**
 * Creates a new OMP profile directory under ~/.omp/profiles/<name>/agent
 * Optionally clones configuration files from an existing profile.
 */
export function createProfile(
  name: string,
  options?: { copyFrom?: string; include?: ProfileComponentsSelection },
): ProfileContext {
  const validation = validateProfileName(name);
  if (!validation.valid) {
    throw new Error(validation.error || "Invalid profile name");
  }

  const normalized = normalizeProfileName(name.trim())!;
  const rootDir = path.join(profilesRoot(), normalized);
  const targetAgentDir = path.join(rootDir, "agent");

  // Create required directory tree
  fs.mkdirSync(targetAgentDir, { recursive: true });
  fs.mkdirSync(path.join(targetAgentDir, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(targetAgentDir, "skills"), { recursive: true });
  fs.mkdirSync(path.join(targetAgentDir, "tools"), { recursive: true });

  const copySource = options?.copyFrom?.trim();
  const include = options?.include ?? {
    configYaml: true,
    modelsYaml: true,
    mcpJson: true,
    agentsMd: true,
    rulesMd: true,
  };

  const isCopying = Boolean(copySource && (copySource === DEFAULT_PROFILE || isKnownProfile(copySource)));
  const srcCtx = isCopying && copySource ? resolveProfileContext(copySource) : null;

  // Starter default templates
  const defaultConfigYaml = `# OMP Model Roles Configuration\nmodel_roles:\n  planner: ""\n  general: ""\n  fast: ""\n`;
  const defaultModelsYaml = `# OMP Models Configuration\nproviders: {}\n`;
  const defaultMcpJson = JSON.stringify({ mcpServers: {} }, null, 2) + "\n";
  const defaultAgentsMd = `# Agent Instructions & Persona\n\nYou are an expert fullstack software engineer.\n`;
  const defaultRulesMd = `# System Rules\n\n1. Always prioritize correctness, safety, and clean code.\n`;

  const componentMap = [
    { key: "configYaml" as const, file: "config.yml", defaultContent: defaultConfigYaml },
    { key: "modelsYaml" as const, file: "models.yml", defaultContent: defaultModelsYaml },
    { key: "mcpJson" as const, file: "mcp.json", defaultContent: defaultMcpJson },
    { key: "agentsMd" as const, file: "AGENTS.md", defaultContent: defaultAgentsMd },
    { key: "rulesMd" as const, file: "RULES.md", defaultContent: defaultRulesMd },
  ];

  for (const comp of componentMap) {
    const destPath = path.join(targetAgentDir, comp.file);
    const shouldCopy = isCopying && srcCtx && include[comp.key] !== false;
    let copied = false;

    if (shouldCopy && srcCtx) {
      const srcPath = path.join(srcCtx.agentDir, comp.file);
      if (fs.existsSync(srcPath)) {
        try {
          fs.copyFileSync(srcPath, destPath);
          copied = true;
        } catch {
          // ignore copy error
        }
      }
    }

    if (!copied) {
      fs.writeFileSync(destPath, comp.defaultContent, "utf-8");
    }
  }

  return resolveProfileContext(normalized);
}

function safeReadFile(filePath: string): string {
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, "utf-8");
    }
  } catch {
    // ignore
  }
  return "";
}

/**
 * Reads detailed configuration files and stats for a given profile.
 */
export function getProfileDetails(profile: string): ProfileDetails {
  if (profile !== DEFAULT_PROFILE && !isKnownProfile(profile)) {
    throw new Error(`Profile "${profile}" not found`);
  }

  const ctx = resolveProfileContext(profile);
  const configYaml = safeReadFile(path.join(ctx.agentDir, "config.yml"));
  const modelsYaml = safeReadFile(path.join(ctx.agentDir, "models.yml"));
  const mcpJson = safeReadFile(path.join(ctx.agentDir, "mcp.json"));
  const agentsMd = safeReadFile(path.join(ctx.agentDir, "AGENTS.md"));
  const rulesMd = safeReadFile(path.join(ctx.agentDir, "RULES.md"));

  let mcpServersCount = 0;
  if (mcpJson) {
    try {
      const parsed = JSON.parse(mcpJson) as { mcpServers?: Record<string, unknown> };
      if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
        mcpServersCount = Object.keys(parsed.mcpServers).length;
      }
    } catch {
      // ignore parse error
    }
  }

  return {
    profile: ctx.profile,
    isDefault: ctx.isDefault,
    agentDir: ctx.agentDir,
    configRoot: ctx.configRoot,
    configYaml,
    modelsYaml,
    mcpJson,
    agentsMd,
    rulesMd,
    mcpServersCount,
  };
}

/**
 * Updates configuration files of a target profile.
 */
export function updateProfileConfig(profile: string, payload: ProfileConfigPayload): ProfileDetails {
  if (profile !== DEFAULT_PROFILE && !isKnownProfile(profile)) {
    throw new Error(`Profile "${profile}" not found`);
  }

  const ctx = resolveProfileContext(profile);
  fs.mkdirSync(ctx.agentDir, { recursive: true });

  if (typeof payload.configYaml === "string") {
    fs.writeFileSync(path.join(ctx.agentDir, "config.yml"), payload.configYaml, "utf-8");
  }
  if (typeof payload.modelsYaml === "string") {
    fs.writeFileSync(path.join(ctx.agentDir, "models.yml"), payload.modelsYaml, "utf-8");
  }
  if (typeof payload.mcpJson === "string") {
    // Validate JSON before saving
    try {
      JSON.parse(payload.mcpJson);
    } catch (err) {
      throw new Error(`Invalid JSON syntax in mcp.json: ${String(err)}`);
    }
    fs.writeFileSync(path.join(ctx.agentDir, "mcp.json"), payload.mcpJson, "utf-8");
  }
  if (typeof payload.agentsMd === "string") {
    fs.writeFileSync(path.join(ctx.agentDir, "AGENTS.md"), payload.agentsMd, "utf-8");
  }
  if (typeof payload.rulesMd === "string") {
    fs.writeFileSync(path.join(ctx.agentDir, "RULES.md"), payload.rulesMd, "utf-8");
  }

  return getProfileDetails(profile);
}

/**
 * Deletes a non-default, non-active profile directory from disk.
 */
export async function deleteProfile(profile: string, currentActiveKey: string): Promise<void> {
  const trimmed = profile.trim();
  if (trimmed === DEFAULT_PROFILE) {
    throw new Error("Cannot delete the default profile");
  }
  if (trimmed === currentActiveKey) {
    throw new Error("Cannot delete the currently active profile. Please switch to another profile first.");
  }
  if (!isKnownProfile(trimmed)) {
    throw new Error(`Profile "${trimmed}" does not exist`);
  }

  const normalized = normalizeProfileName(trimmed);
  if (!normalized) {
    throw new Error("Invalid profile name");
  }

  // 1. Terminate in-process host for this profile so file handles to runtime.db are released
  try {
    await disposeHostFor(normalized);
  } catch {
    // ignore
  }

  const targetDir = path.join(profilesRoot(), normalized);
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
