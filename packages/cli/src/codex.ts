import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AgentEvent, PermissionMode } from '@kovan/harness';
import { launch } from './claude.js';

/**
 * Codex as an engine, the way the desktop app runs it: `codex exec --json`, one process per turn, as one of the app's Codex accounts (each in
 * a folder of its own, given to Codex as CODEX_HOME) or the CLI's own sign-in. Nothing to set up: the accounts are the app's.
 */
export const CODEX_MODELS = ['default'] as const;

/** `codex exec` cannot stop and ask mid-run, so Request is read-only like Plan (the desktop does the same). */
export const CODEX_SANDBOX: Record<PermissionMode, string> = {
  plan: 'read-only',
  request: 'read-only',
  allow: 'workspace-write',
  full: 'danger-full-access',
};

export function codexEnv(dataDir: string, id: string | null): Record<string, string> {
  return id ? { CODEX_HOME: join(dataDir, 'agent-accounts', id) } : {};
}

/** `/bin/zsh -lc "ls"` → `ls`, as you would type it. */
export function bareCommand(command: string): string {
  const m = /^\S*\/(?:ba|z)?sh -l?c (.*)$/s.exec(command);
  if (!m) return command;
  const inner = m[1]!;
  if (inner.startsWith('"') && inner.endsWith('"'))
    return inner.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
  if (inner.startsWith("'") && inner.endsWith("'")) return inner.slice(1, -1);
  return inner;
}

interface Item {
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
  query?: string;
  error?: { message?: string } | null;
}

const VERB: Record<string, string> = { add: 'Created', delete: 'Deleted', update: 'Edited' };

/** `codex exec --json` lines as Kovan's events. Pure, so it is tested with recorded lines. */
export class CodexLines {
  threadId: string | null = null;
  private started = false;
  ended = false;
  private readonly open = new Set<string>();
  private lastError: string | null = null;
  constructor(
    private readonly turnId: string,
    private readonly root: string,
    private readonly model: string,
    private readonly emit: (e: AgentEvent) => void,
  ) {}

  private rel(p: string) {
    return this.root && p.startsWith(`${this.root}/`) ? p.slice(this.root.length + 1) : p;
  }
  private start() {
    if (this.started) return;
    this.started = true;
    this.emit({
      type: 'turn_start',
      turnId: this.turnId,
      model: `codex · ${this.model}`,
    } as AgentEvent);
  }

  private toolStart(i: Item) {
    if (this.open.has(i.id)) return;
    let name: string;
    let summary: string;
    let args: Record<string, unknown>;
    switch (i.type) {
      case 'command_execution':
        name = 'run_shell';
        args = { command: bareCommand(i.command ?? '') };
        summary = `Ran ${String(args['command']).split('\n')[0]}`;
        break;
      case 'file_change': {
        name = 'apply_patch';
        const c = i.changes ?? [];
        args = { changes: c };
        summary =
          c.length === 1
            ? `${VERB[c[0]!.kind] ?? 'Changed'} ${this.rel(c[0]!.path)}`
            : `Changed ${c.length} files`;
        break;
      }
      case 'mcp_tool_call':
        name = `mcp__${i.server ?? ''}__${i.tool ?? ''}`;
        args = i.arguments ?? {};
        summary = `Called ${i.server ?? ''} ${i.tool ?? ''}`.trim();
        break;
      case 'web_search':
        name = 'web_search';
        args = { query: i.query ?? '' };
        summary = `Searched the web for ${JSON.stringify(i.query ?? '')}`;
        break;
      default:
        return;
    }
    this.open.add(i.id);
    this.emit({ type: 'tool_start', id: i.id, name, summary, args } as AgentEvent);
  }

  private toolEnd(i: Item) {
    if (!this.open.has(i.id)) this.toolStart(i);
    if (!this.open.delete(i.id)) return;
    let ok = i.status !== 'failed' && i.status !== 'declined';
    let output = '';
    if (i.type === 'command_execution') {
      ok = ok && i.exit_code === 0;
      output = i.aggregated_output ?? '';
    } else if (i.type === 'file_change')
      output = (i.changes ?? []).map((c) => `${c.kind} ${this.rel(c.path)}`).join('\n');
    else if (i.type === 'mcp_tool_call') ok = ok && !i.error;
    this.emit({ type: 'tool_end', id: i.id, ok, output } as AgentEvent);
  }

