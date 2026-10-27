import {
  canMoveTask,
  graphProblem,
  type ActivityKind,
  type TaskState,
  can,
  type AddStepsSchema,
  type Comment,
  type CommentAnchor,
  type CreateCommentSchema,
  type CreateMemorySchema,
  type Memory,
  type Plan,
  type PlanStep,
  type ServerMessage,
  type StepOffer,
  type UpdateCommentSchema,
  type UpdateMemorySchema,
  type UpdateStepSchema,
} from '@kovan/shared';
import { NO_PUSH, type PushSink } from '../push/service.js';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { authorize, getRole } from '../authz.js';
import type { Db } from '../db/client.js';
import { comments, memories, planSteps, stepOffers, users } from '../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { redactText } from '../sessions/redact.js';
import type { SessionService } from '../sessions/service.js';
import { memberKind } from '../users.js';

type StepRow = typeof planSteps.$inferSelect;
type CommentRow = typeof comments.$inferSelect;
type MemoryRow = typeof memories.$inferSelect;

export interface CollabBroadcast {
  sendWorkspace(workspaceId: string, message: ServerMessage): void;
  sendRoom(workspaceId: string, sessionId: string, message: ServerMessage): void;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
/** Run states worth a line in the session's activity, and how the line ends. */
const RUN_ENDS: Partial<Record<TaskState, string>> = {
  done: 'is done',
  failed: 'failed',
  blocked: 'is blocked',
  cancelled: 'was stopped',
  waiting_for_approval: 'waits for approval',
};

const isUuid = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

const toStep = (r: StepRow): PlanStep => ({
  id: r.id,
  sessionId: r.sessionId,
  position: r.position,
  title: r.title,
  detail: r.detail,
  ownerId: r.ownerId,
  status: r.status,
  files: r.files,
  createdBy: r.createdBy,
  fromCommentId: r.fromCommentId,
  acceptance: r.acceptance,
  dependsOn: r.dependsOn,
  runState: r.runState,
  runDetail: r.runDetail,
  approval: r.approval,
  approvalReason: r.approvalReason,
  approvedBy: r.approvedBy,
  spent: r.spent,
  updatedAt: r.updatedAt.toISOString(),
});

const toOffer = (r: typeof stepOffers.$inferSelect): StepOffer => ({
  id: r.id,
  stepId: r.stepId,
  sessionId: r.sessionId,
  fromUserId: r.fromUserId,
  toUserId: r.toUserId,
  status: r.status,
  createdAt: r.createdAt.toISOString(),
});

const toMemory = (r: MemoryRow, authorName: string | null): Memory => ({
  id: r.id,
  workspaceId: r.workspaceId,
  kind: r.kind,
  text: r.text,
  path: r.path,
  startLine: r.startLine,
  endLine: r.endLine,
  snippet: r.snippet,
  commit: r.commit,
  status: r.status,
  flagReason: r.flagReason,
  authorId: r.authorId,
  authorName,
  byAgent: r.byAgent,
  verified: r.verified,
  sessionId: r.sessionId,
  replacesId: r.replacesId,
  rationale: r.rationale,
  consequences: r.consequences,
  affects: r.affects,
  conflictsWith: r.conflictsWith,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

/**
 * The team's shared work beyond the live stream: the session plan and who owns each step,
 * comments pinned to sessions and code, and the Brain (notes every agent reads).
 */
export class CollabService {
  push: PushSink = NO_PUSH;

  constructor(
    private readonly db: Db,
    private readonly out: CollabBroadcast,
    private readonly sessions: SessionService,
  ) {}

  // ---------- plan ----------

  private async loadPlan(sessionId: string): Promise<Plan> {
    const steps = await this.db
      .select()
      .from(planSteps)
      .where(eq(planSteps.sessionId, sessionId))
      .orderBy(asc(planSteps.position), asc(planSteps.createdAt));
    const offers = await this.db
      .select()
      .from(stepOffers)
      .where(and(eq(stepOffers.sessionId, sessionId), eq(stepOffers.status, 'pending')));
    return { sessionId, steps: steps.map(toStep), offers: offers.map(toOffer) };
  }

  async plan(sessionId: string, userId: string): Promise<Plan> {
    const session = await this.sessions.row(sessionId);
    await authorize(this.db, session.workspaceId, userId, 'plan.view');
    return this.loadPlan(sessionId);
  }

  /** Sends the session's plan to everyone in it (and the card's progress). */
  async changed(sessionId: string): Promise<Plan> {
    const session = await this.sessions.row(sessionId);
    const plan = await this.loadPlan(sessionId);
    this.out.sendRoom(session.workspaceId, sessionId, {
      type: 'plan',
      workspaceId: session.workspaceId,
      plan,
    });
    await this.sessions.announce(sessionId); // the card's progress
    return plan;
  }

  private async step(stepId: string): Promise<{ step: StepRow; workspaceId: string }> {
    if (!isUuid(stepId)) throw notFound('Step not found');
    const [step] = await this.db.select().from(planSteps).where(eq(planSteps.id, stepId));
    if (!step) throw notFound('Step not found');
    const session = await this.sessions.row(step.sessionId);
    return { step, workspaceId: session.workspaceId };
  }

  private async assertMember(workspaceId: string, userId: string): Promise<void> {
    if (!isUuid(userId) || !(await getRole(this.db, workspaceId, userId)))
      throw badRequest('That person is not in this workspace');
  }

  async addSteps(
    sessionId: string,
    userId: string,
    input: z.infer<typeof AddStepsSchema>,
  ): Promise<Plan> {
    const session = await this.sessions.row(sessionId);
    await authorize(this.db, session.workspaceId, userId, 'plan.manage');
    if (session.status !== 'active') throw conflict('This session has ended');
    for (const s of input.steps)
      if (s.ownerId) await this.assertMember(session.workspaceId, s.ownerId);
    const problem = graphProblem(
      input.steps.map((s, i) => ({ key: String(i), dependsOn: s.after.map(String) })),
    );
    if (problem) throw badRequest(problem);
    const [last] = await this.db
      .select({ max: sql<number | null>`max(${planSteps.position})` })
      .from(planSteps)
      .where(eq(planSteps.sessionId, sessionId));
    const start = (last?.max ?? -1) + 1;
    const created = await this.db
      .insert(planSteps)
      .values(
        input.steps.map((s, i) => ({
          sessionId,
          position: start + i,
          title: s.title,
          detail: s.detail,
          files: s.files,
          ownerId: s.ownerId,
          acceptance: s.acceptance,
          approval: s.approvalReason ? ('pending' as const) : null,
          approvalReason: s.approvalReason,
          createdBy: userId,
          fromCommentId: input.fromCommentId,
        })),
      )
      .returning();
    for (const step of created)
      if (step.approval === 'pending')
        this.push.emit({
          kind: 'task',
          sessionId,
          stepId: step.id,
          title: step.title,
          reason: step.approvalReason,
        });
    // Dependencies name steps of this request by index; they get their ids once inserted.
    for (const [i, s] of input.steps.entries()) {
      if (s.after.length === 0) continue;
      const [linked] = await this.db
        .update(planSteps)
        .set({ dependsOn: s.after.map((at) => created[at]!.id) })
        .where(eq(planSteps.id, created[i]!.id))
        .returning();
      created[i] = linked!;
    }
    await this.sessions.journal(session, {
      kind: 'plan.steps_added',
      actorId: userId,
      summary: `Plan: ${created.length} step${created.length === 1 ? '' : 's'} added`,
      data: {
        steps: created.map((c) => ({
          id: c.id,
          title: c.title,
          ownerId: c.ownerId,
          dependsOn: c.dependsOn,
          acceptance: c.acceptance,
          approval: c.approval,
        })),
      },
    });
    if (input.fromCommentId && created[0]) {
      const [comment] = await this.db
        .update(comments)
        .set({ stepId: created[0].id })
        .where(
          and(eq(comments.id, input.fromCommentId), eq(comments.workspaceId, session.workspaceId)),
        )
        .returning();
      if (comment) await this.sendComment(comment);
    }
    return this.changed(sessionId);
  }

  async updateStep(
    stepId: string,
    userId: string,
    patch: z.infer<typeof UpdateStepSchema>,
  ): Promise<Plan> {
    const { step, workspaceId } = await this.step(stepId);
    const role = await getRole(this.db, workspaceId, userId);
    if (!role) throw notFound('Step not found');
    const editing =
      patch.title !== undefined || patch.detail !== undefined || patch.position !== undefined;
    // Owners move their own step along (no agent needed); editors manage the whole plan.
    const isOwner = step.ownerId === userId;
    const canManage = can(role, 'plan.manage');
    if (editing && !canManage) throw forbidden();
    if (patch.status && !canManage && !(isOwner && can(role, 'work.markDone'))) throw forbidden();
    // A swarm's run of the step: whoever manages the plan (the machine running the swarm) moves
    // it, one allowed step at a time, and the session's activity records where it ended up.
    if ((patch.runState !== undefined || patch.runDetail !== undefined) && !canManage)
      throw forbidden();
    if (patch.runState && !canMoveTask(step.runState, patch.runState))
      throw conflict(`A task can't go from ${step.runState} to ${patch.runState}`);
    // A step that needs a yes doesn't start without one, whatever the machine running it says.
    if (patch.runState === 'running' && step.approval && step.approval !== 'approved')
      throw conflict(`"${step.title}" needs approval before an agent starts it`);
    await this.db
      .update(planSteps)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(planSteps.id, stepId));
    // Every move of a task goes in the journal, from where to where and why.
    if (patch.runState && patch.runState !== step.runState)
      await this.sessions.journal(
        { id: step.sessionId, workspaceId },
        {
          kind: 'task.state',
          actorId: userId,
          stepId,
          summary: `"${step.title}": ${step.runState ?? 'new'} → ${patch.runState}`,
          data: {
            from: step.runState,
            to: patch.runState,
            title: step.title,
            ...(patch.runDetail ? { detail: patch.runDetail } : {}),
          },
        },
      );
    if (patch.status && patch.status !== step.status)
      await this.sessions.journal(
        { id: step.sessionId, workspaceId },
        {
          kind: 'plan.step_status',
          actorId: userId,
          stepId,
          summary: `"${step.title}" marked ${patch.status}`,
          data: { from: step.status, to: patch.status },
        },
      );
    // The board counts tasks by state: tell it.
    if (patch.runState && patch.runState !== step.runState)
      await this.sessions.announce(step.sessionId);
    const ended =
      patch.runState && patch.runState !== step.runState ? RUN_ENDS[patch.runState] : null;
    if (ended)
      await this.sessions.activity(
        await this.sessions.row(step.sessionId),
        userId,
        `task_${patch.runState}` as ActivityKind,
        `"${step.title}" ${ended}`,
        (patch.runDetail ?? step.runDetail)?.split('\n')[0]?.slice(0, 200) ?? null,
      );
    return this.changed(step.sessionId);
  }

  /**
   * A person answers a step that needs a yes before an agent starts it. Editors answer (as for
   * any approval); the first answer stands. The machine running the swarm sees it in the plan.
   */
  async answerApproval(stepId: string, userId: string, approve: boolean): Promise<Plan> {
    const { step, workspaceId } = await this.step(stepId);
    await authorize(this.db, workspaceId, userId, 'approval.answer');
    const [answered] = await this.db
      .update(planSteps)
      .set({
        approval: approve ? 'approved' : 'rejected',
        approvedBy: userId,
        updatedAt: new Date(),
      })
      .where(and(eq(planSteps.id, stepId), eq(planSteps.approval, 'pending')))
      .returning();
    if (!answered)
      throw conflict(
        step.approval
          ? `This step was ${step.approval} already`
          : "This step doesn't need approval",
      );
    await this.sessions.activity(
      await this.sessions.row(step.sessionId),
      userId,
      approve ? 'task_approved' : 'task_rejected',
      `${await this.sessions.nameOf(userId)} ${approve ? 'approved' : 'rejected'} "${step.title}"`,
      step.approvalReason,
    );
    await this.sessions.announce(step.sessionId);
    return this.changed(step.sessionId);
  }

  async deleteStep(stepId: string, userId: string): Promise<Plan> {
    const { step, workspaceId } = await this.step(stepId);
    await authorize(this.db, workspaceId, userId, 'plan.manage');
    await this.db.delete(planSteps).where(eq(planSteps.id, stepId));
    return this.changed(step.sessionId);
  }

  /** An editor gives a step to someone (or to nobody). */
  async assign(stepId: string, userId: string, to: string | null): Promise<Plan> {
    const { step, workspaceId } = await this.step(stepId);
    await authorize(this.db, workspaceId, userId, 'work.assign');
    if (to) await this.assertMember(workspaceId, to);
    await this.db
      .update(planSteps)
      .set({ ownerId: to, updatedAt: new Date() })
      .where(eq(planSteps.id, stepId));
    await this.closeOffers(stepId);
    return this.changed(step.sessionId);
  }

  /** The owner hands a step back; it is free for anyone again. */
  async release(stepId: string, userId: string): Promise<Plan> {
    const { step, workspaceId } = await this.step(stepId);
    await authorize(this.db, workspaceId, userId, 'work.handBack');
    if (step.ownerId !== userId) throw forbidden('Only the owner can hand a step back');
    await this.db
      .update(planSteps)
      .set({
        ownerId: null,
        status: step.status === 'done' ? 'done' : 'todo',
        updatedAt: new Date(),
      })
      .where(eq(planSteps.id, stepId));
    return this.changed(step.sessionId);
  }

  /**
   * Taking over steps: an unowned step that hasn't started moves at once; anything someone owns
   * or has started is asked of its owner.
   */
  async takeOver(
    sessionId: string,
    userId: string,
    stepIds: string[],
  ): Promise<{ plan: Plan; transferred: string[]; requested: string[] }> {
    const session = await this.sessions.row(sessionId);
    await authorize(this.db, session.workspaceId, userId, 'work.claim');
    const steps = await this.db
      .select()
      .from(planSteps)
      .where(
        and(eq(planSteps.sessionId, sessionId), inArray(planSteps.id, stepIds.filter(isUuid))),
      );
    const transferred: string[] = [];
    const requested: string[] = [];
    for (const s of steps) {
      if (s.status === 'done' || s.ownerId === userId) continue;
      if (!s.ownerId) {
        await this.db
          .update(planSteps)
          .set({ ownerId: userId, updatedAt: new Date() })
          .where(and(eq(planSteps.id, s.id), isNull(planSteps.ownerId)));
        transferred.push(s.id);
        continue;
      }
      const [open] = await this.db
        .select({ id: stepOffers.id })
        .from(stepOffers)
        .where(
          and(
            eq(stepOffers.stepId, s.id),
            eq(stepOffers.fromUserId, userId),
            eq(stepOffers.status, 'pending'),
          ),
        );
      if (!open)
        await this.db
          .insert(stepOffers)
          .values({ stepId: s.id, sessionId, fromUserId: userId, toUserId: s.ownerId });
      requested.push(s.id);
    }
    return { plan: await this.changed(sessionId), transferred, requested };
  }

  /** The owner answers a takeover request. */
  async answerOffer(offerId: string, userId: string, accept: boolean): Promise<Plan> {
    if (!isUuid(offerId)) throw notFound('Request not found');
    const [offer] = await this.db.select().from(stepOffers).where(eq(stepOffers.id, offerId));
    if (!offer || offer.toUserId !== userId) throw notFound('Request not found');
    if (offer.status !== 'pending') throw conflict('This request was already answered');
    const { step } = await this.step(offer.stepId);
    if (accept) {
      if (step.ownerId !== userId) throw conflict('The step changed hands in the meantime');
      await this.db
        .update(planSteps)
        .set({ ownerId: offer.fromUserId, updatedAt: new Date() })
        .where(eq(planSteps.id, step.id));
      await this.closeOffers(step.id);
    }
    await this.db
      .update(stepOffers)
      .set({ status: accept ? 'accepted' : 'declined' })
      .where(eq(stepOffers.id, offerId));
    return this.changed(step.sessionId);
  }

  private async closeOffers(stepId: string): Promise<void> {
    await this.db
      .update(stepOffers)
      .set({ status: 'declined' })
      .where(and(eq(stepOffers.stepId, stepId), eq(stepOffers.status, 'pending')));
  }

  /** An agent claims a free step for its person; owned steps stay with their owner. */
  async claim(stepId: string, userId: string): Promise<Plan> {
    const { step, workspaceId } = await this.step(stepId);
    await authorize(this.db, workspaceId, userId, 'work.claim');
    if (step.ownerId && step.ownerId !== userId) {
      const [owner] = await this.db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, step.ownerId));
      throw conflict(
        `"${step.title}" belongs to ${owner?.name ?? 'someone else'}; ask them instead`,
      );
    }
    await this.db
      .update(planSteps)
      .set({
        ownerId: userId,
        status: step.status === 'todo' ? 'doing' : step.status,
        updatedAt: new Date(),
      })
      .where(eq(planSteps.id, stepId));
    return this.changed(step.sessionId);
  }

