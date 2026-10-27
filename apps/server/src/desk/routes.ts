import { DeskActionSchema, DeskResultSchema } from '@kovan/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/guard.js';
import type { AppContext } from '../context.js';

const Id = z.object({ id: z.string().uuid() });
const Machine = z.object({ machineId: z.string().min(1).max(100) });

export function registerDeskRoutes(app: FastifyInstance, ctx: AppContext): void {
  // The phone asks; the person's desktop claims, does and reports.
  app.post('/api/desk', async (req, reply) => {
    const user = await requireUser(ctx, req);
    const { action } = z.object({ action: DeskActionSchema }).parse(req.body);
    return ctx.idempotency.run(req, reply, `user:${user.id}`, async () => ({
      request: await ctx.desk.ask(user.id, action),
    }));
  });
  app.post('/api/desk/:id/claim', async (req) => {
    const user = await requireUser(ctx, req);
    const { machineId } = Machine.parse(req.body);
    ctx.desk.claim(Id.parse(req.params).id, user.id, machineId);
    return { ok: true };
  });
  app.post('/api/desk/:id/done', async (req) => {
    const user = await requireUser(ctx, req);
    const body = Machine.merge(DeskResultSchema).parse(req.body);
    ctx.desk.done(Id.parse(req.params).id, user.id, body.machineId, body.ok, body.message);
    return { ok: true };
  });
}
