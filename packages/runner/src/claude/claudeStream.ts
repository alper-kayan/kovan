import { editProgress, isRiskyCommand, type AgentEvent } from '@kovan/harness';
import { maskSecrets } from '@kovan/mcp-client';

/** One-line descriptions of Claude Code's tools, matching Kovan's own tool rows. */
export function describeClaudeTool(name: string, input: Record<string, unknown>): string {
  const path =
    typeof input['file_path'] === 'string'
      ? input['file_path']
      : typeof input['path'] === 'string'
        ? input['path']
        : '';
  switch (name) {
    case 'Read':
      return `Read ${path}`;
    case 'Edit':
    case 'MultiEdit':
      return `Edited ${path}`;
    case 'Write':
      return `Wrote ${path}`;
    case 'Bash':
      return `Ran ${String(input['command'] ?? '')}`;
    case 'Glob':
      return `Listed ${String(input['pattern'] ?? '')}`;
    case 'Grep':
      return `Searched for ${JSON.stringify(input['pattern'] ?? '')}`;
    case 'WebFetch':
      return `Fetched ${String(input['url'] ?? '')}`;
    case 'TodoWrite':
      return 'Updated its todo list';
    case 'Agent':
    case 'Task':
      return `Delegated ${String(input['description'] ?? 'a task to a helper')}`;
    case 'Skill': {
      const skill = input['skill'] ?? input['command'] ?? input['name'];
      return typeof skill === 'string' ? `Used skill ${skill.replace(/^\//, '')}` : 'Used a skill';
    }
    default:
      return name.startsWith('mcp__')
        ? `Called ${name.split('__').slice(1).join(' ')}`
        : `Used ${name}`;
  }
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);

/** Makes paths in summaries relative to the repo, like Kovan's own tools. */
function relative(summary: string, root: string): string {
  return root ? summary.split(`${root}/`).join('') : summary;
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((c) =>
        typeof c === 'object' && c && 'text' in c ? String((c as { text: unknown }).text) : '',
      )
      .join('\n');
  return '';
}

/**
 * Turns Claude Code's --output-format stream-json lines into Kovan agent events, so Claude Code
 * runs show up in the same chat as Kovan's own agent.
 */
export class ClaudeStreamParser {
  model: string | null = null;
  sessionId: string | null = null;
  private started = false;
  private ended = false;
  /** Bash commands started and not yet finished: cut off by a stop, their outcome is unknown. */
  private readonly running = new Map<string, string>();
  /** Tool calls being written (with --include-partial-messages), by content block. */
  private readonly writing = new Map<
    number,
    { id: string; name: string; json: string; at: number; text: string }
  >();

  constructor(
    private readonly turnId: string,
    private readonly root: string,
    private readonly emit: (event: AgentEvent) => void,
    /** Claude Code's account limit, as it reports it during the turn. */
    private readonly onLimit?: (info: Record<string, unknown>) => void,
  ) {}

  get finished(): boolean {
    return this.ended;
  }

