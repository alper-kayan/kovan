import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, connect, oauthLogin, startHarness, type Harness } from './test/harness.js';

let h: Harness;
type Person = { token: string; id: string };
let alice: Person; // owner
let bob: Person; // editor
let carol: Person; // editor
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
  carol = await login('carol', '3');
  dave = await login('dave', '4');
  const orgId = (await api(alice, 'GET', '/api/me')).body.orgs[0].id;
  workspaceId = (
    await api(alice, 'POST', '/api/workspaces', { orgId, name: 'lobby', repoUrl: null })
  ).body.workspace.id;
  for (const [login, role] of [
    ['bob', 'editor'],
    ['carol', 'editor'],
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

async function sessionWithBob() {
  const s = (
    await api(alice, 'POST', `/api/workspaces/${workspaceId}/sessions`, {
      title: 'Lobby race',
      branch: 'kovan/lobby',
    })
  ).body.session as { id: string };
  for (const p of [alice, bob, carol])
    await api(p, 'POST', `/api/sessions/${s.id}/join`, { mode: 'join' });
  const b = await connect(h, bob.token);
  await b.waitFor((m) => m.type === 'welcome');
  b.send({ type: 'session.subscribe', sessionId: s.id });
  await b.waitFor((m) => m.type === 'session.snapshot');
  return { s, b };
}

const lane = (b: Awaited<ReturnType<typeof connect>>, sessionId: string, events: object[]) =>
  b.send({ type: 'lane.events', sessionId, events });

describe('takeover after a usage limit', () => {
  it('moves the lane to awaiting takeover, gives it to one person, and resumes from the plan', async () => {
    const { s, b } = await sessionWithBob();
    await api(alice, 'POST', `/api/sessions/${s.id}/plan/steps`, {
      steps: [
        { title: 'Find the race' },
        { title: 'Compare-and-set the write', ownerId: bob.id },
        { title: 'Test it', ownerId: bob.id },
      ],
    });
    const plan = (await api(alice, 'GET', `/api/sessions/${s.id}/plan`)).body.plan;
    await api(alice, 'PATCH', `/api/plan-steps/${plan.steps[0].id}`, { status: 'done' });

    lane(b, s.id, [
      { type: 'user', text: 'Make the seat write compare-and-set', attachments: [], at: 1 },
      { type: 'turn_start', turnId: 't1', model: 'claude-code · claude-haiku-5-5' },
      { type: 'text', text: 'Patching reserveSlot.' },
      { type: 'turn_end', turnId: 't1', reason: 'done', cost: 0.01 },
      { type: 'snapshot', sha: 'a'.repeat(40), ref: 'refs/kovan/snapshots/x/bob' },
      { type: 'turn_start', turnId: 't2', model: 'claude-code · claude-haiku-5-5' },
      {
        type: 'turn_end',
        turnId: 't2',
        reason: 'error',
        cost: 0,
        error: 'Claude usage limit reached',
      },
      { type: 'limit_hit', reason: 'Claude usage limit reached' },
    ]);
    const awaiting = await b.waitFor<{
      session: {
        participants: {
          userId: string;
          state: string;
          awaitingReason: string | null;
          snapshotAt: string | null;
        }[];
      };
    }>(
      (m) =>
        m.type === 'session' &&
        (m['session'] as { participants: { userId: string; state: string }[] }).participants.some(
          (p) => p.userId === bob.id && p.state === 'awaiting',
        ),
    );
    const bobLane = awaiting.session.participants.find((p) => p.userId === bob.id)!;
    expect(bobLane.awaitingReason).toBe('Claude usage limit reached');
    expect(bobLane.snapshotAt).not.toBeNull();

    // Alice and Carol ask at the same moment: exactly one wins.
    const [x, y] = await Promise.all([
      api(alice, 'POST', `/api/sessions/${s.id}/takeover`, { laneUserId: bob.id }),
      api(carol, 'POST', `/api/sessions/${s.id}/takeover`, { laneUserId: bob.id }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const [won, lost] = x.status === 200 ? [x, y] : [y, x];
    const winner = x.status === 200 ? alice : carol;
    expect(lost.body.error.message).toMatch(/already taking over bob's lane\. Join the session/);
    // Bob's agent is stuck, so it's ready at once, from his last snapshot and transcript.
    expect(won.body.handoff).toMatchObject({
      status: 'ready',
      snapshotSha: 'a'.repeat(40),
      context: {
        lastPrompts: ['Make the seat write compare-and-set'],
        lastReply: 'Patching reserveSlot.',
        reason: "bob's agent hit a usage limit",
      },
    });

    // Only the winner accepts; Bob's open steps become theirs; it resumes at step 2 of 3.
    expect((await api(bob, 'POST', `/api/handoffs/${won.body.handoff.id}/accept`)).status).toBe(
      404,
    );
    const accepted = await api(winner, 'POST', `/api/handoffs/${won.body.handoff.id}/accept`);
    expect(accepted.body.resumeStep).toEqual({
      index: 2,
      total: 3,
      title: 'Compare-and-set the write',
    });
    const after = (await api(alice, 'GET', `/api/sessions/${s.id}/plan`)).body.plan.steps;
    expect(after.filter((st: { ownerId: string }) => st.ownerId === winner.id)).toHaveLength(2);
    const view = (await api(alice, 'GET', `/api/sessions/${s.id}`)).body.session;
    expect(view.participants.find((p: { userId: string }) => p.userId === bob.id).state).toBe(
      'idle',
    );

    const feed = (await api(dave, 'GET', `/api/sessions/${s.id}/activity`)).body.activity.map(
      (a: { text: string }) => a.text,
    );
    expect(feed).toEqual(
      expect.arrayContaining([
        'bob started a turn on their Claude subscription',
        "bob's agent hit a usage limit",
        expect.stringMatching(/took over bob's work/),
      ]),
    );
    b.close();
  });

  it('asks a working owner to stop at a checkpoint first', async () => {
    const { s, b } = await sessionWithBob();
    const req = await api(alice, 'POST', `/api/sessions/${s.id}/takeover`, { laneUserId: bob.id });
    expect(req.body.handoff.status).toBe('requested');
    const asked = await b.waitFor<{ handoff: { id: string; toUserId: string } }>(
      (m) => m.type === 'handoff',
    );
    expect(asked.handoff.toUserId).toBe(alice.id);
    // Not ready yet.
    expect((await api(alice, 'POST', `/api/handoffs/${asked.handoff.id}/accept`)).status).toBe(409);
    const ready = await api(bob, 'POST', `/api/handoffs/${asked.handoff.id}/ready`, {
      snapshot: { sha: 'b'.repeat(40), ref: 'refs/kovan/snapshots/s/bob' },
      context: {
        lastPrompts: ['x'],
        lastReply: 'y',
        touchedFiles: ['a.ts'],
        reason: 'alice took over',
      },
    });
    expect(ready.body.handoff).toMatchObject({ status: 'ready', snapshotSha: 'b'.repeat(40) });
    expect((await api(alice, 'POST', `/api/handoffs/${asked.handoff.id}/accept`)).status).toBe(200);
    b.close();
  });
});

describe('steering, locks and unknown outcomes', () => {
  it("delivers a teammate's steer to the owner's machine", async () => {
    const { s, b } = await sessionWithBob();
    const a = await connect(h, alice.token);
    await a.waitFor((m) => m.type === 'welcome');
    a.send({
      type: 'lane.steer',
      sessionId: s.id,
      laneUserId: bob.id,
      id: 'st1',
      text: 'Keep the retry bounded',
    });
    const steer = await b.waitFor<Msg>((m) => m.type === 'steer');
    expect(steer).toMatchObject({
      fromUserId: alice.id,
      fromName: 'alice',
      text: 'Keep the retry bounded',
      id: 'st1',
    });
    const d = await connect(h, dave.token);
    await d.waitFor((m) => m.type === 'welcome');
    d.send({ type: 'lane.steer', sessionId: s.id, laneUserId: bob.id, id: 'st2', text: 'x' });
    expect((await d.waitFor<Msg>((m) => m.type === 'error'))['code']).toBe('forbidden');
    for (const c of [a, b, d]) c.close();
  });

  it('says once that someone joined, not each time they open the session again', async () => {
    const { s, b } = await sessionWithBob();
    const join = (mode: 'join' | 'watch') =>
      api(bob, 'POST', `/api/sessions/${s.id}/join`, { mode });
    await join('join');
    await join('join');
    await join('watch');
    const joins = (await api(alice, 'GET', `/api/sessions/${s.id}/activity`)).body.activity
      .map((a: { text: string }) => a.text)
      .filter((t: string) => t.startsWith('bob '));
    expect(joins.filter((t: string) => t === 'bob joined with their agent')).toHaveLength(1);
    expect(joins).toContain('bob is watching');
    b.close();
  });

  it('holds advisory locks per session and shows them to the workspace', async () => {
    const { s, b } = await sessionWithBob();
    await api(alice, 'POST', `/api/sessions/${s.id}/locks`, { path: 'src/lobby/join.ts' });
    expect((await api(dave, 'POST', `/api/sessions/${s.id}/locks`, { path: 'x' })).status).toBe(
      403,
    );
    expect(
      (await api(alice, 'POST', `/api/sessions/${s.id}/locks`, { path: '../etc/passwd' })).status,
    ).toBe(400);
    const all = (await api(dave, 'GET', `/api/workspaces/${workspaceId}/locks`)).body.locks;
    expect(
      all.some(
        (l: { path: string; userName: string }) =>
          l.path === 'src/lobby/join.ts' && l.userName === 'alice',
      ),
    ).toBe(true);
    expect(
      (await api(bob, 'POST', `/api/sessions/${s.id}/unlock`, { path: 'src/lobby/join.ts' }))
        .status,
    ).toBe(403);
    expect(
      (await api(alice, 'POST', `/api/sessions/${s.id}/unlock`, { path: 'src/lobby/join.ts' })).body
        .locks,
    ).toEqual([]);
    b.close();
  });

  it('records an action cut off mid-flight and lets an editor say what happened', async () => {
    const { s, b } = await sessionWithBob();
    lane(b, s.id, [
      { type: 'turn_start', turnId: 't', model: 'm' },
      {
        type: 'outcome_unknown',
        toolId: 'c9',
        command: 'git push origin kovan/lobby',
        evidence: 'Enumerating objects: 5',
      },
      { type: 'turn_end', turnId: 't', reason: 'stopped', cost: 0 },
    ]);
    const heard = await b.waitFor<{ outcome: { id: string; status: string; evidence: string } }>(
      (m) => m.type === 'outcome',
    );
    expect(heard.outcome).toMatchObject({ status: 'unknown', evidence: 'Enumerating objects: 5' });
    const alerts = (await api(dave, 'GET', `/api/workspaces/${workspaceId}/flow`)).body;
    expect(alerts.outcomes.map((o: { id: string }) => o.id)).toContain(heard.outcome.id);
    expect(
      (await api(dave, 'POST', `/api/outcomes/${heard.outcome.id}`, { status: 'failed' })).status,
    ).toBe(403);
    const recorded = await api(carol, 'POST', `/api/outcomes/${heard.outcome.id}`, {
      status: 'not_run',
    });
    expect(recorded.body.outcome).toMatchObject({ status: 'not_run', recordedBy: carol.id });
    b.close();
  });
});
