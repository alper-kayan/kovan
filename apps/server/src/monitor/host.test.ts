import { describe, expect, it } from 'vitest';
import { problemsOf, type HostStatus, type Offsite, type Seen } from './host.js';

const now = Date.UTC(2026, 9, 25, 9, 0);
const ago = (ms: number) => new Date(now - ms).toISOString();
const healthy = (): HostStatus => ({
  at: ago(60_000),
  disks: [{ mount: '/', usedPct: 50, freeGb: 30 }],
  memory: { availablePct: 60 },
  containers: [
    { name: 'kovan-prod-server-1', state: 'running', health: 'healthy', restarts: 0 },
    { name: 'kovan-prod-backup-1', state: 'running', health: null, restarts: 0 },
  ],
  backup: { file: 'kovan-x.dump.enc', at: ago(3 * 3_600_000) },
  restore: {
    at: ago(2 * 86_400_000),
    ok: true,
    detail: 'kovan-x.dump.enc restored',
    file: 'kovan-x.dump.enc',
    sha256: 'abc',
  },
});
const fresh = (): Seen => ({ restarts: {} });
const copies = (newestAt: number | null, sha: string | null = null): Offsite => ({
  newestAt,
  sha256Of: () => sha,
});

describe('what the host says is wrong', () => {
  it('is nothing on a healthy host with a certificate months away', () => {
    expect(problemsOf(healthy(), now + 60 * 86_400_000, fresh(), now)).toEqual({});
  });

  it('names a full disk, low memory, a stopped or unhealthy container, an old backup', () => {
    const s = healthy();
    s.disks[0] = { mount: '/', usedPct: 91, freeGb: 5.5 };
    s.memory.availablePct = 4;
    s.containers[0]!.health = 'unhealthy';
    s.containers[1]!.state = 'exited';
    s.backup = { file: 'kovan-x.dump.enc', at: ago(30 * 3_600_000) };
    expect(problemsOf(s, null, fresh(), now)).toEqual({
      'disk:/': 'Disk / is 91% full (5.5 GB free).',
      memory: 'Only 4% of the memory is free.',
      'container:kovan-prod-server-1': 'kovan-prod-server-1 is unhealthy.',
      'container:kovan-prod-backup-1': 'kovan-prod-backup-1 is exited.',
      backup: 'The newest database backup is 30 h old.',
    });
    expect(problemsOf({ ...healthy(), backup: null }, null, fresh(), now)).toEqual({
      backup: 'There is no database backup.',
    });
  });

  it('tells a crash loop from a restart now and then', () => {
    const seen = fresh();
    const check = (restarts: number, later: number) => {
      const s = { ...healthy(), at: new Date(now + later).toISOString() };
      s.containers[0]!.restarts = restarts;
      return problemsOf(s, null, seen, now + later);
    };
    expect(check(5, 0)).toEqual({});
    expect(check(7, 20 * 60_000)).toEqual({});
    expect(check(8, 40 * 60_000)).toEqual({
      'container:kovan-prod-server-1': 'kovan-prod-server-1 restarted 3 times within the hour.',
    });
    // An hour on, counting starts again from there.
    expect(check(8, 70 * 60_000)).toEqual({});
  });

  it('notices a report the host stopped writing, and a certificate about to run out', () => {
    expect(problemsOf({ ...healthy(), at: ago(45 * 60_000) }, null, fresh(), now)).toEqual({
      status: "The host's own report is 45 min old: is its cron running?",
    });
    expect(problemsOf(null, now + 5 * 86_400_000, fresh(), now)).toEqual({
      cert: 'The HTTPS certificate expires in 5 days.',
    });
    expect(problemsOf(null, now - 1, fresh(), now)).toEqual({
      cert: 'The HTTPS certificate has expired.',
    });
  });

  it('watches the copies off the server when the machine keeps them', () => {
    expect(problemsOf(healthy(), null, fresh(), now, copies(now - 20 * 3_600_000))).toEqual({});
    expect(problemsOf(healthy(), null, fresh(), now, copies(now - 50 * 3_600_000))).toEqual({
      offsite: 'The newest backup copied off the server is 50 h old.',
    });
    expect(problemsOf(healthy(), null, fresh(), now, copies(null))).toEqual({
      offsite: 'There is no copy of the backups off the server.',
    });
  });

  it('names a failed, missing or old restore drill, and a copy that differs from the server', () => {
    const failed = {
      ...healthy().restore!,
      ok: false,
      detail: "kovan-x.dump.enc didn't restore: bad",
    };
    expect(problemsOf({ ...healthy(), restore: failed }, null, fresh(), now)).toEqual({
      restore: "The restore drill failed: kovan-x.dump.enc didn't restore: bad",
    });
    expect(problemsOf({ ...healthy(), restore: null }, null, fresh(), now)).toEqual({
      restore: 'No restore drill has run yet.',
    });
    const old = { ...healthy().restore!, at: ago(9 * 86_400_000) };
    expect(problemsOf({ ...healthy(), restore: old }, null, fresh(), now)).toEqual({
      restore: 'The last restore drill was 9 days ago.',
    });
    const recent = now - 3_600_000;
    expect(problemsOf(healthy(), null, fresh(), now, copies(recent, 'abc'))).toEqual({});
    expect(problemsOf(healthy(), null, fresh(), now, copies(recent, null))).toEqual({});
    expect(problemsOf(healthy(), null, fresh(), now, copies(recent, 'xyz'))).toEqual({
      'offsite-copy': "The copy of kovan-x.dump.enc off the server differs from the server's.",
    });
  });
});