  // ---------- comments ----------

  private async toComments(rows: CommentRow[]): Promise<Comment[]> {
    if (rows.length === 0) return [];
    const authors = await this.db
      .select({ id: users.id, name: users.name, avatarUrl: users.avatarUrl, kind: users.kind })
      .from(users)
      .where(inArray(users.id, [...new Set(rows.map((r) => r.authorId))]));
    return rows.map((r) => {
      const a = authors.find((x) => x.id === r.authorId);
      return {
        id: r.id,
        workspaceId: r.workspaceId,
        sessionId: r.sessionId,
        parentId: r.parentId,
        anchor: r.anchor as CommentAnchor,
        kind: r.kind,
        body: r.body,
        proposal: r.proposal,
        authorId: r.authorId,
        authorName: a?.name ?? 'Someone',
        authorAvatar: a?.avatarUrl ?? null,
        authorKind: a ? memberKind(a.kind) : 'human',
        status: r.status,
        resolvedBy: r.resolvedBy,
        outdated: r.outdated,
        stepId: r.stepId,
        promptedAt: iso(r.promptedAt),
        createdAt: r.createdAt.toISOString(),
      };
    });
  }

  private async sendComment(row: CommentRow): Promise<Comment> {
    const [comment] = await this.toComments([row]);
    this.out.sendWorkspace(row.workspaceId, { type: 'comment', comment: comment! });
    return comment!;
  }

