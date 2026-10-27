import type { AgentEvent, Tool } from '@kovan/harness';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commandAllowed } from '../commandPolicy.js';
import type { LiveAgent } from '../run.js';
import { claudeModel, runClaudeDetached } from './detached.js';
import { asApproval, ToolBridge } from './toolBridge.js';

let dir: string;
let bridge: ToolBridge;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kovan-claude-'));
  bridge = new ToolBridge(join(dir, 'bridge.json'));
  await bridge.start();
});
afterAll(async () => {
  await bridge.stop();
  await rm(dir, { recursive: true, force: true });
});

describe('Claude Code for a swarm task', () => {
  it("runs on the person's subscription with the run's tools and the machine's policy", async () => {
    const assigned: unknown[] = [];
    const assign: Tool = {
      spec: { name: 'assign_tasks', description: 'Split the goal', parameters: { type: 'object' } },
      kind: 'read',
      describe: () => 'Assigned tasks',
      run: async (args) => {
        assigned.push(args);
        return { ok: true, output: 'Assigned 1 task' };
      },
    };
    const events: AgentEvent[] = [];
    const decided: { task: string; questions: unknown }[] = [];
    const end = await runClaudeDetached(
      {
        root: dir,
        model: 'anthropic/claude-sonnet-5.5',
        effort: null,
        mode: 'full',
        task: 'Split the goal',
        tools: [assign],
        approve: async (r) => r.kind === 'command' && commandAllowed(r.detail),
        onEvent: (e) => events.push(e),
        signal: new AbortController().signal,
      },
      {
        binary: join(import.meta.dirname, 'test', 'fake-claude.mjs'),
        dataDir: dir,
        bridge,
        mcpEntry: join(import.meta.dirname, '..', '..', 'dist', 'claude', 'mcpRun.js'),
        nodePath: process.execPath,
        pathEnv: process.env['PATH'] ?? '',
        decide: async (task, questions) => {
          decided.push({ task, questions });
          return 'Which store? → Postgres (the repo already uses it)';
        },
      },
    );
    expect(end, JSON.stringify(end)).toMatchObject({ reason: 'done', cost: 0 });
    const said = JSON.parse(
      events
        .filter((e): e is Extract<AgentEvent, { type: 'text' }> => e.type === 'text')
        .filter((e) => e.text.startsWith('{'))
        .map((e) => e.text)
        .join(''),
    );
    expect(said.tools).toEqual(['approval_prompt', 'assign_tasks']);
    expect(said.assign).toBe('Assigned 1 task');
    expect(assigned).toEqual([{ tasks: [{ id: 'a', title: 'A' }] }]);
    // The machine's policy answers Claude Code's permission prompts.
    expect([said.test, said.push]).toEqual(['allow', 'deny']);
    // Its own Kovan tools never need a yes.
    expect(said.own).toBe('allow');
    // A question has nobody to answer it: Kovan decides, tells the agent and shows it in the lane.
    expect(decided).toEqual([{ task: 'Split the goal', questions: [] }]);
    expect(said.ask.message).toContain('Kovan answered for them: Which store? → Postgres');
    expect(
      events.some((e) => e.type === 'text' && e.text.includes('Kovan answered a question')),
    ).toBe(true);
    // Full is never used unattended; the model becomes Claude Code's alias; only Kovan's tools.
    const args = said.args as string[];
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
    expect(args).toContain('--strict-mcp-config');
    // The subscription pays: nothing counts against Kovan budgets.
    const usage = events.find((e) => e.type === 'usage') as { usage: { cost: number } };
    expect(usage.usage.cost).toBe(0);
  });

  it('lets JevRouter pick the model for a teammate set to it, and shows the choice', async () => {
    const events: AgentEvent[] = [];
    await runClaudeDetached(
      {
        root: dir,
        model: 'kovan/jevrouter',
        effort: null,
        mode: 'allow',
        task: 'Your task: Fix the typo in the README title',
        tools: [
          {
            spec: { name: 'assign_tasks', description: 'x', parameters: { type: 'object' } },
            kind: 'read',
            describe: () => 'x',
            run: async () => ({ ok: true, output: 'ok' }),
          },
        ],
        approve: async () => false,
        onEvent: (e) => events.push(e),
        signal: new AbortController().signal,
      },
      {
        binary: join(import.meta.dirname, 'test', 'fake-claude.mjs'),
        dataDir: dir,
        bridge,
        mcpEntry: join(import.meta.dirname, '..', '..', 'dist', 'claude', 'mcpRun.js'),
        nodePath: process.execPath,
        pathEnv: process.env['PATH'] ?? '',
      },
    );
    expect(events.find((e) => e.type === 'route')).toMatchObject({
      decision: { model: 'claude-code/haiku', tier: 'economy' },
    });
    const said = JSON.parse(
      events
        .filter((e): e is Extract<AgentEvent, { type: 'text' }> => e.type === 'text')
        .filter((e) => e.text.startsWith('{'))
        .map((e) => e.text)
        .join(''),
    );
    expect(said.args[said.args.indexOf('--model') + 1]).toBe('haiku');
  });

  it('hands messages from teammates to the running turn, and says when they arrived', async () => {
    const events: AgentEvent[] = [];
    let live: LiveAgent | undefined;
    const end = await runClaudeDetached(
      {
        root: dir,
        model: 'anthropic/claude-haiku-5.5',
        effort: null,
        mode: 'allow',
        task: 'Your task: Add totals',
        approve: async () => false,
        onEvent: (e) => events.push(e),
        signal: new AbortController().signal,
        onAgent: (agent) => {
          live = agent;
          // Owen writes while it works.
          setTimeout(
            () => agent.steer({ id: 'm1', text: 'cart.ts changed', fromName: 'Owen' }),
            50,
          );
        },
      },
      {
        binary: join(import.meta.dirname, 'test', 'fake-claude-live.mjs'),
        dataDir: dir,
        bridge,
        mcpEntry: join(import.meta.dirname, '..', '..', 'dist', 'claude', 'mcpRun.js'),
        nodePath: process.execPath,
        pathEnv: process.env['PATH'] ?? '',
      },
    );
    expect(end.reason).toBe('done');
    const text = events
      .filter((e): e is Extract<AgentEvent, { type: 'text' }> => e.type === 'text')
      .map((e) => e.text)
      .join('');
    expect(text).toBe(
      'heard: Your task: Add totals | Message from Owen while you work: cart.ts changed',
    );
    expect(events.find((e) => e.type === 'steer')).toMatchObject({
      id: 'm1',
      status: 'delivered',
    });
    // Its turn is over: later messages wait for its next one.
    expect(live!.running).toBe(false);
    expect(live!.steer({ id: 'm2', text: 'late' })).toBe(false);
  });

  it("asks Kovan before each write and gives it the team's work, through Claude Code's hooks", async () => {
    const events: AgentEvent[] = [];
    let notes = 0;
    await runClaudeDetached(
      {
        root: dir,
        model: 'anthropic/claude-sonnet-5.5',
        effort: null,
        mode: 'allow',
        task: 'Your task: Add totals',
        approve: async () => false,
        onEvent: (e) => events.push(e),
        signal: new AbortController().signal,
        checkWrite: async (path) =>
          path === 'src/cart.js' ? 'Held: Bea is changing src/cart.js in "Checkout"' : null,
        turnContext: async () => `Your swarm now: (${++notes})`,
      },
      {
        binary: join(import.meta.dirname, 'test', 'fake-claude.mjs'),
        dataDir: dir,
        bridge,
        mcpEntry: join(import.meta.dirname, '..', '..', 'dist', 'claude', 'mcpRun.js'),
        nodePath: process.execPath,
        pathEnv: process.env['PATH'] ?? '',
      },
    );
    const said = JSON.parse(
      events
        .filter((e): e is Extract<AgentEvent, { type: 'text' }> => e.type === 'text')
        .map((e) => e.text)
        .join(''),
    ) as { hooks: Record<string, string> };
    expect(JSON.parse(said.hooks['pre']!)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Held: Bea is changing src/cart.js in "Checkout"',
      },
    });
    expect(said.hooks['preOther']).toBe('');
    expect(JSON.parse(said.hooks['post']!).hookSpecificOutput.additionalContext).toMatch(
      /^Your swarm now:/,
    );
    // Not again right away: at most every 20 seconds, and only when it changed.
    expect(said.hooks['again']).toBe('');
  });

  it("speaks Kovan's terms for Claude Code's tools and models", () => {
    expect(asApproval('1', 'Bash', { command: 'pnpm test' })).toMatchObject({
      kind: 'command',
      detail: 'pnpm test',
    });
    expect(asApproval('2', 'Edit', { file_path: 'a.ts' })).toMatchObject({
      kind: 'edit',
      detail: 'a.ts',
    });
    expect(asApproval('3', 'WebFetch', { url: 'https://x' }).kind).toBe('external');
    expect(claudeModel('anthropic/claude-opus-5.5')).toBe('opus');
    expect(claudeModel('anthropic/claude-haiku-5.5')).toBe('haiku');
    expect(claudeModel('openai/gpt-oss-120b')).toBeNull();
    expect(claudeModel('claude')).toBeNull();
  });
});
