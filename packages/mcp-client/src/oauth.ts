import {
  auth,
  discoverOAuthProtectedResourceMetadata,
  UnauthorizedError,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** What a sign-in leaves behind for one server URL: kept by the app, in the keychain. */
export interface OAuthState {
  tokens?: OAuthTokens;
  client?: OAuthClientInformationMixed;
  /** The loopback address the client was registered with. */
  redirectUrl?: string;
  codeVerifier?: string;
}

export interface OAuthStore {
  get(serverUrl: string): Promise<OAuthState | undefined>;
  set(serverUrl: string, state: OAuthState | undefined): Promise<void>;
}

const SIGN_IN_TIMEOUT = 5 * 60_000;

/** Signing in again is needed: no tokens, or tokens the server no longer takes. */
export class SignInNeeded extends Error {}

class Provider implements OAuthClientProvider {
  private saved: OAuthState = {};
  private loaded = false;
  private expected: string | null = null;

  constructor(
    private readonly url: string,
    private readonly store: OAuthStore,
    private readonly opts: {
      clientName: string;
      /** Set only during a sign-in the person started; otherwise nothing opens a browser. */
      redirectUrl?: string;
      open?: (url: URL) => void | Promise<void>;
    },
  ) {}

  private async load(): Promise<OAuthState> {
    if (!this.loaded) {
      this.saved = (await this.store.get(this.url)) ?? {};
      this.loaded = true;
      // A client registered for another loopback port can't receive this sign-in's code.
      if (this.opts.redirectUrl && this.saved.redirectUrl !== this.opts.redirectUrl) {
        delete this.saved.client;
        this.saved.redirectUrl = this.opts.redirectUrl;
      }
    }
    return this.saved;
  }

  private async save(change: Partial<OAuthState>): Promise<void> {
    const state = await this.load();
    Object.assign(state, change);
    await this.store.set(this.url, state);
  }

  get redirectUrl(): string | undefined {
    return this.opts.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.opts.clientName,
      redirect_uris: this.opts.redirectUrl ? [this.opts.redirectUrl] : [],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  state(): string {
    this.expected = randomBytes(16).toString('hex');
    return this.expected;
  }

  /** The `state` this sign-in sent, to check the one that comes back. */
  sentState(): string | null {
    return this.expected;
  }

  async clientInformation() {
    return (await this.load()).client;
  }

  async saveClientInformation(client: OAuthClientInformationMixed) {
    await this.save({ client });
  }

  async tokens() {
    return (await this.load()).tokens;
  }

  async saveTokens(tokens: OAuthTokens) {
    await this.save({ tokens });
  }

  async redirectToAuthorization(url: URL) {
    // Outside a sign-in (a turn, a test), a server that wants the browser just says so.
    if (!this.opts.open) throw new SignInNeeded('Sign in needed');
    await this.opts.open(url);
  }

  async saveCodeVerifier(codeVerifier: string) {
    await this.save({ codeVerifier });
  }

  async codeVerifier() {
    const v = (await this.load()).codeVerifier;
    if (!v) throw new Error('No sign-in in progress');
    return v;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    const state = await this.load();
    if (scope === 'all' || scope === 'tokens') delete state.tokens;
    if (scope === 'all' || scope === 'client') delete state.client;
    if (scope === 'all' || scope === 'verifier') delete state.codeVerifier;
    await this.store.set(this.url, state);
  }
}

/**
 * The provider a connection uses: the saved tokens (refreshed when they expire), and never a
 * browser. When the tokens don't work any more, connecting fails with "sign in needed".
 */
export function storedAuth(
  serverUrl: string,
  store: OAuthStore,
  state: OAuthState,
  clientName = 'Kovan',
): OAuthClientProvider {
  // The address it was registered with: the SDK then treats a dead refresh token as "sign in
  // again" (which lands in redirectToAuthorization) rather than as a machine-to-machine client.
  return new Provider(serverUrl, store, {
    clientName,
    ...(state.redirectUrl ? { redirectUrl: state.redirectUrl } : {}),
  });
}

/**
 * Whether a server that said 401 offers OAuth sign-in (it publishes where to sign in), as
 * opposed to wanting a header the person has to set.
 */
export async function offersSignIn(serverUrl: string): Promise<boolean> {
  try {
    await discoverOAuthProtectedResourceMetadata(serverUrl);
    return true;
  } catch {
    return false;
  }
}

/** The server turned the request away for want of sign-in (with or without a provider). */
export function isUnauthorized(error: unknown): boolean {
  for (let e = error; e; e = (e as { cause?: unknown }).cause) {
    if (e instanceof UnauthorizedError || e instanceof SignInNeeded) return true;
    if ((e as { code?: unknown }).code === 401) return true;
  }
  return false;
}

/**
 * Signs in to a remote server the way Claude Code does: finds its authorization server,
 * registers Kovan as a client if needed, opens the browser, and takes the code on a loopback
 * address only this machine can reach. The tokens end up in `store`.
 */
export async function signIn(
  serverUrl: string,
  store: OAuthStore,
  opts: {
    open: (url: URL) => void | Promise<void>;
    clientName?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<void> {
  let deliver: (r: { code?: string; state?: string; error?: string }) => void = () => {};
  const arrived = new Promise<{ code?: string; state?: string; error?: string }>(
    (resolve) => (deliver = resolve),
  );
  const loopback = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get('error_description') ?? url.searchParams.get('error');
    res
      .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end(
        `<!doctype html><meta charset="utf-8"><title>Kovan</title><body style="font:16px system-ui;padding:40px">${
          error
            ? 'Sign-in failed. You can close this tab.'
            : 'Signed in. You can close this tab and go back to Kovan.'
        }</body>`,
      );
    deliver({
      ...(url.searchParams.get('code') ? { code: url.searchParams.get('code')! } : {}),
      ...(url.searchParams.get('state') ? { state: url.searchParams.get('state')! } : {}),
      ...(error ? { error } : {}),
    });
  });
  await new Promise<void>((resolve, reject) => {
    loopback.once('error', reject);
    loopback.listen(0, '127.0.0.1', resolve);
  });
  const { port } = loopback.address() as AddressInfo;
  const provider = new Provider(serverUrl, store, {
    clientName: opts.clientName ?? 'Kovan',
    redirectUrl: `http://127.0.0.1:${port}/callback`,
    open: opts.open,
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const first = await auth(provider, { serverUrl });
    if (first === 'AUTHORIZED') return;
    const stopped = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('Sign-in timed out')),
        opts.timeoutMs ?? SIGN_IN_TIMEOUT,
      );
      opts.signal?.addEventListener('abort', () => reject(new Error('Sign-in stopped')), {
        once: true,
      });
    });
    const back = await Promise.race([arrived, stopped]);
    if (back.error) throw new Error(`The server said: ${back.error}`);
    if (!back.code) throw new Error('No code came back');
    if (back.state !== provider.sentState()) throw new Error("The sign-in reply didn't match");
    const done = await auth(provider, { serverUrl, authorizationCode: back.code });
    if (done !== 'AUTHORIZED') throw new Error("The server didn't accept the sign-in");
  } finally {
    clearTimeout(timer);
    loopback.close();
    loopback.closeAllConnections();
  }
}
