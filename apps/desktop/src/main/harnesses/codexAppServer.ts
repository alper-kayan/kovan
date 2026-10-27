import type { AgentEvent } from '@kovan/harness';
import {
  CODEX_SANDBOX,
  codexMcpArgs,
  CodexStreamParser,
  execItem,
  NO_TOTALS,
  runJsonLines,
  stopGroup,
  type CodexTotals,
  type ExternalRunner,
} from '@kovan/runner';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { KOVAN_APPEND_PROMPT } from './claudeCode.js';
import type { CodexOptions } from './codex.js';
import { readCodexRateLimits } from './codexLimits.js';

type Steer = { id: string; text: string; fromUserId?: string; fromName?: string };
type Json = Record<string, unknown>;

const PLAN_NOTE =
  'Plan mode: investigate and reply with a step-by-step plan. Do not change files or run commands that change anything.';

/**
 * Runs Codex through its app server (`codex app-server`, JSON-RPC on stdio), one process per
 * turn like `codex exec`, so a teammate's message reaches the running turn (`turn/steer`):
 * Codex takes it at its next step, and the lane says so once it shows up in the thread.
 */
export class CodexAppServerRunner implements ExternalRunner {
  private child: ChildProcess | null = null;
  private stopped = false;
  private totals: CodexTotals = NO_TOTALS;
  private next = 0;
  private readonly calls = new Map<number, (reply: Json) => void>();
  private thread: string | null = null;
  private turn: string | null = null;
  /** Messages handed to the running turn, until Codex shows them in the thread. */
  private steers = new Map<string, Steer>();
  private onEvent: (event: AgentEvent) => void;

  constructor(private options: CodexOptions) {
    this.onEvent = options.onEvent;
  }

  get running(): boolean {
    return this.child !== null;
  }

  configure(patch: Partial<Pick<CodexOptions, 'model' | 'mode'>>): void {
    this.options = { ...this.options, ...patch };
  }

  stop(): void {
    this.stopped = true;
    if (this.thread && this.turn)
      this.request('turn/interrupt', { threadId: this.thread, turnId: this.turn });
    const child = this.child;
    setTimeout(() => stopGroup(child), 1500).unref();
  }

  /** A teammate's message for the running turn: true when it was handed over. */
  steer(steer: Steer): boolean {
    if (!this.child || !this.thread || !this.turn) return false;
    const who = steer.fromName ? ` from ${steer.fromName}` : '';
    this.steers.set(steer.id, steer);
    void this.request('turn/steer', {
      threadId: this.thread,
      expectedTurnId: this.turn,
      clientUserMessageId: steer.id,
      input: [{ type: 'text', text: `Message${who} while you work: ${steer.text}` }],
    }).then((reply) => {
      // The turn ended first (or Codex refused it): it goes back to whoever wrote it.
      if (reply['error'] && this.steers.delete(steer.id))
        this.onEvent({ type: 'steer', ...steer, status: 'returned' });
    });
    return true;
  }

  private request(method: string, params: Json): Promise<Json> {
    const id = ++this.next;
    return new Promise((resolve) => {
      if (!this.child?.stdin?.writable) return resolve({ error: { message: 'Codex exited' } });
      this.calls.set(id, resolve);
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async send(prompt: string): Promise<void> {
    if (this.child) throw new Error('Codex is already working');
    const o = this.options;
    const parser = new CodexStreamParser(
      randomUUID(),
      o.root,
      o.model === 'default' ? 'default' : o.model,
      o.onEvent,
      this.totals,
    );
    this.stopped = false;
    this.steers = new Map();
    let total: Json | null = null;
    let lastError: string | null = null;
    let finished: (() => void) | null = null;
    const turnDone = new Promise<void>((resolve) => (finished = resolve));

    const onLine = (m: Json) => {
      const id = m['id'];
      const method = typeof m['method'] === 'string' ? m['method'] : null;
      if (typeof id === 'number' && !method) {
        this.calls.get(id)?.(m);
        this.calls.delete(id);
        return;
      }
      // Codex asking something (approvals never come: it runs with "never").
      if (id !== undefined && method) {
        this.child?.stdin?.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: 'Kovan answers no requests here' },
          }) + '\n',
        );
        return;
      }
      const p = (m['params'] ?? {}) as Json;
      switch (method) {
        case 'turn/started':
          parser.push({ type: 'turn.started' });
          return;
        case 'item/started':
        case 'item/completed': {
          const item = (p['item'] ?? {}) as Json;
          // A teammate's message reached the thread: Codex has it now.
          if (item['type'] === 'userMessage' && typeof item['clientId'] === 'string') {
            const steer = this.steers.get(item['clientId']);
            if (steer && this.steers.delete(steer.id))
              this.onEvent({ type: 'steer', ...steer, status: 'delivered' });
            return;
          }
          const exec = execItem(item);
          if (exec)
            parser.push({
              type: method === 'item/started' ? 'item.started' : 'item.completed',
              item: exec,
            });
          return;
        }
        case 'thread/tokenUsage/updated':
          total = ((p['tokenUsage'] as Json | undefined)?.['total'] as Json | undefined) ?? total;
          return;
        case 'error': {
          const error = p['error'] as Json | undefined;
          if (typeof error?.['message'] === 'string') lastError = error['message'];
          parser.push({ type: 'error', message: lastError ?? 'Codex error' });
          return;
        }
        case 'turn/completed': {
          const turn = (p['turn'] ?? {}) as Json;
          if (turn['status'] === 'failed') {
            const error = turn['error'] as Json | undefined;
            parser.push({
              type: 'turn.failed',
              error: { message: error?.['message'] ?? lastError ?? 'Codex stopped with an error' },
            });
          } else if (turn['status'] !== 'interrupted') {
            parser.push({
              type: 'turn.completed',
              usage: {
                input_tokens: total?.['inputTokens'] ?? 0,
                cached_input_tokens: total?.['cachedInputTokens'] ?? 0,
                output_tokens: total?.['outputTokens'] ?? 0,
                reasoning_output_tokens: total?.['reasoningOutputTokens'] ?? 0,
              },
            });
          }
          finished?.();
          return;
        }
      }
    };

