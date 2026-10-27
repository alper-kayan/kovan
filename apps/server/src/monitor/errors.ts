/**
 * What failed on the server, as `GET /api/ops/errors` groups it, turned into what the operator
 * should hear: a kind of error not seen in the last 30 days, and a burst of them.
 */
import type { Alert } from './monitor.js';

export interface ErrorGroup {
  key: string;
  source: string;
  message: string;
  count: number;
  first: string;
  last: string;
}

export interface ErrorsReport {
  /** The server's time when it answered: where the next look starts. */
  now: string;
  /** Not written because of the server's cap, since it started. */
  dropped: number;
  groups: ErrorGroup[];
}

export interface ErrorsState {
  /** Where the next look starts (the server's clock); null: never looked. */
  since: string | null;
  /** Each kind seen, and when last. */
  known: Record<string, number>;
  dropped: number;
  /** When the operator was last told about a burst. */
  burstAt: number | null;
}

export const freshErrors = (): ErrorsState => ({
  since: null,
  known: {},
  dropped: 0,
  burstAt: null,
});

export const ERRORS = {
  /** In one look (5 minutes): a burst. */
  burst: 30,
  burstEveryMs: 3_600_000,
  forgetAfterMs: 30 * 86_400_000,
  /** The first look reaches back this far, to learn what is usual without telling anyone. */
  firstLookMs: 30 * 86_400_000,
};

const SOURCES: Record<string, string> = {
  server: 'Server',
  main: 'Desktop',
  renderer: 'Desktop window',
};

/** Where the next look starts. */
export const nextSince = (state: ErrorsState, now: number) =>
  state.since ?? new Date(now - ERRORS.firstLookMs).toISOString();

export function reviewErrors(
  state: ErrorsState,
  report: ErrorsReport,
  now: number,
): { state: ErrorsState; alerts: Alert[] } {
  const first = state.since === null;
  const known = { ...state.known };
  const fresh = report.groups.filter((g) => !(g.key in known));
  for (const g of report.groups) known[g.key] = now;
  for (const [key, at] of Object.entries(known))
    if (now - at > ERRORS.forgetAfterMs) delete known[key];
  // The server's count starts again when it restarts.
  const dropped = report.dropped >= state.dropped ? report.dropped - state.dropped : report.dropped;
  const total = report.groups.reduce((n, g) => n + g.count, 0) + dropped;

  const alerts: Alert[] = [];
  let burstAt = state.burstAt;
  if (!first) {
    if (fresh.length) {
      const lines = fresh
        .slice(0, 3)
        .map((g) => `${SOURCES[g.source] ?? g.source}: ${g.message.slice(0, 160)} (${g.count}×)`);
      if (fresh.length > 3) lines.push(`and ${fresh.length - 3} more kinds`);
      alerts.push({
        title: fresh.length === 1 ? 'New error on Kovan' : `${fresh.length} new errors on Kovan`,
        body: lines.join('\n'),
      });
    }
    if (total >= ERRORS.burst && (burstAt === null || now - burstAt >= ERRORS.burstEveryMs)) {
      const top = [...report.groups].sort((a, b) => b.count - a.count)[0];
      alerts.push({
        title: 'Errors are piling up on Kovan',
        body: `${total} in the last few minutes${top ? `, most: ${top.message.slice(0, 160)} (${top.count}×)` : ''}.`,
      });
      burstAt = now;
    }
  }
  return {
    state: { since: report.now, known, dropped: report.dropped, burstAt },
    alerts,
  };
}
