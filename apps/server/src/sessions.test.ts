import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sessionParticipants, transcriptChunks, users } from './db/schema.js';
import { auth, connect, oauthLogin, startHarness, type Harness } from './test/harness.js';

let h: Harness;
type Person = { token: string; id: string };
let alice: Person;
let bob: Person;
let carol: Person;
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
  const orgId = (await api(alice, 'GET', '/api/me')).body.orgs[0].id;
  workspaceId = (
    await api(alice, 'POST', '/api/workspaces', { orgId, name: 'lobby', repoUrl: null })
  ).body.workspace.id;
  await api(alice, 'POST', `/api/workspaces/${workspaceId}/invites`, {
    githubLogin: 'bob',
    role: 'editor',
  });
  await api(alice, 'POST', `/api/workspaces/${workspaceId}/invites`, {
    githubLogin: 'carol',
    role: 'viewer',
  });
});
afterAll(async () => {
  await h.close();
});

async function newSession(title = 'Fix the lobby join race') {
  const res = await api(alice, 'POST', `/api/workspaces/${workspaceId}/sessions`, {
    title,
    branch: 'kovan/lobby-race',
  });
  expect(res.status).toBe(200);
  return res.body.session as { id: string; [k: string]: unknown };
}

async function follow(person: Person, sessionId: string) {
  const c = await connect(h, person.token);
  await c.waitFor((m) => m.type === 'welcome');
  c.send({ type: 'subscribe', workspaceId });
  c.send({ type: 'session.subscribe', sessionId });
  const snapshot = await c.waitFor<Msg>((m) => m.type === 'session.snapshot');
  return { c, snapshot };
}

