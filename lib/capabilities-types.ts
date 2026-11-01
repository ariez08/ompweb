/**
 * Types and presets for OMP capabilities (tools, MCP, skills) control.
 */

export type CapabilityPreset = "chat_only" | "code_editor" | "full_agent" | "custom" | string;

export interface SessionCapabilities {
  preset: CapabilityPreset;
  /** Explicit tool names to enable. If undefined in full_agent, all tools are active. */
  tools?: string[];
  /** Glob patterns of skills to include. If undefined, all skills in workspace are available. */
  skills?: string[];
  /** MCP server names to disable (e.g. ["manage_omp", "gitlab_repo_simrskartini"]). */
  disabledMcp?: string[];
  /** Human-readable name if this is a custom saved preset */
  customPresetName?: string;
}

export interface CustomPresetDefinition {
  id: string;
  name: string;
  description?: string;
  tools?: string[];
  skills?: string[];
  disabledMcp?: string[];
  createdAt?: string;
  updatedAt?: string;
}

export const BUILTIN_TOOLS: readonly WorkspaceCapabilityItem[] = [
  { id: "read", name: "Read", description: "Read files, web pages, images, and databases", category: "builtin_tool" },
  { id: "edit", name: "Edit", description: "Precision patch existing files", category: "builtin_tool" },
  { id: "write", name: "Write", description: "Create or replace whole files", category: "builtin_tool" },
  { id: "bash", name: "Bash", description: "Run shell commands and processes", category: "builtin_tool" },
  { id: "glob", name: "Glob", description: "Find files and directory trees by pattern", category: "builtin_tool" },
  { id: "grep", name: "Grep", description: "Regex text search across repository files", category: "builtin_tool" },
  { id: "ask", name: "Ask", description: "Ask clarification questions to the user", category: "builtin_tool" },
  { id: "todo", name: "Todo", description: "Multi-step task progress ledger", category: "builtin_tool" },
  { id: "task", name: "Task", description: "Spawn concurrent subagent workers", category: "builtin_tool" },
  { id: "eval", name: "Eval", description: "Execute Python / Bun in a persistent kernel", category: "builtin_tool" },
  { id: "wait", name: "Wait", description: "Wait for background tasks to settle", category: "builtin_tool" },
] as const;

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
  customPresets?: CustomPresetDefinition[];
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
