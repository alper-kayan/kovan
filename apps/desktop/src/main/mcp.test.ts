import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServerInput } from '../shared/api.js';
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings.js';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`),
    decryptString: (b: Buffer) =>
      Buffer.from(b.toString().replace(/^enc:/, ''), 'base64').toString(),
  },
}));

const { McpRegistry } = await import('./mcp.js');
type Registry = InstanceType<typeof McpRegistry>;

const FAKE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/mcp-client/test/fake-server.mjs',
);

let dir: string;
let repo: string;
let registry: Registry;
let settings: Settings;
const make = () =>
  new McpRegistry({
    userData: dir,
    settings: async () => settings,
    path: async () => process.env['PATH'] ?? '',
    version: 'test',
  });
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kovan-mcp-reg-'));
  repo = join(dir, 'repo');
  await mkdir(repo);
  settings = { ...DEFAULT_SETTINGS };
  registry = make();
});
afterEach(async () => {
  await registry.stop();
  await rm(dir, { recursive: true, force: true });
});

const servers = (map: object) =>
  writeFile(join(dir, 'mcp-servers.json'), JSON.stringify({ mcpServers: map }));
const signal = new AbortController().signal;
const ctx = () => ({ root: repo, isRepo: false, signal });
const input = (over: Partial<McpServerInput> = {}): McpServerInput => ({
  name: 'fake',
  previousName: null,
  type: 'stdio',
  command: process.execPath,
  args: [FAKE],
  url: '',
  env: [],
  headers: [],
  ...over,
});
const names = (tools: { spec: { name: string } }[]) => tools.map((t) => t.spec.name);

