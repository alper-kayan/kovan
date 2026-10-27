import type { ApiKey, ApiKeyScope } from '@kovan/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { randomToken, sha256 } from './crypto.js';
import type { Db } from './db/client.js';
import { apiKeys, machines, users, workspaceMembers } from './db/schema.js';
import { conflict, forbidden, notFound } from './errors.js';
import { inScope, isOrg, orgWorkspaceIds, scopeWord, type Scope } from './scope.js';
import type { UserRow } from './users.js';

export const API_KEY_PREFIX = 'kv_live_';
/** Keys a workspace may have at once. */
export const MAX_API_KEYS = 20;

/**
 * The requests a key may make beyond reading, by scope. Anything not listed (members, roles,
 * settings, billing, account, other keys, model calls) is refused to every key, whatever its
 * scopes: a key drives work, it doesn't administer the workspace.
 */
const WRITES: Record<string, ApiKeyScope[]> = {
  'POST /api/workspaces/:id/sessions': ['dispatch'],
  'PUT /api/sessions/:id/swarm': ['dispatch'],
  'POST /api/swarms/:id/launch': ['dispatch'],
  'POST /api/sessions/:id/end': ['control', 'machine'],
  'POST /api/sessions/:id/steer': ['control'],
  'POST /api/swarms/:id/status': ['control', 'machine'],
  'POST /api/swarms/:id/control': ['control'],
  'POST /api/plan-steps/:id/assign': ['control'],
  // A machine registers, reports in and does the work of the swarms sent to it.
  'POST /api/workspaces/:id/machines': ['machine'],
  'POST /api/machines/:id/heartbeat': ['machine'],
  'POST /api/orgs/:id/machines': ['machine'],
  'PUT /api/sessions/:id/checkout': ['machine'],
  'PUT /api/sessions/:id/changes': ['machine'],
  'POST /api/swarms/:id/messages': ['machine'],
  'POST /api/swarms/:id/messages/delivered': ['machine'],
  'POST /api/swarms/:id/agents': ['machine'],
  // Git through Kovan: fetching is reading, pushing is a machine's work.
  'POST /api/workspaces/:id/git/git-upload-pack': ['read', 'machine'],
  'POST /api/workspaces/:id/git/git-receive-pack': ['machine'],
  'POST /api/swarms/:id/report': ['machine'],
  'PATCH /api/plan-steps/:id': ['machine'],
  'POST /api/sessions/:id/plan/steps': ['machine'],
  'POST /api/sessions/:id/subagents': ['machine'],
  'PATCH /api/subagents/:id': ['machine'],
  'POST /api/subagents/:id/integrate': ['machine'],
  'POST /api/workspaces/:id/learnings': ['machine'],
  'POST /api/agents/:id/spend': ['machine'],
  'POST /api/usage': ['machine'],
};

/** Whether a key with these scopes may make this request. */
export function keyMay(scopes: readonly ApiKeyScope[], req: FastifyRequest): boolean {
  // A machine reads what its work needs.
  if (req.method === 'GET' || req.method === 'HEAD')
    return scopes.includes('read') || scopes.includes('machine');
  const needed = WRITES[`${req.method} ${req.routeOptions.url ?? ''}`];
  return needed !== undefined && needed.some((s) => scopes.includes(s));
}

/** A key that can start, steer or run work joins as an editor; a read-only one as a viewer. */
const roleFor = (scopes: readonly ApiKeyScope[]): 'editor' | 'viewer' =>
  scopes.some((s) => s !== 'read') ? 'editor' : 'viewer';

/** Last-used times are written at most this often per key. */
const TOUCH_MS = 60_000;

export class ApiKeys {
  constructor(private readonly db: Db) {}

