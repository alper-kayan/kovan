import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, lastLink, oauthLogin, startHarness, type Harness } from './test/harness.js';

let h: Harness;
let alice: { token: string; orgId: string; id: string };
let bob: { token: string; id: string };

async function me(token: string) {
  return (await h.app.inject({ method: 'GET', url: '/api/me', headers: auth(token) })).json();
}

beforeAll(async () => {
  h = await startHarness();
  const a = await oauthLogin(h, 'github', 'alice', {
    providerUserId: '1',
    login: 'alice',
    name: 'Alice',
    email: 'alice@example.com',
    emailVerified: true,
  });
  alice = { token: a.token, id: a.user.id, orgId: (await me(a.token)).orgs[0].id };
  const b = await oauthLogin(h, 'github', 'bob', {
    providerUserId: '2',
    login: 'bob',
    name: 'Bob',
    email: 'bob@example.com',
    emailVerified: true,
  });
  bob = { token: b.token, id: b.user.id };
});
afterAll(async () => {
  await h.close();
});

async function createWorkspace(token: string, orgId: string, name: string, repoUrl: string | null) {
  return h.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    headers: auth(token),
    payload: { orgId, name, repoUrl },
  });
}

describe('workspaces', () => {
  it('creates a workspace with the creator as owner, and returns the existing one for the same repo', async () => {
    const res = await createWorkspace(alice.token, alice.orgId, 'lobby', 'github.com/acme/lobby');
    expect(res.statusCode).toBe(201);
    expect(res.json().workspace.role).toBe('owner');
    const again = await createWorkspace(
      alice.token,
      alice.orgId,
      'lobby 2',
      'github.com/acme/lobby',
    );
    expect(again.json()).toMatchObject({
      existing: true,
      workspace: { id: res.json().workspace.id },
    });
  });

  it("hides other people's workspaces and orgs", async () => {
    const res = await createWorkspace(alice.token, alice.orgId, 'private', null);
    const id = res.json().workspace.id;
    expect(
      (
        await h.app.inject({
          method: 'GET',
          url: `/api/workspaces/${id}`,
          headers: auth(bob.token),
        })
      ).statusCode,
    ).toBe(404);
    expect((await createWorkspace(bob.token, alice.orgId, 'sneaky', null)).statusCode).toBe(404);
  });
});

describe('what was sent, when it is wrong', () => {
  it('says what to fix, in words', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: auth(alice.token),
      payload: { orgId: alice.orgId, name: '', repoUrl: null },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe("Name can't be empty.");
  });
});

