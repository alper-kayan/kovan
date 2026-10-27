import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentLimits } from './agentLimits.js';
import { readCodexRateLimits } from './harnesses/codexLimits.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kovan-limits-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('AgentLimits', () => {
  it('remembers a full limit, across restarts, until it resets', async () => {
    let now = 1_000_000;
    const file = join(dir, 'limits.json');
    const limits = new AgentLimits(file, () => now);
    const seen: string[] = [];
    limits.onChange((all) => seen.push(all.map((l) => `${l.account}:${l.status}`).join()));

    expect(await limits.open('claude-code')).toBe(true);
    await limits.full('claude-code', 'limit reached', now + 60_000);
    expect(await limits.open('claude-code')).toBe(false);
    expect(await limits.open('codex')).toBe(true);
    expect(seen).toEqual(['claude-code:full']);

    const again = new AgentLimits(file, () => now);
    expect(await again.open('claude-code')).toBe(false);
    now += 60_000;
    expect(await again.open('claude-code')).toBe(true);
  });

  it('takes the reset time from the windows already reported', async () => {
    let now = 1_000_000;
    const limits = new AgentLimits(join(dir, 'limits.json'), () => now);
    await limits.report('codex', {
      status: 'near',
      windows: [
        { name: '5-hour', used: 0.97, resetsAt: now + 5_000_000 },
        { name: 'weekly', used: 0.3, resetsAt: now + 9_000_000 },
      ],
      resetsAt: null,
    });
    now += 1000;
    const full = await limits.full('codex', 'usage limit', null);
    expect(full.resetsAt).toBe(1_000_000 + 5_000_000);
  });

  it('is not reopened by a report from just before it ran out, but is by a later one', async () => {
    let now = 1_000_000;
    const limits = new AgentLimits(join(dir, 'limits.json'), () => now);
    const ok = {
      status: 'ok' as const,
      windows: [{ name: '5-hour', used: 0.2, resetsAt: null }],
      resetsAt: null,
    };
    await limits.full('claude-code', 'limit', null);
    now += 5_000;
    await limits.report('claude-code', ok);
    expect(await limits.open('claude-code')).toBe(false);
    now += 60_000;
    await limits.report('claude-code', ok);
    expect(await limits.open('claude-code')).toBe(true);
  });
});

describe('readCodexRateLimits', () => {
  it('finds the last rate limits in the thread’s session file', async () => {
    const thread = '01a13637-bc1d-7db2-8e34-b5980d6408a8';
    const day = join(dir, 'sessions', '2026', '10', '13');
    await mkdir(day, { recursive: true });
    await mkdir(join(dir, 'sessions', '2026', '10', '12'), { recursive: true });
    const line = (used: number) =>
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: { primary: { used_percent: used, window_minutes: 300, resets_at: 5 } },
        },
      });
    await writeFile(
      join(day, `rollout-2026-10-13T20-03-04-${thread}.jsonl`),
      [JSON.stringify({ type: 'session_meta' }), line(10), line(35), ''].join('\n'),
    );
    expect(await readCodexRateLimits(thread, dir)).toEqual({
      primary: { used_percent: 35, window_minutes: 300, resets_at: 5 },
    });
    expect(await readCodexRateLimits('ffffffff-0000-0000-0000-000000000000', dir)).toBeNull();
    expect(await readCodexRateLimits('../../etc', dir)).toBeNull();
  });
});
