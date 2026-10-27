import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { bearerToken } from './auth/guard.js';
import type { AppContext } from './context.js';
import { pushDevices, users } from './db/schema.js';
import { errorGroups, type ServerErrors } from './errorLog.js';
import { notFound, unauthorized } from './errors.js';

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * For the outside monitor (deploy/monitor). It runs off this server so it can tell when the
 * server is down, and then the server can't say where to send the warning: so while the server
 * is up the monitor keeps a copy of the phones of the person who runs it (OPS_EMAIL).
 */
export function registerOpsRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  serverErrors: ServerErrors,
): void {
  const { OPS_TOKEN, OPS_EMAIL } = ctx.config;
  const allowed = (token: string | null) => timingSafeEqual(digest(token ?? ''), digest(OPS_TOKEN));

  app.get('/api/ops/push-targets', async (req) => {
    if (!OPS_TOKEN || !OPS_EMAIL) throw notFound();
    if (!allowed(bearerToken(req))) throw unauthorized();
    const rows = await ctx.db
      .select({
        platform: pushDevices.platform,
        token: pushDevices.token,
        sandbox: pushDevices.sandbox,
      })
      .from(pushDevices)
      .innerJoin(users, eq(users.id, pushDevices.userId))
      .where(sql`lower(${users.email}) = ${OPS_EMAIL.toLowerCase()}`);
    return { devices: rows };
  });

  // The host's own report (disk, memory, Kovan's containers, the newest backup), written by
  // deploy/ops-status.py from cron into a folder mounted read-only here.
  app.get('/api/ops/status', async (req, reply) => {
    if (!OPS_TOKEN || !ctx.config.OPS_STATUS_FILE) throw notFound();
    if (!allowed(bearerToken(req))) throw unauthorized();
    const text = await readFile(ctx.config.OPS_STATUS_FILE, 'utf8').catch(() => null);
    if (text === null) throw notFound('The host has not written its report yet.');
    return reply.type('application/json').send(text);
  });

  // What failed since `since`, grouped: the server's 500s and the desktop apps' reports.
  app.get('/api/ops/errors', async (req) => {
    if (!OPS_TOKEN) throw notFound();
    if (!allowed(bearerToken(req))) throw unauthorized();
    const { since } = z.object({ since: z.string().datetime({ offset: true }) }).parse(req.query);
    const now = new Date();
    return {
      now: now.toISOString(),
      dropped: serverErrors.dropped,
      groups: await errorGroups(ctx.db, new Date(since)),
    };
  });
}
