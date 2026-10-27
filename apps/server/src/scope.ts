import { and, eq, inArray, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { Db } from './db/client.js';
import { orgMembers, workspaces } from './db/schema.js';
import { forbidden, notFound } from './errors.js';

/**
 * What an integration (API key, webhook, machine) belongs to: one workspace, or a whole
 * organization, whose workspaces it covers, those made later too.
 */
export type Scope = { workspaceId: string } | { orgId: string };

export const isOrg = (scope: Scope): scope is { orgId: string } => 'orgId' in scope;

/** The rows of a table that belong to this scope. */
export function inScope(table: { workspaceId: PgColumn; orgId: PgColumn }, scope: Scope): SQL {
  return isOrg(scope) ? eq(table.orgId, scope.orgId) : eq(table.workspaceId, scope.workspaceId);
}

/** "workspace" or "organization", as people read it in messages. */
export const scopeWord = (scope: Scope) => (isOrg(scope) ? 'An organization' : 'A workspace');

export async function orgWorkspaceIds(db: Db, orgId: string): Promise<string[]> {
  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.orgId, orgId));
  return rows.map((r) => r.id);
}

export async function orgOfWorkspace(db: Db, workspaceId: string): Promise<string | null> {
  const [row] = await db
    .select({ orgId: workspaces.orgId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  return row?.orgId ?? null;
}

/** Only an organization's owners set up its integrations; others get 404 or 403. */
export async function requireOrgOwner(db: Db, orgId: string, userId: string): Promise<void> {
  const [row] = /^[0-9a-f-]{36}$/i.test(orgId)
    ? await db
        .select({ role: orgMembers.role })
        .from(orgMembers)
        .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    : [];
  if (!row) throw notFound('Organization not found');
  if (row.role !== 'owner') throw forbidden('Only the organization’s owners can do this');
}

/** The workspaces of an organization this person (or key) is a member of. */
export async function visibleOrgWorkspaces(
  db: Db,
  orgId: string,
  memberWorkspaces: string[],
): Promise<string[]> {
  if (memberWorkspaces.length === 0) return [];
  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.orgId, orgId), inArray(workspaces.id, memberWorkspaces)));
  return rows.map((r) => r.id);
}
