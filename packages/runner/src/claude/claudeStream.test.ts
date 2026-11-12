import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent } from '@kovan/harness';
import { describe, expect, it } from 'vitest';
import { ClaudeStreamParser, describeClaudeTool } from './claudeStream.js';

/** A real `claude -p --output-format stream-json --verbose` run (paths and ids scrubbed). */
const fixture = readFileSync(join(import.meta.dirname, 'claudeStream.fixture.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Record<string, unknown>);

describe('ClaudeStreamParser', () => {
  it('maps a recorded Claude Code run onto Kovan agent events', () => {
    const events: AgentEvent[] = [];
    const parser = new ClaudeStreamParser('t1', '/repo', (e) => events.push(e));
    for (const line of fixture) parser.push(line);

    expect(events.map((e) => e.type)).toEqual([
      'turn_start',
      'tool_start',
      'tool_end',
      'text',
      'usage',
      'turn_end',
    ]);
    expect(events[0]).toMatchObject({ model: 'claude-code · claude-haiku-5-5' });
    expect(events[1]).toMatchObject({ name: 'Read', summary: 'Read a.txt' });
    expect(events[2]).toMatchObject({ ok: true, output: expect.stringContaining('hello') });
    expect(events[3]).toEqual({ type: 'text', text: 'OK' });
    expect(events[4]).toMatchObject({
      kind: 'model',
      estimated: false,
      usage: { completionTokens: 105, cachedTokens: 36166 },
    });
    expect(events[5]).toMatchObject({ type: 'turn_end', reason: 'done' });
    expect((events[5] as { cost: number }).cost).toBeCloseTo(0.00328396);
    expect(parser.sessionId).toBe('00000000-0000-4000-8000-000000000001');
  });

  it('ends a turn once, even when the process exits after the result', () => {
    const events: AgentEvent[] = [];
    const parser = new ClaudeStreamParser('t', '/repo', (e) => events.push(e));
    parser.finish('stopped');
    parser.finish('done');
    expect(events.filter((e) => e.type === 'turn_end')).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'turn_start' });
  });

  it("puts a helper agent's steps under the call that started it, without its words", () => {
    const events: AgentEvent[] = [];
    const parser = new ClaudeStreamParser('t', '/repo', (e) => events.push(e));
    const say = (type: string, content: unknown[], parent: string | null = null) =>
      parser.push({ type, message: { content }, parent_tool_use_id: parent });
    say('assistant', [
      {
        type: 'tool_use',
        id: 'agent1',
        name: 'Agent',
        input: { description: 'Auth review', prompt: 'Look at auth' },
      },
    ]);
    say('assistant', [{ type: 'text', text: 'Looking at auth.' }], 'agent1');
    say(
      'assistant',
      [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'grep -rn token src' } }],
      'agent1',
    );
    say('user', [{ type: 'tool_result', tool_use_id: 'b1', content: 'src/a.ts:1' }], 'agent1');
    say('user', [{ type: 'tool_result', tool_use_id: 'agent1', content: 'No issues.' }]);

    expect(events).toEqual([
      expect.objectContaining({
        type: 'tool_start',
        id: 'agent1',
        summary: 'Delegated Auth review',
      }),
      expect.objectContaining({
        type: 'tool_start',
        id: 'b1',
        summary: 'Ran grep -rn token src',
        parent: 'agent1',
      }),
      expect.objectContaining({ type: 'tool_end', id: 'b1', ok: true }),
      expect.objectContaining({ type: 'tool_end', id: 'agent1', output: 'No issues.' }),
    ]);
    expect(events[0]).not.toHaveProperty('parent');
  });
});

describe('ClaudeStreamParser with partial messages', () => {
  it('shows an edit while Claude Code is still writing it', () => {
    const partial = readFileSync(join(import.meta.dirname, 'claudePartial.fixture.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const events: AgentEvent[] = [];
    const parser = new ClaudeStreamParser('t', '/repo', (e) => events.push(e));
    for (const line of partial) parser.push(line);
    const progress = events.filter((e) => e.type === 'tool_progress');
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0]).toMatchObject({ name: 'Write', path: 'a.txt', anchor: null });
    expect('alpha\nbeta\n'.startsWith((progress[0] as { text: string }).text)).toBe(true);
  });
});

describe('describeClaudeTool', () => {
  it('reads like Kovan tool rows', () => {
    expect(describeClaudeTool('Bash', { command: 'pnpm test' })).toBe('Ran pnpm test');
    expect(describeClaudeTool('Edit', { file_path: '/repo/a.ts' })).toBe('Edited /repo/a.ts');
    expect(describeClaudeTool('mcp__kovan__get_team_context', {})).toBe(
      'Called kovan get_team_context',
    );
    expect(describeClaudeTool('Skill', { skill: 'release-notes' })).toBe(
      'Used skill release-notes',
    );
    expect(describeClaudeTool('Skill', { command: '/changelog' })).toBe('Used skill changelog');
  });

  it("hides secret-looking values in an MCP tool's arguments before they reach the team", () => {
    const events: AgentEvent[] = [];
    const parser = new ClaudeStreamParser('t', '/repo', (e) => events.push(e));
    parser.push({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'u1',
            name: 'mcp__github__create_issue',
            input: { title: 'Bug', api_key: 'sk-real-value', body: 'text' },
          },
        ],
      },
    });
    expect(events.find((e) => e.type === 'tool_start')).toMatchObject({
      name: 'mcp__github__create_issue',
      args: { title: 'Bug', api_key: '••••••', body: 'text' },
    });
  });

  it('hands Claude Code’s account limit to whoever asked for it', () => {
    const limits: Record<string, unknown>[] = [];
    const parser = new ClaudeStreamParser(
      't1',
      '/repo',
      () => undefined,
      (info) => limits.push(info),
    );
    for (const line of fixture) parser.push(line);
    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({
      status: 'allowed',
      unifiedWindows: { five_hour: { utilization: 0.09 } },
    });
  });
});

describe('Claude Code errors in words', () => {
  it('says when a usage limit opens again, and keeps the line its reset is read from', async () => {
    const { plainClaudeError } = await import('./claudeStream.js');
    const said = plainClaudeError('Claude AI usage limit reached|1794467829');
    expect(said).toMatch(/^Claude Code hit its usage limit: it opens again at /);
    expect(said).toContain('|1794467829');
    expect(plainClaudeError('Something else broke')).toBe('Something else broke');
  });
});