  async listComments(
    workspaceId: string,
    userId: string,
    filter: { sessionId?: string | undefined; path?: string | undefined },
  ): Promise<Comment[]> {
    await authorize(this.db, workspaceId, userId, 'session.view');
    const rows = await this.db
      .select()
      .from(comments)
      .where(
        and(
          eq(comments.workspaceId, workspaceId),
          ...(filter.sessionId ? [eq(comments.sessionId, filter.sessionId)] : []),
          ...(filter.path ? [eq(comments.path, filter.path)] : []),
        ),
      )
      .orderBy(asc(comments.createdAt))
      .limit(1000);
    return this.toComments(rows);
  }

  async createComment(
    workspaceId: string,
    userId: string,
    input: z.infer<typeof CreateCommentSchema>,
  ): Promise<Comment> {
    await authorize(
      this.db,
      workspaceId,
      userId,
      input.kind === 'suggestion' ? 'suggestion.create' : 'comment.create',
    );
    if (input.sessionId) {
      const session = await this.sessions.row(input.sessionId);
      if (session.workspaceId !== workspaceId)
        throw badRequest('That session is in another workspace');
    }
    if (input.parentId) {
      const [parent] = await this.db
        .select({ w: comments.workspaceId })
        .from(comments)
        .where(eq(comments.id, input.parentId));
      if (parent?.w !== workspaceId) throw badRequest('Reply to a comment in this workspace');
    }
    const anchor = input.anchor;
    const [row] = await this.db
      .insert(comments)
      .values({
        workspaceId,
        sessionId: input.sessionId,
        parentId: input.parentId,
        anchor,
        path: anchor.kind === 'file' || anchor.kind === 'hunk' ? anchor.path : null,
        kind: input.kind,
        body: redactText(input.body),
        proposal: input.kind === 'suggestion' ? input.proposal : null,
        authorId: userId,
      })
      .returning();
    return this.sendComment(row!);
  }

