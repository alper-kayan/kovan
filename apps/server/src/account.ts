import { ROLES, type AccountDeletionPlan, type Role } from '@kovan/shared';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from './context.js';
import type { Db } from './db/client.js';
import {
  aiAgents,
  identities,
  orgMembers,
  orgs,
  users,
  workspaceMembers,
  workspaces,
} from './db/schema.js';
import { conflict } from './errors.js';

export type DeletionPlan = AccountDeletionPlan;

const rank = (role: Role) => ROLES.indexOf(role);

/** The other people (not AI teammates) in a workspace, best candidate for owner first. */
async function othersIn(db: Db, workspaceId: string, userId: string) {
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      role: workspaceMembers.role,
      since: workspaceMembers.createdAt,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        ne(workspaceMembers.userId, userId),
        eq(users.kind, 'human'),
      ),
    )
    .orderBy(asc(workspaceMembers.createdAt));
  // Highest role first; among equals, whoever joined first.
  return rows.sort((a, b) => rank(b.role) - rank(a.role) || a.since.getTime() - b.since.getTime());
}

export async function planDeletion(ctx: AppContext, userId: string): Promise<DeletionPlan> {
  const { db } = ctx;
  const plan: DeletionPlan = {
    deleted: [],
    kept: [],
    orgsDeleted: [],
    orgsKept: [],
    unbilled: 0,
    blocker: null,
  };
  const mine = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      orgId: workspaces.orgId,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaces.name));
  for (const w of mine) {
    const others = await othersIn(db, w.id, userId);
    if (others.length === 0) {
      plan.deleted.push({ id: w.id, name: w.name });
      continue;
    }
    const otherOwner = others.some((o) => o.role === 'owner');
    const heir = w.role === 'owner' && !otherOwner ? others[0]! : null;
    plan.kept.push({
      id: w.id,
      name: w.name,
      owner: heir ? { id: heir.id, name: heir.name } : null,
    });
  }

  const gone = new Set(plan.deleted.map((w) => w.id));
  const myOrgs = await db
    .select({ id: orgs.id, name: orgs.name, role: orgMembers.role })
    .from(orgMembers)
    .innerJoin(orgs, eq(orgs.id, orgMembers.orgId))
    .where(eq(orgMembers.userId, userId));
  for (const o of myOrgs) {
    const left = (
      await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.orgId, o.id))
    ).filter((w) => !gone.has(w.id));
    const members = await db
      .select({
        id: users.id,
        name: users.name,
        role: orgMembers.role,
        since: orgMembers.createdAt,
      })
      .from(orgMembers)
      .innerJoin(users, eq(users.id, orgMembers.userId))
      .where(
        and(eq(orgMembers.orgId, o.id), ne(orgMembers.userId, userId), eq(users.kind, 'human')),
      )
      .orderBy(asc(orgMembers.createdAt));
    if (left.length === 0 && members.length === 0) {
      plan.orgsDeleted.push({ id: o.id, name: o.name });
      continue;
    }
    let owner: { id: string; name: string } | null = null;
    if (o.role === 'owner' && !members.some((m) => m.role === 'owner')) {
      // Whoever now owns one of its workspaces leads; else the longest-standing member.
      const heirs = new Set(plan.kept.flatMap((k) => (k.owner ? [k.owner.id] : [])));
      const pick = members.find((m) => heirs.has(m.id)) ?? members[0];
      // A kept org always has someone: a kept workspace has another person in it.
      owner = pick ? { id: pick.id, name: pick.name } : null;
    }
    plan.orgsKept.push({ id: o.id, name: o.name, owner });
  }

  const billing = await ctx.billing.beforeDeletion(userId);
  plan.unbilled = billing.unbilled;
  plan.blocker = billing.blocker;
  return plan;
}

/**
 * Deletes an account for good: the workspaces only this person was in (with their sessions,
 * transcripts and AI teammates), their memberships, sign-ins, phones and billing details.
 * Workspaces and orgs others are in stay, with a new owner where this person was the last one.
 * What they wrote in shared workspaces (comments, their lanes) goes with them.
 */
export async function deleteAccount(
  ctx: AppContext,
  user: { id: string; name: string },
  req?: FastifyRequest,
): Promise<DeletionPlan> {
  const plan = await planDeletion(ctx, user.id);
  if (plan.blocker) throw conflict(plan.blocker);
  const { db } = ctx;
  // Written first: the log keeps the actor's name once the account is gone.
  for (const w of plan.kept)
    await ctx.audit.record({
      workspaceId: w.id,
      actor: user,
      action: 'account.deleted',
      target: user.name,
      meta: { newOwner: w.owner?.name ?? null },
      ...(req ? { req } : {}),
    });
  await ctx.billing.settleBeforeDeletion(user.id);
  await ctx.billing.forget(user.id);
  // Apple asks apps to revoke Sign in with Apple when the account goes (after it is gone here).
  const apple = await db
    .select({ token: identities.accessTokenEnc })
    .from(identities)
    .where(and(eq(identities.userId, user.id), eq(identities.provider, 'apple')));
  await db.transaction(async (tx) => {
    for (const w of plan.kept)
      if (w.owner)
        await tx
          .update(workspaceMembers)
          .set({ role: 'owner' })
          .where(
            and(eq(workspaceMembers.workspaceId, w.id), eq(workspaceMembers.userId, w.owner.id)),
          );
    for (const o of plan.orgsKept)
      if (o.owner)
        await tx
          .update(orgMembers)
          .set({ role: 'owner' })
          .where(and(eq(orgMembers.orgId, o.id), eq(orgMembers.userId, o.owner.id)));
    const gone = plan.deleted.map((w) => w.id);
    if (gone.length > 0) {
      // AI teammates are accounts of their own, made for one workspace: they go with it.
      const agents = await tx
        .select({ id: aiAgents.userId })
        .from(aiAgents)
        .where(inArray(aiAgents.workspaceId, gone));
      await tx.delete(workspaces).where(inArray(workspaces.id, gone));
      if (agents.length > 0)
        await tx.delete(users).where(
          inArray(
            users.id,
            agents.map((a) => a.id),
          ),
        );
    }
    if (plan.orgsDeleted.length > 0)
      await tx.delete(orgs).where(
        inArray(
          orgs.id,
          plan.orgsDeleted.map((o) => o.id),
        ),
      );
    await tx.delete(users).where(eq(users.id, user.id));
  });

  for (const w of plan.kept)
    if (w.owner)
      ctx.hub.sendUser(w.owner.id, { type: 'membership', workspaceId: w.id, role: 'owner' });
  ctx.hub.signOutUser(user.id);
  for (const { token } of apple) {
    if (!token) {
      console.warn(`Account ${user.id} deleted; its Apple sign-in had no token to revoke`);
      continue;
    }
    await ctx.apple
      .revoke(ctx.enc.decrypt(token))
      .catch((error: unknown) =>
        console.warn(
          `Account ${user.id} deleted; revoking its Apple sign-in failed: ${String(error)}`,
        ),
      );
  }
  return plan;
}
