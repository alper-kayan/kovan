import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, connect, oauthLogin, startHarness, type Harness } from './test/harness.js';

let h: Harness;
type Person = { token: string; id: string };
let alice: Person; // owner
let bob: Person; // editor
let carol: Person; // viewer
let dave: Person; // commenter
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
  carol = await login('carol', '3');
  dave = await login('dave', '4');
  const orgId = (await api(alice, 'GET', '/api/me')).body.orgs[0].id;
  workspaceId = (
    await api(alice, 'POST', '/api/workspaces', { orgId, name: 'lobby', repoUrl: null })
  ).body.workspace.id;
  for (const [login, role] of [
    ['bob', 'editor'],
    ['carol', 'viewer'],
    ['dave', 'commenter'],
  ])
    await api(alice, 'POST', `/api/workspaces/${workspaceId}/invites`, {
      githubLogin: login,
      role,
    });
});
afterAll(async () => {
  await h.close();
});

async function newSession() {
  return (
    await api(alice, 'POST', `/api/workspaces/${workspaceId}/sessions`, {
      title: 'Lobby race',
      branch: 'kovan/lobby',
    })
  ).body.session as { id: string };
}

type Step = { id: string; title: string; ownerId: string | null; status: string };

describe('the session plan', () => {
  it('keeps the order steps depend on, and refuses a circle', async () => {
    const s = await newSession();
    const added = await api(alice, 'POST', `/api/sessions/${s.id}/plan/steps`, {
      steps: [
        { title: 'Add the model', acceptance: 'pnpm test passes' },
        { title: 'Expose it over the API', after: [0] },
        { title: 'Show it in the UI', after: [0, 1] },
      ],
    });
    expect(added.status).toBe(200);
    const [model, api1, ui] = added.body.plan.steps as (Step & {
      dependsOn: string[];
      acceptance: string | null;
    })[];
    expect(model).toMatchObject({ acceptance: 'pnpm test passes', dependsOn: [] });
    expect(api1!.dependsOn).toEqual([model!.id]);
    expect(ui!.dependsOn).toEqual([model!.id, api1!.id]);

    const circle = await api(alice, 'POST', `/api/sessions/${s.id}/plan/steps`, {
      steps: [
        { title: 'a', after: [1] },
        { title: 'b', after: [0] },
      ],
    });
    expect(circle.status).toBe(400);
    expect(circle.body.error.message).toContain('circle');
    const self = await api(alice, 'POST', `/api/sessions/${s.id}/plan/steps`, {
      steps: [{ title: 'a', after: [3] }],
    });
    expect(self.status).toBe(400);
  });

  it('holds a step that needs a yes until an editor gives it', async () => {
    const s = await newSession();
    const added = await api(alice, 'POST', `/api/sessions/${s.id}/plan/steps`, {
      steps: [{ title: 'Add a users migration', approvalReason: 'Changes the database schema' }],
    });
    const step = added.body.plan.steps[0];
    expect(step).toMatchObject({
      approval: 'pending',
      approvalReason: 'Changes the database schema',
      approvedBy: null,
    });
    const answer = (who: typeof alice, approve: boolean) =>
      api(who, 'POST', `/api/plan-steps/${step.id}/approval`, { approve });

    await api(alice, 'PATCH', `/api/plan-steps/${step.id}`, { runState: 'waiting' });
    await api(alice, 'PATCH', `/api/plan-steps/${step.id}`, { runState: 'waiting_for_approval' });
    // The machine running the swarm can't start it before someone says yes.
    expect(
      (await api(alice, 'PATCH', `/api/plan-steps/${step.id}`, { runState: 'running' })).status,
    ).toBe(409);
    // The board sees it waiting for a yes, and counts it as a waiting task.
    let card = (await api(alice, 'GET', `/api/sessions/${s.id}`)).body.session;
    expect(card.taskApprovals).toEqual([
      { stepId: step.id, title: 'Add a users migration', reason: 'Changes the database schema' },
    ]);
    expect(card.tasks).toMatchObject({ waiting: 1, running: 0 });
    // Viewers and commenters don't answer approvals; editors do, once.
    expect((await answer(carol, true)).status).toBe(403);
    expect((await answer(dave, true)).status).toBe(403);
    const yes = await answer(bob, true);
    expect(yes.body.plan.steps[0]).toMatchObject({ approval: 'approved', approvedBy: bob.id });
    expect((await answer(alice, false)).status).toBe(409);
    await api(alice, 'PATCH', `/api/plan-steps/${step.id}`, { runState: 'waiting' });
    expect(
      (await api(alice, 'PATCH', `/api/plan-steps/${step.id}`, { runState: 'running' })).status,
    ).toBe(200);
    card = (await api(alice, 'GET', `/api/sessions/${s.id}`)).body.session;
    expect(card.taskApprovals).toEqual([]);
    expect(card.tasks).toMatchObject({ waiting: 0, running: 1, failed: 0 });
    const activity = (await api(alice, 'GET', `/api/sessions/${s.id}/activity`)).body.activity;
    expect(activity.map((a: { text: string }) => a.text)).toContain(
      'bob approved "Add a users migration"',
    );

    // A step without the flag can't be "approved".
    const plain = await api(alice, 'POST', `/api/sessions/${s.id}/plan/steps`, {
      steps: [{ title: 'Write docs' }],
    });
    const docs = plain.body.plan.steps.at(-1);
    expect(
      (await api(bob, 'POST', `/api/plan-steps/${docs.id}/approval`, { approve: true })).status,
    ).toBe(409);
  });

  it("tracks a swarm's run of a step, one allowed move at a time, in the activity", async () => {
    const s = await newSession();
    const added = await api(alice, 'POST', `/api/sessions/${s.id}/plan/steps`, {
      steps: [{ title: 'Add the model' }],
    });
    const step = added.body.plan.steps[0] as Step & { runState: string | null };
    expect(step.runState).toBeNull();
    const move = (who: typeof alice, runState: string, runDetail: string | null = null) =>
      api(who, 'PATCH', `/api/plan-steps/${step.id}`, { runState, runDetail });

    // Only someone who manages the plan (the machine running the swarm) moves it.
    expect((await move(carol, 'waiting')).status).toBe(403);
    expect((await move(alice, 'waiting')).status).toBe(200);
    // No skipping: a waiting task hasn't run, so it can't be done.
    expect((await move(alice, 'done')).status).toBe(409);
    expect((await move(alice, 'running')).status).toBe(200);
    const failed = await move(alice, 'failed', 'npm run test failed: expected 6, got 5');
    expect(failed.body.plan.steps[0]).toMatchObject({
      runState: 'failed',
      runDetail: 'npm run test failed: expected 6, got 5',
    });
    // Planned again, then done: final.
    expect((await move(alice, 'waiting')).status).toBe(200);
    expect((await move(alice, 'running')).status).toBe(200);
    expect((await move(alice, 'done', 'verified: 3/3 checks')).status).toBe(200);
    expect((await move(alice, 'running')).status).toBe(409);

    const activity = (await api(alice, 'GET', `/api/sessions/${s.id}/activity`)).body.activity as {
      kind: string;
      text: string;
      detail: string | null;
    }[];
    expect(
      activity.filter((a) => a.kind.startsWith('task_')).map((a) => [a.kind, a.text, a.detail]),
    ).toEqual([
      ['task_done', '"Add the model" is done', 'verified: 3/3 checks'],
      ['task_failed', '"Add the model" failed', 'npm run test failed: expected 6, got 5'],
    ]);
  });

  it('lets editors plan, hands over free steps at once and asks owners for theirs', async () => {
    const s = await newSession();
    const watcher = await connect(h, carol.token);
    await watcher.waitFor((m) => m.type === 'welcome');
    watcher.send({ type: 'subscribe', workspaceId });

    expect(
      (await api(carol, 'POST', `/api/sessions/${s.id}/plan/steps`, { steps: [{ title: 'x' }] }))
        .status,
    ).toBe(403);
    const added = await api(alice, 'POST', `/api/sessions/${s.id}/plan/steps`, {
      steps: [
        { title: 'Find the race', ownerId: alice.id },
        { title: 'Compare-and-set the seat write' },
        { title: 'Concurrent join test' },
      ],
    });
    expect(added.status).toBe(200);
    const [find, cas, test] = added.body.plan.steps as Step[];
    await watcher.waitFor((m) => m.type === 'plan');

    // Alice starts her step.
    await api(alice, 'PATCH', `/api/plan-steps/${find!.id}`, { status: 'doing' });

    // Bob takes over: the free step moves now, Alice's started one is asked of her.
    const take = await api(bob, 'POST', `/api/sessions/${s.id}/plan/takeover`, {
      stepIds: [find!.id, cas!.id],
    });
    expect(take.body.transferred).toEqual([cas!.id]);
    expect(take.body.requested).toEqual([find!.id]);
    const offer = take.body.plan.offers[0];
    expect(offer).toMatchObject({ stepId: find!.id, fromUserId: bob.id, toUserId: alice.id });

    // Only the owner answers; she accepts.
    expect((await api(bob, 'POST', `/api/step-offers/${offer.id}`, { accept: true })).status).toBe(
      404,
    );
    const accepted = await api(alice, 'POST', `/api/step-offers/${offer.id}`, { accept: true });
    expect((accepted.body.plan.steps as Step[]).find((x) => x.id === find!.id)!.ownerId).toBe(
      bob.id,
    );
    expect(accepted.body.plan.offers).toEqual([]);

    // A commenter (no agent needed) can hold work and finish it; a viewer can't.
    expect(
      (await api(carol, 'POST', `/api/sessions/${s.id}/plan/takeover`, { stepIds: [test!.id] }))
        .status,
    ).toBe(403);
    await api(dave, 'POST', `/api/sessions/${s.id}/plan/takeover`, { stepIds: [test!.id] });
    expect(
      (await api(dave, 'PATCH', `/api/plan-steps/${test!.id}`, { status: 'done' })).status,
    ).toBe(200);
    expect(
      (await api(dave, 'PATCH', `/api/plan-steps/${cas!.id}`, { status: 'done' })).status,
    ).toBe(403);
    expect(
      (await api(dave, 'PATCH', `/api/plan-steps/${test!.id}`, { title: 'renamed' })).status,
    ).toBe(403);

    // The card's progress comes from the plan.
    const card = await watcher.waitFor<{
      session: { id: string; plan: { done: number; total: number } };
    }>(
      (m) =>
        m.type === 'session' &&
        (m['session'] as { id: string; plan: { done: number } }).id === s.id &&
        (m['session'] as { plan: { done: number } }).plan.done === 1,
    );
    expect(card.session.plan).toEqual({ done: 1, total: 3 });

    // Owners hand work back; agents claim only free steps.
    await api(dave, 'POST', `/api/plan-steps/${test!.id}/release`);
    const claim = await api(dave, 'POST', `/api/plan-steps/${cas!.id}/claim`);
    expect(claim.status).toBe(409);
    expect(claim.body.error.message).toMatch(/belongs to bob/);
    watcher.close();
  });
});

