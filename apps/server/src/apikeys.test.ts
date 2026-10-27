import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, oauthLogin, startHarness, type Harness } from './test/harness.js';

let h: Harness;
type Person = { token: string; id: string };
let alice: Person; // owner
let bob: Person; // editor
let workspaceId: string;
let orgId: string;

async function api(token: string, method: string, url: string, payload?: object, key?: string) {
  const res = await h.app.inject({
    method: method as 'GET',
    url,
    headers: { ...auth(token), ...(key ? { 'idempotency-key': key } : {}) },
    ...(payload ? { payload } : {}),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON in tests
  return { status: res.statusCode, body: res.json() as Record<string, any> };
}

const makeKey = (name: string, scopes: string[], by = alice) =>
  api(by.token, 'POST', `/api/workspaces/${workspaceId}/api-keys`, { name, scopes });

beforeAll(async () => {
  h = await startHarness();
  const login = async (code: string, n: string) => {
    const r = await oauthLogin(h, 'github', code, { providerUserId: n, login: code, name: code });
    return { token: r.token, id: r.user.id };
  };
  alice = await login('alice', '1');
  bob = await login('bob', '2');
  orgId = (await api(alice.token, 'GET', '/api/me')).body.orgs[0].id;
  workspaceId = (
    await api(alice.token, 'POST', '/api/workspaces', { orgId, name: 'lobby', repoUrl: null })
  ).body.workspace.id;
  await api(alice.token, 'POST', `/api/workspaces/${workspaceId}/invites`, {
    githubLogin: 'bob',
    role: 'editor',
  });
});
afterAll(async () => {
  await h.close();
});

describe('workspace API keys', () => {
  it('are made by owners, shown once and listed without the secret', async () => {
    expect((await makeKey('Nope', ['read'], bob)).status).toBe(403);
    expect((await api(bob.token, 'GET', `/api/workspaces/${workspaceId}/api-keys`)).status).toBe(
      403,
    );
    const made = await makeKey('FounderOS', ['read', 'dispatch', 'read']);
    expect(made.status).toBe(200);
    expect(made.body.token).toMatch(/^kv_live_[A-Za-z0-9_-]{43}$/);
    expect(made.body.key).toMatchObject({
      name: 'FounderOS',
      scopes: ['read', 'dispatch'],
      createdByName: 'alice',
      lastUsedAt: null,
      prefix: `${made.body.token.slice(0, 14)}…`,
    });
    const list = (await api(alice.token, 'GET', `/api/workspaces/${workspaceId}/api-keys`)).body;
    expect(list.keys).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(made.body.token);
    expect((await makeKey('founderos', ['read'])).status).toBe(409);
    expect((await makeKey('Empty', [])).status).toBe(400);
    expect((await makeKey('Odd', ['admin'])).status).toBe(400);
  });

  it('reads and starts work without a browser sign-in, and is not listed as a person', async () => {
    const { token } = (await makeKey('Runner', ['read', 'dispatch'])).body;
    const spaces = await api(token, 'GET', '/api/workspaces');
    expect(spaces.status).toBe(200);
    expect(spaces.body.workspaces.map((w: { id: string }) => w.id)).toEqual([workspaceId]);

    const started = await api(
      token,
      'POST',
      `/api/workspaces/${workspaceId}/sessions`,
      { title: 'From outside', branch: 'kovan/outside' },
      'k-1',
    );
    expect(started.status).toBe(200);
    const me = (await api(token, 'GET', '/api/me')).body.user;
    expect(me).toMatchObject({ name: 'Runner' });
    expect(started.body.session.createdBy).toBe(me.id);
    // Its retries are its own: the same Idempotency-Key replays.
    const again = await api(
      token,
      'POST',
      `/api/workspaces/${workspaceId}/sessions`,
      { title: 'From outside', branch: 'kovan/outside' },
      'k-1',
    );
    expect(again.body.session.id).toBe(started.body.session.id);

    const members = (await api(alice.token, 'GET', `/api/workspaces/${workspaceId}/members`)).body
      .members as { name: string }[];
    expect(members.map((m) => m.name).sort()).toEqual(['alice', 'bob']);

    const listed = (await api(alice.token, 'GET', `/api/workspaces/${workspaceId}/api-keys`)).body
      .keys as { name: string; lastUsedAt: string | null }[];
    expect(listed.find((k) => k.name === 'Runner')?.lastUsedAt).not.toBeNull();
  });

  it('does only what its scopes allow, and never administers', async () => {
    const reader = (await makeKey('Reader', ['read'])).body.token;
    const controller = (await makeKey('Controller', ['read', 'dispatch', 'control'])).body.token;
    expect((await api(reader, 'GET', `/api/workspaces/${workspaceId}/sessions`)).status).toBe(200);
    expect(
      (
        await api(reader, 'POST', `/api/workspaces/${workspaceId}/sessions`, {
          title: 'x',
          branch: 'kovan/x',
        })
      ).status,
    ).toBe(403);

    // Control: a session it may end, a reader may not.
    const s = (
      await api(controller, 'POST', `/api/workspaces/${workspaceId}/sessions`, {
        title: 'Stop me',
        branch: 'kovan/stop',
      })
    ).body.session;
    expect((await api(reader, 'POST', `/api/sessions/${s.id}/end`, {})).status).toBe(403);
    expect((await api(controller, 'POST', `/api/sessions/${s.id}/end`, {})).status).toBe(200);

    for (const [method, url, body] of [
      ['POST', `/api/workspaces/${workspaceId}/invites`, { githubLogin: 'eve', role: 'owner' }],
      ['PATCH', `/api/workspaces/${workspaceId}`, { name: 'Taken' }],
      ['POST', `/api/workspaces/${workspaceId}/api-keys`, { name: 'More', scopes: ['read'] }],
      ['DELETE', `/api/workspaces/${workspaceId}`, undefined],
      ['POST', '/api/me/delete', { confirm: true }],
      ['POST', '/api/workspaces', { orgId, name: 'mine', repoUrl: null }],
      ['POST', `/api/sessions/${s.id}/join`, { mode: 'join' }],
    ] as const)
      expect((await api(controller, method, url, body)).status, `${method} ${url}`).toBe(403);
    // Reading is allowed, but owner-only pages stay closed to it.
    expect((await api(controller, 'GET', `/api/workspaces/${workspaceId}/api-keys`)).status).toBe(
      403,
    );
  });

  it('stops working when revoked, and outlives the person who made it', async () => {
    const { key, token } = (await makeKey('Temporary', ['read'])).body;
    expect((await api(token, 'GET', '/api/workspaces')).status).toBe(200);
    expect(
      (await api(bob.token, 'DELETE', `/api/workspaces/${workspaceId}/api-keys/${key.id}`)).status,
    ).toBe(403);
    expect(
      (await api(alice.token, 'DELETE', `/api/workspaces/${workspaceId}/api-keys/${key.id}`))
        .status,
    ).toBe(200);
    const after = await api(token, 'GET', '/api/workspaces');
    expect(after.status).toBe(401);
    expect(after.body.error.message).toMatch(/revoked/);
    expect(
      (await api(alice.token, 'DELETE', `/api/workspaces/${workspaceId}/api-keys/${key.id}`))
        .status,
    ).toBe(404);
    expect((await api('kv_live_made-up', 'GET', '/api/workspaces')).status).toBe(401);

    const audit = (await api(alice.token, 'GET', `/api/orgs/${orgId}/audit`)).body.entries as {
      action: string;
      target: string;
    }[];
    expect(audit.filter((e) => e.target === 'Temporary').map((e) => e.action)).toEqual([
      'api_key.revoked',
      'api_key.created',
    ]);

    // Alice made "Runner"; she leaves Kovan, bob becomes owner, and the key keeps working.
    const runner = (await api(alice.token, 'GET', `/api/workspaces/${workspaceId}/api-keys`)).body
      .keys as { name: string }[];
    expect(runner.some((k) => k.name === 'Runner')).toBe(true);
    const lasting = (await makeKey('Lasting', ['read'])).body.token;
    expect((await api(alice.token, 'POST', '/api/me/delete', { confirm: true })).status).toBe(200);
    expect((await api(lasting, 'GET', `/api/workspaces/${workspaceId}/sessions`)).status).toBe(200);
    const kept = (await api(bob.token, 'GET', `/api/workspaces/${workspaceId}/api-keys`)).body
      .keys as { name: string; createdByName: string }[];
    expect(kept.find((k) => k.name === 'Lasting')?.createdByName).toBe('alice');
  });
});
