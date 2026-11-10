import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { AgentEvent, PermissionMode } from '@kovan/harness';

/**
 * Claude Code as one of Kovan's engines, the way the desktop app runs it: `claude -p --output-format stream-json`, one process per turn,
 * signed in as one of the accounts listed in the app (`agent-accounts.json`; each keeps its sign-in in a folder of its own, which the CLI is
 * pointed at with CLAUDE_CONFIG_DIR). Nothing is sent anywhere else: the sign-in stays with Claude Code.
 */
export interface ClaudeAccount {
  /** null is the CLI's own sign-in (~/.claude). */
  id: string | null;
  name: string;
}

export const CLAUDE_MODELS = ['default', 'sonnet', 'opus', 'haiku'] as const;

/** The accounts added in the desktop app. Like the app, the CLI's own sign-in (~/.claude, ~/.codex) is never used. */
export function claudeAccounts(dataDir: string, harness = 'claude-code'): ClaudeAccount[] {
  const out: ClaudeAccount[] = [];
  try {
    const list = JSON.parse(readFileSync(join(dataDir, 'agent-accounts.json'), 'utf8')) as {
      id?: unknown;
      harness?: unknown;
      name?: unknown;
    }[];
    for (const a of list)
      if (
        a.harness === harness &&
        typeof a.id === 'string' &&
        /^[a-z0-9-]{1,64}$/i.test(a.id) &&
        typeof a.name === 'string'
      )
        out.push({ id: a.id, name: a.name });
  } catch {
    // no accounts registered
  }
  return out;
}

export function claudeEnv(dataDir: string, id: string | null): Record<string, string> {
  return id ? { CLAUDE_CONFIG_DIR: join(dataDir, 'agent-accounts', id) } : {};
}

/** The `claude` program, from PATH or the usual places. Null when it is not installed. */
export function findClaude(env: Record<string, string | undefined>, home: string): string | null {
  return findBinary('claude', env, home);
}