  push(line: Record<string, unknown>): void {
    const type = line['type'];
    if (type === 'thread.started') {
      if (typeof line['thread_id'] === 'string') this.threadId = line['thread_id'];
      return;
    }
    if (type === 'turn.started') return this.start();
    if (type === 'error') {
      if (typeof line['message'] === 'string') this.lastError = line['message'];
      return;
    }
    if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
      this.start();
      const item = line['item'] as Item | undefined;
      if (!item?.id) return;
      if (type !== 'item.completed') return this.toolStart(item);
      if (item.type === 'agent_message' && item.text)
        this.emit({ type: 'text', text: item.text } as AgentEvent);
      else if (item.type === 'reasoning' && item.text)
        this.emit({ type: 'reasoning', text: item.text } as AgentEvent);
      else this.toolEnd(item);
      return;
    }
    if (type === 'turn.completed') {
      const u = (line['usage'] ?? {}) as Record<string, number>;
      this.emit({
        type: 'usage',
        model: `codex · ${this.model}`,
        kind: 'model',
        estimated: false,
        usage: {
          promptTokens: u['input_tokens'] ?? 0,
          completionTokens: u['output_tokens'] ?? 0,
          cachedTokens: u['cached_input_tokens'] ?? 0,
          reasoningTokens: u['reasoning_output_tokens'] ?? 0,
          // Codex bills your own OpenAI account and reports tokens only.
          cost: null,
        },
      } as AgentEvent);
      this.finish('done');
      return;
    }
    if (type === 'turn.failed') {
      const e = line['error'] as { message?: string } | undefined;
      this.finish('error', e?.message ?? this.lastError ?? 'Codex reported an error');
    }
  }

  finish(reason: 'done' | 'stopped' | 'error', error?: string): void {
    if (this.ended) return;
    this.ended = true;
    this.start();
    for (const id of this.open)
      this.emit({ type: 'tool_end', id, ok: false, output: '' } as AgentEvent);
    this.open.clear();
    const why = reason === 'error' ? (error ?? this.lastError ?? undefined) : undefined;
    this.emit({
      type: 'turn_end',
      turnId: this.turnId,
      reason,
      cost: 0,
      ...(why ? { error: why } : {}),
    } as AgentEvent);
  }
}

export interface CodexTurn {
  binary: string;
  root: string;
  model: string;
  mode: PermissionMode;
  /** Codex's own thread, so the next turn continues the same conversation. */
  threadId: string | null;
  /** Reasoning effort; Codex knows minimal … high, so xhigh and max are high. */
  effort?: string | null;
  env: Record<string, string>;
  baseEnv: Record<string, string | undefined>;
  onEvent: (e: AgentEvent) => void;
}

export class CodexRunner {
  private child: ChildProcess | null = null;
  private stopped = false;

  stop(): void {
    this.stopped = true;
    try {
      this.child?.kill('SIGTERM');
    } catch {
      // already gone
    }
  }

  async send(prompt: string, o: CodexTurn): Promise<string | null> {
    if (this.child) throw new Error('Codex is already running');
    const note =
      o.mode === 'plan'
        ? 'Plan mode: investigate and reply with a step-by-step plan. Do not change files or run commands that change anything.\n\n'
        : '';
    const args = [
      'exec',
      ...(o.threadId ? ['resume', o.threadId] : []),
      '--json',
      '--skip-git-repo-check',
      '-c',
      `sandbox_mode=${JSON.stringify(CODEX_SANDBOX[o.mode])}`,
      ...(o.model && o.model !== 'default' ? ['-m', o.model] : []),
      ...(o.effort && o.effort !== 'none'
        ? [
            '-c',
            `model_reasoning_effort=${JSON.stringify(['xhigh', 'max'].includes(o.effort) ? 'high' : o.effort)}`,
          ]
        : []),
      note + prompt,
    ];
    const lines = new CodexLines(randomUUID(), o.root, o.model, o.onEvent);
    this.stopped = false;
    const run = launch(o.binary, args);
    const child = spawn(run.file, run.args, {
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
          // not a JSON line
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
        err.trim().split('\n').slice(-3).join(' ') || `codex exited with code ${code}`,
      );
    else lines.finish('done');
    return lines.threadId ?? o.threadId;
  }
}
