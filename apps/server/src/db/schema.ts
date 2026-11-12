import type { ApiKeyScope, CheckResult, PluginRecommendation, SwarmOutcome } from '@kovan/shared';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable(
  'users',
  {
    id: id(),
    name: text('name').notNull(),
    email: text('email'),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    avatarUrl: text('avatar_url'),
    githubLogin: text('github_login'),
    onboarding: jsonb('onboarding').$type<Record<string, boolean>>().notNull().default({}),
    errorReports: boolean('error_reports').notNull().default(true),
    /** The language the person chose in an app ("tr"), for emails and pushes; null: not said. */
    locale: text('locale'),
    lastVerificationSentAt: timestamp('last_verification_sent_at', { withTimezone: true }),
    /**
     * "agent": an AI teammate; "service": what a workspace API key acts as. Neither has
     * identities, so neither can ever sign in.
     */
    kind: text('kind', { enum: ['human', 'agent', 'service'] })
      .notNull()
      .default('human'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('users_email_unique').on(sql`lower(${t.email})`),
    uniqueIndex('users_github_login_unique').on(sql`lower(${t.githubLogin})`),
  ],
);

/** A way to sign in: an OAuth account or an email address. */
export const identities = pgTable(
  'identities',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: ['github', 'google', 'apple', 'email'] }).notNull(),
    providerUserId: text('provider_user_id').notNull(),
    login: text('login'),
    email: text('email'),
    /**
     * Encrypted by the app before it is written (see crypto.ts). For Apple, the refresh token
     * that is revoked when the account is deleted.
     */
    accessTokenEnc: text('access_token_enc'),
    scopes: text('scopes'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('identities_provider_user').on(t.provider, t.providerUserId)],
);

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    machineId: text('machine_id'),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('auth_sessions_token').on(t.tokenHash),
    index('auth_sessions_user').on(t.userId),
  ],
);

/**
 * A phone that gets push notifications: its platform token, tied to the sign-in it came from
 * (a signed-out or revoked phone gets nothing), and the kinds it turned off.
 */
export const pushDevices = pgTable(
  'push_devices',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    authSessionId: uuid('auth_session_id')
      .notNull()
      .references(() => authSessions.id, { onDelete: 'cascade' }),
    platform: text('platform', { enum: ['ios', 'android'] }).notNull(),
    token: text('token').notNull(),
    /** iOS development builds: Apple's sandbox host. */
    sandbox: boolean('sandbox').notNull().default(false),
    muted: jsonb('muted').$type<string[]>().notNull().default([]),
    appVersion: text('app_version'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('push_devices_token').on(t.platform, t.token),
    index('push_devices_user').on(t.userId),
  ],
);

/**
 * A sign-in started by a desktop app. The browser finishes it; the app collects the session
 * token by polling with a secret only it knows.
 */
