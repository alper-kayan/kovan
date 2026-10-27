import { z } from 'zod';

/** At most this many people work in a session with their own agent (watchers don't count). */
export const MAX_SESSION_AGENTS = 20;

export const SessionStatusSchema = z.enum(['active', 'ended']);

/** What a lane's agent is doing right now. */
/** waiting: an approval card; awaiting: stopped (usage limit, gone) until someone takes over. */
export const LaneStateSchema = z.enum(['idle', 'running', 'waiting', 'awaiting']);
export type LaneState = z.infer<typeof LaneStateSchema>;

export const ParticipantSchema = z.object({
  userId: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  /** "join": their own lane and agent. "watch": read-only, but visible to everyone. */
  mode: z.enum(['join', 'watch']),
  /** Who runs their agent ("kovan", "claude-code", "codex") and on which model. */
  harness: z.string().nullable(),
  model: z.string().nullable(),
  state: LaneStateSchema,
  joinedAt: z.string(),
  /** Why the lane is awaiting takeover, when it is. */
  awaitingReason: z.string().nullable(),
  /** The lane's last checkpoint snapshot (a commit on the person's remote, under a shadow ref). */
  snapshotAt: z.string().nullable(),
  snapshotSha: z.string().nullable(),
  snapshotRef: z.string().nullable(),
  /** Why their checkout stopped syncing or their session is paused, when it has. */
  paused: z.string().nullable(),
  /** An AI teammate's lane, and whose machine runs it (and pays). */
  kind: z.enum(['human', 'agent']),
  hostId: z.string().nullable(),
  hostName: z.string().nullable(),
});
export type Participant = z.infer<typeof ParticipantSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  branch: z.string().nullable(),
  status: SessionStatusSchema,
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  endedAt: z.string().nullable(),
  participants: z.array(ParticipantSchema),
  /** Repo-relative paths the agents changed in this session, newest first. */
  touchedFiles: z.array(z.string()),
  /** Lanes with a turn running now, and whose account each one uses. */
  running: z.array(z.object({ userId: z.string(), model: z.string().nullable() })),
  pendingApprovals: z.number(),
  cost: z.number(),
  /** Plan progress for the card: steps done of all steps. */
  plan: z.object({ done: z.number(), total: z.number() }),
  /** Where the swarm's tasks stand (plan steps it ran), for the board. */
  tasks: z.object({
    waiting: z.number(),
    running: z.number(),
    done: z.number(),
    failed: z.number(),
    blocked: z.number(),
    cancelled: z.number(),
  }),
  /** Steps waiting for a person's yes before an agent starts them. */
  taskApprovals: z.array(z.object({ stepId: z.string(), title: z.string(), reason: z.string() })),
  locks: z.array(z.object({ path: z.string(), userId: z.string() })),
  /** Actions cut off mid-flight that nobody has recorded yet. */
  unknownOutcomes: z.number(),
  /** Subagents still running or waiting to be integrated. */
  subagents: z.number(),
  /** The session's swarm, when it has one. */
  swarm: z
    .object({
      id: z.string(),
      status: z.string(),
      spent: z.number(),
      budget: z.number().nullable(),
      /** Why it paused itself (budget, monthly limit), or who paused it. */
      pausedReason: z.string().nullable(),
      launchedBy: z.string().nullable(),
    })
    .nullable(),
  pr: z
    .object({
      url: z.string(),
      number: z.number(),
      state: z.enum(['open', 'merged', 'closed']),
    })
    .nullable(),
  /** The issue the session works on; its pull request says it closes it. */
  issue: z.object({ number: z.number(), url: z.string().nullable() }).nullable().default(null),
  /** The registered machine running it, when one does (agentd), and its checkout there. */
  machine: z.object({ id: z.string(), name: z.string() }).nullable().default(null),
  worktreePath: z.string().nullable().default(null),
});
export type Session = z.infer<typeof SessionSchema>;

export const StartSessionSchema = z.object({
  title: z.string().trim().min(1).max(120),
  branch: z.string().trim().min(1).max(200).nullable(),
  /**
   * The issue to work on. Without a `url`, a GitHub workspace's issue page is used, e.g.
   * https://github.com/owner/repo/issues/12.
   */
  issue: z
    .object({
      number: z.number().int().positive(),
      url: z
        .string()
        .url()
        .max(500)
        .refine((u) => u.startsWith('https://'), 'Must be an https address')
        .optional(),
    })
    .nullable()
    .default(null),
  /** Run it on a registered machine: its id, or "auto" to let Kovan choose. */
  machine: z
    .union([z.string().uuid(), z.literal('auto')])
    .nullable()
    .default(null),
});

export const JoinSessionSchema = z.object({
  mode: z.enum(['join', 'watch']),
  harness: z.string().max(40).nullable().default(null),
  model: z.string().max(200).nullable().default(null),
});

export const EndSessionSchema = z.object({
  /** The final diff, from the machine that ends the session. */
  diff: z.string().max(400_000).nullable().default(null),
});

/** A machine's view of a live session's changes: everything since the base branch, new files too. */
export const SessionChangesInputSchema = z.object({
  diff: z.string().max(400_000).nullable(),
  /** The commit the checkout sits on, for comments pinned to its lines. */
  commit: z.string().max(64).nullable().default(null),
});

export interface SessionChanges {
  userId: string;
  userName: string;
  diff: string | null;
  commit: string | null;
  updatedAt: string;
}

/** The approval card a lane's agent is waiting on; any editor may answer, first answer wins. */
export const SessionApprovalSchema = z.object({
  sessionId: z.string(),
  laneUserId: z.string(),
  requestId: z.string(),
  tool: z.string(),
  kind: z.string(),
  title: z.string(),
  detail: z.string(),
  status: z.enum(['pending', 'approved', 'denied', 'expired']),
  answeredBy: z.string().nullable(),
  createdAt: z.string(),
});
export type SessionApproval = z.infer<typeof SessionApprovalSchema>;

/**
 * One event of a lane's agent: the desktop app's conversation events (prompt, turn start/end,
 * text, reasoning, tool rows, approvals, usage). The server reads a few fields and passes the
 * rest through.
 */
export const LaneEventSchema = z.object({ type: z.string().max(40) }).passthrough();
export type LaneEvent = z.infer<typeof LaneEventSchema>;

export interface LaneTranscript {
  userId: string;
  events: LaneEvent[];
}
