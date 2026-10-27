import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// The real server on a throwaway database (needs the local Postgres, like the server's tests).
import {
  auth,
  oauthLogin,
  startHarness,
  type Harness,
} from '../../../apps/server/src/test/harness.js';
import { Brain } from './brain.js';
import { Daemon } from './daemon.js';

const sh = promisify(execFile);

let h: Harness;
let dir: string;
let repo: string;
let alice: string;
let founder: string;
let machineKey: string;
let workspaceId: string;
let daemon: Daemon;
let brain: Brain;
const logs: string[] = [];

async function api(token: string, method: string, url: string, payload?: object) {
  const res = await h.app.inject({
    method: method as 'GET',
    url,
    headers: auth(token),
    ...(payload ? { payload } : {}),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON in tests
  return { status: res.statusCode, body: res.json() as Record<string, any> };
}

async function until<T>(read: () => Promise<T>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A session with a one-agent swarm, sent to a machine and launched by FounderOS. */
async function sendSwarm(title: string, branch: string | null) {
  const s = (
    await api(founder, 'POST', `/api/workspaces/${workspaceId}/sessions`, {
      title,
      branch,
      machine: 'auto',
    })
  ).body.session;
  const agent = (
    await api(alice, 'POST', `/api/workspaces/${workspaceId}/agents`, {
      name: `Wren ${title.slice(0, 8)}`,
      model: 'openai/gpt-oss-20b',
      instructions: 'Small tested changes.',
    })
  ).body.agent;
  const swarm = (
    await api(founder, 'PUT', `/api/sessions/${s.id}/swarm`, {
      goal: 'Add a total helper',
      leadAgentId: agent.id,
      agentIds: [agent.id],
      budget: 0.05,
    })
  ).body.swarm;
  const launched = await api(founder, 'POST', `/api/swarms/${swarm.id}/launch`, {});
  expect(launched.status).toBe(200);
  return { session: s, swarm };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentd-daemon-'));
  repo = join(dir, 'shop');
  await sh('git', ['init', '-q', '-b', 'main', repo]);
  await sh('git', ['-C', repo, 'config', 'user.email', 'test@kovan.dev']);
  await sh('git', ['-C', repo, 'config', 'user.name', 'Test']);
  await writeFile(join(repo, 'README.md'), '# shop\n');
  await sh('git', ['-C', repo, 'add', '.']);
  await sh('git', ['-C', repo, 'commit', '-q', '-m', 'start']);
  await sh('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:acme/shop.git']);

  h = await startHarness();
  alice = (await oauthLogin(h, 'github', 'alice', { providerUserId: '1', login: 'alice' })).token;
  const orgId = (await api(alice, 'GET', '/api/me')).body.orgs[0].id;
  workspaceId = (
    await api(alice, 'POST', '/api/workspaces', {
      orgId,
      name: 'shop',
      repoUrl: 'https://github.com/acme/shop',
    })
  ).body.workspace.id;
  const key = async (name: string, scopes: string[]) =>
    (await api(alice, 'POST', `/api/workspaces/${workspaceId}/api-keys`, { name, scopes })).body
      .token as string;
  machineKey = await key('box', ['machine']);
  founder = await key('FounderOS', ['read', 'dispatch']);

  brain = new Brain(
    h.baseUrl,
    machineKey,
    'box',
    (m) => daemon.onMessage(m),
    (l) => logs.push(l),
  );
  daemon = new Daemon(
    {
      name: 'box',
      platform: 'linux-x64',
      slots: 2,
      agents: [{ name: 'kovan', version: null, ready: true }],
      repos: [{ remote: 'git@github.com:acme/shop.git', path: repo }],
      dataDir: join(dir, 'state'),
      scope: { workspaceId },
      pushWhenDone: false,
    },
    {
      request: (m, path, body) => brain.request(m, path, body),
      follow: (id) => brain.follow(id),
      laneEvent: (s, e, t, a) => brain.laneEvent(s, e, t, a),
      run: () => Promise.reject(new Error('no model in this test')),
      log: (l) => logs.push(l),
      heartbeatMs: 60_000,
    },
  );
});
afterAll(async () => {
  brain?.close();
  await h?.close();
  await rm(dir, { recursive: true, force: true });
});

describe('agentd', () => {
  it('registers and comes online with what it holds', async () => {
    brain.connect();
    await daemon.start();
    const machines = (await api(founder, 'GET', `/api/workspaces/${workspaceId}/machines`)).body
      .machines;
    expect(machines).toEqual([
      expect.objectContaining({
        name: 'box',
        online: true,
        slots: 2,
        repos: [{ remote: 'github.com/acme/shop', path: repo }],
      }),
    ]);
  });

  it('takes a swarm sent to it: a session worktree on its branch, reported, then run', async () => {
    const take = vi.spyOn(daemon.swarms, 'take').mockImplementation(async (swarm) => swarm);
    const { session, swarm } = await sendSwarm('Cart total', 'kovan/cart-total');
    // The live connection hears of it right away; no need to wait for the next report.
    await until(async () => take.mock.calls.length > 0);
    const [taken, root, resumed] = take.mock.calls[0]!;
    expect(taken.id).toBe(swarm.id);
    expect(resumed).toBe(false);
    expect(await stat(join(root, 'README.md')).then(() => true)).toBe(true);
    const branch = (await sh('git', ['-C', root, 'branch', '--show-current'])).stdout.trim();
    expect(branch).toBe('kovan/cart-total');
    const view = (await api(founder, 'GET', `/api/sessions/${session.id}`)).body.session;
    expect(view).toMatchObject({ machine: { name: 'box' }, worktreePath: root });
    // Reporting again doesn't start it twice.
    await daemon.report();
    expect(take).toHaveBeenCalledTimes(1);
    take.mockRestore();

    // When it finishes, the work is committed on the session branch.
    await writeFile(join(root, 'cart.js'), 'export const total = () => 0;\n');
    const sha = await daemon.finish(root, 'kovan/cart-total', 'Cart total: Add a total helper');
    const log = (await sh('git', ['-C', root, 'log', '-1', '--format=%H %an %s'])).stdout.trim();
    expect(log).toBe(`${sha} Kovan agentd (box) Cart total: Add a total helper`);
    expect((await sh('git', ['-C', root, 'status', '--porcelain'])).stdout).toBe('');
  });

  it("pauses work it can't do, with why", async () => {
    const { swarm } = await sendSwarm('No branch', null);
    const paused = await until(async () => {
      const s = (await api(founder, 'GET', `/api/sessions/${swarm.sessionId}/swarm`)).body.swarm;
      return s.status === 'paused' ? s : null;
    });
    expect(paused.pausedReason).toMatch(/no branch/);
  });

  it('pauses what it runs when it stops', async () => {
    const running = (await api(founder, 'GET', `/api/workspaces/${workspaceId}/sessions`)).body
      .sessions as { id: string; title: string }[];
    const cart = running.find((s) => s.title === 'Cart total')!;
    await daemon.stop('agentd was stopped');
    const s = (await api(founder, 'GET', `/api/sessions/${cart.id}/swarm`)).body.swarm;
    expect(s).toMatchObject({ status: 'paused', pausedReason: 'box: agentd was stopped' });
  });

  it('serves every workspace of the organization whose repository it holds', async () => {
    // A second workspace, with its own repository on this machine.
    const blogRepo = join(dir, 'blog');
    await sh('git', ['init', '-q', '-b', 'main', blogRepo]);
    await sh('git', ['-C', blogRepo, 'config', 'user.email', 'test@kovan.dev']);
    await sh('git', ['-C', blogRepo, 'config', 'user.name', 'Test']);
    await writeFile(join(blogRepo, 'README.md'), '# blog\n');
    await sh('git', ['-C', blogRepo, 'add', '.']);
    await sh('git', ['-C', blogRepo, 'commit', '-q', '-m', 'start']);
    await sh('git', [
      '-C',
      blogRepo,
      'remote',
      'add',
      'origin',
      'https://github.com/acme/blog.git',
    ]);
    const orgId = (await api(alice, 'GET', '/api/me')).body.orgs[0].id as string;
    const blogId = (
      await api(alice, 'POST', '/api/workspaces', {
        orgId,
        name: 'blog',
        repoUrl: 'github.com/acme/blog',
      })
    ).body.workspace.id as string;
    const orgMachineKey = (
      await api(alice, 'POST', `/api/orgs/${orgId}/api-keys`, {
        name: 'tower',
        scopes: ['machine'],
      })
    ).body.token as string;
    const orgFounder = (
      await api(alice, 'POST', `/api/orgs/${orgId}/api-keys`, {
        name: 'FounderOS org',
        scopes: ['read', 'dispatch', 'control'],
      })
    ).body.token as string;

    const towerBrain = new Brain(
      h.baseUrl,
      orgMachineKey,
      'tower',
      (m) => tower.onMessage(m),
      () => {},
    );
    const tower: Daemon = new Daemon(
      {
        name: 'tower',
        platform: 'linux-x64',
        slots: 2,
        agents: [{ name: 'kovan', version: null, ready: true }],
        repos: [{ remote: 'https://github.com/acme/blog.git', path: blogRepo }],
        dataDir: join(dir, 'tower'),
        scope: { orgId },
        pushWhenDone: false,
      },
      {
        request: (m, path, body) => towerBrain.request(m, path, body),
        follow: (id) => towerBrain.follow(id),
        laneEvent: (s, e, t, a) => towerBrain.laneEvent(s, e, t, a),
        run: () => Promise.reject(new Error('no model in this test')),
        log: () => {},
        heartbeatMs: 60_000,
      },
    );
    towerBrain.connect();
    await tower.start();
    const listed = (await api(orgFounder, 'GET', `/api/workspaces/${blogId}/machines`)).body
      .machines;
    expect(listed).toEqual([
      expect.objectContaining({ name: 'tower', scope: 'organization', online: true }),
    ]);

    const take = vi.spyOn(tower.swarms, 'take').mockImplementation(async (swarm) => swarm);
    const s = (
      await api(orgFounder, 'POST', `/api/workspaces/${blogId}/sessions`, {
        title: 'Post',
        branch: 'kovan/post',
        machine: 'auto',
      })
    ).body.session;
    expect(s.machine.name).toBe('tower');
    const agent = (
      await api(alice, 'POST', `/api/workspaces/${blogId}/agents`, {
        name: 'Quill',
        model: 'openai/gpt-oss-20b',
        instructions: 'Writes posts.',
      })
    ).body.agent;
    const swarm = (
      await api(orgFounder, 'PUT', `/api/sessions/${s.id}/swarm`, {
        goal: 'Write a post',
        leadAgentId: agent.id,
        agentIds: [agent.id],
        budget: 0.05,
      })
    ).body.swarm;
    await api(orgFounder, 'POST', `/api/swarms/${swarm.id}/launch`, {});
    await until(async () => take.mock.calls.length > 0);
    const root = take.mock.calls[0]![1];
    expect((await sh('git', ['-C', root, 'branch', '--show-current'])).stdout.trim()).toBe(
      'kovan/post',
    );
    await tower.stop('test over');
    towerBrain.close();
  });
});
