import { NO_EVENTS, type EventSink } from '../events/service.js';
import { memberKind } from '../users.js';
import {
  type ReplayEvent,
  MAX_SESSION_AGENTS,
  can,
  type Role,
  type Activity,
  type ActivityKind,
  type LaneEvent,
  type Outcome,
  type LaneState,
  type LaneTranscript,
  type Participant,
  type ServerMessage,
  type Session,
  type SessionApproval,
  type SessionChanges,
} from '@kovan/shared';
import { NO_PUSH, type PushSink } from '../push/service.js';
import { and, asc, desc, eq, inArray, isNull, sql, sum } from 'drizzle-orm';
import type { z } from 'zod';
import type {
  EndSessionSchema,
  JoinSessionSchema,
  SessionChangesInputSchema,
  StartSessionSchema,
} from '@kovan/shared';
import { authorize, authorizeLane, getRole } from '../authz.js';
import type { Encryptor } from '../crypto.js';
import type { Db } from '../db/client.js';
import {
  activities,
  outcomes,
  pathLocks,
  planSteps,
  sessionApprovals,
  sessionChanges,
  sessionParticipants,
  sessions,
  subagents,
  swarms,
  journalEvents,
  machines,
  transcriptChunks,
  turns,
  users,
  workspaces,
} from '../db/schema.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { redact, redactText } from './redact.js';

/** Flush a lane's buffered events to the database after this many, or on a timer. */
const FLUSH_EVENTS = 200;
const FLUSH_INTERVAL_MS = 5_000;
const RETENTION_SWEEP_MS = 6 * 3_600_000;
const MAX_TOUCHED = 100;
const isUuid = (id: string) => /^[0-9a-f-]{36}$/i.test(id);
const UNSTORED = new Set(['tool_progress', 'sync', 'paused', 'resumed', 'conflict']);
/** Long tool output is clipped before it is stored or sent to others. */
const MAX_FIELD = 20_000;

type SessionRow = typeof sessions.$inferSelect;
type StartInput = z.infer<typeof StartSessionSchema>;
type JoinInput = z.infer<typeof JoinSessionSchema>;
type EndInput = z.infer<typeof EndSessionSchema>;

interface LaneLive {
  state: LaneState;
  model: string | null;
  /** Events not yet written, in order. */
  buffer: LaneEvent[];
  /** The next chunk number; loaded from the database on first use. */
  nextSeq: number | null;
}

/** What the session service needs from the realtime hub. */
export interface SessionBroadcast {
  /** To everyone following the session. */
  sendSession(sessionId: string, message: ServerMessage): void;
  /** Once to everyone following the workspace or the session, plus a person's own machines. */
  sendRoom(
    workspaceId: string,
    sessionId: string,
    message: ServerMessage,
    alsoUserId?: string,
  ): void;
}

function clip(value: unknown): unknown {
  if (typeof value === 'string')
    return value.length > MAX_FIELD
      ? `${value.slice(0, MAX_FIELD)}\n… (${value.length - MAX_FIELD} more characters)`
      : value;
  if (Array.isArray(value)) return value.map(clip);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v)]));
  return value;
}

