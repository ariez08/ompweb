/**
 * Capabilities service: discovers and catalogs all tools, MCP servers, and skills
 * available for a workspace or session, and computes preset configurations.
 */
import { defaultProfileContext, type ProfileContext } from "./omp/profile-context";
import { readDiscoveredMcpServers } from "./omp/mcp-config";
import { discoverSkills } from "./skills-service";
import type {
  WorkspaceCapabilitiesCatalog,
  WorkspaceCapabilityItem,
  SessionCapabilities,
} from "./capabilities-types";

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

export async function getWorkspaceCapabilitiesCatalog(
  cwd: string,
  ctx: ProfileContext = defaultProfileContext(),
): Promise<WorkspaceCapabilitiesCatalog> {
  // 1. Built-in tools
  const builtinTools = [...BUILTIN_TOOLS];

  // 2. Discovered MCP servers
  const mcpServersList = readDiscoveredMcpServers(cwd);
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

  return {
    builtinTools,
    mcpServers,
    skills,
    defaultCapabilities,
  };
}
