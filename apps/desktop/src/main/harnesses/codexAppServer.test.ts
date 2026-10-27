import type { AgentEvent } from '@kovan/harness';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexAppServerRunner, execItem } from './codexAppServer.js';

const runner = (events: AgentEvent[], threads: string[], root = tmpdir()) =>
  new CodexAppServerRunner({
    binary: join(import.meta.dirname, 'test', 'fake-codex-app-server.mjs'),
    root,
    model: 'default',
    mode: 'allow',
    mcpServer: { command: 'node', args: ['mcp.js'], env: {} },
    threadId: null,
    onThread: (t) => threads.push(t),
    onEvent: (e) => events.push(e),
    pathEnv: process.env['PATH'] ?? '',
  });

describe('Codex through its app server', () => {
  it("hands a teammate's message to the running turn and says when Codex has it", async () => {
    const events: AgentEvent[] = [];
    const threads: string[] = [];
    const codex = runner(events, threads);
    const turn = codex.send('Fix the cart total');
    // Owen writes while it works (once the turn is under way).
    for (let i = 0; i < 100 && !events.some((e) => e.type === 'tool_start'); i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(codex.steer({ id: 'm1', text: 'cart.ts changed', fromName: 'Owen' })).toBe(true);
    await turn;
    expect(events.find((e) => e.type === 'steer')).toMatchObject({ id: 'm1', status: 'delivered' });
    const text = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text);
    expect(text.join('')).toBe(
      'heard: Fix the cart total | Message from Owen while you work: cart.ts changed',
    );
    expect(events.find((e) => e.type === 'tool_start')).toMatchObject({ name: 'shell' });
    expect(events.find((e) => e.type === 'tool_end')).toMatchObject({ ok: true, output: 'ok' });
    expect(events.find((e) => e.type === 'usage')).toMatchObject({
      usage: { promptTokens: 100, completionTokens: 10, cachedTokens: 40 },
    });
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', reason: 'done' });
    expect(threads).toEqual(['thread-1']);
    // The turn is over: a later message waits.
    expect(codex.steer({ id: 'm2', text: 'late' })).toBe(false);
  });

  it("speaks the parser's terms for app-server items", () => {
    expect(
      execItem({
        id: 'f',
        type: 'fileChange',
        status: 'completed',
        changes: [{ path: 'a.ts', kind: { type: 'add' }, diff: '' }],
      }),
    ).toEqual({
      id: 'f',
      type: 'file_change',
      status: 'completed',
      changes: [{ path: 'a.ts', kind: 'add' }],
    });
    expect(execItem({ id: 'u', type: 'userMessage' })).toBeNull();
    expect(
      execItem({ id: 'c', type: 'commandExecution', status: 'inProgress', command: 'ls' }),
    ).toMatchObject({
      type: 'command_execution',
      status: 'in_progress',
    });
  });

  it("doesn't hang when Codex can't start", async () => {
    const events: AgentEvent[] = [];
    const codex = runner(events, [], join(tmpdir(), 'kovan-no-such-folder'));
    await codex.send('Fix it');
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', reason: 'error' });
  });
});
