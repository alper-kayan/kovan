/* eslint-disable @typescript-eslint/no-explicit-any -- loose JSON in tests */
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import {
  createServer as createHttp2Server,
  type Http2Server,
  type ServerHttp2Stream,
} from 'node:http2';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auth, connect, oauthLogin, startHarness, type Harness } from './test/harness.js';

type Person = { token: string; id: string };
type ApnsCall = { host: string; path: string; headers: Record<string, string>; body: any };
type FcmCall = { auth: string; body: any };

let h: Harness;
let alice: Person;
let bob: Person;
let workspaceId: string;
const apnsCalls: ApnsCall[] = [];
const fcmCalls: FcmCall[] = [];
let apnsServers: Http2Server[] = [];
let fcmServer: Server;
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

/** Apple's push service, as far as the server can tell: HTTP/2, a reason on failure. */
function fakeApns(name: string): Promise<{ server: Http2Server; url: string }> {
  const server = createHttp2Server();
  server.on('stream', (stream: ServerHttp2Stream, headers) => {
    let body = '';
    stream.on('data', (c: Buffer) => (body += c.toString()));
    stream.on('end', () => {
      const path = String(headers[':path']);
      apnsCalls.push({
        host: name,
        path,
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)])),
        body: JSON.parse(body),
      });
      const gone = path.endsWith('/gone-token-ios');
      stream.respond({ ':status': gone ? 410 : 200 });
      stream.end(gone ? JSON.stringify({ reason: 'Unregistered' }) : '');
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }),
    ),
  );
}

async function api(person: Person, method: string, url: string, payload?: object) {
  const res = await h.app.inject({
    method: method as 'GET',
    url,
    headers: auth(person.token),
    ...(payload ? { payload } : {}),
  });
  return { status: res.statusCode, body: res.json() as any };
}

const until = async (check: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('Timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kovan-push-'));
  writeFileSync(join(dir, 'apns.p8'), ec.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  fcmServer = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      if (req.url === '/token') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ access_token: 'ya29.fake', expires_in: 3600 }));
        return;
      }
      const parsed = JSON.parse(body);
      fcmCalls.push({ auth: String(req.headers.authorization), body: parsed });
      const gone = parsed.message.token === 'gone-token-android';
      res.statusCode = gone ? 404 : 200;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify(
          gone
            ? { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }
            : { name: 'projects/p/messages/1' },
        ),
      );
    });
  });
  await new Promise<void>((r) => fcmServer.listen(0, '127.0.0.1', r));
  const fcmUrl = `http://127.0.0.1:${(fcmServer.address() as AddressInfo).port}`;
  writeFileSync(
    join(dir, 'fcm.json'),
    JSON.stringify({
      type: 'service_account',
      project_id: 'kovan-test',
      client_email: 'push@kovan-test.iam.gserviceaccount.com',
      private_key: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      token_uri: `${fcmUrl}/token`,
    }),
  );
  const production = await fakeApns('production');
  const sandbox = await fakeApns('sandbox');
  apnsServers = [production.server, sandbox.server];
  h = await startHarness({
    APNS_KEY_FILE: join(dir, 'apns.p8'),
    APNS_KEY_ID: 'KEYID12345',
    APNS_TEAM_ID: 'TEAM123456',
    APNS_PRODUCTION_HOST: production.url,
    APNS_SANDBOX_HOST: sandbox.url,
    FCM_KEY_FILE: join(dir, 'fcm.json'),
    FCM_API: fcmUrl,
  });
  const login = async (code: string, n: string) => {
    const r = await oauthLogin(h, 'github', code, { providerUserId: n, login: code, name: code });
    return { token: r.token, id: r.user.id };
  };
  alice = await login('alice', '1');
  bob = await login('bob', '2');
  const orgId = (await api(alice, 'GET', '/api/me')).body.orgs[0].id;
  workspaceId = (
    await api(alice, 'POST', '/api/workspaces', { orgId, name: 'lobby', repoUrl: null })
  ).body.workspace.id;
  await api(alice, 'POST', `/api/workspaces/${workspaceId}/invites`, {
    githubLogin: 'bob',
    role: 'editor',
  });
});
afterAll(async () => {
  await h.close();
  for (const s of apnsServers) s.close();
  fcmServer.close();
});
beforeEach(() => {
  apnsCalls.length = 0;
  fcmCalls.length = 0;
});

async function newSession(title: string) {
  const s = (
    await api(alice, 'POST', `/api/workspaces/${workspaceId}/sessions`, { title, branch: null })
  ).body.session as { id: string };
  await api(alice, 'POST', `/api/sessions/${s.id}/join`, { mode: 'join' });
  return s.id;
}

