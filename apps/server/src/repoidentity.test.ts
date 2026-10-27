import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, oauthLogin, startHarness, type Harness } from './test/harness.js';

let h: Harness;
let token: string;
let orgId: string;

async function api(method: string, url: string, payload?: object, as = token) {
  const res = await h.app.inject({
    method: method as 'GET',
    url,
    headers: auth(as),
    ...(payload ? { payload } : {}),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON in tests
  return { status: res.statusCode, body: res.json() as Record<string, any> };
}

beforeAll(async () => {
  h = await startHarness();
  token = (await oauthLogin(h, 'github', 'alice', { providerUserId: '1', login: 'alice' })).token;
  orgId = (await api('GET', '/api/me')).body.orgs[0].id;
});
afterAll(async () => {
  await h.close();
});

describe('repository identity', () => {
  it('stores any form of the remote normalised, and finds the workspace from any form', async () => {
    const made = await api('POST', '/api/workspaces', {
      orgId,
      name: 'shop',
      repoUrl: 'git@github.com:Acme/shop.git',
      defaultBranch: 'trunk',
    });
    expect(made.status).toBe(201);
    expect(made.body.workspace).toMatchObject({
      repoUrl: 'github.com/Acme/shop',
      defaultBranch: 'trunk',
    });
    const id = made.body.workspace.id;
    await api('POST', '/api/workspaces', { orgId, name: 'other', repoUrl: null });

    for (const form of [
      'https://github.com/Acme/shop.git',
      'ssh://git@github.com/Acme/shop',
      'git@GitHub.com:Acme/shop.git',
      'https://github.com/Acme/shop/',
    ]) {
      const found = await api('GET', `/api/workspaces?repo=${encodeURIComponent(form)}`);
      expect(
        found.body.workspaces.map((w: { id: string }) => w.id),
        form,
      ).toEqual([id]);
    }
    expect(
      (await api('GET', `/api/workspaces?repo=${encodeURIComponent('github.com/acme/elsewhere')}`))
        .body.workspaces,
    ).toEqual([]);
    expect((await api('GET', '/api/workspaces?repo=not%20a%20remote')).status).toBe(400);
    expect((await api('GET', '/api/workspaces')).body.workspaces).toHaveLength(2);

    // The same repository again, in another form: the existing workspace comes back.
    const again = await api('POST', '/api/workspaces', {
      orgId,
      name: 'shop again',
      repoUrl: 'https://github.com/Acme/shop',
    });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ existing: true, workspace: { id } });
  });

  it('keeps the issue a session works on, with the branch and pull request', async () => {
    const shop = (
      await api('GET', `/api/workspaces?repo=${encodeURIComponent('github.com/Acme/shop')}`)
    ).body.workspaces[0];
    const started = await api('POST', `/api/workspaces/${shop.id}/sessions`, {
      title: 'Fix the cart total',
      branch: 'kovan/cart-total',
      issue: { number: 12 },
    });
    expect(started.status).toBe(200);
    const view = (await api('GET', `/api/sessions/${started.body.session.id}`)).body.session;
    expect(view).toMatchObject({
      branch: 'kovan/cart-total',
      pr: null,
      issue: { number: 12, url: 'https://github.com/Acme/shop/issues/12' },
    });

    const linked = await api('POST', `/api/workspaces/${shop.id}/sessions`, {
      title: 'Tracked elsewhere',
      branch: 'kovan/elsewhere',
      issue: { number: 7, url: 'https://linear.app/acme/issue/SHOP-7' },
    });
    expect(linked.body.session.issue).toEqual({
      number: 7,
      url: 'https://linear.app/acme/issue/SHOP-7',
    });
    const plain = await api('POST', `/api/workspaces/${shop.id}/sessions`, {
      title: 'No issue',
      branch: 'kovan/plain',
    });
    expect(plain.body.session.issue).toBeNull();
    for (const issue of [
      { number: 0 },
      { number: 1.5 },
      { number: 3, url: 'http://example.com/3' },
      { number: 3, url: 'javascript:alert(1)' },
    ])
      expect(
        (
          await api('POST', `/api/workspaces/${shop.id}/sessions`, {
            title: 'Bad',
            branch: 'kovan/bad',
            issue,
          })
        ).status,
        JSON.stringify(issue),
      ).toBe(400);

    // Without a GitHub remote there is no page to point at.
    const other = (await api('GET', '/api/workspaces')).body.workspaces.find(
      (w: { name: string }) => w.name === 'other',
    );
    const local = await api('POST', `/api/workspaces/${other.id}/sessions`, {
      title: 'Local',
      branch: null,
      issue: { number: 4 },
    });
    expect(local.body.session.issue).toEqual({ number: 4, url: null });

    // Pull request state lands on the same session.
    expect(
      (
        await api('POST', `/api/sessions/${started.body.session.id}/pr`, {
          url: 'https://github.com/Acme/shop/pull/30',
          number: 30,
          state: 'open',
        })
      ).status,
    ).toBe(200);
    expect(
      (await api('GET', `/api/sessions/${started.body.session.id}`)).body.session,
    ).toMatchObject({
      pr: { url: 'https://github.com/Acme/shop/pull/30', number: 30, state: 'open' },
      issue: { number: 12 },
    });
  });
});
