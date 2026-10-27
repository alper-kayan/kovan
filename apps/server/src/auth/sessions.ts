import { and, eq, gt, isNull } from 'drizzle-orm';
import { randomToken, sha256 } from '../crypto.js';
import type { Db } from '../db/client.js';
import { authSessions, users } from '../db/schema.js';
import type { UserRow } from '../users.js';

const SESSION_DAYS = 60;

export async function createSession(
  db: Db,
  userId: string,
  machineId: string | null,
): Promise<string> {
  const token = `kvn_${randomToken()}`;
  await db.insert(authSessions).values({
    userId,
    tokenHash: sha256(token),
    machineId,
    expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000),
  });
  return token;
}

/** The user behind a session token, or null when it is unknown, expired or revoked. */
export async function authenticate(db: Db, token: string): Promise<UserRow | null> {
  const [row] = await db
    .select({ user: users, sessionId: authSessions.id, lastSeenAt: authSessions.lastSeenAt })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(
      and(
        eq(authSessions.tokenHash, sha256(token)),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, new Date()),
      ),
    );
  if (!row) return null;
  if (Date.now() - row.lastSeenAt.getTime() > 3_600_000) {
    await db
      .update(authSessions)
      .set({ lastSeenAt: new Date() })
      .where(eq(authSessions.id, row.sessionId));
  }
  return row.user;
}

/** The sign-in a token belongs to, while it is valid. */
export async function sessionIdOf(db: Db, token: string): Promise<string | null> {
  const [row] = await db
    .select({ id: authSessions.id })
    .from(authSessions)
    .where(
      and(
        eq(authSessions.tokenHash, sha256(token)),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, new Date()),
      ),
    );
  return row?.id ?? null;
}

export async function revokeSession(db: Db, token: string): Promise<void> {
  await db
    .update(authSessions)
    .set({ revokedAt: new Date() })
    .where(eq(authSessions.tokenHash, sha256(token)));
}
