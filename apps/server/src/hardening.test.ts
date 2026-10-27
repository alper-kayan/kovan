import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { MESSAGE_LIMIT } from './realtime/hub.js';
import { auth, connect, oauthLogin, startHarness, type Harness } from './test/harness.js';

let h: Harness;
let alice: { token: string; orgId: string; id: string };
let bob: { token: string; id: string };
let workspaceId: string;

const call = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  token: string,
  payload?: object,
) => h.app.inject({ method, url, headers: auth(token), ...(payload ? { payload } : {}) });

beforeAll(async () => {
  h = await startHarness({ DOWNLOAD_BASE_URL: 'https://releases.example/latest/download/' });
  const a = await oauthLogin(h, 'github', 'alice', {
    providerUserId: '1',
    login: 'alice',
    name: 'Alice',
    email: 'alice@example.com',
    emailVerified: true,
  });
  const me = (await call('GET', '/api/me', a.token)).json();
  alice = { token: a.token, id: a.user.id, orgId: me.orgs[0].id };
  const b = await oauthLogin(h, 'github', 'bob', {
    providerUserId: '2',
    login: 'bob',
    name: 'Bob',
    email: 'bob@example.com',
    emailVerified: true,
  });
  bob = { token: b.token, id: b.user.id };
  workspaceId = (
    await call('POST', '/api/workspaces', alice.token, {
      orgId: alice.orgId,
      name: 'lobby',
      repoUrl: null,
    })
  ).json().workspace.id;
});
afterAll(async () => {
  await h.close();
});

describe('org settings and the audit log', () => {
  it('lets only an org owner change transcript retention, within bounds', async () => {
    const org = (await call('GET', `/api/orgs/${alice.orgId}`, alice.token)).json().org;
    expect(org).toMatchObject({ role: 'owner', transcriptRetentionDays: 90 });

    for (const days of [0, 3651, 1.5])
      expect(
        (
          await call('PATCH', `/api/orgs/${alice.orgId}`, alice.token, {
            transcriptRetentionDays: days,
          })
        ).statusCode,
      ).toBe(400);

    const saved = await call('PATCH', `/api/orgs/${alice.orgId}`, alice.token, {
      transcriptRetentionDays: 30,
    });
    expect(saved.json().org.transcriptRetentionDays).toBe(30);

    // Someone outside the org can't tell it exists.
    expect((await call('GET', `/api/orgs/${alice.orgId}`, bob.token)).statusCode).toBe(404);
    expect(
      (await call('PATCH', `/api/orgs/${alice.orgId}`, bob.token, { transcriptRetentionDays: 1 }))
        .statusCode,
    ).toBe(404);
  });

  it('records who changed what, newest first, and shows it to owners only', async () => {
    await call('POST', `/api/workspaces/${workspaceId}/invites`, alice.token, {
      githubLogin: 'bob',
      role: 'editor',
    });
    await call('PATCH', `/api/workspaces/${workspaceId}/members/${bob.id}`, alice.token, {
      role: 'viewer',
    });
    await call('POST', `/api/workspaces/${workspaceId}/invites`, alice.token, {
      email: 'carol@example.com',
      role: 'editor',
    });
    await call('DELETE', `/api/workspaces/${workspaceId}/members/${bob.id}`, bob.token);

    const res = await call('GET', `/api/orgs/${alice.orgId}/audit`, alice.token);
    expect(res.statusCode).toBe(200);
    const entries = res.json().entries as {
      action: string;
      actorName: string;
      target: string | null;
      meta: Record<string, unknown> | null;
      createdAt: string;
    }[];
    expect(entries.map((e) => e.action)).toEqual([
      'member.left',
      'invite.created',
      'member.role_changed',
      'member.added',
      'org.retention_changed',
      'workspace.created',
    ]);
    expect(entries[0]).toMatchObject({ actorName: 'Bob', target: null });
    expect(entries[1]).toMatchObject({ target: 'carol@example.com', meta: { role: 'editor' } });
    expect(entries[2]).toMatchObject({ target: 'Bob', meta: { from: 'editor', to: 'viewer' } });
    expect(entries[4]!.meta).toEqual({ from: 90, to: 30 });
    // The address is kept for the operator, not handed to the app.
    expect(entries[0]).not.toHaveProperty('ip');

    const page = await call(
      'GET',
      `/api/orgs/${alice.orgId}/audit?limit=2&before=${encodeURIComponent(entries[1]!.createdAt)}`,
      alice.token,
    );
    expect(page.json().entries.map((e: { action: string }) => e.action)).toEqual([
      'member.role_changed',
      'member.added',
    ]);

    // Bob is still an org member (he was added to a workspace) but not an owner.
    expect((await call('GET', `/api/orgs/${alice.orgId}/audit`, bob.token)).statusCode).toBe(403);
    expect(
      (await call('PATCH', `/api/orgs/${alice.orgId}`, bob.token, { transcriptRetentionDays: 1 }))
        .statusCode,
    ).toBe(403);
  });

  it('redacts secrets from comments and memories before they are stored', async () => {
    const memory = await call('POST', `/api/workspaces/${workspaceId}/memories`, alice.token, {
      kind: 'gotcha',
      text: 'deploy with STRIPE_SECRET_KEY=sk_live_abcdefghijklmnop1234',
    });
    expect(memory.statusCode, memory.body).toBeLessThan(300);
    expect(memory.body).toContain('[redacted]');
    expect(memory.body).not.toContain('sk_live_abcdefghijklmnop1234');
  });
});