export const desktopLogins = pgTable('desktop_logins', {
  id: text('id').primaryKey(),
  secretHash: text('secret_hash').notNull(),
  intent: text('intent', { enum: ['login', 'link'] }).notNull(),
  /** For "link": the signed-in user who is connecting another provider. */
  linkUserId: uuid('link_user_id').references(() => users.id, { onDelete: 'cascade' }),
  machineId: text('machine_id'),
  /** Where the browser sends the person back when done: the mobile app's own link (kovan://…). */
  returnTo: text('return_to'),
  status: text('status', { enum: ['pending', 'complete', 'failed'] })
    .notNull()
    .default('pending'),
  /** The new session token, encrypted, handed out once. */
  sessionTokenEnc: text('session_token_enc'),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  error: text('error'),
  oauthState: text('oauth_state'),
  createdAt: createdAt(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
});

export const emailTokens = pgTable(
  'email_tokens',
  {
    id: id(),
    tokenHash: text('token_hash').notNull(),
    email: text('email').notNull(),
    purpose: text('purpose', { enum: ['login', 'verify'] }).notNull(),
    loginId: text('login_id').references(() => desktopLogins.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    /** Wrong codes typed on a sign-in link's page; past a few, the link stops working. */
    attempts: integer('attempts').notNull().default(0),
  },
  (t) => [uniqueIndex('email_tokens_hash').on(t.tokenHash)],
);

export const orgs = pgTable('orgs', {
  id: id(),
  name: text('name').notNull(),
  /** How long session transcripts are kept. */
  transcriptRetentionDays: integer('transcript_retention_days').notNull().default(90),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

export const orgMembers = pgTable(
  'org_members',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'member'] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

export const workspaces = pgTable('workspaces', {
  id: id(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  repoUrl: text('repo_url'),
  defaultBranch: text('default_branch').notNull().default('main'),
  color: text('color'),
  /** Saved changes in a session go to its teammates every few seconds; one switch for all. */
  autoGitSync: boolean('auto_git_sync').notNull().default(true),
  /** Who last turned it on or off, and when (shown next to the switch). */
  gitSyncChangedBy: text('git_sync_changed_by'),
  gitSyncChangedAt: timestamp('git_sync_changed_at', { withTimezone: true }),
  /** USD a month all agent swarms of the workspace may spend; null: no limit. */
  agentMonthlyLimit: doublePrecision('agent_monthly_limit'),
  /** Who may answer or steer an agent that isn't theirs: owners only, or every editor too. */
  othersAgents: text('others_agents', { enum: ['owners', 'editors'] })
    .notNull()
    .default('owners'),
  mode: text('mode', { enum: ['solo', 'team', 'adaptive'] })
    .notNull()
    .default('adaptive'),
  /** Plugins the owner suggests to members (`PluginRecommendation[]`). */
  recommendedPlugins: jsonb('recommended_plugins')
    .$type<PluginRecommendation[]>()
    .notNull()
    .default([]),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  /**
   * The owner's access token for the repository's git host (encrypted): the server reaches the
   * host with it when machines fetch and push through Kovan (gitRelay.ts).
   */
  gitTokenEnc: text('git_token_enc'),
  gitTokenAt: timestamp('git_token_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['viewer', 'commenter', 'editor', 'owner'] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index('workspace_members_user').on(t.userId),
  ],
);

export const invites = pgTable(
  'invites',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    githubLogin: text('github_login'),
    email: text('email'),
    role: text('role', { enum: ['viewer', 'commenter', 'editor', 'owner'] }).notNull(),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedBy: uuid('accepted_by').references(() => users.id, { onDelete: 'set null' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** The invite link's secret, hashed: whoever opens the link joins with their own account. */
    tokenHash: text('token_hash'),
  },
  (t) => [
    uniqueIndex('invites_token_hash').on(t.tokenHash),
    index('invites_github_login').on(sql`lower(${t.githubLogin})`),
    index('invites_email').on(sql`lower(${t.email})`),
  ],
);

/** Crash and failure reports from desktop apps. Never prompts or code. */
export const errorReports = pgTable('error_reports', {
  id: id(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  source: text('source').notNull(),
  message: text('message').notNull(),
  stack: text('stack'),
  appVersion: text('app_version').notNull(),
  platform: text('platform').notNull(),
  createdAt: createdAt(),
});

/** What each model call cost, per person, for usage pages and (later) managed billing. */
export const usageRecords = pgTable(
  'usage_records',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
    conversationId: text('conversation_id').notNull(),
    model: text('model').notNull(),
    kind: text('kind', { enum: ['model', 'routing'] }).notNull(),
    promptTokens: integer('prompt_tokens').notNull(),
    completionTokens: integer('completion_tokens').notNull(),
    cachedTokens: integer('cached_tokens').notNull().default(0),
    /** USD. */
    cost: doublePrecision('cost').notNull(),
    estimated: boolean('estimated').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('usage_records_user_time').on(t.userId, t.createdAt)],
);

/** One task, one branch: the room where teammates work side by side, each in their own lane. */
export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    branch: text('branch'),
    status: text('status', { enum: ['active', 'ended'] })
      .notNull()
      .default('active'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    /** Repo-relative paths agents changed, newest first (capped). */
    touchedFiles: jsonb('touched_files').$type<string[]>().notNull().default([]),
    /** The final diff, encrypted, saved when the session ends. */
    finalDiffEnc: text('final_diff_enc'),
    /** The session's pull request; merging it completes the session. */
    prUrl: text('pr_url'),
    prNumber: integer('pr_number'),
    prState: text('pr_state', { enum: ['open', 'merged', 'closed'] }),
    /** The issue this session works on; its pull request closes it. */
    issueNumber: integer('issue_number'),
    issueUrl: text('issue_url'),
    /** The registered machine running it (agentd), and its checkout there. */
    machineId: uuid('machine_id').references((): AnyPgColumn => machines.id, {
      onDelete: 'set null',
    }),
    worktreePath: text('worktree_path'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [index('sessions_workspace_status').on(t.workspaceId, t.status, t.updatedAt)],
);

/** Who is in a session: with their own lane ("join") or watching, visibly ("watch"). */
export const sessionParticipants = pgTable(
  'session_participants',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mode: text('mode', { enum: ['join', 'watch'] }).notNull(),
    harness: text('harness'),
    model: text('model'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp('left_at', { withTimezone: true }),
    /** Set when the lane stopped (usage limit, gone) and waits for someone to take over. */
    awaitingReason: text('awaiting_reason'),
    /** The lane's last checkpoint: a commit pushed to the person's own remote. */
    snapshotSha: text('snapshot_sha'),
    snapshotRef: text('snapshot_ref'),
    snapshotAt: timestamp('snapshot_at', { withTimezone: true }),
    /** Why their session is paused or their sync stopped (a manual branch switch, a refused push). */
    paused: text('paused'),
    /** For an AI teammate's lane: whose machine runs it (and pays). */
    hostId: uuid('host_id').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.userId] })],
);

/**
 * Each machine's latest view of a live session's changes (its checkout against the base
 * branch, new files included), encrypted. Phones and teammates read it; ending the session
 * keeps only the final diff.
 */
export const sessionChanges = pgTable(
  'session_changes',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    diffEnc: text('diff_enc'),
    commit: text('commit'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.userId] })],
);

/** Every agent turn in a session and its one visible sponsor: whose account paid for it. */
export const turns = pgTable(
  'turns',
  {
    id: id(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    sponsorId: uuid('sponsor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The turn id the agent gave it. */
    turnKey: text('turn_key').notNull(),
    model: text('model'),
    status: text('status', { enum: ['running', 'done', 'stopped', 'error', 'step_limit'] })
      .notNull()
      .default('running'),
    cost: doublePrecision('cost').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('turns_session_key').on(t.sessionId, t.sponsorId, t.turnKey)],
);

/** A lane's events, redacted and encrypted, in order. Deleted after the org's retention. */
export const transcriptChunks = pgTable(
  'transcript_chunks',
  {
    id: id(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    dataEnc: text('data_enc').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('transcript_chunks_lane_seq').on(t.sessionId, t.userId, t.seq)],
);

/** Approval cards in sessions: any editor answers, the first answer wins. */
export const sessionApprovals = pgTable(
  'session_approvals',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    laneUserId: uuid('lane_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    requestId: text('request_id').notNull(),
    tool: text('tool').notNull(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    /** Encrypted: commands and edits can carry code. */
    detailEnc: text('detail_enc').notNull(),
    status: text('status', { enum: ['pending', 'approved', 'denied', 'expired'] })
      .notNull()
      .default('pending'),
    answeredBy: uuid('answered_by').references(() => users.id, { onDelete: 'set null' }),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.laneUserId, t.requestId] })],
);

/** The session's one plan: ordered steps, each owned by a person (or nobody yet). */
export const planSteps = pgTable(
  'plan_steps',
  {
    id: id(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    title: text('title').notNull(),
    detail: text('detail'),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    status: text('status', { enum: ['todo', 'doing', 'done'] })
      .notNull()
      .default('todo'),
    files: jsonb('files').$type<string[]>().notNull().default([]),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    fromCommentId: uuid('from_comment_id'),
    acceptance: text('acceptance'),
    /** Steps of the same session that must be done first. */
    dependsOn: jsonb('depends_on').$type<string[]>().notNull().default([]),
    runState: text('run_state', {
      enum: [
        'waiting',
        'waiting_for_approval',
        'running',
        'done',
        'failed',
        'blocked',
        'cancelled',
      ],
    }),
    runDetail: text('run_detail'),
    approval: text('approval', { enum: ['pending', 'approved', 'rejected'] }),
    approvalReason: text('approval_reason'),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    /** What agents spent on it (provider cost, USD). */
    spent: doublePrecision('spent').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('plan_steps_session').on(t.sessionId, t.position)],
);

/** Asking an owner to hand over a step they own or have started. */
export const stepOffers = pgTable(
  'step_offers',
  {
    id: id(),
    stepId: uuid('step_id')
      .notNull()
      .references(() => planSteps.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    fromUserId: uuid('from_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    toUserId: uuid('to_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['pending', 'accepted', 'declined'] })
      .notNull()
      .default('pending'),
    createdAt: createdAt(),
  },
  (t) => [index('step_offers_session').on(t.sessionId, t.status)],
);

/** Comments pinned to a session, a transcript moment, file lines or a diff hunk. Never deleted by resolve. */
export const comments = pgTable(
  'comments',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    parentId: uuid('parent_id'),
    anchor: jsonb('anchor').notNull(),
    /** Denormalised from the anchor, to list a file's comments quickly. */
    path: text('path'),
    kind: text('kind', { enum: ['comment', 'suggestion'] })
      .notNull()
      .default('comment'),
    body: text('body').notNull(),
    proposal: text('proposal'),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['open', 'resolved'] })
      .notNull()
      .default('open'),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    outdated: boolean('outdated').notNull().default(false),
    stepId: uuid('step_id'),
    promptedAt: timestamp('prompted_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('comments_workspace_path').on(t.workspaceId, t.path),
    index('comments_session').on(t.sessionId),
  ],
);

/** The Brain: short notes pinned to code that every agent in the workspace reads. */
export const memories = pgTable(
  'memories',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['decision', 'gotcha', 'convention'] }).notNull(),
    text: text('text').notNull(),
    path: text('path'),
    startLine: integer('start_line'),
    endLine: integer('end_line'),
    snippet: text('snippet'),
    commit: text('commit'),
    status: text('status', { enum: ['active', 'flagged', 'retired'] })
      .notNull()
      .default('active'),
    flagReason: text('flag_reason'),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    byAgent: text('by_agent'),
    verified: boolean('verified').notNull().default(false),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    replacesId: uuid('replaces_id'),
    rationale: text('rationale'),
    consequences: text('consequences'),
    affects: jsonb('affects').$type<string[]>().notNull().default([]),
    conflictsWith: jsonb('conflicts_with').$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('memories_workspace_status').on(t.workspaceId, t.status)],
);

