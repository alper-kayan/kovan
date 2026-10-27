import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, oauthLogin, startHarness, type Harness } from './test/harness.js';

let h: Harness;
let alice: string;
let bob: string;
let workspaceId: string;

const record = (model: string, cost: number, kind: 'model' | 'routing' = 'model') => ({
  model,
  kind,
  promptTokens: 1000,
  completionTokens: 100,
  cachedTokens: 200,
  cost,
  estimated: false,
});

beforeAll(async () => {
  h = await startHarness();
  alice = (await oauthLogin(h, 'github', 'alice', { providerUserId: '1', login: 'alice' })).token;
  bob = (await oauthLogin(h, 'github', 'bob', { providerUserId: '2', login: 'bob' })).token;
  const orgId = (await h.app.inject({ method: 'GET', url: '/api/me', headers: auth(alice) })).json()
    .orgs[0].id;
  workspaceId = (
    await h.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: auth(alice),
      payload: { orgId, name: 'w', repoUrl: null },
    })
  ).json().workspace.id;
});
afterAll(async () => {
  await h.close();
});

describe('usage', () => {
  it('records usage and summarises it by model, workspace and day', async () => {
    const post = (payload: object) =>
      h.app.inject({ method: 'POST', url: '/api/usage', headers: auth(alice), payload });
    expect(
      (
        await post({
          workspaceId,
          conversationId: 'c1',
          records: [record('a/sonnet', 0.02), record('a/luna', 0.0001, 'routing')],
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (await post({ workspaceId: null, conversationId: 'c2', records: [record('a/sonnet', 0.01)] }))
        .statusCode,
    ).toBe(204);

    const summary = (
      await h.app.inject({ method: 'GET', url: '/api/usage', headers: auth(alice) })
    ).json();
    expect(summary.total).toBeCloseTo(0.0301);
    expect(summary.calls).toBe(3);
    expect(summary.byModel[0]).toMatchObject({ model: 'a/sonnet', calls: 2, promptTokens: 2000 });
    expect(summary.byModel[0].cost).toBeCloseTo(0.03);
    expect(summary.byWorkspace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workspaceId, name: 'w' }),
        expect.objectContaining({ workspaceId: null }),
      ]),
    );
    expect(summary.byDay).toHaveLength(1);
  });

  it("refuses usage filed against someone else's workspace, and keeps people's usage separate", async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/usage',
      headers: auth(bob),
      payload: { workspaceId, conversationId: 'x', records: [record('m', 1)] },
    });
    expect(res.statusCode).toBe(404);
    const summary = (
      await h.app.inject({ method: 'GET', url: '/api/usage', headers: auth(bob) })
    ).json();
    expect(summary).toMatchObject({ total: 0, calls: 0, byModel: [] });
  });

  it('validates reports', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/usage',
      headers: auth(alice),
      payload: { workspaceId: null, conversationId: 'c', records: [] },
    });
    expect(res.statusCode).toBe(400);
  });
});
