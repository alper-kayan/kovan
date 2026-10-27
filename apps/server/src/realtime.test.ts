import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, connect, oauthLogin, startHarness, type Harness } from './test/harness.js';

let h: Harness;
let alice: { token: string; id: string };
let bob: { token: string; id: string };
let workspaceId: string;

type Presence = {
  type: 'presence';
  workspaceId: string;
  online: { userId: string; inWorkspace: boolean; status: string }[];
};

beforeAll(async () => {
  h = await startHarness();
  const a = await oauthLogin(h, 'github', 'alice', {
    providerUserId: '1',
    login: 'alice',
    name: 'Alice',
  });
  const b = await oauthLogin(h, 'github', 'bob', {
    providerUserId: '2',
    login: 'bob',
    name: 'Bob',
  });
  alice = { token: a.token, id: a.user.id };
  bob = { token: b.token, id: b.user.id };
  const orgId = (
    await h.app.inject({ method: 'GET', url: '/api/me', headers: auth(a.token) })
  ).json().orgs[0].id;
  workspaceId = (
    await h.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: auth(a.token),
      payload: { orgId, name: 'room', repoUrl: null },
    })
  ).json().workspace.id;
  await h.app.inject({
    method: 'POST',
    url: `/api/workspaces/${workspaceId}/invites`,
    headers: auth(a.token),
    payload: { githubLogin: 'bob', role: 'editor' },
  });
});
afterAll(async () => {
  await h.close();
});

