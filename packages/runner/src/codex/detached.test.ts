import type { AgentEvent, Tool } from '@kovan/harness';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolBridge } from '../claude/toolBridge.js';
import { commandAllowed } from '../commandPolicy.js';
import { runCodexDetached } from './detached.js';

let dir: string;
let bridge: ToolBridge;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kovan-codex-'));
  bridge = new ToolBridge(join(dir, 'bridge.json'));
  await bridge.start();
});
afterAll(async () => {
  await bridge.stop();
  await rm(dir, { recursive: true, force: true });
});

describe('Codex for a swarm task', () => {
  it("answers Codex's requests by the machine's policy, checks its changes, and passes messages", async () => {
    const message: Tool = {
      spec: { name: 'message_agent', description: 'Message', parameters: { type: 'object' } },
      kind: 'team',
      describe: () => 'Messaged',
      run: async (args) => ({ ok: true, output: `Sent to ${String(args['to'])}.` }),
    };
    const events: AgentEvent[] = [];
    const end = await runCodexDetached(
      {
        root: dir,
        model: 'openai/gpt-5.5',
        effort: null,
        mode: 'full',
        task: 'Your task: Add totals',
        tools: [message],
        approve: async (r) => r.kind === 'command' && commandAllowed(r.detail),
        onEvent: (e) => events.push(e),
        signal: new AbortController().signal,
        checkWrite: async (path) =>
          path === 'src/cart.js' ? 'Held: Bea is changing src/cart.js in "Checkout"' : null,
        turnContext: async () => 'Your swarm now:\n- Moss: Add totals → running',
        onAgent: (agent) =>
          setTimeout(
            () => agent.steer({ id: 'm1', text: 'cart.ts changed', fromName: 'Owen' }),
            50,
          ),
      },
      {
        binary: join(import.meta.dirname, 'test', 'fake-codex-swarm.mjs'),
        bridge,
        mcpEntry: join(import.meta.dirname, '..', '..', 'dist', 'claude', 'mcpRun.js'),
        nodePath: process.execPath,
        pathEnv: process.env['PATH'] ?? '',
      },
    );
    expect(end.reason).toBe('done');
    const said = JSON.parse(
      events
        .filter((e): e is Extract<AgentEvent, { type: 'text' }> => e.type === 'text')
        .map((e) => e.text)
        .join(''),
    ) as {
      prompt: string;
      decisions: Record<string, unknown>;
      steered: string[];
      tool: string;
      policy: string;
      sandbox: string;
    };
    // Commands that want out of the sandbox ask: checks run, anything else is declined.
    // Never Full's open sandbox here.
    expect(said.policy).toBe('on-request');
    expect(said.sandbox).toBe('workspace-write');
    expect(said.decisions).toEqual({ test: 'accept', push: 'decline', change: 'decline' });
    // The change collides with someone's work: declined, and Codex is told why.
    expect(said.steered).toContain('Held: Bea is changing src/cart.js in "Checkout"');
    expect(said.steered).toContain('Message from Owen while you work: cart.ts changed');
    expect(events.find((e) => e.type === 'steer')).toMatchObject({ id: 'm1', status: 'delivered' });
    // The team's work is in its first prompt; the run's tools work through the bridge.
    expect(said.prompt).toContain('Your task: Add totals');
    expect(said.prompt).toContain('Your swarm now:');
    expect(said.tool).toBe('Sent to lead.');
    // The person's Codex plan pays.
    expect(events.filter((e) => e.type === 'usage').every((e) => e.usage.cost === 0)).toBe(true);
  });
});