/** The session's activity feed: who did what, in words. */
export const activities = pgTable(
  'activities',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    text: text('text').notNull(),
    detail: text('detail'),
    createdAt: createdAt(),
  },
  (t) => [index('activities_session').on(t.sessionId, t.createdAt)],
);

/** Advisory locks: agents in the workspace are told not to edit these paths. */
export const pathLocks = pgTable(
  'path_locks',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.path] })],
);

/** A lane's work moving to someone else. One open handoff per lane: the first request wins. */
export const handoffs = pgTable(
  'handoffs',
  {
    id: id(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['takeover', 'handoff'] }).notNull(),
    fromUserId: uuid('from_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    toUserId: uuid('to_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['requested', 'ready', 'done', 'declined', 'cancelled'] })
      .notNull()
      .default('requested'),
    snapshotSha: text('snapshot_sha'),
    snapshotRef: text('snapshot_ref'),
    snapshotAt: timestamp('snapshot_at', { withTimezone: true }),
    /** Encrypted: prompts and replies can carry code. */
    contextEnc: text('context_enc'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('handoffs_one_open_per_lane')
      .on(t.sessionId, t.fromUserId)
      .where(sql`${t.status} in ('requested', 'ready')`),
  ],
);

/** Actions cut off mid-flight. Never retried automatically; a person records what happened. */
export const outcomes = pgTable(
  'outcomes',
  {
    id: id(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    laneUserId: uuid('lane_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    toolId: text('tool_id').notNull(),
    command: text('command').notNull(),
    evidenceEnc: text('evidence_enc').notNull(),
    status: text('status', { enum: ['unknown', 'succeeded', 'failed', 'not_run'] })
      .notNull()
      .default('unknown'),
    recordedBy: uuid('recorded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('outcomes_tool').on(t.sessionId, t.laneUserId, t.toolId)],
);

/**
 * The session's journal: what the Brain saw happen to its agent work, in order. Summaries are
 * redacted; details are redacted and encrypted (they can carry code and command output).
 */
export const journalEvents = pgTable(
  'journal_events',
  {
    id: id(),
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    stepId: uuid('step_id'),
    swarmId: uuid('swarm_id'),
    subagentId: uuid('subagent_id'),
    summary: text('summary').notNull(),
    dataEnc: text('data_enc'),
    createdAt: createdAt(),
  },
  (t) => [index('journal_events_session').on(t.sessionId, t.seq)],
);

/** Child tasks beside a lane, each in its own worktree; integrated into the parent exactly once. */
export const subagents = pgTable(
  'subagents',
  {
    id: id(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    parentUserId: uuid('parent_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    task: text('task').notNull(),
    status: text('status', {
      enum: [
        'running',
        'checking',
        'passed',
        'integrated',
        'failed',
        'conflict',
        'cancelled',
        'answered',
      ],
    })
      .notNull()
      .default('running'),
    added: integer('added').notNull().default(0),
    removed: integer('removed').notNull().default(0),
    checksPassed: integer('checks_passed').notNull().default(0),
    checksTotal: integer('checks_total').notNull().default(0),
    rev: integer('rev').notNull().default(0),
    baseSha: text('base_sha'),
    detail: text('detail'),
    checks: jsonb('checks').$type<CheckResult[]>().notNull().default([]),
    /** Set by a caller that may repeat the request; one subagent per lane and key. */
    requestKey: text('request_key'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    integratedAt: timestamp('integrated_at', { withTimezone: true }),
  },
  (t) => [
    index('subagents_session').on(t.sessionId, t.createdAt),
    uniqueIndex('subagents_request_key')
      .on(t.parentUserId, t.requestKey)
      .where(sql`${t.requestKey} is not null`),
  ],
);

/** AI teammates: a user of kind "agent" in one workspace, with how it works. */
export const aiAgents = pgTable(
  'ai_agents',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    model: text('model').notNull(),
    effort: text('effort', {
      enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    }),
    mode: text('mode', { enum: ['plan', 'request', 'allow', 'full'] })
      .notNull()
      .default('allow'),
    instructions: text('instructions').notNull().default(''),
    /** USD a month its work may cost (swarm tasks and direct tasks); null: no limit of its own. */
    monthlyLimit: doublePrecision('monthly_limit'),
    /** The swarm whose lead added it (through the agent factory), if one did. */
    hiredBySwarm: uuid('hired_by_swarm').references((): AnyPgColumn => swarms.id, {
      onDelete: 'set null',
    }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('ai_agents_workspace').on(t.workspaceId)],
);

/** Several AI teammates on one goal in a session; one live swarm per session. */
export const swarms = pgTable(
  'swarms',
  {
    id: id(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    launchedBy: uuid('launched_by').references(() => users.id, { onDelete: 'set null' }),
    goal: text('goal').notNull(),
    leadAgentId: uuid('lead_agent_id').references(() => users.id, { onDelete: 'set null' }),
    status: text('status', { enum: ['draft', 'running', 'paused', 'done', 'stopped'] })
      .notNull()
      .default('draft'),
    /** USD; null means explicitly unlimited. */
    budget: doublePrecision('budget'),
    taskBudget: doublePrecision('task_budget'),
    review: boolean('review').notNull().default(true),
    spent: doublePrecision('spent').notNull().default(0),
    maxParallel: integer('max_parallel').notNull().default(2),
    mode: text('mode', { enum: ['plan', 'request', 'allow', 'full'] })
      .notNull()
      .default('allow'),
    pausedReason: text('paused_reason'),
    /** How its tasks ended, reported by the run that finished it. */
    outcome: jsonb('outcome').$type<SwarmOutcome>(),
    /**
     * Raised on every launch: the run that started it carries this number, and a run with an
     * older one (a machine that came back after the swarm moved on) is refused.
     */
    fence: integer('fence').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('swarms_one_live_per_session')
      .on(t.sessionId)
      .where(sql`${t.status} in ('draft', 'running', 'paused')`),
  ],
);

export const swarmAgents = pgTable(
  'swarm_agents',
  {
    swarmId: uuid('swarm_id')
      .notNull()
      .references(() => swarms.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['lead', 'worker'] }).notNull(),
    status: text('status', { enum: ['idle', 'working', 'done', 'stopped'] })
      .notNull()
      .default('idle'),
    task: text('task'),
    spent: doublePrecision('spent').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.swarmId, t.agentId] })],
);

/** Every cost a swarm reported, by workspace, swarm, task and agent: limits sum it up. */
export const agentSpend = pgTable(
  'agent_spend',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    swarmId: uuid('swarm_id').references(() => swarms.id, { onDelete: 'set null' }),
    stepId: uuid('step_id').references(() => planSteps.id, { onDelete: 'set null' }),
    agentId: uuid('agent_id').references(() => users.id, { onDelete: 'set null' }),
    amount: doublePrecision('amount').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('agent_spend_workspace').on(t.workspaceId, t.createdAt)],
);

/** The swarm's live chat: agents to each other, and people to agents. */
export const swarmMessages = pgTable(
  'swarm_messages',
  {
    id: id(),
    swarmId: uuid('swarm_id')
      .notNull()
      .references(() => swarms.id, { onDelete: 'cascade' }),
    fromId: uuid('from_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    toId: uuid('to_id').references(() => users.id, { onDelete: 'cascade' }),
    /** Encrypted: messages can carry code. */
    textEnc: text('text_enc').notNull(),
    /** The agents that have it in their context now (the machine running the swarm says). */
    deliveredTo: jsonb('delivered_to').$type<string[]>().notNull().default([]),
    /** The agents whose model answered after seeing it. */
    readBy: jsonb('read_by').$type<string[]>().notNull().default([]),
    kind: text('kind', { enum: ['note', 'question', 'answer', 'blocker'] })
      .notNull()
      .default('note'),
    /** The message this one answers. */
    replyTo: uuid('reply_to'),
    /** The sender's own key for it: sending again with the same key doesn't make a second one. */
    key: text('key'),
    createdAt: createdAt(),
  },
  (t) => [
    index('swarm_messages_swarm').on(t.swarmId, t.createdAt),
    uniqueIndex('swarm_messages_key').on(t.swarmId, t.key),
  ],
);

/** Knowledge from checked results (shared), and private, unverified-until-accepted preferences. */
export const learnings = pgTable(
  'learnings',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'cascade' }),
    swarmId: uuid('swarm_id').references(() => swarms.id, { onDelete: 'set null' }),
    kind: text('kind', { enum: ['knowledge', 'preference'] }).notNull(),
    textEnc: text('text_enc').notNull(),
    status: text('status', { enum: ['suggested', 'accepted', 'forgotten'] })
      .notNull()
      .default('suggested'),
    verified: boolean('verified').notNull().default(false),
    evidence: text('evidence'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('learnings_workspace').on(t.workspaceId, t.kind)],
);

/** A person's managed-usage billing: their allowance, consent and saved payment method. */
export const billingAccounts = pgTable('billing_accounts', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** USD, markup included; null when uncapped (or not chosen yet). */
  allowance: doublePrecision('allowance'),
  uncapped: boolean('uncapped').notNull().default(false),
  /** Usage counts against the allowance from here (set or reset). */
  allowanceSince: timestamp('allowance_since', { withTimezone: true }).notNull().defaultNow(),
  consentAt: timestamp('consent_at', { withTimezone: true }),
  consentVersion: text('consent_version'),
  stripeCustomerId: text('stripe_customer_id'),
  paymentMethodId: text('payment_method_id'),
  cardBrand: text('card_brand'),
  cardLast4: text('card_last4'),
  status: text('status', { enum: ['ok', 'past_due'] })
    .notNull()
    .default('ok'),
  lastChargeAt: timestamp('last_charge_at', { withTimezone: true }),
  /** The month ("2026-11") the person was last told their allowance ran out. */
  noticeMonth: text('notice_month'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * An organization that pays for its members' managed usage in its workspaces: what an owner
 * agreed to, the limits, the card and the company details on its monthly invoice.
 */
export const orgBilling = pgTable('org_billing', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  /** The owner who turned it on and agreed to pay. */
  setupBy: uuid('setup_by').references(() => users.id, { onDelete: 'set null' }),
  consentAt: timestamp('consent_at', { withTimezone: true }),
  consentVersion: text('consent_version'),
  /** USD per calendar month for the whole organization, markup included. */
  monthlyCap: doublePrecision('monthly_cap'),
  /** USD per month each member may use, unless set for them; null: only the cap. */
  memberLimit: doublePrecision('member_limit'),
  stripeCustomerId: text('stripe_customer_id'),
  paymentMethodId: text('payment_method_id'),
  cardBrand: text('card_brand'),
  cardLast4: text('card_last4'),
  status: text('status', { enum: ['ok', 'past_due'] })
    .notNull()
    .default('ok'),
  companyName: text('company_name'),
  companyAddress: text('company_address'),
  taxId: text('tax_id'),
  billingEmail: text('billing_email'),
  lastChargeAt: timestamp('last_charge_at', { withTimezone: true }),
  /** The month the owners were last told the organization's cap ran out. */
  noticeMonth: text('notice_month'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A member's own monthly limit in an organization that pays (the default applies without it). */
export const orgMemberLimits = pgTable(
  'org_member_limits',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** USD per month; null: no limit of their own (the organization's cap still applies). */
    monthlyLimit: doublePrecision('monthly_limit'),
    /** The month they were last told their limit there ran out. */
    noticeMonth: text('notice_month'),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

/** Invoices for managed usage: a person's daily charge, or an organization's monthly one. */
export const invoices = pgTable(
  'invoices',
  {
    id: id(),
    /** Whose personal invoice it is; kept (without the person) when the account is deleted. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** The organization it bills, for team billing. */
    orgId: uuid('org_id').references(() => orgs.id, { onDelete: 'set null' }),
    /** For an organization's monthly invoice: the month it covers ("2026-11"). */
    period: text('period'),
    amountCents: integer('amount_cents').notNull(),
    /** The exact usage it covers, USD. */
    usage: doublePrecision('usage').notNull(),
    status: text('status', { enum: ['pending', 'paid', 'failed'] })
      .notNull()
      .default('pending'),
    paymentIntentId: text('payment_intent_id'),
    receiptUrl: text('receipt_url'),
    failureReason: text('failure_reason'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: createdAt(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
  },
  (t) => [index('invoices_user').on(t.userId, t.createdAt)],
);

/** The billing ledger: every managed model call, what the provider charged and what we bill. */
export const managedUsage = pgTable(
  'managed_usage',
  {
    id: id(),
    /** Who started the run: delegated agents and routing included. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** The organization that pays, when it pays for its members; null: the person pays. */
    orgId: uuid('org_id').references(() => orgs.id, { onDelete: 'set null' }),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
    runId: text('run_id').notNull(),
    /** What the run was ("Fix the lobby race"), for the usage page. */
    runLabel: text('run_label'),
    model: text('model').notNull(),
    generationId: text('generation_id'),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    /** USD the provider charged. */
    providerCost: doublePrecision('provider_cost').notNull(),
    /** USD billed: provider cost × 1.05. */
    billed: doublePrecision('billed').notNull(),
    invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('managed_usage_user_time').on(t.userId, t.createdAt),
    index('managed_usage_org_time').on(t.orgId, t.createdAt),
    uniqueIndex('managed_usage_generation').on(t.generationId),
  ],
);

/**
 * Who changed what, for an org's owners: roles, members, invites, settings, billing. Sign-ins
 * carry no org. Rows never hold secrets or message text.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    orgId: uuid('org_id').references(() => orgs.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id'),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    /** Kept beside the id so the line still reads after the account is gone. */
    actorName: text('actor_name').notNull(),
    action: text('action').notNull(),
    /** What it was done to, in words ("Deniz", "fixture-repo"). */
    target: text('target'),
    meta: jsonb('meta').$type<Record<string, string | number | boolean | null>>(),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_log_org_time').on(t.orgId, t.createdAt),
    index('audit_log_actor_time').on(t.actorId, t.createdAt),
  ],
);

/**
 * Requests that start work, by the `Idempotency-Key` their caller sent: a retried request
 * gets the first one's answer instead of starting the work again. Kept 24 hours.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: id(),
    /** Who sent it, e.g. "user:<id>"; keys of different callers never meet. */
    owner: text('owner').notNull(),
    key: text('key').notNull(),
    /** The method, path and body the key was first used with. */
    fingerprint: text('fingerprint').notNull(),
    status: text('status', { enum: ['pending', 'done'] }).notNull(),
    statusCode: integer('status_code'),
    response: jsonb('response'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('idempotency_keys_owner_key').on(t.owner, t.key),
    index('idempotency_keys_created').on(t.createdAt),
  ],
);

/**
 * Workspace API keys, for other systems driving Kovan. Each acts as its own member of the
 * workspace (a `service` user), so a person leaving or deleting their account doesn't break
 * it; its scopes limit which requests it may make. Only the hash of the key is kept.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: id(),
    /** The one workspace it belongs to, or null when it belongs to the whole organization. */
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Set instead of the workspace: every workspace of the organization, later ones too. */
    orgId: uuid('org_id').references(() => orgs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    tokenHash: text('token_hash').notNull(),
    scopes: jsonb('scopes').$type<ApiKeyScope[]>().notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdByName: text('created_by_name'),
    createdAt: createdAt(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('api_keys_token_hash').on(t.tokenHash),
    index('api_keys_workspace').on(t.workspaceId),
    index('api_keys_org').on(t.orgId),
  ],
);

/**
 * What happened in a workspace, for other systems: read as a stream (`?since=<id>`) and
 * delivered to webhooks. Kept two weeks.
 */
export const workspaceEvents = pgTable(
  'workspace_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('workspace_events_stream').on(t.workspaceId, t.id)],
);

/** Addresses a workspace's events are posted to, signed with a secret only they share. */
export const webhooks = pgTable(
  'webhooks',
  {
    id: id(),
    /** The one workspace it belongs to, or null when it belongs to the whole organization. */
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Set instead of the workspace: every workspace of the organization, later ones too. */
    orgId: uuid('org_id').references(() => orgs.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    /** Encrypted: the server needs it back to sign each delivery. */
    secretEnc: text('secret_enc').notNull(),
    /** Event types to send; empty means all. */
    events: jsonb('events').$type<string[]>().notNull().default([]),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdByName: text('created_by_name'),
    createdAt: createdAt(),
  },
  (t) => [index('webhooks_workspace').on(t.workspaceId), index('webhooks_org').on(t.orgId)],
);

/** One event on its way to one webhook, with its attempts. */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: id(),
    webhookId: uuid('webhook_id')
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),
    /** Null for a test ping, which isn't part of the stream. */
    eventId: bigint('event_id', { mode: 'number' }).references(() => workspaceEvents.id, {
      onDelete: 'cascade',
    }),
    type: text('type').notNull(),
    /** The exact JSON that is signed and sent, the same on every attempt. */
    body: text('body').notNull(),
    status: text('status', { enum: ['pending', 'delivered', 'failed'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    lastCode: integer('last_code'),
    lastError: text('last_error'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('webhook_deliveries_due').on(t.status, t.nextAttemptAt),
    index('webhook_deliveries_hook').on(t.webhookId, t.createdAt),
  ],
);

/**
 * Machines that run agents unattended (agentd), registered with a `machine` API key. They
 * report in every 30 seconds; being online is worked out from that. Paths of the checkouts
 * they hold are stored so work goes where the repository is (people's desktops never send
 * paths).
 */
export const machines = pgTable(
  'machines',
  {
    id: id(),
    /** The one workspace it belongs to, or null when it belongs to the whole organization. */
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Set instead of the workspace: every workspace of the organization, later ones too. */
    orgId: uuid('org_id').references(() => orgs.id, { onDelete: 'cascade' }),
    /** The member it reports as: its API key's. */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    platform: text('platform').notNull(),
    slots: integer('slots').notNull().default(2),
    agents: jsonb('agents')
      .$type<{ name: string; version: string | null; ready: boolean; works?: boolean }[]>()
      .notNull()
      .default([]),
    repos: jsonb('repos').$type<{ remote: string; path: string }[]>().notNull().default([]),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('machines_workspace_name').on(t.workspaceId, t.name),
    uniqueIndex('machines_org_name').on(t.orgId, t.name),
  ],
);
