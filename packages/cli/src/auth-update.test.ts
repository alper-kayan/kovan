import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthStore, login, managedProvider, type Auth } from './auth.js';
import { ConversationStore } from './store.js';
import { main, resolveProvider, VERSION, type Terminal } from './run.js';
import { bundlePath, checkAndUpdate, isNewer, manifestUrl } from './update.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kovan-auth-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const TOKEN = 'kvs_SECRET_SESSION_TOKEN_0123456789';
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

function term() {
  const written: string[] = [];
  const t: Terminal = {
    isTTY: false,
    write: (s) => void written.push(s),
    readLine: async () => null,
    onInterrupt: () => {},
    close: () => {},
  };
  return { t, text: () => written.join('') };
}

// ── a Kovan server, as far as the terminal needs one ─────────────────────────

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

async function serve(
  handler: (
    req: Seen,
  ) => { status?: number; json?: unknown; body?: string | Buffer; type?: string } | undefined,
) {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const s: Seen = {
        method: req.method ?? 'GET',
        url: req.url ?? '',
        headers: req.headers,
        body,
      };
      seen.push(s);
      const r = handler(s) ?? { status: 404, json: { error: 'no' } };
      res.statusCode = r.status ?? 200;
      if (r.json !== undefined) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(r.json));
      } else {
        res.setHeader('content-type', r.type ?? 'application/octet-stream');
        res.end(r.body ?? '');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, seen, close: () => server.close() };
}

// ── signing in ───────────────────────────────────────────────────────────────