  push(line: Record<string, unknown>): void {
    const type = line['type'];
    if (typeof line['session_id'] === 'string') this.sessionId = line['session_id'];

    if (type === 'rate_limit_event') {
      const info = line['rate_limit_info'];
      if (info && typeof info === 'object') this.onLimit?.(info as Record<string, unknown>);
      return;
    }

    if (type === 'system' && line['subtype'] === 'init') {
      this.model = typeof line['model'] === 'string' ? line['model'] : null;
      if (!this.started) {
        this.started = true;
        this.emit({
          type: 'turn_start',
          turnId: this.turnId,
          model: `claude-code · ${this.model ?? 'default'}`,
        });
      }
      return;
    }

    if (type === 'stream_event') {
      if (line['parent_tool_use_id']) return;
      this.partial(line['event'] as Record<string, unknown> | undefined);
      return;
    }

    if (type === 'assistant' || type === 'user') {
      // A helper agent's steps go under the call that started it (one may wait for approval);
      // its words are left out to keep the lane readable.
      const parent =
        typeof line['parent_tool_use_id'] === 'string' ? line['parent_tool_use_id'] : null;
      const message = line['message'] as { content?: ContentBlock[] } | undefined;
      for (const block of message?.content ?? []) {
        if (block.type === 'text' && block.text) {
          if (!parent) this.emit({ type: 'text', text: block.text });
        } else if (block.type === 'thinking' && block.thinking) {
          if (!parent) this.emit({ type: 'reasoning', text: block.thinking });
        } else if (block.type === 'tool_use' && block.id && block.name) {
          // An MCP tool's arguments go to the team and the phone: secret-looking values hidden.
          const args = block.name.startsWith('mcp__')
            ? maskSecrets(block.input ?? {})
            : (block.input ?? {});
          if (block.name === 'Bash' && typeof args['command'] === 'string')
            this.running.set(block.id, args['command']);
          this.emit({
            type: 'tool_start',
            id: block.id,
            name: block.name,
            summary: relative(describeClaudeTool(block.name, args), this.root),
            args,
            ...(parent ? { parent } : {}),
          });
        } else if (block.type === 'tool_result' && block.tool_use_id) {
          this.running.delete(block.tool_use_id);
          this.emit({
            type: 'tool_end',
            id: block.tool_use_id,
            ok: block.is_error !== true,
            output: resultText(block.content),
          });
        }
      }
      return;
    }

    if (type === 'result') {
      const usage = (line['usage'] ?? {}) as Record<string, number>;
      const cost = typeof line['total_cost_usd'] === 'number' ? line['total_cost_usd'] : 0;
      this.emit({
        type: 'usage',
        model: this.model,
        kind: 'model',
        estimated: false,
        usage: {
          promptTokens:
            (usage['input_tokens'] ?? 0) +
            (usage['cache_read_input_tokens'] ?? 0) +
            (usage['cache_creation_input_tokens'] ?? 0),
          completionTokens: usage['output_tokens'] ?? 0,
          cachedTokens: usage['cache_read_input_tokens'] ?? 0,
          reasoningTokens: 0,
          cost,
        },
      });
      this.finish(
        line['is_error'] === true ? 'error' : 'done',
        cost,
        line['is_error'] === true
          ? plainClaudeError(
              String(line['result'] ?? line['subtype'] ?? 'Claude Code stopped with an error'),
            )
          : undefined,
      );
    }
  }

  /** An edit Claude Code is still writing: show it being typed, a few times a second. */
  private partial(event: Record<string, unknown> | undefined): void {
    const index = typeof event?.['index'] === 'number' ? event['index'] : -1;
    if (event?.['type'] === 'content_block_start') {
      const block = event['content_block'] as ContentBlock | undefined;
      if (block?.type === 'tool_use' && block.id && block.name && EDIT_TOOLS.has(block.name))
        this.writing.set(index, { id: block.id, name: block.name, json: '', at: 0, text: '' });
      return;
    }
    if (event?.['type'] === 'content_block_stop') {
      this.writing.delete(index);
      return;
    }
    const delta = event?.['delta'] as { type?: string; partial_json?: string } | undefined;
    const call = this.writing.get(index);
    if (!call || delta?.type !== 'input_json_delta' || !delta.partial_json) return;
    call.json += delta.partial_json;
    const now = Date.now();
    if (now - call.at < 80) return;
    const edit = editProgress(call.json);
    if (!edit || edit.text === call.text) return;
    call.at = now;
    call.text = edit.text;
    this.emit({
      type: 'tool_progress',
      id: call.id,
      name: call.name,
      ...edit,
      path: edit.path ? relative(edit.path, this.root) : null,
    });
  }

  /** Ends the turn exactly once (also used when the process exits or is stopped). */
  finish(reason: 'done' | 'stopped' | 'error', cost = 0, error?: string): void {
    if (this.ended) return;
    this.ended = true;
    if (reason !== 'done')
      for (const [toolId, command] of this.running)
        if (isRiskyCommand(command))
          this.emit({
            type: 'outcome_unknown',
            toolId,
            command,
            evidence: `Sent: ${command}\n\nClaude Code was stopped before the command reported back.`,
          });
    this.running.clear();
    if (!this.started) {
      this.started = true;
      this.emit({ type: 'turn_start', turnId: this.turnId, model: 'claude-code' });
    }
    this.emit({ type: 'turn_end', turnId: this.turnId, reason, cost, ...(error ? { error } : {}) });
  }
}

/**
 * Claude Code's own error line in words: its usage limit says when it opens again. The original
 * stays in brackets (its "|<time>" is how the limit's reset is read).
 */
export function plainClaudeError(raw: string): string {
  const limit = /usage limit reached\|(\d{10})/i.exec(raw);
  if (!limit) return raw;
  const at = new Date(Number(limit[1]) * 1000);
  const when = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day =
    at.toDateString() === new Date().toDateString() ? '' : ` on ${at.toLocaleDateString()}`;
  return `Claude Code hit its usage limit: it opens again at ${when}${day}. (Claude said: ${raw})`;
}
