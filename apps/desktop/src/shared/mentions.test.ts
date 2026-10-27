import { describe, expect, it } from 'vitest';
import { foldEvents, type ConversationEvent } from './agent.js';
import {
  conversationDigest,
  insertMention,
  mentionedTeammate,
  mentionMatches,
  mentionQuery,
} from './mentions.js';

const bob = { id: 'b', name: 'Bob' };
const bobby = { id: 'bb', name: 'Bobby' };
const mary = { id: 'm', name: 'Mary Ann' };

describe('mentions', () => {
  it('finds the name typed after an @ at the caret', () => {
    expect(mentionQuery('@', 1)).toBe('');
    expect(mentionQuery('look @Bo', 8)).toBe('Bo');
    expect(mentionQuery('look @Bo here', 8)).toBe('Bo');
    expect(mentionQuery('look @Bo here', 13)).toBeNull();
    // An email address isn't a mention.
    expect(mentionQuery('ana@ex', 6)).toBeNull();
    expect(mentionMatches('bo', [bob, bobby, mary]).map((t) => t.name)).toEqual(['Bob', 'Bobby']);
  });

  it('puts the picked name in place of what was typed', () => {
    expect(insertMention('hey @Bo', 7, 'Bobby')).toEqual({ text: 'hey @Bobby ', caret: 11 });
    expect(insertMention('@b is it right?', 2, 'Bob')).toEqual({
      text: '@Bob is it right?',
      caret: 5,
    });
  });

  it('tells which teammate a message calls in, the longest name first', () => {
    expect(mentionedTeammate('@Bob is this right?', [bob, bobby])).toBe(bob);
    expect(mentionedTeammate('what do you think, @bobby?', [bob, bobby])).toBe(bobby);
    expect(mentionedTeammate('ask @Mary Ann about it', [bob, mary])).toBe(mary);
    expect(mentionedTeammate('mail bob@example.com', [bob])).toBeNull();
    expect(mentionedTeammate('@Bobcat', [bob])).toBeNull();
    expect(mentionedTeammate('no one here', [bob])).toBeNull();
  });

  it('turns a conversation into what a called-in teammate reads, newest last', () => {
    const events: ConversationEvent[] = [
      { type: 'user', text: 'Add total()', attachments: [], at: 1 },
      { type: 'turn_start', turnId: 't', model: 'm' },
      { type: 'text', text: 'Adding it.' },
      {
        type: 'tool_start',
        id: 'c1',
        name: 'write_file',
        summary: 'Wrote src/total.ts',
        args: {},
      },
      { type: 'tool_end', id: 'c1', ok: true, output: 'ok' },
      { type: 'text', text: 'Done.' },
      { type: 'mention', agentId: 'b', name: 'Bob', text: '@Bob check it', requestId: 'r', at: 2 },
    ];
    expect(conversationDigest(events, 'Alper')).toBe(
      [
        'Alper: Add total()',
        'Agent: Adding it.',
        '  [write_file] Wrote src/total.ts',
        'Agent: Done.',
        'Alper to @Bob: @Bob check it',
      ].join('\n'),
    );
    expect(conversationDigest([], 'Alper')).toBeNull();
    const long: ConversationEvent[] = Array.from({ length: 30 }, (_, i) => ({
      type: 'user',
      text: `${i} ${'x'.repeat(3000)}`,
      attachments: [],
      at: i,
    }));
    const digest = conversationDigest(long, 'Alper')!;
    expect(digest.length).toBeLessThanOrEqual(20_100);
    expect(digest.startsWith('(earlier messages left out)')).toBe(true);
    expect(digest.endsWith('x')).toBe(true);
    expect(digest).toContain('Alper: 29 ');
  });

  it('keeps one row per call: the teammate at work, then its answer', () => {
    const call = { agentId: 'b', name: 'Bob', requestId: 'r1' };
    const items = foldEvents([
      { type: 'mention', ...call, text: '@Bob check it', at: 1 },
      { type: 'teammate', ...call, status: 'working', text: null, at: 2 },
      { type: 'teammate', ...call, status: 'answered', text: 'It is fine.', at: 3 },
    ]);
    expect(items.map((i) => i.kind)).toEqual(['mention', 'teammate']);
    expect(items[1]).toMatchObject({ status: 'answered', text: 'It is fine.', at: 3 });
    expect(
      conversationDigest(
        [
          { type: 'mention', ...call, text: '@Bob check it', at: 1 },
          { type: 'teammate', ...call, status: 'answered', text: 'It is fine.', at: 3 },
        ],
        'Alper',
      ),
    ).toBe('Alper to @Bob: @Bob check it\nBob: It is fine.');
  });
});
