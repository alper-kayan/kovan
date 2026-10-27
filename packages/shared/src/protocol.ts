import { z } from 'zod';
import { RoleSchema } from './roles.js';
import type { Activity, Comment, Handoff, Memory, Outcome, Plan } from './collab.js';
import type { Subagent } from './git.js';
import type { Learning, MentionReply, MentionStatus, Swarm, SwarmMessage } from './swarm.js';
import {
  LaneEventSchema,
  type LaneEvent,
  type LaneTranscript,
  type Session,
  type SessionApproval,
} from './sessions.js';

// ---------- REST shapes shared by the Brain server and the desktop app ----------

export const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  emailVerified: z.boolean(),
  avatarUrl: z.string().nullable(),
  githubLogin: z.string().nullable(),
  onboarding: z.record(z.string(), z.boolean()),
  errorReports: z.boolean(),
});
export type User = z.infer<typeof UserSchema>;

/**
 * The `avatarUrl` of someone who picked Kovan's own picture (their initials on the dark theme)
 * over a sign-in provider's photo. Signing in again doesn't bring the provider's photo back.
 */
export const KOVAN_AVATAR = 'kovan:dark';

export const OrgSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(['owner', 'member']),
});
export type Org = z.infer<typeof OrgSchema>;

/**
 * How a workspace works: one person with their agents (solo), people together (team), or
 * whichever fits who is in it (adaptive: solo while one person is a member, team after).
 */
export const WorkspaceModeSchema = z.enum(['solo', 'team', 'adaptive']);
export type WorkspaceMode = z.infer<typeof WorkspaceModeSchema>;

/** What a workspace acts as now, from its mode and how many people (not AI teammates) are in it. */
export function effectiveMode(mode: WorkspaceMode, people: number): 'solo' | 'team' {
  if (mode === 'adaptive') return people <= 1 ? 'solo' : 'team';
  return mode;
}

/**
 * A plugin the workspace's owner suggests: members see "Install" for it, nothing installs by
 * itself. It comes from git (a URL or GitHub's owner/repo), optionally a folder and a ref.
 */
export const PluginRecommendationSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  source: z.string().trim().min(1).max(500),
  path: z.string().trim().max(300).default(''),
  ref: z.string().trim().max(200).default(''),
  description: z.string().max(300).default(''),
});
export type PluginRecommendation = z.infer<typeof PluginRecommendationSchema>;

export const WorkspaceSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  /** Normalised remote, e.g. "github.com/owner/repo"; null for repos without a remote. */
  repoUrl: z.string().nullable(),
  defaultBranch: z.string(),
  color: z.string().nullable(),
  autoGitSync: z.boolean(),
  /** Who last turned automatic Git sync on or off (a name), and when. */
  gitSyncChangedBy: z.string().nullable().default(null),
  gitSyncChangedAt: z.string().nullable().default(null),
  /** USD a month the workspace's agent swarms may spend together; null: no limit. */
  agentMonthlyLimit: z.number().nullable(),
  mode: WorkspaceModeSchema,
  /** Plugins the owner suggests to members. */
  recommendedPlugins: z.array(PluginRecommendationSchema).default([]),
  role: RoleSchema,
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const MemberSchema = z.object({
  userId: z.string(),
  name: z.string(),
  githubLogin: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  role: RoleSchema,
  /** A person, or an AI teammate. */
  kind: z.enum(['human', 'agent']),
});
export type Member = z.infer<typeof MemberSchema>;

export const InviteSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  githubLogin: z.string().nullable(),
  email: z.string().nullable(),
  role: RoleSchema,
  createdAt: z.string(),
});
export type Invite = z.infer<typeof InviteSchema>;

export const CreateWorkspaceSchema = z.object({
  orgId: z.string(),
  name: z.string().trim().min(1).max(80),
  /** Any form of the remote; stored normalised ("github.com/owner/repo") so clones match. */
  repoUrl: z
    .string()
    .max(300)
    .nullable()
    .transform((v) => (v === null ? null : (normalizeRepoUrl(v) ?? v))),
  defaultBranch: z.string().trim().min(1).max(200).default('main'),
});

