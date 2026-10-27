import type { AgentEvent, ApprovalRequest } from '@kovan/harness';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { runJsonLines, stopGroup } from '../claude/process.js';
import type { ToolBridge } from '../claude/toolBridge.js';
import type { DetachedRun, LiveAgent } from '../run.js';
import { CODEX_SANDBOX, codexMcpArgs, type McpServerSpec } from './args.js';
import { execItem } from './items.js';
import { bareCommand, CodexStreamParser } from './stream.js';

type TurnEnd = Extract<AgentEvent, { type: 'turn_end' }>;
type Json = Record<string, unknown>;
type Steer = { id: string; text: string; fromUserId?: string; fromName?: string };

const PROMPT =
  "You are an AI teammate in a Kovan swarm, working unattended on this machine for your team. Use the kovan MCP tools your task names. Commands are limited to checks (tests, linters, type checks, builds) and reading; anything else is declined, so don't try to push, commit, install or reach the network.";

const PLAN_NOTE =
  'Plan mode: investigate and reply. Do not change files or run commands that change anything.';

/** How often a long turn hears the team's work again, at most (when it changed). */
const NOTE_REFRESH_MS = 20_000;

export interface CodexDetachedOptions {
  /** The `codex` CLI (one with `codex app-server`). */
  binary: string;
  /** The loopback bridge the MCP server inside Codex calls for the run's tools. */
  bridge: ToolBridge;
  /** The MCP server script (`@kovan/runner/claude-mcp`: the same bridge client). */
  mcpEntry: string;
  /** Node (or the app itself run as Node) to start the MCP server with. */
  nodePath: string;
  pathEnv: string;
}

/**
 * Runs Codex on one swarm task through its app server (`codex app-server`, JSON-RPC on stdio),
 * with nobody at the machine: the run's own tools come over Kovan's MCP bridge, commands run in
 * Codex's sandbox (no network, writes only in its copy) and one that asks to leave it is
 * answered by the machine's policy, teammates' messages reach the running turn (`turn/steer`),
 * and the team's work is told to it as it changes. A file change Codex asks about is checked
 * against others' work first; one it makes without asking is checked right after, and Codex
 * hears about a collision at once. Costs are the person's Codex plan.
 */
