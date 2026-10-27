import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq, lte } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { webhookDeliveries, workspaceEvents } from './db/schema.js';
import { isPrivateAddress, targetProblem } from './events/deliver.js';
import { RETRY_DELAYS_S } from './events/service.js';
import { auth, oauthLogin, startHarness, type Harness } from './test/harness.js';

let h: Harness;
let receiver: Server;
let port: number;
let alice: string; // owner
let bob: string; // viewer
let workspaceId: string;

type Got = { headers: IncomingMessage['headers']; body: string };
const got: Got[] = [];
/** What the receiver answers next; the default is 200. */
let answer: { code: number; location?: string } = { code: 200 };

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

const sign = (secret: string, body: string) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

beforeAll(async () => {
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      got.push({ headers: req.headers, body });
      res.writeHead(answer.code, answer.location ? { location: answer.location } : {});
      res.end('ok');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  port = (receiver.address() as AddressInfo).port;
  h = await startHarness({ KOVAN_WEBHOOK_ALLOW: `127.0.0.1:${port}` });
  const login = async (code: string, n: string) =>
    (await oauthLogin(h, 'github', code, { providerUserId: n, login: code, name: code })).token;
  alice = await login('alice', '1');
  bob = await login('bob', '2');
  const orgId = (await api(alice, 'GET', '/api/me')).body.orgs[0].id;
  workspaceId = (
    await api(alice, 'POST', '/api/workspaces', {
      orgId,
      name: 'shop',
      repoUrl: 'github.com/acme/shop',
    })
  ).body.workspace.id;
  await api(alice, 'POST', `/api/workspaces/${workspaceId}/invites`, {
    githubLogin: 'bob',
    role: 'viewer',
  });
});
afterAll(async () => {
  await h.close();
  receiver.close();
});

describe('webhook addresses', () => {
  it('allow public https, and private or plain http only when listed exactly', () => {
    const allow = ['127.0.0.1:4100', 'founderos:4100'];
    expect(targetProblem('https://hooks.example.com/kovan', [])).toBeNull();
    expect(targetProblem('http://hooks.example.com/kovan', [])).toMatch(/https/);
    for (const url of [
      'https://localhost/x',
      'https://10.1.2.3/x',
      'https://169.254.169.254/latest/meta-data',
      'https://192.168.1.10/x',
      'https://[::1]/x',
      'https://[fd00::1]/x',
      'https://metadata.google.internal/x',
    ])
      expect(targetProblem(url, []), url).toMatch(/private/);
    expect(targetProblem('http://127.0.0.1:4100/hook', allow)).toBeNull();
    expect(targetProblem('http://founderos:4100/hook', allow)).toBeNull();
    // The port is part of the entry: the next port is not allowed.
    expect(targetProblem('http://127.0.0.1:4101/hook', allow)).toMatch(/https/);
    expect(targetProblem('https://user:pw@hooks.example.com/', [])).toMatch(/user name/);
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('100.100.1.1')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('2606:4700::1111')).toBe(false);
  });
});

