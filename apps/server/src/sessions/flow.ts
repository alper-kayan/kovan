import type {
  Handoff,
  HandoffContext,
  MentionReply,
  Outcome,
  PathLock,
  ServerMessage,
} from '@kovan/shared';
import { NO_PUSH, type PushSink } from '../push/service.js';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { authorize, getRole } from '../authz.js';
import type { Encryptor } from '../crypto.js';
import type { Db } from '../db/client.js';
import {
  handoffs,
  outcomes,
  pathLocks,
  planSteps,
  sessionParticipants,
  sessions,
  users,
} from '../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { redact } from './redact.js';
import type { SessionService } from './service.js';

type HandoffRow = typeof handoffs.$inferSelect;

export interface FlowBroadcast {
  sendRoom(
    workspaceId: string,
    sessionId: string,
    message: ServerMessage,
    alsoUserId?: string,
  ): void;
  sendUser(userId: string, message: ServerMessage): void;
  isOnline(userId: string): boolean;
}

const isUuid = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

/** Postgres refused a duplicate (the query builder may wrap the driver's error). */
function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return e.code === '23505' || e.cause?.code === '23505';
}

function ago(at: Date | null): string {
  if (!at) return 'no snapshot yet';
  const minutes = Math.round((Date.now() - at.getTime()) / 60_000);
  return minutes < 1 ? 'snapshot just taken' : `snapshot from ${minutes} min ago`;
}

/**
 * Who works on what, when it has to change hands: advisory locks, steering someone's running
 * agent, takeovers and handoffs (one winner), and actions whose outcome is unknown.
 */
export class FlowService {
  push: PushSink = NO_PUSH;

  constructor(
    private readonly db: Db,
    private readonly enc: Encryptor,
    private readonly out: FlowBroadcast,
    private readonly sessions: SessionService,
  ) {}

  // ---------- locks ----------

  async locks(sessionId: string, userId: string): Promise<PathLock[]> {
    await this.sessions.visible(sessionId, userId);
    const rows = await this.db
      .select({ l: pathLocks, name: users.name })
      .from(pathLocks)
      .innerJoin(users, eq(users.id, pathLocks.userId))
      .where(eq(pathLocks.sessionId, sessionId))
      .orderBy(asc(pathLocks.path));
    return rows.map(({ l, name }) => ({
      sessionId: l.sessionId,
      path: l.path,
      userId: l.userId,
      userName: name,
      createdAt: l.createdAt.toISOString(),
    }));
  }

