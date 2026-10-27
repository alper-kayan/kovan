import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, oauthLogin, startHarness, type Harness } from './test/harness.js';

let h: Harness;
let receiver: Server;
let alice: string; // owns the organization
let bob: string; // editor of the shop workspace only
let eve: string; // outside
let orgId: string;
let shop: string;
let blog: string;
let orgKey: string;
let secret: string;
const got: { event: string; body: string; signature: string }[] = [];

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

async function until<T>(read: () => T | Promise<T>, ms = 3000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const workspace = async (name: string, repoUrl: string) =>
  (await api(alice, 'POST', '/api/workspaces', { orgId, name, repoUrl })).body.workspace
    .id as string;

beforeAll(async () => {
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      got.push({
        event: String(req.headers['x-kovan-event']),
        body,
        signature: String(req.headers['x-kovan-signature']),
      });
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  const port = (receiver.address() as AddressInfo).port;
  h = await startHarness({ KOVAN_WEBHOOK_ALLOW: `127.0.0.1:${port}` });
  const login = async (code: string, n: string) =>
    (await oauthLogin(h, 'github', code, { providerUserId: n, login: code, name: code })).token;
  alice = await login('alice', '1');
  bob = await login('bob', '2');
  eve = await login('eve', '3');
  orgId = (await api(alice, 'GET', '/api/me')).body.orgs[0].id;
  shop = await workspace('shop', 'github.com/acme/shop');
  blog = await workspace('blog', 'github.com/acme/blog');
  await api(alice, 'POST', `/api/workspaces/${shop}/invites`, {
    githubLogin: 'bob',
    role: 'editor',
  });
  // The receiver's address is known once it listens.
  (globalThis as { hookUrl?: string }).hookUrl = `http://127.0.0.1:${port}/kovan`;
});
afterAll(async () => {
  await h.close();
  receiver.close();
});

describe('organization integrations', () => {
  it('one key covers every workspace of the organization, later ones too', async () => {
    expect(
      (await api(bob, 'POST', `/api/orgs/${orgId}/api-keys`, { name: 'x', scopes: ['read'] }))
        .status,
    ).toBe(403);
    expect(
      (await api(eve, 'POST', `/api/orgs/${orgId}/api-keys`, { name: 'x', scopes: ['read'] }))
        .status,
    ).toBe(404);
    const made = await api(alice, 'POST', `/api/orgs/${orgId}/api-keys`, {
      name: 'FounderOS',
      scopes: ['read', 'dispatch', 'control'],
    });
    expect(made.status).toBe(200);
    orgKey = made.body.token;
    const names = async () =>
      ((await api(orgKey, 'GET', '/api/workspaces')).body.workspaces as { name: string }[])
        .map((w) => w.name)
        .sort();
    expect(await names()).toEqual(['blog', 'shop']);
    await workspace('docs', 'github.com/acme/docs');
    expect(await names()).toEqual(['blog', 'docs', 'shop']);
    expect((await api(orgKey, 'GET', '/api/keys/me')).body.key).toMatchObject({
      name: 'FounderOS',
      orgId,
      workspaceId: null,
    });
    expect((await api(alice, 'GET', '/api/keys/me')).status).toBe(404);
    // It starts work in any of them, found by the repository.
    const found = (
      await api(
        orgKey,
        'GET',
        `/api/workspaces?repo=${encodeURIComponent('git@github.com:acme/blog.git')}`,
      )
    ).body.workspaces;
    expect(found.map((w: { id: string }) => w.id)).toEqual([blog]);
    expect(
      (
        await api(orgKey, 'POST', `/api/workspaces/${blog}/sessions`, {
          title: 'Blog post',
          branch: 'kovan/post',
        })
      ).status,
    ).toBe(200);
    // Listed with the organization's keys, not a workspace's.
    expect((await api(alice, 'GET', `/api/workspaces/${shop}/api-keys`)).body.keys).toEqual([]);
    expect((await api(alice, 'GET', `/api/orgs/${orgId}/api-keys`)).body.keys).toHaveLength(1);
  });

  it('one webhook hears every workspace, signed', async () => {
    const url = (globalThis as { hookUrl?: string }).hookUrl!;
    const made = await api(alice, 'POST', `/api/orgs/${orgId}/webhooks`, {
      url,
      events: ['session.started'],
    });
    expect(made.status).toBe(200);
    secret = made.body.secret;
    got.length = 0;
    await api(orgKey, 'POST', `/api/workspaces/${shop}/sessions`, {
      title: 'Shop work',
      branch: 'kovan/s',
    });
    await api(orgKey, 'POST', `/api/workspaces/${blog}/sessions`, {
      title: 'Blog work',
      branch: 'kovan/b',
    });
    await until(() => got.length >= 2);
    const bodies = got.map(
      (g) => JSON.parse(g.body) as { workspaceId: string; data: { title: string } },
    );
    expect(bodies.map((b) => [b.workspaceId, b.data.title]).sort()).toEqual(
      [
        [blog, 'Blog work'],
        [shop, 'Shop work'],
      ].sort(),
    );
    for (const g of got)
      expect(g.signature).toBe(
        `sha256=${createHmac('sha256', secret).update(g.body).digest('hex')}`,
      );

    got.length = 0;
    const hookId = made.body.webhook.id;
    await api(alice, 'POST', `/api/orgs/${orgId}/webhooks/${hookId}/ping`);
    const ping = await until(() => got.find((g) => g.event === 'ping'));
    expect(JSON.parse(ping.body)).toMatchObject({ workspaceId: '', data: { orgId } });
    expect((await api(bob, 'GET', `/api/orgs/${orgId}/webhooks`)).status).toBe(403);
  });

  it('one stream carries every workspace the reader can see', async () => {
    const forKey = (await api(orgKey, 'GET', `/api/orgs/${orgId}/events?limit=500`)).body
      .events as { workspaceId: string }[];
    expect(new Set(forKey.map((e) => e.workspaceId))).toEqual(new Set([shop, blog]));
    // Bob is only in shop: he sees only its events.
    const forBob = (await api(bob, 'GET', `/api/orgs/${orgId}/events?limit=500`)).body.events as {
      workspaceId: string;
    }[];
    expect(forBob.length).toBeGreaterThan(0);
    expect(new Set(forBob.map((e) => e.workspaceId))).toEqual(new Set([shop]));
    expect((await api(eve, 'GET', `/api/orgs/${orgId}/events`)).status).toBe(404);
  });

  it('a machine of the organization takes work of every workspace whose repository it holds', async () => {
    const machineKey = (
      await api(alice, 'POST', `/api/orgs/${orgId}/api-keys`, { name: 'pi', scopes: ['machine'] })
    ).body.token as string;
    const shopKey = (
      await api(alice, 'POST', `/api/workspaces/${shop}/api-keys`, {
        name: 'shop-box',
        scopes: ['machine'],
      })
    ).body.token as string;
    const body = {
      name: 'pi',
      platform: 'linux-arm64',
      slots: 2,
      repos: [
        { remote: 'git@github.com:acme/shop.git', path: '/w/shop' },
        { remote: 'git@github.com:acme/blog.git', path: '/w/blog' },
      ],
    };
    // A workspace's machine key can't register for the organization.
    expect((await api(shopKey, 'POST', `/api/orgs/${orgId}/machines`, body)).status).toBe(403);
    const reg = await api(machineKey, 'POST', `/api/orgs/${orgId}/machines`, body);
    expect(reg.status).toBe(200);
    expect(reg.body.machine).toMatchObject({ name: 'pi', scope: 'organization', online: true });

    for (const ws of [shop, blog]) {
      const listed = (await api(orgKey, 'GET', `/api/workspaces/${ws}/machines`)).body.machines;
      expect(listed.map((m: { name: string }) => m.name)).toEqual(['pi']);
    }
    for (const [ws, title] of [
      [shop, 'Shop on pi'],
      [blog, 'Blog on pi'],
    ] as const) {
      const s = await api(orgKey, 'POST', `/api/workspaces/${ws}/sessions`, {
        title,
        branch: 'kovan/pi',
        machine: 'auto',
      });
      expect(s.body.session.machine?.name, title).toBe('pi');
    }
    // Docs is in the organization, but pi doesn't hold its repository.
    const docs = (
      (await api(orgKey, 'GET', '/api/workspaces')).body.workspaces as {
        id: string;
        name: string;
      }[]
    ).find((w) => w.name === 'docs')!;
    expect(
      (
        await api(orgKey, 'POST', `/api/workspaces/${docs.id}/sessions`, {
          title: 'Docs',
          branch: 'kovan/d',
          machine: 'auto',
        })
      ).status,
    ).toBe(409);
    expect((await api(alice, 'GET', `/api/orgs/${orgId}/machines`)).body.machines).toHaveLength(1);

    // Revoking the organization's machine key: it leaves every workspace, its machine goes.
    const keys = (await api(alice, 'GET', `/api/orgs/${orgId}/api-keys`)).body.keys as {
      id: string;
      name: string;
    }[];
    await api(
      alice,
      'DELETE',
      `/api/orgs/${orgId}/api-keys/${keys.find((k) => k.name === 'pi')!.id}`,
    );
    expect((await api(machineKey, 'GET', '/api/workspaces')).status).toBe(401);
    expect((await api(alice, 'GET', `/api/orgs/${orgId}/machines`)).body.machines).toEqual([]);
    // The other keys keep working.
    expect((await api(orgKey, 'GET', '/api/workspaces')).status).toBe(200);
  });
});
