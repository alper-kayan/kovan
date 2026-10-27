import type { ChatMessage } from '@kovan/model-gateway';

/** About four characters a token: enough to tell when a conversation nears the window. */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content))
      for (const part of m.content) chars += 'text' in part ? String(part.text).length : 1000;
    if (m.role === 'assistant')
      for (const c of m.tool_calls ?? [])
        chars += c.function.name.length + c.function.arguments.length;
  }
  return Math.ceil(chars / 4);
}

/** When to compact: within max(15%, 16k tokens) of the model's window. */
export function nearWindow(tokens: number, window: number): boolean {
  return tokens > window - Math.max(window * 0.15, 16_000);
}

/**
 * Where the kept tail starts: the newest messages worth about `keep` tokens, beginning on a
 * user or assistant message so a tool result is never kept without its call. Null when there
 * is too little before it to be worth a summary.
 */
export function compactPoint(messages: ChatMessage[], keep: number): number | null {
  const head = messages[0]?.role === 'system' ? 1 : 0;
  let size = 0;
  let point: number | null = null;
  for (let i = messages.length - 1; i > head; i--) {
    const own = estimateTokens([messages[i]!]);
    // The kept part stays within `keep`, though the newest exchange is always kept.
    if (size + own > keep && point !== null) break;
    size += own;
    if (messages[i]!.role !== 'tool') point = i;
  }
  // Something older than the kept part must be left to summarize.
  if (point === null || point - head < 1) return null;
  return point;
}

const PER_MESSAGE = 4_000;
const PER_TOOL_OUTPUT = 1_500;

/** The part being summarized, as plain text for the summarizing model (long outputs cut). */
export function transcriptOf(messages: ChatMessage[], maxChars: number): string {
  const lines: string[] = [];
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)} …[cut]` : s);
  for (const m of messages) {
    if (m.role === 'system') lines.push(`[system] ${cut(m.content, PER_MESSAGE)}`);
    else if (m.role === 'user')
      lines.push(
        `[user] ${cut(typeof m.content === 'string' ? m.content : '(attachments)', PER_MESSAGE)}`,
      );
    else if (m.role === 'assistant') {
      if (m.content) lines.push(`[assistant] ${cut(m.content, PER_MESSAGE)}`);
      for (const c of m.tool_calls ?? [])
        lines.push(`[tool call] ${c.function.name} ${cut(c.function.arguments, PER_MESSAGE)}`);
    } else lines.push(`[tool result] ${cut(m.content, PER_TOOL_OUTPUT)}`);
  }
  const text = lines.join('\n');
  // Too long even so: the start (the task) and the end (where things stand) matter most.
  return text.length > maxChars
    ? `${text.slice(0, maxChars * 0.3)}\n…[middle cut]…\n${text.slice(-maxChars * 0.7)}`
    : text;
}

export const SUMMARY_PROMPT = [
  "You compress the earlier part of a coding agent's working conversation so the agent can carry on without it.",
  'Write a dense, factual summary with these parts: the goal and every requirement the person gave; decisions made and why; files read and files changed (exact paths, and what changed); commands run and their results (which tests passed or failed, error messages word for word); where the work stands now; what is left to do and any open problem.',
  'Keep exact names: paths, functions, identifiers, branch names, error text. Leave out pleasantries and anything already superseded. No preamble.',
].join('\n');

export const SUMMARY_HEADER =
  'The earlier part of this conversation was summarized to fit the model’s context. The summary:';

/** Whether a provider error means the request was too long for the model. */
export function isContextOverflow(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /context (length|window)|maximum context|too many tokens|prompt is too long|input is too long|reduce the length|exceeds? the (model'?s )?(maximum|context)/i.test(
    text,
  );
}
