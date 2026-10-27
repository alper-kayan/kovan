import { can, type Action, type Role } from '@kovan/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { workspaceMembers } from './db/schema.js';
import { forbidden, notFound } from './errors.js';

export async function getRole(db: Db, workspaceId: string, userId: string): Promise<Role | null> {
  const [row] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  return row?.role ?? null;
}

/**
 * Checks the caller's current role against the action, reading it fresh from the database on
 * every call, so a role change applies to the very next request. Non-members get 404 so
 * workspace ids don't leak.
 */
export async function authorize(
  db: Db,
  workspaceId: string,
  userId: string,
  action: Action,
): Promise<Role> {
  const role = await getRole(db, workspaceId, userId);
  if (!role) throw notFound('Workspace not found');
  if (!can(role, action)) throw forbidden();
  return role;
}
