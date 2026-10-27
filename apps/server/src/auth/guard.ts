import type { FastifyRequest } from 'fastify';
import { API_KEY_PREFIX, keyMay, keyRefused } from '../apikeys.js';
import type { AppContext } from '../context.js';
import { unauthorized } from '../errors.js';
import type { UserRow } from '../users.js';
import { authenticate } from './sessions.js';

export function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
}

/**
 * The signed-in user for this request; throws 401 otherwise. A workspace API key stands for its
 * own service member, and only for the requests its scopes allow (403 for the rest).
 */
export async function requireUser(ctx: AppContext, req: FastifyRequest): Promise<UserRow> {
  const token = bearerToken(req);
  if (token?.startsWith(API_KEY_PREFIX)) {
    const key = await ctx.apiKeys.authenticate(token);
    if (!key) throw unauthorized('This API key is not valid or was revoked.');
    if (!keyMay(key.scopes, req)) throw keyRefused();
    return key.user;
  }
  const user = token ? await authenticate(ctx.db, token) : null;
  if (!user) throw unauthorized();
  return user;
}
