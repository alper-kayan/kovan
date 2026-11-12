import { describe, expect, it } from 'vitest';
import { foldLane, laneDigest, toolLabel } from './lanes';

describe('a lane on the phone', () => {
  it('joins streamed words and follows a tool through its approval', () => {
    const items = foldLane([
      { type: 'user', text: 'Fix the race', attachments: [], at: 1 },
      { type: 'turn_start', turnId: 't', model: 'm' },
      { type: 'text', text: 'Look' },
      { type: 'text', text: 'ing.' },
      { type: 'tool_start', id: 'x', name: 'bash', summary: 'npm test', args: {} },
      { type: 'approval', request: { id: 'x' } },
    ]);
    expect(items.map((i) => i.kind)).toEqual(['prompt', 'text', 'tool']);
    expect(items[1]).toMatchObject({ text: 'Looking.' });
    expect(items[2]).toMatchObject({ status: 'waiting', summary: 'npm test' });

    const after = foldLane([
      { type: 'tool_start', id: 'x', name: 'edit', summary: 'src/a.ts', args: {} },
      { type: 'approval', request: { id: 'x' } },
      { type: 'approval_resolved', id: 'x', approved: true },
      { type: 'tool_end', id: 'x', ok: true, output: '', meta: { added: 3, removed: 1 } },
      { type: 'turn_end', turnId: 't', reason: 'done', cost: 0.012 },
    ]);
    expect(after[0]).toMatchObject({ status: 'ok', added: 3, removed: 1 });
    expect(after[1]).toMatchObject({ kind: 'end', reason: 'done', cost: 0.012 });
  });

  it('shows a denied action as denied even after it reports back', () => {
    const items = foldLane([
      { type: 'tool_start', id: 'x', name: 'bash', summary: 'rm -rf build', args: {} },
      { type: 'approval_resolved', id: 'x', approved: false },
      { type: 'tool_end', id: 'x', ok: false, output: 'denied' },
    ]);
    expect(items[0]).toMatchObject({ status: 'denied' });
  });

  it("keeps a helper agent's steps out, unless one waits for an answer", () => {
    const items = foldLane([
      { type: 'tool_start', id: 'a', name: 'Agent', summary: 'Delegated Auth review', args: {} },
      { type: 'tool_start', id: 's1', name: 'Read', summary: 'Read a.ts', args: {}, parent: 'a' },
      { type: 'tool_start', id: 's2', name: 'Bash', summary: 'Ran ls', args: {}, parent: 'a' },
      { type: 'approval', request: { id: 's2', tool: 'Bash' } },
      { type: 'approval', request: { id: 'ghost', tool: 'Bash' } },
    ]);
    expect(items.map((i) => (i.kind === 'tool' ? `${i.summary}:${i.status}` : i.kind))).toEqual([
      'Delegated Auth review:running',
      'Ran ls:waiting',
      'Asked Bash:waiting',
    ]);
  });

  it('turns guidance, limits and notices into notes and skips what it does not know', () => {
    const items = foldLane([
      { type: 'steer', id: 's', text: 'Use the cache', fromName: 'Bob', status: 'delivered' },
      { type: 'limit_hit', reason: 'weekly limit' },
      { type: 'usage', usage: {}, model: 'm', kind: 'model', estimated: false },
      { type: 'something_new', text: 'raw' },
      { type: 'notice', tone: 'warn', text: 'Checkout is behind' },
    ]);
    expect(items.map((i) => (i.kind === 'note' ? [i.tone, i.text] : i.kind))).toEqual([
      ['info', '↪ Guidance from Bob: Use the cache'],
      ['warn', 'Usage limit hit (weekly limit). Someone needs to take over.'],
      ['warn', 'Checkout is behind'],
    ]);
  });
});

describe('tool labels', () => {
  it('name skills, MCP servers and plugin servers briefly', () => {
    expect(toolLabel('use_skill')).toBe('skill');
    expect(toolLabel('Skill')).toBe('skill');
    expect(toolLabel('mcp_trust')).toBe('mcp');
    expect(toolLabel('mcp__github__create_issue')).toBe('github');
    expect(toolLabel('mcp__plugin_release-tools_notes__echo')).toBe('release-tools_notes');
    expect(toolLabel('run_shell')).toBe('run_shell');
  });

  it('shows a call to a teammate, then one row for it at work and its answer', () => {
    const call = { agentId: 'b', name: 'Bob', requestId: 'r1' };
    const items = foldLane([
      { type: 'user', text: 'Add total()', attachments: [], at: 1 },
      { type: 'mention', ...call, text: '@Bob check it', at: 2 },
      { type: 'teammate', ...call, status: 'working', text: null, at: 3 },
      { type: 'teammate', ...call, status: 'answered', text: 'It is fine.', at: 4 },
      { type: 'teammate', ...call, status: 'sideways', text: 'x', at: 5 },
    ]);
    expect(items.map((i) => i.kind)).toEqual(['prompt', 'mention', 'teammate']);
    expect(items[2]).toMatchObject({ name: 'Bob', status: 'answered', text: 'It is fine.' });
    expect(laneDigest(items, 'Alper')).toBe(
      'Alper: Add total()\nAlper to @Bob: @Bob check it\nBob: It is fine.',
    );
    expect(laneDigest([], 'Alper')).toBeNull();
  });
});
