import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent } from '@kovan/harness';
import { describe, expect, it } from 'vitest';
import { bareCommand, CodexStreamParser } from './stream.js';

/** Real `codex exec --json` runs (codex-cli 0.162, paths and ids scrubbed). */
const fixture = readFileSync(join(import.meta.dirname, 'stream.fixture.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Record<string, unknown>);

describe('CodexStreamParser', () => {
  it('maps a recorded Codex run onto Kovan agent events', () => {
    const events: AgentEvent[] = [];
    const parser = new CodexStreamParser('t1', '/repo', 'gpt-6-luna', (e) => events.push(e));
    for (const line of fixture) parser.push(line);

    expect(events.map((e) => e.type)).toEqual([
      'turn_start',
      'text',
      'tool_start',
      'tool_end',
      'tool_start',
      'tool_end',
      'tool_start',
      'tool_end',
      'tool_start',
      'tool_end',
      'text',
      'usage',
      'turn_end',
    ]);
    expect(events[0]).toMatchObject({ model: 'codex · gpt-6-luna' });
    expect(events[2]).toMatchObject({ name: 'shell', summary: 'Ran ls' });
    expect(events[3]).toMatchObject({ ok: true, output: 'a.js\n' });
    expect(events[4]).toMatchObject({ summary: "Ran sed -n '1,40p' a.js" });
    expect(events[6]).toMatchObject({ name: 'apply_patch', summary: 'Edited a.js' });
    expect(events[8]).toMatchObject({
      name: 'mcp__kovan__get_team_context',
      summary: 'Called kovan get_team_context',
    });
    expect(events[9]).toMatchObject({ ok: true, output: expect.stringContaining('Members:') });
    expect(events[11]).toMatchObject({
      kind: 'model',
      model: 'codex · gpt-6-luna',
      usage: { promptTokens: 42684, cachedTokens: 31801, completionTokens: 360, cost: null },
    });
    expect(events[12]).toMatchObject({ type: 'turn_end', reason: 'done' });
    expect(parser.threadId).toBe('00000000-0000-4000-8000-000000000002');
  });

  it("hides secret-looking values in an MCP tool's arguments", () => {
    const events: AgentEvent[] = [];
    const parser = new CodexStreamParser('t', '/repo', 'default', (e) => events.push(e));
    parser.push({ type: 'turn.started' });
    parser.push({
      type: 'item.started',
      item: {
        id: 'm1',
        type: 'mcp_tool_call',
        server: 'github',
        tool: 'create_issue',
        arguments: { title: 'Bug', token: 'ghp_real' },
        status: 'in_progress',
      },
    });
    expect(events.find((e) => e.type === 'tool_start')).toMatchObject({
      name: 'mcp__github__create_issue',
      args: { title: 'Bug', token: '••••••' },
    });
  });

  it('reports a failed turn with its error and closes open tool rows', () => {
    const events: AgentEvent[] = [];
    const parser = new CodexStreamParser('t', '/repo', 'default', (e) => events.push(e));
    parser.push({ type: 'turn.started' });
    parser.push({
      type: 'item.started',
      item: { id: 'i1', type: 'command_execution', command: 'ls', status: 'in_progress' },
    });
    parser.push({ type: 'error', message: 'Reconnecting... 1/5' });
    parser.push({ type: 'turn.failed', error: { message: '401 Unauthorized' } });
    parser.finish('done');
    expect(events.map((e) => e.type)).toEqual(['turn_start', 'tool_start', 'tool_end', 'turn_end']);
    expect(events[3]).toMatchObject({ reason: 'error', error: '401 Unauthorized' });
  });
});

describe('CodexStreamParser usage', () => {
  it('reports only this turn when Codex sends totals for a resumed thread', () => {
    const events: AgentEvent[] = [];
    const before = { input: 60499, cached: 47733, output: 437, reasoning: 99 };
    const parser = new CodexStreamParser('t', '/repo', 'default', (e) => events.push(e), before);
    parser.push({
      type: 'turn.completed',
      usage: { input_tokens: 73323, cached_input_tokens: 60484, output_tokens: 446 },
    });
    expect(events.find((e) => e.type === 'usage')).toMatchObject({
      usage: { promptTokens: 12824, cachedTokens: 12751, completionTokens: 9, reasoningTokens: 0 },
    });
    expect(parser.totals).toMatchObject({ input: 73323, output: 446 });
  });
});

describe('bareCommand', () => {
  it('strips the login-shell wrapper Codex adds', () => {
    expect(bareCommand('/bin/zsh -lc ls')).toBe('ls');
    expect(bareCommand('/bin/zsh -lc "sed -n \'1,40p\' a.js"')).toBe("sed -n '1,40p' a.js");
    expect(bareCommand('/bin/bash -lc \'echo "hi"\'')).toBe('echo "hi"');
    expect(bareCommand('git status')).toBe('git status');
  });
});
