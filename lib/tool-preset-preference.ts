import { isToolPreset, type ToolPreset } from "./tool-presets";
import type { SessionCapabilities } from "./capabilities-types";

const STORAGE_KEY = "omp-web:tool-preset";
const CAPABILITIES_STORAGE_KEY = "omp-web:capabilities";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getPreferredToolPreset(storage: StorageLike | null = browserStorage()): ToolPreset {
  if (!storage) return "full";
  try {
    const value = storage.getItem(STORAGE_KEY);
    return isToolPreset(value) ? value : "full";
  } catch {
    return "full";
  }
}

export function setPreferredToolPreset(preset: ToolPreset, storage: StorageLike | null = browserStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, preset);
  } catch {
    // Preferences remain optional when storage is unavailable.
  }
}

/** Coarse preset a full capability selection collapses to. */
function presetToToolPreset(caps: SessionCapabilities): ToolPreset {
  if (caps.preset === "chat_only") return "none";
  if (caps.preset === "code_editor") return "default";
  return "full";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function reviveCapabilities(raw: string | null): SessionCapabilities | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = parsed as Record<string, unknown>;
  if (typeof value.preset !== "string" || !value.preset) return null;

  // An absent `tools`/`skills` key is meaningful: for full_agent it means
  // "everything", so only revive arrays that were actually serialized.
  const caps: SessionCapabilities = { preset: value.preset };
  if (isStringArray(value.tools)) caps.tools = value.tools;
  if (isStringArray(value.skills)) caps.skills = value.skills;
  if (isStringArray(value.disabledMcp)) caps.disabledMcp = value.disabledMcp;
  if (typeof value.customPresetName === "string" && value.customPresetName) {
    caps.customPresetName = value.customPresetName;
  }
  return caps;
}

/**
 * The user's last capability selection (tools, skills, disabled MCP), restored
 * on reload so reopening the app keeps the custom preset instead of falling
 * back to the plain `full_agent` default. Falls back to the legacy coarse
 * preset key for installs that predate full capability persistence.
 */
export function getPreferredCapabilities(storage: StorageLike | null = browserStorage()): SessionCapabilities {
  if (!storage) return { preset: "full_agent" };
  try {
    const stored = reviveCapabilities(storage.getItem(CAPABILITIES_STORAGE_KEY));
    if (stored) return stored;
  } catch {
    // Fall through to the legacy mapping.
  }
  const preset = getPreferredToolPreset(storage);
  if (preset === "none") return { preset: "chat_only", tools: [], skills: [], disabledMcp: [] };
  if (preset === "default") {
    return { preset: "code_editor", tools: ["read", "edit", "write", "bash", "glob", "grep"], disabledMcp: [] };
  }
  return { preset: "full_agent" };
}

export function setPreferredCapabilities(caps: SessionCapabilities, storage: StorageLike | null = browserStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(CAPABILITIES_STORAGE_KEY, JSON.stringify(caps));
  } catch {
    // Preferences remain optional when storage is unavailable.
  }
  // Keep the coarse key in sync so `toolPreset` state and older readers agree.
  setPreferredToolPreset(presetToToolPreset(caps), storage);
}
