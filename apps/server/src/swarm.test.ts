import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, connect, oauthLogin, startHarness, type Harness } from './test/harness.js';

let h: Harness;
type Person = { token: string; id: string };
let alice: Person; // owner
let bob: Person; // editor
let dave: Person; // viewer
let workspaceId: string;
type Msg = { type: string; [k: string]: unknown };

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
  dave = await login('dave', '4');
  const orgId = (await api(alice, 'GET', '/api/me')).body.orgs[0].id;
  workspaceId = (
    await api(alice, 'POST', '/api/workspaces', { orgId, name: 'lobby', repoUrl: null })
  ).body.workspace.id;
  for (const [login, role] of [
    ['bob', 'editor'],
    ['dave', 'viewer'],
  ])
    await api(alice, 'POST', `/api/workspaces/${workspaceId}/invites`, {
      githubLogin: login,
      role,
    });
});
afterAll(async () => {
  await h.close();
});

const agent = (name: string, by: Person = alice) =>
  api(by, 'POST', `/api/workspaces/${workspaceId}/agents`, {
    name,
    model: 'openai/gpt-5.6-luna',
    instructions: `${name} writes small, tested changes.`,
  });

async function session(title: string) {
  return (
    await api(alice, 'POST', `/api/workspaces/${workspaceId}/sessions`, {
      title,
      branch: 'kovan/x',
    })
  ).body.session as { id: string };
}

describe('AI teammates', () => {
  it('are members of the workspace like people, without an account', async () => {
    expect((await agent('Nope', dave)).status).toBe(403);
    const created = await agent('Rook');
    expect(created.status).toBe(200);
    expect(created.body.agent).toMatchObject({
      name: 'Rook',
      mode: 'allow',
      createdByName: 'alice',
    });
    expect((await agent('rook')).status).toBe(409);
    expect((await agent('alice')).status).toBe(409);

    const members = (await api(dave, 'GET', `/api/workspaces/${workspaceId}/members`)).body
      .members as { name: string; kind: string; role: string }[];
    expect(members.find((m) => m.name === 'Rook')).toMatchObject({ kind: 'agent', role: 'editor' });
    expect(members.find((m) => m.name === 'alice')?.kind).toBe('human');

    const id = created.body.agent.id;
    expect(
      (await api(bob, 'PATCH', `/api/agents/${id}`, { instructions: 'Reviews first.' })).body.agent
        .instructions,
    ).toBe('Reviews first.');
    // Only whoever added it (or an owner) retires it.
    expect((await api(bob, 'DELETE', `/api/agents/${id}`)).status).toBe(403);
    expect((await api(alice, 'DELETE', `/api/agents/${id}`)).status).toBe(200);
    const after = (await api(alice, 'GET', `/api/workspaces/${workspaceId}/agents`)).body.agents;
    expect(after.map((a: { name: string }) => a.name)).not.toContain('Rook');
  });

  it('stream their lane only from the machine running them; steering goes there', async () => {
    const s = await session('Seat race');
    const lark = (await agent('Lark')).body.agent;
    await api(bob, 'POST', `/api/sessions/${s.id}/agents`, { agentId: lark.id });
    const view = (await api(alice, 'GET', `/api/sessions/${s.id}`)).body.session;
    expect(view.participants.find((p: { userId: string }) => p.userId === lark.id)).toMatchObject({
      name: 'Lark',
      kind: 'agent',
      hostId: bob.id,
      hostName: 'bob',
      mode: 'join',
    });

    const a = await connect(h, alice.token);
    await a.waitFor((m) => m.type === 'welcome');
    a.send({
      type: 'lane.events',
      sessionId: s.id,
      agentId: lark.id,
      events: [{ type: 'text', text: 'not mine to send' }],
    });
    expect((await a.waitFor((m: Msg) => m.type === 'error')).message).toMatch(/machine running/);

    const b = await connect(h, bob.token);
    await b.waitFor((m) => m.type === 'welcome');
    b.send({ type: 'session.subscribe', sessionId: s.id });
    await b.waitFor((m) => m.type === 'session.snapshot');
    b.send({
      type: 'lane.events',
      sessionId: s.id,
      agentId: lark.id,
      events: [{ type: 'turn_start', turnId: 't1', model: 'openai/gpt-5.6-luna' }],
    });
    await b.waitFor(
      (m: Msg) => m.type === 'lane.events' && m['userId'] === lark.id && m['sessionId'] === s.id,
    );

    // Alice steers Lark: the guidance reaches Bob's machine, which runs it.
    a.send({ type: 'lane.steer', sessionId: s.id, laneUserId: lark.id, id: 's1', text: 'Smaller' });
    expect(await b.waitFor((m: Msg) => m.type === 'steer')).toMatchObject({
      laneUserId: lark.id,
      fromName: 'alice',
      text: 'Smaller',
    });
    a.close();
    b.close();
  });
});

