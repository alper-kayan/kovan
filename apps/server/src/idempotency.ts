import { createHash } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from './db/client.js';
import { idempotencyKeys } from './db/schema.js';
import { badRequest, conflict, HttpError } from './errors.js';

/** How long an answer is kept for retries. */
export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;
/**
 * A request still marked running after this long died with the server; its key is freed so
 * the caller isn't locked out for a day. Starting work takes milliseconds, not minutes.
 */
export const IDEMPOTENCY_STALE_MS = 2 * 60_000;

const KEY = /^[\x21-\x7e]{1,255}$/;

/**
 * `Idempotency-Key` for requests that start work: the first request runs and, when it
 * succeeds, its answer is kept; the same key again gets that answer back, marked
 * `Idempotent-Replayed: true`, without running anything. A refusal (403, 409 "busy") or a
 * failure started nothing, so it frees the key: a retry runs again and may succeed once the
 * reason is gone. Reusing a key for a different request is refused (422), and a retry while
 * the first is still running gets 409.
 */
export class Idempotency {
  constructor(private readonly db: Db) {}

  async run<T>(
    req: FastifyRequest,
    reply: FastifyReply,
    owner: string,
    work: () => Promise<T>,
  ): Promise<T | unknown> {
    const header = req.headers['idempotency-key'];
    if (header === undefined) return work();
    const key = Array.isArray(header) ? header[0] : header;
    if (!key || !KEY.test(key))
      throw badRequest('Idempotency-Key must be 1 to 255 visible ASCII characters.');
    const fingerprint = createHash('sha256')
      .update(`${req.method} ${req.url}\n${JSON.stringify(req.body ?? null)}`)
      .digest('hex');

    const claimed = await this.claim(owner, key, fingerprint);
    if (claimed !== true) {
      if (claimed.fingerprint !== fingerprint)
        throw new HttpError(
          422,
          'idempotency_mismatch',
          'This Idempotency-Key was already used for a different request.',
        );
      if (claimed.status === 'pending')
        throw conflict('A request with this Idempotency-Key is still running. Retry shortly.');
      void reply.header('idempotent-replayed', 'true');
      void reply.code(claimed.statusCode ?? 200);
      return claimed.response;
    }

    const id = and(eq(idempotencyKeys.owner, owner), eq(idempotencyKeys.key, key));
    try {
      const result = await work();
      await this.db
        .update(idempotencyKeys)
        .set({ status: 'done', statusCode: reply.statusCode, response: result ?? null })
        .where(id);
      return result;
    } catch (error) {
      await this.db.delete(idempotencyKeys).where(id);
      throw error;
    }
  }

  /** True when this request now owns the key; otherwise the row that already holds it. */
  private async claim(owner: string, key: string, fingerprint: string) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const [inserted] = await this.db
        .insert(idempotencyKeys)
        .values({ owner, key, fingerprint, status: 'pending' })
        .onConflictDoNothing()
        .returning({ id: idempotencyKeys.id });
      if (inserted) return true as const;
      const [row] = await this.db
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.owner, owner), eq(idempotencyKeys.key, key)));
      if (!row) continue; // swept in between
      const age = Date.now() - row.createdAt.getTime();
      const expired =
        age > IDEMPOTENCY_TTL_MS || (row.status === 'pending' && age > IDEMPOTENCY_STALE_MS);
      if (!expired) return row;
      await this.db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, row.id));
    }
    throw conflict('A request with this Idempotency-Key is still running. Retry shortly.');
  }

  /** Forgets answers older than a day. */
  async sweep(): Promise<number> {
    const gone = await this.db
      .delete(idempotencyKeys)
      .where(lt(idempotencyKeys.createdAt, new Date(Date.now() - IDEMPOTENCY_TTL_MS)))
      .returning({ id: idempotencyKeys.id });
    return gone.length;
  }
}
