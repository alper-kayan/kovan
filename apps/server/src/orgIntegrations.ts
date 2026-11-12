import { CreateApiKeySchema, CreateWebhookSchema, RegisterMachineSchema } from '@kovan/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from './auth/guard.js';
import type { AppContext } from './context.js';
import { orgMembers, workspaceMembers } from './db/schema.js';
import { badRequest, forbidden, notFound } from './errors.js';
import { targetProblem } from './events/deliver.js';
import { requireOrgOwner, visibleOrgWorkspaces } from './scope.js';

const Org = z.object({ id: z.string().uuid() });
const OrgItem = z.object({ id: z.string().uuid(), itemId: z.string().uuid() });

/**
 * Integrations of a whole organization: one API key, one webhook and one event stream for
 * all its workspaces (later ones too), and machines that serve every workspace whose
 * repository they hold. Its owners set them up; keys and members read what they can see.
 */
export function registerOrgIntegrationRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, apiKeys, events, machines, audit } = ctx;

  /** The organization's workspaces this caller (a person or a key) is a member of; 404 if none. */
  const visible = async (orgId: string, userId: string) => {
    const mine = await db
      .select({ id: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, userId));
    const ids = await visibleOrgWorkspaces(
      db,
      orgId,
      mine.map((m) => m.id),
    );
    if (ids.length === 0) throw notFound('Organization not found');
    return ids;
  };

  // A key asks what it is: agentd learns whether it serves a workspace or an organization.
  app.get('/api/keys/me', async (req) => {
    const user = await requireUser(ctx, req);
    const key = await apiKeys.keyOf(user.id);
    if (!key) throw notFound('This is not an API key');
    return { key };
  });

  // ---------- keys ----------

  app.get('/api/orgs/:id/api-keys', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = Org.parse(req.params);
    await requireOrgOwner(db, id, user.id);
    return { keys: await apiKeys.list({ orgId: id }) };
  });
  app.post('/api/orgs/:id/api-keys', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = Org.parse(req.params);
    await requireOrgOwner(db, id, user.id);
    const created = await apiKeys.create({ orgId: id }, user, CreateApiKeySchema.parse(req.body));
    await audit.record({
      orgId: id,
      actor: user,
      action: 'api_key.created',
      target: created.key.name,
      meta: { scopes: created.key.scopes.join(' '), covers: 'organization' },
      req,
    });
    return created;
  });
  app.delete('/api/orgs/:id/api-keys/:itemId', async (req) => {
    const user = await requireUser(ctx, req);
    const { id, itemId } = OrgItem.parse(req.params);
    await requireOrgOwner(db, id, user.id);
    const revoked = await apiKeys.revoke({ orgId: id }, itemId);
    await audit.record({
      orgId: id,
      actor: user,
      action: 'api_key.revoked',
      target: revoked.name,
      req,
    });
    return { ok: true };
  });

  // ---------- events and webhooks ----------

  app.get('/api/orgs/:id/events', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = Org.parse(req.params);
    const q = z
      .object({
        since: z.coerce.number().int().min(0).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        wait: z.coerce.number().int().min(0).max(30).default(0),
      })
      .parse(req.query);
    return events.stream(await visible(id, user.id), {
      since: q.since ?? null,
      limit: q.limit,
      waitS: q.wait,
    });
  });

  app.get('/api/orgs/:id/webhooks', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = Org.parse(req.params);
    await requireOrgOwner(db, id, user.id);
    return { webhooks: await events.hooks({ orgId: id }) };
  });
  app.post('/api/orgs/:id/webhooks', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = Org.parse(req.params);
    await requireOrgOwner(db, id, user.id);
    const input = CreateWebhookSchema.parse(req.body);
    const problem = targetProblem(input.url, ctx.config.KOVAN_WEBHOOK_ALLOW);
    if (problem) throw badRequest(problem);
    const { row, secret } = await events.createHook({ orgId: id }, user, input);
    await audit.record({
      orgId: id,
      actor: user,
      action: 'webhook.created',
      target: new URL(row.url).host,
      req,
    });
    return { webhook: (await events.hooks({ orgId: id })).find((h) => h.id === row.id), secret };
  });
  app.delete('/api/orgs/:id/webhooks/:itemId', async (req) => {
    const user = await requireUser(ctx, req);
    const { id, itemId } = OrgItem.parse(req.params);
    await requireOrgOwner(db, id, user.id);
    const row = await events.removeHook({ orgId: id }, itemId);
    await audit.record({
      orgId: id,
      actor: user,
      action: 'webhook.deleted',
      target: new URL(row.url).host,
      req,
    });
    return { ok: true };
  });
  app.post('/api/orgs/:id/webhooks/:itemId/ping', async (req) => {
    const user = await requireUser(ctx, req);
    const { id, itemId } = OrgItem.parse(req.params);
    await requireOrgOwner(db, id, user.id);
    return { deliveryId: (await events.ping({ orgId: id }, itemId, user)).id };
  });
  app.get('/api/orgs/:id/webhooks/:itemId/deliveries', async (req) => {
    const user = await requireUser(ctx, req);
    const { id, itemId } = OrgItem.parse(req.params);
    await requireOrgOwner(db, id, user.id);
    return { deliveries: await events.deliveries({ orgId: id }, itemId) };
  });

  // ---------- machines ----------

  app.get('/api/orgs/:id/machines', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = Org.parse(req.params);
    // A member of an organization without workspaces yet sees an empty list, not "not found".
    const [member] = await db
      .select({ role: orgMembers.role })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, id), eq(orgMembers.userId, user.id)));
    if (!member) await visible(id, user.id);
    return { machines: await machines.listOrg(id) };
  });
  // agentd with an organization's machine key.
  app.post('/api/orgs/:id/machines', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = Org.parse(req.params);
    const key = await apiKeys.keyOf(user.id);
    if (key?.orgId !== id) throw forbidden('Register with a machine key of this organization');
    const machine = await machines.register(
      { orgId: id },
      user.id,
      RegisterMachineSchema.parse(req.body),
    );
    return { machine, work: await machines.work(machine.id) };
  });
  app.delete('/api/orgs/:id/machines/:itemId', async (req) => {
    const user = await requireUser(ctx, req);
    const { id, itemId } = OrgItem.parse(req.params);
    await requireOrgOwner(db, id, user.id);
    const gone = await machines.remove({ orgId: id }, itemId);
    await audit.record({
      orgId: id,
      actor: user,
      action: 'machine.removed',
      target: gone.name,
      req,
    });
    return { ok: true };
  });
}
