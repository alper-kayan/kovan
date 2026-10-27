import { gt } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { errorReports } from './db/schema.js';

/**
 * The server's own failures (the 500s) go where the desktop apps' reports go, as source
 * "server", so the outside monitor sees them all in one place (`GET /api/ops/errors`). A burst
 * is capped: past the limit in a minute they are only counted.
 */
export class ServerErrors {
  private window = { start: 0, count: 0 };
  /** Not written because of the cap, since the server started. */
  dropped = 0;

  constructor(
    private readonly db: Db,
    private readonly perMinute = 60,
  ) {}

  record(where: string, error: unknown): void {
    const now = Date.now();
    if (now - this.window.start >= 60_000) this.window = { start: now, count: 0 };
    if (++this.window.count > this.perMinute) {
      this.dropped += 1;
      return;
    }
    const e = error instanceof Error ? error : new Error(String(error));
    void this.db
      .insert(errorReports)
      .values({
        userId: null,
        source: 'server',
        message: `${where}: ${e.name}: ${e.message}`.slice(0, 2000),
        stack: e.stack?.slice(0, 20_000) ?? null,
        appVersion: 'server',
        platform: process.platform,
      })
      .catch(() => {});
  }
}

export interface ErrorGroup {
  /** The same for the same failure: where it came from and its message without ids or numbers. */
  key: string;
  source: string;
  /** One of them, first line only. */
  message: string;
  count: number;
  first: string;
  last: string;
}

const shape = (message: string) =>
  (message.split('\n')[0] ?? '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\d+/g, '<n>')
    .slice(0, 200);

/** The errors after `since`, grouped by what failed. */
export async function errorGroups(db: Db, since: Date): Promise<ErrorGroup[]> {
  const rows = await db
    .select({
      source: errorReports.source,
      message: errorReports.message,
      createdAt: errorReports.createdAt,
    })
    .from(errorReports)
    .where(gt(errorReports.createdAt, since))
    .orderBy(errorReports.createdAt)
    .limit(10_000);
  const groups = new Map<string, ErrorGroup>();
  for (const row of rows) {
    const key = `${row.source}|${shape(row.message)}`;
    const at = row.createdAt.toISOString();
    const group = groups.get(key);
    if (group) {
      group.count += 1;
      group.last = at;
    } else
      groups.set(key, {
        key,
        source: row.source,
        message: (row.message.split('\n')[0] ?? '').slice(0, 300),
        count: 1,
        first: at,
        last: at,
      });
  }
  return [...groups.values()];
}