describe('realtime hub', () => {
  it('closes connections that fail to authenticate', async () => {
    const client = await connect(h, 'kvn_wrong');
    const code = await new Promise((resolve) => client.socket.once('close', resolve));
    expect(code).toBe(4401);
  });

  it('sends an app that reconnects what it missed, in order, or tells it to read again', async () => {
    type Subscribed = { type: 'subscribed'; epoch: string; seq: number; resync: boolean };
    const change = () => h.ctx.hub.sendWorkspace(workspaceId, { type: 'members', workspaceId });
    const a = await connect(h, alice.token);
    await a.waitFor((m) => m.type === 'welcome');
    a.send({ type: 'subscribe', workspaceId });
    const first = await a.waitFor<Subscribed>((m) => m.type === 'subscribed');
    expect(first.resync).toBe(false);
    change();
    const seen = await a.waitFor<{ seq: number }>((m) => m.type === 'members');
    expect(seen.seq).toBe(first.seq + 1);
    a.socket.close();

    // Offline: two changes go by.
    change();
    change();
    const back = await connect(h, alice.token);
    await back.waitFor((m) => m.type === 'welcome');
    back.send({ type: 'subscribe', workspaceId, since: { epoch: first.epoch, seq: seen.seq } });
    const again = await back.waitFor<Subscribed & { replayed: number }>(
      (m) => m.type === 'subscribed',
    );
    expect(again).toMatchObject({ resync: false, replayed: 2, seq: seen.seq + 2 });
    await back.waitFor((m) => m.type === 'members' && m['seq'] === seen.seq + 2);
    expect(back.messages.filter((m) => m.type === 'members').map((m) => m['seq'])).toEqual([
      seen.seq + 1,
      seen.seq + 2,
    ]);

    // Another server process (a restart) or a gap the journal no longer holds: read again.
    back.send({ type: 'subscribe', workspaceId, since: { epoch: 'other', seq: 1 } });
    expect(
      await back.waitFor<Subscribed>((m) => m.type === 'subscribed' && m['resync'] === true),
    ).toMatchObject({ resync: true });
    for (let i = 0; i < 520; i++) change();
    back.send({ type: 'subscribe', workspaceId, since: { epoch: first.epoch, seq: seen.seq } });
    expect(
      await back.waitFor<Subscribed>(
        (m) => m.type === 'subscribed' && m['resync'] === true && m['seq'] === seen.seq + 522,
      ),
    ).toMatchObject({ resync: true });
    back.close();
  });

  it('shows two people online in the same workspace, live', async () => {
    const a = await connect(h, alice.token);
    await a.waitFor((m) => m.type === 'welcome');
    a.send({ type: 'subscribe', workspaceId });
    a.send({ type: 'presence', status: 'active', workspaceId });

    const b = await connect(h, bob.token);
    await b.waitFor((m) => m.type === 'welcome');
    b.send({ type: 'subscribe', workspaceId });

    const both = await a.waitFor<Presence>(
      (m) => m.type === 'presence' && (m as Presence).online.length === 2,
    );
    expect(both.online.map((p) => p.userId).sort()).toEqual([alice.id, bob.id].sort());
    expect(both.online.find((p) => p.userId === alice.id)?.inWorkspace).toBe(true);

    b.close();
    const alone = await a.waitFor<Presence>(
      (m) => m.type === 'presence' && (m as Presence).online.length === 1,
    );
    expect(alone.online[0]!.userId).toBe(alice.id);
    a.close();
  });

  it("doesn't count a phone as a machine or show it online", async () => {
    const phone = await connect(h, bob.token, { client: 'mobile' });
    await phone.waitFor((m) => m.type === 'welcome');
    phone.send({ type: 'subscribe', workspaceId });
    phone.send({ type: 'presence', status: 'active', workspaceId });
    await phone.waitFor((m) => m.type === 'presence');
    // It follows the workspace like any app, but Bob's agents aren't on it.
    expect(h.ctx.hub.presenceOf(workspaceId).some((p) => p.userId === bob.id)).toBe(false);
    expect(h.ctx.hub.isOnline(bob.id)).toBe(false);
    // Phones can't see WebSocket pings; they ask over the line instead.
    phone.send({ type: 'ping' });
    await phone.waitFor((m) => m.type === 'pong');

    const laptop = await connect(h, bob.token);
    await laptop.waitFor((m) => m.type === 'welcome');
    expect(h.ctx.hub.isOnline(bob.id)).toBe(true);
    laptop.close();
    phone.close();
  });

  it('tells the creator about a new workspace so their apps follow it', async () => {
    const a = await connect(h, alice.token);
    await a.waitFor((m) => m.type === 'welcome');
    const orgId = (
      await h.app.inject({ method: 'GET', url: '/api/me', headers: auth(alice.token) })
    ).json().orgs[0].id;
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: auth(alice.token),
      payload: { orgId, name: 'fresh', repoUrl: null },
    });
    const id = created.json().workspace.id;
    expect(
      await a.waitFor(
        (m) => m.type === 'membership' && m['workspaceId'] === id && m['role'] === 'owner',
      ),
    ).toBeTruthy();
    a.close();
  });

  it("refuses to subscribe someone to a workspace they aren't in", async () => {
    const carol = await oauthLogin(h, 'github', 'carol', { providerUserId: '3', login: 'carol' });
    const c = await connect(h, carol.token);
    await c.waitFor((m) => m.type === 'welcome');
    c.send({ type: 'subscribe', workspaceId });
    const error = await c.waitFor((m) => m.type === 'error');
    expect(error).toMatchObject({ code: 'not_found' });
    c.close();
  });

  it('pushes role changes immediately and drops removed members', async () => {
    const b = await connect(h, bob.token);
    await b.waitFor((m) => m.type === 'welcome');
    b.send({ type: 'subscribe', workspaceId });
    await b.waitFor((m) => m.type === 'presence');

    await h.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${workspaceId}/members/${bob.id}`,
      headers: auth(alice.token),
      payload: { role: 'viewer' },
    });
    expect(await b.waitFor((m) => m.type === 'membership' && m['role'] === 'viewer')).toBeTruthy();

    await h.app.inject({
      method: 'DELETE',
      url: `/api/workspaces/${workspaceId}/members/${bob.id}`,
      headers: auth(alice.token),
    });
    expect(await b.waitFor((m) => m.type === 'membership' && m['role'] === null)).toBeTruthy();
    expect(h.ctx.hub.presenceOf(workspaceId).some((p) => p.userId === bob.id)).toBe(false);
    b.close();
  });
});