/** Alice's desktop, with its window in the background (she is away). */
async function awayDesktop() {
  const desk = await connect(h, alice.token);
  await desk.waitFor((m) => m.type === 'welcome');
  desk.send({ type: 'presence', status: 'idle', workspaceId: null });
  return desk;
}

describe('push notifications', () => {
  it('registers a phone for this sign-in and lets it turn kinds off', async () => {
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: '/api/push/devices',
          payload: { platform: 'ios', token: 'x'.repeat(64) },
        })
      ).statusCode,
    ).toBe(401);
    const r = await api(alice, 'POST', '/api/push/devices', {
      platform: 'ios',
      token: 'ios-token-alice',
      sandbox: true,
      appVersion: '0.1.0',
    });
    expect(r.status).toBe(200);
    // Team questions start off; everything else is on.
    expect(r.body).toMatchObject({ device: { platform: 'ios', muted: ['team'] }, enabled: true });
    await api(alice, 'POST', '/api/push/devices', {
      platform: 'android',
      token: 'android-token-alice',
    });
    const muted = await api(alice, 'PATCH', '/api/push/devices', {
      token: 'android-token-alice',
      muted: ['finished'],
    });
    expect(muted.body.device.muted).toEqual(['finished']);
    // Someone else can't change another person's phone.
    expect(
      (
        await api(bob, 'PATCH', '/api/push/devices', {
          token: 'android-token-alice',
          muted: [],
        })
      ).status,
    ).toBe(404);
  });

  it("sends an agent's approval to its owner's phones, straight to Apple and Google", async () => {
    const sessionId = await newSession('Lobby race');
    const desk = await awayDesktop();
    desk.send({
      type: 'lane.events',
      sessionId,
      events: [
        {
          type: 'approval',
          request: {
            id: 'req-1',
            tool: 'run_shell',
            kind: 'command',
            title: 'Run this?',
            detail: 'npm publish --token=sk-or-v1-0123456789abcdef0123456789abcdef',
          },
        },
      ],
    });
    await until(() => apnsCalls.length === 1 && fcmCalls.length === 1);

    const a = apnsCalls[0]!;
    // A development build: Apple's sandbox host.
    expect(a.host).toBe('sandbox');
    expect(a.path).toBe('/3/device/ios-token-alice');
    expect(a.headers).toMatchObject({
      'apns-topic': 'dev.alperkayan.kovan',
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-collapse-id': 'a:req-1',
    });
    expect(a.body.aps).toMatchObject({
      alert: { title: 'Your agent asks: Run this?', subtitle: 'Lobby race' },
      category: 'approval',
      'thread-id': sessionId,
    });
    // Secrets never leave in a notification.
    expect(a.body.aps.alert.body).not.toContain('sk-or-v1');
    expect(a.body.body).toEqual({
      kind: 'approval',
      sessionId,
      laneUserId: alice.id,
      requestId: 'req-1',
    });
    // The provider token is Apple's ES256 JWT, signed with the key, for the team.
    const [head, claims, signature] = a.headers.authorization!.replace('bearer ', '').split('.');
    expect(JSON.parse(Buffer.from(head!, 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: 'KEYID12345',
    });
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString()).iss).toBe('TEAM123456');
    expect(
      verify(
        'sha256',
        Buffer.from(`${head}.${claims}`),
        { key: ec.publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature!, 'base64url'),
      ),
    ).toBe(true);

    const f = fcmCalls[0]!;
    expect(f.auth).toBe('Bearer ya29.fake');
    expect(f.body.message).toMatchObject({
      token: 'android-token-alice',
      android: { priority: 'high' },
      data: { title: 'Your agent asks: Run this?', categoryId: 'approval', channelId: 'asks' },
    });
    expect(JSON.parse(f.body.message.data.body)).toMatchObject({ requestId: 'req-1' });

    // Turned off on the Android phone: only the iPhone hears that the agent finished.
    apnsCalls.length = 0;
    fcmCalls.length = 0;
    desk.send({
      type: 'lane.events',
      sessionId,
      events: [{ type: 'turn_end', turnId: 't', reason: 'done', cost: 0 }],
    });
    await until(
      () => apnsCalls.length === 1 && apnsCalls[0]!.body.aps.alert.title === 'Your agent finished',
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(fcmCalls).toHaveLength(0);
    desk.close();
  });

  it('asks whoever called an AI teammate in with @, as well as the machine running it', async () => {
    await api(bob, 'POST', '/api/push/devices', { platform: 'ios', token: 'ios-token-bob' });
    const sessionId = await newSession('Review call');
    const ivy = (
      await api(alice, 'POST', `/api/workspaces/${workspaceId}/agents`, {
        name: 'Ivy',
        model: 'openai/gpt-5.6-luna',
      })
    ).body.agent.id as string;
    await api(alice, 'POST', `/api/sessions/${sessionId}/agents`, { agentId: ivy });
    const desk = await awayDesktop();
    const ask = (requestId: string, askerId: string) =>
      desk.send({
        type: 'lane.events',
        sessionId,
        agentId: ivy,
        events: [
          {
            type: 'approval',
            request: { id: requestId, tool: 'run_shell', kind: 'command', title: 'Run this?' },
            askerId,
          },
        ],
      });
    ask('req-ivy', bob.id);
    await until(() => apnsCalls.some((c) => c.path === '/3/device/ios-token-bob'));
    expect(apnsCalls.map((c) => c.path).sort()).toEqual([
      '/3/device/ios-token-alice',
      '/3/device/ios-token-bob',
    ]);
    expect(apnsCalls[0]!.body.aps.alert.title).toBe('Ivy asks: Run this?');
    // Someone who can't answer approvals there isn't asked.
    apnsCalls.length = 0;
    ask('req-ivy-2', '00000000-0000-4000-8000-000000000000');
    await until(() => apnsCalls.length === 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(apnsCalls.map((c) => c.path)).toEqual(['/3/device/ios-token-alice']);
    desk.close();
    await api(bob, 'POST', '/api/push/devices/remove', { token: 'ios-token-bob' });
  });

  it('stays quiet while the person is at their desktop', async () => {
    const sessionId = await newSession('At the desk');
    const desk = await connect(h, alice.token);
    await desk.waitFor((m) => m.type === 'welcome');
    desk.send({ type: 'presence', status: 'active', workspaceId: null });
    desk.send({
      type: 'lane.events',
      sessionId,
      events: [{ type: 'approval', request: { id: 'req-2', title: 'Run this?', detail: 'ls' } }],
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(apnsCalls).toHaveLength(0);
    expect(fcmCalls).toHaveLength(0);
    desk.close();
  });

  it('tells whoever launched a swarm when it ends or pauses itself, not when they stop it', async () => {
    const sessionId = await newSession('Swarm news');
    const agent = (
      await api(alice, 'POST', `/api/workspaces/${workspaceId}/agents`, {
        name: 'Wren',
        model: 'openai/gpt-5.6-luna',
      })
    ).body.agent.id;
    const swarm = (
      await api(alice, 'PUT', `/api/sessions/${sessionId}/swarm`, {
        goal: 'Fix it',
        leadAgentId: agent,
        agentIds: [agent],
        budget: 1,
      })
    ).body.swarm;
    await api(alice, 'POST', `/api/swarms/${swarm.id}/launch`);
    const desk = await awayDesktop();
    // Bob stops it: Alice hears.
    await api(bob, 'POST', `/api/swarms/${swarm.id}/status`, { status: 'stopped' });
    await until(() => apnsCalls.length === 1);
    expect(apnsCalls[0]!.body.aps.alert.title).toBe('bob stopped your swarm');
    expect(apnsCalls[0]!.body.body).toEqual({ kind: 'swarm', sessionId });
    desk.close();
  });

  it('asks the rest of the team too, only on phones that turned team questions on', async () => {
    const reg = await api(bob, 'POST', '/api/push/devices', {
      platform: 'ios',
      token: 'ios-token-bob-team',
    });
    // A new phone starts with team questions off.
    expect(reg.body.device.muted).toContain('team');
    const sessionId = await newSession('Team asks');
    const desk = await awayDesktop();
    const ask = (id: string) =>
      desk.send({
        type: 'lane.events',
        sessionId,
        events: [{ type: 'approval', request: { id, title: 'Run this?', detail: 'ls' } }],
      });
    await api(alice, 'PATCH', `/api/workspaces/${workspaceId}`, { othersAgents: 'editors' });
    ask('req-team-1');
    await until(() => apnsCalls.length >= 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(apnsCalls.map((c) => c.path)).not.toContain('/3/device/ios-token-bob-team');
    // Bob turns them on: an editor may answer others' agents here, so he's asked as well.
    await api(bob, 'PATCH', '/api/push/devices', { token: 'ios-token-bob-team', muted: [] });
    apnsCalls.length = 0;
    ask('req-team-2');
    await until(() => apnsCalls.some((c) => c.path === '/3/device/ios-token-bob-team'));
    const bobs = apnsCalls.find((c) => c.path === '/3/device/ios-token-bob-team')!;
    expect(bobs.body.aps.alert.title).toBe("alice's agent asks: Run this?");
    expect(bobs.body.aps.category).toBe('approval');
    // Back to owners only: Bob may not answer, so he isn't asked.
    await api(alice, 'PATCH', `/api/workspaces/${workspaceId}`, { othersAgents: 'owners' });
    apnsCalls.length = 0;
    ask('req-team-3');
    await until(() => apnsCalls.length >= 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(apnsCalls.map((c) => c.path)).not.toContain('/3/device/ios-token-bob-team');
    desk.close();
    await api(bob, 'POST', '/api/push/devices/remove', { token: 'ios-token-bob-team' });
  });

  it('tells someone a comment named them, and not the one who wrote it', async () => {
    const sessionId = await newSession('Mentions');
    const desk = await awayDesktop();
    const comment = (body: string, who: Person) =>
      api(who, 'POST', `/api/workspaces/${workspaceId}/comments`, {
        sessionId,
        anchor: { kind: 'session' },
        body,
      });
    expect((await comment('@alice can you look at the totals?', bob)).status).toBe(200);
    await until(() => apnsCalls.length === 1);
    expect(apnsCalls[0]!.path).toBe('/3/device/ios-token-alice');
    expect(apnsCalls[0]!.body.aps.alert).toMatchObject({
      title: 'bob mentioned you',
      body: '@alice can you look at the totals?',
    });
    expect(apnsCalls[0]!.body.body).toEqual({ kind: 'mention', sessionId });
    // Naming yourself, or an address that only looks like it, tells no one.
    apnsCalls.length = 0;
    await comment('note to self @alice', alice);
    await comment('mail bob@alice.dev', bob);
    await new Promise((r) => setTimeout(r, 300));
    expect(apnsCalls).toHaveLength(0);
    desk.close();
  });

  it('asks the swarm owner about a task that needs a yes, with buttons', async () => {
    const sessionId = await newSession('Migration');
    const desk = await awayDesktop();
    const plan = await api(alice, 'POST', `/api/sessions/${sessionId}/plan/steps`, {
      steps: [{ title: 'Add a migration', approvalReason: 'changes the database' }],
    });
    const stepId = plan.body.plan.steps[0].id;
    await until(() => apnsCalls.length === 1);
    expect(apnsCalls[0]!.body.aps).toMatchObject({
      alert: {
        title: 'A Swarm task waits for your approval: Add a migration',
        body: 'changes the database',
      },
      category: 'task',
    });
    expect(apnsCalls[0]!.body.body).toEqual({ kind: 'task', sessionId, stepId });
    desk.close();
  });

  it('forgets a phone Apple or Google says is gone, and phones that signed out', async () => {
    await api(bob, 'POST', '/api/push/devices', { platform: 'ios', token: 'gone-token-ios' });
    await api(bob, 'POST', '/api/push/devices', {
      platform: 'android',
      token: 'gone-token-android',
    });
    const desk = await connect(h, bob.token);
    await desk.waitFor((m) => m.type === 'welcome');
    desk.send({ type: 'presence', status: 'idle', workspaceId: null });
    await h.ctx.push.handle({
      kind: 'handoff',
      sessionId: await newSession('Handed'),
      fromUserId: alice.id,
      toUserId: bob.id,
      reason: 'alice handed it over',
    });
    expect(apnsCalls).toHaveLength(1);
    expect(fcmCalls).toHaveLength(1);
    // Both are gone: the next one reaches nobody.
    await h.ctx.push.handle({
      kind: 'handoff',
      sessionId: await newSession('Handed again'),
      fromUserId: alice.id,
      toUserId: bob.id,
      reason: null,
    });
    expect(apnsCalls).toHaveLength(1);
    expect(fcmCalls).toHaveLength(1);

    // Signing out removes the phone; a revoked sign-in gets nothing even if it didn't.
    await api(alice, 'POST', '/api/push/devices/remove', { token: 'ios-token-alice' });
    await h.app.inject({ method: 'POST', url: '/auth/logout', headers: auth(alice.token) });
    const sent = await h.ctx.push.deliver({
      userIds: [alice.id],
      kind: 'handoff',
      title: 't',
      subtitle: 's',
      body: 'b',
      data: { kind: 'handoff', sessionId: 'x' },
    });
    expect(sent).toEqual({ sent: 0, failed: 0 });
    desk.close();
  });
});
