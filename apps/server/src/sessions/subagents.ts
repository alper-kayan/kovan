import {
  can,
  canMoveSubagent,
  type SessionPr,
  type Subagent,
  type SubagentStatus,
  type StartSubagentSchema,
  type UpdateSubagentSchema,
} from '@kovan/shared';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { authorize, getRole } from '../authz.js';
import type { Db } from '../db/client.js';
import { sessionParticipants, sessions, subagents } from '../db/schema.js';
import { conflict, forbidden, notFound, tooMany } from '../errors.js';
import type { FlowBroadcast } from './flow.js';
import type { SessionService } from './service.js';

type SubagentRow = typeof subagents.$inferSelect;

const DONE: SubagentStatus[] = ['integrated', 'cancelled', 'answered'];
/** Subagents one lane may have working at once (a swarm runs at most 6 side by side). */
export const MAX_ACTIVE = 8;

/**
 * Subagents (child tasks beside a lane, each in its own worktree on the parent's machine) and the
 * session's pull request. The Brain keeps their progress for the rail and makes sure a child's
 * work is integrated into its parent exactly once.
 */
export class SubagentService {
  constructor(
    private readonly db: Db,
    private readonly out: FlowBroadcast,
    private readonly sessions: SessionService,
  ) {}

  private async toSubagent(row: SubagentRow): Promise<Subagent> {
    return {
      id: row.id,
      sessionId: row.sessionId,
      parentUserId: row.parentUserId,
      parentName: await this.sessions.nameOf(row.parentUserId),
      task: row.task,
      status: row.status,
      added: row.added,
      removed: row.removed,
      checksPassed: row.checksPassed,
      checksTotal: row.checksTotal,
      rev: row.rev,
      baseSha: row.baseSha,
      detail: row.detail,
      checks: row.checks,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      integratedAt: row.integratedAt?.toISOString() ?? null,
    };
  }

  private async send(workspaceId: string, row: SubagentRow): Promise<Subagent> {
    const subagent = await this.toSubagent(row);
    this.out.sendRoom(workspaceId, row.sessionId, { type: 'subagent', workspaceId, subagent });
    return subagent;
  }