describe('McpRegistry', () => {
  it('gives agents a server\'s tools, masks its secrets, and remembers "always allow"', async () => {
    await servers({
      fake: { command: process.execPath, args: [FAKE], env: { FAKE_TOKEN: 'sk-very-secret' } },
      broken: { command: process.execPath, args: [FAKE], env: { FAKE_FAIL_START: '1' } },
    });
    const tools = await registry.toolsFor(dir);
    const echo = tools.find((t) => t.spec.name === 'mcp__fake__echo')!;
    expect(echo).toMatchObject({ kind: 'external', readOnly: true, origin: 'fake · echo' });
    expect(tools.find((t) => t.spec.name === 'mcp__fake__save_note')?.readOnly).toBe(false);
    expect(tools.some((t) => t.spec.name.startsWith('mcp__broken__'))).toBe(false);
    expect(registry.states().find((s) => s.name === 'broken')).toMatchObject({ status: 'failed' });

    const env = tools.find((t) => t.spec.name === 'mcp__fake__env')!;
    const out = await env.run({}, { root: dir, isRepo: false, signal });
    expect(out.output).toBe('token is ••••••');
    expect(env.display!({ note: 'sk-very-secret' })).toEqual({ note: '••••••' });
    expect(await echo.run({ text: 'hi' }, { root: dir, isRepo: false, signal })).toEqual({
      ok: true,
      output: 'echo: hi',
    });

    expect(echo.allowed!()).toBe(false);
    registry.allow(['mcp__fake__echo']);
    expect(echo.allowed!()).toBe(true);
  });

  it('stops a server once it leaves the list, and has none without a file', async () => {
    expect(await registry.toolsFor(dir)).toEqual([]);
    await servers({ fake: { command: process.execPath, args: [FAKE] } });
    expect((await registry.toolsFor(dir)).length).toBeGreaterThan(0);
    await servers({});
    expect(await registry.toolsFor(dir)).toEqual([]);
    await writeFile(join(dir, 'mcp-servers.json'), '{ broken');
    expect((await registry.personal()).problems[0]?.problem).toMatch(/can't be read/);
  });
});

describe("the person's servers in Settings", () => {
  it('keeps values in the keychain, not in the file, through edits and renames', async () => {
    await registry.save(input({ env: [{ name: 'FAKE_TOKEN', value: 'tok-123456' }] }));
    const file = await readFile(join(dir, 'mcp-servers.json'), 'utf8');
    expect(file).not.toContain('tok-123456');
    expect(JSON.parse(file).mcpServers.fake.env).toEqual({ FAKE_TOKEN: '' });
    expect((await readFile(join(dir, 'mcp-secrets.bin'))).toString()).not.toContain('tok-123456');

    const run = async (server = 'fake') => {
      const env = (await registry.toolsFor(repo)).find(
        (t) => t.spec.name === `mcp__${server}__env`,
      )!;
      return (await env.run({}, ctx())).output;
    };
    // The real value reached the server (it comes back masked, so it was the secret).
    expect(await run()).toBe('token is ••••••');

    // Editing without retyping keeps the value; renaming takes it along.
    await registry.save(
      input({ name: 'renamed', previousName: 'fake', env: [{ name: 'FAKE_TOKEN', value: null }] }),
    );
    expect(await run('renamed')).toBe('token is ••••••');
    const listing = await registry.listing(repo);
    expect(listing.servers).toEqual([
      expect.objectContaining({ name: 'renamed', source: 'personal', envNames: ['FAKE_TOKEN'] }),
    ]);

    await registry.remove('renamed');
    expect((await registry.listing(repo)).servers).toEqual([]);
    await expect(readFile(join(dir, 'mcp-secrets.bin'))).rejects.toThrow();
  });

  it('turns servers off and on, refuses bad input, and tests a form without saving', async () => {
    await registry.save(input());
    await registry.setEnabled('fake', false);
    expect(await registry.toolsFor(repo)).toEqual([]);
    expect((await registry.listing(repo)).servers[0]).toMatchObject({
      status: 'off',
      enabled: false,
    });
    await registry.setEnabled('fake', true);
    expect(names(await registry.toolsFor(repo))).toContain('mcp__fake__echo');

    await expect(registry.save(input({ name: 'bad name' }))).rejects.toThrow(/letters, digits/);
    await expect(registry.save(input())).rejects.toThrow(/already a server named fake/);
    await expect(registry.save(input({ name: 'x', command: '' }))).rejects.toThrow(/command/);

    const ok = await registry.test(input({ name: 'draft' }), repo);
    expect(ok).toMatchObject({ ok: true, needsSignIn: false });
    expect(ok.tools).toContain('echo');
    const failed = await registry.test(
      input({ name: 'draft', env: [{ name: 'FAKE_FAIL_START', value: '1' }] }),
      repo,
    );
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/FAKE_FAIL_START is set/);
    // Testing saved nothing.
    expect((await registry.listing(repo)).servers.map((s) => s.name)).toEqual(['fake']);
  });
});

