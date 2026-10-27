import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pushCommands, pushProblem } from './gitRelay.js';
import { auth, oauthLogin, startHarness, type Harness } from './test/harness.js';

const TOKEN = 'ghp_relaytest_1234';
let h: Harness;
let host: Server;
let dir: string;
let owner: string;
let workspaceId: string;
let machineKey: string;
let readKey: string;
let base: string;

const run = promisify(execFile);
/** Async: the server and the git host answer from this same process. */
const git = async (cwd: string, ...args: string[]) =>
  (
    await run('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: 60_000,
    })
  ).stdout;

/** A git host for the test: `git http-backend` behind a token check, like GitHub's. */
function gitHost(root: string): Server {
  return createServer((req, res) => {
    const expected = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`;
    if (req.headers.authorization !== expected) {
      res.writeHead(401).end();
      return;
    }
    const url = new URL(req.url!, 'http://host');
    const cgi = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        REQUEST_METHOD: req.method!,
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        HTTP_CONTENT_ENCODING: String(req.headers['content-encoding'] ?? ''),
        REMOTE_USER: 'relay',
      },
    });
    req.pipe(cgi.stdin);
    let out = Buffer.alloc(0);
    let sent = false;
    cgi.stdout.on('data', (chunk: Buffer) => {
      if (sent) {
        res.write(chunk);
        return;
      }
      out = Buffer.concat([out, chunk]);
      const end = out.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = out.subarray(0, end).toString().split('\r\n');
      const status = Number(head.find((l) => l.startsWith('Status:'))?.split(' ')[1] ?? 200);
      const headers = Object.fromEntries(
        head
          .filter((l) => !l.startsWith('Status:'))
          .map((l) => l.split(/:\s*/, 2) as [string, string]),
      );
      res.writeHead(status, headers);
      res.write(out.subarray(end + 4));
      sent = true;
    });
    cgi.on('close', () => res.end());
  });
}

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

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kovan-relay-'));
  // The "GitHub" repository, with one commit on main.
  const bare = join(dir, 'hosts', 'github.com', 'acme', 'shop.git');
  await git(dir, 'init', '-q', '--bare', '-b', 'main', bare);
  await git(bare, 'config', 'http.receivepack', 'true');
  const seed = join(dir, 'seed');
  await git(dir, 'clone', '-q', bare, seed);
  await git(seed, 'config', 'user.email', 's@example.com');
  await git(seed, 'config', 'user.name', 's');
  await writeFile(join(seed, 'README.md'), 'shop\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-qm', 'start');
  await git(seed, 'push', '-q', 'origin', 'HEAD:main');

  host = gitHost(join(dir, 'hosts'));
  await new Promise<void>((r) => host.listen(0, '127.0.0.1', r));
  const port = (host.address() as AddressInfo).port;
  h = await startHarness({ KOVAN_GIT_UPSTREAM: `http://127.0.0.1:${port}` });
  owner = (
    await oauthLogin(h, 'github', 'alice', { providerUserId: '1', login: 'alice', name: 'Alice' })
  ).token;
  const orgId = (await api(owner, 'GET', '/api/me')).body.orgs[0].id;
  workspaceId = (
    await api(owner, 'POST', '/api/workspaces', {
      orgId,
      name: 'shop',
      repoUrl: 'github.com/acme/shop',
    })
  ).body.workspace.id;
  const key = async (name: string, scopes: string[]) =>
    (await api(owner, 'POST', `/api/workspaces/${workspaceId}/api-keys`, { name, scopes })).body
      .token as string;
  machineKey = await key('pi', ['machine']);
  readKey = await key('reader', ['read']);
  base = `${h.wsUrl.replace(/^ws/, 'http').replace(/\/ws$/, '')}/api/workspaces/${workspaceId}/git`;
});
afterAll(async () => {
  await h.close();
  host.close();
  await rm(dir, { recursive: true, force: true });
});

describe('git through Kovan', () => {
  it('reads the commands of a push and refuses main and foreign deletes', () => {
    const line = (s: string) => `${(s.length + 4).toString(16).padStart(4, '0')}${s}`;
    const old = 'a'.repeat(40);
    const head = Buffer.from(
      line(`${old} ${'b'.repeat(40)} refs/heads/kovan/x\0report-status`) +
        line(`${old} ${'0'.repeat(40)} refs/heads/feature`) +
        '0000PACK',
    );
    const commands = pushCommands(head)!;
    expect(commands.map((c) => c.ref)).toEqual(['refs/heads/kovan/x', 'refs/heads/feature']);
    expect(pushCommands(head.subarray(0, 20))).toBeNull();
    expect(pushProblem([commands[0]!], 'main')).toBeNull();
    expect(pushProblem(commands, 'main')).toMatch(/only deletes branches it made/);
    expect(pushProblem([{ ...commands[0]!, ref: 'refs/heads/main' }], 'main')).toMatch(
      /doesn't push to main/,
    );
  });

  it("keeps the owner's token only once the git host accepts it", async () => {
    const url = `/api/workspaces/${workspaceId}/git-access`;
    expect((await api(owner, 'PUT', url, { token: 'ghp_wrong_token' })).status).toBe(400);
    expect((await api(owner, 'GET', url)).body.access.configured).toBe(false);
    expect((await api(owner, 'PUT', url, { token: TOKEN })).status).toBe(200);
    const access = (await api(machineKey, 'GET', url)).body.access;
    expect(access).toMatchObject({ configured: true, relayUrl: expect.stringContaining('/git') });
    expect(JSON.stringify(access)).not.toContain(TOKEN);
  });

  it('lets a machine clone and push its branch with its Kovan key, never to main', async () => {
    const work = join(dir, 'machine');
    const as = (key: string) => ['-c', `http.extraHeader=Authorization: Bearer ${key}`];
    await git(dir, ...as(machineKey), 'clone', '-q', base, work);
    await git(work, 'config', 'user.email', 'm@example.com');
    await git(work, 'config', 'user.name', 'm');
    await git(work, 'checkout', '-qb', 'kovan/discount');
    await writeFile(join(work, 'discount.js'), 'export const d = 1;\n');
    await git(work, 'add', '.');
    await git(work, 'commit', '-qm', 'discount');
    await git(work, ...as(machineKey), 'push', '-q', 'origin', 'kovan/discount');
    expect(await git(join(dir, 'hosts', 'github.com', 'acme', 'shop.git'), 'branch')).toContain(
      'kovan/discount',
    );
    // main is the person's: refused.
    await expect(git(work, ...as(machineKey), 'push', '-q', 'origin', 'HEAD:main')).rejects.toThrow(
      /403/,
    );
    // A read key fetches, but doesn't push.
    await git(work, ...as(readKey), 'fetch', '-q', 'origin');
    await expect(
      git(work, ...as(readKey), 'push', '-q', 'origin', 'HEAD:kovan/other'),
    ).rejects.toThrow();
    // Without a Kovan key, nothing.
    await expect(git(dir, 'clone', '-q', base, join(dir, 'nobody'))).rejects.toThrow();
  });
});