describe('login (the desktop’s own device flow)', () => {
  it('starts with the hash of a secret, the browser finishes it, the terminal collects the token with the secret', async () => {
    let polls = 0;
    const srv = await serve((r) => {
      if (r.url === '/auth/desktop/start')
        return {
          json: {
            loginId: 'L1',
            url: 'https://kovan.test/auth/start?login=L1',
            expiresInSeconds: 600,
          },
        };
      if (r.url === '/auth/desktop/poll') {
        return ++polls < 3
          ? { json: { status: 'pending' } }
          : { json: { status: 'complete', token: TOKEN, user: { id: 'u1', name: 'Alper' } } };
      }
      return undefined;
    });
    try {
      const out: string[] = [];
      let opened = '';
      const auth = await login({
        server: srv.url,
        machineId: 'm-1',
        fetchImpl: fetch,
        open: (u) => (opened = u),
        out: (s) => out.push(s),
        sleep: async () => {},
      });
      expect(auth).toMatchObject({
        token: TOKEN,
        machineId: 'm-1',
        user: { id: 'u1', name: 'Alper' },
      });
      expect(opened).toBe('https://kovan.test/auth/start?login=L1');
      expect(out.join('\n')).toContain('https://kovan.test/auth/start?login=L1'); // printed too, in case no browser opens

      const start = JSON.parse(srv.seen.find((s) => s.url === '/auth/desktop/start')!.body) as {
        secretHash: string;
        intent: string;
        machineId: string;
      };
      expect(start).toMatchObject({ intent: 'login', machineId: 'm-1' });
      const poll = JSON.parse(srv.seen.find((s) => s.url === '/auth/desktop/poll')!.body) as {
        loginId: string;
        secret: string;
      };
      expect(poll.loginId).toBe('L1');
      // The server only ever saw the hash first; the secret that proves it is theirs arrives at the end.
      expect(createHash('sha256').update(poll.secret).digest('base64url')).toBe(start.secretHash);
      expect(JSON.stringify(start)).not.toContain(poll.secret);
    } finally {
      srv.close();
    }
  });

  it.each([
    [
      'a failed sign-in says why',
      { json: { status: 'failed', error: 'hesap engellendi' } },
      /hesap engellendi/,
    ],
    ['an expired one is not retried for ever', { status: 404, json: {} }, /expired/],
  ])('%s', async (_n, poll, why) => {
    const srv = await serve((r) =>
      r.url === '/auth/desktop/start'
        ? { json: { loginId: 'L', url: 'u', expiresInSeconds: 600 } }
        : poll,
    );
    try {
      await expect(
        login({
          server: srv.url,
          machineId: 'm',
          fetchImpl: fetch,
          open: () => {},
          out: () => {},
          sleep: async () => {},
        }),
      ).rejects.toThrow(why);
    } finally {
      srv.close();
    }
  });

  it('a server that cannot be reached, or will not start one, is said plainly', async () => {
    const base = { machineId: 'm', open: () => {}, out: () => {}, sleep: async () => {} };
    await expect(
      login({ ...base, server: 'http://127.0.0.1:1', fetchImpl: fetch }),
    ).rejects.toThrow(/Can't reach/);
    const srv = await serve(() => ({ status: 500, json: {} }));
    try {
      await expect(login({ ...base, server: srv.url, fetchImpl: fetch })).rejects.toThrow(
        /Couldn't start signing in \(HTTP 500\)/,
      );
    } finally {
      srv.close();
    }
  });

  it('a browser that will not open does not stop it', async () => {
    const srv = await serve((r) =>
      r.url === '/auth/desktop/start'
        ? { json: { loginId: 'L', url: 'u', expiresInSeconds: 600 } }
        : { json: { status: 'complete', token: TOKEN, user: null } },
    );
    try {
      const a = await login({
        server: srv.url,
        machineId: 'm',
        fetchImpl: fetch,
        open: () => {
          throw new Error('no browser');
        },
        out: () => {},
        sleep: async () => {},
      });
      expect(a.token).toBe(TOKEN);
      expect(a.user).toBeNull();
    } finally {
      srv.close();
    }
  });
});

describe('the sign-in on disk', () => {
  it('only its owner can read it, and logging out removes it', () => {
    const store = new AuthStore(join(dir, 'k'));
    expect(store.load()).toBeNull();
    store.save({ server: 'https://s', token: TOKEN, machineId: 'm', user: null, at: 'x' });
    expect(statSync(join(dir, 'k', 'auth.json')).mode & 0o777).toBe(0o600);
    expect(store.load()?.token).toBe(TOKEN);
    expect(store.clear()).toBe(true);
    expect(store.load()).toBeNull();
    expect(store.clear()).toBe(false);
  });
  it('the machine id is made once and stays', () => {
    const store = new AuthStore(join(dir, 'k'));
    const id = store.machineId();
    expect(id).toMatch(/[0-9a-f-]{36}/);
    expect(new AuthStore(join(dir, 'k')).machineId()).toBe(id);
  });
  it('a damaged file is not a sign-in', () => {
    const store = new AuthStore(join(dir, 'k'));
    store.save({ server: 's', token: 't', machineId: 'm', user: null, at: 'x' });
    writeFileSync(join(dir, 'k', 'auth.json'), '{nope');
    expect(store.load()).toBeNull();
  });
});

describe('the commands', () => {
  const run = (argv: string[], over: Partial<Parameters<typeof main>[1]> = {}) => {
    const t = term();
    const errors: string[] = [];
    const store = new ConversationStore(join(dir, 'data'));
    const auth = new AuthStore(join(dir, 'k'));
    const done = main(argv, {
      env: {},
      cwd: dir,
      terminal: t.t,
      store,
      auth,
      err: (s) => errors.push(s),
      checkUpdates: false,
      home: join(dir, 'home'),
      stateDir: join(dir, 'state'),
      ...over,
    });
    return { done, t, errors, auth };
  };

  it('login saves the sign-in, says who, and never prints the token', async () => {
    const srv = await serve((r) =>
      r.url === '/auth/desktop/start'
        ? { json: { loginId: 'L', url: 'https://x/y', expiresInSeconds: 600 } }
        : { json: { status: 'complete', token: TOKEN, user: { id: 'u', name: 'Alper' } } },
    );
    try {
      const r = run(['login', '--server', srv.url], { sleep: async () => {} });
      expect(await r.done).toBe(0);
      expect(r.t.text()).toContain('Signed in: Alper');
      expect(r.t.text()).not.toContain(TOKEN);
      expect(r.auth.load()).toMatchObject({ token: TOKEN, server: srv.url });
    } finally {
      srv.close();
    }
  });

  it('a chat asks to sign in only when there is no key of their own', async () => {
    const without = run([]);
    expect(await without.done).toBe(1);
    expect(without.errors.join('\n')).toMatch(/not signed in/);
    const own = run([], { env: { OPENROUTER_API_KEY: 'sk-own' } });
    await own.done;
    expect(own.errors.join('\n')).not.toMatch(/not signed in/);
  });

  it('login that fails says why and saves nothing', async () => {
    const r = run(['login', '--server', 'http://127.0.0.1:1'], { sleep: async () => {} });
    expect(await r.done).toBe(1);
    expect(r.errors.join('\n')).toMatch(/Can't reach/);
    expect(r.auth.load()).toBeNull();
  });

  it('whoami asks the server who this token is', async () => {
    const srv = await serve((r) =>
      r.url === '/api/me'
        ? { json: { user: { id: 'u', name: 'Alper', email: 'a@b.c' } } }
        : undefined,
    );
    try {
      const store = new AuthStore(join(dir, 'k'));
      store.save({ server: srv.url, token: TOKEN, machineId: 'm', user: null, at: 'x' });
      const r = run(['whoami'], { auth: store });
      expect(await r.done).toBe(0);
      expect(r.t.text()).toContain('Alper <a@b.c>');
      expect(srv.seen[0]!.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    } finally {
      srv.close();
    }
  });

  it('whoami with a token the server no longer knows says to sign in again', async () => {
    const srv = await serve(() => ({ status: 401, json: {} }));
    try {
      const store = new AuthStore(join(dir, 'k'));
      store.save({ server: srv.url, token: TOKEN, machineId: 'm', user: null, at: 'x' });
      const r = run(['whoami'], { auth: store });
      expect(await r.done).toBe(1);
      expect(r.errors.join('\n')).toMatch(/kovan login/);
    } finally {
      srv.close();
    }
  });

  it('logout ends the session on the server and removes the file, even when the server is gone', async () => {
    const srv = await serve((r) => (r.url === '/auth/logout' ? { json: { ok: true } } : undefined));
    const store = new AuthStore(join(dir, 'k'));
    store.save({ server: srv.url, token: TOKEN, machineId: 'm', user: null, at: 'x' });
    expect(await run(['logout'], { auth: store }).done).toBe(0);
    expect(srv.seen.find((s) => s.url === '/auth/logout')?.headers['authorization']).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(store.load()).toBeNull();
    srv.close();

    store.save({ server: 'http://127.0.0.1:1', token: TOKEN, machineId: 'm', user: null, at: 'x' });
    expect(await run(['logout'], { auth: store }).done).toBe(0);
    expect(store.load()).toBeNull();
  });

  it('config says whether you are signed in, never the token', async () => {
    const store = new AuthStore(join(dir, 'k'));
    store.save({
      server: 'https://kovan.test',
      token: TOKEN,
      machineId: 'm',
      user: { id: 'u', name: 'Alper' },
      at: 'x',
    });
    const r = run(['config'], { auth: store, configFile: join(dir, 'none.json') });
    expect(await r.done).toBe(0);
    expect(r.t.text()).toContain('signed in: Alper (https://kovan.test)');
    expect(r.t.text()).toContain('managed usage');
    expect(r.t.text()).not.toContain(TOKEN);
  });
});

// ── which model: their own first, the account when there is none ───────────────

describe('which model server', () => {
  const auth: Auth = {
    server: 'https://kovan.test/',
    token: TOKEN,
    machineId: 'm',
    user: null,
    at: 'x',
  };
  const none = '/nonexistent/agent.json';

  it('signed in, an own key still wins: the account is billed only when asked for', () => {
    expect(resolveProvider({ OPENROUTER_API_KEY: 'sk-own' }, none, auth, null)).toMatchObject({
      ok: true,
      provider: { managed: false, label: 'openrouter.ai', apiKey: 'sk-own' },
    });
    expect(
      resolveProvider(
        { OPENROUTER_API_KEY: 'sk-own', KOVAN_PROVIDER: 'managed' },
        none,
        auth,
        null,
      ),
    ).toMatchObject({ ok: true, provider: { managed: true } });
  });
  it('KOVAN_PROVIDER=own never falls back to the account', () => {
    const p = resolveProvider({ KOVAN_PROVIDER: 'own' }, none, auth, null);
    expect(p.ok).toBe(false);
  });
  it('your own gateway is used when you ask for it', () => {
    const p = resolveProvider(
      { KOVAN_BASE_URL: 'http://localhost:20128/v1', KOVAN_MODEL: 'm', KOVAN_PROVIDER: 'own' },
      none,
      auth,
      null,
    );
    expect(p).toMatchObject({ ok: true, provider: { managed: false } });
  });
  it('with nothing of your own and a sign-in, Kovan’s managed usage, filed against the account and said so', () => {
    const p = resolveProvider({}, none, auth, null);
    expect(p).toMatchObject({
      ok: true,
      provider: {
        managed: true,
        baseUrl: 'https://kovan.test/api/inference/v1',
        apiKey: TOKEN,
        model: 'openrouter/auto',
      },
    });
    expect(p.ok && p.provider.label).toMatch(/billed to your account/);
  });
  it('a model you named is kept', () => {
    expect(resolveProvider({}, none, auth, 'anthropic/claude-sonnet')).toMatchObject({
      provider: { model: 'anthropic/claude-sonnet' },
    });
    expect(managedProvider(auth, 'x/y').model).toBe('x/y');
  });
  it('a half-configured gateway is theirs to fix, not a reason to bill the account', () => {
    const p = resolveProvider({ KOVAN_BASE_URL: 'http://localhost:20128/v1' }, none, auth, null);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.why).toMatch(/No model name/);
  });
  it('no key and no sign-in says both ways out', () => {
    const p = resolveProvider({}, none, null, null);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.why).toMatch(/kovan login/);
  });

  it('a managed turn goes to the server’s endpoint with the token and files its usage under this conversation', async () => {
    const srv = await serve((r) => {
      if (r.url.endsWith('/models')) return { json: { data: [] } };
      const chunk = (delta: object, finish: string | null = null) =>
        `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;
      return {
        type: 'text/event-stream',
        body: `${chunk({ content: 'merhaba' }, 'stop')}data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
      };
    });
    try {
      const store = new ConversationStore(join(dir, 'data'));
      const t = term();
      const authStore = new AuthStore(join(dir, 'k'));
      authStore.save({ server: srv.url, token: TOKEN, machineId: 'm', user: null, at: 'x' });
      const code = await main(['selam'], {
        env: {},
        cwd: dir,
        terminal: t.t,
        store,
        auth: authStore,
        err: () => {},
        configFile: join(dir, 'none.json'),
        checkUpdates: false,
        home: join(dir, 'home'),
      });
      expect(code).toBe(0);
      const chat = srv.seen.find((s) => s.url === '/api/inference/v1/chat/completions')!;
      expect(chat.headers['authorization']).toBe(`Bearer ${TOKEN}`);
      expect(chat.headers['x-kovan-run']).toBe(store.list()[0]!.id);
      expect(decodeURIComponent(String(chat.headers['x-kovan-run-label']))).toBe('Kovan terminal');
      expect(t.text()).toContain('merhaba');
    } finally {
      srv.close();
    }
  });
});

