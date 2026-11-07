import type { AgentMessage } from "@/lib/types";

type JobState = "running" | "completed" | "failed" | "cancelled";

export interface BackgroundJob {
  id: string;
  toolCallId: string;
  type: "bash" | "eval";
  command: string;
  status: JobState | "unknown";
  output: string;
}

export interface BackgroundJobUpdate {
  id: string;
  toolCallId: string;
  type: "bash" | "eval";
  command: string;
  state: JobState;
  output: string;
}

export function parseBackgroundJobUpdate(event: {
  toolCallId?: unknown;
  toolName?: unknown;
  args?: unknown;
  partialResult?: unknown;
}): BackgroundJobUpdate | null {
  if (typeof event.toolCallId !== "string" || (event.toolName !== "bash" && event.toolName !== "eval")) return null;
  const result = event.partialResult;
  if (!result || typeof result !== "object") return null;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") return null;
  const asyncJob = (details as { async?: unknown }).async;
  if (!asyncJob || typeof asyncJob !== "object") return null;
  const { jobId, state, type } = asyncJob as { jobId?: unknown; state?: unknown; type?: unknown };
  if (typeof jobId !== "string" || !jobId || type !== event.toolName ||
      (state !== "running" && state !== "completed" && state !== "failed" && state !== "cancelled")) return null;
  const args = event.args && typeof event.args === "object" ? event.args as Record<string, unknown> : {};
  const command = event.toolName === "bash" ? args.command : args.code;
  const content = (result as { content?: unknown }).content;
  const text = Array.isArray(content) ? content.find((block) => block?.type === "text")?.text : undefined;
  return {
    id: jobId,
    toolCallId: event.toolCallId,
    type: event.toolName,
    state,
    command: typeof command === "string" ? command.slice(0, 300) : "",
    output: typeof text === "string" ? text.slice(-500) : "",
  };
}

export function projectBackgroundJobs(messages: AgentMessage[], updates: Record<string, BackgroundJobUpdate>): BackgroundJob[] {
  const calls = new Map<string, string>();
  const jobs = new Map<string, BackgroundJob>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type !== "toolCall" || (block.toolName !== "bash" && block.toolName !== "eval")) continue;
        const command = block.toolName === "bash" ? block.input.command : block.input.code;
        calls.set(block.toolCallId, typeof command === "string" ? command.slice(0, 300) : "");
      }
    } else if (message.role === "toolResult" && (message.toolName === "bash" || message.toolName === "eval")) {
      const parsed = parseBackgroundJobUpdate({
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        args: message.toolName === "bash" ? { command: calls.get(message.toolCallId) } : { code: calls.get(message.toolCallId) },
        partialResult: message,
      });
      if (!parsed) continue;
      jobs.set(parsed.id, {
        id: parsed.id,
        toolCallId: parsed.toolCallId,
        type: parsed.type,
        command: parsed.command,
        status: parsed.state === "running" ? "unknown" : parsed.state,
        output: "",
      });
    }
  }
  for (const update of Object.values(updates)) {
    const previous = jobs.get(update.id);
    jobs.set(update.id, {
      id: update.id,
      toolCallId: update.toolCallId,
      type: update.type,
      command: update.command || previous?.command || calls.get(update.toolCallId) || "",
      status: update.state === "running" ? "unknown" : update.state,
      output: update.output,
    });
  }
  return [...jobs.values()].reverse();
}
