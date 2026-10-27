/**
 * The outside monitor: runs on another machine (deploy/monitor), checks the server every minute
 * and tells its operator's phone when it goes down and when it is back. It sends straight to
 * Apple, so a warning doesn't depend on the server it is about; the phones to send to are
 * fetched from the server while it is up (`GET /api/ops/push-targets`) and kept. While it is up
 * it also reads the host's own report (disk, memory, containers, backups) and the HTTPS
 * certificate, and says when something there goes wrong and when it is fine again, and what
 * failed on the server: a new kind of error, or a burst of them.
 */

import {
  freshErrors,
  nextSince,
  reviewErrors,
  type ErrorsReport,
  type ErrorsState,
} from './errors.js';
import { problemsOf, type HostStatus, type Offsite, type Seen } from './host.js';

export interface Device {
  platform: 'ios' | 'android';
  token: string;
  sandbox: boolean;
}

export interface MonitorState {
  /** Failed checks in a row. */
  failures: number;
  /** When the first of them failed. */
  downSince: number | null;
  reason: string | null;
  /** When the operator was last told it is down; null: not told (yet). */
  alertedAt: number | null;
  devices: Device[];
  devicesAt: number | null;
  /** What is wrong on the host, by key: since when, and when the operator was last told. */
  problems: Record<string, { text: string; since: number; alertedAt: number }>;
  /** When the host's report was last read. */
  hostAt: number | null;
  seen: Seen;
  /** What failed on the server, looked at with the host's report. */
  errors: ErrorsState;
}

export const freshState = (): MonitorState => ({
  failures: 0,
  downSince: null,
  reason: null,
  alertedAt: null,
  devices: [],
  devicesAt: null,
  problems: {},
  hostAt: null,
  seen: { restarts: {} },
  errors: freshErrors(),
});

export interface Alert {
  title: string;
  body: string;
}

export interface MonitorOptions {
  /** The server, e.g. https://kovan.alperkayan.dev */
  url: string;
  opsToken: string;
  /** Failed checks in a row before the operator is told (a blip of a minute isn't news). */
  failAfter?: number;
  /** While it stays down, say so again this often. */
  remindEveryMs?: number;
  /** How often the phones are fetched again while the server is up. */
  refreshEveryMs?: number;
  /** How often the host's report and the certificate are looked at while the server is up. */
  hostEveryMs?: number;
  /** A problem on the host that stays: say so again this often. */
  remindProblemsEveryMs?: number;
  /** When the server's HTTPS certificate expires (ms); not given: not checked. */
  certExpiry?: (host: string) => Promise<number>;
  /** The backups this machine keeps; not given: it keeps none. */
  offsite?: () => Offsite;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  /** Sends one alert to these phones; returns the tokens Apple says are gone for good. */
  send: (devices: Device[], alert: Alert) => Promise<string[]>;
  log?: (line: string) => void;
  /** For the times in the messages; the machine's own zone when not given. */
  timeZone?: string;
}

const minutes = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};
const clock = (at: number, timeZone?: string) =>
  new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone });

/** What a user would notice: the API answering, and the site (and sign-in) loading. */
async function check(o: Required<Pick<MonitorOptions, 'url' | 'fetch' | 'timeoutMs'>>) {
  const get = (path: string) =>
    o.fetch(`${o.url}${path}`, {
      signal: AbortSignal.timeout(o.timeoutMs),
      headers: { 'user-agent': 'kovan-monitor' },
    });
  try {
    const health = await get('/health');
    if (health.status !== 200) return `/health answered ${health.status}`;
    const body = (await health.json().catch(() => null)) as { ok?: boolean } | null;
    if (!body?.ok) return '/health says it is not ok';
    const site = await get('/');
    if (site.status !== 200) return `The site answered ${site.status}`;
    return null;
  } catch (error) {
    const e = error as Error & { cause?: { code?: string } };
    if (e.name === 'TimeoutError') return `No answer in ${Math.round(o.timeoutMs / 1000)} s`;
    return `Can't reach it (${e.cause?.code ?? e.message})`;
  }
}

