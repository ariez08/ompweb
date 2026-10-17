/**
 * Types and presets for OMP capabilities (tools, MCP, skills) control.
 */

export type CapabilityPreset = "chat_only" | "code_editor" | "full_agent" | "custom";

export interface SessionCapabilities {
  preset: CapabilityPreset;
  /** Explicit tool names to enable. If undefined in full_agent, all tools are active. */
  tools?: string[];
  /** Glob patterns of skills to include. If undefined, all skills in workspace are available. */
  skills?: string[];
  /** MCP server names to disable (e.g. ["manage_omp", "gitlab_repo_simrskartini"]). */
  disabledMcp?: string[];
}

export interface WorkspaceCapabilityItem {
  id: string;
  name: string;
  description?: string;
  category: "builtin_tool" | "mcp_tool" | "skill";
  serverName?: string; // For MCP tools
}

export interface WorkspaceCapabilitiesCatalog {
  builtinTools: WorkspaceCapabilityItem[];
  mcpServers: { name: string; status?: string }[];
  skills: WorkspaceCapabilityItem[];
  defaultCapabilities: SessionCapabilities;
}

/** Pre-configured tool combinations for quick selection. */
export const CAPABILITY_PRESETS = {
  chat_only: {
    id: "chat_only" as const,
    labelKey: "capabilities.presetChatOnly",
    descriptionKey: "capabilities.presetChatOnlyDesc",
    tools: [] as string[],
    skills: [] as string[], // --no-skills
    disabledMcp: [] as string[],
    tokenSavings: "~6.000",
  },
  code_editor: {
    id: "code_editor" as const,
    labelKey: "capabilities.presetCodeEditor",
    descriptionKey: "capabilities.presetCodeEditorDesc",
    tools: ["read", "edit", "write", "bash", "glob", "grep"] as string[],
    skills: undefined as string[] | undefined, // Project & matching skills allowed
    disabledMcp: [] as string[],
    tokenSavings: "~3.700",
  },
  full_agent: {
    id: "full_agent" as const,
    labelKey: "capabilities.presetFullAgent",
    descriptionKey: "capabilities.presetFullAgentDesc",
    tools: undefined as string[] | undefined, // All tools active (omit --tools)
    skills: undefined as string[] | undefined, // All skills active
    disabledMcp: [] as string[],
    tokenSavings: "0",
  },
};