/**
 * What a workspace API key may do: `read` the workspace, `dispatch` work (start sessions, set
 * up and launch swarms), `control` running work (stop, pause, steer, reassign), `machine`: be
 * a machine that runs agents (`agentd`): register, report in, take its work.
 */
export const API_KEY_SCOPES = ['read', 'dispatch', 'control', 'machine'] as const;
export const ApiKeyScopeSchema = z.enum(API_KEY_SCOPES);
export type ApiKeyScope = z.infer<typeof ApiKeyScopeSchema>;

/** A workspace API key, without its secret (shown once, when it is made). */
export const ApiKeySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  /** The start of the key, to tell keys apart: `kv_live_ab12cd…`. */
  prefix: z.string(),
  scopes: z.array(ApiKeyScopeSchema),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type ApiKey = z.infer<typeof ApiKeySchema>;

export const CreateApiKeySchema = z.object({
  name: z.string().trim().min(1).max(60),
  scopes: z
    .array(ApiKeyScopeSchema)
    .min(1)
    .transform((s) => [...new Set(s)]),
});

// ---------- machines that run agents (agentd) ----------

/** An agent CLI a machine has, and whether it is signed in and ready. */
export const MachineAgentSchema = z.object({
  name: z.string().trim().min(1).max(40),
  version: z.string().max(80).nullable().default(null),
  ready: z.boolean().default(true),
  /** The agent this machine runs work with (agentd's KOVAN_AGENT), when it says. */
  works: z.boolean().default(false),
});

/** A checkout a machine holds: which repository, and where. */
export const MachineRepoSchema = z.object({
  /** Any form of the remote; stored normalised like a workspace's. */
  remote: z.string().max(300),
  path: z.string().min(1).max(500),
});

export const RegisterMachineSchema = z.object({
  name: z.string().trim().min(1).max(60),
  platform: z.string().trim().min(1).max(40),
  /** How many runs it takes at once. */
  slots: z.number().int().min(1).max(32).default(2),
  agents: z.array(MachineAgentSchema).max(20).default([]),
  repos: z.array(MachineRepoSchema).max(50).default([]),
});

/** A machine's report; what it leaves out stays as it was. */
export const MachineHeartbeatSchema = z.object({
  slots: z.number().int().min(1).max(32).optional(),
  agents: z.array(MachineAgentSchema).max(20).optional(),
  repos: z.array(MachineRepoSchema).max(50).optional(),
});

export const MachineSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  platform: z.string(),
  slots: z.number(),
  /** Sessions assigned to it that are still active. */
  running: z.number(),
  agents: z.array(MachineAgentSchema),
  repos: z.array(z.object({ remote: z.string(), path: z.string() })),
  /** Heard from in the last 90 seconds (it reports every 30). */
  online: z.boolean(),
  lastSeenAt: z.string(),
  createdAt: z.string(),
  /** The API key it reports with. */
  keyName: z.string().nullable(),
  /** Registered for one workspace, or for the whole organization (it serves them all). */
  scope: z.enum(['workspace', 'organization']).default('workspace'),
});
export type Machine = z.infer<typeof MachineSchema>;

/** Where work runs: a machine's id, or "auto" for the least busy one holding the repository. */
export const MachineChoiceSchema = z.union([z.string().uuid(), z.literal('auto')]);

/** What other systems can hear about a workspace, by webhook or from its event stream. */
export const WORKSPACE_EVENTS = [
  'session.started',
  'session.finished',
  'session.failed',
  'approval.requested',
  'swarm.status_changed',
  'swarm.message',
  'pr.opened',
  'pr.merged',
] as const;
export const WorkspaceEventTypeSchema = z.enum(WORKSPACE_EVENTS);
export type WorkspaceEventType = z.infer<typeof WorkspaceEventTypeSchema>;

/**
 * One event. `id` is a cursor: the stream continues after it (`?since=<id>`), and a webhook
 * receiver can drop an id it has already seen.
 */
export const WorkspaceEventSchema = z.object({
  id: z.string(),
  type: z.union([WorkspaceEventTypeSchema, z.literal('ping')]),
  workspaceId: z.string(),
  createdAt: z.string(),
  data: z.record(z.string(), z.unknown()),
});
export type WorkspaceEvent = z.infer<typeof WorkspaceEventSchema>;

