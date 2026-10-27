import { redactText, type WorkspaceEvent, type WorkspaceEventType } from '@kovan/shared';
import { and, desc, eq, gt, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { EventEmitter } from 'node:events';
import type { Encryptor } from '../crypto.js';
import { randomToken } from '../crypto.js';
import type { Db } from '../db/client.js';
import { sessions, webhookDeliveries, webhooks, workspaceEvents } from '../db/schema.js';
import { conflict, notFound } from '../errors.js';
import { inScope, isOrg, orgOfWorkspace, scopeWord, type Scope } from '../scope.js';
import { deliver, type Outcome } from './deliver.js';

/** Wait before each attempt after the first; then the delivery is given up as failed. */
export const RETRY_DELAYS_S = [10, 30, 120, 600, 1800, 3600, 3 * 3600];
/** Events are kept this long for the stream; deliveries go with them. */
export const EVENT_TTL_MS = 14 * 24 * 3_600_000;
export const MAX_WEBHOOKS = 10;
/** A delivery being sent is leased this long, so a crash mid-send retries it later. */
const LEASE_MS = 60_000;

type Send = typeof deliver;

/** Where services report what happened; the default does nothing (tests, tools). */
export interface EventSink {
  /** An event about a session; its branch, pull request and issue are added. */
  session(sessionId: string, type: WorkspaceEventType, extra?: Record<string, unknown>): void;
}
export const NO_EVENTS: EventSink = { session: () => undefined };

/**
 * Workspace events for other systems: each is stored for the stream and queued for every
 * webhook that wants it. Deliveries are signed, retried with growing waits, and their
 * attempts are kept so an owner can see what happened.
 */
export class WorkspaceEvents implements EventSink {
  private readonly appended = new EventEmitter();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private again = false;
  private closed = false;

  constructor(
    private readonly db: Db,
    private readonly enc: Encryptor,
    private readonly allow: readonly string[],
    private readonly send: Send = deliver,
    private readonly onError: (message: string) => void = () => undefined,
  ) {
    this.appended.setMaxListeners(0);
  }

  start(): void {
    this.timer = setInterval(() => this.kick(), 5_000);
    this.timer.unref();
    this.kick();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.appended.removeAllListeners();
  }

  session(sessionId: string, type: WorkspaceEventType, extra: Record<string, unknown> = {}): void {
    void this.emitSession(sessionId, type, extra).catch((e: unknown) =>
      this.onError(`event ${type}: ${e instanceof Error ? e.message : String(e)}`),
    );
  }

  async emitSession(
    sessionId: string,
    type: WorkspaceEventType,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const [row] = await this.db.select().from(sessions).where(eq(sessions.id, sessionId));
    if (!row) return;
    await this.emit(row.workspaceId, type, {
      sessionId,
      title: row.title,
      branch: row.branch,
      // The registered machine running it (agentd); null on people's desktops.
      machineId: row.machineId,
      prUrl: row.prUrl,
      prState: row.prState,
      issue: row.issueNumber ? { number: row.issueNumber, url: row.issueUrl } : null,
      ...extra,
    });
  }

  /** Stores an event and queues it for the webhooks that want it. */
  async emit(workspaceId: string, type: WorkspaceEventType, data: Record<string, unknown>) {
    const [event] = await this.db
      .insert(workspaceEvents)
      .values({ workspaceId, type, data })
      .returning();
    // The workspace's own webhooks and its organization's.
    const orgId = await orgOfWorkspace(this.db, workspaceId);
    const hooks = await this.db
      .select({ id: webhooks.id, events: webhooks.events })
      .from(webhooks)
      .where(
        orgId
          ? or(eq(webhooks.workspaceId, workspaceId), eq(webhooks.orgId, orgId))
          : eq(webhooks.workspaceId, workspaceId),
      );
    const wanted = hooks.filter((h) => h.events.length === 0 || h.events.includes(type));
    if (wanted.length) {
      const body = JSON.stringify(toEvent(event!));
      await this.db.insert(webhookDeliveries).values(
        wanted.map((h) => ({
          webhookId: h.id,
          eventId: event!.id,
          type,
          body,
          nextAttemptAt: new Date(),
        })),
      );
      this.kick();
    }
    this.appended.emit(workspaceId);
  }

  // ---------- the stream ----------

  /**
   * Events of these workspaces (one, or an organization's) after `since`, oldest first.
   * Without `since`, the newest `limit`. With `waitS`, an empty answer waits up to that long
   * for the next event instead of making the caller poll.
   */
  async stream(
    workspaceIds: string[],
    options: { since: number | null; limit: number; waitS: number },
  ): Promise<{ events: WorkspaceEvent[]; next: string | null; missed: boolean }> {
    if (workspaceIds.length === 0)
      return {
        events: [],
        next: options.since === null ? null : String(options.since),
        missed: false,
      };
    const mine = inArray(workspaceEvents.workspaceId, workspaceIds);
    const read = async () => {
      if (options.since === null) {
        const rows = await this.db
          .select()
          .from(workspaceEvents)
          .where(mine)
          .orderBy(desc(workspaceEvents.id))
          .limit(options.limit);
        return rows.reverse();
      }
      return this.db
        .select()
        .from(workspaceEvents)
        .where(and(mine, gt(workspaceEvents.id, options.since)))
        .orderBy(workspaceEvents.id)
        .limit(options.limit);
    };
    let rows = await read();
    if (rows.length === 0 && options.waitS > 0 && !this.closed) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          for (const id of workspaceIds) this.appended.off(id, done);
          resolve();
        };
        const timer = setTimeout(done, options.waitS * 1000);
        for (const id of workspaceIds) this.appended.on(id, done);
      });
      rows = await read();
    }
    // Events older than two weeks are swept: a cursor from before the oldest kept event may
    // have missed some, so say so rather than skip them silently. (Ids grow with time, so the
    // oldest id still stored marks what was swept.)
    let missed = false;
    if (options.since !== null) {
      const [oldest] = await this.db
        .select({ id: workspaceEvents.id })
        .from(workspaceEvents)
        .orderBy(workspaceEvents.id)
        .limit(1);
      missed = oldest !== undefined && options.since < oldest.id - 1;
    }
    const last = rows.at(-1);
    return {
      events: rows.map(toEvent),
      next: last ? String(last.id) : options.since === null ? null : String(options.since),
      missed,
    };
  }

  // ---------- webhooks ----------

  async createHook(
    scope: Scope,
    by: { id: string; name: string },
    input: { url: string; events: WorkspaceEventType[] },
  ) {
    const [{ n }] = (await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(webhooks)
      .where(inScope(webhooks, scope))) as [{ n: number }];
    if (n >= MAX_WEBHOOKS)
      throw conflict(`${scopeWord(scope)} can have ${MAX_WEBHOOKS} webhooks; remove one first.`);
    const secret = `whsec_${randomToken(24)}`;
    const [row] = await this.db
      .insert(webhooks)
      .values({
        ...(isOrg(scope) ? { orgId: scope.orgId } : { workspaceId: scope.workspaceId }),
        url: input.url,
        secretEnc: this.enc.encrypt(secret),
        events: input.events,
        createdBy: by.id,
        createdByName: by.name,
      })
      .returning();
    return { row: row!, secret };
  }

  async hooks(scope: Scope) {
    const rows = await this.db
      .select()
      .from(webhooks)
      .where(inScope(webhooks, scope))
      .orderBy(webhooks.createdAt);
    const last = rows.length
      ? await this.db
          .selectDistinctOn([webhookDeliveries.webhookId])
          .from(webhookDeliveries)
          .where(
            inArray(
              webhookDeliveries.webhookId,
              rows.map((r) => r.id),
            ),
          )
          .orderBy(webhookDeliveries.webhookId, desc(webhookDeliveries.createdAt))
      : [];
    return rows.map((r) => {
      const d = last.find((x) => x.webhookId === r.id);
      return {
        id: r.id,
        url: r.url,
        events: r.events as WorkspaceEventType[],
        createdByName: r.createdByName,
        createdAt: r.createdAt.toISOString(),
        last: d
          ? {
              status: d.status,
              code: d.lastCode,
              at: (d.deliveredAt ?? d.createdAt).toISOString(),
            }
          : null,
      };
    });
  }

  async hook(scope: Scope, hookId: string) {
    const [row] = await this.db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.id, hookId), inScope(webhooks, scope)));
    if (!row) throw notFound('Webhook not found');
    return row;
  }

  async removeHook(scope: Scope, hookId: string) {
    const row = await this.hook(scope, hookId);
    await this.db.delete(webhooks).where(eq(webhooks.id, row.id));
    return row;
  }

  /** Sends a `ping` to one webhook, outside the stream, to check the address and secret. */
  async ping(scope: Scope, hookId: string, by: { name: string }) {
    const row = await this.hook(scope, hookId);
    // An organization's webhook belongs to no one workspace: its ping says so with "".
    const body = JSON.stringify({
      id: `ping-${randomToken(8)}`,
      type: 'ping',
      workspaceId: isOrg(scope) ? '' : scope.workspaceId,
      createdAt: new Date().toISOString(),
      data: { sentBy: by.name, ...(isOrg(scope) ? { orgId: scope.orgId } : {}) },
    } satisfies WorkspaceEvent);
    const [delivery] = await this.db
      .insert(webhookDeliveries)
      .values({ webhookId: row.id, type: 'ping', body, nextAttemptAt: new Date() })
      .returning();
    this.kick();
    return delivery!;
  }

  async deliveries(scope: Scope, hookId: string) {
    const row = await this.hook(scope, hookId);
    const rows = await this.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, row.id))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(30);
    return rows.map((d) => ({
      id: d.id,
      type: d.type,
      eventId: d.eventId === null ? null : String(d.eventId),
      status: d.status,
      attempts: d.attempts,
      lastCode: d.lastCode,
      lastError: d.lastError,
      createdAt: d.createdAt.toISOString(),
      deliveredAt: d.deliveredAt?.toISOString() ?? null,
      nextAttemptAt: d.status === 'pending' ? (d.nextAttemptAt?.toISOString() ?? null) : null,
    }));
  }

  // ---------- sending ----------

  /** Sends what is due now; overlapping calls fold into one more round. */
  kick(): void {
    if (this.closed) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    void this.round()
      .catch((e: unknown) => this.onError(`webhooks: ${e instanceof Error ? e.message : e}`))
      .finally(() => {
        this.running = false;
        if (this.again) {
          this.again = false;
          this.kick();
        }
      });
  }

  /** One round: takes the due deliveries (leasing them) and sends them side by side. */
  async round(): Promise<number> {
    const now = new Date();
    const due = await this.db
      .update(webhookDeliveries)
      .set({ nextAttemptAt: new Date(now.getTime() + LEASE_MS) })
      .where(
        inArray(
          webhookDeliveries.id,
          this.db
            .select({ id: webhookDeliveries.id })
            .from(webhookDeliveries)
            .where(
              and(
                eq(webhookDeliveries.status, 'pending'),
                lte(webhookDeliveries.nextAttemptAt, now),
              ),
            )
            .orderBy(webhookDeliveries.createdAt)
            .limit(20),
        ),
      )
      .returning();
    await Promise.all(due.map((d) => this.attempt(d)));
    return due.length;
  }

  private async attempt(d: typeof webhookDeliveries.$inferSelect): Promise<void> {
    const [hook] = await this.db.select().from(webhooks).where(eq(webhooks.id, d.webhookId));
    if (!hook) return;
    let outcome: Outcome;
    try {
      outcome = await this.send(hook.url, this.allow, this.enc.decrypt(hook.secretEnc), {
        id: d.id,
        type: d.type,
        body: d.body,
      });
    } catch (e) {
      outcome = { ok: false, code: null, error: e instanceof Error ? e.message : String(e) };
    }
    const attempts = d.attempts + 1;
    const wait = RETRY_DELAYS_S[attempts - 1];
    await this.db
      .update(webhookDeliveries)
      .set(
        outcome.ok
          ? {
              status: 'delivered',
              attempts,
              lastCode: outcome.code,
              lastError: null,
              deliveredAt: new Date(),
              nextAttemptAt: null,
            }
          : {
              status: wait === undefined ? 'failed' : 'pending',
              attempts,
              lastCode: outcome.code,
              lastError: redactText(outcome.error ?? 'Failed').slice(0, 300),
              nextAttemptAt: wait === undefined ? null : new Date(Date.now() + wait * 1000),
            },
      )
      .where(eq(webhookDeliveries.id, d.id));
  }

  /** Forgets events older than two weeks, with their deliveries. */
  async sweep(): Promise<void> {
    const cutoff = new Date(Date.now() - EVENT_TTL_MS);
    await this.db.delete(workspaceEvents).where(lt(workspaceEvents.createdAt, cutoff));
    await this.db.delete(webhookDeliveries).where(lt(webhookDeliveries.createdAt, cutoff));
  }
}

function toEvent(row: typeof workspaceEvents.$inferSelect): WorkspaceEvent {
  return {
    id: String(row.id),
    type: row.type as WorkspaceEvent['type'],
    workspaceId: row.workspaceId,
    createdAt: row.createdAt.toISOString(),
    data: row.data,
  };
}
