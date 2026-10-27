import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, connect, oauthLogin, startHarness, type Harness } from './test/harness.js';

let h: Harness;
type Person = { token: string; id: string };
let alice: Person; // owner
let bob: Person; // editor
let dave: Person; // viewer
let workspaceId: string;
let sessionId: string;

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
  dave = await login('dave', '4');
  const orgId = (await api(alice, 'GET', '/api/me')).body.orgs[0].id;
  workspaceId = (
    await api(alice, 'POST', '/api/workspaces', { orgId, name: 'lobby', repoUrl: null })
  ).body.workspace.id;
  for (const [login, role] of [
    ['bob', 'editor'],
    ['dave', 'viewer'],
  ])
    await api(alice, 'POST', `/api/workspaces/${workspaceId}/invites`, {
      githubLogin: login,
      role,
    });
  sessionId = (
    await api(alice, 'POST', `/api/workspaces/${workspaceId}/sessions`, {
      title: 'Lobby race',
      branch: 'kovan/lobby',
    })
  ).body.session.id;
  for (const p of [alice, bob])
    await api(p, 'POST', `/api/sessions/${sessionId}/join`, { mode: 'join' });
});
afterAll(async () => {
  await h.close();
});

const takeover = () => ({ action: { kind: 'takeover', sessionId, laneUserId: bob.id } });

