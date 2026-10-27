import type { ChatMessage } from '@kovan/model-gateway';

const textOf = (content: ChatMessage['content']): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((p) => (p.type === 'text' ? p.text : '[image]')).join('\n')
      : '';

/** Rough token count; good enough to pick a context window. */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += textOf(m.content).length;
    if (m.role === 'assistant' && m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  return Math.ceil(chars / 3.5);
}

export function lastUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === 'user') return i;
  return -1;
}

/** Did this tool result fail? Matches the harness's error and exit-code conventions. */
export function isFailure(content: string): boolean {
  return (
    content.startsWith('Error:') ||
    content.startsWith('Not found:') ||
    content.includes('was not found in') ||
    /\[exit code (?!0\])\d+\]$/.test(content.trimEnd()) ||
    /\[timed out after/.test(content)
  );
}

export interface TurnSignals {
  /** Failed tool results since the last user message. */
  failures: number;
  /** Failures at the end of the turn, back to back. */
  consecutiveFailures: number;
  toolCalls: number;
}

export function turnSignals(messages: ChatMessage[]): TurnSignals {
  const start = lastUserIndex(messages) + 1;
  let failures = 0;
  let consecutive = 0;
  let toolCalls = 0;
  for (const m of messages.slice(start)) {
    if (m.role !== 'tool') continue;
    toolCalls++;
    if (isFailure(m.content)) {
      failures++;
      consecutive++;
    } else {
      consecutive = 0;
    }
  }
  return { failures, consecutiveFailures: consecutive, toolCalls };
}

/**
 * A compact view of the whole conversation for the classifier: earlier user asks, what the
 * agent did, and the new message. Long texts are trimmed from the middle.
 */
export function digest(
  messages: ChatMessage[],
  maxChars = 6000,
): { previous: string; latest: string } {
  const trim = (s: string, n: number) =>
    s.length <= n ? s : `${s.slice(0, n * 0.6)} … ${s.slice(-n * 0.4)}`;
  const last = lastUserIndex(messages);
  const latest = last >= 0 ? trim(textOf(messages[last]!.content), 3000) : '';
  const lines: string[] = [];
  for (const m of messages.slice(0, Math.max(0, last))) {
    if (m.role === 'user') lines.push(`USER: ${trim(textOf(m.content), 400)}`);
    else if (m.role === 'assistant' && m.tool_calls?.length)
      lines.push(`AGENT used: ${m.tool_calls.map((c) => c.function.name).join(', ')}`);
    else if (m.role === 'assistant' && m.content) lines.push(`AGENT: ${trim(m.content, 200)}`);
    else if (m.role === 'tool' && isFailure(m.content))
      lines.push(`TOOL FAILED: ${trim(m.content, 120)}`);
  }
  return { previous: trim(lines.join('\n'), maxChars - latest.length), latest };
}
