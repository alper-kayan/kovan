import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, oauthLogin, startHarness, type Harness } from './test/harness.js';

let h: Harness;
type Person = { token: string; id: string };
let ana: Person; // owner
let bora: Person; // editor
let wsId: string;
let sessionId: string;
let otherSession: string;

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
  const login = async (code: string, n: string, name: string) => {
    const r = await oauthLogin(h, 'github', code, { providerUserId: n, login: code, name });
    return { token: r.token, id: r.user.id };
  };
  ana = await login('ana', '1', 'Ana');
  bora = await login('bora', '2', 'Bora');
  const orgId = (await api(ana, 'GET', '/api/me')).body.orgs[0].id;
  const workspace = async (name: string) =>
    (await api(ana, 'POST', '/api/workspaces', { orgId, name, repoUrl: null })).body.workspace
      .id as string;
  wsId = await workspace('Shop');
  const other = await workspace('Other');
  await api(ana, 'POST', `/api/workspaces/${wsId}/invites`, {
    githubLogin: 'bora',
    role: 'editor',
  });
  const session = async (ws: string, title: string) =>
    (await api(ana, 'POST', `/api/workspaces/${ws}/sessions`, { title, branch: `kovan/${title}` }))
      .body.session.id as string;
  sessionId = await session(wsId, 'totals');
  otherSession = await session(other, 'elsewhere');
});

afterAll(() => h.close());

describe("an AI teammate's monthly limit", () => {
  it("is the owner's to set; anyone who can add a teammate adds one without it", async () => {
    const refused = await api(bora, 'POST', `/api/workspaces/${wsId}/agents`, {
      name: 'Wren',
      model: 'openai/gpt-5.6-luna',
      monthlyLimit: 5,
    });
    expect(refused.status).toBe(403);
    const wren = await api(bora, 'POST', `/api/workspaces/${wsId}/agents`, {
      name: 'Wren',
      model: 'openai/gpt-5.6-luna',
    });
    expect(wren.body.agent).toMatchObject({ monthlyLimit: null, monthSpent: 0 });
    const id = wren.body.agent.id as string;
    expect((await api(bora, 'PATCH', `/api/agents/${id}`, { monthlyLimit: 1 })).status).toBe(403);
    // An editor still changes the rest.
    expect(
      (await api(bora, 'PATCH', `/api/agents/${id}`, { instructions: 'Tests first' })).status,
    ).toBe(200);
    const set = await api(ana, 'PATCH', `/api/agents/${id}`, { monthlyLimit: 0.05 });
    expect(set.body.agent.monthlyLimit).toBe(0.05);
  });

  it('counts what its direct tasks cost, and says to stop at the limit', async () => {
    const { agents } = (await api(ana, 'GET', `/api/workspaces/${wsId}/agents`)).body;
    const id = agents.find((a: { name: string }) => a.name === 'Wren').id as string;
    const spend = (amount: number, session = sessionId) =>
      api(bora, 'POST', `/api/agents/${id}/spend`, { sessionId: session, amount });
    expect((await spend(0)).body).toEqual({ monthSpent: 0, over: null });
    expect((await spend(0.03)).body).toEqual({ monthSpent: 0.03, over: null });
    const over = await spend(0.03);
    expect(over.body.monthSpent).toBeCloseTo(0.06);
    expect(over.body.over).toBe("Wren's monthly limit is reached ($0.0600 of $0.0500)");
    // Asking again before more work gets the same no.
    expect((await spend(0)).body.over).toContain('monthly limit is reached');
    const listed = (await api(ana, 'GET', `/api/workspaces/${wsId}/agents`)).body.agents[0];
    expect(listed.monthSpent).toBeCloseTo(0.06);
    // Only for its own workspace's sessions.
    expect((await spend(0.01, otherSession)).status).toBe(400);
  });

  it("counts toward the workspace's limit too", async () => {
    const moss = await api(ana, 'POST', `/api/workspaces/${wsId}/agents`, {
      name: 'Moss',
      model: 'openai/gpt-5.6-luna',
    });
    const id = moss.body.agent.id as string;
    await api(ana, 'PATCH', `/api/workspaces/${wsId}`, { agentMonthlyLimit: 0.07 });
    const r = await api(bora, 'POST', `/api/agents/${id}/spend`, { sessionId, amount: 0.02 });
    expect(r.body.over).toBe("The workspace's monthly agent limit is reached ($0.0800 of $0.0700)");
    const stats = await api(ana, 'GET', `/api/workspaces/${wsId}/agent-spend`);
    expect(stats.body.stats.monthSpent).toBeCloseTo(0.08);
  });
});
