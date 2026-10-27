import { z } from 'zod';
import { TaskStateSchema, type TaskState } from './tasks.js';

// ---------- the session plan ----------

export const StepStatusSchema = z.enum(['todo', 'doing', 'done']);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export interface PlanStep {
  id: string;
  sessionId: string;
  position: number;
  title: string;
  detail: string | null;
  /** Work belongs to people, not agents. */
  ownerId: string | null;
  status: StepStatus;
  files: string[];
  createdBy: string | null;
  /** The comment this step came from, if any. */
  fromCommentId: string | null;
  /** What "done" means for this step, checked before it counts as done. */
  acceptance: string | null;
  /** Steps that must be done before this one starts (a swarm runs them in this order). */
  dependsOn: string[];
  /** Where a swarm's run of this step stands; null when no swarm has run it. */
  runState: TaskState | null;
  /** Why it failed or is blocked, or what it waits for. */
  runDetail: string | null;
  /** Set when a person must say yes before an agent starts it; then whether they did. */
  approval: 'pending' | 'approved' | 'rejected' | null;
  /** Why it needs a yes ("adds a database migration"). */
  approvalReason: string | null;
  /** Who answered. */
  approvedBy: string | null;
  /** What agents spent on it (provider cost, USD). */
  spent: number;
  updatedAt: string;
}

/** A request to take over a step someone else owns or has started; the owner answers. */
export interface StepOffer {
  id: string;
  stepId: string;
  sessionId: string;
  fromUserId: string;
  toUserId: string;
  status: 'pending' | 'accepted' | 'declined';
  createdAt: string;
}

export interface Plan {
  sessionId: string;
  steps: PlanStep[];
  offers: StepOffer[];
}

export const AddStepsSchema = z.object({
  steps: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        detail: z.string().max(2000).nullable().default(null),
        files: z.array(z.string().max(500)).max(50).default([]),
        ownerId: z.string().uuid().nullable().default(null),
        acceptance: z.string().max(2000).nullable().default(null),
        /** Earlier steps of this same request (by index) that must be done first. */
        after: z.array(z.number().int().min(0).max(29)).max(29).default([]),
        /** Set when an agent may start it only after a person says yes: why. */
        approvalReason: z.string().trim().min(1).max(500).nullable().default(null),
      }),
    )
    .min(1)
    .max(30),
  fromCommentId: z.string().uuid().nullable().default(null),
});

export const UpdateStepSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    detail: z.string().max(2000).nullable(),
    status: StepStatusSchema,
    position: z.number().int().min(0),
    runState: TaskStateSchema,
    runDetail: z.string().max(2000).nullable(),
  })
  .partial();

// ---------- comments ----------

/** Where a comment is pinned: the session, a moment in a lane, lines of a file, or a diff hunk. */
export const CommentAnchorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session') }),
  z.object({
    kind: z.literal('transcript'),
    laneUserId: z.string(),
    /** The row in that lane's transcript, and a short excerpt to recognise it by. */
    index: z.number().int().min(0),
    excerpt: z.string().max(300),
  }),
  z.object({
    kind: z.enum(['file', 'hunk']),
    path: z.string().min(1).max(500),
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
    /** The code the comment was about, to notice when it moves or changes. */
    snippet: z.string().max(4000),
    /** The commit checked out when it was written. */
    commit: z.string().max(64).nullable().optional(),
  }),
]);
export type CommentAnchor = z.infer<typeof CommentAnchorSchema>;

export interface Comment {
  id: string;
  workspaceId: string;
  sessionId: string | null;
  parentId: string | null;
  anchor: CommentAnchor;
  kind: 'comment' | 'suggestion';
  body: string;
  /** For suggestions on code: the replacement for the anchored lines. */
  proposal: string | null;
  authorId: string;
  authorName: string;
  authorAvatar: string | null;
  /** An AI teammate wrote it (called in with @), or a person. */
  authorKind: 'human' | 'agent';
  status: 'open' | 'resolved';
  resolvedBy: string | null;
  /** The code it points at moved or changed since; it's kept, and labelled. */
  outdated: boolean;
  /** What came of it: a plan step, or a prompt to someone's agent. */
  stepId: string | null;
  promptedAt: string | null;
  createdAt: string;
}

export const CreateCommentSchema = z.object({
  sessionId: z.string().uuid().nullable().default(null),
  parentId: z.string().uuid().nullable().default(null),
  anchor: CommentAnchorSchema,
  kind: z.enum(['comment', 'suggestion']).default('comment'),
  body: z.string().trim().min(1).max(10_000),
  proposal: z.string().max(20_000).nullable().default(null),
});

export const UpdateCommentSchema = z
  .object({
    body: z.string().trim().min(1).max(10_000),
    status: z.enum(['open', 'resolved']),
    outdated: z.boolean(),
    prompted: z.literal(true),
  })
  .partial();

// ---------- the Brain: notes pinned to code ----------

export const MemoryKindSchema = z.enum(['decision', 'gotcha', 'convention']);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