  async updateComment(
    commentId: string,
    userId: string,
    patch: z.infer<typeof UpdateCommentSchema>,
  ): Promise<Comment> {
    if (!isUuid(commentId)) throw notFound('Comment not found');
    const [row] = await this.db.select().from(comments).where(eq(comments.id, commentId));
    if (!row) throw notFound('Comment not found');
    const role = await getRole(this.db, row.workspaceId, userId);
    if (!role) throw notFound('Comment not found');
    if (patch.body !== undefined && row.authorId !== userId)
      throw forbidden('Only the author can edit a comment');
    if ((patch.status !== undefined || patch.prompted) && role === 'viewer') throw forbidden();
    // Any member's machine may notice that the code moved; that's a fact, not an opinion.
    const [updated] = await this.db
      .update(comments)
      .set({
        ...(patch.body !== undefined ? { body: redactText(patch.body) } : {}),
        ...(patch.status
          ? { status: patch.status, resolvedBy: patch.status === 'resolved' ? userId : null }
          : {}),
        ...(patch.outdated !== undefined ? { outdated: patch.outdated } : {}),
        ...(patch.prompted ? { promptedAt: new Date() } : {}),
      })
      .where(eq(comments.id, commentId))
      .returning();
    return this.sendComment(updated!);
  }

