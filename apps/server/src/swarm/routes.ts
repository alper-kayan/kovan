import {
  AgentSpendSchema,
  CreateAiAgentSchema,
  CreateLearningSchema,
  HireTeammateSchema,
  MachineChoiceSchema,
  MentionAnswerSchema,
  MentionSchema,
  SwarmDeliveredSchema,
  SwarmMessageSchema,
  SwarmReportSchema,
  SwarmSettingsSchema,
  UpdateAiAgentSchema,
  UpdateLearningSchema,
} from '@kovan/shared';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireUser } from '../auth/guard.js';
import type { AppContext } from '../context.js';

const Id = z.object({ id: z.string() });
const WorkspaceId = z.object({ id: z.string().uuid() });

export function registerSwarmRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { swarm } = ctx;

  // ---------- AI teammates ----------

  app.get('/api/workspaces/:id/agents', async (req) => {
    const user = await requireUser(ctx, req);
    return { agents: await swarm.listAgents(WorkspaceId.parse(req.params).id, user.id) };
  });
  app.post('/api/workspaces/:id/agents', async (req) => {
    const user = await requireUser(ctx, req);
    const input = CreateAiAgentSchema.parse(req.body);
    const agent = await swarm.createAgent(WorkspaceId.parse(req.params).id, user.id, input);
    await ctx.audit.record({
      workspaceId: agent.workspaceId,
      actor: user,
      action: 'agent.created',
      target: agent.name,
      req,
    });
    return { agent };
  });
  app.patch('/api/agents/:id', async (req) => {
    const user = await requireUser(ctx, req);
    const patch = UpdateAiAgentSchema.parse(req.body);
    const agent = await swarm.updateAgent(Id.parse(req.params).id, user.id, patch);
    await ctx.audit.record({
      workspaceId: agent.workspaceId,
      actor: user,
      action: 'agent.updated',
      target: agent.name,
      meta: { fields: Object.keys(patch).join(', ') },
      req,
    });
    return { agent };
  });
  // A direct task's cost, from the machine running the AI teammate (0 asks whether it may work).
  app.post('/api/agents/:id/spend', async (req) => {
    const user = await requireUser(ctx, req);
    return swarm.agentSpent(Id.parse(req.params).id, user.id, AgentSpendSchema.parse(req.body));
  });
  app.delete('/api/agents/:id', async (req) => {
    const user = await requireUser(ctx, req);
    const gone = await swarm.archiveAgent(Id.parse(req.params).id, user.id);
    await ctx.audit.record({
      workspaceId: gone.workspaceId,
      actor: user,
      action: 'agent.deleted',
      target: gone.name,
      req,
    });
    return { ok: true };
  });
  app.post('/api/sessions/:id/agents', async (req) => {
    const user = await requireUser(ctx, req);
    const { agentId } = z.object({ agentId: z.string().uuid() }).parse(req.body);
    const { id } = Id.parse(req.params);
    await swarm.addToSession(id, user.id, agentId);
    return { session: await ctx.sessions.view(id) };
  });
  // An AI teammate called into a conversation with @: it joins if needed and gets the request.
  app.post('/api/sessions/:id/mention', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = Id.parse(req.params);
    const mention = MentionSchema.parse(req.body);
    await swarm.callIn(id, user.id, mention);
    const requestId = randomUUID();
    await ctx.flow.steer(id, user.id, mention.agentId, requestId, mention.text, {
      context: mention.context,
      reply: mention.reply,
    });
    return { id: requestId };
  });
  // The machine running a called-in teammate reports back to the conversation it was called into.
  app.post('/api/sessions/:id/mention/answer', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = Id.parse(req.params);
    await swarm.answerCall(id, user.id, MentionAnswerSchema.parse(req.body), (c) =>
      ctx.collab.createComment(c.workspaceId, c.agentId, {
        sessionId: c.sessionId,
        parentId: c.parentId,
        anchor: c.anchor,
        kind: 'comment',
        body: c.body,
        proposal: null,
      }),
    );
    return { ok: true };
  });
  app.post('/api/sessions/:id/agents/:agentId/leave', async (req) => {
    const user = await requireUser(ctx, req);
    const { id, agentId } = z.object({ id: z.string(), agentId: z.string() }).parse(req.params);
    await swarm.removeFromSession(id, user.id, agentId);
    return { session: await ctx.sessions.view(id) };
  });

  // ---------- swarms ----------

  app.get('/api/sessions/:id/swarm', async (req) => {
    const user = await requireUser(ctx, req);
    return swarm.ofSession(Id.parse(req.params).id, user.id);
  });
  app.put('/api/sessions/:id/swarm', async (req) => {
    const user = await requireUser(ctx, req);
    const input = SwarmSettingsSchema.parse(req.body);
    return { swarm: await swarm.configure(Id.parse(req.params).id, user.id, input) };
  });
  app.post('/api/swarms/:id/launch', async (req, reply) => {
    const user = await requireUser(ctx, req);
    const { id } = Id.parse(req.params);
    const { machine } = z
      .object({ machine: MachineChoiceSchema.nullable().default(null) })
      .parse(req.body ?? {});
    return ctx.idempotency.run(req, reply, `user:${user.id}`, () =>
      swarm.launch(id, user.id, machine),
    );
  });
  app.post('/api/swarms/:id/status', async (req) => {
    const user = await requireUser(ctx, req);
    const { status, reason } = z
      .object({
        status: z.enum(['paused', 'stopped', 'done']),
        reason: z.string().max(300).nullable().default(null),
      })
      .parse(req.body);
    return { swarm: await swarm.setStatus(Id.parse(req.params).id, user.id, status, reason) };
  });
  app.get('/api/workspaces/:id/agent-spend', async (req) => {
    const user = await requireUser(ctx, req);
    return { stats: await swarm.spendStats(Id.parse(req.params).id, user.id) };
  });
  app.post('/api/swarms/:id/report', async (req) => {
    const user = await requireUser(ctx, req);
    const input = SwarmReportSchema.parse(req.body);
    return swarm.report(Id.parse(req.params).id, user.id, input);
  });
  app.post('/api/swarms/:id/control', async (req) => {
    const user = await requireUser(ctx, req);
    const input = z
      .object({
        action: z.enum(['stop', 'reassign']),
        agentId: z.string().uuid(),
        toId: z.string().uuid().optional(),
      })
      .parse(req.body);
    await swarm.control(Id.parse(req.params).id, user.id, input);
    return { ok: true };
  });
  app.get('/api/swarms/:id/messages', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = Id.parse(req.params);
    const { swarm: s } = await swarm.ofSessionOfSwarm(id, user.id);
    return { messages: s ? await swarm.messages(id) : [] };
  });
  app.post('/api/swarms/:id/messages', async (req) => {
    const user = await requireUser(ctx, req);
    const input = SwarmMessageSchema.parse(req.body);
    return { message: await swarm.post(Id.parse(req.params).id, user.id, input) };
  });

  // The lead adds a teammate the team lacks (the machine running the swarm asks for it).
  app.post('/api/swarms/:id/agents', async (req) => {
    const user = await requireUser(ctx, req);
    const input = HireTeammateSchema.parse(req.body);
    const { agent, swarm: s, leadName } = await swarm.hire(Id.parse(req.params).id, user.id, input);
    await ctx.audit.record({
      workspaceId: agent.workspaceId,
      actor: user,
      action: 'agent.created',
      target: agent.name,
      meta: { by: leadName, reason: input.reason },
      req,
    });
    return { agent, swarm: s };
  });

  app.post('/api/swarms/:id/messages/delivered', async (req) => {
    const user = await requireUser(ctx, req);
    await swarm.delivered(Id.parse(req.params).id, user.id, SwarmDeliveredSchema.parse(req.body));
    return { ok: true };
  });
  app.post('/api/swarms/:id/messages/read', async (req) => {
    const user = await requireUser(ctx, req);
    await swarm.delivered(
      Id.parse(req.params).id,
      user.id,
      SwarmDeliveredSchema.parse(req.body),
      'read',
    );
    return { ok: true };
  });

  // ---------- learning ----------

  app.get('/api/workspaces/:id/learnings', async (req) => {
    const user = await requireUser(ctx, req);
    return { learnings: await swarm.listLearnings(WorkspaceId.parse(req.params).id, user.id) };
  });
  app.post('/api/workspaces/:id/learnings', async (req) => {
    const user = await requireUser(ctx, req);
    const input = CreateLearningSchema.parse(req.body);
    return { learning: await swarm.learn(WorkspaceId.parse(req.params).id, user.id, input) };
  });
  app.patch('/api/learnings/:id', async (req) => {
    const user = await requireUser(ctx, req);
    const patch = UpdateLearningSchema.parse(req.body);
    return { learning: await swarm.updateLearning(Id.parse(req.params).id, user.id, patch) };
  });
}
