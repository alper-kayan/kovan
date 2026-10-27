import { describe, expect, it } from 'vitest';
import { freshErrors, nextSince, reviewErrors, type ErrorGroup } from './errors.js';

const group = (key: string, count = 1, source = 'server'): ErrorGroup => ({
  key: `${source}|${key}`,
  source,
  message: key,
  count,
  first: '2026-10-25T09:00:00.000Z',
  last: '2026-10-25T09:00:00.000Z',
});
const now = Date.UTC(2026, 9, 25, 9, 0);

describe('what failed on the server', () => {
  it('learns what is usual on the first look, then tells a new kind once', () => {
    let state = freshErrors();
    expect(nextSince(state, now)).toBe('2026-09-25T09:00:00.000Z');
    let looked = reviewErrors(
      state,
      { now: 'T1', dropped: 0, groups: [group('old one', 50)] },
      now,
    );
    expect(looked.alerts).toEqual([]);
    state = looked.state;
    expect(nextSince(state, now)).toBe('T1');
    looked = reviewErrors(
      state,
      {
        now: 'T2',
        dropped: 0,
        groups: [group('old one'), group('Boom', 2), group('Bang', 1, 'renderer')],
      },
      now + 300_000,
    );
    expect(looked.alerts).toEqual([
      {
        title: '2 new errors on Kovan',
        body: 'Server: Boom (2×)\nDesktop window: Bang (1×)',
      },
    ]);
    looked = reviewErrors(
      looked.state,
      { now: 'T3', dropped: 0, groups: [group('Boom')] },
      now + 600_000,
    );
    expect(looked.alerts).toEqual([]);
  });

  it('tells a burst at most once an hour, counting what the server dropped', () => {
    let state = reviewErrors(
      freshErrors(),
      { now: 'T0', dropped: 0, groups: [group('Boom')] },
      now,
    ).state;
    const burst = { now: 'T1', dropped: 15, groups: [group('Boom', 20)] };
    let looked = reviewErrors(state, burst, now + 300_000);
    expect(looked.alerts).toEqual([
      {
        title: 'Errors are piling up on Kovan',
        body: '35 in the last few minutes, most: Boom (20×).',
      },
    ]);
    state = looked.state;
    looked = reviewErrors(state, { ...burst, dropped: 15 + 40 }, now + 600_000);
    expect(looked.alerts).toEqual([]);
    looked = reviewErrors(looked.state, { ...burst, dropped: 100 }, now + 3_900_000);
    expect(looked.alerts.map((a) => a.title)).toEqual(['Errors are piling up on Kovan']);
  });

  it('forgets a kind after 30 days, so it counts as new again', () => {
    const state = reviewErrors(
      freshErrors(),
      { now: 'T0', dropped: 0, groups: [group('Boom')] },
      now,
    ).state;
    const later = reviewErrors(state, { now: 'T1', dropped: 0, groups: [] }, now + 31 * 86_400_000);
    expect(later.state.known).toEqual({});
  });
});
