import type { User } from '@kovan/shared';
import { request } from './api';
import { t } from './i18n';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Bytes as base64url without padding, the way the server writes hashes. */
export function base64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a = 0, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    const n = (a << 16) | (b << 8) | c;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) out += ALPHABET[(n >> 6) & 63]!;
    if (i + 2 < bytes.length) out += ALPHABET[n & 63]!;
  }
  return out;
}

/** Standard (padded) base64 turned into base64url without padding. */
export const toBase64Url = (base64: string) =>
  base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export interface PendingSignIn {
  loginId: string;
  url: string;
  secret: string;
  expiresAt: number;
  /** The code an emailed sign-in link's page asks for (shown while waiting). */
  code: string | null;
}

export type PollResult =
  | { status: 'pending' }
  | { status: 'failed'; error: string }
  | { status: 'complete'; token: string; user: User };

/**
 * The same sign-in as the desktop app: the phone keeps a secret, the server gets its hash and a
 * page to open in the browser; once the person signs in there, polling with the secret returns
 * a session token (once). `crypto` is injected so this runs in tests too.
 */
export async function startSignIn(
  server: string,
  crypto: { randomBytes(n: number): Uint8Array; sha256Base64(text: string): Promise<string> },
  /** The app's own link the server's last page sends the browser to (kovan://…). */
  returnTo: string | null = null,
): Promise<PendingSignIn> {
  const secret = base64url(crypto.randomBytes(32));
  const secretHash = toBase64Url(await crypto.sha256Base64(secret));
  const started = await request<{
    loginId: string;
    url: string;
    expiresInSeconds: number;
    code?: string;
  }>(server, null, 'POST', '/auth/desktop/start', {
    secretHash,
    intent: 'login',
    machineId: null,
    returnTo,
  });
  return {
    loginId: started.loginId,
    url: started.url,
    secret,
    expiresAt: Date.now() + started.expiresInSeconds * 1000,
    code: started.code ?? null,
  };
}

export async function pollSignIn(server: string, pending: PendingSignIn): Promise<PollResult> {
  if (Date.now() > pending.expiresAt)
    return { status: 'failed', error: t('Sign-in expired. Try again.') };
  const res = await request<{
    status: 'pending' | 'failed' | 'complete';
    error?: string;
    token?: string | null;
    user?: User | null;
  }>(server, null, 'POST', '/auth/desktop/poll', {
    loginId: pending.loginId,
    secret: pending.secret,
  });
  if (res.status === 'complete') {
    if (!res.token || !res.user)
      return { status: 'failed', error: t("Sign-in didn't finish. Try again.") };
    return { status: 'complete', token: res.token, user: res.user };
  }
  if (res.status === 'failed')
    return { status: 'failed', error: res.error ?? t('Sign-in failed.') };
  return { status: 'pending' };
}
