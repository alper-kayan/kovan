import {
  AddStepsSchema,
  CreateCommentSchema,
  CreateMemorySchema,
  FlagMemorySchema,
  UpdateCommentSchema,
  UpdateMemorySchema,
  UpdateStepSchema,
} from '@kovan/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/guard.js';
import type { AppContext } from '../context.js';

const Id = z.object({ id: z.string() });
const WorkspaceId = z.object({ id: z.string().uuid() });

export function registerCollabRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { collab } = ctx;

  // ---------- plan ----------

  app.get('/api/sessions/:id/plan', async (req) => {
    const user = await requireUser(ctx, req);
    return { plan: await collab.plan(Id.parse(req.params).id, user.id) };
  });

  app.post('/api/sessions/:id/plan/steps', async (req) => {
    const user = await requireUser(ctx, req);
    const input = AddStepsSchema.parse(req.body);
    return { plan: await collab.addSteps(Id.parse(req.params).id, user.id, input) };
  });

  app.post('/api/sessions/:id/plan/takeover', async (req) => {
    const user = await requireUser(ctx, req);
    const { stepIds } = z.object({ stepIds: z.array(z.string()).min(1).max(50) }).parse(req.body);
    return collab.takeOver(Id.parse(req.params).id, user.id, stepIds);
  });

  app.patch('/api/plan-steps/:id', async (req) => {
    const user = await requireUser(ctx, req);
    const patch = UpdateStepSchema.parse(req.body);
    return { plan: await collab.updateStep(Id.parse(req.params).id, user.id, patch) };
  });

  app.post('/api/plan-steps/:id/approval', async (req) => {
    const user = await requireUser(ctx, req);
    const { approve } = z.object({ approve: z.boolean() }).parse(req.body);
    return { plan: await collab.answerApproval(Id.parse(req.params).id, user.id, approve) };
  });

  app.delete('/api/plan-steps/:id', async (req) => {
    const user = await requireUser(ctx, req);
    return { plan: await collab.deleteStep(Id.parse(req.params).id, user.id) };
  });

  app.post('/api/plan-steps/:id/assign', async (req) => {
    const user = await requireUser(ctx, req);
    const { userId } = z.object({ userId: z.string().nullable() }).parse(req.body);
    return { plan: await collab.assign(Id.parse(req.params).id, user.id, userId) };
  });

  app.post('/api/plan-steps/:id/release', async (req) => {
    const user = await requireUser(ctx, req);
    return { plan: await collab.release(Id.parse(req.params).id, user.id) };
  });

  app.post('/api/plan-steps/:id/claim', async (req) => {
    const user = await requireUser(ctx, req);
    return { plan: await collab.claim(Id.parse(req.params).id, user.id) };
  });

  app.post('/api/step-offers/:id', async (req) => {
    const user = await requireUser(ctx, req);
    const { accept } = z.object({ accept: z.boolean() }).parse(req.body);
    return { plan: await collab.answerOffer(Id.parse(req.params).id, user.id, accept) };
  });

  // ---------- comments ----------

  app.get('/api/workspaces/:id/comments', async (req) => {
    const user = await requireUser(ctx, req);
    const { sessionId, path } = z
      .object({ sessionId: z.string().uuid().optional(), path: z.string().max(500).optional() })
      .parse(req.query);
    return {
      comments: await collab.listComments(WorkspaceId.parse(req.params).id, user.id, {
        sessionId,
        path,
      }),
    };
  });

  app.post('/api/workspaces/:id/comments', async (req) => {
    const user = await requireUser(ctx, req);
    const input = CreateCommentSchema.parse(req.body);
    return {
      comment: await collab.createComment(WorkspaceId.parse(req.params).id, user.id, input),
    };
  });

  app.patch('/api/comments/:id', async (req) => {
    const user = await requireUser(ctx, req);
    const patch = UpdateCommentSchema.parse(req.body);
    return { comment: await collab.updateComment(Id.parse(req.params).id, user.id, patch) };
  });

  // ---------- the Brain ----------

  app.get('/api/workspaces/:id/memories', async (req) => {
    const user = await requireUser(ctx, req);
    const { status } = z
      .object({ status: z.enum(['live', 'retired', 'all']).default('live') })
      .parse(req.query);
    return {
      memories: await collab.listMemories(WorkspaceId.parse(req.params).id, user.id, status),
    };
  });

  app.post('/api/workspaces/:id/memories', async (req) => {
    const user = await requireUser(ctx, req);
    const input = CreateMemorySchema.parse(req.body);
    return { memory: await collab.createMemory(WorkspaceId.parse(req.params).id, user.id, input) };
  });

  app.patch('/api/memories/:id', async (req) => {
    const user = await requireUser(ctx, req);
    const patch = UpdateMemorySchema.parse(req.body);
    return { memory: await collab.updateMemory(Id.parse(req.params).id, user.id, patch) };
  });

  app.post('/api/memories/:id/flag', async (req) => {
    const user = await requireUser(ctx, req);
    const { reason } = FlagMemorySchema.parse(req.body);
    return { memory: await collab.flagMemory(Id.parse(req.params).id, user.id, reason) };
  });
}