/** Joins streamed text and reasoning deltas so stored chunks stay small. */
export function compactLaneEvents(events: LaneEvent[]): LaneEvent[] {
  const out: LaneEvent[] = [];
  for (const e of events) {
    const last = out.at(-1);
    if (
      last &&
      (e.type === 'text' || e.type === 'reasoning') &&
      last.type === e.type &&
      typeof last['text'] === 'string' &&
      typeof e['text'] === 'string'
    ) {
      out[out.length - 1] = { ...last, text: last['text'] + e['text'] };
    } else out.push(e);
  }
  return out;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * Sessions: the room records, each lane's live state, transcripts and team-wide approvals.
 * Lane events come from the machine running that lane's agent; everyone else gets them live.
 */
export class SessionService {
  /** Push notifications for people away from their desk (set when push is configured). */
  push: PushSink = NO_PUSH;
  /** Where other systems hear what happened (webhooks, the event stream). */
  events: EventSink = NO_EVENTS;

  private readonly lanes = new Map<string, Map<string, LaneLive>>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly db: Db,
    private readonly enc: Encryptor,
    private readonly out: SessionBroadcast,
    private readonly log: (message: string) => void = () => {},
  ) {}

  start(): void {
    const flush = setInterval(
      () => void this.flushAll().catch((e) => this.log(String(e))),
      FLUSH_INTERVAL_MS,
    );
    const sweep = setInterval(
      () => void this.sweepRetention().catch((e) => this.log(String(e))),
      RETENTION_SWEEP_MS,
    );
    flush.unref();
    sweep.unref();
    this.timers.push(flush, sweep);
    void this.sweepRetention().catch((e) => this.log(String(e)));
  }

  async close(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    await this.flushAll();
  }

  /** Runs `fn` alone for this session: flushes and snapshots never interleave. */
  private withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.locks.set(sessionId, next);
    const cleanup = () => {
      if (this.locks.get(sessionId) === next) this.locks.delete(sessionId);
    };
    next.then(cleanup, cleanup);
    return next;
  }

  private lane(sessionId: string, userId: string): LaneLive {
    let byUser = this.lanes.get(sessionId);
    if (!byUser) this.lanes.set(sessionId, (byUser = new Map()));
    let lane = byUser.get(userId);
    if (!lane)
      byUser.set(userId, (lane = { state: 'idle', model: null, buffer: [], nextSeq: null }));
    return lane;
  }

  // ---------- reading ----------

  async row(sessionId: string): Promise<SessionRow> {
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw notFound('Session not found');
    const [row] = await this.db.select().from(sessions).where(eq(sessions.id, sessionId));
    if (!row) throw notFound('Session not found');
    return row;
  }

  /** The session, if the person may see it (404 otherwise, so ids don't leak). */
  async visible(sessionId: string, userId: string): Promise<SessionRow> {
    const row = await this.row(sessionId);
    await authorize(this.db, row.workspaceId, userId, 'session.view');
    return row;
  }

  private async views(rows: SessionRow[]): Promise<Session[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const people = await this.db
      .select({
        sessionId: sessionParticipants.sessionId,
        userId: sessionParticipants.userId,
        mode: sessionParticipants.mode,
        harness: sessionParticipants.harness,
        model: sessionParticipants.model,
        joinedAt: sessionParticipants.joinedAt,
        awaitingReason: sessionParticipants.awaitingReason,
        snapshotAt: sessionParticipants.snapshotAt,
        snapshotSha: sessionParticipants.snapshotSha,
        snapshotRef: sessionParticipants.snapshotRef,
        paused: sessionParticipants.paused,
        hostId: sessionParticipants.hostId,
        kind: users.kind,
        name: users.name,
        avatarUrl: users.avatarUrl,
      })
      .from(sessionParticipants)
      .innerJoin(users, eq(users.id, sessionParticipants.userId))
      .where(and(inArray(sessionParticipants.sessionId, ids), isNull(sessionParticipants.leftAt)))
      .orderBy(asc(sessionParticipants.joinedAt));
    const steps = await this.db
      .select({
        sessionId: planSteps.sessionId,
        total: sql<number>`count(*)::int`,
        done: sql<number>`count(*) filter (where ${planSteps.status} = 'done')::int`,
        waiting: sql<number>`count(*) filter (where ${planSteps.runState} in ('waiting', 'waiting_for_approval'))::int`,
        running: sql<number>`count(*) filter (where ${planSteps.runState} = 'running')::int`,
        tasksDone: sql<number>`count(*) filter (where ${planSteps.runState} = 'done')::int`,
        failed: sql<number>`count(*) filter (where ${planSteps.runState} = 'failed')::int`,
        blocked: sql<number>`count(*) filter (where ${planSteps.runState} = 'blocked')::int`,
        cancelled: sql<number>`count(*) filter (where ${planSteps.runState} = 'cancelled')::int`,
      })
      .from(planSteps)
      .where(inArray(planSteps.sessionId, ids))
      .groupBy(planSteps.sessionId);
    const asking = await this.db
      .select({
        sessionId: planSteps.sessionId,
        stepId: planSteps.id,
        title: planSteps.title,
        reason: planSteps.approvalReason,
      })
      .from(planSteps)
      .where(and(inArray(planSteps.sessionId, ids), eq(planSteps.approval, 'pending')))
      .orderBy(asc(planSteps.position));
    const costs = await this.db
      .select({ sessionId: turns.sessionId, cost: sum(turns.cost) })
      .from(turns)
      .where(inArray(turns.sessionId, ids))
      .groupBy(turns.sessionId);
    const locks = await this.db
      .select({ sessionId: pathLocks.sessionId, path: pathLocks.path, userId: pathLocks.userId })
      .from(pathLocks)
      .where(inArray(pathLocks.sessionId, ids));
    const unknown = await this.db
      .select({ sessionId: outcomes.sessionId, n: sql<number>`count(*)::int` })
      .from(outcomes)
      .where(and(inArray(outcomes.sessionId, ids), eq(outcomes.status, 'unknown')))
      .groupBy(outcomes.sessionId);
    const pending = await this.db
      .select({ sessionId: sessionApprovals.sessionId, n: sql<number>`count(*)::int` })
      .from(sessionApprovals)
      .where(and(inArray(sessionApprovals.sessionId, ids), eq(sessionApprovals.status, 'pending')))
      .groupBy(sessionApprovals.sessionId);
    const children = await this.db
      .select({ sessionId: subagents.sessionId, n: sql<number>`count(*)::int` })
      .from(subagents)
      .where(
        and(
          inArray(subagents.sessionId, ids),
          inArray(subagents.status, ['running', 'checking', 'passed']),
        ),
      )
      .groupBy(subagents.sessionId);
    const swarmRows = await this.db
      .select({
        id: swarms.id,
        sessionId: swarms.sessionId,
        status: swarms.status,
        spent: swarms.spent,
        budget: swarms.budget,
        pausedReason: swarms.pausedReason,
        outcome: swarms.outcome,
        launchedBy: swarms.launchedBy,
      })
      .from(swarms)
      .where(inArray(swarms.sessionId, ids))
      .orderBy(desc(swarms.createdAt));
    const machineIds = [...new Set(rows.map((r) => r.machineId).filter((m) => m !== null))];
    const machineNames = new Map(
      (machineIds.length
        ? await this.db
            .select({ id: machines.id, name: machines.name })
            .from(machines)
            .where(inArray(machines.id, machineIds))
        : []
      ).map((m) => [m.id, m.name]),
    );
    const hostNames = new Map<string, string>();
    for (const p of people)
      if (p.hostId && !hostNames.has(p.hostId))
        hostNames.set(p.hostId, await this.nameOf(p.hostId));

    return rows.map((r) => {
      const live = this.lanes.get(r.id);
      const participants: Participant[] = people
        .filter((p) => p.sessionId === r.id)
        .map((p) => {
          const lane = live?.get(p.userId);
          const active = p.mode === 'join' && r.status === 'active';
          const state = active
            ? p.awaitingReason && lane?.state !== 'running'
              ? 'awaiting'
              : (lane?.state ?? 'idle')
            : 'idle';
          return {
            userId: p.userId,
            name: p.name,
            avatarUrl: p.avatarUrl,
            mode: p.mode,
            harness: p.harness,
            model: lane?.model ?? p.model,
            state,
            joinedAt: p.joinedAt.toISOString(),
            awaitingReason: active ? p.awaitingReason : null,
            snapshotAt: iso(p.snapshotAt),
            snapshotSha: p.snapshotSha,
            snapshotRef: p.snapshotRef,
            paused: active ? p.paused : null,
            kind: memberKind(p.kind),
            hostId: p.hostId,
            hostName: p.hostId ? (hostNames.get(p.hostId) ?? null) : null,
          };
        });
      return {
        id: r.id,
        workspaceId: r.workspaceId,
        title: r.title,
        branch: r.branch,
        status: r.status,
        createdBy: r.createdBy,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        endedAt: iso(r.endedAt),
        participants,
        touchedFiles: r.touchedFiles,
        running: participants
          .filter((p) => p.state === 'running' || p.state === 'waiting')
          .map((p) => ({ userId: p.userId, model: p.model })),
        pendingApprovals: pending.find((x) => x.sessionId === r.id)?.n ?? 0,
        cost: Number(costs.find((c) => c.sessionId === r.id)?.cost ?? 0),
        plan: (() => {
          const p = steps.find((x) => x.sessionId === r.id);
          return { done: p?.done ?? 0, total: p?.total ?? 0 };
        })(),
        tasks: (() => {
          const p = steps.find((x) => x.sessionId === r.id);
          return {
            waiting: p?.waiting ?? 0,
            running: p?.running ?? 0,
            done: p?.tasksDone ?? 0,
            failed: p?.failed ?? 0,
            blocked: p?.blocked ?? 0,
            cancelled: p?.cancelled ?? 0,
          };
        })(),
        taskApprovals: asking
          .filter((a) => a.sessionId === r.id)
          .map((a) => ({ stepId: a.stepId, title: a.title, reason: a.reason ?? '' })),
        locks: locks
          .filter((l) => l.sessionId === r.id)
          .map(({ path, userId }) => ({ path, userId })),
        unknownOutcomes: unknown.find((x) => x.sessionId === r.id)?.n ?? 0,
        subagents: children.find((x) => x.sessionId === r.id)?.n ?? 0,
        swarm: (() => {
          const w = swarmRows.find((x) => x.sessionId === r.id);
          return w
            ? {
                id: w.id,
                status: w.status,
                spent: w.spent,
                budget: w.budget,
                pausedReason: w.pausedReason,
                outcome: w.outcome ?? null,
                launchedBy: w.launchedBy,
              }
            : null;
        })(),
        pr:
          r.prUrl && r.prNumber && r.prState
            ? { url: r.prUrl, number: r.prNumber, state: r.prState }
            : null,
        issue: r.issueNumber ? { number: r.issueNumber, url: r.issueUrl } : null,
        machine:
          r.machineId && machineNames.has(r.machineId)
            ? { id: r.machineId, name: machineNames.get(r.machineId)! }
            : null,
        worktreePath: r.machineId ? r.worktreePath : null,
      };
    });
  }

  async view(sessionId: string): Promise<Session> {
    const [view] = await this.views([await this.row(sessionId)]);
    return view!;
  }

  async list(workspaceId: string, userId: string, status: 'active' | 'ended'): Promise<Session[]> {
    await authorize(this.db, workspaceId, userId, 'session.view');
    const rows = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.status, status)))
      .orderBy(desc(sessions.updatedAt))
      .limit(status === 'active' ? 200 : 100);
    return this.views(rows);
  }

  private toApproval(row: typeof sessionApprovals.$inferSelect): SessionApproval {
    return {
      sessionId: row.sessionId,
      laneUserId: row.laneUserId,
      requestId: row.requestId,
      tool: row.tool,
      kind: row.kind,
      title: row.title,
      detail: this.decryptOr(row.detailEnc, '(unreadable: the encryption key changed)'),
      status: row.status,
      answeredBy: row.answeredBy,
      answeredByName: null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private decryptOr(payload: string, fallback: string): string {
    try {
      return this.enc.decrypt(payload);
    } catch {
      return fallback;
    }
  }

  /** Pending approvals across a workspace's live sessions, for the alerts strip. */
  async pendingApprovals(workspaceId: string, userId: string): Promise<SessionApproval[]> {
    await authorize(this.db, workspaceId, userId, 'session.view');
    const rows = await this.db
      .select({ a: sessionApprovals })
      .from(sessionApprovals)
      .innerJoin(sessions, eq(sessions.id, sessionApprovals.sessionId))
      .where(
        and(
          eq(sessions.workspaceId, workspaceId),
          eq(sessions.status, 'active'),
          eq(sessionApprovals.status, 'pending'),
        ),
      )
      .orderBy(asc(sessionApprovals.createdAt));
    return rows.map((r) => this.toApproval(r.a));
  }

  private async readChunks(sessionId: string): Promise<Map<string, LaneEvent[]>> {
    const chunks = await this.db
      .select({ userId: transcriptChunks.userId, dataEnc: transcriptChunks.dataEnc })
      .from(transcriptChunks)
      .where(eq(transcriptChunks.sessionId, sessionId))
      .orderBy(asc(transcriptChunks.userId), asc(transcriptChunks.seq));
    const byUser = new Map<string, LaneEvent[]>();
    let unreadable = 0;
    for (const c of chunks) {
      let events: LaneEvent[];
      try {
        events = JSON.parse(this.enc.decrypt(c.dataEnc)) as LaneEvent[];
      } catch {
        // Written with a key this server no longer has; the rest of the transcript still shows.
        unreadable += 1;
        continue;
      }
      byUser.set(c.userId, [...(byUser.get(c.userId) ?? []), ...events]);
    }
    if (unreadable) this.log(`session ${sessionId}: ${unreadable} transcript chunk(s) unreadable`);
    return byUser;
  }

  /** Stored events plus what is still buffered. Synchronous, so nothing slips in between. */
  private withBuffers(sessionId: string, stored: Map<string, LaneEvent[]>): LaneTranscript[] {
    const byUser = new Map(stored);
    for (const [userId, lane] of this.lanes.get(sessionId) ?? [])
      if (lane.buffer.length) byUser.set(userId, [...(byUser.get(userId) ?? []), ...lane.buffer]);
    return [...byUser].map(([userId, events]) => ({ userId, events }));
  }

  async transcript(sessionId: string, userId: string): Promise<LaneTranscript[]> {
    const row = await this.row(sessionId);
    await authorize(this.db, row.workspaceId, userId, 'transcript.view');
    return this.withLock(sessionId, async () =>
      this.withBuffers(sessionId, await this.readChunks(sessionId)),
    );
  }

  /** The transcript for internal use (handoff context); callers check access. */
  transcriptFor(sessionId: string): Promise<LaneTranscript[]> {
    return this.withLock(sessionId, async () =>
      this.withBuffers(sessionId, await this.readChunks(sessionId)),
    );
  }

  async finalDiff(sessionId: string, userId: string): Promise<string | null> {
    const row = await this.row(sessionId);
    await authorize(this.db, row.workspaceId, userId, 'diff.view');
    return row.finalDiffEnc
      ? this.decryptOr(row.finalDiffEnc, '(unreadable: the encryption key changed)')
      : null;
  }

  /**
   * A machine's newer view of the live session's changes. Only someone who may work in the
   * session sends one; the room hears that it changed and reads it when it wants.
   */
  async putChanges(
    sessionId: string,
    userId: string,
    input: z.infer<typeof SessionChangesInputSchema>,
  ): Promise<void> {
    const row = await this.row(sessionId);
    await authorize(this.db, row.workspaceId, userId, 'session.join');
    if (row.status !== 'active') throw conflict('The session has ended.');
    const now = new Date();
    const values = {
      diffEnc: input.diff ? this.enc.encrypt(redact(input.diff)) : null,
      commit: input.commit,
      updatedAt: now,
    };
    await this.db
      .insert(sessionChanges)
      .values({ sessionId, userId, ...values })
      .onConflictDoUpdate({
        target: [sessionChanges.sessionId, sessionChanges.userId],
        set: values,
      });
    this.out.sendSession(sessionId, {
      type: 'session.changes',
      sessionId,
      userId,
      updatedAt: now.toISOString(),
    });
  }

  /** Each machine's latest view of a live session's changes, newest first. */
  async changes(sessionId: string, userId: string): Promise<SessionChanges[]> {
    const row = await this.row(sessionId);
    await authorize(this.db, row.workspaceId, userId, 'diff.view');
    const rows = await this.db
      .select({
        userId: sessionChanges.userId,
        userName: users.name,
        diffEnc: sessionChanges.diffEnc,
        commit: sessionChanges.commit,
        updatedAt: sessionChanges.updatedAt,
      })
      .from(sessionChanges)
      .innerJoin(users, eq(users.id, sessionChanges.userId))
      .where(eq(sessionChanges.sessionId, sessionId))
      .orderBy(desc(sessionChanges.updatedAt));
    return rows.map((r) => ({
      userId: r.userId,
      userName: r.userName,
      diff: r.diffEnc
        ? this.decryptOr(r.diffEnc, '(unreadable: the encryption key changed)')
        : null,
      commit: r.commit,
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  /**
   * Everything a newcomer needs to catch up, built so that no event is lost or repeated:
   * `subscribe` runs inside the session lock, right after the snapshot is read.
   */
  async snapshot(
    sessionId: string,
    userId: string,
    subscribe: (message: ServerMessage, workspaceId: string) => void,
  ): Promise<void> {
    const row = await this.visible(sessionId, userId);
    await this.withLock(sessionId, async () => {
      const stored = await this.readChunks(sessionId);
      const approvals = await this.db
        .select()
        .from(sessionApprovals)
        .where(
          and(eq(sessionApprovals.sessionId, sessionId), eq(sessionApprovals.status, 'pending')),
        );
      const session = await this.view(sessionId);
      // The lock keeps flushes out, so events that arrived meanwhile are still buffered: take
      // them and subscribe in the same tick, and the live stream continues exactly from here.
      subscribe(
        {
          type: 'session.snapshot',
          session,
          lanes: this.withBuffers(sessionId, stored),
          approvals: approvals.map((a) => this.toApproval(a)),
        },
        row.workspaceId,
      );
    });
  }

  // ---------- changing ----------

  /** Sends the session's current card to everyone following its workspace or the room. */
  async announce(sessionId: string): Promise<Session> {
    const session = await this.view(sessionId);
    this.out.sendRoom(session.workspaceId, sessionId, { type: 'session', session });
    return session;
  }

  async create(
    workspaceId: string,
    userId: string,
    input: StartInput,
    machineId: string | null = null,
  ): Promise<Session> {
    await authorize(this.db, workspaceId, userId, 'session.start');
    let issueUrl = input.issue?.url ?? null;
    if (input.issue && !issueUrl) {
      const [ws] = await this.db
        .select({ repoUrl: workspaces.repoUrl })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));
      if (ws?.repoUrl?.startsWith('github.com/'))
        issueUrl = `https://${ws.repoUrl}/issues/${input.issue.number}`;
    }
    const [row] = await this.db
      .insert(sessions)
      .values({
        workspaceId,
        title: input.title,
        branch: input.branch,
        createdBy: userId,
        issueNumber: input.issue?.number ?? null,
        issueUrl,
        machineId,
      })
      .returning();
    const session = await this.announce(row!.id);
    this.events.session(row!.id, 'session.started', { startedBy: await this.nameOf(userId) });
    return session;
  }

  async join(sessionId: string, userId: string, input: JoinInput): Promise<Session> {
    const row = await this.row(sessionId);
    await authorize(
      this.db,
      row.workspaceId,
      userId,
      input.mode === 'join' ? 'session.join' : 'session.view',
    );
    if (row.status !== 'active') throw conflict('This session has ended');
    if (input.mode === 'join') {
      const [taken] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(sessionParticipants)
        .where(
          and(
            eq(sessionParticipants.sessionId, sessionId),
            eq(sessionParticipants.mode, 'join'),
            isNull(sessionParticipants.leftAt),
            sql`${sessionParticipants.userId} <> ${userId}`,
          ),
        );
      if ((taken?.n ?? 0) >= MAX_SESSION_AGENTS)
        throw conflict(
          `This session is full: ${MAX_SESSION_AGENTS} agents are already working in it`,
        );
    }
    const [before] = await this.db
      .select({ mode: sessionParticipants.mode, leftAt: sessionParticipants.leftAt })
      .from(sessionParticipants)
      .where(
        and(eq(sessionParticipants.sessionId, sessionId), eq(sessionParticipants.userId, userId)),
      );
    await this.db
      .insert(sessionParticipants)
      .values({ sessionId, userId, mode: input.mode, harness: input.harness, model: input.model })
      .onConflictDoUpdate({
        target: [sessionParticipants.sessionId, sessionParticipants.userId],
        set: {
          mode: input.mode,
          harness: input.harness,
          model: input.model,
          leftAt: null,
          joinedAt: sql`case when ${sessionParticipants.leftAt} is null then ${sessionParticipants.joinedAt} else now() end`,
        },
      });
    if (input.mode === 'join' && input.model) this.lane(sessionId, userId).model = input.model;
    // Opening the session again (or another window of it) isn't news; coming in, or switching
    // between watching and working, is.
    if (!before || before.leftAt || before.mode !== input.mode)
      await this.activity(
        row,
        userId,
        'joined',
        input.mode === 'join'
          ? `${await this.nameOf(userId)} joined with their agent`
          : `${await this.nameOf(userId)} is watching`,
      );
    return this.announce(sessionId);
  }

  async leave(sessionId: string, userId: string): Promise<Session> {
    await this.visible(sessionId, userId);
    await this.db
      .update(sessionParticipants)
      .set({ leftAt: new Date() })
      .where(
        and(eq(sessionParticipants.sessionId, sessionId), eq(sessionParticipants.userId, userId)),
      );
    await this.expireApprovals(sessionId, userId);
    await this.withLock(sessionId, () => this.flushLane(sessionId, userId));
    this.lanes.get(sessionId)?.delete(userId);
    return this.announce(sessionId);
  }

  /**
   * Someone's role in a workspace changed: removed, they leave its live sessions at once;
   * demoted below what working in a lane needs, their lane turns into watching. Either way the
   * approvals waiting on their lane are closed, and everyone in the session sees it.
   */
  async membershipChanged(workspaceId: string, userId: string, role: Role | null): Promise<void> {
    const rows = await this.db
      .select({ sessionId: sessionParticipants.sessionId, mode: sessionParticipants.mode })
      .from(sessionParticipants)
      .innerJoin(sessions, eq(sessions.id, sessionParticipants.sessionId))
      .where(
        and(
          eq(sessions.workspaceId, workspaceId),
          eq(sessions.status, 'active'),
          eq(sessionParticipants.userId, userId),
          isNull(sessionParticipants.leftAt),
        ),
      );
    for (const r of rows) {
      const where = and(
        eq(sessionParticipants.sessionId, r.sessionId),
        eq(sessionParticipants.userId, userId),
      );
      if (!role) {
        await this.db.update(sessionParticipants).set({ leftAt: new Date() }).where(where);
      } else if (r.mode === 'join' && !can(role, 'session.join')) {
        await this.db.update(sessionParticipants).set({ mode: 'watch' }).where(where);
      } else continue;
      await this.expireApprovals(r.sessionId, userId);
      await this.withLock(r.sessionId, () => this.flushLane(r.sessionId, userId));
      if (!role) this.lanes.get(r.sessionId)?.delete(userId);
      await this.announce(r.sessionId);
    }
  }

  async end(sessionId: string, userId: string, input: EndInput): Promise<Session> {
    const row = await this.row(sessionId);
    await authorize(this.db, row.workspaceId, userId, 'session.join');
    if (row.status === 'ended') return this.view(sessionId);
    await this.withLock(sessionId, () => this.flushSession(sessionId));
    await this.db
      .update(sessions)
      .set({
        status: 'ended',
        endedAt: new Date(),
        updatedAt: new Date(),
        finalDiffEnc: input.diff ? this.enc.encrypt(redact(input.diff)) : null,
      })
      .where(eq(sessions.id, sessionId));
    await this.expireApprovals(sessionId, null);
    // The final diff is what stays; the live views were only for while it ran.
    await this.db.delete(sessionChanges).where(eq(sessionChanges.sessionId, sessionId));
    await this.db
      .update(turns)
      .set({ status: 'stopped', endedAt: new Date() })
      .where(and(eq(turns.sessionId, sessionId), eq(turns.status, 'running')));
    this.lanes.delete(sessionId);
    const ended = await this.announce(sessionId);
    this.events.session(sessionId, 'session.finished', { endedBy: await this.nameOf(userId) });
    return ended;
  }

  /**
   * Events from the sender's own lane, or from an AI teammate's lane their machine runs. Only a
   * joined editor may stream into a live session.
   */
  async laneEvents(
    sessionId: string,
    userId: string,
    raw: LaneEvent[],
    touched: string[],
    agentId?: string,
  ): Promise<void> {
    let lane = userId;
    if (agentId) {
      if (!isUuid(sessionId) || !isUuid(agentId)) throw notFound('Session not found');
      const [p] = await this.db
        .select({ hostId: sessionParticipants.hostId, leftAt: sessionParticipants.leftAt })
        .from(sessionParticipants)
        .where(
          and(
            eq(sessionParticipants.sessionId, sessionId),
            eq(sessionParticipants.userId, agentId),
          ),
        );
      if (!p || p.leftAt || p.hostId !== userId)
        throw forbidden('Only the machine running this AI teammate can stream its lane');
      lane = agentId;
    }
    // One batch at a time per lane, so events keep their order.
    return this.withLock(`lane:${sessionId}:${lane}`, () =>
      this.applyLaneEvents(sessionId, lane, raw, touched),
    );
  }

  private async applyLaneEvents(
    sessionId: string,
    userId: string,
    raw: LaneEvent[],
    touched: string[],
  ): Promise<void> {
    const row = await this.row(sessionId);
    const role = await getRole(this.db, row.workspaceId, userId);
    if (!role) throw notFound('Session not found');
    if (!can(role, 'agent.prompt')) throw forbidden();
    if (row.status !== 'active') throw conflict('This session has ended');
    const [me] = await this.db
      .select({ mode: sessionParticipants.mode, harness: sessionParticipants.harness })
      .from(sessionParticipants)
      .where(
        and(
          eq(sessionParticipants.sessionId, sessionId),
          eq(sessionParticipants.userId, userId),
          isNull(sessionParticipants.leftAt),
        ),
      );
    if (me?.mode !== 'join') throw forbidden('Join the session to run an agent in it');

    const events = raw.map((e) => clip(redact(e)) as LaneEvent);
    const lane = this.lane(sessionId, userId);
    // Edits being typed and sync bookkeeping go to everyone watching but aren't part of the
    // stored transcript.
    lane.buffer.push(...events.filter((e) => !UNSTORED.has(e.type)));
    this.out.sendSession(sessionId, { type: 'lane.events', sessionId, userId, events });

    let changed = false;
    let flush = lane.buffer.length >= FLUSH_EVENTS;
    for (const e of events) {
      switch (e.type) {
        case 'turn_start': {
          lane.state = 'running';
          lane.model = typeof e['model'] === 'string' ? e['model'] : lane.model;
          changed = true;
          // A new turn in the lane: whatever it was waiting for is over.
          await this.db
            .update(sessionParticipants)
            .set({ awaitingReason: null })
            .where(
              and(
                eq(sessionParticipants.sessionId, sessionId),
                eq(sessionParticipants.userId, userId),
              ),
            );
          await this.activity(
            row,
            userId,
            'turn_started',
            `${await this.nameOf(userId)} started a turn on ${this.account(row, userId, lane.model, me?.harness ?? null)}`,
            lane.model,
          );
          if (typeof e['turnId'] === 'string')
            await this.db
              .insert(turns)
              .values({ sessionId, sponsorId: userId, turnKey: e['turnId'], model: lane.model })
              .onConflictDoNothing();
          break;
        }
        case 'approval': {
          const request = e['request'] as Record<string, unknown> | undefined;
          if (!request || typeof request['id'] !== 'string') break;
          lane.state = 'waiting';
          changed = true;
          const [created] = await this.db
            .insert(sessionApprovals)
            .values({
              sessionId,
              laneUserId: userId,
              requestId: request['id'].slice(0, 200),
              tool: String(request['tool'] ?? '').slice(0, 100),
              kind: String(request['kind'] ?? 'command').slice(0, 20),
              title: String(request['title'] ?? 'Approve this?').slice(0, 300),
              detailEnc: this.enc.encrypt(String(request['detail'] ?? '')),
            })
            .onConflictDoNothing()
            .returning();
          if (created) {
            this.sendApproval(row.workspaceId, this.toApproval(created));
            this.events.session(sessionId, 'approval.requested', {
              laneUserId: userId,
              lane: await this.nameOf(userId),
              requestId: created.requestId,
              tool: created.tool,
              kind: created.kind,
              title: created.title,
            });
            // An AI teammate called in with @ asks whoever called it, if they may answer.
            const asker =
              typeof e['askerId'] === 'string' && isUuid(e['askerId']) ? e['askerId'] : null;
            const askerRole = asker ? await getRole(this.db, row.workspaceId, asker) : null;
            this.push.emit({
              kind: 'approval',
              sessionId,
              laneUserId: userId,
              requestId: created.requestId,
              title: created.title,
              detail: String(request['detail'] ?? ''),
              askerId: askerRole && can(askerRole, 'approval.answer') ? asker : null,
            });
          }
          break;
        }
        case 'limit_hit': {
          // The person's account ran out (or the agent can't go on): someone else can take over.
          const reason = String(e['reason'] ?? 'usage limit').slice(0, 300);
          this.push.emit({ kind: 'limit', sessionId, laneUserId: userId, reason });
          await this.db
            .update(sessionParticipants)
            .set({ awaitingReason: reason })
            .where(
              and(
                eq(sessionParticipants.sessionId, sessionId),
                eq(sessionParticipants.userId, userId),
              ),
            );
          changed = true;
          await this.activity(
            row,
            userId,
            'limit_hit',
            `${await this.nameOf(userId)}'s agent hit a usage limit`,
            'awaiting takeover',
          );
          break;
        }
        case 'sync':
        case 'snapshot': {
          if (typeof e['sha'] !== 'string' || !/^[0-9a-f]{7,64}$/.test(e['sha'])) break;
          await this.db
            .update(sessionParticipants)
            .set({
              snapshotSha: e['sha'],
              snapshotRef: typeof e['ref'] === 'string' ? e['ref'].slice(0, 300) : null,
              snapshotAt: new Date(),
            })
            .where(
              and(
                eq(sessionParticipants.sessionId, sessionId),
                eq(sessionParticipants.userId, userId),
              ),
            );
          changed = true;
          break;
        }
        case 'paused': {
          // A manual branch switch in the session's checkout, or a sync the remote refused.
          const reason = String(e['reason'] ?? 'paused').slice(0, 300);
          const [before] = await this.db
            .select({ paused: sessionParticipants.paused })
            .from(sessionParticipants)
            .where(
              and(
                eq(sessionParticipants.sessionId, sessionId),
                eq(sessionParticipants.userId, userId),
              ),
            );
          if (before?.paused === reason) break;
          await this.db
            .update(sessionParticipants)
            .set({ paused: reason })
            .where(
              and(
                eq(sessionParticipants.sessionId, sessionId),
                eq(sessionParticipants.userId, userId),
              ),
            );
          changed = true;
          const sync = e['kind'] === 'sync';
          await this.activity(
            row,
            userId,
            sync ? 'sync_paused' : 'paused',
            sync
              ? `${await this.nameOf(userId)}'s sync is paused`
              : `${await this.nameOf(userId)}'s session is paused`,
            reason,
          );
          break;
        }
        case 'resumed': {
          const updated = await this.db
            .update(sessionParticipants)
            .set({ paused: null })
            .where(
              and(
                eq(sessionParticipants.sessionId, sessionId),
                eq(sessionParticipants.userId, userId),
                sql`${sessionParticipants.paused} is not null`,
              ),
            )
            .returning({ userId: sessionParticipants.userId });
          if (updated.length === 0) break;
          changed = true;
          await this.activity(
            row,
            userId,
            'resumed',
            `${await this.nameOf(userId)} resumed syncing`,
          );
          break;
        }
        case 'conflict': {
          if (typeof e['path'] !== 'string') break;
          await this.activity(
            row,
            userId,
            'conflict',
            `2 versions of ${e['path'].slice(0, 200)}`,
            `${await this.nameOf(userId)} and ${typeof e['with'] === 'string' && /^[0-9a-f-]{36}$/i.test(e['with']) ? await this.nameOf(e['with']) : 'a teammate'} changed the same lines · both kept`,
          );
          break;
        }
        case 'outcome_unknown': {
          if (typeof e['toolId'] !== 'string') break;
          const [created] = await this.db
            .insert(outcomes)
            .values({
              sessionId,
              laneUserId: userId,
              toolId: e['toolId'].slice(0, 200),
              command: String(e['command'] ?? '').slice(0, 2000),
              evidenceEnc: this.enc.encrypt(String(e['evidence'] ?? '').slice(0, 20_000)),
            })
            .onConflictDoNothing()
            .returning();
          if (created) {
            this.out.sendRoom(row.workspaceId, sessionId, {
              type: 'outcome',
              workspaceId: row.workspaceId,
              outcome: this.toOutcome(created),
            });
            await this.activity(
              row,
              userId,
              'outcome_unknown',
              `Outcome unknown: ${created.command.slice(0, 80)}`,
              'cut off mid-flight · never retried',
            );
            changed = true;
          }
          break;
        }
        case 'mode': {
          const mode = String(e['mode'] ?? '');
          if (!['plan', 'request', 'allow', 'full'].includes(mode)) break;
          await this.activity(
            row,
            userId,
            'mode_changed',
            `${await this.nameOf(userId)} switched their agent to ${mode[0]!.toUpperCase()}${mode.slice(1)} permissions`,
            mode === 'full' ? 'no approvals · everyone is warned' : null,
          );
          break;
        }
        case 'steer': {
          if (e['status'] !== 'delivered') break;
          const from = typeof e['fromUserId'] === 'string' ? e['fromUserId'] : userId;
          await this.activity(
            row,
            from,
            'steer',
            from === userId
              ? `${await this.nameOf(userId)} steered their agent`
              : `${await this.nameOf(from)} steered ${await this.nameOf(userId)}'s agent`,
            String(e['text'] ?? '').slice(0, 140),
          );
          break;
        }
        case 'approval_resolved': {
          // The owner's machine settled it (answered there, or the turn was stopped).
          lane.state = 'running';
          changed = true;
          if (typeof e['id'] === 'string')
            await this.settle(
              row.workspaceId,
              sessionId,
              userId,
              e['id'],
              e['approved'] === true,
              userId,
            );
          break;
        }
        case 'turn_end': {
          lane.state = 'idle';
          changed = true;
          flush = true;
          const reason = String(e['reason'] ?? 'done');
          this.push.emit({ kind: 'finished', sessionId, laneUserId: userId, reason });
          if (reason === 'error' || reason === 'step_limit')
            this.events.session(sessionId, 'session.failed', {
              laneUserId: userId,
              lane: await this.nameOf(userId),
              reason,
              error: typeof e['error'] === 'string' ? redactText(e['error']).slice(0, 300) : null,
            });
          if (reason === 'stopped' || reason === 'error')
            await this.activity(
              row,
              userId,
              'turn_interrupted',
              e['checkpoint'] === true
                ? `${await this.nameOf(userId)}'s turn stopped at a safe checkpoint`
                : `${await this.nameOf(userId)}'s turn was ${reason === 'stopped' ? 'stopped' : 'interrupted'}`,
              typeof e['error'] === 'string' ? e['error'].slice(0, 200) : null,
            );
          if (typeof e['turnId'] === 'string')
            await this.db
              .update(turns)
              .set({
                status: (['done', 'stopped', 'error', 'step_limit'].includes(reason)
                  ? reason
                  : 'done') as 'done',
                cost: typeof e['cost'] === 'number' ? e['cost'] : 0,
                endedAt: new Date(),
              })
              .where(
                and(
                  eq(turns.sessionId, sessionId),
                  eq(turns.sponsorId, userId),
                  eq(turns.turnKey, e['turnId']),
                ),
              );
          await this.expireApprovals(sessionId, userId);
          break;
        }
      }
    }

    if (touched.length) {
      const merged = [...new Set([...touched.slice().reverse(), ...row.touchedFiles])].slice(
        0,
        MAX_TOUCHED,
      );
      if (merged.join('\n') !== row.touchedFiles.join('\n')) {
        await this.db
          .update(sessions)
          .set({ touchedFiles: merged })
          .where(eq(sessions.id, sessionId));
        changed = true;
      }
    }
    // Stored before it's announced, so whoever reacts to the announcement finds it.
    if (flush) await this.withLock(sessionId, () => this.flushLane(sessionId, userId));
    if (changed) {
      await this.db
        .update(sessions)
        .set({ updatedAt: new Date() })
        .where(eq(sessions.id, sessionId));
      await this.announce(sessionId);
    }
  }

  private sendApproval(workspaceId: string, approval: SessionApproval): void {
    this.out.sendRoom(
      workspaceId,
      approval.sessionId,
      { type: 'approval', approval },
      approval.laneUserId,
    );
  }

  /** Marks a pending approval answered; false when someone else got there first. */
  private async settle(
    workspaceId: string,
    sessionId: string,
    laneUserId: string,
    requestId: string,
    approved: boolean,
    by: string,
  ): Promise<SessionApproval | null> {
    const [row] = await this.db
      .update(sessionApprovals)
      .set({ status: approved ? 'approved' : 'denied', answeredBy: by, answeredAt: new Date() })
      .where(
        and(
          eq(sessionApprovals.sessionId, sessionId),
          eq(sessionApprovals.laneUserId, laneUserId),
          eq(sessionApprovals.requestId, requestId),
          eq(sessionApprovals.status, 'pending'),
        ),
      )
      .returning();
    if (!row) return null;
    const approval = { ...this.toApproval(row), answeredByName: await this.nameOf(by) };
    this.sendApproval(workspaceId, approval);
    return approval;
  }

  /**
   * The lane's own person (or whoever runs that AI teammate) answers; so do the workspace's
   * owners, and every editor when the workspace allows it. The first valid answer wins, and goes
   * to the lane owner's machine, which runs (or skips) the action.
   */
  async answer(
    sessionId: string,
    userId: string,
    laneUserId: string,
    requestId: string,
    approved: boolean,
  ): Promise<SessionApproval> {
    const row = await this.row(sessionId);
    const [lane] = await this.db
      .select({ hostId: sessionParticipants.hostId })
      .from(sessionParticipants)
      .where(
        and(
          eq(sessionParticipants.sessionId, sessionId),
          eq(sessionParticipants.userId, laneUserId),
        ),
      );
    await authorizeLane(this.db, row.workspaceId, userId, 'approval.answer', {
      userId: laneUserId,
      hostId: lane?.hostId ?? null,
    });
    if (row.status !== 'active') throw conflict('This session has ended');
    const settled = await this.settle(
      row.workspaceId,
      sessionId,
      laneUserId,
      requestId,
      approved,
      userId,
    );
    if (!settled) throw conflict('Someone already answered this');
    // Who let an agent do something (or didn't) is part of the session's story.
    const whose =
      userId === laneUserId ? 'their own agent' : `${await this.nameOf(laneUserId)}'s agent`;
    await this.activity(
      row,
      userId,
      'approval_answered',
      `${await this.nameOf(userId)} ${approved ? 'approved' : 'denied'} ${whose}: ${settled.title}`,
      settled.detail ? redactText(settled.detail.split('\n')[0]!.slice(0, 200)) : null,
    );
    await this.announce(sessionId);
    return settled;
  }

  private async expireApprovals(sessionId: string, laneUserId: string | null): Promise<void> {
    const expired = await this.db
      .update(sessionApprovals)
      .set({ status: 'expired' })
      .where(
        and(
          eq(sessionApprovals.sessionId, sessionId),
          eq(sessionApprovals.status, 'pending'),
          ...(laneUserId ? [eq(sessionApprovals.laneUserId, laneUserId)] : []),
        ),
      )
      .returning();
    if (expired.length === 0) return;
    const [s] = await this.db
      .select({ w: sessions.workspaceId })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    for (const a of expired) this.sendApproval(s!.w, this.toApproval(a));
  }

  // ---------- activity ----------

  private readonly names = new Map<string, string>();

  async nameOf(userId: string): Promise<string> {
    const known = this.names.get(userId);
    if (known) return known;
    const [u] = await this.db.select({ name: users.name }).from(users).where(eq(users.id, userId));
    const name = u?.name ?? 'Someone';
    this.names.set(userId, name);
    return name;
  }

  /** Whose account a turn runs on, in words: "his OpenAI subscription", "their OpenRouter key". */
  private account(
    _row: SessionRow,
    _userId: string,
    model: string | null,
    harness: string | null,
  ): string {
    if (harness === 'claude-code' || model?.startsWith('claude-code'))
      return 'their Claude subscription';
    if (harness === 'codex' || model?.startsWith('codex')) return 'their OpenAI subscription';
    if (model?.startsWith('@')) return `their ${model.split('/')[0]} provider`;
    return 'their OpenRouter key';
  }

  toOutcome(row: typeof outcomes.$inferSelect): Outcome {
    return {
      id: row.id,
      sessionId: row.sessionId,
      laneUserId: row.laneUserId,
      toolId: row.toolId,
      command: row.command,
      evidence: this.decryptOr(row.evidenceEnc, '(unreadable: the encryption key changed)'),
      status: row.status,
      recordedBy: row.recordedBy,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** Adds a line to the session's activity feed and tells everyone watching. */
  async activity(
    row: SessionRow,
    actorId: string | null,
    kind: ActivityKind,
    text: string,
    detail: string | null = null,
  ): Promise<Activity> {
    const [created] = await this.db
      .insert(activities)
      .values({ workspaceId: row.workspaceId, sessionId: row.id, actorId, kind, text, detail })
      .returning();
    await this.journal(row, {
      kind: `activity.${kind}`,
      actorId,
      summary: text,
      ...(detail ? { data: { detail } } : {}),
    });
    const activity: Activity = {
      id: created!.id,
      sessionId: row.id,
      actorId,
      actorName: actorId ? await this.nameOf(actorId) : null,
      kind,
      text,
      detail,
      createdAt: created!.createdAt.toISOString(),
    };
    this.out.sendRoom(row.workspaceId, row.id, {
      type: 'activity',
      workspaceId: row.workspaceId,
      activity,
    });
    return activity;
  }

  async listActivity(sessionId: string, userId: string): Promise<Activity[]> {
    await this.visible(sessionId, userId);
    const rows = await this.db
      .select({ a: activities, name: users.name })
      .from(activities)
      .leftJoin(users, eq(users.id, activities.actorId))
      .where(eq(activities.sessionId, sessionId))
      .orderBy(desc(activities.createdAt))
      .limit(200);
    return rows.map(({ a, name }) => ({
      id: a.id,
      sessionId: a.sessionId,
      actorId: a.actorId,
      actorName: name,
      kind: a.kind as ActivityKind,
      text: a.text,
      detail: a.detail,
      createdAt: a.createdAt.toISOString(),
    }));
  }

  // ---------- the journal ----------

  /**
   * Records something that happened to the session's agent work, in order. Secrets are masked
   * before anything is written; details are encrypted like transcripts.
   */
  async journal(
    session: { id: string; workspaceId: string },
    entry: {
      kind: string;
      actorId?: string | null;
      stepId?: string | null;
      swarmId?: string | null;
      subagentId?: string | null;
      summary: string;
      data?: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.db.insert(journalEvents).values({
      workspaceId: session.workspaceId,
      sessionId: session.id,
      kind: entry.kind,
      actorId: entry.actorId ?? null,
      stepId: entry.stepId ?? null,
      swarmId: entry.swarmId ?? null,
      subagentId: entry.subagentId ?? null,
      summary: redactText(entry.summary).slice(0, 500),
      dataEnc: entry.data ? this.enc.encrypt(JSON.stringify(redact(entry.data))) : null,
    });
  }

  /**
   * The session's story for replay: the Brain's journal and what the agents did in their lanes
   * (model choices, tools, approvals, costs, turn ends), merged by time. Nothing runs again.
   */
  async replay(sessionId: string, userId: string): Promise<ReplayEvent[]> {
    const row = await this.row(sessionId);
    await authorize(this.db, row.workspaceId, userId, 'transcript.view');
    const names = new Map<string, string>();
    const nameOf = async (id: string | null) => {
      if (!id) return null;
      if (!names.has(id)) names.set(id, await this.nameOf(id));
      return names.get(id)!;
    };
    const events: ReplayEvent[] = [];
    const journal = await this.db
      .select()
      .from(journalEvents)
      .where(eq(journalEvents.sessionId, sessionId))
      .orderBy(asc(journalEvents.seq))
      .limit(5000);
    for (const j of journal) {
      let data: Record<string, unknown> | null = null;
      if (j.dataEnc)
        try {
          data = JSON.parse(this.enc.decrypt(j.dataEnc)) as Record<string, unknown>;
        } catch {
          data = { unreadable: true };
        }
      events.push({
        source: 'journal',
        seq: j.seq,
        at: j.createdAt.toISOString(),
        kind: j.kind,
        actorName: await nameOf(j.actorId),
        laneName: null,
        summary: j.summary,
        detail: typeof data?.['detail'] === 'string' ? data['detail'] : null,
        refs: {
          ...(j.stepId ? { stepId: j.stepId } : {}),
          ...(j.swarmId ? { swarmId: j.swarmId } : {}),
          ...(j.subagentId ? { subagentId: j.subagentId } : {}),
        },
        data,
      });
    }
    const chunks = await this.db
      .select({
        userId: transcriptChunks.userId,
        dataEnc: transcriptChunks.dataEnc,
        createdAt: transcriptChunks.createdAt,
      })
      .from(transcriptChunks)
      .where(eq(transcriptChunks.sessionId, sessionId))
      .orderBy(asc(transcriptChunks.createdAt), asc(transcriptChunks.seq));
    // Tool calls someone declined: their end isn't a failure.
    const denied = new Set<string>();
    for (const c of chunks) {
      let lane: LaneEvent[];
      try {
        lane = JSON.parse(this.enc.decrypt(c.dataEnc)) as LaneEvent[];
      } catch {
        continue;
      }
      const laneName = await nameOf(c.userId);
      for (const e of lane) {
        const line = laneLine(e, denied);
        if (line)
          events.push({
            source: 'lane',
            seq: null,
            at: c.createdAt.toISOString(),
            actorName: laneName,
            laneName,
            ...line,
          });
      }
    }
    // By time; the journal's own order breaks ties, and lane events keep theirs (stable sort).
    return events.sort(
      (a, b) => a.at.localeCompare(b.at) || (a.seq ?? Infinity) - (b.seq ?? Infinity),
    );
  }

  // ---------- storage ----------

  /** Writes a lane's buffered events as one encrypted chunk. Call inside the session lock. */
  private async flushLane(sessionId: string, userId: string): Promise<void> {
    const lane = this.lanes.get(sessionId)?.get(userId);
    if (!lane || lane.buffer.length === 0) return;
    if (lane.nextSeq === null) {
      const [last] = await this.db
        .select({ seq: sql<number | null>`max(${transcriptChunks.seq})` })
        .from(transcriptChunks)
        .where(and(eq(transcriptChunks.sessionId, sessionId), eq(transcriptChunks.userId, userId)));
      lane.nextSeq = (last?.seq ?? -1) + 1;
    }
    const events = lane.buffer.slice();
    await this.db.insert(transcriptChunks).values({
      sessionId,
      userId,
      seq: lane.nextSeq,
      dataEnc: this.enc.encrypt(JSON.stringify(compactLaneEvents(events))),
    });
    lane.nextSeq += 1;
    lane.buffer.splice(0, events.length);
  }

  private async flushSession(sessionId: string): Promise<void> {
    for (const userId of this.lanes.get(sessionId)?.keys() ?? [])
      await this.flushLane(sessionId, userId);
  }

  async flushAll(): Promise<void> {
    for (const sessionId of [...this.lanes.keys()]) {
      const lanes = this.lanes.get(sessionId);
      if ([...(lanes?.values() ?? [])].some((l) => l.buffer.length))
        await this.withLock(sessionId, () => this.flushSession(sessionId));
    }
  }

  /** Deletes transcript chunks older than each org's retention (90 days unless set). */
  async sweepRetention(): Promise<number> {
    const result = await this.db.execute(sql`
      delete from transcript_chunks tc
      using sessions s, workspaces w, orgs o
      where tc.session_id = s.id and s.workspace_id = w.id and w.org_id = o.id
        and tc.created_at < now() - make_interval(days => o.transcript_retention_days)
    `);
    // The journal tells the same story: it is kept exactly as long.
    const journal = await this.db.execute(sql`
      delete from journal_events je
      using workspaces w, orgs o
      where je.workspace_id = w.id and w.org_id = o.id
        and je.created_at < now() - make_interval(days => o.transcript_retention_days)
    `);
    // An ended session's final diff is code too: it goes when its transcripts would.
    const diffs = await this.db.execute(sql`
      update sessions s set final_diff_enc = null
      from workspaces w, orgs o
      where s.workspace_id = w.id and w.org_id = o.id
        and s.final_diff_enc is not null and s.ended_at is not null
        and s.ended_at < now() - make_interval(days => o.transcript_retention_days)
    `);
    return (
      ((result as unknown as { count?: number }).count ?? 0) +
      ((journal as unknown as { count?: number }).count ?? 0) +
      ((diffs as unknown as { count?: number }).count ?? 0)
    );
  }
}

/** What a lane event adds to a replay, or null for the noise (text deltas, progress). */
function laneLine(
  e: LaneEvent,
  denied: Set<string>,
): Pick<ReplayEvent, 'kind' | 'summary' | 'detail' | 'refs' | 'data'> | null {
  const ev = e as unknown as Record<string, unknown> & { type: string };
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (ev.type) {
    case 'user':
      return {
        kind: 'lane.prompt',
        summary: str(ev['text']).slice(0, 300),
        detail: null,
        refs: {},
        data: null,
      };
    case 'turn_start':
      return {
        kind: 'lane.turn_start',
        summary: `Turn started on ${str(ev['model'])}`,
        detail: null,
        refs: {},
        data: { model: ev['model'] },
      };
    case 'route': {
      const d = (ev['decision'] ?? {}) as Record<string, unknown>;
      return {
        kind: 'lane.route',
        summary: `JevRouter → ${str(d['model'])} (${str(d['tier'])})`,
        detail: str(d['reason']) || null,
        refs: {},
        data: { model: d['model'], tier: d['tier'] },
      };
    }
    case 'tool_start':
      return {
        kind: 'lane.tool',
        summary: str(ev['summary']) || str(ev['name']),
        detail: null,
        refs: { toolId: str(ev['id']) },
        data: { name: ev['name'] },
      };
    case 'tool_end':
      // Done, or declined (the "Denied" line already says so).
      return ev['ok'] || denied.has(str(ev['id']))
        ? null
        : {
            kind: 'lane.tool_failed',
            summary: 'A tool call failed',
            detail: str(ev['output']).slice(0, 500) || null,
            refs: { toolId: str(ev['id']) },
            data: null,
          };
    case 'approval': {
      const r = (ev['request'] ?? {}) as Record<string, unknown>;
      return {
        kind: 'lane.approval',
        summary: `Asked: ${str(r['title'])}`,
        detail: str(r['detail']).slice(0, 500) || null,
        refs: { toolId: str(r['id']) },
        data: null,
      };
    }
    case 'approval_resolved':
      if (!ev['approved']) denied.add(str(ev['id']));
      return {
        kind: 'lane.approval_resolved',
        summary: ev['approved'] ? 'Approved' : 'Denied',
        detail: null,
        refs: { toolId: str(ev['id']) },
        data: { approved: ev['approved'] },
      };
    case 'turn_end':
      return {
        kind: 'lane.turn_end',
        summary: `Turn ${str(ev['reason'])}${typeof ev['cost'] === 'number' && ev['cost'] > 0 ? ` · $${(ev['cost'] as number).toFixed(4)}` : ''}`,
        detail: str(ev['error']).slice(0, 500) || null,
        refs: {},
        data: { reason: ev['reason'], cost: ev['cost'] },
      };
    default:
      return null;
  }
}
