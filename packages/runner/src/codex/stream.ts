import type { AgentEvent } from '@kovan/harness';
import { maskSecrets } from '@kovan/mcp-client';

interface CodexItem {
  id: string;
  type: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  changes?: { path: string; kind: string }[];
  server?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  result?: { content?: { type: string; text?: string }[] } | null;
  error?: { message?: string } | null;
  query?: string;
}

/** `/bin/zsh -lc "sed -n '1,40p' a.js"` → `sed -n '1,40p' a.js`, as the person would type it. */
export function bareCommand(command: string): string {
  const m = /^\S*\/(?:ba|z)?sh -l?c (.*)$/s.exec(command);
  if (!m) return command;
  const inner = m[1]!;
  if (inner.startsWith('"') && inner.endsWith('"'))
    return inner.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
  if (inner.startsWith("'") && inner.endsWith("'")) return inner.slice(1, -1);
  return inner;
}

/** Codex's token counts; on a resumed thread they cover the whole thread, not just this turn. */
export interface CodexTotals {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
}

export const NO_TOTALS: CodexTotals = { input: 0, cached: 0, output: 0, reasoning: 0 };

const KIND_VERB: Record<string, string> = { add: 'Created', delete: 'Deleted', update: 'Edited' };

/**
 * Turns `codex exec --json` lines into Kovan agent events, so Codex runs show up in the same
 * chat as Kovan's own agent.
 */
export class CodexStreamParser {
  threadId: string | null = null;
  /** The thread's running totals after this turn, to subtract on the next one. */
  totals: CodexTotals;
  private started = false;
  private ended = false;
  private readonly open = new Set<string>();
  private lastError: string | null = null;

  constructor(
    private readonly turnId: string,
    private readonly root: string,
    private readonly model: string,
    private readonly emit: (event: AgentEvent) => void,
    private readonly before: CodexTotals = NO_TOTALS,
  ) {
    this.totals = before;
  }

  get finished(): boolean {
    return this.ended;
  }

  private relative(path: string): string {
    return this.root && path.startsWith(`${this.root}/`) ? path.slice(this.root.length + 1) : path;
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    this.emit({ type: 'turn_start', turnId: this.turnId, model: `codex · ${this.model}` });
  }

  private toolStart(item: CodexItem): void {
    if (this.open.has(item.id)) return;
    let name: string;
    let summary: string;
    let args: Record<string, unknown>;
    switch (item.type) {
      case 'command_execution':
        name = 'shell';
        args = { command: bareCommand(item.command ?? '') };
        summary = `Ran ${String(args['command'])}`;
        break;
      case 'file_change': {
        name = 'apply_patch';
        const changes = item.changes ?? [];
        args = { changes };
        summary =
          changes.length === 1
            ? `${KIND_VERB[changes[0]!.kind] ?? 'Changed'} ${this.relative(changes[0]!.path)}`
            : `Changed ${changes.length} files`;
        break;
      }
      case 'mcp_tool_call':
        name = `mcp__${item.server ?? ''}__${item.tool ?? ''}`;
        // Shown to the team and the phone: secret-looking values hidden.
        args = maskSecrets(item.arguments ?? {});
        summary = `Called ${item.server ?? ''} ${item.tool ?? ''}`.trim();
        break;
      case 'web_search':
        name = 'web_search';
        args = { query: item.query ?? '' };
        summary = `Searched the web for ${JSON.stringify(item.query ?? '')}`;
        break;
      default:
        return;
    }
    this.open.add(item.id);
    this.emit({ type: 'tool_start', id: item.id, name, summary, args });
  }

  private toolEnd(item: CodexItem): void {
    if (!this.open.has(item.id)) this.toolStart(item);
    if (!this.open.delete(item.id)) return;
    let ok = item.status !== 'failed' && item.status !== 'declined';
    let output = '';
    if (item.type === 'command_execution') {
      ok = ok && item.exit_code === 0;
      output = item.aggregated_output ?? '';
    } else if (item.type === 'file_change') {
      output = (item.changes ?? []).map((c) => `${c.kind} ${this.relative(c.path)}`).join('\n');
    } else if (item.type === 'mcp_tool_call') {
      output =
        item.error?.message ??
        (item.result?.content ?? [])
          .map((c) => (c.type === 'text' ? (c.text ?? '') : ''))
          .join('\n');
      ok = ok && !item.error;
    }
    this.emit({ type: 'tool_end', id: item.id, ok, output });
  }

  push(line: Record<string, unknown>): void {
    const type = line['type'];
    if (type === 'thread.started') {
      if (typeof line['thread_id'] === 'string') this.threadId = line['thread_id'];
      return;
    }
    if (type === 'turn.started') {
      this.start();
      return;
    }
    if (type === 'error') {
      // Retries ("Reconnecting... 2/5") arrive as errors too; keep the last one for the summary.
      if (typeof line['message'] === 'string') this.lastError = line['message'];
      return;
    }
    if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
      this.start();
      const item = line['item'] as CodexItem | undefined;
      if (!item?.id) return;
      if (type !== 'item.completed') {
        this.toolStart(item);
        return;
      }
      if (item.type === 'agent_message' && item.text) this.emit({ type: 'text', text: item.text });
      else if (item.type === 'reasoning' && item.text)
        this.emit({ type: 'reasoning', text: item.text });
      else this.toolEnd(item);
      return;
    }
    if (type === 'turn.completed') {
      const usage = (line['usage'] ?? {}) as Record<string, number>;
      const now: CodexTotals = {
        input: usage['input_tokens'] ?? 0,
        cached: usage['cached_input_tokens'] ?? 0,
        output: usage['output_tokens'] ?? 0,
        reasoning: usage['reasoning_output_tokens'] ?? 0,
      };
      // Counts that went down mean Codex started counting afresh (a new thread or a restart).
      const b = now.input >= this.before.input ? this.before : NO_TOTALS;
      this.totals = now;
      this.emit({
        type: 'usage',
        model: `codex · ${this.model}`,
        kind: 'model',
        estimated: false,
        usage: {
          promptTokens: now.input - b.input,
          completionTokens: Math.max(0, now.output - b.output),
          cachedTokens: Math.max(0, now.cached - b.cached),
          reasoningTokens: Math.max(0, now.reasoning - b.reasoning),
          // Codex bills the person's own OpenAI account and reports tokens only, not cost.
          cost: null,
        },
      });
      this.finish('done');
      return;
    }
    if (type === 'turn.failed') {
      const error = line['error'] as { message?: string } | undefined;
      this.finish('error', error?.message ?? this.lastError ?? 'Codex stopped with an error');
    }
  }

  /** Ends the turn exactly once (also used when the process exits or is stopped). */
  finish(reason: 'done' | 'stopped' | 'error', error?: string): void {
    if (this.ended) return;
    this.ended = true;
    this.start();
    for (const id of this.open) this.emit({ type: 'tool_end', id, ok: false, output: '' });
    this.open.clear();
    const why = reason === 'error' ? (error ?? this.lastError ?? undefined) : undefined;
    this.emit({
      type: 'turn_end',
      turnId: this.turnId,
      reason,
      cost: 0,
      ...(why ? { error: why } : {}),
    });
  }
}