describe('webhooks', () => {
  let secret: string;
  let hookId: string;

  it('are added by owners, with a secret shown once', async () => {
    const url = `http://127.0.0.1:${port}/kovan`;
    expect(
      (await api(bob, 'POST', `/api/workspaces/${workspaceId}/webhooks`, { url })).status,
    ).toBe(403);
    for (const bad of ['http://hooks.example.com/x', 'https://10.0.0.5/x', 'not a url'])
      expect(
        (await api(alice, 'POST', `/api/workspaces/${workspaceId}/webhooks`, { url: bad })).status,
        bad,
      ).toBe(400);
    const made = await api(alice, 'POST', `/api/workspaces/${workspaceId}/webhooks`, {
      url,
      events: ['session.started', 'session.finished', 'pr.opened'],
    });
    expect(made.status).toBe(200);
    expect(made.body.secret).toMatch(/^whsec_/);
    expect(made.body.webhook).toMatchObject({ url, last: null, createdByName: 'alice' });
    secret = made.body.secret;
    hookId = made.body.webhook.id;
    const list = await api(alice, 'GET', `/api/workspaces/${workspaceId}/webhooks`);
    expect(JSON.stringify(list.body)).not.toContain(secret);
  });

  it('post signed events with the session’s branch and issue, and skip unwanted types', async () => {
    got.length = 0;
    const s = (
      await api(alice, 'POST', `/api/workspaces/${workspaceId}/sessions`, {
        title: 'Cart total',
        branch: 'kovan/cart',
        issue: { number: 12 },
      })
    ).body.session;
    const first = await until(() => got[0]);
    expect(first.headers['x-kovan-event']).toBe('session.started');
    expect(first.headers['x-kovan-signature']).toBe(sign(secret, first.body));
    expect(first.headers['content-type']).toBe('application/json');
    const event = JSON.parse(first.body);
    expect(event).toMatchObject({
      type: 'session.started',
      workspaceId,
      data: {
        sessionId: s.id,
        title: 'Cart total',
        branch: 'kovan/cart',
        machineId: null,
        prUrl: null,
        issue: { number: 12, url: 'https://github.com/acme/shop/issues/12' },
        startedBy: 'alice',
      },
    });
    expect(event.id).toMatch(/^\d+$/);

    // pr.opened is wanted, a swarm change isn't.
    await api(alice, 'POST', `/api/sessions/${s.id}/pr`, {
      url: 'https://github.com/acme/shop/pull/30',
      number: 30,
      state: 'open',
    });
    const pr = await until(() => got.find((g) => g.headers['x-kovan-event'] === 'pr.opened'));
    expect(JSON.parse(pr.body).data).toMatchObject({
      prUrl: 'https://github.com/acme/shop/pull/30',
      prState: 'open',
      number: 30,
      issue: { number: 12 },
    });
    await api(alice, 'POST', `/api/sessions/${s.id}/end`, {});
    await until(() => got.find((g) => g.headers['x-kovan-event'] === 'session.finished'));
    expect(got.map((g) => g.headers['x-kovan-event'])).toEqual([
      'session.started',
      'pr.opened',
      'session.finished',
    ]);

    const deliveries = (
      await api(alice, 'GET', `/api/workspaces/${workspaceId}/webhooks/${hookId}/deliveries`)
    ).body.deliveries;
    expect(deliveries).toHaveLength(3);
    expect(deliveries[0]).toMatchObject({ status: 'delivered', attempts: 1, lastCode: 200 });
    const listed = (await api(alice, 'GET', `/api/workspaces/${workspaceId}/webhooks`)).body
      .webhooks[0];
    expect(listed.last).toMatchObject({ status: 'delivered', code: 200 });
  });

  it('retry with growing waits, then give up; redirects count as failures', async () => {
    got.length = 0;
    answer = { code: 500 };
    await api(alice, 'POST', `/api/workspaces/${workspaceId}/sessions`, {
      title: 'Flaky',
      branch: 'kovan/flaky',
    });
    await until(() => got[0]);
    const [failed] = await until(async () => {
      const rows = await h.ctx.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.webhookId, hookId));
      const row = rows.find((r) => r.attempts === 1 && r.lastCode === 500);
      return row ? [row] : null;
    });
    expect(failed).toMatchObject({ status: 'pending', lastError: 'It answered 500.' });
    const wait = failed.nextAttemptAt!.getTime() - Date.now();
    expect(wait).toBeGreaterThan((RETRY_DELAYS_S[0]! - 2) * 1000);
    expect(wait).toBeLessThan((RETRY_DELAYS_S[0]! + 2) * 1000);

    // A redirect isn't followed.
    answer = { code: 302, location: 'http://169.254.169.254/' };
    const due = async () =>
      h.ctx.db
        .update(webhookDeliveries)
        .set({ nextAttemptAt: new Date(Date.now() - 1000) })
        .where(eq(webhookDeliveries.id, failed.id));
    await due();
    await h.ctx.events.round();
    const [redirected] = await h.ctx.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, failed.id));
    expect(redirected).toMatchObject({ attempts: 2, lastCode: 302, status: 'pending' });
    expect(redirected!.lastError).toMatch(/redirect/);

    // It recovers: the same body, still signed, arrives.
    answer = { code: 204 };
    got.length = 0;
    await due();
    await h.ctx.events.round();
    expect(got).toHaveLength(1);
    expect(got[0]!.headers['x-kovan-signature']).toBe(sign(secret, got[0]!.body));
    expect(JSON.parse(got[0]!.body).data.title).toBe('Flaky');

    // Out of attempts: failed, and nothing more is sent.
    answer = { code: 503 };
    await h.ctx.db
      .update(webhookDeliveries)
      .set({ status: 'pending', attempts: RETRY_DELAYS_S.length, nextAttemptAt: new Date(0) })
      .where(eq(webhookDeliveries.id, failed.id));
    await h.ctx.events.round();
    const [gaveUp] = await h.ctx.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, failed.id));
    expect(gaveUp).toMatchObject({
      status: 'failed',
      attempts: RETRY_DELAYS_S.length + 1,
      nextAttemptAt: null,
    });
    answer = { code: 200 };
  });

  it('can be pinged to check the address and secret, and removed', async () => {
    got.length = 0;
    const ping = await api(alice, 'POST', `/api/workspaces/${workspaceId}/webhooks/${hookId}/ping`);
    expect(ping.status).toBe(200);
    const sent = await until(() => got[0]);
    expect(sent.headers['x-kovan-event']).toBe('ping');
    expect(sent.headers['x-kovan-delivery']).toBe(ping.body.deliveryId);
    expect(sent.headers['x-kovan-signature']).toBe(sign(secret, sent.body));
    expect(JSON.parse(sent.body)).toMatchObject({ type: 'ping', data: { sentBy: 'alice' } });

    expect(
      (await api(alice, 'DELETE', `/api/workspaces/${workspaceId}/webhooks/${hookId}`)).status,
    ).toBe(200);
    got.length = 0;
    await api(alice, 'POST', `/api/workspaces/${workspaceId}/sessions`, {
      title: 'After',
      branch: null,
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(got).toHaveLength(0);
  });
});

