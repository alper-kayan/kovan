import { describe, expect, it } from 'vitest';
import { compactEvents, foldEvents, type ConversationEvent } from './agent.js';

const events: ConversationEvent[] = [
  { type: 'user', text: 'fix it', attachments: [], at: 1 },
  { type: 'turn_start', turnId: 't', model: 'a/b' },
  { type: 'reasoning', text: 'Look' },
  { type: 'reasoning', text: 'ing' },
  { type: 'tool_start', id: 'c1', name: 'run_shell', summary: 'Ran pnpm test', args: {} },
  {
    type: 'approval',
    request: {
      id: 'c1',
      tool: 'run_shell',
      kind: 'command',
      title: 'Run this?',
      detail: 'pnpm test',
    },
  },
  { type: 'approval_resolved', id: 'c1', approved: true },
  { type: 'tool_end', id: 'c1', ok: true, output: 'ok', meta: { exitCode: 0 } },
  { type: 'text', text: 'All ' },
  { type: 'text', text: 'good.' },
  {
    type: 'usage',
    usage: {
      promptTokens: 1,
      completionTokens: 1,
      cachedTokens: 0,
      reasoningTokens: 0,
      cost: 0.01,
    },
    model: 'a/b-2026',
    kind: 'model',
    estimated: false,
  },
  { type: 'turn_end', turnId: 't', reason: 'done', cost: 0.01 },
];

describe('foldEvents', () => {
  it('turns the event stream into chat rows', () => {
    expect(foldEvents(events)).toEqual([
      { kind: 'prompt', text: 'fix it', attachments: [], at: 1 },
      { kind: 'reasoning', text: 'Looking' },
      expect.objectContaining({
        kind: 'tool',
        id: 'c1',
        status: 'ok',
        output: 'ok',
        approval: expect.objectContaining({ detail: 'pnpm test' }),
      }),
      { kind: 'text', text: 'All good.' },
      {
        kind: 'end',
        reason: 'done',
        cost: 0.01,
        model: 'a/b-2026',
        receipt: [
          {
            model: 'a/b-2026',
            kind: 'model',
            promptTokens: 1,
            completionTokens: 1,
            cachedTokens: 0,
            cost: 0.01,
            estimated: false,
          },
        ],
      },
    ]);
  });

  it('marks denied actions and stops spinners when a turn is stopped', () => {
    const items = foldEvents([
      { type: 'tool_start', id: 'x', name: 'edit_file', summary: 'Edited a', args: {} },
      { type: 'approval_resolved', id: 'x', approved: false },
      { type: 'tool_end', id: 'x', ok: false, output: 'denied' },
      { type: 'tool_start', id: 'y', name: 'run_shell', summary: 'Ran sleep', args: {} },
      { type: 'turn_end', turnId: 't', reason: 'stopped', cost: 0 },
    ]);
    expect(items.map((i) => (i.kind === 'tool' ? i.status : i.kind))).toEqual([
      'denied',
      'failed',
      'end',
    ]);
  });

  it("puts a helper agent's steps under its call, and shows every approval it waits on", () => {
    const ask = (id: string) => ({
      type: 'approval' as const,
      request: { id, tool: 'Bash', kind: 'command' as const, title: 'Run this?', detail: 'ls' },
    });
    const items = foldEvents([
      { type: 'tool_start', id: 'a', name: 'Agent', summary: 'Delegated Auth review', args: {} },
      { type: 'tool_start', id: 's1', name: 'Read', summary: 'Read a.ts', args: {}, parent: 'a' },
      { type: 'tool_end', id: 's1', ok: true, output: 'x' },
      { type: 'tool_start', id: 's2', name: 'Bash', summary: 'Ran ls', args: {}, parent: 'a' },
      ask('s2'),
      // An approval for a call the stream never showed.
      ask('ghost'),
    ]);
    expect(items).toEqual([
      expect.objectContaining({
        id: 'a',
        status: 'running',
        steps: [
          expect.objectContaining({ id: 's1', status: 'ok' }),
          expect.objectContaining({ id: 's2', status: 'waiting', approval: expect.anything() }),
        ],
      }),
      expect.objectContaining({ id: 'ghost', status: 'waiting', summary: 'Asked Bash' }),
    ]);
  });
});

describe('compactEvents', () => {
  it("puts whose account paid on the turn's end", () => {
    const end = foldEvents([
      { type: 'payer', payer: 'your Claude subscription' },
      { type: 'turn_start', turnId: 't', model: 'claude-code · claude-sonnet-5-5' },
      { type: 'turn_end', turnId: 't', reason: 'done', cost: 0 },
    ]).at(-1);
    expect(end).toMatchObject({ kind: 'end', payer: 'your Claude subscription' });
  });

  it('notes when the conversation was summarized', () => {
    expect(foldEvents([{ type: 'compacted', before: 120_400, after: 31_900 }])).toEqual([
      expect.objectContaining({
        kind: 'note',
        text: expect.stringContaining('about 120k → 32k tokens'),
      }),
    ]);
  });

  it('joins consecutive deltas', () => {
    const compacted = compactEvents(events);
    expect(compacted.filter((e) => e.type === 'reasoning')).toEqual([
      { type: 'reasoning', text: 'Looking' },
    ]);
    expect(compacted.filter((e) => e.type === 'text')).toEqual([
      { type: 'text', text: 'All good.' },
    ]);
  });
});
