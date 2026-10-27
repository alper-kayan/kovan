import { effectiveMode } from '@kovan/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, oauthLogin, startHarness, type Harness } from './test/harness.js';

let h: Harness;
type Person = { token: string; id: string };
let alice: Person; // owner of "solo-ws", alone at first
let bob: Person; // invited later
let eve: Person; // in her own workspace only
let soloId: string;
let eveWs: string;

async function api(person: Person, method: string, url: string, payload?: object) {
  const res = await h.app.inject({
    method: method as 'GET',
    url,
    headers: auth(person.token),
    ...(payload ? { payload } : {}),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON in tests
  return { status: res.statusCode, body: res.json() as Record<string, any> };
}

beforeAll(async () => {
  h = await startHarness();
  const login = async (code: string, n: string) => {
    const r = await oauthLogin(h, 'github', code, { providerUserId: n, login: code, name: code });
    return { token: r.token, id: r.user.id };
  };
  alice = await login('alice', '1');
  bob = await login('bob', '2');
  eve = await login('eve', '5');
  const workspace = async (who: Person, name: string) => {
    const orgId = (await api(who, 'GET', '/api/me')).body.orgs[0].id;
    return (await api(who, 'POST', '/api/workspaces', { orgId, name, repoUrl: null })).body
      .workspace;
  };
  const ws = await workspace(alice, 'solo-ws');
  soloId = ws.id;
  expect(ws.mode).toBe('adaptive');
  eveWs = (await workspace(eve, 'eve-ws')).id;
});

afterAll(async () => {
  await h.close();
});

describe('effectiveMode', () => {
  it('reads adaptive by who is in the workspace', () => {
    expect(effectiveMode('adaptive', 1)).toBe('solo');
    expect(effectiveMode('adaptive', 2)).toBe('team');
    expect(effectiveMode('solo', 1)).toBe('solo');
    expect(effectiveMode('team', 1)).toBe('team');
  });
});

describe('workspace modes', () => {
  it('keeps a Solo workspace to one person, and lets owners switch', async () => {
    const solo = await api(alice, 'PATCH', `/api/workspaces/${soloId}`, { mode: 'solo' });
    expect(solo.body.workspace.mode).toBe('solo');
    // Solo means nobody else: no invites.
    const invite = await api(alice, 'POST', `/api/workspaces/${soloId}/invites`, {
      githubLogin: 'bob',
      role: 'editor',
    });
    expect(invite.status).toBe(409);
    expect(invite.body.error.message).toContain('Solo workspace');

    // AI teammates are fine in Solo: they are the person's own agents.
    const ai = await api(alice, 'POST', `/api/workspaces/${soloId}/agents`, {
      name: 'Wren',
      model: 'openai/gpt-5.6-luna',
    });
    expect(ai.status).toBe(200);
    expect((await api(alice, 'PATCH', `/api/workspaces/${soloId}`, { mode: 'solo' })).status).toBe(
      200,
    );

    // Adaptive takes people in; then Solo can't be chosen while they are members.
    await api(alice, 'PATCH', `/api/workspaces/${soloId}`, { mode: 'adaptive' });
    expect(
      (
        await api(alice, 'POST', `/api/workspaces/${soloId}/invites`, {
          githubLogin: 'bob',
          role: 'editor',
        })
      ).status,
    ).toBe(201);
    const back = await api(alice, 'PATCH', `/api/workspaces/${soloId}`, { mode: 'solo' });
    expect(back.status).toBe(409);
    expect(back.body.error.message).toContain('2 people are members');
    // Only owners change how a workspace works.
    expect((await api(bob, 'PATCH', `/api/workspaces/${soloId}`, { mode: 'team' })).status).toBe(
      403,
    );
  });
});

describe('workspace boundaries for agent work', () => {
  it("keeps one workspace's agent work out of reach of another's members", async () => {
    const session = (
      await api(alice, 'POST', `/api/workspaces/${soloId}/sessions`, {
        title: 'Private work',
        branch: 'kovan/private',
      })
    ).body.session;
    const step = (
      await api(alice, 'POST', `/api/sessions/${session.id}/plan/steps`, {
        steps: [{ title: 'Migrate users', approvalReason: 'Changes the schema' }],
      })
    ).body.plan.steps[0];
    const wren = (await api(alice, 'GET', `/api/workspaces/${soloId}/agents`)).body.agents[0];
    const swarm = (
      await api(alice, 'PUT', `/api/sessions/${session.id}/swarm`, {
        goal: 'Migrate users',
        leadAgentId: wren.id,
        agentIds: [wren.id],
        budget: 1,
      })
    ).body.swarm;

    // Eve is signed in, but not a member: everything answers "not found" or "forbidden".
    const outside = [
      await api(eve, 'GET', `/api/workspaces/${soloId}/agent-spend`),
      await api(eve, 'GET', `/api/sessions/${session.id}/plan`),
      await api(eve, 'GET', `/api/sessions/${session.id}/subagents`),
      await api(eve, 'GET', `/api/sessions/${session.id}/swarm`),
      await api(eve, 'POST', `/api/plan-steps/${step.id}/approval`, { approve: true }),
      await api(eve, 'PATCH', `/api/plan-steps/${step.id}`, { runState: 'waiting' }),
      await api(eve, 'POST', `/api/sessions/${session.id}/subagents`, { task: 'x' }),
      await api(eve, 'POST', `/api/swarms/${swarm.id}/launch`),
      await api(eve, 'POST', `/api/swarms/${swarm.id}/report`, { agentId: wren.id, cost: 1 }),
      await api(eve, 'PATCH', `/api/workspaces/${soloId}`, { agentMonthlyLimit: 1000 }),
    ];
    for (const r of outside) expect([403, 404]).toContain(r.status);
    // Nothing she sent counted or changed.
    const plan = (await api(alice, 'GET', `/api/sessions/${session.id}/plan`)).body.plan;
    expect(plan.steps[0]).toMatchObject({ approval: 'pending', runState: null });
    const stats = (await api(alice, 'GET', `/api/workspaces/${soloId}/agent-spend`)).body.stats;
    expect(stats.monthSpent).toBe(0);
    expect(stats.monthLimit).toBeNull();
    // And her own workspace shows none of it.
    const mine = (await api(eve, 'GET', `/api/workspaces/${eveWs}/agent-spend`)).body.stats;
    expect(mine).toMatchObject({ monthSpent: 0, tasks: 0 });
  });
});