describe('the event stream', () => {
  it('continues after a cursor, waits for the next event, and works with a read key', async () => {
    const all = (await api(bob, 'GET', `/api/workspaces/${workspaceId}/events?limit=500`)).body;
    expect(all.events.length).toBeGreaterThan(3);
    const types = all.events.map((e: { type: string }) => e.type);
    expect(types).toContain('session.started');
    expect(types).toContain('pr.opened');
    expect(types).toContain('session.finished');
    const ids = all.events.map((e: { id: string }) => Number(e.id));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));

    const cursor = all.next as string;
    const empty = await api(bob, 'GET', `/api/workspaces/${workspaceId}/events?since=${cursor}`);
    expect(empty.body).toEqual({ events: [], next: cursor, missed: false });

    // A read-only key follows the stream without a browser sign-in; it waits instead of polling.
    const key = (
      await api(alice, 'POST', `/api/workspaces/${workspaceId}/api-keys`, {
        name: 'FounderOS',
        scopes: ['read'],
      })
    ).body.token as string;
    const started = Date.now();
    const waiting = api(
      key,
      'GET',
      `/api/workspaces/${workspaceId}/events?since=${cursor}&wait=10`,
    );
    setTimeout(
      () =>
        void api(alice, 'POST', `/api/workspaces/${workspaceId}/sessions`, {
          title: 'Live',
          branch: 'kovan/live',
        }),
      300,
    );
    const next = (await waiting).body;
    expect(Date.now() - started).toBeLessThan(3000);
    expect(next.events.map((e: { type: string; data: { title: string } }) => e.data.title)).toEqual(
      ['Live'],
    );
    expect(Number(next.next)).toBeGreaterThan(Number(cursor));

    // Two weeks on, old events are swept: a cursor from before them is told it missed some.
    await h.ctx.db.delete(workspaceEvents).where(lte(workspaceEvents.id, Number(all.events[1].id)));
    const late = await api(bob, 'GET', `/api/workspaces/${workspaceId}/events?since=0`);
    expect(late.body.missed).toBe(true);
    expect(late.body.events[0].id).toBe(all.events[2].id);
    const fresh = await api(bob, 'GET', `/api/workspaces/${workspaceId}/events?since=${cursor}`);
    expect(fresh.body.missed).toBe(false);

    // Not a member: the workspace doesn't exist for them.
    const eve = (await oauthLogin(h, 'github', 'eve', { providerUserId: '9', login: 'eve' })).token;
    expect((await api(eve, 'GET', `/api/workspaces/${workspaceId}/events`)).status).toBe(404);
  });

  it('carries approvals, failed turns and swarm changes', async () => {
    const s = (
      await api(alice, 'POST', `/api/workspaces/${workspaceId}/sessions`, {
        title: 'Lane',
        branch: 'kovan/lane',
      })
    ).body.session;
    const since = (await api(alice, 'GET', `/api/workspaces/${workspaceId}/events?limit=1`)).body
      .next;
    await api(alice, 'POST', `/api/sessions/${s.id}/join`, { mode: 'join' });
    const me = (await api(alice, 'GET', '/api/me')).body.user.id as string;
    await h.ctx.sessions.laneEvents(
      s.id,
      me,
      [
        { type: 'turn_start', turnId: 't1', model: 'm' },
        {
          type: 'approval',
          request: {
            id: 'r1',
            tool: 'run_shell',
            kind: 'command',
            title: 'Run this?',
            detail: 'rm -rf x',
          },
        },
        {
          type: 'turn_end',
          turnId: 't1',
          reason: 'error',
          error: 'failed with token=sk-or-v1-abcdefabcdefabcdef',
        },
      ],
      [],
    );
    const lead = (
      await api(alice, 'POST', `/api/workspaces/${workspaceId}/agents`, {
        name: 'Wren',
        model: 'openai/gpt-5.6-luna',
        instructions: 'Small tested changes.',
      })
    ).body.agent;
    const swarm = (
      await api(alice, 'PUT', `/api/sessions/${s.id}/swarm`, {
        goal: 'x',
        leadAgentId: lead.id,
        agentIds: [lead.id],
        budget: 1,
      })
    ).body.swarm;
    await api(alice, 'POST', `/api/swarms/${swarm.id}/launch`);
    await api(alice, 'POST', `/api/swarms/${swarm.id}/status`, {
      status: 'paused',
      reason: 'lunch',
    });

    const events = await until(async () => {
      const list = (await api(alice, 'GET', `/api/workspaces/${workspaceId}/events?since=${since}`))
        .body.events as { type: string; data: Record<string, unknown> }[];
      return list.length >= 4 ? list : null;
    });
    const of = (t: string) => events.filter((e) => e.type === t).map((e) => e.data);
    expect(of('approval.requested')).toEqual([
      expect.objectContaining({
        sessionId: s.id,
        tool: 'run_shell',
        title: 'Run this?',
        lane: 'alice',
      }),
    ]);
    // The command itself stays out of events.
    expect(JSON.stringify(events)).not.toContain('rm -rf');
    const failed = of('session.failed')[0]!;
    expect(failed).toMatchObject({ reason: 'error', branch: 'kovan/lane' });
    expect(String(failed['error'])).not.toContain('abcdefabcdef');
    expect(
      of('swarm.status_changed').map((d) => [d['status'], d['previous'], d['reason']]),
    ).toEqual([
      ['running', 'draft', null],
      ['paused', 'running', 'lunch'],
    ]);
  });
});