  // ---------- the Brain ----------

  private async memoryWithAuthor(row: MemoryRow): Promise<Memory> {
    const [a] = row.authorId
      ? await this.db.select({ name: users.name }).from(users).where(eq(users.id, row.authorId))
      : [];
    return toMemory(row, a?.name ?? null);
  }

  private async sendMemory(row: MemoryRow): Promise<Memory> {
    const memory = await this.memoryWithAuthor(row);
    this.out.sendWorkspace(row.workspaceId, { type: 'memory', memory });
    return memory;
  }

  async listMemories(
    workspaceId: string,
    userId: string,
    status: 'live' | 'retired' | 'all',
  ): Promise<Memory[]> {
    await authorize(this.db, workspaceId, userId, 'memory.view');
    const rows = await this.db
      .select({ m: memories, authorName: users.name })
      .from(memories)
      .leftJoin(users, eq(users.id, memories.authorId))
      .where(
        and(
          eq(memories.workspaceId, workspaceId),
          ...(status === 'live'
            ? [inArray(memories.status, ['active', 'flagged'])]
            : status === 'retired'
              ? [eq(memories.status, 'retired')]
              : []),
        ),
      )
      .orderBy(desc(memories.updatedAt))
      .limit(500);
    return rows.map((r) => toMemory(r.m, r.authorName));
  }