export interface Memory {
  id: string;
  workspaceId: string;
  kind: MemoryKind;
  text: string;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  snippet: string | null;
  commit: string | null;
  /** "flagged": the code it points at moved or changed; the next agent nearby rewrites it. */
  status: 'active' | 'flagged' | 'retired';
  flagReason: string | null;
  authorId: string | null;
  authorName: string | null;
  /** Set when an agent wrote it ("Claude Code · haiku"); such notes start unverified. */
  byAgent: string | null;
  verified: boolean;
  sessionId: string | null;
  /** The note this one replaced (a rewrite after a flag). */
  replacesId: string | null;
  /** For a decision: why it was made, and what follows from it. */
  rationale: string | null;
  consequences: string | null;
  /** Files or folders (modules, services) it governs, beyond the lines it is pinned to. */
  affects: string[];
  /**
   * Notes that may disagree with this one: written about the same code (or, for decisions, the
   * same modules) by someone else, without replacing it. Both are kept, with their author and
   * date, until a person says both hold or retires one.
   */
  conflictsWith: string[];
  createdAt: string;
  updatedAt: string;
}

export const CreateMemorySchema = z.object({
  kind: MemoryKindSchema,
  text: z.string().trim().min(1).max(2000),
  path: z.string().max(500).nullable().default(null),
  startLine: z.number().int().min(1).nullable().default(null),
  endLine: z.number().int().min(1).nullable().default(null),
  snippet: z.string().max(4000).nullable().default(null),
  commit: z.string().max(64).nullable().default(null),
  byAgent: z.string().max(100).nullable().default(null),
  sessionId: z.string().uuid().nullable().default(null),
  replacesId: z.string().uuid().nullable().default(null),
  rationale: z.string().trim().max(2000).nullable().default(null),
  consequences: z.string().trim().max(2000).nullable().default(null),
  affects: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
});

export const UpdateMemorySchema = z
  .object({
    kind: MemoryKindSchema,
    text: z.string().trim().min(1).max(2000),
    status: z.enum(['active', 'retired']),
    verified: z.literal(true),
    /** Re-pin after a person checked a flagged note still holds. */
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
    snippet: z.string().max(4000),
    rationale: z.string().trim().max(2000).nullable(),
    consequences: z.string().trim().max(2000).nullable(),
    /** A person read the notes this one may disagree with: both hold. */
    clearConflicts: z.literal(true),
  })
  .partial();

export const FlagMemorySchema = z.object({ reason: z.string().trim().min(1).max(300) });

// ---------- Phase 8: activity, locks, handoffs, unknown outcomes ----------

export type ActivityKind =
  | 'turn_started'
  | 'turn_interrupted'
  | 'mode_changed'
  | 'steer'
  | 'limit_hit'
  | 'takeover_requested'
  | 'handed_over'
  | 'lock'
  | 'unlock'
  | 'comment'
  | 'outcome_unknown'
  | 'outcome_recorded'
  | 'joined'
  | 'left'
  | 'subagent_started'
  | 'subagent_integrated'
  | 'subagent_failed'
  | 'paused'
  | 'resumed'
  | 'sync_paused'
  | 'conflict'
  | 'pr_opened'
  | 'merged'
  | 'agent_added'
  | 'swarm_launched'
  | 'swarm_paused'
  | 'swarm_done'
  | 'swarm_stopped'
  | 'reassigned'
  | 'task_done'
  | 'task_failed'
  | 'task_blocked'
  | 'task_cancelled'
  | 'task_waiting_for_approval'
  | 'task_approved'
  | 'task_rejected';

/** One line of the session's activity feed ("Bob started a turn on his OpenAI subscription"). */
export interface Activity {
  id: string;
  sessionId: string;
  actorId: string | null;
  actorName: string | null;
  kind: ActivityKind;
  text: string;
  /** A quieter second line ("turn 18 · ahead of queue", "everyone is warned"). */
  detail: string | null;
  createdAt: string;
}

/** An advisory lock: agents are told not to edit this path while the session holds it. */
export interface PathLock {
  sessionId: string;
  path: string;
  userId: string;
  userName: string;
  createdAt: string;
}

/** Moving a lane's work to another person: asked for (takeover) or given (handoff). */
export interface Handoff {
  id: string;
  sessionId: string;
  kind: 'takeover' | 'handoff';
  fromUserId: string;
  toUserId: string;
  /** requested → (the owner's machine stops at a checkpoint) ready → done; or declined. */
  status: 'requested' | 'ready' | 'done' | 'declined' | 'cancelled';
  /** The snapshot commit to continue from, and when it was taken. */
  snapshotSha: string | null;
  snapshotRef: string | null;
  snapshotAt: string | null;
  /** What the new agent needs to pick up the thread. */
  context: HandoffContext | null;
  createdAt: string;
}

export interface HandoffContext {
  /** The last prompts and the agent's last words in the lane being taken over. */
  lastPrompts: string[];
  lastReply: string | null;
  touchedFiles: string[];
  /** Why it moved: a usage limit, a closed laptop, a deliberate handoff. */
  reason: string;
}

/** An action cut off mid-flight (a push, a deploy): never retried; a person records what happened. */
export interface Outcome {
  id: string;
  sessionId: string;
  laneUserId: string;
  toolId: string;
  command: string;
  /** What was sent, and the output seen before it was cut off. */
  evidence: string;
  status: 'unknown' | 'succeeded' | 'failed' | 'not_run';
  recordedBy: string | null;
  createdAt: string;
}
