import { CreateWebhookSchema } from '@kovan/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/guard.js';
import { authorize } from '../authz.js';
import type { AppContext } from '../context.js';
import { badRequest } from '../errors.js';
import { targetProblem } from './deliver.js';

const Ws = z.object({ id: z.string().uuid() });
const Hook = z.object({ id: z.string().uuid(), hookId: z.string().uuid() });

export function registerEventRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { events, db, audit } = ctx;

  // The stream: anyone who can see the workspace (and read-scoped API keys).
  app.get('/api/workspaces/:id/events', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = Ws.parse(req.params);
    await authorize(db, id, user.id, 'session.view');
    const q = z
      .object({
        since: z.coerce.number().int().min(0).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        wait: z.coerce.number().int().min(0).max(30).default(0),
      })
      .parse(req.query);
    return events.stream([id], { since: q.since ?? null, limit: q.limit, waitS: q.wait });
  });

  // ---------- webhooks (owners) ----------

  app.get('/api/workspaces/:id/webhooks', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = Ws.parse(req.params);
    await authorize(db, id, user.id, 'workspace.manageSettings');
    return { webhooks: await events.hooks({ workspaceId: id }) };
  });

  app.post('/api/workspaces/:id/webhooks', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = Ws.parse(req.params);
    await authorize(db, id, user.id, 'workspace.manageSettings');
    const input = CreateWebhookSchema.parse(req.body);
    const problem = targetProblem(input.url, ctx.config.KOVAN_WEBHOOK_ALLOW);
    if (problem) throw badRequest(problem);
    const { row, secret } = await events.createHook({ workspaceId: id }, user, input);
    await audit.record({
      workspaceId: id,
      actor: user,
      action: 'webhook.created',
      target: new URL(row.url).host,
      req,
    });
    return {
      webhook: (await events.hooks({ workspaceId: id })).find((h) => h.id === row.id),
      secret,
    };
  });

  app.delete('/api/workspaces/:id/webhooks/:hookId', async (req) => {
    const user = await requireUser(ctx, req);
    const { id, hookId } = Hook.parse(req.params);
    await authorize(db, id, user.id, 'workspace.manageSettings');
    const row = await events.removeHook({ workspaceId: id }, hookId);
    await audit.record({
      workspaceId: id,
      actor: user,
      action: 'webhook.deleted',
      target: new URL(row.url).host,
      req,
    });
    return { ok: true };
  });

  app.post('/api/workspaces/:id/webhooks/:hookId/ping', async (req) => {
    const user = await requireUser(ctx, req);
    const { id, hookId } = Hook.parse(req.params);
    await authorize(db, id, user.id, 'workspace.manageSettings');
    const delivery = await events.ping({ workspaceId: id }, hookId, user);
    return { deliveryId: delivery.id };
  });

  app.get('/api/workspaces/:id/webhooks/:hookId/deliveries', async (req) => {
    const user = await requireUser(ctx, req);
    const { id, hookId } = Hook.parse(req.params);
    await authorize(db, id, user.id, 'workspace.manageSettings');
    return { deliveries: await events.deliveries({ workspaceId: id }, hookId) };
  });
}