  private async own(
    id: string,
    userId: string,
  ): Promise<{ row: SubagentRow; workspaceId: string }> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Subagent not found');
    const [found] = await this.db
      .select({ s: subagents, workspaceId: sessions.workspaceId })
      .from(subagents)
      .innerJoin(sessions, eq(sessions.id, subagents.sessionId))
      .where(eq(subagents.id, id));
    if (!found) throw notFound('Subagent not found');
    await authorize(this.db, found.workspaceId, userId, 'session.view');
    // Only the machine running it reports on it.
    if (found.s.parentUserId !== userId) throw forbidden('Only its parent lane can update it');
    return { row: found.s, workspaceId: found.workspaceId };
  }

  async list(sessionId: string, userId: string): Promise<Subagent[]> {
    await this.sessions.visible(sessionId, userId);
    const rows = await this.db
      .select()
      .from(subagents)
      .where(eq(subagents.sessionId, sessionId))
      .orderBy(asc(subagents.createdAt));
    return Promise.all(rows.map((r) => this.toSubagent(r)));
  }

  async start(
    sessionId: string,
    userId: string,
    input: z.infer<typeof StartSubagentSchema>,
  ): Promise<{ subagent: Subagent; existing: boolean }> {
    const row = await this.sessions.row(sessionId);
    const role = await getRole(this.db, row.workspaceId, userId);
    if (!role) throw notFound('Session not found');
    if (!can(role, 'agent.prompt')) throw forbidden();
    if (row.status !== 'active') throw conflict('This session has ended');
    const [me] = await this.db
      .select({ mode: sessionParticipants.mode })
      .from(sessionParticipants)
      .where(
        and(eq(sessionParticipants.sessionId, sessionId), eq(sessionParticipants.userId, userId)),
      );
    // A machine running the session's AI teammates (a swarm sent to it) starts their tasks
    // without a lane of its own.
    const [hosting] =
      me?.mode === 'join'
        ? [true]
        : await this.db
            .select({ id: sessionParticipants.userId })
            .from(sessionParticipants)
            .where(
              and(
                eq(sessionParticipants.sessionId, sessionId),
                eq(sessionParticipants.hostId, userId),
                isNull(sessionParticipants.leftAt),
              ),
            );
    if (!hosting) throw forbidden('Join the session with your agent first');
    // A repeated request (a retry, a second window, a resumed swarm) gets the one it started.
    const earlier = async () => {
      if (!input.requestKey) return null;
      const [found] = await this.db
        .select()
        .from(subagents)
        .where(and(eq(subagents.parentUserId, userId), eq(subagents.requestKey, input.requestKey)));
      return found ? { subagent: await this.toSubagent(found), existing: true } : null;
    };
    const repeated = await earlier();
    if (repeated) return repeated;
    // However a machine schedules its work, one lane runs only so many subagents at once.
    const [active] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(subagents)
      .where(
        and(
          eq(subagents.sessionId, sessionId),
          eq(subagents.parentUserId, userId),
          inArray(subagents.status, ['running', 'checking', 'passed']),
        ),
      );
    if ((active?.n ?? 0) >= MAX_ACTIVE)
      throw tooMany(`A lane runs at most ${MAX_ACTIVE} subagents at once; wait for one to finish`);
    const [created] = await this.db
      .insert(subagents)
      .values({
        sessionId,
        parentUserId: userId,
        task: input.task,
        baseSha: input.baseSha,
        requestKey: input.requestKey ?? null,
      })
      .onConflictDoNothing()
      .returning();
    // Two identical requests at once: the other one inserted it.
    if (!created) return (await earlier())!;
    await this.sessions.activity(
      row,
      userId,
      'subagent_started',
      `${await this.sessions.nameOf(userId)} started a subagent`,
      input.task.slice(0, 140),
    );
    await this.sessions.announce(sessionId);
    return { subagent: await this.send(row.workspaceId, created), existing: false };
  }

  async update(
    id: string,
    userId: string,
    patch: z.infer<typeof UpdateSubagentSchema>,
  ): Promise<Subagent> {
    const { row, workspaceId } = await this.own(id, userId);
    if (DONE.includes(row.status)) throw conflict(`This subagent is ${row.status} already`);
    if (patch.status && !canMoveSubagent(row.status, patch.status))
      throw conflict(`A subagent can't go from ${row.status} to ${patch.status}`);
    const [updated] = await this.db
      .update(subagents)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(subagents.id, id))
      .returning();
    if (patch.status && patch.status !== row.status) {
      const session = await this.sessions.row(row.sessionId);
      const checks = patch.checks ?? updated!.checks;
      await this.sessions.journal(session, {
        kind: 'subagent.status',
        actorId: userId,
        subagentId: id,
        summary: `${row.task.slice(0, 120)}: ${row.status} → ${patch.status}`,
        data: {
          from: row.status,
          to: patch.status,
          ...(patch.detail ? { detail: patch.detail } : {}),
          checks: checks.map((c) => ({ name: c.name, status: c.status, detail: c.detail })),
        },
      });
      if (patch.status === 'failed' || patch.status === 'conflict')
        await this.sessions.activity(
          session,
          userId,
          'subagent_failed',
          patch.status === 'conflict'
            ? "A subagent's work conflicts with its parent · kept for review"
            : "A subagent didn't pass its checks · kept for review",
          (patch.detail ?? row.detail ?? row.task).slice(0, 200),
        );
      await this.sessions.announce(row.sessionId);
    }
    return this.send(workspaceId, updated!);
  }

  /**
   * Claims the one integration of a child that passed its checks. Exactly one call wins; the
   * machine that wins applies the work to the parent, any other gets a conflict.
   */
  async integrate(id: string, userId: string): Promise<Subagent> {
    const { row, workspaceId } = await this.own(id, userId);
    const [claimed] = await this.db
      .update(subagents)
      .set({ status: 'integrated', integratedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(subagents.id, id), eq(subagents.status, 'passed')))
      .returning();
    if (!claimed)
      throw conflict(
        row.status === 'integrated'
          ? 'This subagent was integrated already'
          : 'Only a subagent that passed its checks can be integrated',
      );
    const session = await this.sessions.row(row.sessionId);
    await this.sessions.activity(
      session,
      userId,
      'subagent_integrated',
      `A subagent's work joined ${await this.sessions.nameOf(userId)}'s lane`,
      `+${claimed.added} −${claimed.removed} · ${claimed.checksPassed}/${claimed.checksTotal} checks · ${row.task.slice(0, 100)}`,
    );
    await this.sessions.announce(row.sessionId);
    return this.send(workspaceId, claimed);
  }

  /** Records the session's pull request; a merged one completes the session. */
  async setPr(
    sessionId: string,
    userId: string,
    pr: SessionPr,
    diff: string | null,
  ): Promise<void> {
    const row = await this.sessions.row(sessionId);
    await authorize(this.db, row.workspaceId, userId, 'session.join');
    if (row.prState === pr.state && row.prUrl === pr.url) return;
    await this.db
      .update(sessions)
      .set({ prUrl: pr.url, prNumber: pr.number, prState: pr.state, updatedAt: new Date() })
      .where(eq(sessions.id, sessionId));
    const name = await this.sessions.nameOf(userId);
    if (pr.state === 'open' && row.prUrl !== pr.url)
      this.sessions.events.session(sessionId, 'pr.opened', { number: pr.number, by: name });
    if (pr.state === 'merged' && row.prState !== 'merged')
      this.sessions.events.session(sessionId, 'pr.merged', { number: pr.number });
    if (pr.state === 'open' && row.prUrl !== pr.url)
      await this.sessions.activity(
        row,
        userId,
        'pr_opened',
        `${name} opened PR #${pr.number}`,
        pr.url,
      );
    if (pr.state === 'merged') {
      await this.sessions.activity(
        row,
        userId,
        'merged',
        `PR #${pr.number} was merged`,
        'the session is complete',
      );
      if (row.status === 'active') {
        await this.sessions.end(sessionId, userId, { diff });
        return;
      }
    }
    await this.sessions.announce(sessionId);
  }
}