export const WebhookSchema = z.object({
  id: z.string().uuid(),
  url: z.string(),
  /** Empty: every event. */
  events: z.array(WorkspaceEventTypeSchema),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
  /** The newest delivery, to see at a glance whether it works. */
  last: z
    .object({
      status: z.enum(['pending', 'delivered', 'failed']),
      code: z.number().nullable(),
      at: z.string(),
    })
    .nullable(),
});
export type Webhook = z.infer<typeof WebhookSchema>;

export const CreateWebhookSchema = z.object({
  url: z.string().trim().url().max(500),
  events: z
    .array(WorkspaceEventTypeSchema)
    .default([])
    .transform((e) => [...new Set(e)]),
});

export const WebhookDeliverySchema = z.object({
  id: z.string().uuid(),
  type: z.string(),
  eventId: z.string().nullable(),
  status: z.enum(['pending', 'delivered', 'failed']),
  attempts: z.number(),
  lastCode: z.number().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  deliveredAt: z.string().nullable(),
  nextAttemptAt: z.string().nullable(),
});
export type WebhookDelivery = z.infer<typeof WebhookDeliverySchema>;

export const UpdateWorkspaceSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    defaultBranch: z.string().trim().min(1).max(200),
    color: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .nullable(),
    autoGitSync: z.boolean(),
    agentMonthlyLimit: z.number().min(0.01).max(100_000).nullable(),
    mode: WorkspaceModeSchema,
    recommendedPlugins: z.array(PluginRecommendationSchema).max(30),
  })
  .partial();

export const CreateInviteSchema = z
  .object({
    githubLogin: z
      .string()
      .trim()
      .regex(/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i, 'Not a valid GitHub username')
      .optional(),
    email: z.string().trim().email().optional(),
    role: RoleSchema,
  })
  .refine((v) => v.githubLogin || v.email, 'Give a GitHub username or an email');

export const ErrorReportSchema = z.object({
  message: z.string().max(2000),
  stack: z.string().max(20_000).nullable(),
  source: z.enum(['main', 'renderer']),
  appVersion: z.string().max(50),
  platform: z.string().max(50),
});

/** Turns any git remote into "host/owner/repo" so clones of the same repo match. */
export function normalizeRepoUrl(remote: string): string | null {
  const trimmed = remote
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(trimmed);
  if (scp) return `${scp[1]!.toLowerCase()}/${scp[2]}`;
  // Already "host/owner/repo", the form Kovan stores.
  const bare = /^([\w-]+(?:\.[\w-]+)+)\/([^\s:]+\/[^\s:]+)$/.exec(trimmed);
  if (bare) return `${bare[1]!.toLowerCase()}/${bare[2]}`;
  try {
    const url = new URL(trimmed);
    if (!url.hostname) return null;
    return `${url.hostname.toLowerCase()}${url.pathname}`;
  } catch {
    return null;
  }
}

// ---------- the phone asks the person's own desktop ----------

/**
 * Work only a desktop can do (it runs the agents and has the checkout), asked for from the
 * phone: the server hands it to one of the person's own machines, which reports back.
 */
export const DeskActionSchema = z.discriminatedUnion('kind', [
  /** Take over a teammate's lane: this person's agent continues their work. */
  z.object({ kind: z.literal('takeover'), sessionId: z.string().uuid(), laneUserId: z.string() }),
  /** Pick up work handed to this person. */
  z.object({
    kind: z.literal('continue'),
    handoffId: z.string().uuid(),
    sessionId: z.string().uuid(),
  }),
  /** Hand this person's own lane to a teammate. */
  z.object({ kind: z.literal('handoff'), sessionId: z.string().uuid(), toUserId: z.string() }),
  /** Resume a paused swarm this person launched (it runs on their machine). */
  z.object({
    kind: z.literal('resume'),
    swarmId: z.string().uuid(),
    sessionId: z.string().uuid(),
  }),
  /** Start a swarm set up on the phone: it runs on this person's machine, on their key. */
  z.object({
    kind: z.literal('launch'),
    swarmId: z.string().uuid(),
    sessionId: z.string().uuid(),
  }),
  /**
   * A prompt for this person's own agent in a session: a new turn when it is idle (joining the
   * session with a lane first if they have none), guidance when it is working.
   */
  z.object({
    kind: z.literal('prompt'),
    sessionId: z.string().uuid(),
    text: z.string().trim().min(1).max(10_000),
  }),
]);
export type DeskAction = z.infer<typeof DeskActionSchema>;

