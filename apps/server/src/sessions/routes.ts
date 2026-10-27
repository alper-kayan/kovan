import { randomUUID } from 'node:crypto';
import {
  EndSessionSchema,
  JoinSessionSchema,
  SessionChangesInputSchema,
  SessionPrSchema,
  StartSessionSchema,
  StartSubagentSchema,
  UpdateSubagentSchema,
} from '@kovan/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/guard.js';
import { authorize } from '../authz.js';
import type { AppContext } from '../context.js';

const SessionParams = z.object({ id: z.string() });
/** Routes that carry a diff (up to 400k characters, more once JSON-escaped). */
const DIFF_BODY = { bodyLimit: 1_500_000 };
const WorkspaceParams = z
  .object({ id: z.string().uuid() })
  .transform((p) => ({ workspaceId: p.id }));

export function registerSessionRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { sessions } = ctx;

  /** Picks the machine new work runs on, once the caller may start work there. */
  const chooseMachine = async (workspaceId: string, userId: string, choice: string) => {
    await authorize(ctx.db, workspaceId, userId, 'session.start');
    return ctx.machines.choose(workspaceId, choice);
  };

  app.get('/api/workspaces/:id/sessions', async (req) => {
    const user = await requireUser(ctx, req);
    const { workspaceId } = WorkspaceParams.parse(req.params);
    const { status } = z
      .object({ status: z.enum(['active', 'ended']).default('active') })
      .parse(req.query);
    return { sessions: await sessions.list(workspaceId, user.id, status) };
  });

  app.post('/api/workspaces/:id/sessions', async (req, reply) => {
    const user = await requireUser(ctx, req);
    const { workspaceId } = WorkspaceParams.parse(req.params);
    const input = StartSessionSchema.parse(req.body);
    return ctx.idempotency.run(req, reply, `user:${user.id}`, async () => ({
      session: await sessions.create(
        workspaceId,
        user.id,
        input,
        input.machine ? await chooseMachine(workspaceId, user.id, input.machine) : null,
      ),
    }));
  });

  app.get('/api/workspaces/:id/approvals', async (req) => {
    const user = await requireUser(ctx, req);
    const { workspaceId } = WorkspaceParams.parse(req.params);
    return { approvals: await sessions.pendingApprovals(workspaceId, user.id) };
  });

  app.get('/api/sessions/:id', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = SessionParams.parse(req.params);
    await sessions.visible(id, user.id);
    return { session: await sessions.view(id) };
  });

  app.post('/api/sessions/:id/join', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = SessionParams.parse(req.params);
    return { session: await sessions.join(id, user.id, JoinSessionSchema.parse(req.body ?? {})) };
  });

  app.post('/api/sessions/:id/leave', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = SessionParams.parse(req.params);
    return { session: await sessions.leave(id, user.id) };
  });

  app.post('/api/sessions/:id/end', DIFF_BODY, async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = SessionParams.parse(req.params);
    return { session: await sessions.end(id, user.id, EndSessionSchema.parse(req.body ?? {})) };
  });

  app.get('/api/sessions/:id/replay', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = SessionParams.parse(req.params);
    return { events: await sessions.replay(id, user.id) };
  });
  app.get('/api/sessions/:id/transcript', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = SessionParams.parse(req.params);
    return { lanes: await sessions.transcript(id, user.id) };
  });

  app.get('/api/sessions/:id/diff', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = SessionParams.parse(req.params);
    return { diff: await sessions.finalDiff(id, user.id) };
  });

  app.get('/api/sessions/:id/changes', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = SessionParams.parse(req.params);
    return { changes: await sessions.changes(id, user.id) };
  });
  app.put('/api/sessions/:id/changes', DIFF_BODY, async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = SessionParams.parse(req.params);
    await sessions.putChanges(id, user.id, SessionChangesInputSchema.parse(req.body ?? {}));
    return { ok: true };
  });

  // ---------- activity, locks, takeovers, outcomes ----------

  app.get('/api/sessions/:id/activity', async (req) => {
    const user = await requireUser(ctx, req);
    return { activity: await sessions.listActivity(SessionParams.parse(req.params).id, user.id) };
  });

  const Path = z.object({ path: z.string().min(1).max(500) });
  app.get('/api/sessions/:id/locks', async (req) => {
    const user = await requireUser(ctx, req);
    return { locks: await ctx.flow.locks(SessionParams.parse(req.params).id, user.id) };
  });
  app.post('/api/sessions/:id/locks', async (req) => {
    const user = await requireUser(ctx, req);
    const { path } = Path.parse(req.body);
    return { locks: await ctx.flow.lock(SessionParams.parse(req.params).id, user.id, path) };
  });
  app.post('/api/sessions/:id/unlock', async (req) => {
    const user = await requireUser(ctx, req);
    const { path } = Path.parse(req.body);
    return { locks: await ctx.flow.unlock(SessionParams.parse(req.params).id, user.id, path) };
  });
  app.get('/api/workspaces/:id/locks', async (req) => {
    const user = await requireUser(ctx, req);
    return {
      locks: await ctx.flow.workspaceLocks(WorkspaceParams.parse(req.params).workspaceId, user.id),
    };
  });
  app.get('/api/workspaces/:id/flow', async (req) => {
    const user = await requireUser(ctx, req);
    return ctx.flow.alerts(WorkspaceParams.parse(req.params).workspaceId, user.id);
  });

  const Context = z.object({
    lastPrompts: z.array(z.string().max(4000)).max(5),
    lastReply: z.string().max(8000).nullable(),
    touchedFiles: z.array(z.string().max(500)).max(50),
    reason: z.string().max(300),
  });
  const Snapshot = z.object({
    sha: z
      .string()
      .regex(/^[0-9a-f]{7,64}$/)
      .nullable(),
    ref: z.string().max(300).nullable(),
  });
  app.post('/api/sessions/:id/takeover', async (req) => {
    const user = await requireUser(ctx, req);
    const { laneUserId } = z.object({ laneUserId: z.string() }).parse(req.body);
    return {
      handoff: await ctx.flow.takeover(SessionParams.parse(req.params).id, user.id, laneUserId),
    };
  });
  app.post('/api/sessions/:id/handoff', async (req) => {
    const user = await requireUser(ctx, req);
    const body = z
      .object({ toUserId: z.string(), snapshot: Snapshot, context: Context })
      .parse(req.body);
    return {
      handoff: await ctx.flow.handoff(
        SessionParams.parse(req.params).id,
        user.id,
        body.toUserId,
        body.snapshot,
        body.context,
      ),
    };
  });
  app.post('/api/handoffs/:id/ready', async (req) => {
    const user = await requireUser(ctx, req);
    const body = z.object({ snapshot: Snapshot, context: Context }).parse(req.body);
    return {
      handoff: await ctx.flow.ready(
        SessionParams.parse(req.params).id,
        user.id,
        body.snapshot,
        body.context,
      ),
    };
  });
  app.post('/api/handoffs/:id/accept', async (req) => {
    const user = await requireUser(ctx, req);
    return ctx.flow.accept(SessionParams.parse(req.params).id, user.id);
  });
  app.post('/api/handoffs/:id/decline', async (req) => {
    const user = await requireUser(ctx, req);
    return { handoff: await ctx.flow.decline(SessionParams.parse(req.params).id, user.id) };
  });
  app.post('/api/outcomes/:id', async (req) => {
    const user = await requireUser(ctx, req);
    const { status } = z
      .object({ status: z.enum(['succeeded', 'failed', 'not_run']) })
      .parse(req.body);
    return { outcome: await ctx.flow.record(SessionParams.parse(req.params).id, user.id, status) };
  });

  // Guidance from an app that isn't the lane's machine (the phone): the server passes it on.
  app.post('/api/sessions/:id/steer', async (req) => {
    const user = await requireUser(ctx, req);
    const body = z
      .object({ laneUserId: z.string(), text: z.string().trim().min(1).max(10_000) })
      .parse(req.body);
    const id = randomUUID();
    await ctx.flow.steer(
      SessionParams.parse(req.params).id,
      user.id,
      body.laneUserId,
      id,
      body.text,
    );
    return { id };
  });

  app.post('/api/sessions/:id/approvals', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = SessionParams.parse(req.params);
    const body = z
      .object({ laneUserId: z.string(), requestId: z.string().max(200), approved: z.boolean() })
      .parse(req.body);
    return {
      approval: await sessions.answer(id, user.id, body.laneUserId, body.requestId, body.approved),
    };
  });

  // ---------- subagents and the pull request ----------

  app.get('/api/sessions/:id/subagents', async (req) => {
    const user = await requireUser(ctx, req);
    return { subagents: await ctx.subagents.list(SessionParams.parse(req.params).id, user.id) };
  });
  app.post('/api/sessions/:id/subagents', async (req) => {
    const user = await requireUser(ctx, req);
    const input = StartSubagentSchema.parse(req.body);
    return ctx.subagents.start(SessionParams.parse(req.params).id, user.id, input);
  });
  app.patch('/api/subagents/:id', async (req) => {
    const user = await requireUser(ctx, req);
    const patch = UpdateSubagentSchema.parse(req.body);
    return {
      subagent: await ctx.subagents.update(SessionParams.parse(req.params).id, user.id, patch),
    };
  });
  app.post('/api/subagents/:id/integrate', async (req) => {
    const user = await requireUser(ctx, req);
    return { subagent: await ctx.subagents.integrate(SessionParams.parse(req.params).id, user.id) };
  });
  app.post('/api/sessions/:id/pr', DIFF_BODY, async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = SessionParams.parse(req.params);
    const body = SessionPrSchema.extend({
      diff: z.string().max(400_000).nullable().default(null),
    }).parse(req.body);
    const { diff, ...pr } = body;
    await ctx.subagents.setPr(id, user.id, pr, diff);
    return { session: await sessions.view(id) };
  });
}