/** A program from PATH or the usual places; null when it is not installed. */
export function findBinary(
  name: string,
  env: Record<string, string | undefined>,
  home: string,
): string | null {
  const dirs = [
    ...(env['PATH'] ?? '').split(delimiter),
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    join(home, '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ].filter(Boolean);
  for (const d of dirs) {
    const f = join(d, name);
    if (existsSync(f)) return f;
  }
  return null;
}

export const CLAUDE_PERMISSION: Record<PermissionMode, string> = {
  plan: 'plan',
  request: 'default',
  allow: 'acceptEdits',
  full: 'bypassPermissions',
};

interface Block {
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

const str = (v: unknown) => (typeof v === 'string' ? v : '');

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

/** Claude Code's tool, in the names and arguments the screen already knows how to draw (diffs, commands). */
export function mapTool(
  name: string,
  input: Record<string, unknown>,
  root: string,
): { name: string; summary: string; args: Record<string, unknown> } {
  const rel = (p: string) => (root && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p);
  const path = rel(str(input['file_path']) || str(input['path']));
  switch (name) {
    case 'Read':
      return { name: 'read_file', summary: `Read ${path}`, args: { path } };
    case 'Edit':
      return {
        name: 'edit_file',
        summary: `Edited ${path}`,
        args: { path, old_string: str(input['old_string']), new_string: str(input['new_string']) },
      };
    case 'Write':
      return {
        name: 'write_file',
        summary: `Wrote ${path}`,
        args: { path, content: str(input['content']) },
      };
    case 'Bash':
      return {
        name: 'run_shell',
        summary: `Ran ${str(input['command']).split('\n')[0]}`,
        args: { command: str(input['command']) },
      };
    case 'Glob':
      return { name, summary: `Listed ${str(input['pattern'])}`, args: input };
    case 'Grep':
      return {
        name,
        summary: `Searched for ${JSON.stringify(input['pattern'] ?? '')}`,
        args: input,
      };
    case 'TodoWrite':
      return { name, summary: 'Updated its todo list', args: input };
    case 'Task':
    case 'Agent':
      return { name, summary: `Delegated ${str(input['description']) || 'a task'}`, args: input };
    default:
      return {
        name,
        summary: name.startsWith('mcp__')
          ? `Called ${name.split('__').slice(1).join(' ')}`
          : `Used ${name}`,
        args: input,
      };
  }
}

/** Claude Code's stream-json lines as Kovan's events. Pure, so it can be tested with recorded lines. */
export class ClaudeLines {
  sessionId: string | null = null;
  model: string | null = null;
  private started = false;
  ended = false;
  constructor(
    private readonly turnId: string,
    private readonly root: string,
    private readonly emit: (e: AgentEvent) => void,
  ) {}

  private start() {
    if (this.started) return;
    this.started = true;
    this.emit({
      type: 'turn_start',
      turnId: this.turnId,
      model: `claude-code · ${this.model ?? 'default'}`,
    } as AgentEvent);
  }

  push(line: Record<string, unknown>): void {
    if (typeof line['session_id'] === 'string') this.sessionId = line['session_id'];
    const type = line['type'];
    if (type === 'system' && line['subtype'] === 'init') {
      this.model = str(line['model']) || null;
      this.start();
      return;
    }
    if (type === 'assistant' || type === 'user') {
      if (line['parent_tool_use_id']) return; // a helper's own steps stay out of the lane
      this.start();
      const blocks = (line['message'] as { content?: Block[] } | undefined)?.content ?? [];
      for (const b of Array.isArray(blocks) ? blocks : []) {
        if (b.type === 'text' && b.text) this.emit({ type: 'text', text: b.text } as AgentEvent);
        else if (b.type === 'thinking' && b.thinking)
          this.emit({ type: 'reasoning', text: b.thinking } as AgentEvent);
        else if (b.type === 'tool_use' && b.id && b.name) {
          const m = mapTool(b.name, b.input ?? {}, this.root);
          this.emit({ type: 'tool_start', id: b.id, ...m } as AgentEvent);
        } else if (b.type === 'tool_result' && b.tool_use_id)
          this.emit({
            type: 'tool_end',
            id: b.tool_use_id,
            ok: b.is_error !== true,
            output: resultText(b.content),
          } as AgentEvent);
      }
      return;
    }
    if (type === 'result') {
      const u = (line['usage'] ?? {}) as Record<string, number>;
      const cost = typeof line['total_cost_usd'] === 'number' ? line['total_cost_usd'] : 0;
      this.start();
      this.emit({
        type: 'usage',
        model: this.model,
        kind: 'model',
        estimated: false,
        usage: {
          promptTokens:
            (u['input_tokens'] ?? 0) +
            (u['cache_read_input_tokens'] ?? 0) +
            (u['cache_creation_input_tokens'] ?? 0),
          completionTokens: u['output_tokens'] ?? 0,
          cachedTokens: u['cache_read_input_tokens'] ?? 0,
          reasoningTokens: 0,
          cost,
        },
      } as AgentEvent);
      const bad = line['is_error'] === true;
      this.finish(
        bad ? 'error' : 'done',
        cost,
        bad ? str(line['result']) || 'Claude Code reported an error' : undefined,
      );
    }
  }

  finish(reason: 'done' | 'stopped' | 'error', cost = 0, error?: string): void {
    if (this.ended) return;
    this.ended = true;
    this.start();
    this.emit({
      type: 'turn_end',
      turnId: this.turnId,
      reason,
      cost,
      ...(error ? { error } : {}),
    } as AgentEvent);
  }
}

export interface ClaudeTurn {
  binary: string;
  root: string;
  model: string;
  mode: PermissionMode;
  /** Claude Code's own session, so the next turn continues the same conversation. */
  sessionId: string | null;
  /** Reasoning effort; Claude Code takes low … max, so none and minimal are left to its default. */
  effort?: string | null;
  env: Record<string, string>;
  baseEnv: Record<string, string | undefined>;
  onEvent: (e: AgentEvent) => void;
}

/** One turn: runs `claude`, streams its events, resolves with the session to continue from. */
export class ClaudeRunner {
  private child: ChildProcess | null = null;
  private stopped = false;

  get running(): boolean {
    return this.child !== null;
  }

  stop(): void {
    this.stopped = true;
    try {
      this.child?.kill('SIGTERM');
    } catch {
      // already gone
    }
  }

  async send(prompt: string, o: ClaudeTurn): Promise<string | null> {
    if (this.child) throw new Error('Claude Code is already running');
    const session = o.sessionId ?? randomUUID();
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      CLAUDE_PERMISSION[o.mode],
      ...(o.model && o.model !== 'default' ? ['--model', o.model] : []),
      ...(o.effort && ['low', 'medium', 'high', 'xhigh', 'max'].includes(o.effort)
        ? ['--effort', o.effort]
        : []),
      ...(o.sessionId ? ['--resume', o.sessionId] : ['--session-id', session]),
      '--',
      prompt,
    ];
    const lines = new ClaudeLines(randomUUID(), o.root, o.onEvent);
    this.stopped = false;
    const child = spawn(o.binary, args, {
      cwd: o.root,
      env: { ...o.baseEnv, ...o.env } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    let buf = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!raw) continue;
        try {
          lines.push(JSON.parse(raw) as Record<string, unknown>);
        } catch {
          // not a JSON line: ignore
        }
      }
    });
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    const code = await new Promise<number | null>((resolve) => {
      child.on('error', (e) => {
        err += e.message;
        resolve(-1);
      });
      child.on('close', (c) => resolve(c));
    });
    this.child = null;
    if (this.stopped) lines.finish('stopped');
    else if (code !== 0)
      lines.finish(
        'error',
        0,
        err.trim().split('\n').slice(-3).join(' ') || `claude exited with code ${code}`,
      );
    else lines.finish('done');
    return lines.sessionId ?? session;
  }
}
