import { NO_EVENTS, type EventSink } from '../events/service.js';
import {
  can,
  type AgentSpendReply,
  type AgentSpendSchema,
  type AgentSpendStats,
  type SwarmReportReply,
  type AiAgent,
  type CreateAiAgentSchema,
  type CreateLearningSchema,
  type Learning,
  type Mention,
  type MentionAnswer,
  type CommentAnchor,
  type ServerMessage,
  type Swarm,
  type SwarmMessage,
  type HireTeammateSchema,
  type SwarmDeliveredSchema,
  type SwarmMessageSchema,
  type SwarmReportSchema,
  type SwarmSettingsSchema,
  type UpdateAiAgentSchema,
  type UpdateLearningSchema,
} from '@kovan/shared';
import { NO_PUSH, type PushSink } from '../push/service.js';
import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { authorize, getRole } from '../authz.js';
import type { Encryptor } from '../crypto.js';
import type { Db } from '../db/client.js';
import {
  agentSpend,
  aiAgents,
  comments,
  learnings,
  machines,
  planSteps,
  sessions as sessionsTable,
  sessionParticipants,
  swarmAgents,
  swarmMessages,
  swarms,
  users,
  workspaceMembers,
  workspaces,
} from '../db/schema.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../errors.js';
import type { FlowBroadcast } from '../sessions/flow.js';
import { redactText } from '../sessions/redact.js';
import type { SessionService } from '../sessions/service.js';

export interface SwarmBroadcast extends FlowBroadcast {
  sendWorkspace(workspaceId: string, message: ServerMessage): void;
}

type SwarmRow = typeof swarms.$inferSelect;
type LearningRow = typeof learnings.$inferSelect;

const isUuid = (id: string) => /^[0-9a-f-]{36}$/i.test(id);
const LIVE = ['draft', 'running', 'paused'] as const;

/** Postgres refused a duplicate (the query builder may wrap the driver's error). */
function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return e.code === '23505' || e.cause?.code === '23505';
}

const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

/** How long a desktop app running a swarm may be away before the swarm pauses. */
const LAUNCHER_GRACE_MS = 90_000;

/** How many teammates one swarm's lead may add. */
const MAX_HIRES = 2;

/**
 * AI teammates, swarms and what they learn. AI teammates are workspace members of kind
 * "agent"; their work runs on the machine of whoever puts them to work, who pays. A swarm's
 * budget is kept here: every finished turn reports its cost, and the swarm pauses the moment
 * the budget is reached, whatever the machine running it thinks.
 */
export class SwarmService {
  push: PushSink = NO_PUSH;
  events: EventSink = NO_EVENTS;
  /** Picks a registered machine for work sent to one (agentd). */
  chooseMachine: (workspaceId: string, choice: string) => Promise<string> = () =>
    Promise.reject(new Error('No machines here'));
  /** The member a registered machine reports as; null when it was removed. */
  machineUser: (machineId: string) => Promise<string | null> = async () => null;
  /** Tells the session the plan changed (its steps moved to another owner). */
  planChanged: (sessionId: string) => Promise<unknown> = async () => undefined;

  constructor(
    private readonly db: Db,
    private readonly enc: Encryptor,
    private readonly out: SwarmBroadcast,
    private readonly sessions: SessionService,
  ) {}

  // ---------- AI teammates ----------

  private async agentRow(agentId: string) {
    if (!isUuid(agentId)) throw notFound('AI teammate not found');
    const [row] = await this.db
      .select({ a: aiAgents, name: users.name })
      .from(aiAgents)
      .innerJoin(users, eq(users.id, aiAgents.userId))
      .where(eq(aiAgents.userId, agentId));
    if (!row) throw notFound('AI teammate not found');
    return row;
  }

  private async toAgent(row: { a: typeof aiAgents.$inferSelect; name: string }): Promise<AiAgent> {
    return {
      id: row.a.userId,
      workspaceId: row.a.workspaceId,
      name: row.name,
      model: row.a.model,
      effort: row.a.effort,
      mode: row.a.mode,
      instructions: row.a.instructions,
      monthlyLimit: row.a.monthlyLimit,
      monthSpent: await this.agentMonthSpent(row.a.userId),
      createdBy: row.a.createdBy,
      createdByName: row.a.createdBy ? await this.sessions.nameOf(row.a.createdBy) : null,
      archived: row.a.archivedAt !== null,
      createdAt: row.a.createdAt.toISOString(),
    };
  }

  async listAgents(workspaceId: string, userId: string): Promise<AiAgent[]> {
    await authorize(this.db, workspaceId, userId, 'session.view');
    const rows = await this.db
      .select({ a: aiAgents, name: users.name })
      .from(aiAgents)
      .innerJoin(users, eq(users.id, aiAgents.userId))
      .where(and(eq(aiAgents.workspaceId, workspaceId), isNull(aiAgents.archivedAt)))
      .orderBy(asc(users.name));
    return Promise.all(rows.map((r) => this.toAgent(r)));
  }

