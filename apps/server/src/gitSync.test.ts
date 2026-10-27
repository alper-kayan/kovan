import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, connect, oauthLogin, startHarness, type Harness } from './test/harness.js';

let h: Harness;
type Person = { token: string; id: string };
let ana: Person; // owner
let bora: Person; // editor
let cem: Person; // commenter
let wsId: string;

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
  const ws = (await api(ana, 'POST', '/api/workspaces', { orgId, name: 'Shop', repoUrl: null }))
    .body.workspace;
  wsId = ws.id;
  expect(ws).toMatchObject({ autoGitSync: true, gitSyncChangedBy: null });
  for (const [login, role] of [
    ['bora', 'editor'],
    ['cem', 'commenter'],
  ])
    expect(
      (await api(ana, 'POST', `/api/workspaces/${wsId}/invites`, { githubLogin: login, role }))
        .status,
    ).toBe(201);
});

afterAll(() => h.close());

describe("a workspace's automatic Git sync", () => {
  it('is one switch anyone working in it flips, and everyone sees who did', async () => {
    const watcher = await connect(h, ana.token);
    await watcher.waitFor((m) => m.type === 'welcome');
    const off = await api(bora, 'PUT', `/api/workspaces/${wsId}/git-sync`, { on: false });
    expect(off.status).toBe(200);
    expect(off.body.workspace).toMatchObject({ autoGitSync: false, gitSyncChangedBy: 'Bora' });
    expect(Date.parse(off.body.workspace.gitSyncChangedAt)).toBeGreaterThan(Date.now() - 60_000);
    const told = await watcher.waitFor(
      (m) =>
        m.type === 'workspace' &&
        (m.workspace as { autoGitSync?: boolean } | undefined)?.autoGitSync === false,
    );
    expect(told.workspace).toMatchObject({ gitSyncChangedBy: 'Bora', role: 'owner' });
    watcher.socket.close();

    // Commenters don't run agents in it: theirs isn't the call.
    expect((await api(cem, 'PUT', `/api/workspaces/${wsId}/git-sync`, { on: true })).status).toBe(
      403,
    );
    // The owner's settings page changes it too, and says so the same way.
    const on = await api(ana, 'PATCH', `/api/workspaces/${wsId}`, { autoGitSync: true });
    expect(on.body.workspace).toMatchObject({ autoGitSync: true, gitSyncChangedBy: 'Ana' });
  });

  it('leaves the name, color and base branch to the owner', async () => {
    const patch = { name: 'Shop app', color: '#e5484d', defaultBranch: 'develop' };
    expect((await api(bora, 'PATCH', `/api/workspaces/${wsId}`, patch)).status).toBe(403);
    const done = await api(ana, 'PATCH', `/api/workspaces/${wsId}`, patch);
    expect(done.body.workspace).toMatchObject(patch);
    expect((await api(ana, 'PATCH', `/api/workspaces/${wsId}`, { color: 'red' })).status).toBe(400);
  });
});