describe('comments', () => {
  it('pins comments to code, keeps resolved ones, labels moved code and links what came of them', async () => {
    const s = await newSession();
    const anchor = {
      kind: 'file',
      path: 'src/lobby.ts',
      startLine: 10,
      endLine: 12,
      snippet: 'reserveSlot(seat)',
    };
    expect(
      (await api(carol, 'POST', `/api/workspaces/${workspaceId}/comments`, { anchor, body: 'hm' }))
        .status,
    ).toBe(403);
    const made = await api(dave, 'POST', `/api/workspaces/${workspaceId}/comments`, {
      sessionId: s.id,
      anchor,
      body: 'Both joins read the same revision here.',
    });
    expect(made.status).toBe(200);
    const comment = made.body.comment;
    expect(comment).toMatchObject({ authorName: 'dave', status: 'open', outdated: false });

    await api(bob, 'POST', `/api/workspaces/${workspaceId}/comments`, {
      parentId: comment.id,
      anchor,
      body: 'Agreed.',
    });
    await api(alice, 'POST', `/api/workspaces/${workspaceId}/comments`, {
      anchor: { kind: 'hunk', path: 'src/lobby.ts', startLine: 11, endLine: 11, snippet: 'x' },
      kind: 'suggestion',
      body: 'Use compare-and-set',
      proposal: 'casSeat(seat, revision)',
    });

    // Resolving never deletes.
    await api(dave, 'PATCH', `/api/comments/${comment.id}`, { status: 'resolved' });
    // Any member's machine may label it outdated when the code moves.
    expect(
      (await api(carol, 'PATCH', `/api/comments/${comment.id}`, { outdated: true })).status,
    ).toBe(200);
    // Only the author edits the text.
    expect((await api(bob, 'PATCH', `/api/comments/${comment.id}`, { body: 'x' })).status).toBe(
      403,
    );

    // A comment becomes a plan step and stays linked to it.
    const step = await api(bob, 'POST', `/api/sessions/${s.id}/plan/steps`, {
      steps: [{ title: 'Make the seat write compare-and-set' }],
      fromCommentId: comment.id,
    });
    const stepId = step.body.plan.steps[0].id;

    const list = await api(
      carol,
      'GET',
      `/api/workspaces/${workspaceId}/comments?path=src/lobby.ts`,
    );
    const mine = list.body.comments.find((c: { id: string }) => c.id === comment.id);
    expect(mine).toMatchObject({ status: 'resolved', outdated: true, stepId, resolvedBy: dave.id });
    expect(list.body.comments).toHaveLength(3);
    expect(list.body.comments.find((c: { kind: string }) => c.kind === 'suggestion').proposal).toBe(
      'casSeat(seat, revision)',
    );
  });
});