describe('swarms', () => {
  it('are set up before launch, run on the launcher, and pause themselves at the budget', async () => {
    const s = await session('Totals');
    const wren = (await agent('Wren')).body.agent;
    const moss = (await agent('Moss')).body.agent;
    expect(
      (
        await api(dave, 'PUT', `/api/sessions/${s.id}/swarm`, {
          goal: 'x',
          leadAgentId: null,
          agentIds: [wren.id],
          budget: 1,
        })
      ).status,
    ).toBe(403);
    const draft = (
      await api(bob, 'PUT', `/api/sessions/${s.id}/swarm`, {
        goal: 'Add total and product helpers with tests',
        leadAgentId: wren.id,
        agentIds: [moss.id],
        budget: 0.05,
        maxParallel: 2,
      })
    ).body.swarm;
    expect(draft).toMatchObject({ status: 'draft', leadAgentId: wren.id, budget: 0.05, spent: 0 });
    expect(draft.agents.map((a: { name: string; role: string }) => [a.name, a.role])).toEqual([
      ['Wren', 'lead'],
      ['Moss', 'worker'],
    ]);
    // Settings can change until it runs.
    const changed = (
      await api(bob, 'PUT', `/api/sessions/${s.id}/swarm`, {
        goal: 'Add total and product helpers with tests',
        leadAgentId: wren.id,
        agentIds: [wren.id, moss.id],
        budget: 0.02,
      })
    ).body.swarm;
    expect(changed.id).toBe(draft.id);
    expect(changed.budget).toBe(0.02);

    const b = await connect(h, bob.token);
    await b.waitFor((m) => m.type === 'welcome');
    const first = (await api(bob, 'POST', `/api/swarms/${draft.id}/launch`)).body;
    expect(first.resumed).toBe(false);
    expect(first.swarm).toMatchObject({ status: 'running', launchedByName: 'bob' });
    const view = (await api(alice, 'GET', `/api/sessions/${s.id}`)).body.session;
    expect(view.swarm).toMatchObject({ id: draft.id, status: 'running', budget: 0.02 });
    expect(
      view.participants
        .filter((p: { kind: string }) => p.kind === 'agent')
        .map((p: { name: string; hostName: string }) => [p.name, p.hostName]),
    ).toEqual(
      expect.arrayContaining([
        ['Wren', 'bob'],
        ['Moss', 'bob'],
      ]),
    );

    // Only the machine running it reports.
    expect(
      (await api(alice, 'POST', `/api/swarms/${draft.id}/report`, { agentId: moss.id, cost: 0.01 }))
        .status,
    ).toBe(403);
    const r1 = (
      await api(bob, 'POST', `/api/swarms/${draft.id}/report`, {
        agentId: moss.id,
        status: 'working',
        task: 'Write product()',
        cost: 0.012,
      })
    ).body.swarm;
    expect(r1).toMatchObject({ status: 'running', spent: 0.012 });
    const r2 = (
      await api(bob, 'POST', `/api/swarms/${draft.id}/report`, { agentId: wren.id, cost: 0.009 })
    ).body.swarm;
    expect(r2.status).toBe('paused');
    expect(r2.pausedReason).toMatch(/Budget reached: \$0\.0210 of \$0\.0200/);
    expect(r2.agents.find((a: { name: string }) => a.name === 'Moss')).toMatchObject({
      spent: 0.012,
      task: 'Write product()',
    });
    // Can't go on until the budget is raised.
    expect((await api(bob, 'POST', `/api/swarms/${draft.id}/launch`)).status).toBe(409);
    await api(bob, 'PUT', `/api/sessions/${s.id}/swarm`, {
      goal: 'Add total and product helpers with tests',
      leadAgentId: wren.id,
      agentIds: [moss.id],
      budget: 0.1,
    });
    // Someone else can't resume what Bob's machine runs.
    expect((await api(alice, 'POST', `/api/swarms/${draft.id}/launch`)).status).toBe(403);
    const again = (await api(bob, 'POST', `/api/swarms/${draft.id}/launch`)).body;
    expect(again).toMatchObject({ resumed: true, swarm: { status: 'running' } });

    // Chat: agents speak through the running machine; people speak for themselves.
    expect(
      (
        await api(alice, 'POST', `/api/swarms/${draft.id}/messages`, {
          fromId: wren.id,
          text: 'fake',
        })
      ).status,
    ).toBe(403);
    await api(bob, 'POST', `/api/swarms/${draft.id}/messages`, {
      fromId: wren.id,
      toId: moss.id,
      text: 'Can you review the change before it merges?',
    });
    await api(alice, 'POST', `/api/swarms/${draft.id}/messages`, {
      toId: null,
      text: 'Keep it small, please.',
    });
    const chat = (await api(dave, 'GET', `/api/sessions/${s.id}/swarm`)).body.messages;
    expect(
      chat.map((m: { fromName: string; toName: string | null }) => [m.fromName, m.toName]),
    ).toEqual([
      ['Wren', 'Moss'],
      ['alice', null],
    ]);

    // Controls reach the machine running it.
    await api(alice, 'POST', `/api/swarms/${draft.id}/control`, {
      action: 'reassign',
      agentId: moss.id,
      toId: wren.id,
    });
    expect(await b.waitFor((m: Msg) => m.type === 'swarm.control')).toMatchObject({
      action: 'reassign',
      agentId: moss.id,
      toId: wren.id,
      fromUserId: alice.id,
    });

    // Only the runner says it's done; a new swarm can follow.
    expect(
      (await api(alice, 'POST', `/api/swarms/${draft.id}/status`, { status: 'done' })).status,
    ).toBe(403);
    // Done carries how the tasks went: all failed is not "finished its goal".
    const done = (
      await api(bob, 'POST', `/api/swarms/${draft.id}/status`, {
        status: 'done',
        outcome: { tasks: 2, done: 0, failed: 2 },
      })
    ).body.swarm;
    expect(done.status).toBe('done');
    expect(done.outcome).toMatchObject({ tasks: 2, done: 0, failed: 2 });
    const activity = (await api(alice, 'GET', `/api/sessions/${s.id}/activity`)).body.activity;
    expect(activity.find((a: { kind: string }) => a.kind === 'swarm_done').text).toBe(
      'The swarm ended without finishing a task (2 failed)',
    );
    const kinds = activity.map((a: { kind: string }) => a.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'swarm_launched',
        'swarm_paused',
        'reassigned',
        'swarm_done',
        'agent_added',
      ]),
    );
    b.close();
  });
});