    const run = runJsonLines(
      o.binary,
      ['app-server', '-c', 'approval_policy="never"', ...codexMcpArgs(o.mcpServer)],
      { cwd: o.root, pathEnv: o.pathEnv, name: 'Codex', input: true, env: o.env ?? {} },
      onLine,
    );
    this.child = run.child;
    run.child.stdin?.on('error', () => undefined);
    const exited = run.done.then((error) => {
      // Codex is gone: nothing it was asked will be answered now.
      for (const reply of this.calls.values())
        reply({ error: { message: error ?? 'Codex exited' } });
      this.calls.clear();
      finished?.();
      return error;
    });

    let failure: string | undefined;
    try {
      const init = await this.request('initialize', {
        clientInfo: { name: 'kovan', title: 'Kovan', version: '1' },
      });
      if (init['error']) throw new Error(String((init['error'] as Json)['message']));
      this.child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
      const settings = {
        cwd: o.root,
        sandbox: CODEX_SANDBOX[o.mode],
        approvalPolicy: 'never',
        model: o.model && o.model !== 'default' ? o.model : null,
      };
      const opened = await this.request(
        o.threadId ? 'thread/resume' : 'thread/start',
        o.threadId ? { ...settings, threadId: o.threadId } : settings,
      );
      const thread = ((opened['result'] as Json | undefined)?.['thread'] as Json | undefined)?.[
        'id'
      ];
      if (typeof thread !== 'string')
        throw new Error(
          String((opened['error'] as Json | undefined)?.['message'] ?? 'Codex opened no thread'),
        );
      this.thread = thread;
      parser.push({ type: 'thread.started', thread_id: thread });
      const started = await this.request('turn/start', {
        threadId: thread,
        input: [
          {
            type: 'text',
            text: [
              // On the first turn only, as with `codex exec`.
              ...(o.threadId ? [] : [KOVAN_APPEND_PROMPT]),
              ...(o.mode === 'plan' ? [PLAN_NOTE] : []),
              prompt,
            ].join('\n\n'),
          },
        ],
      });
      const turn = ((started['result'] as Json | undefined)?.['turn'] as Json | undefined)?.['id'];
      if (typeof turn !== 'string')
        throw new Error(
          String((started['error'] as Json | undefined)?.['message'] ?? 'Codex started no turn'),
        );
      this.turn = turn;
      await turnDone;
    } catch (error) {
      failure = (error as Error).message;
    }
    this.turn = null;
    stopGroup(this.child);
    const exitError = await exited;
    this.child = null;
    this.totals = parser.totals;
    // What Codex never took goes back to whoever wrote it.
    for (const steer of this.steers.values())
      this.onEvent({ type: 'steer', ...steer, status: 'returned' });
    this.steers.clear();
    if (parser.threadId && parser.threadId !== o.threadId) {
      o.threadId = parser.threadId;
      o.onThread(parser.threadId);
    }
    if (o.threadId && o.onLimit) {
      const limits = await readCodexRateLimits(o.threadId, o.env?.['CODEX_HOME']).catch(() => null);
      if (limits) o.onLimit(limits);
    }
    if (this.stopped) parser.finish('stopped');
    else if (failure) parser.finish('error', failure);
    // Codex went away before the turn ended: that is an error, not a finished turn.
    else if (!parser.finished) parser.finish('error', exitError ?? 'Codex exited mid-turn');
  }
}

export { codexHasAppServer, execItem } from '@kovan/runner';