describe('the Brain', () => {
  it("keeps agents' notes unverified until accepted, flags moved code and supersedes on rewrite", async () => {
    const listener = await connect(h, carol.token);
    await listener.waitFor((m) => m.type === 'welcome');
    listener.send({ type: 'subscribe', workspaceId });

    expect(
      (
        await api(carol, 'POST', `/api/workspaces/${workspaceId}/memories`, {
          kind: 'gotcha',
          text: 'x',
        })
      ).status,
    ).toBe(403);
    const byAgent = await api(bob, 'POST', `/api/workspaces/${workspaceId}/memories`, {
      kind: 'gotcha',
      text: 'reserveSlot reads the revision before the write; never cache it.',
      path: 'src/lobby.ts',
      startLine: 10,
      endLine: 12,
      snippet: 'reserveSlot(seat)',
      byAgent: 'Claude Code · haiku',
    });
    const note = byAgent.body.memory;
    expect(note).toMatchObject({ status: 'active', verified: false, authorName: 'bob' });
    const heard = await listener.waitFor<{ memory: { id: string } }>((m) => m.type === 'memory');
    expect(heard.memory.id).toBe(note.id);

    const human = await api(alice, 'POST', `/api/workspaces/${workspaceId}/memories`, {
      kind: 'convention',
      text: 'Seat writes go through casSeat.',
    });
    expect(human.body.memory.verified).toBe(true);

    // Someone's machine notices the code moved: the note is flagged, for the next agent.
    const flagged = await api(carol, 'POST', `/api/memories/${note.id}/flag`, {
      reason: 'The code moved to line 40.',
    });
    expect(flagged.body.memory).toMatchObject({
      status: 'flagged',
      flagReason: 'The code moved to line 40.',
    });

    // An agent rewrites it: the old one retires, the new one points back at it.
    const rewrite = await api(alice, 'POST', `/api/workspaces/${workspaceId}/memories`, {
      kind: 'gotcha',
      text: 'reserveSlot (now line 40) reads the revision before the write; never cache it.',
      path: 'src/lobby.ts',
      startLine: 40,
      snippet: 'reserveSlot(seat)',
      byAgent: 'Kovan · JevRouter',
      replacesId: note.id,
    });
    expect(rewrite.body.memory).toMatchObject({ replacesId: note.id, endLine: 40 });
    const live = await api(carol, 'GET', `/api/workspaces/${workspaceId}/memories`);
    expect(live.body.memories.map((m: { id: string }) => m.id).sort()).toEqual(
      [human.body.memory.id, rewrite.body.memory.id].sort(),
    );
    const retired = await api(
      carol,
      'GET',
      `/api/workspaces/${workspaceId}/memories?status=retired`,
    );
    expect(retired.body.memories.map((m: { id: string }) => m.id)).toEqual([note.id]);

    // A person accepts the agent's note and edits it.
    const accepted = await api(bob, 'PATCH', `/api/memories/${rewrite.body.memory.id}`, {
      verified: true,
      text: 'reserveSlot reads the revision first; never cache it.',
    });
    expect(accepted.body.memory).toMatchObject({ verified: true, status: 'active' });
    listener.close();
  });
});

