import type { AuditEntry } from '@kovan/shared';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { Db } from './db/client.js';
import { auditLog, workspaces } from './db/schema.js';

/** Audit lines are kept this long, whatever the transcript retention is. */
export const AUDIT_RETENTION_DAYS = 400;

export interface AuditInput {
  /** The org it belongs to; worked out from the workspace when left out. */
  orgId?: string | null;
  workspaceId?: string | null;
  actor: { id: string; name: string };
  action: string;
  target?: string | null;
  meta?: Record<string, string | number | boolean | null>;
  /** Pass the request to record where it came from. */
  req?: FastifyRequest;
}

/**
 * The record of who changed what. Writing never fails the request it describes: a log that
 * can't be written is reported and the action still stands.
 */
export class AuditLog {
  constructor(
    private readonly db: Db,
    private readonly log: (message: string) => void = () => {},
  ) {}

  async record(input: AuditInput): Promise<void> {
    try {
      let orgId = input.orgId ?? null;
      if (!orgId && input.workspaceId) {
        const [row] = await this.db
          .select({ orgId: workspaces.orgId })
          .from(workspaces)
          .where(eq(workspaces.id, input.workspaceId));
        orgId = row?.orgId ?? null;
      }
      await this.db.insert(auditLog).values({
        orgId,
        workspaceId: input.workspaceId ?? null,
        actorId: input.actor.id,
        actorName: input.actor.name,
        action: input.action,
        target: input.target?.slice(0, 200) ?? null,
        meta: input.meta ?? null,
        ip: input.req?.ip ?? null,
      });
    } catch (error) {
      this.log(`Could not write audit log (${input.action}): ${String(error)}`);
    }
  }

  /** Newest first; pass the last line's time as `before` for the next page. */
  async list(
    orgId: string,
    options: { before?: Date; limit?: number } = {},
  ): Promise<AuditEntry[]> {
    const rows = await this.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.orgId, orgId),
          options.before ? lt(auditLog.createdAt, options.before) : undefined,
        ),
      )
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(Math.min(options.limit ?? 50, 200));
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      actorId: r.actorId,
      actorName: r.actorName,
      action: r.action,
      target: r.target,
      meta: r.meta ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async sweep(days = AUDIT_RETENTION_DAYS): Promise<void> {
    await this.db
      .delete(auditLog)
      .where(sql`${auditLog.createdAt} < now() - make_interval(days => ${days})`);
  }
}