describe('invites and roles', () => {
  let workspaceId: string;

  beforeAll(async () => {
    workspaceId = (
      await createWorkspace(alice.token, alice.orgId, 'shared', 'github.com/acme/shared')
    ).json().workspace.id;
  });

  it('adds an existing user straight away and emails them', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/invites`,
      headers: auth(alice.token),
      payload: { githubLogin: 'Bob', role: 'editor' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().member).toMatchObject({ userId: bob.id, role: 'editor' });
    expect(lastLink(h, 'bob@example.com')).toContain('/docs/getting-started/');
    const list = await h.app.inject({
      method: 'GET',
      url: '/api/workspaces',
      headers: auth(bob.token),
    });
    expect(list.json().workspaces.map((w: { name: string }) => w.name)).toContain('shared');
  });

  it('keeps an invite for someone new until they sign in with that GitHub account', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/invites`,
      headers: auth(alice.token),
      payload: { githubLogin: 'carol-dev', email: 'carol@example.com', role: 'commenter' },
    });
    expect(res.json().invite).toMatchObject({ githubLogin: 'carol-dev', role: 'commenter' });
    expect(res.json().invite.link).toContain('/join/?t=');
    expect(lastLink(h, 'carol@example.com')).toBe(res.json().invite.link);
    const mail = [...h.mailer.sent].reverse().find((m) => m.to === 'carol@example.com')!;
    expect(mail.text).toContain('a commenter: you can watch and leave comments');

    const carol = await oauthLogin(h, 'github', 'carol', {
      providerUserId: '3',
      login: 'carol-dev',
      name: 'Carol',
    });
    const list = await h.app.inject({
      method: 'GET',
      url: '/api/workspaces',
      headers: auth(carol.token),
    });
    expect(list.json().workspaces).toEqual([
      expect.objectContaining({ id: workspaceId, role: 'commenter' }),
    ]);

    const members = await h.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/members`,
      headers: auth(alice.token),
    });
    expect(members.json().invites).toEqual([]);
  });

  it('lets whoever holds the invite link join, signed in with any account, once', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/invites`,
      headers: auth(alice.token),
      payload: { email: 'dana@company.example', role: 'editor' },
    });
    const link = new URL(res.json().invite.link as string);
    const token = link.searchParams.get('t')!;

    // Before signing in, the link says whose workspace and which role.
    const lookup = await h.app.inject({ method: 'GET', url: `/api/invites/lookup?t=${token}` });
    expect(lookup.json()).toMatchObject({
      status: 'pending',
      workspaceName: 'shared',
      repoUrl: 'github.com/acme/shared',
      role: 'editor',
      sentTo: 'dana@company.example',
    });
    expect(
      (await h.app.inject({ method: 'GET', url: '/api/invites/lookup?t=not-a-token' })).statusCode,
    ).toBe(404);

    // Dana signs in with Apple's private address: no email match, the link still joins her.
    const dana = await oauthLogin(h, 'github', 'dana', {
      providerUserId: '41',
      login: 'dana-private',
      name: 'Dana',
    });
    expect((await me(dana.token)).orgs.map((o: { role: string }) => o.role)).toEqual(['owner']);
    const accepted = await h.app.inject({
      method: 'POST',
      url: '/api/invites/accept',
      headers: auth(dana.token),
      payload: { token },
    });
    expect(accepted.json()).toEqual({ workspaceId, workspaceName: 'shared', role: 'editor' });
    // Again is fine for her; nobody else gets in with the same link.
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: '/api/invites/accept',
          headers: auth(dana.token),
          payload: { token },
        })
      ).statusCode,
    ).toBe(200);
    const erin = await oauthLogin(h, 'github', 'erin', { providerUserId: '42', login: 'erin' });
    const again = await h.app.inject({
      method: 'POST',
      url: '/api/invites/accept',
      headers: auth(erin.token),
      payload: { token },
    });
    expect(again.statusCode).toBe(409);
    expect(
      (await h.app.inject({ method: 'GET', url: `/api/invites/lookup?t=${token}` })).json().status,
    ).toBe('accepted');
  });

  it('enforces roles on the very next request after a downgrade', async () => {
    // Bob is promoted to owner and can change settings...
    await h.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${workspaceId}/members/${bob.id}`,
      headers: auth(alice.token),
      payload: { role: 'owner' },
    });
    const ok = await h.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${workspaceId}`,
      headers: auth(bob.token),
      payload: { defaultBranch: 'develop' },
    });
    expect(ok.statusCode).toBe(200);

    // ...then downgraded to viewer: his next settings change is rejected.
    await h.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${workspaceId}/members/${bob.id}`,
      headers: auth(alice.token),
      payload: { role: 'viewer' },
    });
    const denied = await h.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${workspaceId}`,
      headers: auth(bob.token),
      payload: { defaultBranch: 'main' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('forbidden');

    // Viewers can still read.
    expect(
      (
        await h.app.inject({
          method: 'GET',
          url: `/api/workspaces/${workspaceId}`,
          headers: auth(bob.token),
        })
      ).statusCode,
    ).toBe(200);
  });

  it('lets owners recommend plugins that members see but cannot change', async () => {
    const plugin = {
      name: 'release-tools',
      source: 'https://github.com/acme/release-tools.git',
      description: 'Release notes and changelogs',
    };
    const set = await h.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${workspaceId}`,
      headers: auth(alice.token),
      payload: { recommendedPlugins: [plugin] },
    });
    expect(set.statusCode).toBe(200);
    const seen = await h.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}`,
      headers: auth(bob.token),
    });
    expect(seen.json().workspace.recommendedPlugins).toEqual([{ ...plugin, path: '', ref: '' }]);
    const denied = await h.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${workspaceId}`,
      headers: auth(bob.token),
      payload: { recommendedPlugins: [] },
    });
    expect(denied.statusCode).toBe(403);
    const bad = await h.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${workspaceId}`,
      headers: auth(alice.token),
      payload: { recommendedPlugins: [{ ...plugin, name: 'Not A Name' }] },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('never leaves a workspace without an owner', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${workspaceId}/members/${alice.id}`,
      headers: auth(alice.token),
      payload: { role: 'editor' },
    });
    expect(res.statusCode).toBe(409);
    const leave = await h.app.inject({
      method: 'DELETE',
      url: `/api/workspaces/${workspaceId}/members/${alice.id}`,
      headers: auth(alice.token),
    });
    expect(leave.statusCode).toBe(409);
  });

  it('lets members leave, and only managers remove others', async () => {
    const denied = await h.app.inject({
      method: 'DELETE',
      url: `/api/workspaces/${workspaceId}/members/${alice.id}`,
      headers: auth(bob.token),
    });
    expect(denied.statusCode).toBe(403);
    const leave = await h.app.inject({
      method: 'DELETE',
      url: `/api/workspaces/${workspaceId}/members/${bob.id}`,
      headers: auth(bob.token),
    });
    expect(leave.statusCode).toBe(200);
    expect(
      (
        await h.app.inject({
          method: 'GET',
          url: `/api/workspaces/${workspaceId}`,
          headers: auth(bob.token),
        })
      ).statusCode,
    ).toBe(404);
  });

  it('validates invite input', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/invites`,
      headers: auth(alice.token),
      payload: { role: 'editor' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('error reports', () => {
  it('stores reports and respects the opt-out', async () => {
    const report = {
      message: 'boom',
      stack: null,
      source: 'renderer',
      appVersion: '0.0.0',
      platform: 'darwin',
    };
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: '/api/error-reports',
          headers: auth(alice.token),
          payload: report,
        })
      ).statusCode,
    ).toBe(204);
    await h.app.inject({
      method: 'PATCH',
      url: '/api/me',
      headers: auth(alice.token),
      payload: { errorReports: false },
    });
    const rows = await h.ctx.db.query.errorReports.findMany();
    await h.app.inject({
      method: 'POST',
      url: '/api/error-reports',
      headers: auth(alice.token),
      payload: report,
    });
    expect(await h.ctx.db.query.errorReports.findMany()).toHaveLength(rows.length);
  });
});
