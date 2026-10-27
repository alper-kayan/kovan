import { RegisterDeviceSchema, UpdateDeviceSchema, type PushDevice } from '@kovan/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { bearerToken, requireUser } from '../auth/guard.js';
import { sessionIdOf } from '../auth/sessions.js';
import type { AppContext } from '../context.js';
import { pushDevices } from '../db/schema.js';
import { notFound, unauthorized } from '../errors.js';

type Row = typeof pushDevices.$inferSelect;
const toDevice = (row: Row): PushDevice => ({
  platform: row.platform,
  muted: row.muted as PushDevice['muted'],
  createdAt: row.createdAt.toISOString(),
});

const Token = z.object({ token: z.string().min(8).max(4096) });

export function registerPushRoutes(app: FastifyInstance, ctx: AppContext): void {
  // A phone registers its push token for this sign-in; the same token moves to whoever signed
  // in last on that phone (keeping what it had turned off when it is the same person).
  app.post('/api/push/devices', async (req) => {
    const user = await requireUser(ctx, req);
    const authSessionId = await sessionIdOf(ctx.db, bearerToken(req)!);
    if (!authSessionId) throw unauthorized();
    const input = RegisterDeviceSchema.parse(req.body);
    const [existing] = await ctx.db
      .select()
      .from(pushDevices)
      .where(and(eq(pushDevices.platform, input.platform), eq(pushDevices.token, input.token)));
    const values = {
      userId: user.id,
      authSessionId,
      sandbox: input.sandbox,
      appVersion: input.appVersion,
      updatedAt: new Date(),
      ...(existing && existing.userId !== user.id ? { muted: [] } : {}),
    };
    const [row] = existing
      ? await ctx.db
          .update(pushDevices)
          .set(values)
          .where(eq(pushDevices.id, existing.id))
          .returning()
      : await ctx.db
          .insert(pushDevices)
          .values({ ...values, platform: input.platform, token: input.token })
          .returning();
    return { device: toDevice(row!), enabled: ctx.push.enabled };
  });

  // What this phone turned off. Only the person it is registered to can change it.
  app.patch('/api/push/devices', async (req) => {
    const user = await requireUser(ctx, req);
    const { token, muted } = Token.merge(UpdateDeviceSchema).parse(req.body);
    const [row] = await ctx.db
      .update(pushDevices)
      .set({ muted, updatedAt: new Date() })
      .where(and(eq(pushDevices.token, token), eq(pushDevices.userId, user.id)))
      .returning();
    if (!row) throw notFound('This phone is not registered for notifications');
    return { device: toDevice(row) };
  });

  // Signing out on the phone: no more notifications there.
  app.post('/api/push/devices/remove', async (req) => {
    const user = await requireUser(ctx, req);
    const { token } = Token.parse(req.body);
    await ctx.db
      .delete(pushDevices)
      .where(and(eq(pushDevices.token, token), eq(pushDevices.userId, user.id)));
    return { ok: true };
  });
}