describe('the swarm chat', () => {
  it('keeps kinds, answers and receipts, lets agents write to people, and moves reassigned work', async () => {
    const s = await session('Chat');
    const iris = (await agent('Iris')).body.agent;
    const owen = (await agent('Owen')).body.agent;
    const draft = (
      await api(bob, 'PUT', `/api/sessions/${s.id}/swarm`, {
        goal: 'Paint the button',
        leadAgentId: iris.id,
        agentIds: [iris.id, owen.id],
        budget: 1,
      })
    ).body.swarm;
    const b = await connect(h, bob.token);
    await b.waitFor((m) => m.type === 'welcome');
    await api(bob, 'POST', `/api/swarms/${draft.id}/launch`);
    const pushed: { kind: string; [k: string]: unknown }[] = [];
    h.ctx.swarm.push = { emit: (e) => pushed.push(e) };
    const url = `/api/swarms/${draft.id}/messages`;

    // An agent asks a person of the session; nobody outside it.
    const ask = (
      await api(bob, 'POST', url, {
        fromId: iris.id,
        toId: alice.id,
        kind: 'question',
        text: 'Blue or green?',
        key: 'ask-blue-or-green',
      })
    ).body.message;
    expect(ask).toMatchObject({ kind: 'question', toName: 'alice', readBy: [] });
    // Sent again with its key: the same message, not a second one.
    const again = (
      await api(bob, 'POST', url, {
        fromId: iris.id,
        toId: alice.id,
        kind: 'question',
        text: 'Blue or green?',
        key: 'ask-blue-or-green',
      })
    ).body.message;
    expect(again.id).toBe(ask.id);
    expect(
      (await api(bob, 'POST', url, { fromId: iris.id, toId: dave.id, text: 'Hi' })).status,
    ).toBe(400);
    // People write only to the swarm's agents.
    expect((await api(alice, 'POST', url, { toId: bob.id, text: 'Hi' })).status).toBe(400);
    expect(pushed).toEqual([
      expect.objectContaining({
        kind: 'message',
        toUserId: alice.id,
        fromName: 'Iris',
        messageKind: 'question',
        text: 'Blue or green?',
      }),
    ]);

    // The person answers it; an answer to a message of another swarm is refused.
    const answer = (
      await api(alice, 'POST', url, {
        toId: iris.id,
        replyTo: ask.id,
        kind: 'answer',
        text: 'Blue',
      })
    ).body.message;
    expect(answer).toMatchObject({ replyTo: ask.id, kind: 'answer' });
    expect(
      (
        await api(alice, 'POST', url, {
          toId: iris.id,
          replyTo: '00000000-0000-4000-8000-000000000000',
          text: 'x',
        })
      ).status,
    ).toBe(400);

    // The machine running it says when its agent's model has it, then read it.
    await api(bob, 'POST', `${url}/delivered`, { agentId: iris.id, ids: [answer.id] });
    await api(bob, 'POST', `${url}/read`, { agentId: iris.id, ids: [answer.id] });
    await api(bob, 'POST', `${url}/read`, { agentId: iris.id, ids: [answer.id] });
    expect(
      (await api(alice, 'POST', `${url}/read`, { agentId: iris.id, ids: [answer.id] })).status,
    ).toBe(403);
    const seen = (await api(alice, 'GET', url)).body.messages.find(
      (m: { id: string }) => m.id === answer.id,
    );
    expect(seen).toMatchObject({ deliveredTo: [iris.id], readBy: [iris.id] });

    // Other systems hear every message.
    const events = (await api(alice, 'GET', `/api/workspaces/${workspaceId}/events?limit=500`)).body
      .events as { type: string; data: Record<string, unknown> }[];
    const ours = events.filter((e) => e.type === 'swarm.message' && e.data['swarmId'] === draft.id);
    expect(ours.map((e) => e.data['kind'])).toEqual(['question', 'answer']);

    // Moving an agent's work moves its plan steps too, so a resume keeps it with the new agent.
    await api(bob, 'POST', `/api/sessions/${s.id}/plan/steps`, {
      steps: [
        { title: 'Paint', ownerId: owen.id, after: [] },
        { title: 'Old', ownerId: owen.id, after: [] },
      ],
    });
    const plan = (await api(alice, 'GET', `/api/sessions/${s.id}/plan`)).body.plan;
    const old = plan.steps.find((x: { title: string }) => x.title === 'Old');
    await api(bob, 'PATCH', `/api/plan-steps/${old.id}`, { status: 'done' });
    await api(alice, 'POST', `/api/swarms/${draft.id}/control`, {
      action: 'reassign',
      agentId: owen.id,
      toId: iris.id,
    });
    const after = (await api(alice, 'GET', `/api/sessions/${s.id}/plan`)).body.plan.steps;
    expect(after.map((x: { title: string; ownerId: string }) => [x.title, x.ownerId])).toEqual([
      ['Paint', iris.id],
      ['Old', owen.id],
    ]);
    b.close();
  });

  it('pauses a swarm whose desktop app went away for longer than a while', async () => {
    // Someone with no other app open.
    const r = await oauthLogin(h, 'github', 'erin', {
      providerUserId: '9',
      login: 'erin',
      name: 'erin',
    });
    const erin = { token: r.token, id: r.user.id };
    await api(alice, 'POST', `/api/workspaces/${workspaceId}/invites`, {
      githubLogin: 'erin',
      role: 'editor',
    });
    const s = await session('Away');
    const wren = (await agent('Wren2')).body.agent;
    const draft = (
      await api(erin, 'PUT', `/api/sessions/${s.id}/swarm`, {
        goal: 'x',
        leadAgentId: wren.id,
        agentIds: [wren.id],
        budget: 1,
      })
    ).body.swarm;
    const b = await connect(h, erin.token);
    await b.waitFor((m) => m.type === 'welcome');
    await api(erin, 'POST', `/api/swarms/${draft.id}/launch`);
    // While the app is there, nothing happens.
    await h.ctx.swarm.sweepLaunchers(0);
    expect((await api(erin, 'GET', `/api/sessions/${s.id}/swarm`)).body.swarm.status).toBe(
      'running',
    );
    b.close();
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    await h.ctx.swarm.sweepLaunchers(60_000, t0);
    expect((await api(erin, 'GET', `/api/sessions/${s.id}/swarm`)).body.swarm.status).toBe(
      'running',
    );
    await h.ctx.swarm.sweepLaunchers(60_000, t0 + 61_000);
    const swarm = (await api(erin, 'GET', `/api/sessions/${s.id}/swarm`)).body.swarm;
    expect(swarm.status).toBe('paused');
    expect(swarm.pausedReason).toMatch(/The app running it \(erin's\) went away/);
  });
});

describe('learning', () => {
  it('shares only checked knowledge, and keeps preferences private until accepted', async () => {
    const url = `/api/workspaces/${workspaceId}/learnings`;
    expect(
      (await api(bob, 'POST', url, { kind: 'knowledge', text: 'Guessed fact', verified: false }))
        .status,
    ).toBe(400);
    const fact = (
      await api(bob, 'POST', url, {
        kind: 'knowledge',
        text: 'Totals live in src/totals.ts; add tests beside them.',
        verified: true,
        evidence: 'Task "product()" passed 3/3 checks',
      })
    ).body.learning;
    expect(fact).toMatchObject({ status: 'accepted', verified: true, ownerId: null });

    const pref = (
      await api(alice, 'POST', url, { kind: 'preference', text: 'Alice wants small diffs' })
    ).body.learning;
    expect(pref).toMatchObject({ status: 'suggested', verified: false, ownerId: alice.id });
    // Bob sees the knowledge, not Alice's preference.
    const bobs = (await api(bob, 'GET', url)).body.learnings.map((l: { id: string }) => l.id);
    expect(bobs).toContain(fact.id);
    expect(bobs).not.toContain(pref.id);
    expect(
      (await api(bob, 'PATCH', `/api/learnings/${pref.id}`, { status: 'accepted' })).status,
    ).toBe(404);

    const corrected = (
      await api(alice, 'PATCH', `/api/learnings/${pref.id}`, {
        text: 'Alice wants small diffs with a test',
        status: 'accepted',
      })
    ).body.learning;
    expect(corrected).toMatchObject({
      status: 'accepted',
      text: 'Alice wants small diffs with a test',
    });
    await api(alice, 'PATCH', `/api/learnings/${pref.id}`, { status: 'forgotten' });
    const alices = (await api(alice, 'GET', url)).body.learnings.map((l: { id: string }) => l.id);
    expect(alices).not.toContain(pref.id);
  });
});

describe('agent spending limits', () => {
  it('stops a task past its budget, pauses at the monthly limit, and estimates from real tasks', async () => {
    const s = await session('Limits');
    const finch = (await agent('Finch')).body.agent;
    const swarm = (
      await api(alice, 'PUT', `/api/sessions/${s.id}/swarm`, {
        goal: 'Add helpers',
        leadAgentId: finch.id,
        agentIds: [finch.id],
        budget: 1,
        taskBudget: 0.01,
      })
    ).body.swarm;
    expect(swarm.taskBudget).toBe(0.01);
    // Reviews are on unless turned off.
    expect(swarm.review).toBe(true);
    await api(alice, 'POST', `/api/swarms/${swarm.id}/launch`);
    const step = (
      await api(alice, 'POST', `/api/sessions/${s.id}/plan/steps`, {
        steps: [{ title: 'Add median()', ownerId: finch.id }],
      })
    ).body.plan.steps[0];
    const report = (cost: number, stepId?: string) =>
      api(alice, 'POST', `/api/swarms/${swarm.id}/report`, {
        agentId: finch.id,
        cost,
        ...(stepId ? { stepId } : {}),
      });

    // The task's own budget: the Brain says when it is over.
    expect((await report(0.006, step.id)).body.step).toEqual({ spent: 0.006, over: false });
    const over = (await report(0.006, step.id)).body;
    expect(over.step.over).toBe(true);
    expect(over.step.spent).toBeCloseTo(0.012);
    expect(over.swarm.status).toBe('running');
    // A step of another session isn't this swarm's.
    const other = await session('Other');
    const foreign = (
      await api(alice, 'POST', `/api/sessions/${other.id}/plan/steps`, { steps: [{ title: 'x' }] })
    ).body.plan.steps[0];
    expect((await report(0.001, foreign.id)).status).toBe(400);

    // Estimates come only from tasks that ran: none finished yet, so none.
    let stats = (await api(bob, 'GET', `/api/workspaces/${workspaceId}/agent-spend`)).body.stats;
    expect(stats.tasks).toBe(0);
    expect(stats.perTask).toBeNull();
    for (const runState of ['waiting', 'running', 'failed'])
      await api(alice, 'PATCH', `/api/plan-steps/${step.id}`, { runState });
    stats = (await api(bob, 'GET', `/api/workspaces/${workspaceId}/agent-spend`)).body.stats;
    expect(stats.tasks).toBe(1);
    expect(stats.perTask.average).toBeCloseTo(0.012);
    expect(stats.monthSpent).toBeGreaterThanOrEqual(0.013);

    // The workspace's monthly limit: owners set it; reaching it pauses the swarm.
    expect(
      (await api(bob, 'PATCH', `/api/workspaces/${workspaceId}`, { agentMonthlyLimit: 1 })).status,
    ).toBe(403);
    const limit = Math.round((stats.monthSpent + 0.005) * 1000) / 1000;
    const ws = await api(alice, 'PATCH', `/api/workspaces/${workspaceId}`, {
      agentMonthlyLimit: limit,
    });
    expect(ws.body.workspace.agentMonthlyLimit).toBe(limit);
    expect((await report(0.002)).body.swarm.status).toBe('running');
    const paused = (await report(0.01)).body.swarm;
    expect(paused.status).toBe('paused');
    expect(paused.pausedReason).toMatch(/monthly agent limit is reached/);
    const again = await api(alice, 'POST', `/api/swarms/${swarm.id}/launch`);
    expect(again.status).toBe(409);
    expect(again.body.error.message).toMatch(/Settings → Workspaces/);

    // Raised (or removed), it can go on.
    await api(alice, 'PATCH', `/api/workspaces/${workspaceId}`, { agentMonthlyLimit: null });
    expect((await api(alice, 'POST', `/api/swarms/${swarm.id}/launch`)).status).toBe(200);
  });
});
