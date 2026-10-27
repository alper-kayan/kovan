import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mcpToolName, parseMcpConfig, secretValues, type McpServerConfig } from './config.js';
import { McpConnection, McpHub } from './connection.js';
import { MASK, maskSecrets, resultText } from './content.js';
import { signIn, type OAuthState, type OAuthStore } from './oauth.js';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fake-server.mjs');
const stdio = (env: Record<string, string> = {}): McpServerConfig => ({
  type: 'stdio',
  command: process.execPath,
  args: [FAKE],
  env,
});

let dir: string;
const open: McpConnection[] = [];
const connect = (config: McpServerConfig, name = 'fake') => {
  const c = new McpConnection(name, config, { cwd: dir, startTimeoutMs: 15_000 });
  open.push(c);
  return c;
};
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kovan-mcp-'));
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('config', () => {
  it("reads Claude Code's .mcp.json, expanding variables and reporting what can't be used", () => {
    const parsed = parseMcpConfig(
      {
        mcpServers: {
          files: { command: 'npx', args: ['-y', 'server', '${HOME}'], env: { TOKEN: '${TOKEN}' } },
          remote: {
            type: 'http',
            url: '${BASE:-https://mcp.example.com}/mcp',
            headers: { A: 'b' },
          },
          sse: { type: 'sse', url: 'https://x.example.com/sse' },
          missing: { command: 'x', env: { K: '${NOPE}' } },
          'bad name!': { command: 'x' },
          nothing: {},
          ftp: { url: 'ftp://x' },
        },
      },
      { HOME: '/home/a', TOKEN: 'secret-token' },
    );
    expect(parsed.servers['files']).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'server', '/home/a'],
      env: { TOKEN: 'secret-token' },
    });
    expect(parsed.servers['remote']).toEqual({
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { A: 'b' },
    });
    expect(parsed.servers['sse']?.type).toBe('http');
    expect(parsed.problems.map((p) => p.name).sort()).toEqual(
      ['bad name!', 'ftp', 'missing', 'nothing'].sort(),
    );
    expect(parsed.problems.find((p) => p.name === 'missing')?.problem).toBe('Not set: NOPE');
  });

  it('names tools for the model within 64 characters', () => {
    expect(mcpToolName('github', 'create_issue')).toBe('mcp__github__create_issue');
    expect(mcpToolName('my server', 'a.b')).toBe('mcp__my_server__a_b');
    const long = mcpToolName('s'.repeat(30), 't'.repeat(60));
    expect(long).toHaveLength(64);
    expect(long).not.toBe(mcpToolName('s'.repeat(30), `${'t'.repeat(59)}u`));
  });

  it('hides secrets: values under secret-looking names and the server’s own secrets', () => {
    const config = stdio({ GITHUB_TOKEN: 'ghp_abcdef123456', DEBUG: '1' });
    const masked = maskSecrets(
      { query: 'repo', apiKey: 'k-123', nested: { note: 'use ghp_abcdef123456 here' } },
      secretValues(config),
    );
    expect(masked).toEqual({ query: 'repo', apiKey: MASK, nested: { note: `use ${MASK} here` } });
  });

  it('turns images, resources and structured results into text and cuts long ones', () => {
    expect(
      resultText({
        content: [
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'resource', resource: { uri: 'file:///a.txt', text: 'hello' } },
          { type: 'resource_link', uri: 'https://x', name: 'X' },
        ],
      }),
    ).toBe('[image: image/png, 3 bytes]\n[resource file:///a.txt]\nhello\n[link: X https://x]');
    expect(resultText({ content: [], structuredContent: { a: 1 } })).toBe('{\n  "a": 1\n}');
    expect(resultText({ content: [{ type: 'text', text: 'abcdef' }] }, 3)).toBe(
      'abc\n… cut: the tool returned 6 characters',
    );
  });
});

describe('a stdio server', () => {
  it('starts when first needed, lists tools and calls them', async () => {
    const c = connect(stdio({ FAKE_TOKEN: 'tok-42' }));
    expect(c.status).toBe('idle');
    const tools = await c.listTools();
    expect(c.status).toBe('ready');
    expect(tools.find((t) => t.name === 'echo')).toMatchObject({
      readOnly: true,
      description: 'Says the text back',
    });
    expect(tools.find((t) => t.name === 'save_note')?.readOnly).toBe(false);
    expect(await c.callTool('echo', { text: 'hi' })).toEqual({ text: 'echo: hi', isError: false });
    expect(await c.callTool('env', {})).toEqual({ text: 'token is tok-42', isError: false });
    expect((await c.callTool('picture', {})).text).toBe(
      'Here it is\n[image: image/png, 300 bytes]',
    );
    expect((await c.callTool('big', {})).text).toContain('… cut: the tool returned 100000');
    expect(await c.callTool('fail', {})).toEqual({ text: 'it went wrong', isError: true });
  });

  it('times out a slow call and can be stopped', async () => {
    const c = connect(stdio());
    const late = await c.callTool('slow', { ms: 5000 }, { timeoutMs: 300 });
    expect(late.isError).toBe(true);
    expect(late.text).toMatch(/timed out/i);
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 200);
    const stopped = await c.callTool('slow', { ms: 5000 }, { signal: abort.signal });
    expect(stopped.isError).toBe(true);
    // Still usable after both.
    expect((await c.callTool('echo', { text: 'ok' })).text).toBe('echo: ok');
  });

  it('starts again once after a crash, not twice', async () => {
    const starts = join(dir, 'starts.txt');
    const c = connect(stdio({ FAKE_STARTS: starts }));
    const crashed = await c.callTool('crash', {});
    expect(crashed.isError).toBe(true);
    expect(crashed.text).toContain("isn't known whether it happened");
    expect(crashed.text).toContain('fake: crashing now');
    await new Promise((r) => setTimeout(r, 100));
    expect((await c.callTool('echo', { text: 'back' })).text).toBe('echo: back');
    await c.callTool('crash', {});
    await new Promise((r) => setTimeout(r, 100));
    expect(c.status).toBe('failed');
    await expect(c.callTool('echo', { text: 'x' })).rejects.toThrow(/stopped again/);
    expect((await readFile(starts, 'utf8')).trim().split('\n')).toHaveLength(2);
  });

  it("says why a server didn't start", async () => {
    const c = connect(stdio({ FAKE_FAIL_START: '1' }));
    await expect(c.listTools()).rejects.toThrow(/didn't start[\s\S]*FAKE_FAIL_START is set/);
    expect(c.status).toBe('failed');
  });
});

