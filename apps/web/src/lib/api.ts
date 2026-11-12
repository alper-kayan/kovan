import { safeUrl } from './dom';

/**
 * The site's connection to the Kovan server (same origin). The session token lives in
 * sessionStorage only: it goes away with the tab and is never written anywhere durable.
 */

const TOKEN_KEY = 'kovan.session';
const POLL_MS = 2500;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function getToken(): string | null {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function setToken(token: string | null): void {
  try {
    if (token) window.sessionStorage.setItem(TOKEN_KEY, token);
    else window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage is blocked: the person stays signed out.
  }
}

async function request<T>(path: string, method: string, body: unknown, auth: boolean): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const token = getToken();
  if (auth && token) headers['authorization'] = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'network', "The Kovan server can't be reached. Try again in a moment.");
  }

  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error = (data as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    if (res.status === 401) setToken(null);
    throw new ApiError(
      res.status,
      typeof error?.code === 'string' ? error.code : 'error',
      typeof error?.message === 'string' ? error.message : `The server answered ${res.status}.`,
    );
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path, 'GET', undefined, true),
  post: <T>(path: string, body: unknown = {}) => request<T>(path, 'POST', body, true),
  put: <T>(path: string, body: unknown) => request<T>(path, 'PUT', body, true),
  patch: <T>(path: string, body: unknown) => request<T>(path, 'PATCH', body, true),
};

export async function signOut(): Promise<void> {
  try {
    await api.post('/auth/logout');
  } catch {
    // The token is dropped either way.
  }
  setToken(null);
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export interface SignInHandle {
  /** Resolves once the person has finished in the other tab; rejects with a message otherwise. */
  done: Promise<void>;
  /** The sign-in page, for a link when the browser blocked the new tab. */
  url: Promise<string>;
  /** The code an emailed sign-in link's page asks for. */
  code: Promise<string | null>;
  cancel: () => void;
}

/**
 * The same flow the desktop app uses: start a sign-in, send the browser to the returned page
 * in a new tab, and poll with a secret only this page knows until the server hands the session
 * over. Must be called from a click, so the tab can be opened.
 */
export function signIn(): SignInHandle {
  // Opened right away, while the click still counts; it is pointed at the page once we have it.
  const tab = window.open('', '_blank');
  let cancelled = false;
  let giveUrl: (url: string) => void = () => {};
  const url = new Promise<string>((resolve) => (giveUrl = resolve));
  let giveCode: (code: string | null) => void = () => {};
  const code = new Promise<string | null>((resolve) => (giveCode = resolve));

  const done = (async () => {
    const secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
    const start = await request<{
      loginId: string;
      url: string;
      expiresInSeconds: number;
      code?: string;
    }>(
      '/auth/desktop/start',
      'POST',
      { secretHash: base64url(new Uint8Array(digest)), intent: 'login', machineId: null },
      false,
    );
    const page = safeUrl(start.url);
    if (!page)
      throw new ApiError(0, 'bad_url', 'The server sent a sign-in link that cannot be opened.');
    giveUrl(page);
    giveCode(start.code ?? null);
    if (tab && !tab.closed) {
      tab.opener = null;
      tab.location.replace(page);
    }

    const deadline = Date.now() + start.expiresInSeconds * 1000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      if (cancelled) throw new ApiError(0, 'cancelled', 'Sign-in cancelled.');
      let result: { status: string; token?: string | null; error?: string | null };
      try {
        result = await request(
          '/auth/desktop/poll',
          'POST',
          { loginId: start.loginId, secret },
          false,
        );
      } catch (error) {
        // A blip or a rate limit while waiting: keep polling. Anything else ends it.
        if (error instanceof ApiError && (error.status === 0 || error.status === 429)) continue;
        throw error;
      }
      if (result.status === 'pending') continue;
      if (result.status === 'complete' && result.token) {
        setToken(result.token);
        return;
      }
      throw new ApiError(0, 'failed', result.error ?? 'Sign-in failed. Try again.');
    }
    throw new ApiError(0, 'expired', 'Sign-in expired. Try again.');
  })();

  done.catch(() => {
    if (tab && !tab.closed && tab.location.href === 'about:blank') tab.close();
  });

  return { done, url, code, cancel: () => (cancelled = true) };
}
