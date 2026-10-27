import { describe, expect, it } from 'vitest';
import { LiveDiffs } from './liveDiffs.js';

function setup(read: () => Promise<{ diff: string | null; commit: string | null }>) {
  const sent: { path: string; body: unknown }[] = [];
  let fail: number | null = null;
  const live = new LiveDiffs({
    request: async (_method, path, body) => {
      if (fail !== null) {
        const status = fail;
        throw Object.assign(new Error('nope'), { status });
      }
      sent.push({ path, body });
    },
    read,
    signedIn: () => true,
    delayMs: 5,
    retryMs: 5,
  });
  return { live, sent, failWith: (s: number | null) => (fail = s) };
}

describe('live diffs', () => {
  it('sends a view once changes settle, and only when it differs', async () => {
    let diff = 'diff --git a/x b/x\n+one\n';
    let reads = 0;
    const { live, sent } = setup(async () => {
      reads++;
      return { diff, commit: 'c1' };
    });
    live.changed('s1', '/r');
    live.changed('s1', '/r');
    live.changed('s1', '/r');
    await live.settled();
    expect(reads).toBe(1);
    expect(sent).toEqual([{ path: '/api/sessions/s1/changes', body: { diff, commit: 'c1' } }]);
    live.changed('s1', '/r');
    await live.settled();
    expect(sent).toHaveLength(1);
    diff = 'diff --git a/x b/x\n+two\n';
    live.changed('s1', '/r');
    await live.settled();
    expect(sent).toHaveLength(2);
  });

  it('tries again when offline, and stops for a session that ended', async () => {
    let n = 0;
    const { live, sent, failWith } = setup(async () => ({ diff: `d${n++}`, commit: null }));
    failWith(0);
    live.changed('s1', '/r');
    await new Promise((r) => setTimeout(r, 8));
    failWith(null);
    await live.settled();
    expect(sent).toHaveLength(1);

    failWith(409);
    live.changed('s1', '/r');
    await live.settled();
    failWith(null);
    live.changed('s1', '/r');
    await live.settled();
    expect(sent).toHaveLength(1);
    live.stop();
  });
});