// ── keeping itself current ───────────────────────────────────────────────────

describe('versions', () => {
  it('are compared by number, not by text', () => {
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('0.2.1', '0.2.0')).toBe(true);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
    expect(isNewer('0.2.0', '0.2.0')).toBe(false);
    expect(isNewer('0.1.9', '0.2.0')).toBe(false);
  });
  it('only a file called kovan.mjs is a bundle that may replace itself', () => {
    expect(bundlePath('/home/a/.kovan/cli/kovan.mjs')).toBe('/home/a/.kovan/cli/kovan.mjs');
    expect(bundlePath('/repo/packages/cli/dist/index.js')).toBeNull();
    expect(bundlePath(undefined)).toBeNull();
  });
  it('the version in the code is the one in package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });
});

describe('self-update', () => {
  const NEW = Buffer.from('#!/usr/bin/env node\nconsole.log("yeni sürüm");\n');
  const manifest = (over: object = {}) => ({
    version: '9.9.0',
    url: 'kovan.mjs',
    sha256: sha(NEW),
    ...over,
  });

  // The release key: the manifest is signed with the private half, the bundle trusts the public half.
  const keys = generateKeyPairSync('ed25519');
  const KEY = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const signed = (text: string) =>
    sign(null, Buffer.from(text), keys.privateKey).toString('base64');

  const publish = (
    over: object = {},
    bytes: Buffer = NEW,
    signature: (text: string) => string | null = signed,
  ) =>
    serve((r) => {
      const text = JSON.stringify(manifest(over));
      if (r.url === '/updates/cli/latest.json') return { body: text, type: 'application/json' };
      const sig = signature(text);
      if (r.url === '/updates/cli/latest.json.sig' && sig !== null)
        return { body: sig, type: 'text/plain' };
      if (r.url === '/updates/cli/kovan.mjs') return { body: bytes };
      return undefined;
    });

  const deps = (
    server: string,
    target: string | null,
    over: Partial<Parameters<typeof checkAndUpdate>[0]> = {},
  ) => ({
    server,
    current: '0.2.0',
    fetchImpl: fetch,
    target,
    stampFile: join(dir, 'stamp.json'),
    env: {},
    publicKey: KEY,
    ...over,
  });

  it('a newer bundle is downloaded, checked against the manifest and swapped in, the old one kept', async () => {
    const srv = await publish();
    try {
      const target = join(dir, 'kovan.mjs');
      writeFileSync(target, 'eski sürüm');
      const r = await checkAndUpdate(deps(srv.url, target));
      expect(r).toEqual({ status: 'updated', from: '0.2.0', to: '9.9.0' });
      expect(readFileSync(target)).toEqual(NEW);
      expect(readFileSync(`${target}.old`, 'utf8')).toBe('eski sürüm');
      expect(statSync(target).mode & 0o111).not.toBe(0); // runnable
      expect(existsSync(`${target}.new`)).toBe(false);
    } finally {
      srv.close();
    }
  });

  it('looks once in twelve hours, unless asked to look now', async () => {
    const srv = await publish();
    try {
      const target = join(dir, 'kovan.mjs');
      writeFileSync(target, 'eski');
      let t = 1_000_000;
      const common = { now: () => t };
      expect((await checkAndUpdate({ ...deps(srv.url, target), ...common })).status).toBe(
        'updated',
      );
      writeFileSync(target, 'eski');
      t += 3_600_000; // an hour later
      expect(await checkAndUpdate({ ...deps(srv.url, target), ...common })).toMatchObject({
        status: 'skipped',
      });
      expect(
        (await checkAndUpdate({ ...deps(srv.url, target), ...common, force: true })).status,
      ).toBe('updated');
      writeFileSync(target, 'eski');
      t += 13 * 3_600_000;
      expect((await checkAndUpdate({ ...deps(srv.url, target), ...common })).status).toBe(
        'updated',
      );
    } finally {
      srv.close();
    }
  });

  it('a manifest without the release key’s signature is not believed, and nothing is downloaded', async () => {
    const other = generateKeyPairSync('ed25519');
    for (const signature of [
      () => null, // no .sig at all
      (text: string) => sign(null, Buffer.from(text), other.privateKey).toString('base64'), // someone else's key
      (text: string) => signed(text.replace('9.9.0', '9.9.1')), // signed, but not this text
    ]) {
      const srv = await publish({}, NEW, signature);
      try {
        const target = join(dir, 'kovan.mjs');
        writeFileSync(target, 'eski');
        const r = await checkAndUpdate(
          deps(srv.url, target, { stampFile: join(dir, `s${Math.random()}.json`) }),
        );
        expect(r).toMatchObject({ status: 'failed', why: expect.stringMatching(/isn't signed/) });
        expect(readFileSync(target, 'utf8')).toBe('eski');
        expect(srv.seen.some((q) => q.url.endsWith('/kovan.mjs'))).toBe(false);
      } finally {
        srv.close();
      }
    }
  });

  it('a bundle built without the release key never replaces itself', async () => {
    const srv = await publish();
    try {
      const target = join(dir, 'kovan.mjs');
      writeFileSync(target, 'eski');
      const r = await checkAndUpdate(deps(srv.url, target, { publicKey: '' }));
      expect(r).toMatchObject({ status: 'failed', why: expect.stringMatching(/no update key/) });
      expect(readFileSync(target, 'utf8')).toBe('eski');
      expect(srv.seen.some((q) => q.url.endsWith('/kovan.mjs'))).toBe(false);
    } finally {
      srv.close();
    }
  });

  it('a file that does not match the manifest’s hash is never used', async () => {
    const srv = await publish({}, Buffer.from('baska bir sey'));
    try {
      const target = join(dir, 'kovan.mjs');
      writeFileSync(target, 'eski');
      const r = await checkAndUpdate(deps(srv.url, target));
      expect(r).toMatchObject({
        status: 'failed',
        why: expect.stringMatching(/doesn't match the manifest/),
      });
      expect(readFileSync(target, 'utf8')).toBe('eski');
      expect(existsSync(`${target}.new`)).toBe(false);
    } finally {
      srv.close();
    }
  });

  it('an address on another origin is not fetched', async () => {
    const srv = await publish({ url: 'https://evil.example/kovan.mjs' });
    try {
      const target = join(dir, 'kovan.mjs');
      writeFileSync(target, 'eski');
      expect(await checkAndUpdate(deps(srv.url, target))).toMatchObject({
        status: 'failed',
        why: expect.stringMatching(/another server/),
      });
      expect(readFileSync(target, 'utf8')).toBe('eski');
    } finally {
      srv.close();
    }
  });

  it('the same or an older version is current', async () => {
    const srv = await publish({ version: '0.2.0' });
    try {
      expect(await checkAndUpdate(deps(srv.url, join(dir, 'kovan.mjs')))).toEqual({
        status: 'current',
      });
    } finally {
      srv.close();
    }
  });

  it('a checkout run from dist/ is told there is a newer version and its files are left alone', async () => {
    const srv = await publish();
    try {
      expect(await checkAndUpdate(deps(srv.url, null))).toEqual({
        status: 'available',
        version: '9.9.0',
      });
    } finally {
      srv.close();
    }
  });

  it('KOVAN_NO_UPDATE=1 turns it off, and no network is touched', async () => {
    const srv = await publish();
    try {
      expect(
        await checkAndUpdate(deps(srv.url, join(dir, 'k.mjs'), { env: { KOVAN_NO_UPDATE: '1' } })),
      ).toMatchObject({ status: 'skipped' });
      expect(srv.seen).toHaveLength(0);
    } finally {
      srv.close();
    }
  });

  it('a server with no manifest, or one that is down, is a quiet failure, not a crash', async () => {
    const empty = await serve(() => undefined);
    try {
      expect((await checkAndUpdate(deps(empty.url, join(dir, 'k.mjs')))).status).toBe('failed');
    } finally {
      empty.close();
    }
    expect(
      (
        await checkAndUpdate(
          deps('http://127.0.0.1:1', join(dir, 'k.mjs'), { stampFile: join(dir, 's2.json') }),
        )
      ).status,
    ).toBe('failed');
  });

  it('a manifest that is not in the shape is not believed', async () => {
    const srv = await serve(() => ({
      json: { version: '9.9.9', url: 'kovan.mjs', sha256: 'zzz' },
    }));
    try {
      expect((await checkAndUpdate(deps(srv.url, join(dir, 'k.mjs')))).status).toBe('failed');
    } finally {
      srv.close();
    }
  });

  it('`kovan update` does it now and says so; from a checkout it says how to update', async () => {
    const srv = await publish();
    try {
      const target = join(dir, 'kovan.mjs');
      writeFileSync(target, 'eski');
      const t = term();
      const base = {
        env: { KOVAN_SERVER: srv.url },
        cwd: dir,
        terminal: t.t,
        store: new ConversationStore(join(dir, 'data')),
        auth: new AuthStore(join(dir, 'k')),
        err: () => {},
        stateDir: join(dir, 'state'),
        updateKey: KEY,
      };
      expect(await main(['update'], { ...base, argv1: target })).toBe(0);
      expect(t.text()).toContain(`${VERSION} → 9.9.0`);

      const t2 = term();
      expect(
        await main(['update'], {
          ...base,
          terminal: t2.t,
          argv1: '/repo/packages/cli/dist/index.js',
        }),
      ).toBe(0);
      expect(t2.text()).toContain('pnpm --filter @kovan/cli bundle --install');
    } finally {
      srv.close();
    }
  });

  it('the manifest lives next to the desktop’s own releases', () => {
    expect(manifestUrl('https://kovan.alperkayan.dev/')).toBe(
      'https://kovan.alperkayan.dev/updates/cli/latest.json',
    );
  });
});