describe('work asked for on the phone, done by the desktop', () => {
  it('says so at once when none of the person’s computers is connected', async () => {
    const phone = await connect(h, alice.token, { client: 'mobile' });
    await phone.waitFor((m) => m.type === 'welcome');
    const r = await api(alice, 'POST', '/api/desk', takeover());
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/computer is offline/);
    phone.close();
  });

  it('goes to the desktops only, one of them takes it, and the phone hears how it ended', async () => {
    const phone = await connect(h, alice.token, { client: 'mobile' });
    const laptop = await connect(h, alice.token);
    const tower = await connect(h, alice.token);
    for (const c of [phone, laptop, tower]) await c.waitFor((m) => m.type === 'welcome');

    const asked = await api(alice, 'POST', '/api/desk', takeover());
    expect(asked.status).toBe(200);
    const id = asked.body.request.id as string;
    for (const desk of [laptop, tower])
      expect(await desk.waitFor((m) => m.type === 'desk')).toMatchObject({
        request: { id, action: { kind: 'takeover', laneUserId: bob.id } },
      });
    expect(phone.messages.some((m) => m.type === 'desk')).toBe(false);

    // Bob can't touch Alice's request; her second computer loses the race.
    expect((await api(bob, 'POST', `/api/desk/${id}/claim`, { machineId: 'b' })).status).toBe(404);
    expect(
      (await api(alice, 'POST', `/api/desk/${id}/claim`, { machineId: 'laptop' })).status,
    ).toBe(200);
    expect((await api(alice, 'POST', `/api/desk/${id}/claim`, { machineId: 'tower' })).status).toBe(
      409,
    );
    expect(
      (
        await api(alice, 'POST', `/api/desk/${id}/done`, {
          machineId: 'tower',
          ok: true,
          message: 'x',
        })
      ).status,
    ).toBe(409);

    await api(alice, 'POST', `/api/desk/${id}/done`, {
      machineId: 'laptop',
      ok: true,
      message: "You continue bob's work.",
    });
    expect(await phone.waitFor((m) => m.type === 'desk.done')).toMatchObject({
      id,
      ok: true,
      message: "You continue bob's work.",
    });
    // Finished: it can't be claimed again.
    expect((await api(alice, 'POST', `/api/desk/${id}/claim`, { machineId: 'tower' })).status).toBe(
      404,
    );
    for (const c of [phone, laptop, tower]) c.close();
  });

  it('checks the role and the work before bothering any desktop', async () => {
    const desk = await connect(h, dave.token);
    await desk.waitFor((m) => m.type === 'welcome');
    // A viewer can't take over.
    expect((await api(dave, 'POST', '/api/desk', takeover())).status).toBe(403);
    desk.close();

    const laptop = await connect(h, alice.token);
    await laptop.waitFor((m) => m.type === 'welcome');
    // Not your own lane, not a handoff that isn't yours, not a lane you don't have.
    expect(
      (
        await api(alice, 'POST', '/api/desk', {
          action: { kind: 'takeover', sessionId, laneUserId: alice.id },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api(alice, 'POST', '/api/desk', {
          action: {
            kind: 'continue',
            handoffId: '00000000-0000-4000-8000-000000000000',
            sessionId,
          },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api(dave, 'POST', '/api/desk', {
          action: { kind: 'handoff', sessionId, toUserId: alice.id },
        })
      ).status,
    ).toBe(403);
    expect(laptop.messages.some((m) => m.type === 'desk')).toBe(false);
    laptop.close();
  });

  it('lets only the person who launched a paused swarm resume it', async () => {
    const { body } = await api(alice, 'GET', `/api/workspaces/${workspaceId}/agents`);
    let agentId = body.agents?.[0]?.id as string | undefined;
    if (!agentId)
      agentId = (
        await api(alice, 'POST', `/api/workspaces/${workspaceId}/agents`, {
          name: 'Wren',
          model: 'openai/gpt-5.6-luna',
        })
      ).body.agent.id;
    const swarm = (
      await api(alice, 'PUT', `/api/sessions/${sessionId}/swarm`, {
        goal: 'Fix the race',
        leadAgentId: agentId,
        agentIds: [agentId],
        budget: 1,
      })
    ).body.swarm;
    await api(alice, 'POST', `/api/swarms/${swarm.id}/launch`);
    await api(alice, 'POST', `/api/swarms/${swarm.id}/status`, { status: 'paused' });

    const bobDesk = await connect(h, bob.token);
    await bobDesk.waitFor((m) => m.type === 'welcome');
    const r = await api(bob, 'POST', '/api/desk', {
      action: { kind: 'resume', swarmId: swarm.id, sessionId },
    });
    expect(r.status).toBe(403);
    expect(r.body.error.message).toMatch(/Only alice can resume it/);
    bobDesk.close();

    const laptop = await connect(h, alice.token);
    await laptop.waitFor((m) => m.type === 'welcome');
    expect(
      (
        await api(alice, 'POST', '/api/desk', {
          action: { kind: 'resume', swarmId: swarm.id, sessionId },
        })
      ).status,
    ).toBe(200);
    expect(await laptop.waitFor((m) => m.type === 'desk')).toBeTruthy();
    laptop.close();
  });

  it('launches a swarm set up on the phone only while it is a draft', async () => {
    const other = (
      await api(alice, 'POST', `/api/workspaces/${workspaceId}/sessions`, {
        title: 'Phone swarm',
        branch: 'kovan/phone-swarm',
      })
    ).body.session.id as string;
    const agentId = (await api(alice, 'GET', `/api/workspaces/${workspaceId}/agents`)).body
      .agents[0].id as string;
    const swarm = (
      await api(alice, 'PUT', `/api/sessions/${other}/swarm`, {
        goal: 'Add a median helper',
        leadAgentId: agentId,
        agentIds: [agentId],
        budget: 0.5,
      })
    ).body.swarm;
    expect(swarm.status).toBe('draft');

    const laptop = await connect(h, alice.token);
    await laptop.waitFor((m) => m.type === 'welcome');
    const launch = { action: { kind: 'launch', swarmId: swarm.id, sessionId: other } };
    // A viewer can't start one; a swarm can't be launched from another session's id.
    const daveDesk = await connect(h, dave.token);
    await daveDesk.waitFor((m) => m.type === 'welcome');
    expect((await api(dave, 'POST', '/api/desk', launch)).status).toBe(403);
    daveDesk.close();
    expect(
      (
        await api(alice, 'POST', '/api/desk', {
          action: { kind: 'launch', swarmId: swarm.id, sessionId },
        })
      ).status,
    ).toBe(404);
    expect((await api(alice, 'POST', '/api/desk', launch)).status).toBe(200);
    expect(await laptop.waitFor((m) => m.type === 'desk')).toMatchObject({
      request: { action: { kind: 'launch', swarmId: swarm.id } },
    });
    // Once it runs, launching again (or "resuming" a running swarm) is refused.
    await api(alice, 'POST', `/api/swarms/${swarm.id}/launch`);
    const again = await api(alice, 'POST', '/api/desk', launch);
    expect(again.status).toBe(409);
    expect(again.body.error.message).toMatch(/This swarm is running/);
    await api(alice, 'POST', `/api/swarms/${swarm.id}/status`, { status: 'stopped' });
    laptop.close();
  });

  it('sends a prompt for the person’s own agent to their desktop', async () => {
    const laptop = await connect(h, alice.token);
    await laptop.waitFor((m) => m.type === 'welcome');
    const prompt = { action: { kind: 'prompt', sessionId, text: '  Add a median helper  ' } };
    expect((await api(alice, 'POST', '/api/desk', prompt)).status).toBe(200);
    expect(await laptop.waitFor((m) => m.type === 'desk')).toMatchObject({
      request: { action: { kind: 'prompt', sessionId, text: 'Add a median helper' } },
    });
    // Viewers can't have an agent in the session; an empty prompt is no prompt.
    const daveDesk = await connect(h, dave.token);
    await daveDesk.waitFor((m) => m.type === 'welcome');
    expect((await api(dave, 'POST', '/api/desk', prompt)).status).toBe(403);
    daveDesk.close();
    expect(
      (
        await api(alice, 'POST', '/api/desk', {
          action: { kind: 'prompt', sessionId, text: '   ' },
        })
      ).status,
    ).toBe(400);
    laptop.close();
  });

  it('passes guidance from the phone to the machine running the lane', async () => {
    // Bob's machine is gone: he hears nothing, the phone hears why.
    const offline = await api(alice, 'POST', `/api/sessions/${sessionId}/steer`, {
      laneUserId: bob.id,
      text: 'Use the cache',
    });
    expect(offline.status).toBe(409);
    expect(offline.body.error.message).toMatch(/machine is offline/);

    const bobDesk = await connect(h, bob.token);
    await bobDesk.waitFor((m) => m.type === 'welcome');
    const sent = await api(alice, 'POST', `/api/sessions/${sessionId}/steer`, {
      laneUserId: bob.id,
      text: 'Use the cache',
    });
    expect(sent.status).toBe(200);
    expect(await bobDesk.waitFor((m) => m.type === 'steer')).toMatchObject({
      laneUserId: bob.id,
      fromName: 'alice',
      text: 'Use the cache',
    });
    // A viewer can watch but not steer.
    expect(
      (
        await api(dave, 'POST', `/api/sessions/${sessionId}/steer`, {
          laneUserId: bob.id,
          text: 'hi',
        })
      ).status,
    ).toBe(403);
    bobDesk.close();
  });
});