describe('sessions', () => {
  it('starts a session, and lets editors join and viewers only watch', async () => {
    const s = await newSession();
    expect(s).toMatchObject({ status: 'active', branch: 'kovan/lobby-race', participants: [] });

    const join = (p: Person, mode: 'join' | 'watch') =>
      api(p, 'POST', `/api/sessions/${s.id}/join`, { mode, harness: 'kovan', model: 'm' });
    expect((await join(alice, 'join')).status).toBe(200);
    expect((await join(bob, 'join')).status).toBe(200);
    expect((await join(carol, 'join')).status).toBe(403);
    const watched = await join(carol, 'watch');
    expect(watched.status).toBe(200);
    expect(
      watched.body.session.participants.map((p: { name: string; mode: string }) => [
        p.name,
        p.mode,
      ]),
    ).toEqual([
      ['alice', 'join'],
      ['bob', 'join'],
      ['carol', 'watch'],
    ]);

    const list = await api(carol, 'GET', `/api/workspaces/${workspaceId}/sessions`);
    expect(list.body.sessions.map((x: { id: string }) => x.id)).toContain(s.id);
  });

  it('turns away a join when every agent seat is taken', async () => {
    const s = await newSession('Full room');
    const fillers = await h.ctx.db
      .insert(users)
      .values(Array.from({ length: 20 }, (_, i) => ({ name: `filler${i}` })))
      .returning({ id: users.id });
    await h.ctx.db
      .insert(sessionParticipants)
      .values(fillers.map((f) => ({ sessionId: s.id, userId: f.id, mode: 'join' as const })));
    const res = await api(bob, 'POST', `/api/sessions/${s.id}/join`, { mode: 'join' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/full/);
    // Watching is always possible.
    expect((await api(bob, 'POST', `/api/sessions/${s.id}/join`, { mode: 'watch' })).status).toBe(
      200,
    );
  });

  it('streams lanes live to everyone, redacts secrets, and catches up a reconnecting client', async () => {
    const s = await newSession('Live lanes');
    await api(alice, 'POST', `/api/sessions/${s.id}/join`, { mode: 'join' });
    await api(bob, 'POST', `/api/sessions/${s.id}/join`, { mode: 'join' });
    await api(carol, 'POST', `/api/sessions/${s.id}/join`, { mode: 'watch' });

    const a = await follow(alice, s.id);
    const b = await follow(bob, s.id);
    const c = await follow(carol, s.id);

    a.c.send({
      type: 'lane.events',
      sessionId: s.id,
      events: [
        { type: 'user', text: 'Make the seat write compare-and-set', attachments: [], at: 1 },
        { type: 'turn_start', turnId: 't1', model: 'openai/gpt-5.6-luna' },
        { type: 'reasoning', text: 'The race is in ' },
        { type: 'reasoning', text: 'reserveSlot.' },
        { type: 'text', text: 'key is sk-or-v1-0123456789abcdef0123456789abcdef' },
      ],
    });
    const seen = await c.c.waitFor<Msg>(
      (m) => m.type === 'lane.events' && m['userId'] === alice.id,
    );
    const events = seen['events'] as Msg[];
    expect(events).toHaveLength(5);
    expect(events[4]!['text']).toBe('key is [redacted]');
    await b.c.waitFor((m) => m.type === 'lane.events');

    // The board hears that alice's lane is running.
    const running = await c.c.waitFor<Msg>(
      (m) =>
        m.type === 'session' &&
        (m['session'] as { running: { userId: string }[] }).running.some(
          (r) => r.userId === alice.id,
        ),
    );
    expect(running).toBeTruthy();

    // Bob streams in his own lane at the same time.
    b.c.send({
      type: 'lane.events',
      sessionId: s.id,
      events: [{ type: 'turn_start', turnId: 'b1', model: 'claude' }],
    });
    await c.c.waitFor((m) => m.type === 'lane.events' && m['userId'] === bob.id);

    // A client that reconnects mid-turn gets the half-finished output in its snapshot.
    const late = await follow(carol, s.id);
    const lanes = late.snapshot['lanes'] as { userId: string; events: Msg[] }[];
    const aliceLane = lanes.find((l) => l.userId === alice.id)!;
    expect(aliceLane.events.map((e) => e.type)).toEqual([
      'user',
      'turn_start',
      'reasoning',
      'reasoning',
      'text',
    ]);

    // After the turn ends it's stored (compacted, encrypted) and still comes back.
    a.c.send({
      type: 'lane.events',
      sessionId: s.id,
      events: [
        { type: 'tool_start', id: 'x', name: 'edit_file', summary: 'Edited src/lobby.ts' },
        { type: 'turn_end', turnId: 't1', reason: 'done', cost: 0.0123 },
      ],
      touched: ['src/lobby.ts'],
    });
    await c.c.waitFor(
      (m) =>
        m.type === 'session' &&
        (m['session'] as { touchedFiles: string[] }).touchedFiles.includes('src/lobby.ts'),
    );
    const [chunk] = await h.ctx.db
      .select()
      .from(transcriptChunks)
      .where(eq(transcriptChunks.userId, alice.id));
    expect(chunk!.dataEnc).not.toContain('compare-and-set');
    const again = await follow(carol, s.id);
    const stored = (again.snapshot['lanes'] as { userId: string; events: Msg[] }[]).find(
      (l) => l.userId === alice.id,
    )!;
    expect(stored.events.map((e) => e.type)).toEqual([
      'user',
      'turn_start',
      'reasoning',
      'text',
      'tool_start',
      'turn_end',
    ]);
    expect(stored.events[2]!['text']).toBe('The race is in reserveSlot.');
    const view = (await api(carol, 'GET', `/api/sessions/${s.id}`)).body.session;
    expect(view.cost).toBeCloseTo(0.0123);
    expect(view.running).toEqual([{ userId: bob.id, model: 'claude' }]);

    // Watchers can't stream into a lane.
    c.c.send({ type: 'lane.events', sessionId: s.id, events: [{ type: 'text', text: 'hi' }] });
    const refused = await c.c.waitFor<Msg>((m) => m.type === 'error');
    expect(refused['code']).toBe('forbidden');

    for (const x of [a, b, c, late, again]) x.c.close();
  });

  it('lets any editor answer an approval card, first answer wins, on the owner machine', async () => {
    const s = await newSession('Approvals');
    await api(alice, 'POST', `/api/sessions/${s.id}/join`, { mode: 'join' });
    const a = await follow(alice, s.id);
    const b = await follow(bob, s.id);
    const c = await follow(carol, s.id);

    a.c.send({
      type: 'lane.events',
      sessionId: s.id,
      events: [
        { type: 'turn_start', turnId: 't1', model: 'm' },
        {
          type: 'approval',
          request: {
            id: 'call_1',
            tool: 'run_shell',
            kind: 'command',
            title: 'Run this?',
            detail: 'pnpm test',
          },
        },
      ],
    });
    const pending = await b.c.waitFor<Msg>((m) => m.type === 'approval');
    expect(pending['approval']).toMatchObject({
      laneUserId: alice.id,
      requestId: 'call_1',
      detail: 'pnpm test',
      status: 'pending',
    });
    const alerts = await api(carol, 'GET', `/api/workspaces/${workspaceId}/approvals`);
    expect(alerts.body.approvals).toHaveLength(1);

    // A viewer can't answer.
    const answer = {
      type: 'approval.answer',
      sessionId: s.id,
      laneUserId: alice.id,
      requestId: 'call_1',
    };
    c.c.send({ ...answer, approved: true });
    expect((await c.c.waitFor<Msg>((m) => m.type === 'error'))['code']).toBe('forbidden');

    // Bob (an editor, not even in the session) answers first; alice's machine hears it.
    b.c.send({ ...answer, approved: true });
    const resolved = await a.c.waitFor<Msg>(
      (m) => m.type === 'approval' && (m['approval'] as { status: string }).status !== 'pending',
    );
    expect(resolved['approval']).toMatchObject({ status: 'approved', answeredBy: bob.id });

    // A second answer loses.
    a.c.send({ ...answer, approved: false });
    expect((await a.c.waitFor<Msg>((m) => m.type === 'error'))['code']).toBe('conflict');
    expect(
      (await api(carol, 'GET', `/api/workspaces/${workspaceId}/approvals`)).body.approvals,
    ).toEqual([]);

    for (const x of [a, b, c]) x.c.close();
  });

  it('applies a role change to the very next lane batch', async () => {
    const s = await newSession('Role drop');
    await api(bob, 'POST', `/api/sessions/${s.id}/join`, { mode: 'join' });
    const b = await follow(bob, s.id);
    await api(alice, 'PATCH', `/api/workspaces/${workspaceId}/members/${bob.id}`, {
      role: 'viewer',
    });
    b.c.send({ type: 'lane.events', sessionId: s.id, events: [{ type: 'text', text: 'x' }] });
    expect((await b.c.waitFor<Msg>((m) => m.type === 'error'))['code']).toBe('forbidden');
    await api(alice, 'PATCH', `/api/workspaces/${workspaceId}/members/${bob.id}`, {
      role: 'editor',
    });
    b.c.close();
  });

  it('ends a session into history with its transcript and final diff', async () => {
    const s = await newSession('Ends');
    await api(alice, 'POST', `/api/sessions/${s.id}/join`, { mode: 'join' });
    const a = await follow(alice, s.id);
    a.c.send({
      type: 'lane.events',
      sessionId: s.id,
      events: [
        { type: 'turn_start', turnId: 't', model: 'm' },
        { type: 'text', text: 'done' },
      ],
    });
    await a.c.waitFor((m) => m.type === 'lane.events');
    const ended = await api(bob, 'POST', `/api/sessions/${s.id}/end`, {
      diff: 'diff --git a/x b/x\n+TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n',
    });
    expect(ended.body.session).toMatchObject({ status: 'ended', running: [] });

    const history = await api(carol, 'GET', `/api/workspaces/${workspaceId}/sessions?status=ended`);
    expect(history.body.sessions.map((x: { id: string }) => x.id)).toContain(s.id);
    const transcript = await api(carol, 'GET', `/api/sessions/${s.id}/transcript`);
    expect(transcript.body.lanes[0].events.map((e: Msg) => e.type)).toEqual(['turn_start', 'text']);
    const diff = await api(carol, 'GET', `/api/sessions/${s.id}/diff`);
    expect(diff.body.diff).toContain('TOKEN=[redacted]');

    a.c.send({ type: 'lane.events', sessionId: s.id, events: [{ type: 'text', text: 'late' }] });
    expect((await a.c.waitFor<Msg>((m) => m.type === 'error'))['code']).toBe('conflict');
    a.c.close();
  });

  it("keeps each machine's live view of the changes until the session ends", async () => {
    const s = await newSession('Live changes');
    const c = await follow(carol, s.id);
    const big = `diff --git a/big b/big\n${'+x\n'.repeat(130_000)}`;
    const put = (p: Person, diff: string | null) =>
      api(p, 'PUT', `/api/sessions/${s.id}/changes`, { diff, commit: 'abc123' });
    // Viewers read, they don't send; editors send even large diffs.
    expect((await put(carol, 'diff --git a/x b/x\n')).status).toBe(403);
    expect((await put(alice, big)).status).toBe(200);
    const heard = await c.c.waitFor<Msg>((m) => m.type === 'session.changes');
    expect(heard).toMatchObject({ sessionId: s.id, userId: alice.id });
    expect(
      (await put(bob, 'diff --git a/y b/y\n+KEY=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n'))
        .status,
    ).toBe(200);

    const read = await api(carol, 'GET', `/api/sessions/${s.id}/changes`);
    expect(read.body.changes.map((x: Msg) => x['userName'])).toEqual(['bob', 'alice']);
    expect(read.body.changes[0]).toMatchObject({ userId: bob.id, commit: 'abc123' });
    expect(read.body.changes[0].diff).toContain('KEY=[redacted]');
    expect(read.body.changes[1].diff.length).toBe(big.length);
    // A clean checkout says so; the next view replaces the last one.
    await put(bob, null);
    const again = await api(carol, 'GET', `/api/sessions/${s.id}/changes`);
    expect(again.body.changes[0]).toMatchObject({ userId: bob.id, diff: null });

    await api(alice, 'POST', `/api/sessions/${s.id}/end`, { diff: big });
    expect((await api(carol, 'GET', `/api/sessions/${s.id}/changes`)).body.changes).toEqual([]);
    expect((await api(carol, 'GET', `/api/sessions/${s.id}/diff`)).body.diff.length).toBe(
      big.length,
    );
    expect((await put(alice, 'diff --git a/z b/z\n')).status).toBe(409);
    c.c.close();
  });

  it('deletes transcripts past the org retention', async () => {
    const before = await h.ctx.db.select({ n: sql<number>`count(*)::int` }).from(transcriptChunks);
    expect(before[0]!.n).toBeGreaterThan(0);
    await h.ctx.db.execute(
      sql`update transcript_chunks set created_at = now() - interval '91 days'`,
    );
    await h.ctx.sessions.sweepRetention();
    const after = await h.ctx.db.select({ n: sql<number>`count(*)::int` }).from(transcriptChunks);
    expect(after[0]!.n).toBe(0);
  });

  it("doesn't show sessions to people outside the workspace", async () => {
    const s = await newSession('Private');
    const dave = await oauthLogin(h, 'github', 'dave', { providerUserId: '4', login: 'dave' });
    const d = { token: dave.token, id: dave.user.id };
    expect((await api(d, 'GET', `/api/sessions/${s.id}`)).status).toBe(404);
    expect((await api(d, 'GET', `/api/workspaces/${workspaceId}/sessions`)).status).toBe(404);
  });
});
