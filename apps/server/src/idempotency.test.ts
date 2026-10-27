import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { idempotencyKeys } from './db/schema.js';
import { HttpError } from './errors.js';
import { IDEMPOTENCY_STALE_MS, IDEMPOTENCY_TTL_MS } from './idempotency.js';
import { auth, oauthLogin, startHarness, type Harness } from './test/harness.js';

let h: Harness;
type Person = { token: string; id: string };
let alice: Person; // owner
let dave: Person; // viewer
let workspaceId: string;

async function api(person: Person, method: string, url: string, payload?: object, key?: string) {
  const res = await h.app.inject({
    method: method as 'GET',
    url,
    headers: { ...auth(person.token), ...(key ? { 'idempotency-key': key } : {}) },
    ...(payload ? { payload } : {}),
  });
  return {
    status: res.statusCode,
    replayed: res.headers['idempotent-replayed'] === 'true',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON in tests
    body: res.json() as Record<string, any>,
  };
}

beforeAll(async () => {
  h = await startHarness();
  const login = async (code: string, n: string) => {
    const r = await oauthLogin(h, 'github', code, { providerUserId: n, login: code, name: code });
    return { token: r.token, id: r.user.id };
  };
  alice = await login('alice', '1');
  dave = await login('dave', '4');
  const orgId = (await api(alice, 'GET', '/api/me')).body.orgs[0].id;
  workspaceId = (
    await api(alice, 'POST', '/api/workspaces', { orgId, name: 'lobby', repoUrl: null })
  ).body.workspace.id;
  await api(alice, 'POST', `/api/workspaces/${workspaceId}/invites`, {
    githubLogin: 'dave',
    role: 'viewer',
  });
});
afterAll(async () => {
  await h.close();
});

const sessionCount = async () =>
  (await api(alice, 'GET', `/api/workspaces/${workspaceId}/sessions`)).body.sessions.length;
const startSession = (title: string, key?: string, by = alice) =>
  api(by, 'POST', `/api/workspaces/${workspaceId}/sessions`, { title, branch: 'kovan/x' }, key);

describe('Idempotency-Key', () => {
  it('starts a session once and gives a retry the first answer', async () => {
    const before = await sessionCount();
    const first = await startSession('Retry me', 'start-1');
    const again = await startSession('Retry me', 'start-1');
    expect(first.status).toBe(200);
    expect(first.replayed).toBe(false);
    expect(again).toMatchObject({ status: 200, replayed: true });
    expect(again.body.session.id).toBe(first.body.session.id);
    expect(await sessionCount()).toBe(before + 1);

    // Without a key nothing changes: each request starts its own session.
    await startSession('No key');
    await startSession('No key');
    expect(await sessionCount()).toBe(before + 3);
  });

  it('refuses a key reused for a different request, and a malformed key', async () => {
    await startSession('One', 'start-2');
    const other = await startSession('Two', 'start-2');
    expect(other.status).toBe(422);
    expect(other.body.error.code).toBe('idempotency_mismatch');
    expect((await startSession('Bad', 'has space')).status).toBe(400);
    expect((await startSession('Bad', 'x'.repeat(256))).status).toBe(400);
  });

  it('keeps keys apart per caller, and answers a refusal afresh each time', async () => {
    const mine = await startSession('Mine', 'shared-key');
    expect(mine.status).toBe(200);
    // Dave may only watch: refused, and nothing is kept for his key.
    const refused = await startSession('Mine', 'shared-key', dave);
    expect(refused).toMatchObject({ status: 403, replayed: false });
    const again = await startSession('Mine', 'shared-key', dave);
    expect(again).toMatchObject({ status: 403, replayed: false });
  });

  it('launches a swarm once', async () => {
    const s = (await startSession('Swarm')).body.session;
    const lead = (
      await api(alice, 'POST', `/api/workspaces/${workspaceId}/agents`, {
        name: 'Wren',
        model: 'openai/gpt-5.6-luna',
        instructions: 'Wren writes small, tested changes.',
      })
    ).body.agent;
    const draft = (
      await api(alice, 'PUT', `/api/sessions/${s.id}/swarm`, {
        goal: 'Add a helper',
        leadAgentId: lead.id,
        agentIds: [lead.id],
        budget: 0.05,
      })
    ).body.swarm;
    const first = await api(alice, 'POST', `/api/swarms/${draft.id}/launch`, undefined, 'go-1');
    const again = await api(alice, 'POST', `/api/swarms/${draft.id}/launch`, undefined, 'go-1');
    expect(first.body).toMatchObject({ resumed: false, swarm: { status: 'running' } });
    expect(again.replayed).toBe(true);
    expect(again.body).toEqual(first.body);
    // A new key is a new request: the swarm is already running, so that one is refused.
    expect(
      (await api(alice, 'POST', `/api/swarms/${draft.id}/launch`, undefined, 'go-2')).status,
    ).toBe(409);
  });
});