  async createAgent(
    workspaceId: string,
    userId: string,
    input: z.infer<typeof CreateAiAgentSchema>,
  ): Promise<AiAgent> {
    const role = await authorize(this.db, workspaceId, userId, 'session.start');
    // What an AI teammate may spend is the owner's call, like the workspace's limit.
    if (input.monthlyLimit !== null && !can(role, 'workspace.manageSettings'))
      throw forbidden('Only an owner can set what an AI teammate may spend');
    const taken = await this.db
      .select({ id: users.id })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          sql`lower(${users.name}) = lower(${input.name})`,
        ),
      );
    if (taken.length) throw conflict(`Someone in this workspace is already called ${input.name}`);
    const agent = await this.db.transaction(async (tx) => {
      const [u] = await tx.insert(users).values({ name: input.name, kind: 'agent' }).returning();
      // An editor, so it can take plan steps and stream its lane like anyone else.
      await tx.insert(workspaceMembers).values({ workspaceId, userId: u!.id, role: 'editor' });
      const [a] = await tx
        .insert(aiAgents)
        .values({
          userId: u!.id,
          workspaceId,
          createdBy: userId,
          model: input.model,
          effort: input.effort,
          mode: input.mode,
          instructions: input.instructions,
          monthlyLimit: input.monthlyLimit,
        })
        .returning();
      return { a: a!, name: u!.name };
    });
    this.out.sendWorkspace(workspaceId, { type: 'members', workspaceId });
    return this.toAgent(agent);
  }

  /**
   * The lead of a running swarm adds a teammate the team lacks, through the agent factory:
   * a workspace member like any other (People, its own lane), created by the lead, with the
   * lead's model. Only the machine running the swarm asks, and a swarm adds at most two.
   */
  async hire(
    swarmId: string,
    userId: string,
    input: z.infer<typeof HireTeammateSchema>,
  ): Promise<{ agent: AiAgent; swarm: Swarm; leadName: string }> {
    const row = await this.swarmRow(swarmId);
    if (row.launchedBy !== userId)
      throw forbidden('Only the machine running the swarm adds teammates to it');
    if (row.status !== 'running') throw conflict(`This swarm is ${row.status}`);
    if (!row.leadAgentId) throw conflict('This swarm has no lead to add teammates');
    const hired = await this.db
      .select({ id: aiAgents.userId })
      .from(aiAgents)
      .where(eq(aiAgents.hiredBySwarm, swarmId));
    if (hired.length >= MAX_HIRES)
      throw conflict(
        `A swarm adds at most ${MAX_HIRES} teammates; give the task to someone on the team`,
      );
    const members = await this.db
      .select({ agentId: swarmAgents.agentId })
      .from(swarmAgents)
      .where(eq(swarmAgents.swarmId, swarmId));
    if (members.length >= 12) throw conflict('This swarm is full (12 agents)');
    const session = await this.sessions.row(row.sessionId);
    const lead = await this.agentRow(row.leadAgentId);
    // The factory: same checks as a person adding one (a free name in the workspace).
    const agent = await this.createAgent(session.workspaceId, row.leadAgentId, {
      name: input.name,
      model: lead.a.model,
      effort: lead.a.effort,
      mode: 'allow',
      instructions: input.instructions,
      // It spends within the workspace's limit; a limit of its own is the owner's to give.
      monthlyLimit: null,
    });
    await this.db
      .update(aiAgents)
      .set({ hiredBySwarm: swarmId })
      .where(eq(aiAgents.userId, agent.id));
    await this.db.insert(swarmAgents).values({ swarmId, agentId: agent.id, role: 'worker' });
    await this.addToSession(row.sessionId, userId, agent.id);
    await this.sessions.activity(
      session,
      row.leadAgentId,
      'agent_added',
      `${lead.name} added ${agent.name} (AI) to the team`,
      input.reason,
    );
    return { agent, swarm: await this.send(await this.swarmRow(swarmId)), leadName: lead.name };
  }

  async updateAgent(
    agentId: string,
    userId: string,
    patch: z.infer<typeof UpdateAiAgentSchema>,
  ): Promise<AiAgent> {
    const row = await this.agentRow(agentId);
    const role = await authorize(this.db, row.a.workspaceId, userId, 'session.start');
    if (patch.monthlyLimit !== undefined && !can(role, 'workspace.manageSettings'))
      throw forbidden('Only an owner can change what an AI teammate may spend');
    const { name, ...rest } = patch;
    if (name && name !== row.name)
      await this.db.update(users).set({ name }).where(eq(users.id, agentId));
    if (Object.keys(rest).length)
      await this.db.update(aiAgents).set(rest).where(eq(aiAgents.userId, agentId));
    this.out.sendWorkspace(row.a.workspaceId, { type: 'members', workspaceId: row.a.workspaceId });
    return this.toAgent(await this.agentRow(agentId));
  }

  /** Retires an AI teammate: its history stays, it no longer takes work. */
  async archiveAgent(
    agentId: string,
    userId: string,
  ): Promise<{ workspaceId: string; name: string }> {
    const row = await this.agentRow(agentId);
    const role = await authorize(this.db, row.a.workspaceId, userId, 'session.start');
    if (role !== 'owner' && row.a.createdBy !== userId)
      throw forbidden('Only whoever added this AI teammate (or an owner) can retire it');
    await this.db
      .update(aiAgents)
      .set({ archivedAt: new Date() })
      .where(eq(aiAgents.userId, agentId));
    await this.db
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, row.a.workspaceId),
          eq(workspaceMembers.userId, agentId),
        ),
      );
    this.out.sendWorkspace(row.a.workspaceId, { type: 'members', workspaceId: row.a.workspaceId });
    return { workspaceId: row.a.workspaceId, name: row.name };
  }

  /**
   * Puts an AI teammate in a session with its own lane, run by the caller's machine (on their
   * key). Anyone may steer or prompt it; only that machine streams its lane.
   */
  async addToSession(sessionId: string, userId: string, agentId: string): Promise<void> {
    const session = await this.sessions.row(sessionId);
    await authorize(this.db, session.workspaceId, userId, 'session.join');
    if (session.status !== 'active') throw conflict('This session has ended');
    const agent = await this.agentRow(agentId);
    if (agent.a.workspaceId !== session.workspaceId || agent.a.archivedAt)
      throw notFound('AI teammate not found');
    // A machine that works with Claude Code runs it there: its lane says so.
    const [host] = await this.db
      .select({ agents: machines.agents })
      .from(machines)
      .where(eq(machines.userId, userId))
      .limit(1);
    const harness = host?.agents.some((a) => a.works && a.name === 'claude')
      ? 'claude-code'
      : 'kovan';
    await this.db
      .insert(sessionParticipants)
      .values({
        sessionId,
        userId: agentId,
        mode: 'join',
        harness,
        model: agent.a.model,
        hostId: userId,
      })
      .onConflictDoUpdate({
        target: [sessionParticipants.sessionId, sessionParticipants.userId],
        set: { mode: 'join', harness, model: agent.a.model, hostId: userId, leftAt: null },
      });
    await this.sessions.activity(
      session,
      userId,
      'agent_added',
      `${await this.sessions.nameOf(userId)} added ${agent.name} (AI) to the session`,
      `runs on ${await this.sessions.nameOf(userId)}'s machine and key`,
    );
    await this.sessions.announce(sessionId);
  }

  /**
   * Someone calls an AI teammate into a conversation with @. It joins the session if it isn't
   * in it (run by the caller's machine, as adding it would), and its answer may only go to the
   * caller's own lane or a comment thread of this session's workspace.
   */
  async callIn(sessionId: string, userId: string, mention: Mention): Promise<void> {
    const session = await this.sessions.row(sessionId);
    await authorize(this.db, session.workspaceId, userId, 'agent.steer');
    if (session.status !== 'active') throw conflict('This session has ended');
    const agent = await this.agentRow(mention.agentId);
    if (agent.a.workspaceId !== session.workspaceId || agent.a.archivedAt)
      throw notFound('AI teammate not found');
    if (mention.reply.kind === 'lane' && mention.reply.laneUserId !== userId)
      throw forbidden('A teammate answers in your own conversation');
    if (mention.reply.kind === 'comment') {
      const [thread] = await this.db
        .select({ workspaceId: comments.workspaceId })
        .from(comments)
        .where(eq(comments.id, mention.reply.commentId));
      if (thread?.workspaceId !== session.workspaceId) throw notFound('Comment not found');
    }
    const [lane] = await this.db
      .select({ leftAt: sessionParticipants.leftAt })
      .from(sessionParticipants)
      .where(
        and(
          eq(sessionParticipants.sessionId, sessionId),
          eq(sessionParticipants.userId, mention.agentId),
        ),
      );
    if (!lane || lane.leftAt) await this.addToSession(sessionId, userId, mention.agentId);
  }

  /**
   * The machine running a called-in teammate reports on the call: to the caller's conversation
   * (live), or, once done, as the teammate's reply in the comment thread. Only that machine may.
   */
  async answerCall(
    sessionId: string,
    userId: string,
    a: MentionAnswer,
    comment: (input: {
      workspaceId: string;
      agentId: string;
      sessionId: string;
      parentId: string;
      anchor: CommentAnchor;
      body: string;
    }) => Promise<unknown>,
  ): Promise<void> {
    const session = await this.sessions.row(sessionId);
    const [lane] = await this.db
      .select({ hostId: sessionParticipants.hostId, leftAt: sessionParticipants.leftAt })
      .from(sessionParticipants)
      .where(
        and(
          eq(sessionParticipants.sessionId, sessionId),
          eq(sessionParticipants.userId, a.agentId),
        ),
      );
    if (!lane || lane.hostId !== userId)
      throw forbidden('Only the machine running this AI teammate answers for it');
    if (!(await getRole(this.db, session.workspaceId, a.askerId)))
      throw notFound('Who called it in is not in this workspace');
    const name = await this.sessions.nameOf(a.agentId);
    const done = a.status !== 'working';
    if (a.reply.kind === 'lane') {
      if (a.reply.laneUserId !== a.askerId)
        throw badRequest('It answers in the caller’s conversation');
      this.out.sendUser(a.askerId, {
        type: 'teammate.reply',
        sessionId,
        agentId: a.agentId,
        name,
        requestId: a.requestId,
        status: a.status,
        text: a.text && redactText(a.text),
        asked: a.asked && redactText(a.asked),
      });
    } else if (done) {
      const [root] = await this.db
        .select({ workspaceId: comments.workspaceId, anchor: comments.anchor })
        .from(comments)
        .where(eq(comments.id, a.reply.commentId));
      if (root?.workspaceId !== session.workspaceId) throw notFound('Comment not found');
      const body =
        a.status === 'answered' || a.status === 'changed'
          ? (a.text ?? 'Done.')
          : a.status === 'failed'
            ? `I couldn't finish this${a.text ? `: ${a.text}` : '.'}`
            : 'Stopped before answering.';
      await comment({
        workspaceId: session.workspaceId,
        agentId: a.agentId,
        sessionId,
        parentId: a.reply.commentId,
        anchor: root.anchor as CommentAnchor,
        body: body.slice(0, 10_000),
      });
    }
    if ((a.status === 'answered' || a.status === 'changed') && a.text)
      this.push.emit({
        kind: 'message',
        sessionId,
        toUserId: a.askerId,
        fromName: name,
        messageKind: 'answer',
        text: a.text,
      });
  }

  async removeFromSession(sessionId: string, userId: string, agentId: string): Promise<void> {
    const session = await this.sessions.row(sessionId);
    await authorize(this.db, session.workspaceId, userId, 'session.join');
    await this.db
      .update(sessionParticipants)
      .set({ leftAt: new Date() })
      .where(
        and(eq(sessionParticipants.sessionId, sessionId), eq(sessionParticipants.userId, agentId)),
      );
    await this.sessions.announce(sessionId);
  }

  // ---------- swarms ----------

  private async view(row: SwarmRow): Promise<Swarm> {
    const session = await this.sessions.row(row.sessionId);
    const agents = await this.db
      .select({ s: swarmAgents, name: users.name })
      .from(swarmAgents)
      .innerJoin(users, eq(users.id, swarmAgents.agentId))
      .where(eq(swarmAgents.swarmId, row.id))
      .orderBy(desc(sql`${swarmAgents.role} = 'lead'`), asc(users.name));
    return {
      id: row.id,
      sessionId: row.sessionId,
      workspaceId: session.workspaceId,
      goal: row.goal,
      leadAgentId: row.leadAgentId,
      status: row.status,
      budget: row.budget,
      taskBudget: row.taskBudget,
      review: row.review,
      spent: row.spent,
      maxParallel: row.maxParallel,
      mode: row.mode,
      launchedBy: row.launchedBy,
      launchedByName: row.launchedBy ? await this.sessions.nameOf(row.launchedBy) : null,
      fence: row.fence,
      pausedReason: row.pausedReason,
      agents: agents.map(({ s, name }) => ({
        agentId: s.agentId,
        name,
        role: s.role,
        status: s.status,
        task: s.task,
        spent: s.spent,
      })),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async send(row: SwarmRow): Promise<Swarm> {
    const swarm = await this.view(row);
    this.out.sendRoom(swarm.workspaceId, row.sessionId, {
      type: 'swarm',
      workspaceId: swarm.workspaceId,
      swarm,
    });
    return swarm;
  }

  /**
   * A request made for one run of a swarm (`x-kovan-fence: <swarm>:<fence>`): refused when the
   * swarm has been launched again since, so a stale run (a machine that came back) stops
   * instead of writing over the new one.
   */
  async checkFence(header: string): Promise<void> {
    const m = /^([0-9a-f-]{36}):(\d{1,9})$/i.exec(header.trim());
    if (!m) throw badRequest('Bad x-kovan-fence header');
    const [row] = await this.db
      .select({ fence: swarms.fence })
      .from(swarms)
      .where(eq(swarms.id, m[1]!));
    if (row && row.fence !== Number(m[2]))
      throw new HttpError(
        409,
        'stale_run',
        'This swarm was started again elsewhere; this run of it stopped.',
      );
  }

  private async swarmRow(swarmId: string): Promise<SwarmRow> {
    if (!isUuid(swarmId)) throw notFound('Swarm not found');
    const [row] = await this.db.select().from(swarms).where(eq(swarms.id, swarmId));
    if (!row) throw notFound('Swarm not found');
    return row;
  }

  /** The session's current swarm (the live one, else the last), with its recent chat. */
  async ofSession(
    sessionId: string,
    userId: string,
  ): Promise<{ swarm: Swarm | null; messages: SwarmMessage[] }> {
    await this.sessions.visible(sessionId, userId);
    const [row] = await this.db
      .select()
      .from(swarms)
      .where(eq(swarms.sessionId, sessionId))
      .orderBy(
        desc(sql`${swarms.status} in ('draft', 'running', 'paused')`),
        desc(swarms.createdAt),
      )
      .limit(1);
    if (!row) return { swarm: null, messages: [] };
    return { swarm: await this.view(row), messages: await this.messages(row.id) };
  }

  /** Sets up (or changes) the session's swarm before it runs, or while paused. */
  async configure(
    sessionId: string,
    userId: string,
    input: z.infer<typeof SwarmSettingsSchema>,
  ): Promise<Swarm> {
    const session = await this.sessions.row(sessionId);
    await authorize(this.db, session.workspaceId, userId, 'session.start');
    if (session.status !== 'active') throw conflict('This session has ended');
    const ids = [...new Set(input.agentIds)];
    if (input.leadAgentId && !ids.includes(input.leadAgentId)) ids.unshift(input.leadAgentId);
    const found = await this.db
      .select({ id: aiAgents.userId })
      .from(aiAgents)
      .where(
        and(
          inArray(aiAgents.userId, ids),
          eq(aiAgents.workspaceId, session.workspaceId),
          isNull(aiAgents.archivedAt),
        ),
      );
    if (found.length !== ids.length) throw badRequest('Pick AI teammates of this workspace');
    // The lead: the one chosen, else the first.
    const lead = input.leadAgentId ?? ids[0]!;

    const [existing] = await this.db
      .select()
      .from(swarms)
      .where(and(eq(swarms.sessionId, sessionId), inArray(swarms.status, [...LIVE])));
    if (existing?.status === 'running')
      throw conflict('Pause the swarm before changing its settings');
    const values = {
      goal: input.goal,
      leadAgentId: lead,
      budget: input.budget,
      taskBudget: input.taskBudget,
      review: input.review,
      maxParallel: input.maxParallel,
      mode: input.mode,
      updatedAt: new Date(),
    };
    let row: SwarmRow;
    if (existing) {
      [row] = (await this.db
        .update(swarms)
        .set(values)
        .where(eq(swarms.id, existing.id))
        .returning()) as [SwarmRow];
      await this.db.delete(swarmAgents).where(eq(swarmAgents.swarmId, row.id));
    } else {
      try {
        [row] = (await this.db
          .insert(swarms)
          .values({ ...values, sessionId, createdBy: userId })
          .returning()) as [SwarmRow];
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict('This session already has a swarm');
        throw error;
      }
    }
    await this.db.insert(swarmAgents).values(
      ids.map((agentId) => ({
        swarmId: row.id,
        agentId,
        role: agentId === lead ? ('lead' as const) : ('worker' as const),
      })),
    );
    await this.sessions.journal(session, {
      kind: 'swarm.configured',
      actorId: userId,
      swarmId: row.id,
      summary: `Swarm set up: ${ids.length} agent${ids.length === 1 ? '' : 's'}, budget ${input.budget === null ? 'unlimited' : usd(input.budget)}`,
      data: {
        goal: input.goal,
        leadAgentId: lead,
        agentIds: ids,
        budget: input.budget,
        taskBudget: input.taskBudget,
        review: input.review,
        maxParallel: input.maxParallel,
        mode: input.mode,
      },
    });
    await this.sessions.announce(sessionId);
    return this.send(row);
  }

  /**
   * Starts (or resumes) the swarm on the caller's machine: they run its agents and pay. Its
   * agents join the session with lanes hosted there.
   */
  async launch(
    swarmId: string,
    userId: string,
    machine: string | null = null,
  ): Promise<{ swarm: Swarm; resumed: boolean }> {
    const row = await this.swarmRow(swarmId);
    const session = await this.sessions.row(row.sessionId);
    await authorize(this.db, session.workspaceId, userId, 'session.start');
    // Sent to a registered machine (or its session runs on one): the swarm runs there, as
    // that machine's member; its agents' lanes are hosted by it.
    const machineId =
      machine === null ||
      (session.machineId && (machine === 'auto' || machine === session.machineId))
        ? session.machineId
        : await this.chooseMachine(session.workspaceId, machine);
    if (machineId && session.machineId && machineId !== session.machineId)
      throw conflict('This session already runs on another machine.');
    const runner = machineId ? await this.machineUser(machineId) : userId;
    if (!runner) throw conflict('That machine was removed.');
    if (row.status !== 'draft' && row.status !== 'paused')
      throw conflict(`This swarm is ${row.status}`);
    if (!machineId && row.status === 'paused' && row.launchedBy && row.launchedBy !== userId)
      throw forbidden(`Only ${await this.sessions.nameOf(row.launchedBy)} can resume it`);
    if (row.budget !== null && row.spent >= row.budget)
      throw conflict(
        `The budget is spent (${usd(row.spent)} of ${usd(row.budget)}): raise it first`,
      );
    const monthly = await this.monthOver(session.workspaceId);
    if (monthly) throw conflict(`${monthly}: an owner can raise it in Settings → Workspaces`);
    const [updated] = await this.db
      .update(swarms)
      .set({
        status: 'running',
        launchedBy: runner,
        pausedReason: null,
        updatedAt: new Date(),
        // A new run: whatever ran it before can no longer write for it.
        fence: sql`${swarms.fence} + 1`,
      })
      .where(and(eq(swarms.id, swarmId), inArray(swarms.status, ['draft', 'paused'])))
      .returning();
    if (!updated) throw conflict('The swarm changed meanwhile; look again');
    if (machineId && !session.machineId)
      await this.db
        .update(sessionsTable)
        .set({ machineId })
        .where(eq(sessionsTable.id, session.id));
    const members = await this.db
      .select({ agentId: swarmAgents.agentId })
      .from(swarmAgents)
      .where(eq(swarmAgents.swarmId, swarmId));
    for (const m of members) await this.addToSession(row.sessionId, runner, m.agentId);
    this.events.session(row.sessionId, 'swarm.status_changed', {
      swarmId,
      status: 'running',
      previous: row.status,
      reason: null,
      by: await this.sessions.nameOf(userId),
    });
    await this.sessions.activity(
      session,
      userId,
      'swarm_launched',
      `${await this.sessions.nameOf(userId)} ${row.status === 'paused' ? 'resumed' : 'launched'} a swarm of ${members.length}`,
      `${row.goal.slice(0, 100)} · budget ${row.budget === null ? 'unlimited' : usd(row.budget)}`,
    );
    await this.sessions.announce(row.sessionId);
    return { swarm: await this.send(updated), resumed: row.status === 'paused' };
  }

  async setStatus(
    swarmId: string,
    userId: string,
    status: 'paused' | 'stopped' | 'done',
    reason: string | null = null,
  ): Promise<Swarm> {
    const row = await this.swarmRow(swarmId);
    const session = await this.sessions.row(row.sessionId);
    await authorize(this.db, session.workspaceId, userId, 'agent.steer');
    // Done is the running machine's to say; anyone may pause or stop.
    if (status === 'done' && row.launchedBy !== userId) throw forbidden();
    if (!LIVE.includes(row.status as (typeof LIVE)[number]))
      throw conflict(`This swarm is ${row.status} already`);
    const [updated] = await this.db
      .update(swarms)
      .set({ status, pausedReason: status === 'paused' ? reason : null, updatedAt: new Date() })
      .where(eq(swarms.id, swarmId))
      .returning();
    if (status !== 'paused')
      await this.db
        .update(swarmAgents)
        .set({ status: status === 'done' ? 'done' : 'stopped' })
        .where(and(eq(swarmAgents.swarmId, swarmId), eq(swarmAgents.status, 'working')));
    this.push.emit({
      kind: 'swarm',
      sessionId: row.sessionId,
      status,
      reason,
      launchedBy: row.launchedBy,
      actorId: userId,
      spent: updated!.spent,
    });
    this.events.session(row.sessionId, 'swarm.status_changed', {
      swarmId,
      status,
      previous: row.status,
      reason,
      spent: updated!.spent,
      by: await this.sessions.nameOf(userId),
    });
    const name = await this.sessions.nameOf(userId);
    await this.sessions.activity(
      session,
      userId,
      status === 'done' ? 'swarm_done' : status === 'paused' ? 'swarm_paused' : 'swarm_stopped',
      status === 'done'
        ? 'The swarm finished its goal'
        : status === 'paused'
          ? `${name} paused the swarm`
          : `${name} stopped the swarm`,
      status === 'done' ? `spent ${usd(updated!.spent)}` : reason,
    );
    await this.sessions.announce(row.sessionId);
    return this.send(updated!);
  }

  /** The start of this calendar month (UTC), for monthly limits. */
  private monthStart(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }

  private async monthSpent(workspaceId: string): Promise<number> {
    const [sum] = await this.db
      .select({ total: sql<number>`coalesce(sum(${agentSpend.amount}), 0)` })
      .from(agentSpend)
      .where(
        and(eq(agentSpend.workspaceId, workspaceId), gte(agentSpend.createdAt, this.monthStart())),
      );
    return Number(sum?.total ?? 0);
  }

  private async agentMonthSpent(agentId: string): Promise<number> {
    const [sum] = await this.db
      .select({ total: sql<number>`coalesce(sum(${agentSpend.amount}), 0)` })
      .from(agentSpend)
      .where(and(eq(agentSpend.agentId, agentId), gte(agentSpend.createdAt, this.monthStart())));
    return Number(sum?.total ?? 0);
  }

  /** Why this AI teammate may not spend more this month (its own limit), or null. */
  private async agentOver(agentId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ limit: aiAgents.monthlyLimit, name: users.name })
      .from(aiAgents)
      .innerJoin(users, eq(users.id, aiAgents.userId))
      .where(eq(aiAgents.userId, agentId));
    if (row?.limit == null) return null;
    const spent = await this.agentMonthSpent(agentId);
    return spent >= row.limit
      ? `${row.name}'s monthly limit is reached (${usd(spent)} of ${usd(row.limit)})`
      : null;
  }

  /**
   * What an AI teammate's direct task (not a swarm's) cost, reported by the machine running it
   * as it goes; 0 only asks. It counts against the teammate's limit and the workspace's, and the
   * answer says when either is reached: the machine then stops the task.
   */
  async agentSpent(
    agentId: string,
    userId: string,
    input: z.infer<typeof AgentSpendSchema>,
  ): Promise<AgentSpendReply> {
    const row = await this.agentRow(agentId);
    await authorize(this.db, row.a.workspaceId, userId, 'session.start');
    const session = await this.sessions.row(input.sessionId);
    if (session.workspaceId !== row.a.workspaceId)
      throw badRequest('That session is not in this AI teammate’s workspace');
    if (input.amount > 0) {
      await this.db.insert(agentSpend).values({
        workspaceId: row.a.workspaceId,
        agentId,
        amount: input.amount,
      });
      await this.sessions.journal(session, {
        kind: 'cost',
        actorId: agentId,
        swarmId: null,
        stepId: null,
        summary: `${usd(input.amount)} spent`,
        data: { amount: input.amount },
      });
    }
    return {
      monthSpent: await this.agentMonthSpent(agentId),
      over: (await this.agentOver(agentId)) ?? (await this.monthOver(row.a.workspaceId)),
    };
  }

  /** Why the workspace's agents may not spend more this month, or null when they may. */
  private async monthOver(workspaceId: string): Promise<string | null> {
    const [ws] = await this.db
      .select({ limit: workspaces.agentMonthlyLimit })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    if (ws?.limit == null) return null;
    const spent = await this.monthSpent(workspaceId);
    return spent >= ws.limit
      ? `The workspace's monthly agent limit is reached (${usd(spent)} of ${usd(ws.limit)})`
      : null;
  }

  /** The machine running a swarm stopped reporting: it is paused, with why. */
  async machineLost(swarmId: string, sessionId: string, machine: string): Promise<void> {
    await this.pauseFor(
      swarmId,
      sessionId,
      `${machine} stopped reporting, so its work may have stopped: check it, then resume`,
    );
  }

  /** Swarms run by a desktop app, and since when that app has been away. */
  private readonly launcherAway = new Map<string, number>();

  /**
   * A swarm a desktop app runs (not a registered machine) whose app is gone for longer than
   * `graceMs` (closed, asleep, offline) is paused: nobody works on it there any more.
   */
  async sweepLaunchers(graceMs = LAUNCHER_GRACE_MS, now = Date.now()): Promise<void> {
    const rows = await this.db
      .select({ id: swarms.id, sessionId: swarms.sessionId, launchedBy: swarms.launchedBy })
      .from(swarms)
      .innerJoin(sessionsTable, eq(sessionsTable.id, swarms.sessionId))
      .where(and(eq(swarms.status, 'running'), isNull(sessionsTable.machineId)));
    const running = new Set(rows.map((r) => r.id));
    for (const id of this.launcherAway.keys()) if (!running.has(id)) this.launcherAway.delete(id);
    for (const r of rows) {
      if (!r.launchedBy || this.out.isOnline(r.launchedBy)) {
        this.launcherAway.delete(r.id);
        continue;
      }
      const since = this.launcherAway.get(r.id) ?? now;
      this.launcherAway.set(r.id, since);
      if (now - since < graceMs) continue;
      this.launcherAway.delete(r.id);
      await this.pauseFor(
        r.id,
        r.sessionId,
        `The app running it (${await this.sessions.nameOf(r.launchedBy)}'s) went away, so its work stopped: resume it from there`,
      );
    }
  }

  /** Pauses a running swarm with a reason, once; says so in the session. */
  private async pauseFor(
    swarmId: string,
    sessionId: string,
    reason: string,
  ): Promise<SwarmRow | null> {
    const [paused] = await this.db
      .update(swarms)
      .set({ status: 'paused', pausedReason: reason })
      .where(and(eq(swarms.id, swarmId), eq(swarms.status, 'running')))
      .returning();
    if (!paused) return null;
    this.push.emit({
      kind: 'swarm',
      sessionId,
      status: 'paused',
      reason,
      launchedBy: paused.launchedBy,
      actorId: null,
      spent: paused.spent,
    });
    this.events.session(sessionId, 'swarm.status_changed', {
      swarmId,
      status: 'paused',
      previous: 'running',
      reason,
      spent: paused.spent,
      by: null,
    });
    await this.sessions.activity(
      await this.sessions.row(sessionId),
      null,
      'swarm_paused',
      'The swarm paused itself',
      reason,
    );
    await this.sessions.announce(sessionId);
    return paused;
  }

  /**
   * The running machine reports an agent's state and each finished turn's cost. Spend goes to
   * the ledger and is added atomically to the agent, the swarm and the task; the Brain enforces
   * every limit here: the swarm's budget and the workspace's monthly limit pause the swarm, a
   * task past its own budget is reported over, and the machine stops it.
   */
  async report(
    swarmId: string,
    userId: string,
    input: z.infer<typeof SwarmReportSchema>,
  ): Promise<SwarmReportReply> {
    const row = await this.swarmRow(swarmId);
    if (row.launchedBy !== userId) throw forbidden('Only the machine running the swarm reports');
    const session = await this.sessions.row(row.sessionId);
    const cost = input.cost ?? 0;
    const patch: Partial<typeof swarmAgents.$inferInsert> = {};
    if (input.status) patch.status = input.status;
    if (input.task !== undefined) patch.task = input.task;
    if (cost > 0) patch.spent = sql`${swarmAgents.spent} + ${cost}` as unknown as number;
    if (Object.keys(patch).length)
      await this.db
        .update(swarmAgents)
        .set(patch)
        .where(and(eq(swarmAgents.swarmId, swarmId), eq(swarmAgents.agentId, input.agentId)));

    let step: SwarmReportReply['step'];
    if (input.stepId) {
      const [found] = await this.db
        .update(planSteps)
        .set({ spent: sql`${planSteps.spent} + ${cost}` })
        .where(and(eq(planSteps.id, input.stepId), eq(planSteps.sessionId, row.sessionId)))
        .returning({ spent: planSteps.spent });
      if (!found) throw badRequest('That step is not in this swarm’s session');
      step = { spent: found.spent, over: row.taskBudget !== null && found.spent >= row.taskBudget };
    }
    if (cost > 0)
      await this.sessions.journal(session, {
        kind: 'cost',
        actorId: input.agentId,
        swarmId,
        stepId: input.stepId ?? null,
        summary: `${usd(cost)} spent`,
        data: { amount: cost, ...(step ? { stepSpent: step.spent } : {}) },
      });
    if (cost > 0)
      await this.db.insert(agentSpend).values({
        workspaceId: session.workspaceId,
        swarmId,
        stepId: input.stepId ?? null,
        agentId: input.agentId,
        amount: cost,
      });

    let [updated] = await this.db
      .update(swarms)
      .set({ spent: sql`${swarms.spent} + ${cost}`, updatedAt: new Date() })
      .where(eq(swarms.id, swarmId))
      .returning();
    if (updated!.status === 'running') {
      const reason =
        updated!.budget !== null && updated!.spent >= updated!.budget
          ? `Budget reached: ${usd(updated!.spent)} of ${usd(updated!.budget)}`
          : cost > 0
            ? ((await this.monthOver(session.workspaceId)) ?? (await this.agentOver(input.agentId)))
            : null;
      if (reason)
        updated =
          (await this.pauseFor(swarmId, row.sessionId, reason)) ?? (await this.swarmRow(swarmId));
    }
    if (cost > 0) await this.sessions.announce(row.sessionId);
    return { swarm: await this.send(updated!), ...(step ? { step } : {}) };
  }

  /**
   * What agents spent in a workspace this month, against its limit, and what a finished task
   * cost here: the only ground for an estimate.
   */
  async spendStats(workspaceId: string, userId: string): Promise<AgentSpendStats> {
    await authorize(this.db, workspaceId, userId, 'session.view');
    const [ws] = await this.db
      .select({ limit: workspaces.agentMonthlyLimit })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    const costs = (
      await this.db
        .select({ spent: planSteps.spent })
        .from(planSteps)
        .innerJoin(sessionsTable, eq(sessionsTable.id, planSteps.sessionId))
        .where(
          and(
            eq(sessionsTable.workspaceId, workspaceId),
            inArray(planSteps.runState, ['done', 'failed']),
            sql`${planSteps.spent} > 0`,
          ),
        )
        .orderBy(desc(planSteps.updatedAt))
        .limit(200)
    )
      .map((r) => r.spent)
      .sort((x, y) => x - y);
    return {
      monthSpent: await this.monthSpent(workspaceId),
      monthLimit: ws?.limit ?? null,
      tasks: costs.length,
      perTask: costs.length
        ? {
            average: costs.reduce((sum, c) => sum + c, 0) / costs.length,
            p90: costs[Math.min(costs.length - 1, Math.floor(costs.length * 0.9))]!,
          }
        : null,
    };
  }

  /**
   * Stops one agent, or moves its work to another agent of the swarm. Anyone who may steer
   * asks here; the machine running the swarm does it.
   */
  async control(
    swarmId: string,
    userId: string,
    input: { action: 'stop' | 'reassign'; agentId: string; toId?: string | undefined },
  ): Promise<void> {
    const row = await this.swarmRow(swarmId);
    const session = await this.sessions.row(row.sessionId);
    await authorize(this.db, session.workspaceId, userId, 'agent.steer');
    if (row.status !== 'running') throw conflict(`This swarm is ${row.status}`);
    const members = await this.db
      .select()
      .from(swarmAgents)
      .where(eq(swarmAgents.swarmId, swarmId));
    const from = members.find((m) => m.agentId === input.agentId);
    if (!from) throw badRequest('That agent is not in this swarm');
    if (
      input.action === 'reassign' &&
      (!input.toId || !members.some((m) => m.agentId === input.toId))
    )
      throw badRequest('Move it to another agent of this swarm');
    if (!row.launchedBy || !this.out.isOnline(row.launchedBy))
      throw conflict('The machine running the swarm is offline');
    this.out.sendUser(row.launchedBy, {
      type: 'swarm.control',
      swarmId,
      sessionId: row.sessionId,
      action: input.action,
      agentId: input.agentId,
      toId: input.toId ?? null,
      fromUserId: userId,
    });
    // The plan says who owns the work now, so a resume gives it to the new agent too.
    if (input.action === 'reassign') {
      const moved = await this.db
        .update(planSteps)
        .set({ ownerId: input.toId!, updatedAt: new Date() })
        .where(
          and(
            eq(planSteps.sessionId, row.sessionId),
            eq(planSteps.ownerId, input.agentId),
            sql`${planSteps.status} <> 'done'`,
            or(
              isNull(planSteps.runState),
              inArray(planSteps.runState, ['waiting', 'waiting_for_approval', 'running']),
            ),
          ),
        )
        .returning({ id: planSteps.id });
      if (moved.length) await this.planChanged(row.sessionId);
    }
    const name = await this.sessions.nameOf(userId);
    await this.sessions.activity(
      session,
      userId,
      input.action === 'reassign' ? 'reassigned' : 'swarm_stopped',
      input.action === 'reassign'
        ? `${name} moved ${await this.sessions.nameOf(input.agentId)}'s work to ${await this.sessions.nameOf(input.toId!)}`
        : `${name} stopped ${await this.sessions.nameOf(input.agentId)}`,
      from.task,
    );
  }

  // ---------- the swarm's chat ----------

  private async toMessage(m: typeof swarmMessages.$inferSelect): Promise<SwarmMessage> {
    return {
      id: m.id,
      swarmId: m.swarmId,
      fromId: m.fromId,
      fromName: await this.sessions.nameOf(m.fromId),
      toId: m.toId,
      toName: m.toId ? await this.sessions.nameOf(m.toId) : null,
      kind: m.kind,
      replyTo: m.replyTo,
      text: this.enc.decrypt(m.textEnc),
      deliveredTo: m.deliveredTo,
      readBy: m.readBy,
      createdAt: m.createdAt.toISOString(),
    };
  }

  /**
   * The machine running the swarm says one of its agents has these messages in its model's
   * context now (`delivered`), or that its model answered after seeing them (`read`, which
   * means delivered too).
   */
  async delivered(
    swarmId: string,
    userId: string,
    input: z.infer<typeof SwarmDeliveredSchema>,
    how: 'delivered' | 'read' = 'delivered',
  ): Promise<void> {
    const row = await this.swarmRow(swarmId);
    if (row.launchedBy !== userId) throw forbidden('Only the machine running the swarm says this');
    const session = await this.sessions.row(row.sessionId);
    const agent = JSON.stringify([input.agentId]);
    const add = (column: typeof swarmMessages.deliveredTo | typeof swarmMessages.readBy) =>
      sql`case when ${column} @> ${agent}::jsonb then ${column} else ${column} || ${agent}::jsonb end`;
    const updated = await this.db
      .update(swarmMessages)
      .set(
        how === 'read'
          ? { deliveredTo: add(swarmMessages.deliveredTo), readBy: add(swarmMessages.readBy) }
          : { deliveredTo: add(swarmMessages.deliveredTo) },
      )
      .where(
        and(
          eq(swarmMessages.swarmId, swarmId),
          inArray(swarmMessages.id, input.ids),
          sql`not ${how === 'read' ? swarmMessages.readBy : swarmMessages.deliveredTo} @> ${agent}::jsonb`,
        ),
      )
      .returning();
    for (const m of updated)
      this.out.sendRoom(session.workspaceId, row.sessionId, {
        type: 'swarm.message',
        workspaceId: session.workspaceId,
        sessionId: row.sessionId,
        message: await this.toMessage(m),
      });
  }

  /** Whether this user is a person (not an AI teammate) of the session: in it, or its starter. */
  private async personOfSession(sessionId: string, userId: string): Promise<boolean> {
    const [user] = await this.db
      .select({ kind: users.kind })
      .from(users)
      .where(eq(users.id, userId));
    if (user?.kind !== 'human') return false;
    const [inIt] = await this.db
      .select({ userId: sessionParticipants.userId })
      .from(sessionParticipants)
      .where(
        and(eq(sessionParticipants.sessionId, sessionId), eq(sessionParticipants.userId, userId)),
      );
    if (inIt) return true;
    const session = await this.sessions.row(sessionId);
    return session.createdBy === userId;
  }

  /** The swarm, if the person may see its session. */
  async ofSessionOfSwarm(swarmId: string, userId: string): Promise<{ swarm: Swarm | null }> {
    const row = await this.swarmRow(swarmId);
    await this.sessions.visible(row.sessionId, userId);
    return { swarm: await this.view(row) };
  }

  async messages(swarmId: string): Promise<SwarmMessage[]> {
    const rows = await this.db
      .select()
      .from(swarmMessages)
      .where(eq(swarmMessages.swarmId, swarmId))
      .orderBy(desc(swarmMessages.createdAt))
      .limit(200);
    return Promise.all(rows.reverse().map((m) => this.toMessage(m)));
  }

  /**
   * A message in the swarm's chat: from an agent (sent by the machine running the swarm) or
   * from a person, to one agent or to everyone.
   */
  async post(
    swarmId: string,
    userId: string,
    input: z.infer<typeof SwarmMessageSchema>,
  ): Promise<SwarmMessage> {
    const row = await this.swarmRow(swarmId);
    const session = await this.sessions.row(row.sessionId);
    await authorize(this.db, session.workspaceId, userId, 'agent.steer');
    const members = await this.db
      .select({ agentId: swarmAgents.agentId })
      .from(swarmAgents)
      .where(eq(swarmAgents.swarmId, swarmId));
    const inSwarm = (id: string) => members.some((m) => m.agentId === id);
    if (input.fromId && (row.launchedBy !== userId || !inSwarm(input.fromId)))
      throw forbidden('Only the machine running the swarm speaks for its agents');
    // People write to the swarm's agents; an agent also writes to a person of the session.
    if (input.toId && !inSwarm(input.toId)) {
      const person = input.fromId ? await this.personOfSession(row.sessionId, input.toId) : false;
      if (!person) throw badRequest('Send it to an agent of this swarm');
    }
    if (input.replyTo) {
      const [to] = await this.db
        .select({ id: swarmMessages.id })
        .from(swarmMessages)
        .where(and(eq(swarmMessages.id, input.replyTo), eq(swarmMessages.swarmId, swarmId)));
      if (!to) throw badRequest('It answers a message this swarm does not have');
    }
    // Sent again (a lost answer, a retry): the first one stands.
    if (input.key) {
      const [same] = await this.db
        .select()
        .from(swarmMessages)
        .where(and(eq(swarmMessages.swarmId, swarmId), eq(swarmMessages.key, input.key)));
      if (same) return this.toMessage(same);
    }
    const [m] = await this.db
      .insert(swarmMessages)
      .values({
        swarmId,
        fromId: input.fromId ?? userId,
        toId: input.toId,
        kind: input.kind,
        replyTo: input.replyTo,
        key: input.key ?? null,
        textEnc: this.enc.encrypt(redactText(input.text)),
      })
      .onConflictDoNothing()
      .returning();
    if (!m) {
      const [same] = await this.db
        .select()
        .from(swarmMessages)
        .where(and(eq(swarmMessages.swarmId, swarmId), eq(swarmMessages.key, input.key!)));
      return this.toMessage(same!);
    }
    const message = await this.toMessage(m);
    this.out.sendRoom(session.workspaceId, row.sessionId, {
      type: 'swarm.message',
      workspaceId: session.workspaceId,
      sessionId: row.sessionId,
      message,
    });
    // An agent writing to a person: their phone hears it when they're away from their desk.
    if (input.fromId && input.toId && !inSwarm(input.toId))
      this.push.emit({
        kind: 'message',
        sessionId: row.sessionId,
        toUserId: input.toId,
        fromName: message.fromName,
        messageKind: message.kind,
        text: message.text,
      });
    this.events.session(row.sessionId, 'swarm.message', {
      swarmId,
      messageId: message.id,
      kind: message.kind,
      from: { id: message.fromId, name: message.fromName, agent: Boolean(input.fromId) },
      to: message.toId ? { id: message.toId, name: message.toName } : null,
      replyTo: message.replyTo,
      text: message.text,
    });
    return message;
  }

  // ---------- learning ----------

  private toLearning(row: LearningRow): Learning {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      kind: row.kind,
      ownerId: row.ownerId,
      text: this.enc.decrypt(row.textEnc),
      status: row.status,
      verified: row.verified,
      evidence: row.evidence,
      swarmId: row.swarmId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private sendLearning(learning: Learning): void {
    const message: ServerMessage = {
      type: 'learning',
      workspaceId: learning.workspaceId,
      learning,
    };
    // A preference is private: only its owner hears about it.
    if (learning.ownerId) this.out.sendUser(learning.ownerId, message);
    else this.out.sendWorkspace(learning.workspaceId, message);
  }

  /** Shared knowledge, and the caller's own preferences (nobody else's). */
  async listLearnings(workspaceId: string, userId: string): Promise<Learning[]> {
    await authorize(this.db, workspaceId, userId, 'memory.view');
    const rows = await this.db
      .select()
      .from(learnings)
      .where(
        and(
          eq(learnings.workspaceId, workspaceId),
          sql`${learnings.status} <> 'forgotten'`,
          or(isNull(learnings.ownerId), eq(learnings.ownerId, userId)),
        ),
      )
      .orderBy(desc(learnings.createdAt));
    return rows.map((r) => this.toLearning(r));
  }

  /**
   * Knowledge comes only from a checked task result and is shared at once; a preference is
   * the caller's, private and unverified until they accept it.
   */
  async learn(
    workspaceId: string,
    userId: string,
    input: z.infer<typeof CreateLearningSchema>,
  ): Promise<Learning> {
    await authorize(
      this.db,
      workspaceId,
      userId,
      input.kind === 'knowledge' ? 'memory.edit' : 'memory.view',
    );
    if (input.kind === 'knowledge' && (!input.verified || !input.evidence))
      throw badRequest('Knowledge comes from a task whose checks passed: say which');
    const [row] = await this.db
      .insert(learnings)
      .values({
        workspaceId,
        ownerId: input.kind === 'preference' ? userId : null,
        swarmId: input.swarmId,
        kind: input.kind,
        textEnc: this.enc.encrypt(redactText(input.text)),
        status: input.kind === 'knowledge' ? 'accepted' : 'suggested',
        verified: input.kind === 'knowledge',
        evidence: input.evidence ? redactText(input.evidence) : input.evidence,
        createdBy: userId,
      })
      .returning();
    const learning = this.toLearning(row!);
    this.sendLearning(learning);
    return learning;
  }

  /** Accept, correct or forget: a preference only by its owner, knowledge by any editor. */
  async updateLearning(
    id: string,
    userId: string,
    patch: z.infer<typeof UpdateLearningSchema>,
  ): Promise<Learning> {
    if (!isUuid(id)) throw notFound('Not found');
    const [row] = await this.db.select().from(learnings).where(eq(learnings.id, id));
    if (!row || (row.ownerId && row.ownerId !== userId)) throw notFound('Not found');
    if (!row.ownerId) await authorize(this.db, row.workspaceId, userId, 'memory.edit');
    const [updated] = await this.db
      .update(learnings)
      .set({
        ...(patch.text ? { textEnc: this.enc.encrypt(redactText(patch.text)) } : {}),
        ...(patch.status ? { status: patch.status } : {}),
        updatedAt: new Date(),
      })
      .where(eq(learnings.id, id))
      .returning();
    const learning = this.toLearning(updated!);
    this.sendLearning(learning);
    return learning;
  }
}
