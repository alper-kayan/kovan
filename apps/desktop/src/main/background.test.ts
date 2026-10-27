import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BackgroundAgents } from './background.js';

let dir: string;
let script: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kovan-background-'));
  // Stands in for agentd: writes down what it was given, then stays up like agentd does.
  script = join(dir, 'fake-agentd.mjs');
  await writeFile(
    script,
    `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(dir, 'seen.json'))}, JSON.stringify(process.env));
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
`,
  );
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const until = async (fn: () => Promise<boolean> | boolean) => {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('timed out');
};

describe('background agents', () => {
  it('makes a machine key, starts agentd on its own, and stops and revokes it when off', async () => {
    const calls: string[] = [];
    process.env['OPENROUTER_API_KEY'] = 'sk-or-app-only';
    const background = new BackgroundAgents({
      dataDir: dir,
      agentdScript: script,
      mcpScript: join(dir, 'claude-mcp.js'),
      execPath: process.execPath,
      serverUrl: 'http://kovan.test',
      request: async <T>(method: string, path: string) => {
        calls.push(`${method} ${path}`);
        if (path === '/api/me')
          return { orgs: [{ id: 'org-1', name: 'Acme', role: 'owner' }] } as T;
        if (method === 'POST') return { key: { id: 'key-1' }, token: 'kv_live_background' } as T;
        return {} as T;
      },
      checkouts: async () => ({ ws1: '/work/shop', ws2: '/work/blog' }),
      pathEnv: async () => '/usr/bin:/bin',
      encrypt: (text) => Buffer.from(`enc:${text}`),
      decrypt: (data) => data.toString().replace(/^enc:/, ''),
      log: () => undefined,
    });
    expect((await background.status()).enabled).toBe(false);
    const on = await background.enable();
    expect(on).toMatchObject({ enabled: true, running: true });
    expect(calls).toContain('POST /api/orgs/org-1/api-keys');
    await until(async () => Boolean(await readFile(join(dir, 'seen.json')).catch(() => null)));
    const seen = JSON.parse(await readFile(join(dir, 'seen.json'), 'utf8')) as Record<
      string,
      string
    >;
    expect(seen).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1',
      KOVAN_SERVER_URL: 'http://kovan.test',
      KOVAN_API_KEY: 'kv_live_background',
      KOVAN_REPOS: '/work/shop,/work/blog',
      PATH: '/usr/bin:/bin',
    });
    // None of the app's own secrets reach agentd's agents.
    expect(seen['OPENROUTER_API_KEY']).toBeUndefined();
    // The key is kept encrypted, never in the clear.
    expect(await readFile(join(dir, 'background-agents.json'), 'utf8')).not.toContain(
      'kv_live_background',
    );
    const off = await background.disable();
    expect(off.enabled).toBe(false);
    expect(calls).toContain('DELETE /api/orgs/org-1/api-keys/key-1');
    delete process.env['OPENROUTER_API_KEY'];
  });
});