describe('Idempotency service', () => {
  const request = (key: string, body: object = {}) =>
    ({
      headers: { 'idempotency-key': key },
      method: 'POST',
      url: '/x',
      body,
    }) as unknown as FastifyRequest;
  const reply = () => {
    const r = {
      statusCode: 200,
      headers: {} as Record<string, string>,
      header(k: string, v: string) {
        r.headers[k] = v;
        return r;
      },
      code(c: number) {
        r.statusCode = c;
        return r;
      },
    };
    return r as unknown as FastifyReply & { headers: Record<string, string> };
  };
  const row = async (key: string) =>
    (await h.ctx.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key)))[0];

  it('tells a retry that arrives while the first is running to wait', async () => {
    let finish!: () => void;
    const slow = h.ctx.idempotency.run(request('slow'), reply(), 'test', async () => {
      await new Promise<void>((resolve) => (finish = resolve));
      return { ok: 1 };
    });
    await new Promise((r) => setTimeout(r, 50));
    await expect(
      h.ctx.idempotency.run(request('slow'), reply(), 'test', async () => ({ ok: 2 })),
    ).rejects.toMatchObject({ status: 409 });
    finish();
    expect(await slow).toEqual({ ok: 1 });
    expect(await h.ctx.idempotency.run(request('slow'), reply(), 'test', async () => 2)).toEqual({
      ok: 1,
    });
  });

  it('frees the key after a server failure, so a retry runs', async () => {
    let runs = 0;
    const fail = async () => {
      runs++;
      throw new Error('database went away');
    };
    await expect(h.ctx.idempotency.run(request('boom'), reply(), 'test', fail)).rejects.toThrow();
    expect(await row('boom')).toBeUndefined();
    const ok = await h.ctx.idempotency.run(request('boom'), reply(), 'test', async () => {
      runs++;
      return { ok: true };
    });
    expect(ok).toEqual({ ok: true });
    expect(runs).toBe(2);
    // A refusal ("every machine is busy") started nothing: the same key runs again later.
    await expect(
      h.ctx.idempotency.run(request('no'), reply(), 'test', async () => {
        throw new HttpError(409, 'conflict', 'Every machine is busy');
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await row('no')).toBeUndefined();
    const r = reply();
    expect(await h.ctx.idempotency.run(request('no'), r, 'test', async () => 'ran')).toBe('ran');
    expect(r.headers['idempotent-replayed']).toBeUndefined();
  });

  it('frees a key left running by a crash, and forgets answers after a day', async () => {
    await h.ctx.db.insert(idempotencyKeys).values({
      owner: 'test',
      key: 'crashed',
      fingerprint: 'x',
      status: 'pending',
      createdAt: new Date(Date.now() - IDEMPOTENCY_STALE_MS - 1000),
    });
    expect(
      await h.ctx.idempotency.run(request('crashed'), reply(), 'test', async () => 'ran'),
    ).toBe('ran');

    await h.ctx.db
      .update(idempotencyKeys)
      .set({ createdAt: new Date(Date.now() - IDEMPOTENCY_TTL_MS - 1000) })
      .where(eq(idempotencyKeys.key, 'crashed'));
    expect(await h.ctx.idempotency.sweep()).toBeGreaterThanOrEqual(1);
    expect(await row('crashed')).toBeUndefined();
  });
});
