import type { Comment } from '@kovan/shared';
import { describe, expect, it } from 'vitest';
import { laneSpend, onCode, upsertComment } from './reviewData';

const comment = (id: string, extra: Partial<Comment> = {}): Comment => ({
  id,
  workspaceId: 'w',
  sessionId: 's',
  parentId: null,
  anchor: { kind: 'hunk', path: 'a.ts', startLine: 3, endLine: 3, snippet: 'x', commit: null },
  kind: 'comment',
  body: 'b',
  proposal: null,
  authorId: 'u',
  authorName: 'alice',
  authorAvatar: null,
  authorKind: 'human',
  status: 'open',
  resolvedBy: null,
  outdated: false,
  stepId: null,
  promptedAt: null,
  createdAt: '2026-10-16T00:00:00Z',
  ...extra,
});

describe('review', () => {
  it('adds a new comment and replaces a changed one in place', () => {
    const list = upsertComment(upsertComment([], comment('1')), comment('2'));
    const next = upsertComment(list, comment('1', { status: 'resolved' }));
    expect(next.map((c) => [c.id, c.status])).toEqual([
      ['1', 'resolved'],
      ['2', 'open'],
    ]);
    expect(onCode(comment('3', { anchor: { kind: 'session' } }))).toBe(false);
    expect(onCode(comment('4'))).toBe(true);
  });

  it("sums each lane's turn costs, largest first, leaving out lanes that spent nothing", () => {
    const rows = laneSpend(
      {
        a: [
          { type: 'turn_end', cost: 0.01 },
          { type: 'turn_end', cost: 0.02 },
          { type: 'text', text: 'hi' },
        ],
        b: [{ type: 'turn_end', cost: 0.5 }],
        c: [{ type: 'turn_end', cost: null }],
      },
      [
        { userId: 'a', name: 'alice' },
        { userId: 'b', name: 'Bob' },
      ],
    );
    expect(rows.map((r) => [r.name, Number(r.cost.toFixed(4))])).toEqual([
      ['Bob', 0.5],
      ['alice', 0.03],
    ]);
  });
});
