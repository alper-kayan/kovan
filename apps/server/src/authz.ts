import { can, type Action, type Role } from '@kovan/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { users, workspaceMembers, workspaces } from './db/schema.js';
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

/**
 * Whether someone may act on an agent's lane that isn't theirs: approve its commands or give it
 * work (which runs, and is paid for, on that person's account). The lane's own person and whoever
 * runs an AI teammate always may; otherwise owners, and every editor too when the workspace says
 * so. Throws, saying who may, when they can't.
 */
export async function authorizeLane(
  db: Db,
  workspaceId: string,
  userId: string,
  action: 'approval.answer' | 'agent.steer',
  lane: { userId: string; hostId: string | null },
): Promise<Role> {
  const role = await authorize(db, workspaceId, userId, action);
  if (userId === lane.userId || userId === lane.hostId || role === 'owner') return role;
  const [ws] = await db
    .select({ othersAgents: workspaces.othersAgents, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (ws?.othersAgents === 'editors') return role;
  const [person] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, lane.hostId ?? lane.userId));
  throw forbidden(
    `In ${ws?.name ?? 'this workspace'}, only ${person?.name ?? 'its person'} and the workspace's owners ${action === 'approval.answer' ? 'answer for' : 'give work to'} that agent. An owner can let editors do it too, in Settings → Workspaces.`,
  );
}
