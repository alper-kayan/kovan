/** Kovan's server, as the phone talks to it: JSON over HTTPS with the session token. */

import { locale, t } from './i18n';

export const DEFAULT_SERVER = 'https://kovan.alperkayan.dev';

/** Where the sign-in lives in the device's secure storage (read by background tasks too). */
export const STORE_KEYS = { server: 'kovan.server', token: 'kovan.token' } as const;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** A server address as typed: scheme added when missing, trailing slashes dropped. */
export function normalizeServer(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  // Another scheme (ftp://…) isn't a Kovan server; no scheme at all means https.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !/^https?:\/\//i.test(text)) return null;
  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** How long a request may take before the phone says the server can't be reached. */
export const TIMEOUT_MS = 30_000;

export async function request<T>(
  server: string,
  token: string | null,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  const host = server.replace(/^https?:\/\//, '');
  // A request on a network that went away can hang for minutes without this.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    res = await fetch(`${server}${path}`, {
      method,
      signal: abort.signal,
      headers: {
        Accept: 'application/json',
        // The server answers (errors, notifications) in the app's language.
        'x-kovan-locale': locale(),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    clearTimeout(timer);
    throw new ApiError(
      0,
      'offline',
      abort.signal.aborted
        ? t("{host} didn't answer. Check your connection and try again.", { host })
        : t("Can't reach {host}. Check your connection.", { host }),
    );
  }
  let text: string;
  try {
    text = await res.text();
  } catch {
    throw new ApiError(0, 'offline', t('The connection to {host} broke. Try again.', { host }));
  } finally {
    clearTimeout(timer);
  }
  let data: unknown;
  try {
    data = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    // A proxy's error page, not the server: say what happened in words.
    throw new ApiError(
      res.status,
      'unavailable',
      res.ok
        ? t("{host} answered with something that isn't Kovan.", { host })
        : t('{host} is unavailable right now (HTTP {status}). Try again in a moment.', {
            host,
            status: res.status,
          }),
    );
  }
  if (!res.ok) {
    const error = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      res.status,
      error?.code ?? 'error',
      error?.message ??
        (res.status >= 500
          ? t("Kovan's server had a problem (HTTP {status}). Try again in a moment.", {
              status: res.status,
            })
          : t("Kovan's server turned this away (HTTP {status}).", { status: res.status })),
    );
  }
  return data as T;
}
