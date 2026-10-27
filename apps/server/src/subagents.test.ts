import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, connect, oauthLogin, startHarness, type Harness } from './test/harness.js';

let h: Harness;
type Person = { token: string; id: string };
let alice: Person; // owner
let bob: Person; // editor
let dave: Person; // viewer
let workspaceId: string;

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

async function session() {
  const s = (
    await api(alice, 'POST', `/api/workspaces/${workspaceId}/sessions`, {
      title: 'Seat race',
      branch: 'kovan/seats',
    })
  ).body.session as { id: string };
  for (const p of [alice, bob])
    await api(p, 'POST', `/api/sessions/${s.id}/join`, { mode: 'join' });
  return s;
}

describe('subagents', () => {
  it('streams progress to the room and integrates into the parent exactly once', async () => {
    const s = await session();
    const a = await connect(h, alice.token);
    await a.waitFor((m) => m.type === 'welcome');
    a.send({ type: 'session.subscribe', sessionId: s.id });
    await a.waitFor((m) => m.type === 'session.snapshot');

    // Watchers and viewers can't start one.
    expect((await api(dave, 'POST', `/api/sessions/${s.id}/subagents`, { task: 'x' })).status).toBe(
      403,
    );
    const started = await api(bob, 'POST', `/api/sessions/${s.id}/subagents`, {
      task: 'Write tests for reserveSlot',
      baseSha: 'b'.repeat(40),
    });
    expect(started.status).toBe(200);
    const sub = started.body.subagent;
    expect(sub).toMatchObject({ status: 'running', parentName: 'bob', rev: 0 });
    await a.waitFor(
      (m) => m.type === 'subagent' && (m['subagent'] as { id: string }).id === sub.id,
    );
    expect((await api(alice, 'GET', `/api/sessions/${s.id}`)).body.session.subagents).toBe(1);

    // Only the parent's machine reports on it.
    expect((await api(alice, 'PATCH', `/api/subagents/${sub.id}`, { rev: 3 })).status).toBe(403);
    await api(bob, 'PATCH', `/api/subagents/${sub.id}`, { rev: 41, added: 48, removed: 3 });
    // Not before its checks pass.
    expect((await api(bob, 'POST', `/api/subagents/${sub.id}/integrate`)).status).toBe(409);
    // Its status moves one step at a time: no "passed" without checking.
    expect((await api(bob, 'PATCH', `/api/subagents/${sub.id}`, { status: 'passed' })).status).toBe(
      409,
    );
    await api(bob, 'PATCH', `/api/subagents/${sub.id}`, { status: 'checking' });
    const checks = [
      { name: 'Applies cleanly', command: null, status: 'passed', detail: null, ms: 40 },
      { name: 'pnpm test', command: 'pnpm test', status: 'passed', detail: null, ms: 900 },
    ];
    await api(bob, 'PATCH', `/api/subagents/${sub.id}`, {
      status: 'passed',
      checksPassed: 2,
      checksTotal: 2,
      checks,
    });

    // Two integrations at once (two windows, a retry): one wins.
    const results = await Promise.all([
      api(bob, 'POST', `/api/subagents/${sub.id}/integrate`),
      api(bob, 'POST', `/api/subagents/${sub.id}/integrate`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const list = (await api(alice, 'GET', `/api/sessions/${s.id}/subagents`)).body.subagents;
    expect(list[0]).toMatchObject({
      status: 'integrated',
      added: 48,
      removed: 3,
      rev: 41,
      checks,
    });
    expect(list[0].integratedAt).not.toBeNull();
    // Finished work can't be reopened.
    expect(
      (await api(bob, 'PATCH', `/api/subagents/${sub.id}`, { status: 'running' })).status,
    ).toBe(409);

    const activity = (await api(alice, 'GET', `/api/sessions/${s.id}/activity`)).body.activity;
    expect(activity.map((x: { kind: string }) => x.kind)).toEqual(
      expect.arrayContaining(['subagent_started', 'subagent_integrated']),
    );
    expect((await api(alice, 'GET', `/api/sessions/${s.id}`)).body.session.subagents).toBe(0);
    a.close();
  });

  it('keeps failed work reviewable and says why', async () => {
    const s = await session();
    const sub = (
      await api(bob, 'POST', `/api/sessions/${s.id}/subagents`, { task: 'Rename the seat map' })
    ).body.subagent;
    await api(bob, 'PATCH', `/api/subagents/${sub.id}`, { status: 'checking' });
    await api(bob, 'PATCH', `/api/subagents/${sub.id}`, {
      status: 'conflict',
      detail: 'src/seats.ts changed in the parent too',
    });
    // Reworked after a conflict: back to running, then checked again.
    expect(
      (await api(bob, 'PATCH', `/api/subagents/${sub.id}`, { status: 'running' })).status,
    ).toBe(200);
    await api(bob, 'PATCH', `/api/subagents/${sub.id}`, { status: 'checking' });
    await api(bob, 'PATCH', `/api/subagents/${sub.id}`, {
      status: 'conflict',
      detail: 'src/seats.ts changed in the parent too',
    });
    expect((await api(bob, 'POST', `/api/subagents/${sub.id}/integrate`)).status).toBe(409);
    const activity = (await api(alice, 'GET', `/api/sessions/${s.id}/activity`)).body.activity;
    expect(activity[0]).toMatchObject({
      kind: 'subagent_failed',
      detail: 'src/seats.ts changed in the parent too',
    });
  });
});

describe('subagents at once', () => {
  it('caps how many one lane runs side by side', async () => {
    const s = await session();
    for (let i = 0; i < 8; i++)
      expect(
        (await api(bob, 'POST', `/api/sessions/${s.id}/subagents`, { task: `Task ${i}` })).status,
      ).toBe(200);
    const ninth = await api(bob, 'POST', `/api/sessions/${s.id}/subagents`, { task: 'One more' });
    expect(ninth.status).toBe(429);
    expect(ninth.body.error.message).toContain('at most 8 subagents at once');
  });
});

describe('starting a subagent twice', () => {
  it('returns the one already started for the same request key', async () => {
    const s = await session();
    const body = { task: 'Write median()', requestKey: 'swarm-1:median:0' };
    const [a, b] = await Promise.all([
      api(bob, 'POST', `/api/sessions/${s.id}/subagents`, body),
      api(bob, 'POST', `/api/sessions/${s.id}/subagents`, body),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.subagent.id).toBe(b.body.subagent.id);
    expect([a.body.existing, b.body.existing].sort()).toEqual([false, true]);
    const again = await api(bob, 'POST', `/api/sessions/${s.id}/subagents`, body);
    expect(again.body).toMatchObject({ existing: true, subagent: { id: a.body.subagent.id } });
    // Another key, or no key, is another subagent.
    const other = await api(bob, 'POST', `/api/sessions/${s.id}/subagents`, {
      ...body,
      requestKey: 'swarm-1:median:1',
    });
    expect(other.body.subagent.id).not.toBe(a.body.subagent.id);
    const list = (await api(alice, 'GET', `/api/sessions/${s.id}/subagents`)).body.subagents;
    expect(list).toHaveLength(2);
  });
});

describe('sync state and the pull request', () => {
  it('shows snapshots, pauses and resumes on the lane, and a merged PR completes the session', async () => {
    const s = await session();
    const b = await connect(h, bob.token);
    await b.waitFor((m) => m.type === 'welcome');
    b.send({ type: 'session.subscribe', sessionId: s.id });
    await b.waitFor((m) => m.type === 'session.snapshot');
    const view = async () => (await api(alice, 'GET', `/api/sessions/${s.id}`)).body.session;
    const bobOf = async () =>
      (await view()).participants.find((p: { userId: string }) => p.userId === bob.id);

    b.send({
      type: 'lane.events',
      sessionId: s.id,
      events: [
        { type: 'sync', sha: 'c'.repeat(40), ref: `refs/kovan/snapshots/${s.id}/${bob.id}` },
      ],
    });
    await expect.poll(async () => (await bobOf()).snapshotSha).toBe('c'.repeat(40));
    expect((await bobOf()).snapshotRef).toBe(`refs/kovan/snapshots/${s.id}/${bob.id}`);

    b.send({
      type: 'lane.events',
      sessionId: s.id,
      events: [{ type: 'paused', reason: 'You switched to main in the session checkout' }],
    });
    await expect.poll(async () => (await bobOf()).paused).toMatch(/switched to main/);
    b.send({ type: 'lane.events', sessionId: s.id, events: [{ type: 'resumed' }] });
    await expect.poll(async () => (await bobOf()).paused).toBeNull();
    // Sync bookkeeping isn't part of the stored transcript.
    const lanes = (await api(alice, 'GET', `/api/sessions/${s.id}/transcript`)).body.lanes ?? [];
    const types = lanes.flatMap((l: { events: { type: string }[] }) => l.events.map((e) => e.type));
    expect(types).not.toContain('sync');

    expect(
      (
        await api(bob, 'POST', `/api/sessions/${s.id}/pr`, {
          url: 'javascript:alert(1)',
          number: 1,
          state: 'open',
        })
      ).status,
    ).toBe(400);
    await api(bob, 'POST', `/api/sessions/${s.id}/pr`, {
      url: 'https://github.com/acme/lobby/pull/7',
      number: 7,
      state: 'open',
    });
    expect((await view()).pr).toEqual({
      url: 'https://github.com/acme/lobby/pull/7',
      number: 7,
      state: 'open',
    });
    const merged = await api(bob, 'POST', `/api/sessions/${s.id}/pr`, {
      url: 'https://github.com/acme/lobby/pull/7',
      number: 7,
      state: 'merged',
      diff: 'diff --git a/x b/x\n',
    });
    expect(merged.body.session).toMatchObject({ status: 'ended', pr: { state: 'merged' } });
    const activity = (await api(alice, 'GET', `/api/sessions/${s.id}/activity`)).body.activity;
    expect(activity.map((x: { kind: string }) => x.kind)).toEqual(
      expect.arrayContaining(['pr_opened', 'merged', 'paused', 'resumed']),
    );
    b.close();
  });
});