describe("a repository's .mcp.json", () => {
  const repoServers = (map: object, file = '.mcp.json') =>
    mkdir(dirname(join(repo, file)), { recursive: true }).then(() =>
      writeFile(join(repo, file), JSON.stringify({ mcpServers: map })),
    );
  const fake = { command: process.execPath, args: [FAKE] };

  it("doesn't start until the person allows it, and asks again when it changes", async () => {
    await repoServers({ repofake: fake });
    // Nobody to ask (a Swarm agent): not started.
    expect(await registry.toolsFor(repo)).toEqual([]);
    expect((await registry.listing(repo)).servers[0]).toMatchObject({
      name: 'repofake',
      source: 'repo',
      file: '.mcp.json',
      status: 'untrusted',
      trust: 'ask',
    });

    const asked: string[] = [];
    const no = async (q: { name: string; detail: string }) => {
      asked.push(q.detail);
      return false;
    };
    expect(await registry.toolsFor(repo, no)).toEqual([]);
    expect(asked[0]).toContain(`Runs ${process.execPath} ${FAKE}`);

    // Once: until Kovan quits, without asking again.
    const yes = vi.fn(async () => true);
    expect(names(await registry.toolsFor(repo, yes))).toContain('mcp__repofake__echo');
    expect(names(await registry.toolsFor(repo, yes))).toContain('mcp__repofake__echo');
    expect(yes).toHaveBeenCalledTimes(1);
    expect(names(await registry.toolsFor(repo))).toContain('mcp__repofake__echo');
    await registry.stop();
    registry = make();
    expect(await registry.toolsFor(repo)).toEqual([]);

    // Always: saved, for this content only.
    const key = (await registry.listing(repo)).servers[0]!.trustKey!;
    await registry.trust(key, 'always', repo);
    await registry.stop();
    registry = make();
    expect(names(await registry.toolsFor(repo))).toContain('mcp__repofake__echo');
    await repoServers({ repofake: { ...fake, env: { EXTRA: '1' } } });
    const again = vi.fn(async () => false);
    expect(await registry.toolsFor(repo, again)).toEqual([]);
    expect(again).toHaveBeenCalledTimes(1);
  });

  it('remembers "no", and a repository server replaces a personal one of the same name', async () => {
    await registry.save(input());
    await repoServers({ fake: { ...fake, env: { FAKE_TOKEN: 'repo' } } }, '.kovan/mcp.json');
    let listing = await registry.listing(repo);
    expect(listing.servers.find((s) => s.source === 'personal')?.hidden).toBe(true);
    const key = listing.servers.find((s) => s.source === 'repo')!.trustKey!;

    await registry.trust(key, 'deny', repo);
    const ask = vi.fn(async () => true);
    // Declined: neither the repository's nor (shadowed) the personal one runs.
    expect(await registry.toolsFor(repo, ask)).toEqual([]);
    expect(ask).not.toHaveBeenCalled();
    listing = await registry.listing(repo);
    expect(listing.servers.find((s) => s.source === 'repo')).toMatchObject({ trust: 'deny' });

    await registry.trust(key, 'always', repo);
    const env = (await registry.toolsFor(repo)).find((t) => t.spec.name === 'mcp__fake__env')!;
    expect((await env.run({}, ctx())).output).toBe('token is repo');
    // Elsewhere the person's own server is the one, and the repository's keeps running.
    expect(names(await registry.toolsFor(dir))).toContain('mcp__fake__echo');
    expect((await env.run({}, ctx())).output).toBe('token is repo');
  });
});

describe('a remote server with sign-in', () => {
  let child: ChildProcess;
  let base: string;
  beforeAll(async () => {
    child = spawn(process.execPath, [FAKE, '--http', '0'], {
      env: { ...process.env, FAKE_OAUTH: '1' },
    });
    base = await new Promise<string>((resolve, reject) => {
      child.stdout!.on('data', (d: Buffer) => {
        const m = /listening (\d+)/.exec(d.toString());
        if (m) resolve(`http://127.0.0.1:${m[1]}`);
      });
      child.on('exit', () => reject(new Error('fake OAuth server exited')));
    });
  });
  afterAll(() => {
    child.kill();
  });

  it('shows "sign in", signs in through the browser and keeps the tokens in the keychain', async () => {
    await registry.save(
      input({ name: 'remote', type: 'http', url: `${base}/mcp`, command: '', args: [] }),
    );
    expect(await registry.toolsFor(repo)).toEqual([]);
    expect((await registry.listing(repo)).servers[0]).toMatchObject({
      status: 'needs-auth',
      signedIn: false,
    });

    const opened: string[] = [];
    const result = await registry.signIn('remote', repo, async (url) => {
      opened.push(url.href);
      const page = await fetch(url, { redirect: 'manual' });
      await fetch(page.headers.get('location')!);
    });
    expect(opened).toHaveLength(1);
    expect(result).toMatchObject({ ok: true });
    expect(result.tools).toContain('echo');
    expect((await registry.listing(repo)).servers[0]).toMatchObject({
      status: 'ready',
      signedIn: true,
    });
    const secrets = (await readFile(join(dir, 'mcp-secrets.bin'))).toString();
    expect(secrets).not.toContain('at-');
    expect(await readFile(join(dir, 'mcp-servers.json'), 'utf8')).not.toContain('at-');

    // A new start reads the saved sign-in.
    await registry.stop();
    registry = make();
    expect(names(await registry.toolsFor(repo))).toContain('mcp__remote__echo');

    await registry.signOut('remote', repo);
    expect(await registry.toolsFor(repo)).toEqual([]);
    expect((await registry.listing(repo)).servers[0]?.signedIn).toBe(false);
  });
});
