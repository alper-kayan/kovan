import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, connect, oauthLogin, startHarness, type Harness } from './test/harness.js';

let h: Harness;
type Person = { token: string; id: string };
let ana: Person; // owner
let bora: Person; // editor
let cem: Person; // commenter
let wsId: string;
let otherWs: string;
let sessionId: string;
let wren: string;

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
  cem = await login('cem', '3', 'Cem');
  const orgId = (await api(ana, 'GET', '/api/me')).body.orgs[0].id;
  const workspace = async (name: string) =>
    (await api(ana, 'POST', '/api/workspaces', { orgId, name, repoUrl: null })).body.workspace
      .id as string;
  wsId = await workspace('Shop');
  otherWs = await workspace('Other');
  for (const [githubLogin, role] of [
    ['bora', 'editor'],
    ['cem', 'commenter'],
  ])
    await api(ana, 'POST', `/api/workspaces/${wsId}/invites`, { githubLogin, role });
  sessionId = (
    await api(ana, 'POST', `/api/workspaces/${wsId}/sessions`, {
      title: 'totals',
      branch: 'kovan/totals',
    })
  ).body.session.id;
  wren = (
    await api(ana, 'POST', `/api/workspaces/${wsId}/agents`, {
      name: 'Wren',
      model: 'openai/gpt-5.6-luna',
      instructions: 'Reviews code',
    })
  ).body.agent.id;
});

afterAll(() => h.close());

describe('calling an AI teammate in with @', () => {
  it("brings it into the session on the caller's machine and hands it the conversation", async () => {
    const desk = await connect(h, bora.token);
    await desk.waitFor((m) => m.type === 'welcome');
    const r = await api(bora, 'POST', `/api/sessions/${sessionId}/mention`, {
      agentId: wren,
      text: 'Is total() right?',
      context:
        'Bora: add total()\nAgent: Added src/total.ts with key sk-or-v1-0123456789abcdef0123',
      reply: { kind: 'lane', laneUserId: bora.id },
    });
    expect(r.status).toBe(200);
    const steer = await desk.waitFor((m) => m.type === 'steer');
    expect(steer).toMatchObject({
      sessionId,
      laneUserId: wren,
      fromUserId: bora.id,
      fromName: 'Bora',
      text: 'Is total() right?',
      mention: { reply: { kind: 'lane', laneUserId: bora.id } },
    });
    // Secrets in the conversation don't travel with it.
    const context = (steer.mention as { context: string }).context;
    expect(context).toContain('Added src/total.ts');
    expect(context).not.toContain('sk-or-v1');
    const { session } = (await api(ana, 'GET', `/api/sessions/${sessionId}`)).body;
    expect(session.participants.find((p: { userId: string }) => p.userId === wren)).toMatchObject({
      kind: 'agent',
      hostId: bora.id,
    });

    // Called again by someone else, it stays on the machine already running it.
    await api(ana, 'POST', `/api/sessions/${sessionId}/mention`, {
      agentId: wren,
      text: 'And the tests?',
      reply: { kind: 'lane', laneUserId: ana.id },
    });
    const again = await desk.waitFor((m) => m.type === 'steer' && m.text === 'And the tests?');
    expect(again.mention).toMatchObject({ context: null });
    desk.socket.close();
  });

  it('answers only in your own conversation, or a comment thread of the workspace', async () => {
    const desk = await connect(h, bora.token);
    await desk.waitFor((m) => m.type === 'welcome');
    const call = (reply: object, person = bora) =>
      api(person, 'POST', `/api/sessions/${sessionId}/mention`, {
        agentId: wren,
        text: 'Look at this',
        reply,
      });
    expect((await call({ kind: 'lane', laneUserId: ana.id })).status).toBe(403);
    const elsewhere = (
      await api(ana, 'POST', `/api/workspaces/${otherWs}/comments`, {
        anchor: { kind: 'session' },
        body: 'Elsewhere',
      })
    ).body.comment;
    expect((await call({ kind: 'comment', commentId: elsewhere.id })).status).toBe(404);
    const here = (
      await api(bora, 'POST', `/api/workspaces/${wsId}/comments`, {
        sessionId,
        anchor: { kind: 'session' },
        body: '@Wren is this safe?',
      })
    ).body.comment;
    expect((await call({ kind: 'comment', commentId: here.id })).status).toBe(200);
    // Someone who can't steer agents there can't call one in.
    expect((await call({ kind: 'lane', laneUserId: cem.id }, cem)).status).toBe(403);
    desk.socket.close();
  });
});

describe("a called-in teammate's answer", () => {
  it('reaches the caller live, and lands in the comment thread as its reply once done', async () => {
    const desk = await connect(h, bora.token);
    await desk.waitFor((m) => m.type === 'welcome');
    const answer = (person: Person, payload: object) =>
      api(person, 'POST', `/api/sessions/${sessionId}/mention/answer`, {
        agentId: wren,
        requestId: 'req-1',
        askerId: bora.id,
        ...payload,
      });
    // Wren runs on Bora's machine (it was called in from there): only that machine answers.
    expect(
      (await answer(ana, { reply: { kind: 'lane', laneUserId: bora.id }, status: 'working' }))
        .status,
    ).toBe(403);
    expect(
      (
        await answer(bora, {
          reply: { kind: 'lane', laneUserId: bora.id },
          status: 'answered',
          text: 'total() skips refunds; key sk-or-v1-0123456789abcdef0123 aside.',
        })
      ).status,
    ).toBe(200);
    const live = await desk.waitFor((m) => m.type === 'teammate.reply');
    expect(live).toMatchObject({
      sessionId,
      agentId: wren,
      name: 'Wren',
      requestId: 'req-1',
      status: 'answered',
    });
    expect(live.text).toContain('total() skips refunds');
    expect(live.text).not.toContain('sk-or-v1');
    // It answers in the caller's own conversation only.
    expect(
      (await answer(bora, { reply: { kind: 'lane', laneUserId: ana.id }, status: 'working' }))
        .status,
    ).toBe(400);

    const root = (
      await api(bora, 'POST', `/api/workspaces/${wsId}/comments`, {
        sessionId,
        anchor: { kind: 'session' },
        body: '@Wren how are refunds summed?',
      })
    ).body.comment;
    const thread = { reply: { kind: 'comment', commentId: root.id } };
    await answer(bora, { ...thread, status: 'working' });
    await answer(bora, { ...thread, status: 'answered', text: 'They are subtracted twice.' });
    const { comments } = (
      await api(ana, 'GET', `/api/workspaces/${wsId}/comments?sessionId=${sessionId}`)
    ).body;
    const replies = comments.filter((c: { parentId: string }) => c.parentId === root.id);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      authorName: 'Wren',
      authorKind: 'agent',
      body: 'They are subtracted twice.',
    });
    expect(root.authorKind).toBe('human');
    desk.socket.close();
  });
});
