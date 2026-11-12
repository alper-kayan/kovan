import {
  CreateApiKeySchema,
  normalizeRepoUrl,
  CreateInviteSchema,
  CreateWorkspaceSchema,
  ErrorReportSchema,
  KOVAN_AVATAR,
  UsageReportSchema,
  type UsageSummary,
  RoleSchema,
  UpdateOrgSchema,
  UpdateWorkspaceSchema,
  type OrgSettings,
  ROLE_WORDS,
  type Invite,
  type InviteLookup,
  type Member,
  type Org,
  type Workspace,
  LOCALES,
} from '@kovan/shared';
import { currentLocale, t, tFor } from '../i18n/index.js';
import type { FastifyInstance } from 'fastify';
import { and, count, eq, gte, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { deleteAccount, planDeletion } from '../account.js';
import { requireUser } from '../auth/guard.js';
import { authorize, getRole } from '../authz.js';
import type { AppContext } from '../context.js';
import { randomToken, sha256 } from '../crypto.js';
import {
  emailTokens,
  errorReports,
  identities,
  usageRecords,
  invites,
  orgMembers,
  orgs,
  users,
  workspaceMembers,
  workspaces,
} from '../db/schema.js';
import { badRequest, conflict, forbidden, notFound, tooMany } from '../errors.js';
import { actionMail } from '../mail.js';
import { memberKind, toUser } from '../users.js';

const RESEND_SECONDS = 60;

type WorkspaceRow = typeof workspaces.$inferSelect;

const toWorkspace = (row: WorkspaceRow, role: Workspace['role']): Workspace => ({
  id: row.id,
  orgId: row.orgId,
  name: row.name,
  repoUrl: row.repoUrl,
  defaultBranch: row.defaultBranch,
  color: row.color,
  autoGitSync: row.autoGitSync,
  gitSyncChangedBy: row.gitSyncChangedBy,
  gitSyncChangedAt: row.gitSyncChangedAt?.toISOString() ?? null,
  agentMonthlyLimit: row.agentMonthlyLimit,
  othersAgents: row.othersAgents,
  mode: row.mode,
  recommendedPlugins: row.recommendedPlugins,
  role,
});

const toInvite = (row: typeof invites.$inferSelect): Invite => ({
  id: row.id,
  workspaceId: row.workspaceId,
  githubLogin: row.githubLogin,
  email: row.email,
  role: row.role,
  createdAt: row.createdAt.toISOString(),
});

const WorkspaceIdParams = z.object({ id: z.string().uuid() });

export function registerApiRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, mailer, config, hub, audit } = ctx;

  async function orgsOf(userId: string): Promise<Org[]> {
    return db
      .select({ id: orgs.id, name: orgs.name, role: orgMembers.role })
      .from(orgMembers)
      .innerJoin(orgs, eq(orgs.id, orgMembers.orgId))
      .where(eq(orgMembers.userId, userId));
  }

  async function workspaceFor(userId: string, workspaceId: string): Promise<Workspace> {
    const [row] = await db
      .select({ w: workspaces, role: workspaceMembers.role })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
      );
    if (!row) throw notFound('Workspace not found');
    return toWorkspace(row.w, row.role);
  }

  /** How many people (not AI teammates) are members of a workspace. */
  async function humanMembers(workspaceId: string): Promise<number> {
    const [r] = await db
      .select({ n: count() })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(users.kind, 'human')));
    return Number(r?.n ?? 0);
  }

  /** Everyone in the workspace gets it as it now is (each with their own role). */
  async function announceWorkspace(workspaceId: string): Promise<void> {
    const members = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceId));
    for (const m of members)
      hub.sendUser(m.userId, {
        type: 'workspace',
        workspace: await workspaceFor(m.userId, workspaceId),
      });
  }

  /** Tells everyone in a workspace that its member list changed, and the person their new role. */
  async function announceMembership(workspaceId: string, userId: string): Promise<void> {
    const role = await getRole(db, workspaceId, userId);
    hub.sendUser(userId, { type: 'membership', workspaceId, role });
    if (role)
      hub.sendUser(userId, {
        type: 'workspace',
        workspace: await workspaceFor(userId, workspaceId),
      });
    else hub.dropSubscription(userId, workspaceId);
    hub.sendWorkspace(workspaceId, { type: 'members', workspaceId });
  }

  async function nameOf(userId: string): Promise<string> {
    const [row] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
    return row?.name ?? 'someone';
  }

  async function ownerCount(workspaceId: string): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, 'owner')),
      );
    return row?.n ?? 0;
  }

  // ---------- me ----------

  app.get('/api/me', async (req) => {
    const user = await requireUser(ctx, req);
    return { user: toUser(user), orgs: await orgsOf(user.id) };
  });

  app.patch('/api/me', async (req) => {
    const user = await requireUser(ctx, req);
    const body = z
      .object({
        name: z.string().trim().min(1).max(80),
        onboarding: z.record(z.string().max(40), z.boolean()),
        errorReports: z.boolean(),
        photo: z.enum(['kovan', 'github']),
        locale: z.enum(LOCALES).nullable(),
      })
      .partial()
      .strict()
      .parse(req.body);
    const patch: Partial<typeof users.$inferInsert> = {};
    if (body.name) patch.name = body.name;
    if (body.photo === 'kovan') patch.avatarUrl = KOVAN_AVATAR;
    if (body.photo === 'github') {
      const [github] = await db
        .select({ id: identities.providerUserId })
        .from(identities)
        .where(and(eq(identities.userId, user.id), eq(identities.provider, 'github')));
      if (!github) throw badRequest('Connect GitHub first to use its photo');
      patch.avatarUrl = `https://avatars.githubusercontent.com/u/${github.id}?v=4`;
    }
    if (body.errorReports !== undefined) patch.errorReports = body.errorReports;
    if (body.locale !== undefined) patch.locale = body.locale;
    // Onboarding steps only ever get completed, so merge rather than replace.
    if (body.onboarding) patch.onboarding = { ...user.onboarding, ...body.onboarding };
    const [updated] = await db.update(users).set(patch).where(eq(users.id, user.id)).returning();
    return { user: toUser(updated!) };
  });

  // ---------- deleting the account ----------

  app.get('/api/me/deletion', async (req) => {
    const user = await requireUser(ctx, req);
    return { plan: await planDeletion(ctx, user.id) };
  });

  app.post('/api/me/delete', async (req) => {
    const user = await requireUser(ctx, req);
    z.object({ confirm: z.literal(true) }).parse(req.body ?? {});
    return { plan: await deleteAccount(ctx, user, req) };
  });

  app.post('/api/me/verification-email', async (req, reply) => {
    const user = await requireUser(ctx, req);
    if (!user.email) throw badRequest('Your account has no email address');
    if (user.emailVerifiedAt) throw conflict('Your email is already verified');
    const since = user.lastVerificationSentAt
      ? (Date.now() - user.lastVerificationSentAt.getTime()) / 1000
      : Infinity;
    if (since < RESEND_SECONDS) {
      const retryAfter = Math.ceil(RESEND_SECONDS - since);
      reply.header('retry-after', String(retryAfter));
      throw tooMany(`Wait ${retryAfter}s before sending another link`);
    }
    const token = randomToken();
    await db.insert(emailTokens).values({
      tokenHash: sha256(token),
      email: user.email,
      purpose: 'verify',
      userId: user.id,
      expiresAt: new Date(Date.now() + 24 * 3_600_000),
    });
    await db.update(users).set({ lastVerificationSentAt: new Date() }).where(eq(users.id, user.id));
    await mailer.send(
      actionMail(
        user.email,
        t('Verify your email for Kovan'),
        t(
          'Open this link to confirm your address for your Kovan account. Invites and session alerts go here.',
        ),
        t('Verify email'),
        `${config.PUBLIC_URL}/auth/verify?token=${token}`,
        t,
      ),
    );
    return { sentTo: user.email, retryAfter: RESEND_SECONDS };
  });

  // ---------- orgs ----------

  app.post('/api/orgs', async (req) => {
    const user = await requireUser(ctx, req);
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body);
    const org = await db.transaction(async (tx) => {
      const [created] = await tx.insert(orgs).values({ name, createdBy: user.id }).returning();
      await tx.insert(orgMembers).values({ orgId: created!.id, userId: user.id, role: 'owner' });
      return created!;
    });
    await audit.record({
      orgId: org.id,
      actor: user,
      action: 'org.created',
      target: org.name,
      req,
    });
    return { org: { id: org.id, name: org.name, role: 'owner' } satisfies Org };
  });

  async function orgFor(userId: string, orgId: string): Promise<OrgSettings> {
    const [row] = /^[0-9a-f-]{36}$/i.test(orgId)
      ? await db
          .select({ o: orgs, role: orgMembers.role })
          .from(orgMembers)
          .innerJoin(orgs, eq(orgs.id, orgMembers.orgId))
          .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
      : [];
    if (!row) throw notFound('Organization not found');
    return {
      id: row.o.id,
      name: row.o.name,
      role: row.role,
      transcriptRetentionDays: row.o.transcriptRetentionDays,
    };
  }

  app.get('/api/orgs/:id', async (req) => {
    const user = await requireUser(ctx, req);
    return { org: await orgFor(user.id, (req.params as { id: string }).id) };
  });

  app.patch('/api/orgs/:id', async (req) => {
    const user = await requireUser(ctx, req);
    const before = await orgFor(user.id, (req.params as { id: string }).id);
    if (before.role !== 'owner') throw forbidden('Only an organization owner can change this');
    const patch = UpdateOrgSchema.parse(req.body);
    await db.update(orgs).set(patch).where(eq(orgs.id, before.id));
    if (patch.name !== undefined && patch.name !== before.name)
      await audit.record({
        orgId: before.id,
        actor: user,
        action: 'org.renamed',
        target: patch.name,
        meta: { from: before.name },
        req,
      });
    if (
      patch.transcriptRetentionDays !== undefined &&
      patch.transcriptRetentionDays !== before.transcriptRetentionDays
    ) {
      await audit.record({
        orgId: before.id,
        actor: user,
        action: 'org.retention_changed',
        meta: { from: before.transcriptRetentionDays, to: patch.transcriptRetentionDays },
        req,
      });
      // A shorter retention applies now, not at the next nightly sweep.
      await ctx.sessions.sweepRetention();
    }
    return { org: await orgFor(user.id, before.id) };
  });

  app.get('/api/orgs/:id/audit', async (req) => {
    const user = await requireUser(ctx, req);
    const org = await orgFor(user.id, (req.params as { id: string }).id);
    if (org.role !== 'owner') throw forbidden('Only an organization owner can read the audit log');
    const { before, limit } = z
      .object({
        before: z.iso.datetime().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);
    return {
      entries: await audit.list(org.id, { ...(before ? { before: new Date(before) } : {}), limit }),
    };
  });

  // ---------- workspaces ----------

  // `?repo=` finds the workspaces of a repository from any form of its remote
  // (https, ssh, `git@host:owner/repo.git`), the way clones of it are matched.
  app.get('/api/workspaces', async (req) => {
    const user = await requireUser(ctx, req);
    const { repo } = z.object({ repo: z.string().max(500).optional() }).parse(req.query);
    const repoUrl = repo === undefined ? undefined : normalizeRepoUrl(repo);
    if (repo !== undefined && !repoUrl) throw badRequest('repo is not a git remote address');
    const rows = await db
      .select({ w: workspaces, role: workspaceMembers.role })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(
        and(
          eq(workspaceMembers.userId, user.id),
          repoUrl ? eq(workspaces.repoUrl, repoUrl) : undefined,
        ),
      )
      .orderBy(workspaces.name);
    return { workspaces: rows.map((r) => toWorkspace(r.w, r.role)) };
  });

  app.post('/api/workspaces', async (req, reply) => {
    const user = await requireUser(ctx, req);
    const body = CreateWorkspaceSchema.parse(req.body);
    const [membership] = await db
      .select()
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, body.orgId), eq(orgMembers.userId, user.id)));
    if (!membership) throw notFound('Organization not found');
    if (body.repoUrl) {
      const [existing] = await db
        .select()
        .from(workspaces)
        .where(and(eq(workspaces.orgId, body.orgId), eq(workspaces.repoUrl, body.repoUrl)));
      if (existing) {
        const role = await getRole(db, existing.id, user.id);
        if (role)
          return reply.code(200).send({ workspace: toWorkspace(existing, role), existing: true });
        throw conflict(
          'This repository already has a workspace in your organization. Ask its owner to invite you.',
        );
      }
    }
    const workspace = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(workspaces)
        .values({
          orgId: body.orgId,
          name: body.name,
          repoUrl: body.repoUrl,
          defaultBranch: body.defaultBranch,
          createdBy: user.id,
        })
        .returning();
      await tx
        .insert(workspaceMembers)
        .values({ workspaceId: created!.id, userId: user.id, role: 'owner' });
      return created!;
    });
    // The organization's API keys cover it from the start.
    await ctx.apiKeys.joinNewWorkspace(workspace.id, workspace.orgId);
    // The creator's apps start following the new workspace right away.
    hub.sendUser(user.id, { type: 'membership', workspaceId: workspace.id, role: 'owner' });
    hub.sendUser(user.id, { type: 'workspace', workspace: toWorkspace(workspace, 'owner') });
    await audit.record({
      orgId: workspace.orgId,
      workspaceId: workspace.id,
      actor: user,
      action: 'workspace.created',
      target: workspace.name,
      req,
    });
    return reply.code(201).send({ workspace: toWorkspace(workspace, 'owner'), existing: false });
  });

  app.get('/api/workspaces/:id', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = req.params as { id: string };
    await authorize(db, id, user.id, 'session.view');
    return { workspace: await workspaceFor(user.id, id) };
  });

  app.patch('/api/workspaces/:id', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = req.params as { id: string };
    await authorize(db, id, user.id, 'workspace.manageSettings');
    const patch = UpdateWorkspaceSchema.parse(req.body);
    // Solo is one person: it can't be chosen while others are members.
    if (patch.mode === 'solo') {
      const people = await humanMembers(id);
      if (people > 1)
        throw conflict(
          `${people} people are members: remove the others first, or keep it Team or Adaptive`,
        );
    }
    await db
      .update(workspaces)
      .set({
        ...patch,
        ...(patch.autoGitSync !== undefined
          ? { gitSyncChangedBy: user.name, gitSyncChangedAt: new Date() }
          : {}),
      })
      .where(eq(workspaces.id, id));
    await announceWorkspace(id);
    const updated = await workspaceFor(user.id, id);
    await audit.record({
      workspaceId: id,
      actor: user,
      action: 'workspace.updated',
      target: updated.name,
      meta: { fields: Object.keys(patch).join(', ') },
      req,
    });
    return { workspace: updated };
  });

  // Automatic Git sync is one switch for the whole workspace: whoever works in it may flip it,
  // and everyone sees who did it last.
  app.put('/api/workspaces/:id/git-sync', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = req.params as { id: string };
    await authorize(db, id, user.id, 'workspace.gitSync');
    const { on } = z.object({ on: z.boolean() }).parse(req.body);
    await db
      .update(workspaces)
      .set({ autoGitSync: on, gitSyncChangedBy: user.name, gitSyncChangedAt: new Date() })
      .where(eq(workspaces.id, id));
    await announceWorkspace(id);
    const updated = await workspaceFor(user.id, id);
    await audit.record({
      workspaceId: id,
      actor: user,
      action: 'workspace.updated',
      target: updated.name,
      meta: { fields: `autoGitSync: ${on ? 'on' : 'off'}` },
      req,
    });
    return { workspace: updated };
  });

  app.delete('/api/workspaces/:id', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = req.params as { id: string };
    await authorize(db, id, user.id, 'workspace.delete');
    const members = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, id));
    const gone = await workspaceFor(user.id, id);
    await db.delete(workspaces).where(eq(workspaces.id, id));
    await audit.record({
      orgId: gone.orgId,
      workspaceId: id,
      actor: user,
      action: 'workspace.deleted',
      target: gone.name,
      req,
    });
    for (const m of members) {
      hub.sendUser(m.userId, { type: 'membership', workspaceId: id, role: null });
      hub.dropSubscription(m.userId, id);
    }
    return { ok: true };
  });

  // ---------- members and invites ----------

  app.get('/api/workspaces/:id/members', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = req.params as { id: string };
    const role = await authorize(db, id, user.id, 'session.view');
    const rows = await db
      .select({
        userId: users.id,
        name: users.name,
        githubLogin: users.githubLogin,
        avatarUrl: users.avatarUrl,
        role: workspaceMembers.role,
        kind: users.kind,
        email: users.email,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      // API keys are listed with the keys, not as people.
      .where(and(eq(workspaceMembers.workspaceId, id), ne(users.kind, 'service')))
      .orderBy(users.name);
    // Owners see addresses (they invite and remove people by them); others see names.
    const members: Member[] = rows.map((m) => ({
      ...m,
      kind: memberKind(m.kind),
      email: role === 'owner' && m.kind === 'human' ? m.email : null,
    }));
    const pending =
      role === 'owner'
        ? (
            await db
              .select()
              .from(invites)
              .where(
                and(
                  eq(invites.workspaceId, id),
                  isNull(invites.acceptedAt),
                  isNull(invites.revokedAt),
                ),
              )
          ).map(toInvite)
        : [];
    return { members, invites: pending };
  });

  app.patch('/api/workspaces/:id/members/:userId', async (req) => {
    const user = await requireUser(ctx, req);
    const { id, userId } = req.params as { id: string; userId: string };
    await authorize(db, id, user.id, 'workspace.manageRoles');
    const { role } = z.object({ role: RoleSchema }).parse(req.body);
    const current = await getRole(db, id, userId);
    if (!current) throw notFound('Member not found');
    if (current === 'owner' && role !== 'owner' && (await ownerCount(id)) <= 1) {
      throw conflict('A workspace needs at least one owner');
    }
    await db
      .update(workspaceMembers)
      .set({ role })
      .where(and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.userId, userId)));
    await announceMembership(id, userId);
    await ctx.sessions.membershipChanged(id, userId, role);
    if (role !== current)
      await audit.record({
        workspaceId: id,
        actor: user,
        action: 'member.role_changed',
        target: await nameOf(userId),
        meta: { from: current, to: role },
        req,
      });
    return { ok: true };
  });

  app.delete('/api/workspaces/:id/members/:userId', async (req) => {
    const user = await requireUser(ctx, req);
    const { id, userId } = req.params as { id: string; userId: string };
    // Anyone may leave; removing someone else needs membership rights.
    if (userId !== user.id) await authorize(db, id, user.id, 'workspace.manageMembers');
    const current = await getRole(db, id, userId);
    if (!current) throw notFound('Member not found');
    if (current === 'owner' && (await ownerCount(id)) <= 1)
      throw conflict('A workspace needs at least one owner');
    await db
      .delete(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.userId, userId)));
    await announceMembership(id, userId);
    await ctx.sessions.membershipChanged(id, userId, null);
    await audit.record({
      workspaceId: id,
      actor: user,
      action: userId === user.id ? 'member.left' : 'member.removed',
      target: userId === user.id ? null : await nameOf(userId),
      meta: { role: current },
      req,
    });
    return { ok: true };
  });

  app.post('/api/workspaces/:id/invites', async (req, reply) => {
    const user = await requireUser(ctx, req);
    const { id } = req.params as { id: string };
    await authorize(db, id, user.id, 'workspace.manageMembers');
    const body = CreateInviteSchema.parse(req.body);
    const workspace = await workspaceFor(user.id, id);
    if (workspace.mode === 'solo')
      throw conflict('This is a Solo workspace: switch it to Team or Adaptive to invite people');
    const guideUrl = `${config.PUBLIC_URL}/docs/getting-started/`;

    // Someone who already has an account joins straight away.
    const matches = [];
    if (body.githubLogin)
      matches.push(sql`lower(${users.githubLogin}) = lower(${body.githubLogin})`);
    if (body.email)
      matches.push(
        sql`(lower(${users.email}) = lower(${body.email}) and ${users.emailVerifiedAt} is not null)`,
      );
    const [existing] = await db
      .select()
      .from(users)
      .where(sql.join(matches, sql` or `));
    if (existing) {
      if (await getRole(db, id, existing.id))
        throw conflict(`${existing.name} is already a member`);
      await db.transaction(async (tx) => {
        await tx
          .insert(workspaceMembers)
          .values({ workspaceId: id, userId: existing.id, role: body.role });
        await tx
          .insert(orgMembers)
          .values({ orgId: workspace.orgId, userId: existing.id, role: 'member' })
          .onConflictDoNothing();
      });
      if (existing.email) {
        // In their language when they set one; else the inviter's (likely the team's).
        const tt = tFor(existing.locale ?? currentLocale());
        const v = { name: user.name, workspace: workspace.name, role: tt(ROLE_WORDS[body.role]) };
        await mailer.send(
          actionMail(
            existing.email,
            tt('{name} added you to {workspace} on Kovan', v),
            tt(
              '{name} added you to {workspace} as {role}. Open Kovan on your computer or phone: {workspace} is in your workspaces now.',
              v,
            ),
            tt('How to get started'),
            guideUrl,
            tt,
          ),
        );
      }
      await announceMembership(id, existing.id);
      await audit.record({
        workspaceId: id,
        actor: user,
        action: 'member.added',
        target: existing.name,
        meta: { role: body.role },
        req,
      });
      return reply.code(201).send({
        member: {
          userId: existing.id,
          name: existing.name,
          githubLogin: existing.githubLogin,
          avatarUrl: existing.avatarUrl,
          role: body.role,
          kind: memberKind(existing.kind),
        } satisfies Member,
      });
    }

    // A link anyone holding it can join with, signed in as whoever they are (an Apple private
    // address, another email): the inviter gets it once, to send it themselves when no email can.
    const token = randomToken();
    const link = `${config.PUBLIC_URL}/join/?t=${token}`;
    const [invite] = await db
      .insert(invites)
      .values({
        workspaceId: id,
        githubLogin: body.githubLogin ?? null,
        email: body.email ?? null,
        role: body.role,
        invitedBy: user.id,
        tokenHash: sha256(token),
      })
      .returning();
    if (body.email) {
      const v = { name: user.name, workspace: workspace.name, role: t(ROLE_WORDS[body.role]) };
      await mailer.send(
        actionMail(
          body.email,
          t('{name} invited you to {workspace} on Kovan', v),
          [
            t('{name} invited you to work on {workspace} in Kovan, as {role}.', v),
            t(
              'Kovan is where a team and its AI coding agents work on the same code together; you can follow it from your phone too.',
            ),
            t(
              'The page below says what you need and lets you join with the account you sign in with.',
            ),
            t('The invite works until it is used or {name} takes it back.', v),
          ].join('\n\n'),
          t('See the invite'),
          link,
          t,
        ),
      );
    }
    hub.sendWorkspace(id, { type: 'members', workspaceId: id });
    await audit.record({
      workspaceId: id,
      actor: user,
      action: 'invite.created',
      target: body.email ?? `@${body.githubLogin}`,
      meta: { role: body.role },
      req,
    });
    return reply.code(201).send({ invite: { ...toInvite(invite!), link } });
  });

  // ---------- invite links ----------

  async function inviteByToken(token: string) {
    const [row] = token
      ? await db
          .select()
          .from(invites)
          .where(eq(invites.tokenHash, sha256(token)))
      : [];
    if (!row) throw notFound('This invite link is not valid. Ask for a new one.');
    return row;
  }

  // What an invite link shows before anyone signs in: whose workspace, which role.
  app.get('/api/invites/lookup', async (req): Promise<InviteLookup> => {
    const { t = '' } = req.query as { t?: string };
    const row = await inviteByToken(t);
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, row.workspaceId));
    if (!ws) throw notFound('This workspace no longer exists.');
    return {
      status: row.revokedAt ? 'revoked' : row.acceptedAt ? 'accepted' : 'pending',
      workspaceName: ws.name,
      repoUrl: ws.repoUrl,
      inviterName: row.invitedBy ? await nameOf(row.invitedBy) : null,
      role: row.role,
      sentTo: row.email ?? `@${row.githubLogin}`,
    };
  });

  // Joins with the invite link, as whoever is signed in.
  app.post('/api/invites/accept', async (req) => {
    const user = await requireUser(ctx, req);
    const { token } = z.object({ token: z.string().min(10).max(200) }).parse(req.body);
    const row = await inviteByToken(token);
    if (row.revokedAt) throw conflict('This invite was taken back. Ask for a new one.');
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, row.workspaceId));
    if (!ws) throw notFound('This workspace no longer exists.');
    if (row.acceptedAt && row.acceptedBy !== user.id)
      throw conflict('Someone already joined with this invite. Ask for a new one.');
    if (!(await getRole(db, ws.id, user.id))) {
      await db.transaction(async (tx) => {
        await tx
          .insert(workspaceMembers)
          .values({ workspaceId: ws.id, userId: user.id, role: row.role })
          .onConflictDoNothing();
        await tx
          .insert(orgMembers)
          .values({ orgId: ws.orgId, userId: user.id, role: 'member' })
          .onConflictDoNothing();
        await tx
          .update(invites)
          .set({ acceptedAt: new Date(), acceptedBy: user.id })
          .where(eq(invites.id, row.id));
      });
      await announceMembership(ws.id, user.id);
      await audit.record({
        workspaceId: ws.id,
        actor: user,
        action: 'invite.accepted',
        target: user.name,
        meta: { role: row.role },
        req,
      });
    }
    return {
      workspaceId: ws.id,
      workspaceName: ws.name,
      role: (await getRole(db, ws.id, user.id)) ?? row.role,
    };
  });

  app.delete('/api/workspaces/:id/invites/:inviteId', async (req) => {
    const user = await requireUser(ctx, req);
    const { id, inviteId } = req.params as { id: string; inviteId: string };
    await authorize(db, id, user.id, 'workspace.manageMembers');
    const [revoked] = await db
      .update(invites)
      .set({ revokedAt: new Date() })
      .where(and(eq(invites.id, inviteId), eq(invites.workspaceId, id), isNull(invites.acceptedAt)))
      .returning();
    if (!revoked) throw notFound('Invite not found');
    hub.sendWorkspace(id, { type: 'members', workspaceId: id });
    await audit.record({
      workspaceId: id,
      actor: user,
      action: 'invite.revoked',
      target: revoked.email ?? `@${revoked.githubLogin}`,
      req,
    });
    return { ok: true };
  });

  // ---------- API keys (owners) ----------

  app.get('/api/workspaces/:id/api-keys', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = WorkspaceIdParams.parse(req.params);
    await authorize(db, id, user.id, 'workspace.manageSettings');
    return { keys: await ctx.apiKeys.list({ workspaceId: id }) };
  });
  app.post('/api/workspaces/:id/api-keys', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = WorkspaceIdParams.parse(req.params);
    await authorize(db, id, user.id, 'workspace.manageSettings');
    const created = await ctx.apiKeys.create(
      { workspaceId: id },
      user,
      CreateApiKeySchema.parse(req.body),
    );
    await audit.record({
      workspaceId: id,
      actor: user,
      action: 'api_key.created',
      target: created.key.name,
      meta: { scopes: created.key.scopes.join(' ') },
      req,
    });
    return created;
  });
  app.delete('/api/workspaces/:id/api-keys/:keyId', async (req) => {
    const user = await requireUser(ctx, req);
    const { id, keyId } = z
      .object({ id: z.string().uuid(), keyId: z.string().uuid() })
      .parse(req.params);
    await authorize(db, id, user.id, 'workspace.manageSettings');
    const revoked = await ctx.apiKeys.revoke({ workspaceId: id }, keyId);
    await audit.record({
      workspaceId: id,
      actor: user,
      action: 'api_key.revoked',
      target: revoked.name,
      req,
    });
    return { ok: true };
  });

  // ---------- usage ----------

  app.post('/api/usage', async (req, reply) => {
    const user = await requireUser(ctx, req);
    const report = UsageReportSchema.parse(req.body);
    // Usage can only be filed against a workspace the person belongs to.
    if (report.workspaceId) await authorize(db, report.workspaceId, user.id, 'session.view');
    await db.insert(usageRecords).values(
      report.records.map((r) => ({
        ...r,
        userId: user.id,
        workspaceId: report.workspaceId,
        conversationId: report.conversationId,
      })),
    );
    return reply.code(204).send();
  });

  app.get('/api/usage', async (req) => {
    const user = await requireUser(ctx, req);
    const { days: daysText = '30' } = req.query as { days?: string };
    const days = Math.min(365, Math.max(1, Number(daysText) || 30));
    const since = new Date(Date.now() - days * 86_400_000);
    const mine = and(eq(usageRecords.userId, user.id), gte(usageRecords.createdAt, since));
    const byModel = await db
      .select({
        model: usageRecords.model,
        cost: sql<number>`sum(${usageRecords.cost})`.mapWith(Number),
        calls: count(),
        promptTokens: sql<number>`sum(${usageRecords.promptTokens})`.mapWith(Number),
        completionTokens: sql<number>`sum(${usageRecords.completionTokens})`.mapWith(Number),
      })
      .from(usageRecords)
      .where(mine)
      .groupBy(usageRecords.model)
      .orderBy(sql`sum(${usageRecords.cost}) desc`);
    const byWorkspace = await db
      .select({
        workspaceId: usageRecords.workspaceId,
        name: workspaces.name,
        cost: sql<number>`sum(${usageRecords.cost})`.mapWith(Number),
      })
      .from(usageRecords)
      .leftJoin(workspaces, eq(workspaces.id, usageRecords.workspaceId))
      .where(mine)
      .groupBy(usageRecords.workspaceId, workspaces.name)
      .orderBy(sql`sum(${usageRecords.cost}) desc`);
    const byDay = await db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${usageRecords.createdAt}), 'YYYY-MM-DD')`,
        cost: sql<number>`sum(${usageRecords.cost})`.mapWith(Number),
      })
      .from(usageRecords)
      .where(mine)
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    const summary: UsageSummary = {
      days,
      total: byModel.reduce((s, m) => s + m.cost, 0),
      calls: byModel.reduce((s, m) => s + m.calls, 0),
      byModel,
      byWorkspace,
      byDay,
    };
    return summary;
  });

  // ---------- error reports ----------

  app.post('/api/error-reports', async (req, reply) => {
    const user = await requireUser(ctx, req);
    if (!user.errorReports) return reply.code(204).send();
    const report = ErrorReportSchema.parse(req.body);
    await db.insert(errorReports).values({ userId: user.id, ...report });
    return reply.code(204).send();
  });
}
