import type { User } from '@kovan/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Encryptor } from './crypto.js';
import type { Db } from './db/client.js';
import {
  identities,
  invites,
  orgMembers,
  orgs,
  users,
  workspaceMembers,
  workspaces,
} from './db/schema.js';
import { conflict } from './errors.js';

export type UserRow = typeof users.$inferSelect;

/**
 * How apps see a member: a person or not. An API key's service member is never listed as one,
 * and apps only know these two kinds.
 */
export const memberKind = (kind: UserRow['kind']): 'human' | 'agent' =>
  kind === 'human' ? 'human' : 'agent';

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    emailVerified: row.emailVerifiedAt !== null,
    avatarUrl: row.avatarUrl,
    githubLogin: row.githubLogin,
    onboarding: row.onboarding,
    errorReports: row.errorReports,
  };
}

/** What a sign-in provider tells us about a person. */
export interface Profile {
  provider: 'github' | 'google' | 'apple' | 'email';
  providerUserId: string;
  name: string;
  email: string | null;
  emailVerified: boolean;
  avatarUrl: string | null;
  login: string | null;
  accessToken: string | null;
  scopes: string | null;
}

export async function getUser(db: Db, id: string): Promise<UserRow | null> {
  const [row] = await db.select().from(users).where(eq(users.id, id));
  return row ?? null;
}

async function findUserByEmail(db: Db, email: string): Promise<UserRow | null> {
  const [row] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`);
  return row ?? null;
}

/** Workspace memberships created by pending invites that match this person. */
export async function acceptPendingInvites(db: Db, user: UserRow): Promise<string[]> {
  const matches = [];
  if (user.githubLogin)
    matches.push(sql`lower(${invites.githubLogin}) = lower(${user.githubLogin})`);
  if (user.email && user.emailVerifiedAt)
    matches.push(sql`lower(${invites.email}) = lower(${user.email})`);
  if (matches.length === 0) return [];

  const pending = await db
    .select()
    .from(invites)
    .where(
      and(
        isNull(invites.acceptedAt),
        isNull(invites.revokedAt),
        sql`(${sql.join(matches, sql` or `)})`,
      ),
    );
  const joined: string[] = [];
  for (const invite of pending) {
    await db.transaction(async (tx) => {
      const [workspace] = await tx
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, invite.workspaceId));
      if (!workspace) return;
      await tx
        .insert(workspaceMembers)
        .values({ workspaceId: invite.workspaceId, userId: user.id, role: invite.role })
        .onConflictDoNothing();
      await tx
        .insert(orgMembers)
        .values({ orgId: workspace.orgId, userId: user.id, role: 'member' })
        .onConflictDoNothing();
      await tx
        .update(invites)
        .set({ acceptedAt: new Date(), acceptedBy: user.id })
        .where(eq(invites.id, invite.id));
    });
    joined.push(invite.workspaceId);
  }
  return joined;
}

async function storeIdentity(
  db: Db,
  enc: Encryptor,
  userId: string,
  profile: Profile,
): Promise<void> {
  const values = {
    login: profile.login,
    email: profile.email,
    // A sign-in that brought no token keeps the one stored (Apple's, needed to revoke later).
    ...(profile.accessToken ? { accessTokenEnc: enc.encrypt(profile.accessToken) } : {}),
    scopes: profile.scopes,
  };
  await db
    .insert(identities)
    .values({
      userId,
      provider: profile.provider,
      providerUserId: profile.providerUserId,
      ...values,
    })
    .onConflictDoUpdate({ target: [identities.provider, identities.providerUserId], set: values });
}

/** Fills in profile facts the user doesn't have yet (and marks a provider-verified email). */
async function enrichUser(db: Db, user: UserRow, profile: Profile): Promise<UserRow> {
  const patch: Partial<typeof users.$inferInsert> = {};
  if (profile.provider === 'github' && profile.login && user.githubLogin !== profile.login) {
    patch.githubLogin = profile.login;
  }
  if (!user.avatarUrl && profile.avatarUrl) patch.avatarUrl = profile.avatarUrl;
  if (!user.email && profile.email) patch.email = profile.email;
  const sameEmail = profile.email && user.email?.toLowerCase() === profile.email.toLowerCase();
  if (
    !user.emailVerifiedAt &&
    profile.emailVerified &&
    (sameEmail || (!user.email && profile.email))
  ) {
    patch.emailVerifiedAt = new Date();
  }
  if (Object.keys(patch).length === 0) return user;
  try {
    const [updated] = await db.update(users).set(patch).where(eq(users.id, user.id)).returning();
    return updated!;
  } catch (error) {
    if (String(error).includes('users_github_login_unique')) {
      throw conflict(`GitHub account @${profile.login} is already linked to another Kovan account`);
    }
    throw error;
  }
}

/**
 * Signs a person in from a provider profile: the existing identity's user, else the user with
 * the same verified email (linking this provider), else a new user with a personal org.
 */
export async function signInWithProfile(
  db: Db,
  enc: Encryptor,
  profile: Profile,
): Promise<UserRow> {
  const [existing] = await db
    .select({ user: users })
    .from(identities)
    .innerJoin(users, eq(users.id, identities.userId))
    .where(
      and(
        eq(identities.provider, profile.provider),
        eq(identities.providerUserId, profile.providerUserId),
      ),
    );

  let user = existing?.user ?? null;
  if (!user && profile.email && profile.emailVerified)
    user = await findUserByEmail(db, profile.email);
  if (!user) {
    user = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(users)
        .values({
          name: profile.name,
          email: profile.email,
          emailVerifiedAt: profile.emailVerified ? new Date() : null,
          avatarUrl: profile.avatarUrl,
          githubLogin: profile.provider === 'github' ? profile.login : null,
        })
        .returning();
      const [org] = await tx
        .insert(orgs)
        .values({ name: `${profile.name}'s Team`, createdBy: created!.id })
        .returning();
      await tx.insert(orgMembers).values({ orgId: org!.id, userId: created!.id, role: 'owner' });
      return created!;
    });
  } else {
    user = await enrichUser(db, user, profile);
  }
  await storeIdentity(db, enc, user.id, profile);
  await acceptPendingInvites(db, user);
  return user;
}

/** Connects another provider to a signed-in user ("Connect GitHub"). */
export async function linkProfile(
  db: Db,
  enc: Encryptor,
  userId: string,
  profile: Profile,
): Promise<UserRow> {
  const [owner] = await db
    .select({ userId: identities.userId })
    .from(identities)
    .where(
      and(
        eq(identities.provider, profile.provider),
        eq(identities.providerUserId, profile.providerUserId),
      ),
    );
  if (owner && owner.userId !== userId) {
    throw conflict(`That ${profile.provider} account is already linked to another Kovan account`);
  }
  const user = await getUser(db, userId);
  if (!user) throw conflict('Account not found');
  const enriched = await enrichUser(db, user, profile);
  await storeIdentity(db, enc, userId, profile);
  await acceptPendingInvites(db, enriched);
  return enriched;
}
