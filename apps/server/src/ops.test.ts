import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ServerErrors } from './errorLog.js';
import { auth, oauthLogin, startHarness, type Harness } from './test/harness.js';

let h: Harness;
let operatorToken = '';
const OPS_TOKEN = 'o'.repeat(40);
const dir = mkdtempSync(join(tmpdir(), 'kovan-ops-'));
const statusFile = join(dir, 'status.json');

beforeAll(async () => {
  h = await startHarness({
    OPS_TOKEN,
    OPS_EMAIL: 'Operator@Example.com',
    OPS_STATUS_FILE: statusFile,
  });
  for (const [login, email, token] of [
    ['op', 'operator@example.com', 'ios-token-operator'],
    ['bob', 'bob@example.com', 'ios-token-bob'],
  ] as const) {
    const user = await oauthLogin(h, 'github', login, {
      providerUserId: login,
      login,
      name: login,
      email,
      emailVerified: true,
    });
    if (login === 'op') operatorToken = user.token;
    await h.app.inject({
      method: 'POST',
      url: '/api/push/devices',
      headers: auth(user.token),
      payload: { platform: 'ios', token, sandbox: true },
    });
  }
});

afterAll(async () => {
  await h.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the outside monitor’s phones', () => {
  it('are only the operator’s, and only for the ops token', async () => {
    const get = (token?: string) =>
      h.app.inject({
        method: 'GET',
        url: '/api/ops/push-targets',
        ...(token ? { headers: auth(token) } : {}),
      });
    expect((await get()).statusCode).toBe(401);
    expect((await get('x'.repeat(40))).statusCode).toBe(401);
    const res = await get(OPS_TOKEN);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      devices: [{ platform: 'ios', token: 'ios-token-operator', sandbox: true }],
    });
  });

  it('the host’s report: only for the ops token, 404 until the host wrote one', async () => {
    const get = (token: string) =>
      h.app.inject({ method: 'GET', url: '/api/ops/status', headers: auth(token) });
    expect((await get(OPS_TOKEN)).statusCode).toBe(404);
    writeFileSync(statusFile, JSON.stringify({ at: '2026-10-25T09:00:00Z', disks: [] }));
    expect((await get('x'.repeat(40))).statusCode).toBe(401);
    const res = await get(OPS_TOKEN);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ at: '2026-10-25T09:00:00Z', disks: [] });
  });

  it('what failed, grouped by kind without ids or numbers, after a time', async () => {
    const before = new Date(Date.now() - 1000).toISOString();
    const errors = new ServerErrors(h.ctx.db, 2);
    for (const id of [
      '3f1c2a9e-1b2c-4d5e-8f90-123456789abc',
      '9a8b7c6d-1b2c-4d5e-8f90-abcdefabcdef',
    ])
      errors.record('GET /api/sessions/:id', new Error(`session ${id} has no lane 4`));
    errors.record('GET /api/sessions/:id', new Error('over the cap'));
    expect(errors.dropped).toBe(1);
    await h.app.inject({
      method: 'POST',
      url: '/api/error-reports',
      headers: auth(operatorToken),
      payload: {
        message: 'TypeError: x is undefined\n at y',
        stack: null,
        source: 'renderer',
        appVersion: '0.1.0',
        platform: 'darwin',
      },
    });
    await new Promise((r) => setTimeout(r, 200));
    const get = (since: string, token = OPS_TOKEN) =>
      h.app.inject({
        method: 'GET',
        url: `/api/ops/errors?since=${encodeURIComponent(since)}`,
        headers: auth(token),
      });
    expect((await get(before, 'x'.repeat(40))).statusCode).toBe(401);
    const res = await get(before);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups).toEqual([
      expect.objectContaining({
        key: 'server|GET /api/sessions/:id: Error: session <id> has no lane <n>',
        count: 2,
        source: 'server',
      }),
      expect.objectContaining({
        key: 'renderer|TypeError: x is undefined',
        message: 'TypeError: x is undefined',
        count: 1,
      }),
    ]);
    expect((await get(body.now)).json().groups).toEqual([]);
  });
});
