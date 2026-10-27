import { describe, expect, it } from 'vitest';
import type { HostStatus } from './host.js';
import { freshState, tick, type Alert, type Device, type MonitorState } from './monitor.js';

const phone: Device = { platform: 'ios', token: 'aaaa', sandbox: true };
const android: Device = { platform: 'android', token: 'bbbb', sandbox: false };

/** A server that is up or down as the test says, and a phone that collects what it is told. */
function world() {
  let up = true;
  let devices: Device[] = [phone, android];
  const told: Alert[] = [];
  const asked: string[] = [];
  let now = Date.UTC(2026, 9, 25, 9, 0);
  let host: HostStatus | null = null;
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    asked.push(url);
    if (!up)
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (url.endsWith('/health')) return Response.json({ ok: true });
    if (url.endsWith('/api/ops/status'))
      return host
        ? Response.json({ ...host, at: new Date(now).toISOString() })
        : new Response('{}', { status: 404 });
    if (url.endsWith('/api/ops/push-targets')) {
      const auth = (init?.headers as Record<string, string>).authorization;
      return auth === 'Bearer ops-token'
        ? Response.json({ devices })
        : new Response('{}', { status: 401 });
    }
    return new Response('<html>', { status: 200 });
  }) as typeof globalThis.fetch;
  let gone: string[] = [];
  const options = {
    url: 'https://kovan.test',
    opsToken: 'ops-token',
    timeZone: 'UTC',
    fetch,
    now: () => now,
    send: async (to: Device[], alert: Alert) => {
      expect(to.every((d) => d.platform === 'ios')).toBe(true);
      told.push(alert);
      return gone;
    },
  };
  let state: MonitorState = freshState();
  return {
    told,
    asked,
    get state() {
      return state;
    },
    setUp: (v: boolean) => (up = v),
    setDevices: (d: Device[]) => (devices = d),
    setGone: (g: string[]) => (gone = g),
    setHost: (h: HostStatus | null) => (host = h),
    advance: (ms: number) => (now += ms),
    round: async (extra: object = {}) => {
      state = await tick(state, { ...options, ...extra });
      now += 60_000;
    },
  };
}

describe('the outside monitor', () => {
  it('keeps the phones while the server is up, and tells them only after three failures', async () => {
    const w = world();
    await w.round();
    expect(w.state.devices).toEqual([phone, android]);
    w.setUp(false);
    await w.round();
    await w.round();
    expect(w.told).toEqual([]);
    await w.round();
    expect(w.told).toEqual([
      { title: 'Kovan is down', body: "Can't reach it (ECONNREFUSED). Since 09:01." },
    ]);
    // Nothing more every minute, a reminder after an hour.
    for (let i = 0; i < 30; i++) await w.round();
    expect(w.told).toHaveLength(1);
    w.advance(60 * 60_000);
    await w.round();
    expect(w.told[1]?.title).toBe('Kovan is still down');
    w.setUp(true);
    await w.round();
    expect(w.told[2]).toEqual({
      title: 'Kovan is back',
      body: "It was down for 1 h 34 min (Can't reach it (ECONNREFUSED)).",
    });
    expect(w.state).toMatchObject({ failures: 0, downSince: null, alertedAt: null });
  });

  it('says nothing about a blip, and nothing comes back for one', async () => {
    const w = world();
    await w.round();
    w.setUp(false);
    await w.round();
    await w.round();
    w.setUp(true);
    await w.round();
    expect(w.told).toEqual([]);
  });

  it('keeps the phones it had when the server answers wrong, and drops the ones Apple calls gone', async () => {
    const w = world();
    await w.round();
    w.setDevices([]);
    await w.round({ opsToken: 'wrong', refreshEveryMs: 0 });
    expect(w.state.devices).toEqual([phone, android]);
    w.setUp(false);
    w.setGone(['aaaa']);
    for (let i = 0; i < 3; i++) await w.round();
    expect(w.told).toHaveLength(1);
    expect(w.state.devices).toEqual([android]);
  });

  it('fetches the phones again only every half hour', async () => {
    const w = world();
    await w.round();
    await w.round();
    expect(w.asked.filter((u) => u.endsWith('/push-targets'))).toHaveLength(1);
    w.advance(30 * 60_000);
    await w.round();
    expect(w.asked.filter((u) => u.endsWith('/push-targets'))).toHaveLength(2);
  });

  it('tells about a problem on the host once, again a day later, and when it is fixed', async () => {
    const w = world();
    const host = (usedPct: number): HostStatus => ({
      at: '',
      disks: [{ mount: '/', usedPct, freeGb: 5.5 }],
      memory: { availablePct: 60 },
      containers: [],
      backup: { file: 'b', at: new Date(Date.UTC(2026, 9, 25, 8, 0)).toISOString() },
      restore: {
        at: new Date(Date.UTC(2026, 9, 25, 8, 0)).toISOString(),
        ok: true,
        detail: 'b restored',
        file: 'b',
        sha256: 'abc',
      },
    });
    w.setHost(host(91));
    await w.round();
    expect(w.told).toEqual([
      { title: 'Kovan needs a look', body: 'Disk / is 91% full (5.5 GB free).' },
    ]);
    // Looked at every 5 minutes, but said once.
    for (let i = 0; i < 20; i++) await w.round();
    expect(w.told).toHaveLength(1);
    w.advance(24 * 3_600_000);
    w.setHost({
      ...host(92),
      backup: { file: 'b', at: new Date(Date.UTC(2026, 9, 26, 8, 0)).toISOString() },
    });
    await w.round();
    expect(w.told[1]).toEqual({
      title: 'Kovan still needs a look',
      body: 'Disk / is 92% full (5.5 GB free). (since 09:00)',
    });
    w.setHost({
      ...host(60),
      backup: { file: 'b', at: new Date(Date.UTC(2026, 9, 26, 8, 0)).toISOString() },
    });
    w.advance(5 * 60_000);
    await w.round();
    expect(w.told[2]).toEqual({
      title: 'Kovan is fine again',
      body: 'Resolved: Disk / is 92% full (5.5 GB free).',
    });
    expect(w.state.problems).toEqual({});
  });
});
