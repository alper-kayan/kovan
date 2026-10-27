import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { machines } from './db/schema.js';
import { ONLINE_MS } from './machines.js';
import { auth, connect, oauthLogin, startHarness, type Harness } from './test/harness.js';

let h: Harness;
let alice: string; // owner
let eve: string; // not a member
let workspaceId: string;
let piKey: string; // a machine's key
let macKey: string; // another machine's key
let founder: string; // read + dispatch, like FounderOS

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

const key = async (name: string, scopes: string[]) =>
  (await api(alice, 'POST', `/api/workspaces/${workspaceId}/api-keys`, { name, scopes })).body
    .token as string;
const register = (token: string, body: object) =>
  api(token, 'POST', `/api/workspaces/${workspaceId}/machines`, body);
const start = (title: string, machine?: string | null, as = founder) =>
  api(as, 'POST', `/api/workspaces/${workspaceId}/sessions`, {
    title,
    branch: `kovan/${title.toLowerCase().replace(/\W+/g, '-')}`,
    ...(machine === undefined ? {} : { machine }),
  });
const machinesNow = async () =>
  (await api(founder, 'GET', `/api/workspaces/${workspaceId}/machines`)).body.machines as {
    id: string;
    name: string;
    online: boolean;
    running: number;
    slots: number;
  }[];

