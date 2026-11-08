/** Quoted assistant-message snippets attached to the composer as removable chips. */

const MENTION_PREVIEW_CHARS = 280;
const MENTION_TOOLTIP_CHARS = 1200;
const OUTGOING_MENTION_HEADER = "Quoted from assistant message:";

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

/** Collapse whitespace so the chip shows a compact, readable preview. */
export function mentionPreview(text: string): string {
  return truncate(text.replace(/\s+/g, " ").trim(), MENTION_PREVIEW_CHARS);
}

/** Longer, whitespace-preserving text for the chip tooltip. */
export function mentionTooltip(text: string): string {
  return truncate(text.trim(), MENTION_TOOLTIP_CHARS);
}

function quoteMention(text: string): string {
  const quoted = text
    .replace(/\r\n?/g, "\n")
    .trim()
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
  return `> ${OUTGOING_MENTION_HEADER}\n${quoted}`;
}

/**
 * Compose the outgoing prompt: quoted snippets first (as Markdown blockquotes),
 * then what the user typed. Returns the typed message unchanged when there are
 * no mentions, so slash commands and plain prompts are unaffected.
 */
export function buildMentionPrompt(message: string, mentions: readonly string[]): string {
  if (mentions.length === 0) return message;
  return [...mentions.map(quoteMention), message].filter(Boolean).join("\n\n");
}

/** Add a snippet, ignoring blanks and exact duplicates. */
export function addMentionText(current: readonly string[], text: string): string[] {
  const snippet = text.trim();
  if (!snippet || current.includes(snippet)) return current as string[];
  return [...current, snippet];
}