  /** Every lock in a workspace's live sessions, for agents' team context. */
  async workspaceLocks(workspaceId: string, userId: string): Promise<PathLock[]> {
    await authorize(this.db, workspaceId, userId, 'session.view');
    const rows = await this.db
      .select({ l: pathLocks, name: users.name })
      .from(pathLocks)
      .innerJoin(sessions, eq(sessions.id, pathLocks.sessionId))
      .innerJoin(users, eq(users.id, pathLocks.userId))
      .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.status, 'active')));
    return rows.map(({ l, name }) => ({
      sessionId: l.sessionId,
      path: l.path,
      userId: l.userId,
      userName: name,
      createdAt: l.createdAt.toISOString(),
    }));
  }

  async lock(sessionId: string, userId: string, path: string): Promise<PathLock[]> {
    const row = await this.sessions.row(sessionId);
    await authorize(this.db, row.workspaceId, userId, 'session.join');
    if (row.status !== 'active') throw conflict('This session has ended');
    const clean = path.trim().replace(/^\.\//, '');
    if (!clean || clean.startsWith('/') || clean.includes('..'))
      throw badRequest('Lock a path inside the repository');
    const [created] = await this.db
      .insert(pathLocks)
      .values({ sessionId, path: clean, userId })
      .onConflictDoNothing()
      .returning();
    if (created) {
      await this.sessions.activity(
        row,
        userId,
        'lock',
        `${await this.sessions.nameOf(userId)} locked ${clean}`,
        'agents are told not to edit it',
      );
      await this.sessions.announce(sessionId);
    }
    return this.locks(sessionId, userId);
  }

  async unlock(sessionId: string, userId: string, path: string): Promise<PathLock[]> {
    const row = await this.sessions.row(sessionId);
    const role = await authorize(this.db, row.workspaceId, userId, 'session.join');
    const [lock] = await this.db
      .select()
      .from(pathLocks)
      .where(and(eq(pathLocks.sessionId, sessionId), eq(pathLocks.path, path)));
    if (!lock) return this.locks(sessionId, userId);
    if (lock.userId !== userId && role !== 'owner')
      throw forbidden('Only whoever locked it (or an owner) can unlock it');
    await this.db
      .delete(pathLocks)
      .where(and(eq(pathLocks.sessionId, sessionId), eq(pathLocks.path, path)));
    await this.sessions.activity(
      row,
      userId,
      'unlock',
      `${await this.sessions.nameOf(userId)} unlocked ${path}`,
    );
    await this.sessions.announce(sessionId);
    return this.locks(sessionId, userId);
  }

  // ---------- steer ----------

  /** Guidance for a running lane goes to the owner's machine, which feeds it to the agent. */
  async steer(
    sessionId: string,
    fromUserId: string,
    laneUserId: string,
    id: string,
    text: string,
    mention?: { context: string | null; reply: MentionReply },
  ): Promise<void> {
    const row = await this.sessions.row(sessionId);
    await authorize(this.db, row.workspaceId, fromUserId, 'agent.steer');
    if (row.status !== 'active') throw conflict('This session has ended');
    // An AI teammate's lane runs on its host's machine: the guidance goes there.
    const [lane] = await this.db
      .select({ hostId: sessionParticipants.hostId })
      .from(sessionParticipants)
      .where(
        and(
          eq(sessionParticipants.sessionId, sessionId),
          eq(sessionParticipants.userId, laneUserId),
        ),
      );
    const machine = lane?.hostId ?? laneUserId;
    if (!this.out.isOnline(machine))
      throw conflict(
        `${await this.sessions.nameOf(machine)}'s machine is offline; ${lane?.hostId ? 'that AI teammate' : 'their agent'} can't be steered`,
      );
    this.out.sendUser(machine, {
      type: 'steer',
      sessionId,
      laneUserId,
      id,
      fromUserId,
      fromName: await this.sessions.nameOf(fromUserId),
      text: redact(text),
      ...(mention
        ? { mention: { context: mention.context && redact(mention.context), reply: mention.reply } }
        : {}),
    });
  }

  // ---------- takeovers and handoffs ----------

  private toHandoff(row: HandoffRow): Handoff {
    let context: HandoffContext | null = null;
    if (row.contextEnc) {
      try {
        context = JSON.parse(this.enc.decrypt(row.contextEnc)) as HandoffContext;
      } catch {
        context = null;
      }
    }
    return {
      id: row.id,
      sessionId: row.sessionId,
      kind: row.kind,
      fromUserId: row.fromUserId,
      toUserId: row.toUserId,
      status: row.status,
      snapshotSha: row.snapshotSha,
      snapshotRef: row.snapshotRef,
      snapshotAt: row.snapshotAt?.toISOString() ?? null,
      context,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async send(row: HandoffRow): Promise<Handoff> {
    const session = await this.sessions.row(row.sessionId);
    const handoff = this.toHandoff(row);
    const message: ServerMessage = { type: 'handoff', workspaceId: session.workspaceId, handoff };
    this.out.sendRoom(session.workspaceId, row.sessionId, message, row.fromUserId);
    this.out.sendUser(row.toUserId, message);
    return handoff;
  }

  /** What the person taking over needs, from the stored transcript (the owner may be gone). */
  private async contextFromTranscript(
    sessionId: string,
    laneUserId: string,
    reason: string,
  ): Promise<HandoffContext> {
    const lanes = await this.sessions.transcriptFor(sessionId);
    const events = lanes.find((l) => l.userId === laneUserId)?.events ?? [];
    const prompts = events.filter((e) => e.type === 'user').map((e) => String(e['text'] ?? ''));
    let lastReply: string | null = null;
    for (let i = events.length - 1, text = ''; i >= 0; i--) {
      const e = events[i]!;
      if (e.type === 'text') text = String(e['text'] ?? '') + text;
      else if (text) {
        lastReply = text;
        break;
      }
      if (i === 0 && text) lastReply = text;
    }
    const session = await this.sessions.row(sessionId);
    return {
      lastPrompts: prompts.slice(-3).map((p) => p.slice(0, 2000)),
      lastReply: lastReply?.slice(0, 4000) ?? null,
      touchedFiles: session.touchedFiles.slice(0, 30),
      reason,
    };
  }

  /**
   * Asks to take over someone's lane. One open request per lane: a second person asking at the
   * same time gets a conflict (and can join instead). If the owner is offline or their agent
   * hit a limit, it's ready at once from their last snapshot; otherwise their machine stops at
   * a safe checkpoint first.
   */
  async takeover(sessionId: string, takerId: string, laneUserId: string): Promise<Handoff> {
    const row = await this.sessions.row(sessionId);
    await authorize(this.db, row.workspaceId, takerId, 'agent.takeover');
    if (row.status !== 'active') throw conflict('This session has ended');
    if (takerId === laneUserId) throw badRequest("That's your own lane");
    const [lane] = await this.db
      .select()
      .from(sessionParticipants)
      .where(
        and(
          eq(sessionParticipants.sessionId, sessionId),
          eq(sessionParticipants.userId, laneUserId),
        ),
      );
    if (!lane || lane.mode !== 'join') throw notFound('No such lane in this session');
    const owner = await this.sessions.nameOf(laneUserId);
    const immediate = Boolean(lane.awaitingReason) || !this.out.isOnline(laneUserId);
    const reason = lane.awaitingReason
      ? `${owner}'s agent hit a usage limit`
      : !this.out.isOnline(laneUserId)
        ? `${owner}'s machine is offline`
        : `${await this.sessions.nameOf(takerId)} took over`;
    let created: HandoffRow | undefined;
    try {
      [created] = await this.db
        .insert(handoffs)
        .values({
          sessionId,
          kind: 'takeover',
          fromUserId: laneUserId,
          toUserId: takerId,
          status: immediate ? 'ready' : 'requested',
          ...(immediate
            ? {
                snapshotSha: lane.snapshotSha,
                snapshotRef: lane.snapshotRef,
                snapshotAt: lane.snapshotAt,
                contextEnc: this.enc.encrypt(
                  JSON.stringify(await this.contextFromTranscript(sessionId, laneUserId, reason)),
                ),
              }
            : {}),
        })
        .returning();
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const [open] = await this.db
        .select({ to: handoffs.toUserId })
        .from(handoffs)
        .where(
          and(
            eq(handoffs.sessionId, sessionId),
            eq(handoffs.fromUserId, laneUserId),
            inArray(handoffs.status, ['requested', 'ready']),
          ),
        );
      throw conflict(
        `${open ? await this.sessions.nameOf(open.to) : 'Someone'} is already taking over ${owner}'s lane. Join the session to work alongside instead.`,
      );
    }
    await this.sessions.activity(
      row,
      takerId,
      'takeover_requested',
      `${await this.sessions.nameOf(takerId)} requested to take over ${owner}'s lane`,
      immediate ? `${reason} · using the ${ago(lane.snapshotAt)}` : 'waiting for a safe checkpoint',
    );
    return this.send(created!);
  }

  /** The owner gives their own lane's work to someone (who may not even have an agent). */
  async handoff(
    sessionId: string,
    ownerId: string,
    toUserId: string,
    snapshot: { sha: string | null; ref: string | null },
    context: HandoffContext,
  ): Promise<Handoff> {
    const row = await this.sessions.row(sessionId);
    await authorize(this.db, row.workspaceId, ownerId, 'session.join');
    if (!isUuid(toUserId) || !(await getRole(this.db, row.workspaceId, toUserId)))
      throw badRequest('That person is not in this workspace');
    if (toUserId === ownerId) throw badRequest("It's already yours");
    let created: HandoffRow | undefined;
    try {
      [created] = await this.db
        .insert(handoffs)
        .values({
          sessionId,
          kind: 'handoff',
          fromUserId: ownerId,
          toUserId,
          status: 'ready',
          snapshotSha: snapshot.sha,
          snapshotRef: snapshot.ref,
          snapshotAt: snapshot.sha ? new Date() : null,
          contextEnc: this.enc.encrypt(JSON.stringify(redact(context))),
        })
        .returning();
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      throw conflict('Someone is already taking over this lane');
    }
    await this.sessions.activity(
      row,
      ownerId,
      'takeover_requested',
      `${await this.sessions.nameOf(ownerId)} handed their work to ${await this.sessions.nameOf(toUserId)}`,
      context.reason,
    );
    this.push.emit({
      kind: 'handoff',
      sessionId,
      fromUserId: ownerId,
      toUserId,
      reason: context.reason,
    });
    return this.send(created!);
  }

  private async open(id: string): Promise<HandoffRow> {
    if (!isUuid(id)) throw notFound('Handoff not found');
    const [row] = await this.db.select().from(handoffs).where(eq(handoffs.id, id));
    if (!row) throw notFound('Handoff not found');
    return row;
  }

  /** The owner's machine stopped at a checkpoint and pushed a snapshot: the taker can go. */
  async ready(
    id: string,
    ownerId: string,
    snapshot: { sha: string | null; ref: string | null },
    context: HandoffContext,
  ): Promise<Handoff> {
    const row = await this.open(id);
    if (row.fromUserId !== ownerId) throw forbidden();
    if (row.status !== 'requested') throw conflict('This takeover is no longer waiting');
    const [updated] = await this.db
      .update(handoffs)
      .set({
        status: 'ready',
        snapshotSha: snapshot.sha,
        snapshotRef: snapshot.ref,
        snapshotAt: snapshot.sha ? new Date() : null,
        contextEnc: this.enc.encrypt(JSON.stringify(redact(context))),
        updatedAt: new Date(),
      })
      .where(and(eq(handoffs.id, id), eq(handoffs.status, 'requested')))
      .returning();
    if (!updated) throw conflict('This takeover is no longer waiting');
    return this.send(updated);
  }

  /** The taker accepts: the owner's open steps become theirs; History records the move. */
  async accept(
    id: string,
    takerId: string,
  ): Promise<{
    handoff: Handoff;
    resumeStep: { index: number; total: number; title: string } | null;
  }> {
    const row = await this.open(id);
    if (row.toUserId !== takerId) throw notFound('Handoff not found');
    if (row.status !== 'ready')
      throw conflict(
        row.status === 'requested'
          ? 'Still waiting for a safe checkpoint'
          : 'This handoff is closed',
      );
    const session = await this.sessions.row(row.sessionId);
    const [updated] = await this.db
      .update(handoffs)
      .set({ status: 'done', updatedAt: new Date() })
      .where(and(eq(handoffs.id, id), eq(handoffs.status, 'ready')))
      .returning();
    if (!updated) throw conflict('This handoff is closed');
    await this.db
      .update(planSteps)
      .set({ ownerId: takerId, updatedAt: new Date() })
      .where(
        and(
          eq(planSteps.sessionId, row.sessionId),
          eq(planSteps.ownerId, row.fromUserId),
          ne(planSteps.status, 'done'),
        ),
      );
    await this.db
      .update(sessionParticipants)
      .set({ awaitingReason: null })
      .where(
        and(
          eq(sessionParticipants.sessionId, row.sessionId),
          eq(sessionParticipants.userId, row.fromUserId),
        ),
      );
    // Where the work picks up: the first step not done, counted in the whole plan.
    const steps = await this.db
      .select()
      .from(planSteps)
      .where(eq(planSteps.sessionId, row.sessionId))
      .orderBy(asc(planSteps.position), asc(planSteps.createdAt));
    const at = steps.findIndex((s) => s.status !== 'done' && s.ownerId === takerId);
    const resumeStep =
      at >= 0 ? { index: at + 1, total: steps.length, title: steps[at]!.title } : null;
    await this.sessions.activity(
      session,
      takerId,
      'handed_over',
      `${await this.sessions.nameOf(takerId)} took over ${await this.sessions.nameOf(row.fromUserId)}'s work`,
      resumeStep
        ? `resuming at step ${resumeStep.index} of ${resumeStep.total}`
        : ago(row.snapshotAt),
    );
    await this.sessions.announce(row.sessionId);
    return { handoff: await this.send(updated), resumeStep };
  }

  async decline(id: string, userId: string): Promise<Handoff> {
    const row = await this.open(id);
    const mine = row.toUserId === userId;
    if (!mine && row.fromUserId !== userId) throw notFound('Handoff not found');
    const [updated] = await this.db
      .update(handoffs)
      .set({ status: mine ? 'declined' : 'cancelled', updatedAt: new Date() })
      .where(and(eq(handoffs.id, id), inArray(handoffs.status, ['requested', 'ready'])))
      .returning();
    if (!updated) throw conflict('This handoff is closed');
    return this.send(updated);
  }

  /** Open handoffs and unknown outcomes in a workspace's live sessions (the alerts strip). */
  async alerts(
    workspaceId: string,
    userId: string,
  ): Promise<{ handoffs: Handoff[]; outcomes: Outcome[] }> {
    await authorize(this.db, workspaceId, userId, 'session.view');
    const open = await this.db
      .select({ h: handoffs })
      .from(handoffs)
      .innerJoin(sessions, eq(sessions.id, handoffs.sessionId))
      .where(
        and(
          eq(sessions.workspaceId, workspaceId),
          eq(sessions.status, 'active'),
          inArray(handoffs.status, ['requested', 'ready']),
        ),
      );
    const unknown = await this.db
      .select({ o: outcomes })
      .from(outcomes)
      .innerJoin(sessions, eq(sessions.id, outcomes.sessionId))
      .where(
        and(
          eq(sessions.workspaceId, workspaceId),
          eq(sessions.status, 'active'),
          eq(outcomes.status, 'unknown'),
        ),
      );
    return {
      handoffs: open.map((r) => this.toHandoff(r.h)),
      outcomes: unknown.map((r) => this.sessions.toOutcome(r.o)),
    };
  }

  // ---------- outcomes ----------

  /** A person records what really happened to an action that was cut off. */
  async record(
    id: string,
    userId: string,
    status: 'succeeded' | 'failed' | 'not_run',
  ): Promise<Outcome> {
    if (!isUuid(id)) throw notFound('Not found');
    const [row] = await this.db.select().from(outcomes).where(eq(outcomes.id, id));
    if (!row) throw notFound('Not found');
    const session = await this.sessions.row(row.sessionId);
    await authorize(this.db, session.workspaceId, userId, 'approval.answer');
    const [updated] = await this.db
      .update(outcomes)
      .set({ status, recordedBy: userId })
      .where(eq(outcomes.id, id))
      .returning();
    const outcome = this.sessions.toOutcome(updated!);
    this.out.sendRoom(session.workspaceId, session.id, {
      type: 'outcome',
      workspaceId: session.workspaceId,
      outcome,
    });
    await this.sessions.activity(
      session,
      userId,
      'outcome_recorded',
      `${await this.sessions.nameOf(userId)} recorded “${row.command.slice(0, 60)}” as ${status.replace('_', ' ')}`,
    );
    await this.sessions.announce(session.id);
    return outcome;
  }
}