  /** The member a valid key acts as, and what it may do; null for an unknown or revoked key. */
  async authenticate(token: string): Promise<{ user: UserRow; scopes: ApiKeyScope[] } | null> {
    if (!token.startsWith(API_KEY_PREFIX)) return null;
    const [row] = await this.db
      .select({ key: apiKeys, user: users })
      .from(apiKeys)
      .innerJoin(users, eq(users.id, apiKeys.userId))
      .where(and(eq(apiKeys.tokenHash, sha256(token)), isNull(apiKeys.revokedAt)));
    if (!row) return null;
    if (!row.key.lastUsedAt || Date.now() - row.key.lastUsedAt.getTime() > TOUCH_MS)
      await this.db
        .update(apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiKeys.id, row.key.id));
    return { user: row.user, scopes: row.key.scopes };
  }

  async list(scope: Scope): Promise<ApiKey[]> {
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(and(inScope(apiKeys, scope), isNull(apiKeys.revokedAt)))
      .orderBy(apiKeys.createdAt);
    return rows.map(toApiKey);
  }

  /** What a key's own member is: its name, scopes and what it covers. */
  async keyOf(userId: string) {
    const [row] = await this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)));
    return row ? { ...toApiKey(row), workspaceId: row.workspaceId, orgId: row.orgId } : null;
  }

  /**
   * Makes a key; the returned token is the only time anyone sees it. An organization's key
   * joins every workspace of it, and later ones as they are made.
   */
  async create(
    scope: Scope,
    by: { id: string; name: string },
    input: { name: string; scopes: ApiKeyScope[] },
  ): Promise<{ key: ApiKey; token: string }> {
    const active = await this.list(scope);
    if (active.length >= MAX_API_KEYS)
      throw conflict(`${scopeWord(scope)} can have ${MAX_API_KEYS} API keys; revoke one first.`);
    if (active.some((k) => k.name.toLowerCase() === input.name.toLowerCase()))
      throw conflict(`There is already a key called "${input.name}".`);
    const token = API_KEY_PREFIX + randomToken(32);
    const covered = isOrg(scope)
      ? await orgWorkspaceIds(this.db, scope.orgId)
      : [scope.workspaceId];
    const row = await this.db.transaction(async (tx) => {
      const [member] = await tx
        .insert(users)
        .values({ name: input.name, kind: 'service' })
        .returning();
      if (covered.length)
        await tx.insert(workspaceMembers).values(
          covered.map((workspaceId) => ({
            workspaceId,
            userId: member!.id,
            role: roleFor(input.scopes),
          })),
        );
      const [key] = await tx
        .insert(apiKeys)
        .values({
          ...(isOrg(scope) ? { orgId: scope.orgId } : { workspaceId: scope.workspaceId }),
          userId: member!.id,
          name: input.name,
          prefix: token.slice(0, API_KEY_PREFIX.length + 6),
          tokenHash: sha256(token),
          scopes: input.scopes,
          createdBy: by.id,
          createdByName: by.name,
        })
        .returning();
      return key!;
    });
    return { key: toApiKey(row), token };
  }

  /** A new workspace of an organization: its organization keys become members right away. */
  async joinNewWorkspace(workspaceId: string, orgId: string): Promise<void> {
    const keys = await this.db
      .select({ userId: apiKeys.userId, scopes: apiKeys.scopes })
      .from(apiKeys)
      .where(and(eq(apiKeys.orgId, orgId), isNull(apiKeys.revokedAt)));
    if (keys.length)
      await this.db
        .insert(workspaceMembers)
        .values(keys.map((k) => ({ workspaceId, userId: k.userId, role: roleFor(k.scopes) })))
        .onConflictDoNothing();
  }

  /** Revokes a key at once; what it started stays, credited to its name. */
  async revoke(scope: Scope, keyId: string): Promise<ApiKey> {
    const [row] = await this.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, keyId), inScope(apiKeys, scope), isNull(apiKeys.revokedAt)))
      .returning();
    if (!row) throw notFound('API key not found');
    // Its member leaves everything it was in, and machines that reported with it go too.
    await this.db.delete(workspaceMembers).where(eq(workspaceMembers.userId, row.userId));
    await this.db.delete(machines).where(eq(machines.userId, row.userId));
    return toApiKey(row);
  }
}

/** Refuses a request a key isn't allowed to make. */
export function keyRefused(): Error {
  return forbidden('This API key is not allowed to do this.');
}

function toApiKey(row: typeof apiKeys.$inferSelect): ApiKey {
  return {
    id: row.id,
    name: row.name,
    prefix: `${row.prefix}…`,
    scopes: row.scopes,
    createdByName: row.createdByName,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}