describe('evolution memory', () => {
  type Note = { id: string; conflictsWith: string[]; rationale: string | null; affects: string[] };
  const note = async (who: typeof alice, body: Record<string, unknown>) =>
    (await api(who, 'POST', `/api/workspaces/${workspaceId}/memories`, body)).body.memory as Note;
  const get = async (id: string) =>
    (
      (await api(alice, 'GET', `/api/workspaces/${workspaceId}/memories`)).body.memories as Note[]
    ).find((m) => m.id === id)!;

  it('keeps decisions with why and what follows, and links notes that may disagree', async () => {
    const decision = await note(alice, {
      kind: 'decision',
      text: 'Payments go through one Stripe client.',
      rationale: 'Retries and idempotency keys in one place.',
      consequences: 'Other modules must not call Stripe directly.',
      affects: ['./src/billing'],
    });
    expect(decision).toMatchObject({
      rationale: 'Retries and idempotency keys in one place.',
      affects: ['src/billing'],
      conflictsWith: [],
    });
    // Another source decides about a module under the same folder: both kept, linked.
    const other = await note(bob, {
      kind: 'decision',
      text: 'Refunds call Stripe directly for speed.',
      affects: ['src/billing/refunds.ts'],
      byAgent: 'Claude Code · opus',
    });
    expect(other.conflictsWith).toEqual([decision.id]);
    expect((await get(decision.id)).conflictsWith).toEqual([other.id]);

    // Notes on the same lines from different sources too; the same source, or a rewrite, not.
    const pinned = { kind: 'gotcha', path: 'src/seats.ts', startLine: 10, endLine: 14 };
    const a = await note(alice, { ...pinned, text: 'Seat writes must be compare-and-set.' });
    const again = await note(alice, { ...pinned, startLine: 12, text: 'And keep them short.' });
    expect(again.conflictsWith).toEqual([]);
    const b = await note(bob, { ...pinned, startLine: 13, text: 'Seat writes can be plain.' });
    expect(b.conflictsWith.sort()).toEqual([a.id, again.id].sort());
    const rewrite = await note(bob, { ...pinned, text: 'Seat writes are CAS.', replacesId: b.id });
    expect(rewrite.conflictsWith).toEqual([]);

    // A person settles it: both hold, or one is retired; either way the link goes.
    await api(alice, 'PATCH', `/api/memories/${decision.id}`, { clearConflicts: true });
    expect((await get(decision.id)).conflictsWith).toEqual([]);
    expect((await get(other.id)).conflictsWith).toEqual([]);
    const c = await note(bob, { ...pinned, startLine: 10, text: 'Seat writes use a lock.' });
    expect(c.conflictsWith).toContain(a.id);
    await api(alice, 'PATCH', `/api/memories/${c.id}`, { status: 'retired' });
    expect((await get(a.id)).conflictsWith).not.toContain(c.id);
  });
});