describe('http hardening', () => {
  it('sends security headers, and a strict CSP with pages', async () => {
    const json = await h.app.inject({ method: 'GET', url: '/health' });
    expect(json.headers['x-content-type-options']).toBe('nosniff');
    expect(json.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(json.headers['content-security-policy']).toBeUndefined();

    const html = await h.app.inject({ method: 'GET', url: '/billing/cancelled' });
    const csp = String(html.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("'unsafe-eval'");

    const me = await call('GET', '/api/me', alice.token);
    expect(me.headers['cache-control']).toBe('no-store');
  });

  it('publishes where to report a vulnerability', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/.well-known/security.txt' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Contact: mailto:kovan@alperkayan.dev');
    expect(res.body).toMatch(/Expires: \d{4}-/);
  });

  it('points downloads and update files at the release host, and nothing else', async () => {
    const mac = await h.app.inject({ method: 'GET', url: '/download/mac' });
    expect(mac.statusCode).toBe(302);
    expect(mac.headers.location).toBe(
      'https://releases.example/latest/download/Kovan-mac-arm64.dmg',
    );
    const feed = await h.app.inject({ method: 'GET', url: '/updates/latest-mac.yml' });
    expect(feed.headers.location).toBe('https://releases.example/latest/download/latest-mac.yml');
    for (const bad of ['/updates/..%2Fsecret', '/updates/a%2Fb', '/updates/%40evil.example'])
      expect((await h.app.inject({ method: 'GET', url: bad })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: '/download/solaris' })).statusCode).toBe(404);
  });

  it('cuts off a socket that floods', async () => {
    const c = await connect(h, alice.token);
    await c.waitFor((m) => m.type === 'welcome');
    const closed = new Promise<number>((resolve) =>
      c.socket.once('close', (code) => resolve(code)),
    );
    for (let i = 0; i <= MESSAGE_LIMIT + 5 && c.socket.readyState === WebSocket.OPEN; i++)
      c.send({ type: 'ping' });
    expect(await closed).toBe(4429);
  });
});

describe('rate limits', () => {
  it('limits each signed-in person on their own, and answers 429', async () => {
    const limited = await startHarness({ API_RATE_LIMIT: '5' });
    try {
      const login = (code: string, id: string) =>
        oauthLogin(limited, 'github', code, {
          providerUserId: id,
          login: code,
          name: code,
          email: `${code}@example.com`,
          emailVerified: true,
        });
      const a = await login('ann', '1');
      const b = await login('ben', '2');
      const get = (token: string) =>
        limited.app.inject({ method: 'GET', url: '/api/me', headers: auth(token) });
      const codes: number[] = [];
      for (let i = 0; i < 7; i++) codes.push((await get(a.token)).statusCode);
      expect(codes).toEqual([200, 200, 200, 200, 200, 429, 429]);
      const refused = await get(a.token);
      expect(refused.json().error.code).toBe('rate_limited');
      expect(refused.headers['retry-after']).toBeDefined();
      // Someone else is not slowed down by it, and pages aren't counted.
      expect((await get(b.token)).statusCode).toBe(200);
      expect((await limited.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });
});