export async function runCodexDetached(
  run: DetachedRun,
  o: CodexDetachedOptions,
): Promise<TurnEnd> {
  /** Messages handed to the running turn, until Codex shows them in the thread. */
  const steers = new Map<string, Steer>();
  const { id, unregister } = o.bridge.register({
    root: run.root,
    tools: run.tools ?? [],
    approve: (request) => run.approve(request),
    signal: run.signal,
    pending: () => steers.size,
  });
  const mcp: McpServerSpec = {
    command: o.nodePath,
    args: [o.mcpEntry],
    env: {
      KOVAN_BRIDGE_FILE: o.bridge.file,
      KOVAN_RUN_ID: id,
      // Started by the desktop app, "node" is the app itself run as Node.
      ...(process.versions['electron'] ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
  };
  const model = /^(?:openai\/|codex\/)?(gpt-[\w.-]+|o\d[\w.-]*)$/.exec(run.model)?.[1] ?? null;
  let end: TurnEnd | null = null;
  const parser = new CodexStreamParser(randomUUID(), run.root, model ?? 'default', (event) => {
    // The person's Codex plan pays: nothing counts against Kovan budgets.
    if (event.type === 'usage') event = { ...event, usage: { ...event.usage, cost: 0 } };
    if (event.type === 'turn_end') end = event;
    run.onEvent(event);
  });

  let child: ChildProcess | null = null;
  let thread: string | null = null;
  let turn: string | null = null;
  let next = 0;
  const calls = new Map<number, (reply: Json) => void>();
  const write = (message: Json) => child?.stdin?.write(JSON.stringify(message) + '\n');
  const request = (method: string, params: Json): Promise<Json> =>
    new Promise((resolve) => {
      if (!child?.stdin?.writable) return resolve({ error: { message: 'Codex exited' } });
      const n = ++next;
      calls.set(n, resolve);
      write({ jsonrpc: '2.0', id: n, method, params });
    });
  /** Something for the model from Kovan, not from a teammate (a held write, the team's work). */
  const tell = (text: string) => {
    if (thread && turn)
      void request('turn/steer', {
        threadId: thread,
        expectedTurnId: turn,
        clientUserMessageId: randomUUID(),
        input: [{ type: 'text', text }],
      });
  };

  // The files each change item is about, from when it starts (approvals name only the item).
  const changes = new Map<string, string[]>();
  const relative = (path: string) =>
    path.startsWith(`${run.root}/`) ? path.slice(run.root.length + 1) : path;
  /** Why a change to these files waits, or null: a new message first, then others' work. */
  const held = async (paths: string[]): Promise<string | null> => {
    if (steers.size)
      return 'Held this change: a new message came in while you worked. Read it (it comes with your next step), then make the change again if it still applies.';
    for (const path of paths) {
      const note = await run.checkWrite?.(path).catch(() => null);
      if (note) return note;
    }
    return null;
  };

  let note: { text: string; at: number } | null = null;
  const refreshNote = async () => {
    if (!run.turnContext || (note && Date.now() - note.at < NOTE_REFRESH_MS)) return;
    const text = await run.turnContext().catch(() => null);
    const changed = text && text !== note?.text;
    note = { text: text ?? note?.text ?? '', at: Date.now() };
    if (changed) tell(`Update from Kovan on the team's work:\n${text}`);
  };

  /** Codex asks: run this command, apply this change. The machine's policy answers. */
  const answer = async (method: string, p: Json): Promise<Json | null> => {
    if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
      const raw = p['command'];
      const command = bareCommand(Array.isArray(raw) ? raw.join(' ') : String(raw ?? ''));
      const asked: ApprovalRequest = {
        id: String(p['itemId'] ?? p['callId'] ?? randomUUID()),
        tool: 'shell',
        kind: 'command',
        title: 'Run this?',
        detail: command,
      };
      const ok = await run.approve(asked).catch(() => false);
      return method === 'execCommandApproval'
        ? {
            decision: ok
              ? 'approved'
              : { denied: { rejection: 'Only checks and reading run on this machine.' } },
          }
        : { decision: ok ? 'accept' : 'decline' };
    }
    if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
      const paths =
        method === 'applyPatchApproval'
          ? Object.keys((p['fileChanges'] as Json | undefined) ?? {}).map(relative)
          : (changes.get(String(p['itemId'] ?? '')) ?? []);
      const why = run.mode === 'plan' ? 'Plan mode: no changes.' : await held(paths);
      if (why && method === 'item/fileChange/requestApproval') tell(why);
      return method === 'applyPatchApproval'
        ? { decision: why ? { denied: { rejection: why } } : 'approved' }
        : { decision: why ? 'decline' : 'accept' };
    }
    return null;
  };

  let lastError: string | null = null;
  let total: Json | null = null;
  let finished: (() => void) | null = null;
  const turnDone = new Promise<void>((resolve) => (finished = resolve));
  const onLine = (m: Json) => {
    const n = m['id'];
    const method = typeof m['method'] === 'string' ? m['method'] : null;
    if (typeof n === 'number' && !method) {
      calls.get(n)?.(m);
      calls.delete(n);
      return;
    }
    if (n !== undefined && method) {
      void answer(method, (m['params'] ?? {}) as Json).then((result) =>
        write(
          result
            ? { jsonrpc: '2.0', id: n, result }
            : {
                jsonrpc: '2.0',
                id: n,
                error: { code: -32601, message: 'Kovan answers no such request' },
              },
        ),
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
          const steer = steers.get(item['clientId']);
          if (steer && steers.delete(steer.id))
            run.onEvent({ type: 'steer', ...steer, status: 'delivered' });
          return;
        }
        if (item['type'] === 'fileChange') {
          const paths = ((item['changes'] as Json[] | undefined) ?? []).map((c) =>
            relative(String(c['path'] ?? '')),
          );
          changes.set(String(item['id'] ?? ''), paths);
          // Made without asking: checked now, and Codex hears at once if it collides.
          if (method === 'item/completed' && item['status'] === 'completed' && run.checkWrite)
            void (async () => {
              for (const path of paths) {
                const why = await run.checkWrite!(path).catch(() => null);
                if (why)
                  return tell(`${why}\n(You changed it already: check with them, or undo it.)`);
              }
            })();
        }
        const exec = execItem(item);
        if (exec)
          parser.push({
            type: method === 'item/started' ? 'item.started' : 'item.completed',
            item: exec,
          });
        if (method === 'item/completed' && exec) void refreshNote();
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
        const t = (p['turn'] ?? {}) as Json;
        if (t['status'] === 'failed') {
          const error = t['error'] as Json | undefined;
          parser.push({
            type: 'turn.failed',
            error: { message: error?.['message'] ?? lastError ?? 'Codex stopped with an error' },
          });
        } else if (t['status'] !== 'interrupted')
          parser.push({
            type: 'turn.completed',
            usage: {
              input_tokens: total?.['inputTokens'] ?? 0,
              cached_input_tokens: total?.['cachedInputTokens'] ?? 0,
              output_tokens: total?.['outputTokens'] ?? 0,
              reasoning_output_tokens: total?.['reasoningOutputTokens'] ?? 0,
            },
          });
        finished?.();
        return;
      }
    }
  };

  const proc = runJsonLines(
    o.binary,
    ['app-server', '-c', 'approval_policy="on-request"', ...codexMcpArgs(mcp)],
    { cwd: run.root, pathEnv: o.pathEnv, name: 'Codex', input: true },
    onLine,
  );
  child = proc.child;
  child.stdin?.on('error', () => undefined);
  const exited = proc.done.then((error) => {
    // Codex is gone: nothing it was asked will be answered now.
    for (const reply of calls.values()) reply({ error: { message: error ?? 'Codex exited' } });
    calls.clear();
    finished?.();
    return error;
  });
  let stopped = false;
  const stop = () => {
    stopped = true;
    if (thread && turn) void request('turn/interrupt', { threadId: thread, turnId: turn });
    const c = child;
    setTimeout(() => stopGroup(c), 1500).unref();
  };
  run.signal.addEventListener('abort', stop, { once: true });
  const live: LiveAgent = {
    get running() {
      return Boolean(child && thread && turn);
    },
    steer: (s) => {
      if (!child || !thread || !turn) return false;
      const who = s.fromName ? ` from ${s.fromName}` : '';
      steers.set(s.id, s);
      void request('turn/steer', {
        threadId: thread,
        expectedTurnId: turn,
        clientUserMessageId: s.id,
        input: [{ type: 'text', text: `Message${who} while you work: ${s.text}` }],
      }).then((reply) => {
        // The turn ended first (or Codex refused it): it goes back to whoever wrote it.
        if (reply['error'] && steers.delete(s.id))
          run.onEvent({ type: 'steer', ...s, status: 'returned' });
      });
      return true;
    },
    stop,
  };

  let failure: string | undefined;
  try {
    const init = await request('initialize', {
      clientInfo: { name: 'kovan-agentd', title: 'Kovan', version: '1' },
    });
    if (init['error']) throw new Error(String((init['error'] as Json)['message']));
    write({ jsonrpc: '2.0', method: 'initialized' });
    const opened = await request('thread/start', {
      cwd: run.root,
      // Nobody watches here: never Full's open sandbox.
      sandbox: CODEX_SANDBOX[run.mode === 'full' ? 'allow' : run.mode],
      approvalPolicy: 'on-request',
      model,
    });
    const t = ((opened['result'] as Json | undefined)?.['thread'] as Json | undefined)?.['id'];
    if (typeof t !== 'string')
      throw new Error(
        String((opened['error'] as Json | undefined)?.['message'] ?? 'Codex opened no thread'),
      );
    thread = t;
    parser.push({ type: 'thread.started', thread_id: t });
    const first = run.turnContext ? await run.turnContext().catch(() => null) : null;
    if (first) note = { text: first, at: Date.now() };
    const started = await request('turn/start', {
      threadId: t,
      input: [
        {
          type: 'text',
          text: [
            PROMPT,
            ...(run.mode === 'plan' ? [PLAN_NOTE] : []),
            run.task,
            ...(first ? [first] : []),
          ].join('\n\n'),
        },
      ],
    });
    const tid = ((started['result'] as Json | undefined)?.['turn'] as Json | undefined)?.['id'];
    if (typeof tid !== 'string')
      throw new Error(
        String((started['error'] as Json | undefined)?.['message'] ?? 'Codex started no turn'),
      );
    turn = tid;
    run.onAgent?.(live);
    await turnDone;
  } catch (error) {
    failure = (error as Error).message;
  }
  turn = null;
  stopGroup(child);
  const exitError = await exited;
  child = null;
  run.signal.removeEventListener('abort', stop);
  unregister();
  // What Codex never took goes back to whoever wrote it.
  for (const steer of steers.values()) run.onEvent({ type: 'steer', ...steer, status: 'returned' });
  steers.clear();
  if (stopped || run.signal.aborted) parser.finish('stopped');
  else if (failure) parser.finish('error', failure);
  else if (!parser.finished) parser.finish('error', exitError ?? 'Codex exited mid-turn');
  return (
    end ?? { type: 'turn_end', turnId: '', reason: 'error', cost: 0, error: 'Codex did not finish' }
  );
}