describe('an HTTP server', () => {
  let child: ChildProcess;
  let url: string;
  beforeAll(async () => {
    child = spawn(process.execPath, [FAKE, '--http', '0'], {
      env: { ...process.env, FAKE_AUTH: 'h-secret' },
    });
    url = await new Promise<string>((resolve, reject) => {
      child.stdout!.on('data', (d: Buffer) => {
        const m = /listening (\d+)/.exec(d.toString());
        if (m) resolve(`http://127.0.0.1:${m[1]}/mcp`);
      });
      child.on('exit', () => reject(new Error('fake HTTP server exited')));
    });
  });
  afterAll(() => {
    child.kill();
  });

  it('calls tools with the configured headers', async () => {
    const c = connect({ type: 'http', url, headers: { Authorization: 'Bearer h-secret' } });
    expect((await c.listTools()).map((t) => t.name)).toContain('echo');
    expect((await c.callTool('echo', { text: 'over http' })).text).toBe('echo: over http');
  });

  it('fails clearly without them', async () => {
    const c = connect({ type: 'http', url, headers: {} });
    // A header it wants isn't a sign-in: it doesn't publish where to sign in.
    await expect(c.listTools()).rejects.toThrow(/didn't start[\s\S]*401/);
    expect(c.status).toBe('failed');
  });
});

function memoryStore(): OAuthStore & { data: Map<string, OAuthState> } {
  const data = new Map<string, OAuthState>();
  return {
    data,
    get: async (url) => structuredClone(data.get(url)),
    set: async (url, state) => {
      if (state) data.set(url, structuredClone(state));
      else data.delete(url);
    },
  };
}

/** Plays the browser: follows the authorization page's redirect to Kovan's loopback. */
async function browser(url: URL): Promise<void> {
  const page = await fetch(url, { redirect: 'manual' });
  await fetch(page.headers.get('location')!);
}

describe('a server that wants sign-in (OAuth)', () => {
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

  it('says so instead of opening a browser, then works after the person signs in', async () => {
    const url = `${base}/mcp`;
    const store = memoryStore();
    const before = new McpConnection(
      'remote',
      { type: 'http', url, headers: {} },
      {
        cwd: dir,
        oauth: store,
      },
    );
    open.push(before);
    await expect(before.listTools()).rejects.toThrow(/needs you to sign in/);
    expect(before.status).toBe('needs-auth');
    // Nothing was registered or saved without the person.
    expect(store.data.size).toBe(0);

    const opened: URL[] = [];
    await signIn(url, store, {
      open: async (u) => {
        opened.push(u);
        await browser(u);
      },
    });
    expect(opened[0]!.pathname).toBe('/authorize');
    expect(opened[0]!.searchParams.get('code_challenge_method')).toBe('S256');
    expect(store.data.get(url)?.tokens?.access_token).toMatch(/^at-/);

    const signed = new McpConnection(
      'remote',
      { type: 'http', url, headers: {} },
      {
        cwd: dir,
        oauth: store,
      },
    );
    open.push(signed);
    expect((await signed.callTool('echo', { text: 'signed in' })).text).toBe('echo: signed in');
  });

  it('asks for sign-in again when the server no longer takes the tokens', async () => {
    const url = `${base}/mcp`;
    const store = memoryStore();
    await signIn(url, store, { open: browser });
    await fetch(`${base}/forget`, { method: 'POST' });
    const c = new McpConnection(
      'remote',
      { type: 'http', url, headers: {} },
      {
        cwd: dir,
        oauth: store,
      },
    );
    open.push(c);
    await expect(c.listTools()).rejects.toThrow(/needs you to sign in/);
    expect(c.status).toBe('needs-auth');
  });

  it('gives up on a sign-in nobody finishes', async () => {
    await expect(
      signIn(`${base}/mcp`, memoryStore(), { open: () => undefined, timeoutMs: 300 }),
    ).rejects.toThrow(/timed out/);
  });
});

describe('the hub', () => {
  it('reuses a server, starts a new one when its config changes and stops old ones', async () => {
    const hub = new McpHub({ startTimeoutMs: 15_000 });
    const a = hub.connection('fake', stdio(), dir);
    expect(hub.connection('fake', stdio(), dir)).toBe(a);
    await a.listTools();
    const b = hub.connection('fake', stdio({ X: 'changed' }), dir);
    expect(b).not.toBe(a);
    await hub.keepOnly([b.key]);
    expect(a.status).toBe('closed');
    expect(hub.list()).toEqual([b]);
    await hub.closeAll();
    expect(b.status).toBe('closed');
  });
});
