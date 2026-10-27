import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import postgres from 'postgres';
import WebSocket from 'ws';
import type { OAuthProvider } from '../auth/providers.js';
import { loadConfig } from '../config.js';
import { OutboxMailer } from '../mail.js';
import { createContext } from '../server.js';
import type { Profile } from '../users.js';

const ADMIN_URL = process.env['TEST_DATABASE_URL'] ?? 'postgres://kovan:kovan@localhost:5433/kovan';

/** An OAuth provider whose callback "code" picks which fake profile signs in. */
export function fakeProvider(
  id: 'github' | 'google',
  profiles: Record<string, Partial<Profile>>,
): OAuthProvider {
  return {
    id,
    label: id,
    authorizeUrl: (state) => `https://fake.${id}/authorize?state=${state}`,
    async complete(code) {
      const p = profiles[code];
      if (!p) throw new Error(`Unknown fake code ${code}`);
      return {
        provider: id,
        providerUserId: p.providerUserId ?? code,
        name: p.name ?? code,
        email: p.email ?? null,
        emailVerified: p.emailVerified ?? false,
        avatarUrl: null,
        login: p.login ?? null,
        accessToken: p.accessToken ?? (id === 'github' ? `gho_${code}` : null),
        scopes: null,
      };
    },
  };
}

export interface Harness {
  app: FastifyInstance;
  mailer: OutboxMailer;
  baseUrl: string;
  wsUrl: string;
  ctx: Awaited<ReturnType<typeof createContext>>['ctx'];
  profiles: { github: Record<string, Partial<Profile>>; google: Record<string, Partial<Profile>> };
  close(): Promise<void>;
}

/** A server on its own throwaway database, listening on a random port. */
export async function startHarness(env: Record<string, string> = {}): Promise<Harness> {
  const name = `kovan_test_${randomBytes(6).toString('hex')}`;
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;

  const mailer = new OutboxMailer();
  const profiles = { github: {}, google: {} } as Harness['profiles'];
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: url.toString(),
    PUBLIC_URL: 'http://kovan.test',
    AUTH_RATE_LIMIT: '100000',
    API_RATE_LIMIT: '100000',
    ...env,
  } as NodeJS.ProcessEnv);
  const { app, ctx, close } = await createContext(config, {
    mailer,
    providers: {
      github: fakeProvider('github', profiles.github),
      google: fakeProvider('google', profiles.google),
    },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    app,
    ctx,
    mailer,
    profiles,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    async close() {
      await close();
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.end();
    },
  };
}

export const hashSecret = (secret: string) =>
  createHash('sha256').update(secret).digest('base64url');

/** Starts a desktop sign-in like the app does; returns the login id and its secret. */
export async function startLogin(
  h: Harness,
  options: { intent?: 'login' | 'link'; token?: string; returnTo?: string } = {},
) {
  const secret = randomBytes(24).toString('base64url');
  const res = await h.app.inject({
    method: 'POST',
    url: '/auth/desktop/start',
    payload: {
      secretHash: hashSecret(secret),
      intent: options.intent ?? 'login',
      machineId: 'test-machine',
      ...(options.returnTo ? { returnTo: options.returnTo } : {}),
    },
    ...(options.token ? { headers: { authorization: `Bearer ${options.token}` } } : {}),
  });
  if (res.statusCode !== 200) throw new Error(`start failed ${res.statusCode}: ${res.body}`);
  const { loginId } = res.json() as { loginId: string };
  return { loginId, secret };
}

export async function poll(h: Harness, loginId: string, secret: string) {
  const res = await h.app.inject({
    method: 'POST',
    url: '/auth/desktop/poll',
    payload: { loginId, secret },
  });
  return {
    status: res.statusCode,
    body: res.json() as {
      status: string;
      token?: string;
      user?: { id: string; emailVerified: boolean; githubLogin: string | null };
      error?: string;
    },
  };
}

/** Completes a sign-in through the fake OAuth provider and returns the session token and user. */
export async function oauthLogin(
  h: Harness,
  provider: 'github' | 'google',
  code: string,
  profile: Partial<Profile>,
) {
  h.profiles[provider][code] = profile;
  const { loginId, secret } = await startLogin(h);
  const redirect = await h.app.inject({ method: 'GET', url: `/auth/${provider}?login=${loginId}` });
  const state = new URL(redirect.headers.location as string).searchParams.get('state');
  const callback = await h.app.inject({
    method: 'GET',
    url: `/auth/${provider}/callback?code=${code}&state=${state}`,
  });
  if (callback.statusCode !== 200)
    throw new Error(`callback ${callback.statusCode}: ${callback.body}`);
  const { body } = await poll(h, loginId, secret);
  return { token: body.token!, user: body.user! };
}

/** Pulls the first link out of the newest mail to `to`. */
export function lastLink(h: Harness, to: string): string {
  const mail = [...h.mailer.sent].reverse().find((m) => m.to === to);
  const match = mail && /(http\S+)/.exec(mail.text);
  if (!match) throw new Error(`No mail with a link to ${to}`);
  return match[1]!;
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** A WebSocket client that records server messages and can wait for one. */
export async function connect(
  h: Harness,
  token: string,
  { client: kind = 'desktop' }: { client?: 'desktop' | 'mobile' } = {},
) {
  const socket = new WebSocket(h.wsUrl);
  const messages: { type: string; [k: string]: unknown }[] = [];
  const waiters: {
    match: (m: { type: string; [k: string]: unknown }) => boolean;
    resolve: (m: unknown) => void;
  }[] = [];
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    messages.push(message);
    for (const w of [...waiters]) {
      if (w.match(message)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(message);
      }
    }
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const client = {
    socket,
    messages,
    send: (message: object) => socket.send(JSON.stringify(message)),
    waitFor<T = { type: string; [k: string]: unknown }>(
      match: (m: { type: string; [k: string]: unknown }) => boolean,
      timeoutMs = 3000,
    ): Promise<T> {
      const found = messages.find(match);
      if (found) return Promise.resolve(found as T);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Timed out waiting for a message')),
          timeoutMs,
        );
        waiters.push({ match, resolve: (m) => (clearTimeout(timer), resolve(m as T)) });
      });
    },
    close: () => socket.close(),
  };
  client.send({ type: 'hello', token, machineId: 'm', clientVersion: 'test', client: kind });
  return client;
}
