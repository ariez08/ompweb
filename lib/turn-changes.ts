import { buildChatGroups } from "@/lib/chat-groups";
import { parseUnifiedPatch } from "@/lib/patch";
import type { AgentMessage, AssistantMessage, ToolCallContent, ToolResultMessage } from "@/lib/types";

export interface TurnChangeItem {
  id: string;
  toolName: string;
  paths: string[];
  patch: string | null;
  pending: boolean;
}

export interface TurnChangeTurn {
  id: string;
  prompt: string;
  changes: TurnChangeItem[];
}

function textFromMessage(message: AgentMessage | undefined): string {
  if (!message || message.role !== "user") return "";
  if (typeof message.content === "string") return message.content.trim();
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function pathsFromInput(input: Record<string, unknown>): string[] {
  const paths = [input.path, input.file_path, input.filePath, input.filename, input.target]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  return [...new Set(paths)];
}

function patchPaths(patch: string): string[] {
  const files = parseUnifiedPatch(patch);
  return files ? [...new Set(files.map((file) => file.newPath || file.oldPath).filter((path): path is string => Boolean(path)))] : [];
}

function isChangeTool(name: string): boolean {
  return /(?:^|[._:/-])(?:write|edit|apply_patch|patch|create_file|delete_file|remove_file|move_file|rename_file|replace_file|mkdir|touch)(?:$|[._:/-])/i.test(name);
}

function resultPatch(result: ToolResultMessage | undefined): string | null {
  if (!result || result.isError || typeof result.details !== "object" || result.details === null || Array.isArray(result.details)) return null;
  const details = result.details as Record<string, unknown>;
  if (typeof details.patch === "string" && details.patch) return details.patch;
  if (typeof details.diff === "string" && details.diff) return details.diff;
  return null;
}

export function collectTurnChanges(messages: AgentMessage[], entryIds: string[]): TurnChangeTurn[] {
  const groups = buildChatGroups(messages, (message) => (message as AgentMessage | undefined)?.role === "user");
  return groups.flatMap((group) => {
    const hasil = new Map<string, ToolResultMessage>();
    const pemanggilan: ToolCallContent[] = [];
    for (let i = group.startIdx; i < group.endIdx; i++) {
      const message = messages[i];
      if (message?.role === "toolResult") hasil.set(message.toolCallId, message);
      if (message?.role === "assistant" && Array.isArray(message.content)) {
        for (const block of (message as AssistantMessage).content) {
          if (block.type === "toolCall") pemanggilan.push(block);
        }
      }
    }

    const changes = pemanggilan.flatMap((call) => {
      const result = hasil.get(call.toolCallId);
      if (!isChangeTool(call.toolName) && !resultPatch(result)) return [];
      const patch = resultPatch(result);
      const paths = [...new Set([...pathsFromInput(call.input), ...(patch ? patchPaths(patch) : [])])];
      return [{
        id: call.toolCallId,
        toolName: call.toolName,
        paths,
        patch,
        pending: !result,
      }];
    });
    if (changes.length === 0) return [];
    const prompt = textFromMessage(messages[group.userIdx]);
    return [{
      id: entryIds[group.userIdx] ?? `turn-${group.userIdx}`,
      prompt,
      changes,
    }];
  });
}