export interface DeskRequest {
  id: string;
  action: DeskAction;
  createdAt: string;
}

export const DeskResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().max(500),
});

// ---------- Realtime (WebSocket) protocol ----------

export const PresenceStatusSchema = z.enum(['active', 'idle']);

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    token: z.string(),
    machineId: z.string().max(100),
    clientVersion: z.string().max(50),
    /** A phone watches and answers but runs no agents, so it doesn't count as a machine. */
    client: z.enum(['desktop', 'mobile']).default('desktop'),
  }),
  z.object({
    type: z.literal('subscribe'),
    workspaceId: z.string(),
    /** Where this app left off (after a reconnect): what it missed is sent again, in order. */
    since: z.object({ epoch: z.string().max(64), seq: z.number().int().min(0) }).optional(),
  }),
  z.object({ type: z.literal('unsubscribe'), workspaceId: z.string() }),
  /** "Are you there?": apps that can't see WebSocket pings (phones) check the line this way. */
  z.object({ type: z.literal('ping') }),
  z.object({
    type: z.literal('presence'),
    status: PresenceStatusSchema,
    /** The workspace this machine has open, if any. */
    workspaceId: z.string().nullable(),
  }),
  /** Follow a session live; the server answers with a snapshot, then streams changes. */
  z.object({ type: z.literal('session.subscribe'), sessionId: z.string() }),
  z.object({ type: z.literal('session.unsubscribe'), sessionId: z.string() }),
  /** New events from the sender's own lane (their agent, on their machine). */
  z.object({
    type: z.literal('lane.events'),
    sessionId: z.string(),
    events: z.array(LaneEventSchema).min(1).max(500),
    /** Repo-relative paths this batch changed. */
    touched: z.array(z.string().max(500)).max(200).default([]),
    /** An AI teammate's lane this machine runs, instead of the sender's own. */
    agentId: z.string().uuid().optional(),
  }),
  /** Guidance for a running lane, delivered by the owner's machine (on the owner's account). */
  z.object({
    type: z.literal('lane.steer'),
    sessionId: z.string(),
    laneUserId: z.string(),
    id: z.string().max(100),
    text: z.string().min(1).max(10_000),
  }),
  /** An answer to a lane's approval card; the first valid one wins. */
  z.object({
    type: z.literal('approval.answer'),
    sessionId: z.string(),
    laneUserId: z.string(),
    requestId: z.string().max(200),
    approved: z.boolean(),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export const PresenceEntrySchema = z.object({
  userId: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  status: PresenceStatusSchema,
  /** True when one of this person's machines has this workspace open. */
  inWorkspace: z.boolean(),
});
export type PresenceEntry = z.infer<typeof PresenceEntrySchema>;

export type ServerMessage =
  | { type: 'welcome'; user: User }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' }
  | { type: 'presence'; workspaceId: string; online: PresenceEntry[] }
  /**
   * Following a workspace now. Its changes carry `seq` from here on; `resync`: some of what
   * was missed is gone (or the server restarted), so its state must be read again.
   */
  | {
      type: 'subscribed';
      workspaceId: string;
      epoch: string;
      seq: number;
      replayed: number;
      resync: boolean;
    }
  /** Not from the server: an app reloads one workspace's state after a resync. */
  | { type: 'resync'; workspaceId: string }
  /** Your role in a workspace changed; null means you were removed. */
  | { type: 'membership'; workspaceId: string; role: z.infer<typeof RoleSchema> | null }
  | { type: 'workspace'; workspace: Workspace }
  | { type: 'members'; workspaceId: string }
  | { type: 'user'; user: User }
  /** A session in a subscribed workspace changed (board cards, alerts). */
  | { type: 'session'; session: Session }
  | {
      type: 'session.snapshot';
      session: Session;
      lanes: LaneTranscript[];
      approvals: SessionApproval[];
    }
  | { type: 'lane.events'; sessionId: string; userId: string; events: LaneEvent[] }
  /** Someone's machine sent a newer view of the session's changes (read them with a GET). */
  | { type: 'session.changes'; sessionId: string; userId: string; updatedAt: string }
  | { type: 'approval'; approval: SessionApproval }
  | { type: 'plan'; workspaceId: string; plan: Plan }
  | { type: 'comment'; comment: Comment }
  | { type: 'memory'; memory: Memory }
  | { type: 'activity'; workspaceId: string; activity: Activity }
  | {
      type: 'steer';
      sessionId: string;
      laneUserId: string;
      id: string;
      fromUserId: string;
      fromName: string;
      text: string;
      /** An AI teammate called in with @: the conversation it was called into. */
      mention?: { context: string | null; reply: MentionReply };
    }
  /** A teammate you called in with @ is working on it, or answered: for your conversation. */
  | {
      type: 'teammate.reply';
      sessionId: string;
      agentId: string;
      name: string;
      requestId: string;
      status: MentionStatus;
      text: string | null;
      /** What it was asked (with `working`), when the call came from another device. */
      asked: string | null;
    }
  | { type: 'handoff'; workspaceId: string; handoff: Handoff }
  | { type: 'outcome'; workspaceId: string; outcome: Outcome }
  | { type: 'subagent'; workspaceId: string; subagent: Subagent }
  | { type: 'swarm'; workspaceId: string; swarm: Swarm }
  | { type: 'swarm.message'; workspaceId: string; sessionId: string; message: SwarmMessage }
  | { type: 'learning'; workspaceId: string; learning: Learning }
  /** To the person's desktops: work asked for from their phone (claim it, then do it). */
  | { type: 'desk'; request: DeskRequest }
  /** To all the person's apps: how a desk request ended. */
  | { type: 'desk.done'; id: string; ok: boolean; message: string }
  /** To the machine running a swarm: someone asked to stop an agent or move its work. */
  | {
      type: 'swarm.control';
      swarmId: string;
      sessionId: string;
      action: 'stop' | 'reassign';
      agentId: string;
      toId: string | null;
      fromUserId: string;
    };

// ---------- usage ----------

export const UsageReportSchema = z.object({
  workspaceId: z.string().uuid().nullable(),
  conversationId: z.string().max(100),
  records: z
    .array(
      z.object({
        model: z.string().max(200),
        kind: z.enum(['model', 'routing']),
        promptTokens: z.number().int().min(0),
        completionTokens: z.number().int().min(0),
        cachedTokens: z.number().int().min(0),
        cost: z.number().min(0).max(1000),
        estimated: z.boolean(),
      }),
    )
    .min(1)
    .max(200),
});
export type UsageReport = z.infer<typeof UsageReportSchema>;

export interface UsageSummary {
  days: number;
  total: number;
  calls: number;
  byModel: {
    model: string;
    cost: number;
    calls: number;
    promptTokens: number;
    completionTokens: number;
  }[];
  byWorkspace: { workspaceId: string | null; name: string | null; cost: number }[];
  byDay: { day: string; cost: number }[];
}

/** What deleting an account does, worked out before anything changes (and shown first). */
export interface AccountDeletionPlan {
  /** Workspaces nobody else is in: deleted with everything in them. */
  deleted: { id: string; name: string }[];
  /** Workspaces others are in: they stay; `owner` is who becomes owner when you were the last. */
  kept: { id: string; name: string; owner: { id: string; name: string } | null }[];
  /** Orgs that go (nothing and nobody left) or stay with a new owner. */
  orgsDeleted: { id: string; name: string }[];
  orgsKept: { id: string; name: string; owner: { id: string; name: string } | null }[];
  /** Managed usage used but not charged yet: it is not charged once the account is gone. */
  unbilled: number;
  /** Why the account can't be deleted yet, or null. */
  blocker: string | null;
}