/** One round: check, tell the operator when that changes something, keep the phones fresh. */
export async function tick(state: MonitorState, options: MonitorOptions): Promise<MonitorState> {
  const o = {
    failAfter: 3,
    remindEveryMs: 60 * 60_000,
    refreshEveryMs: 30 * 60_000,
    hostEveryMs: 5 * 60_000,
    remindProblemsEveryMs: 24 * 3_600_000,
    timeoutMs: 10_000,
    fetch: globalThis.fetch,
    now: Date.now,
    log: () => {},
    ...options,
  };
  const now = o.now();
  const s = { ...state, problems: { ...state.problems } };
  const tell = async (alert: Alert) => {
    const ios = s.devices.filter((d) => d.platform === 'ios');
    if (ios.length === 0) {
      o.log(`No phone to tell: ${alert.title}. ${alert.body}`);
      return;
    }
    const gone = await o.send(ios, alert);
    if (gone.length) s.devices = s.devices.filter((d) => !gone.includes(d.token));
    o.log(`Told ${ios.length - gone.length} phone(s): ${alert.title}. ${alert.body}`);
  };

  const reason = await check(o);
  if (reason) {
    s.failures += 1;
    s.downSince ??= now;
    s.reason = reason;
    o.log(`Check failed (${s.failures} in a row): ${reason}`);
    if (s.failures >= o.failAfter && s.alertedAt === null) {
      await tell({
        title: 'Kovan is down',
        body: `${reason}. Since ${clock(s.downSince, o.timeZone)}.`,
      });
      s.alertedAt = now;
    } else if (s.alertedAt !== null && now - s.alertedAt >= o.remindEveryMs) {
      await tell({
        title: 'Kovan is still down',
        body: `For ${minutes(now - s.downSince)}: ${reason}.`,
      });
      s.alertedAt = now;
    }
    return s;
  }

  if (s.alertedAt !== null && s.downSince !== null)
    await tell({
      title: 'Kovan is back',
      body: `It was down for ${minutes(now - s.downSince)} (${s.reason}).`,
    });
  else if (s.failures > 0) o.log(`Up again after ${s.failures} failed check(s)`);
  s.failures = 0;
  s.downSince = null;
  s.reason = null;
  s.alertedAt = null;

  if (s.devicesAt === null || now - s.devicesAt >= o.refreshEveryMs) {
    try {
      const res = await o.fetch(`${o.url}/api/ops/push-targets`, {
        signal: AbortSignal.timeout(o.timeoutMs),
        headers: { authorization: `Bearer ${o.opsToken}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { devices } = (await res.json()) as { devices: Device[] };
      if (devices.length === 0) o.log('The server knows no phone for the operator');
      s.devices = devices;
      s.devicesAt = now;
    } catch (error) {
      // Keep the phones we had: a wrong answer now mustn't leave us with nobody to tell.
      o.log(`Couldn't fetch the phones: ${(error as Error).message}`);
    }
  }

  if (s.hostAt === null || now - s.hostAt >= o.hostEveryMs) {
    s.hostAt = now;
    let status: HostStatus | null = null;
    try {
      const res = await o.fetch(`${o.url}/api/ops/status`, {
        signal: AbortSignal.timeout(o.timeoutMs),
        headers: { authorization: `Bearer ${o.opsToken}` },
      });
      // 404: the host writes no report (yet); the certificate is still worth a look.
      if (res.status !== 404) {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        status = (await res.json()) as HostStatus;
      }
    } catch (error) {
      o.log(`Couldn't read the host's report: ${(error as Error).message}`);
      return s;
    }
    let cert: number | null = null;
    if (o.certExpiry)
      try {
        cert = await o.certExpiry(new URL(o.url).hostname);
      } catch (error) {
        o.log(`Couldn't read the certificate: ${(error as Error).message}`);
      }
    const current = problemsOf(status, cert, s.seen, now, o.offsite?.());
    const fresh = Object.keys(current).filter((k) => !s.problems[k]);
    const over = Object.keys(s.problems).filter((k) => !current[k]);
    const stale = Object.keys(current).filter(
      (k) => s.problems[k] && now - s.problems[k].alertedAt >= o.remindProblemsEveryMs,
    );
    if (fresh.length) {
      await tell({
        title: 'Kovan needs a look',
        body: fresh.map((k) => current[k]).join(' '),
      });
      for (const k of fresh) s.problems[k] = { text: current[k]!, since: now, alertedAt: now };
    }
    if (stale.length) {
      await tell({
        title: 'Kovan still needs a look',
        body: stale
          .map((k) => `${current[k]} (since ${clock(s.problems[k]!.since, o.timeZone)})`)
          .join(' '),
      });
      for (const k of stale)
        s.problems[k] = { ...s.problems[k]!, text: current[k]!, alertedAt: now };
    }
    if (over.length) {
      await tell({
        title: 'Kovan is fine again',
        body: `Resolved: ${over.map((k) => s.problems[k]!.text).join(' ')}`,
      });
      for (const k of over) delete s.problems[k];
    }
    for (const k of Object.keys(current)) if (s.problems[k]) s.problems[k].text = current[k]!;

    try {
      const since = encodeURIComponent(nextSince(s.errors, now));
      const res = await o.fetch(`${o.url}/api/ops/errors?since=${since}`, {
        signal: AbortSignal.timeout(o.timeoutMs),
        headers: { authorization: `Bearer ${o.opsToken}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const looked = reviewErrors(s.errors, (await res.json()) as ErrorsReport, now);
      s.errors = looked.state;
      for (const alert of looked.alerts) await tell(alert);
    } catch (error) {
      o.log(`Couldn't read the server's errors: ${(error as Error).message}`);
    }
  }
  return s;
}
