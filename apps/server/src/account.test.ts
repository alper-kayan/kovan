import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invoices, users } from './db/schema.js';
import { auth, connect, oauthLogin, startHarness, type Harness } from './test/harness.js';

let h: Harness;
type Person = { token: string; id: string };
let alice: Person;
let bob: Person;
let dana: Person;

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
  dana = await login('dana', '3');
});
afterAll(async () => {
  await h.close();
});

describe('deleting an account', () => {
  it('deletes what only you were in, hands the rest to the next person, and signs you out', async () => {
    const orgId = (await api(alice, 'GET', '/api/me')).body.orgs[0].id;
    const workspace = async (name: string) =>
      (await api(alice, 'POST', '/api/workspaces', { orgId, name, repoUrl: null })).body.workspace
        .id as string;
    const solo = await workspace('solo');
    const shared = await workspace('shared');
    // An AI teammate is not a person: "solo" still counts as only Alice's.
    const agent = (
      await api(alice, 'POST', `/api/workspaces/${solo}/agents`, {
        name: 'Wren',
        model: 'openai/gpt-5.6-luna',
      })
    ).body.agent.id as string;
    await api(alice, 'POST', `/api/workspaces/${shared}/invites`, {
      githubLogin: 'dana',
      role: 'viewer',
    });
    await api(alice, 'POST', `/api/workspaces/${shared}/invites`, {
      githubLogin: 'bob',
      role: 'editor',
    });

    // Asked first: what goes, what stays and who owns it next (the editor, not the viewer).
    const preview = (await api(alice, 'GET', '/api/me/deletion')).body.plan;
    expect(preview.deleted.map((w: { name: string }) => w.name)).toEqual(['solo']);
    expect(preview.kept).toEqual([
      { id: shared, name: 'shared', owner: { id: bob.id, name: 'bob' } },
    ]);
    expect(preview.orgsKept).toEqual([
      { id: orgId, name: expect.any(String), owner: { id: bob.id, name: 'bob' } },
    ]);
    expect(preview).toMatchObject({ blocker: null, unbilled: 0, orgsDeleted: [] });

    // It takes an explicit yes.
    expect((await api(alice, 'POST', '/api/me/delete', {})).status).toBe(400);

    const aliceApp = await connect(h, alice.token);
    await aliceApp.waitFor((m) => m.type === 'welcome');
    const closed = new Promise<number>((resolve) => aliceApp.socket.once('close', resolve));
    const bobApp = await connect(h, bob.token);
    await bobApp.waitFor((m) => m.type === 'welcome');

    expect((await api(alice, 'POST', '/api/me/delete', { confirm: true })).status).toBe(200);
    expect(await closed).toBe(4401);
    await bobApp.waitFor((m) => m.type === 'membership' && m['role'] === 'owner');
    expect((await api(alice, 'GET', '/api/me')).status).toBe(401);
    expect(await h.ctx.db.select().from(users).where(eq(users.id, alice.id))).toEqual([]);
    expect(await h.ctx.db.select().from(users).where(eq(users.id, agent))).toEqual([]);

    // Bob runs what is left; Dana is still in it, as she was.
    const bobs = (await api(bob, 'GET', '/api/workspaces')).body.workspaces as {
      id: string;
      role: string;
    }[];
    expect(bobs.find((w) => w.id === shared)?.role).toBe('owner');
    expect(bobs.some((w) => w.id === solo)).toBe(false);
    const danas = (await api(dana, 'GET', '/api/workspaces')).body.workspaces as {
      id: string;
      role: string;
    }[];
    expect(danas.find((w) => w.id === shared)?.role).toBe('viewer');
    expect((await api(bob, 'GET', '/api/me')).body.orgs).toContainEqual(
      expect.objectContaining({ id: orgId, role: 'owner' }),
    );
    bobApp.close();
  });

  it('waits while a failed payment is still owed', async () => {
    await h.ctx.db
      .insert(invoices)
      .values({ userId: dana.id, amountCents: 500, usage: 4.76, status: 'failed' });
    const plan = (await api(dana, 'GET', '/api/me/deletion')).body.plan;
    expect(plan.blocker).toMatch(/payment .* failed/);
    expect((await api(dana, 'POST', '/api/me/delete', { confirm: true })).status).toBe(409);
    expect((await api(dana, 'GET', '/api/me')).status).toBe(200);

    await h.ctx.db.update(invoices).set({ status: 'paid' }).where(eq(invoices.userId, dana.id));
    expect((await api(dana, 'POST', '/api/me/delete', { confirm: true })).status).toBe(200);
    // Her personal org had nothing anyone else used: it went with her.
    expect((await api(dana, 'GET', '/api/me')).status).toBe(401);
  });
});