  async createMemory(
    workspaceId: string,
    userId: string,
    input: z.infer<typeof CreateMemorySchema>,
  ): Promise<Memory> {
    await authorize(this.db, workspaceId, userId, 'memory.edit');
    if (input.replacesId) {
      const [old] = await this.db
        .update(memories)
        .set({ status: 'retired', updatedAt: new Date() })
        .where(and(eq(memories.id, input.replacesId), eq(memories.workspaceId, workspaceId)))
        .returning();
      if (!old) throw badRequest('The note to replace was not found');
      await this.sendMemory(old);
    }
    const [row] = await this.db
      .insert(memories)
      .values({
        workspaceId,
        kind: input.kind,
        text: redactText(input.text),
        path: input.path,
        startLine: input.startLine,
        endLine: input.endLine ?? input.startLine,
        snippet: input.snippet ? redactText(input.snippet) : input.snippet,
        commit: input.commit,
        authorId: userId,
        byAgent: input.byAgent,
        // A person's own note is verified; an agent's waits until a person accepts it.
        verified: !input.byAgent,
        sessionId: input.sessionId,
        replacesId: input.replacesId,
        rationale: input.rationale ? redactText(input.rationale) : null,
        consequences: input.consequences ? redactText(input.consequences) : null,
        affects: input.affects.map((a) => a.replace(/^\.\//, '')),
      })
      .returning();
    // A note on code someone else already has a note on (or a decision on the same modules)
    // may disagree with it. Neither wins silently: both are kept and linked for a person.
    const others = input.replacesId ? [] : await this.overlapping(row!);
    if (others.length) {
      for (const o of others)
        await this.sendMemory(
          (
            await this.db
              .update(memories)
              .set({ conflictsWith: [...new Set([...o.conflictsWith, row!.id])] })
              .where(eq(memories.id, o.id))
              .returning()
          )[0]!,
        );
      const [linked] = await this.db
        .update(memories)
        .set({ conflictsWith: others.map((o) => o.id) })
        .where(eq(memories.id, row!.id))
        .returning();
      return this.sendMemory(linked!);
    }
    return this.sendMemory(row!);
  }

  /** Live notes from another source about the same lines, or decisions on the same modules. */
  private async overlapping(note: MemoryRow): Promise<MemoryRow[]> {
    const live = await this.db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.workspaceId, note.workspaceId),
          inArray(memories.status, ['active', 'flagged']),
        ),
      );
    const sameSource = (o: MemoryRow) =>
      o.authorId === note.authorId && (o.byAgent ?? null) === (note.byAgent ?? null);
    const linesMeet = (o: MemoryRow) =>
      o.startLine === null ||
      note.startLine === null ||
      (o.startLine <= (note.endLine ?? note.startLine) &&
        note.startLine <= (o.endLine ?? o.startLine));
    const under = (a: string, b: string) =>
      a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
    return live.filter(
      (o) =>
        o.id !== note.id &&
        !sameSource(o) &&
        ((o.path !== null && o.path === note.path && linesMeet(o)) ||
          (o.kind === 'decision' &&
            note.kind === 'decision' &&
            o.affects.some((a) => note.affects.some((b) => under(a, b))))),
    );
  }

  /** Takes a note out of the others' disagreements (it was retired, or a person said both hold). */
  private async unlinkConflicts(row: MemoryRow): Promise<void> {
    for (const otherId of row.conflictsWith) {
      const [other] = await this.db.select().from(memories).where(eq(memories.id, otherId));
      if (!other) continue;
      const [updated] = await this.db
        .update(memories)
        .set({ conflictsWith: other.conflictsWith.filter((x) => x !== row.id) })
        .where(eq(memories.id, otherId))
        .returning();
      await this.sendMemory(updated!);
    }
  }

  private async memory(id: string): Promise<MemoryRow> {
    if (!isUuid(id)) throw notFound('Note not found');
    const [row] = await this.db.select().from(memories).where(eq(memories.id, id));
    if (!row) throw notFound('Note not found');
    return row;
  }

  async updateMemory(
    id: string,
    userId: string,
    patch: z.infer<typeof UpdateMemorySchema>,
  ): Promise<Memory> {
    const row = await this.memory(id);
    await authorize(this.db, row.workspaceId, userId, 'memory.edit');
    const repinned = patch.snippet !== undefined;
    const { clearConflicts, ...fields } = patch;
    const settled = clearConflicts === true || patch.status === 'retired';
    if (settled) await this.unlinkConflicts(row);
    const [updated] = await this.db
      .update(memories)
      .set({
        ...fields,
        ...(settled ? { conflictsWith: [] } : {}),
        // Re-pinning, or a person saying it still holds, clears the flag.
        ...(repinned || patch.status === 'active' ? { status: 'active', flagReason: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(memories.id, id))
      .returning();
    return this.sendMemory(updated!);
  }

  /** The code a note points at moved or changed (noticed on someone's machine). */
  async flagMemory(id: string, userId: string, reason: string): Promise<Memory> {
    const row = await this.memory(id);
    await authorize(this.db, row.workspaceId, userId, 'memory.view');
    if (row.status !== 'active') return this.memoryWithAuthor(row);
    const [updated] = await this.db
      .update(memories)
      .set({ status: 'flagged', flagReason: reason, updatedAt: new Date() })
      .where(and(eq(memories.id, id), eq(memories.status, 'active')))
      .returning();
    return updated ? this.sendMemory(updated) : this.memoryWithAuthor(row);
  }
}