async function until<T>(read: () => Promise<T>, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Frees every machine's slots: ends what runs. */
async function endAll() {
  const live = (await api(founder, 'GET', `/api/workspaces/${workspaceId}/sessions`)).body
    .sessions as { id: string }[];
  for (const s of live) await api(alice, 'POST', `/api/sessions/${s.id}/end`, {});
}

const PI = {
  name: 'pi',
  platform: 'linux-arm64',
  slots: 1,
  agents: [
    { name: 'kovan', version: '0.9.0', ready: true },
    { name: 'claude', version: '2.1.0', ready: true },
  ],
  repos: [{ remote: 'git@github.com:acme/shop.git', path: '/home/pi/shop' }],
};

beforeAll(async () => {
  h = await startHarness();
  alice = (await oauthLogin(h, 'github', 'alice', { providerUserId: '1', login: 'alice' })).token;
  eve = (await oauthLogin(h, 'github', 'eve', { providerUserId: '9', login: 'eve' })).token;
  const orgId = (await api(alice, 'GET', '/api/me')).body.orgs[0].id;
  workspaceId = (
    await api(alice, 'POST', '/api/workspaces', {
      orgId,
      name: 'shop',
      repoUrl: 'https://github.com/acme/shop.git',
    })
  ).body.workspace.id;
  piKey = await key('pi', ['machine']);
  macKey = await key('mac', ['machine']);
  founder = await key('FounderOS', ['read', 'dispatch']);
});
afterAll(async () => {
  await h.close();
});

describe('machines', () => {
  it('register with their machine key, report in, and are listed online', async () => {
    const made = await register(piKey, PI);
    expect(made.status).toBe(200);
    expect(made.body.machine).toMatchObject({
      name: 'pi',
      platform: 'linux-arm64',
      slots: 1,
      running: 0,
      online: true,
      keyName: 'pi',
      repos: [{ remote: 'github.com/acme/shop', path: '/home/pi/shop' }],
      agents: PI.agents,
    });
    const id = made.body.machine.id;
    // Registering again (agentd restarting) updates the same machine.
    const again = await register(piKey, { ...PI, slots: 1, agents: [PI.agents[0]] });
    expect(again.body.machine.id).toBe(id);
    expect(again.body.machine.agents).toHaveLength(1);
    // The name is the machine's: another key can't take it.
    expect((await register(macKey, PI)).status).toBe(409);
    // A dispatch key isn't a machine.
    expect((await register(founder, { ...PI, name: 'fake' })).status).toBe(403);

    const beat = await api(piKey, 'POST', `/api/machines/${id}/heartbeat`, { slots: 1 });
    expect(beat.status).toBe(200);
    expect((await api(macKey, 'POST', `/api/machines/${id}/heartbeat`, {})).status).toBe(403);
    expect((await api(piKey, 'POST', '/api/machines/nope/heartbeat', {})).status).toBe(404);
    expect((await api(founder, 'POST', `/api/machines/${id}/heartbeat`, {})).status).toBe(403);

    expect((await machinesNow()).map((m) => [m.name, m.online])).toEqual([['pi', true]]);
    expect((await api(eve, 'GET', `/api/workspaces/${workspaceId}/machines`)).status).toBe(404);
  });

  it('take work by id or "auto", within their slots and only when online', async () => {
    const pi = (await machinesNow())[0]!;
    // A session without a machine is a desktop's, as before.
    expect((await start('Desktop')).body.session).toMatchObject({ machine: null });

    const first = await start('Cart total', 'auto');
    expect(first.status).toBe(200);
    expect(first.body.session.machine).toEqual({ id: pi.id, name: 'pi' });
    expect((await machinesNow())[0]).toMatchObject({ running: 1, slots: 1 });
    // Its one slot is taken.
    const busy = await start('Second', 'auto');
    expect(busy.status).toBe(409);
    expect(busy.body.error.message).toMatch(/busy/);
    expect((await start('Second', pi.id)).status).toBe(409);

    // A second machine holding the repository takes the next one.
    const mac = (
      await register(macKey, {
        name: 'mac',
        platform: 'darwin-arm64',
        slots: 2,
        repos: [{ remote: 'https://github.com/acme/shop', path: '/Users/me/shop' }],
      })
    ).body.machine;
    expect((await start('Second', 'auto')).body.session.machine.name).toBe('mac');

    // Three missed reports: offline, and not chosen.
    await h.ctx.db
      .update(machines)
      .set({ lastSeenAt: new Date(Date.now() - ONLINE_MS - 1000) })
      .where(eq(machines.id, mac.id));
    expect((await machinesNow()).find((m) => m.name === 'mac')!.online).toBe(false);
    const offline = await start('Third', mac.id);
    expect(offline.status).toBe(409);
    expect(offline.body.error.message).toMatch(/offline/);
    const none = await start('Third', 'auto');
    expect(none.status).toBe(409);
    await api(macKey, 'POST', `/api/machines/${mac.id}/heartbeat`, {});
    expect((await start('Third', 'auto')).body.session.machine.name).toBe('mac');

    // Nobody outside the workspace learns anything about its machines.
    const outside = await start('Peek', 'auto', eve);
    expect(outside.status).toBe(404);
  });

  it('say where their checkout is, and that shows on the session and in events', async () => {
    await endAll();
    const s = (await start('Checkout', 'auto')).body.session;
    const mine = s.machine.name === 'pi' ? piKey : macKey;
    const other = mine === piKey ? macKey : piKey;
    expect(
      (await api(other, 'PUT', `/api/sessions/${s.id}/checkout`, { path: '/tmp/x' })).status,
    ).toBe(403);
    const set = await api(mine, 'PUT', `/api/sessions/${s.id}/checkout`, {
      path: '/srv/work/shop-checkout',
    });
    expect(set.status).toBe(200);
    const view = (await api(founder, 'GET', `/api/sessions/${s.id}`)).body.session;
    expect(view).toMatchObject({ machine: s.machine, worktreePath: '/srv/work/shop-checkout' });
    const desktop = (await start('Plain')).body.session;
    expect(
      (await api(mine, 'PUT', `/api/sessions/${desktop.id}/checkout`, { path: '/x' })).status,
    ).toBe(409);

    const events = (await api(founder, 'GET', `/api/workspaces/${workspaceId}/events?limit=500`))
      .body.events as { type: string; data: { sessionId: string; machineId: string | null } }[];
    const started = events.find((e) => e.type === 'session.started' && e.data.sessionId === s.id);
    expect(started!.data.machineId).toBe(s.machine.id);
  });

  it("take a swarm launched from a phone when the person's desktop is off", async () => {
    await endAll();
    // Alice is only on her phone: no desktop connected.
    const phone = await connect(h, alice, { client: 'mobile' });
    await phone.waitFor((m) => m.type === 'welcome');
    const s = (await start('From the phone', undefined, alice)).body.session;
    const lead = (
      await api(alice, 'POST', `/api/workspaces/${workspaceId}/agents`, {
        name: 'Moss',
        model: 'openai/gpt-oss-120b',
        instructions: 'Small tested changes.',
      })
    ).body.agent;
    const swarm = (
      await api(alice, 'PUT', `/api/sessions/${s.id}/swarm`, {
        goal: 'Add a median helper',
        leadAgentId: lead.id,
        agentIds: [lead.id],
        budget: 0.5,
      })
    ).body.swarm;
    const asked = await api(alice, 'POST', '/api/desk', {
      action: { kind: 'launch', swarmId: swarm.id, sessionId: s.id },
    });
    expect(asked.status).toBe(200);
    const done = await phone.waitFor<{ ok: boolean; message: string }>(
      (m) => m.type === 'desk.done' && m['id'] === asked.body.request.id,
    );
    expect(done.ok).toBe(true);
    expect(done.message).toMatch(/^Started on (pi|mac)\.$/);
    const view = (await api(alice, 'GET', `/api/sessions/${s.id}`)).body.session;
    expect(['pi', 'mac']).toContain(view.machine.name);
    expect((await api(alice, 'GET', `/api/sessions/${s.id}/swarm`)).body.swarm.status).toBe(
      'running',
    );
    // A prompt to her own agent still needs her desktop.
    const prompt = await api(alice, 'POST', '/api/desk', {
      action: { kind: 'prompt', sessionId: s.id, text: 'hi' },
    });
    expect(prompt.status).toBe(409);
    phone.close();
  });

  it('run a swarm sent to them, and go away when removed or their key is revoked', async () => {
    await endAll();
    const s = (await start('Swarm')).body.session;
    const lead = (
      await api(alice, 'POST', `/api/workspaces/${workspaceId}/agents`, {
        name: 'Wren',
        model: 'openai/gpt-5.6-luna',
        instructions: 'Small tested changes.',
      })
    ).body.agent;
    const swarm = (
      await api(founder, 'PUT', `/api/sessions/${s.id}/swarm`, {
        goal: 'x',
        leadAgentId: lead.id,
        agentIds: [lead.id],
        budget: 1,
      })
    ).body.swarm;
    const launched = await api(founder, 'POST', `/api/swarms/${swarm.id}/launch`, {
      machine: 'auto',
    });
    expect(launched.status).toBe(200);
    const view = (await api(founder, 'GET', `/api/sessions/${s.id}`)).body.session;
    expect(['pi', 'mac']).toContain(view.machine.name);

    // The owner removes a machine: its sessions no longer point at it; it can't report.
    const pi = (await machinesNow()).find((m) => m.name === 'pi')!;
    expect(
      (await api(founder, 'DELETE', `/api/workspaces/${workspaceId}/machines/${pi.id}`)).status,
    ).toBe(403);
    expect(
      (await api(alice, 'DELETE', `/api/workspaces/${workspaceId}/machines/${pi.id}`)).status,
    ).toBe(200);
    expect((await api(piKey, 'POST', `/api/machines/${pi.id}/heartbeat`, {})).status).toBe(404);

    // Revoking a machine's key removes its machines too.
    const keys = (await api(alice, 'GET', `/api/workspaces/${workspaceId}/api-keys`)).body.keys as {
      id: string;
      name: string;
    }[];
    await api(
      alice,
      'DELETE',
      `/api/workspaces/${workspaceId}/api-keys/${keys.find((k) => k.name === 'mac')!.id}`,
    );
    expect(await machinesNow()).toEqual([]);
  });

  it('do the work sent to them as their own member, and are paused when they go quiet', async () => {
    const boxKey = await key('box', ['machine']);
    const box = (
      await register(boxKey, {
        name: 'box',
        platform: 'linux-x64',
        slots: 2,
        // It works with Claude Code, on its owner's subscription.
        agents: [
          { name: 'kovan', version: null, ready: false, works: false },
          { name: 'claude', version: '2.1.302', ready: true, works: true },
        ],
        repos: [{ remote: 'github.com/acme/shop', path: '/srv/shop' }],
      })
    ).body;
    expect(box.work).toEqual([]);
    const s = (await start('Night work', 'auto')).body.session;
    expect(s.machine.name).toBe('box');
    const lead = (
      await api(alice, 'POST', `/api/workspaces/${workspaceId}/agents`, {
        name: 'Rook',
        model: 'openai/gpt-5.6-luna',
        instructions: 'Small tested changes.',
      })
    ).body.agent;
    const swarm = (
      await api(founder, 'PUT', `/api/sessions/${s.id}/swarm`, {
        goal: 'Add a total helper',
        leadAgentId: lead.id,
        agentIds: [lead.id],
        budget: 1,
      })
    ).body.swarm;
    // Launched without naming a machine: the session's machine runs it, as its own member.
    const launched = await api(founder, 'POST', `/api/swarms/${swarm.id}/launch`, {});
    expect(launched.body.swarm).toMatchObject({ status: 'running', launchedByName: 'box' });
    const view = (await api(founder, 'GET', `/api/sessions/${s.id}`)).body.session;
    expect(view.participants.find((p: { userId: string }) => p.userId === lead.id)).toMatchObject({
      kind: 'agent',
      hostName: 'box',
      harness: 'claude-code',
    });

    const boxNow = async () => (await machinesNow()).find((m) => m.name === 'box')!;
    expect(await boxNow()).toMatchObject({ running: 1 });

    // Its report tells it what to run.
    const beat = await api(boxKey, 'POST', `/api/machines/${box.machine.id}/heartbeat`, {});
    expect(beat.body.work).toEqual([{ swarmId: swarm.id, sessionId: s.id }]);
    // It may do the swarm's work, not dispatch new work.
    expect(
      (await api(boxKey, 'POST', `/api/swarms/${swarm.id}/messages`, { text: 'Starting.' })).status,
    ).not.toBe(403);
    // A person writes to the lead: it waits until the machine hands it over.
    const note = (
      await api(alice, 'POST', `/api/swarms/${swarm.id}/messages`, {
        toId: lead.id,
        text: 'Mind the cart totals',
      })
    ).body.message;
    expect(note.deliveredTo).toEqual([]);
    const delivered = { agentId: lead.id, ids: [note.id] };
    expect(
      (await api(alice, 'POST', `/api/swarms/${swarm.id}/messages/delivered`, delivered)).status,
    ).toBe(403);
    expect(
      (await api(boxKey, 'POST', `/api/swarms/${swarm.id}/messages/delivered`, delivered)).status,
    ).toBe(200);
    // Saying it twice changes nothing.
    await api(boxKey, 'POST', `/api/swarms/${swarm.id}/messages/delivered`, delivered);
    const chat = (await api(founder, 'GET', `/api/swarms/${swarm.id}/messages`)).body.messages;
    expect(chat.find((m: { id: string }) => m.id === note.id).deliveredTo).toEqual([lead.id]);

    // The lead adds a teammate the team lacks, through the agent factory.
    const hire = (key: string, name: string) =>
      api(key, 'POST', `/api/swarms/${swarm.id}/agents`, {
        name,
        instructions: 'Database work: schema design, migrations and query tuning.',
        reason: 'Nobody on the team knows the database well',
      });
    expect((await hire(boxKey, 'Claude')).status).toBe(400);
    expect((await hire(boxKey, 'gpt-helper')).status).toBe(400);
    expect((await hire(alice, 'Leo')).status).toBe(403);
    const leo = await hire(boxKey, 'Leo');
    expect(leo.status).toBe(200);
    expect(leo.body.agent).toMatchObject({ name: 'Leo', model: lead.model, createdByName: 'Rook' });
    expect(leo.body.swarm.agents.map((a: { name: string }) => a.name)).toContain('Leo');
    const withLeo = (await api(founder, 'GET', `/api/sessions/${s.id}`)).body.session;
    expect(
      withLeo.participants.find((p: { userId: string }) => p.userId === leo.body.agent.id),
    ).toMatchObject({ hostName: 'box', harness: 'claude-code' });
    expect((await hire(boxKey, 'Leo')).status).toBe(409);
    expect((await hire(boxKey, 'Nora')).status).toBe(200);
    expect((await hire(boxKey, 'Mira')).body.error.message).toMatch(/at most 2/);
    expect((await start('Sneaky', null, boxKey)).status).toBe(403);
    // It starts its teammates' tasks without a lane of its own; a machine running nothing here can't.
    expect(
      (await api(boxKey, 'POST', `/api/sessions/${s.id}/subagents`, { task: 'Write total()' }))
        .status,
    ).toBe(200);
    const idleKey = await key('idle', ['machine']);
    await register(idleKey, { name: 'idle', platform: 'linux-x64' });
    expect(
      (await api(idleKey, 'POST', `/api/sessions/${s.id}/subagents`, { task: 'Write total()' }))
        .status,
    ).toBe(403);

    // It connects live with its key and streams its agents' lanes; a read key can't connect.
    const live = await connect(h, boxKey);
    await live.waitFor((m) => m.type === 'welcome');
    live.send({ type: 'subscribe', workspaceId });
    live.send({
      type: 'lane.events',
      sessionId: s.id,
      agentId: lead.id,
      events: [{ type: 'turn_start', turnId: 't1', model: 'm' }],
      touched: [],
    });
    await until(async () => {
      const v = (await api(founder, 'GET', `/api/sessions/${s.id}`)).body.session;
      return v.running.some((r: { userId: string }) => r.userId === lead.id);
    });
    expect(live.messages.some((m) => m.type === 'error')).toBe(false);
    live.close();
    const reader = await connect(h, await key('reader', ['read']));
    await new Promise((resolve) => reader.socket.once('close', resolve));

    // It goes quiet: its running swarm is paused with why, and FounderOS hears of it.
    await h.ctx.db
      .update(machines)
      .set({ lastSeenAt: new Date(Date.now() - ONLINE_MS - 1000) })
      .where(eq(machines.id, box.machine.id));
    for (const l of await h.ctx.machines.lost())
      await h.ctx.swarm.machineLost(l.swarmId, l.sessionId, l.machine);
    const paused = (await api(founder, 'GET', `/api/sessions/${s.id}/swarm`)).body.swarm;
    expect(paused.status).toBe('paused');
    expect(paused.pausedReason).toMatch(/box stopped reporting/);
    const events = (await api(founder, 'GET', `/api/workspaces/${workspaceId}/events?limit=500`))
      .body.events as { type: string; data: { status?: string; reason?: string } }[];
    expect(
      events.some(
        (e) =>
          e.type === 'swarm.status_changed' &&
          e.data.status === 'paused' &&
          /stopped reporting/.test(e.data.reason ?? ''),
      ),
    ).toBe(true);
    expect(await h.ctx.machines.lost()).toEqual([]);
    // A paused (or done) swarm frees its slot, though its session stays open.
    expect(await boxNow()).toMatchObject({ running: 0 });

    // Launched again: the old run's writes carry an old fence and are refused.
    expect(launched.body.swarm.fence).toBe(1);
    const again = await api(founder, 'POST', `/api/swarms/${swarm.id}/launch`, {});
    expect(again.body.swarm.fence).toBe(2);
    const report = (fence: string) =>
      h.app.inject({
        method: 'POST',
        url: `/api/swarms/${swarm.id}/report`,
        headers: { ...auth(boxKey), 'x-kovan-fence': fence },
        payload: { agentId: lead.id, status: 'working', task: 'Old work' },
      });
    const stale = await report(`${swarm.id}:1`);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('stale_run');
    expect((await report(`${swarm.id}:2`)).statusCode).toBe(200);
    expect((await report('not-a-fence')).statusCode).toBe(400);
  });
});
