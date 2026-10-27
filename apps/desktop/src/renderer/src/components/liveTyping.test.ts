import { describe, expect, it } from 'vitest';
import type { LiveAgent } from '../services/liveAgents';
import { TICK_MS, TYPE_RATE, advance, itemsOf, keptPrefix, landedAt } from './liveTyping';

const agent = (over: Partial<LiveAgent>): LiveAgent => ({
  key: 'bob',
  name: 'Bob',
  sessionId: 's1',
  sessionTitle: 'Demo',
  label: 'Bob · agent',
  color: '#4dabf7',
  mine: false,
  path: 'src/stats.js',
  phase: 'typing',
  line: null,
  anchor: null,
  text: null,
  toolId: 't2',
  at: 0,
  pending: [],
  ...over,
});

describe('advance', () => {
  it('types at a pace that can be followed', () => {
    let shown = 0;
    let ticks = 0;
    while (shown < 300) {
      shown = advance(shown, 300);
      ticks++;
    }
    // 300 characters at ~90 a second: around three seconds, not a blink.
    const seconds = (ticks * TICK_MS) / 1000;
    expect(seconds).toBeGreaterThan((300 / TYPE_RATE) * 0.8);
    expect(seconds).toBeLessThan((300 / TYPE_RATE) * 1.3);
  });

  it('catches up faster on a long edit, and never passes the end', () => {
    let shown = 0;
    let ticks = 0;
    while (shown < 6000) {
      shown = advance(shown, 6000);
      ticks++;
    }
    expect((ticks * TICK_MS) / 1000).toBeLessThan(15);
    expect(advance(10, 10)).toBe(10);
    expect(advance(9, 10)).toBe(10);
  });
});

describe('itemsOf', () => {
  it('keeps finished edits on their way, oldest first, then the one being written', () => {
    const items = itemsOf(
      agent({
        text: 'function mode',
        pending: [
          { toolId: 't1', path: 'src/stats.js', anchor: 'mean', text: 'function median', at: 1 },
        ],
      }),
      'src/stats.js',
    );
    expect(items.map((i) => [i.id, i.done, i.pending])).toEqual([
      ['bob:t1', true, true],
      ['bob:t2', false, false],
    ]);
  });

  it("doesn't show an edit twice once it is pending", () => {
    const items = itemsOf(
      agent({
        phase: 'wrote',
        toolId: 't1',
        text: 'x',
        pending: [{ toolId: 't1', path: 'src/stats.js', anchor: null, text: 'x', at: 1 }],
      }),
      'src/stats.js',
    );
    expect(items).toHaveLength(1);
  });

  it('shows nothing to type while only reading', () => {
    expect(itemsOf(agent({ phase: 'reading' }), 'src/stats.js')).toEqual([]);
  });

  it('keeps an edit in its own file after the agent moves on to another', () => {
    const moved = agent({
      path: 'test/stats.test.js',
      text: 'test(',
      pending: [
        { toolId: 't1', path: 'src/stats.js', anchor: null, text: 'function median', at: 1 },
      ],
    });
    expect(itemsOf(moved, 'src/stats.js').map((i) => i.id)).toEqual(['bob:t1']);
    expect(itemsOf(moved, 'test/stats.test.js').map((i) => i.id)).toEqual(['bob:t2']);
  });
});

describe('landedAt', () => {
  const item = { id: 'a', agentKey: 'a', toolId: 't', pending: true };
  it('finds a finished edit in the file', () => {
    const content = 'a\nfunction median(xs) {}\n';
    expect(
      landedAt(content, { ...item, anchor: 'a', text: 'function median(xs) {}', done: true }),
    ).toBe(2);
    expect(landedAt('a\n', { ...item, anchor: 'a', text: 'function median', done: true })).toBe(-1);
  });

  it('counts an unfinished edit as landed only once the text it replaces is gone', () => {
    const edit = { ...item, anchor: 'old()', text: 'new()', done: false };
    expect(landedAt('old()\nnew()', edit)).toBe(-1);
    expect(landedAt('new()', edit)).toBe(0);
  });
});

describe('keptPrefix', () => {
  it('skips the lines a whole-file write kept, from the start of the first changed line', () => {
    const before = 'a\nmean\n\nexports = { mean };\n';
    const text = 'a\nmean\n\nsum\n\nexports = { mean, sum };\n';
    expect(text.slice(keptPrefix(before, 0, text))).toBe('sum\n\nexports = { mean, sum };\n');
  });

  it('is everything when nothing changed, and nothing when the first line did', () => {
    expect(keptPrefix('same', 0, 'same')).toBe(4);
    expect(keptPrefix('old\n', 0, 'new\n')).toBe(0);
  });
});
