import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { combineNotches, createHookNotch, doingOf, hookConfig } from './hook-notch.js';
import { NOOP_NOTCH, type Notch } from './notch.js';

let server: Server | null = null;
afterEach(() => server?.close());

/** A stand-in status server: records what it is told and answers approvals as a script says. */
async function fakeHook(answerAfter: number | null, answer = 'allow') {
  const live: Record<string, unknown>[] = [];
  const asked: Record<string, unknown>[] = [];
  const closed: string[] = [];
  const headers: (string | undefined)[] = [];
  let polls = 0;
  server = createServer((req, res) => {
    headers.push(
      (req.headers['authorization'] ?? req.headers['x-hook-token']) as string | undefined,
    );
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const url = new URL(req.url!, 'http://x');
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/api/kovan/live') {
        live.push(JSON.parse(body));
        return res.end('{"ok":true}');
      }
      if (url.pathname === '/api/kovan/approval' && req.method === 'POST') {
        asked.push(JSON.parse(body));
        return res.end('{"ok":true,"id":"q1"}');
      }
      if (url.pathname === '/api/kovan/approval' && req.method === 'DELETE') {
        closed.push(url.searchParams.get('id')!);
        return res.end('{"ok":true}');
      }
      polls++;
      const done = answerAfter !== null && polls > answerAfter;
      res.end(JSON.stringify({ ok: true, status: done ? answer : 'pending' }));
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, live, asked, closed, headers };
}

const opts = (url: string) => ({
  config: { url, token: 'T', tokenHeader: null },
  sessionId: () => 's1',
  cwd: '/proje',
  title: () => 'sohbet',
  pollSeconds: 0,
});

describe('hook notch', () => {
  it('reads the address and token from the environment or ~/.kovan/hook.env, and is off without them', () => {
    const home = mkdtempSync(join(tmpdir(), 'kv-home-'));
    expect(hookConfig({}, home)).toBeNull();
    mkdirSync(join(home, '.kovan'));
    writeFileSync(
      join(home, '.kovan', 'hook.env'),
      'KOVAN_HOOK_URL="https://f.test/"\nKOVAN_HOOK_TOKEN=abc\nOTHER=1\n',
    );
    expect(hookConfig({}, home)).toEqual({
      url: 'https://f.test',
      token: 'abc',
      tokenHeader: null,
    });
    expect(
      hookConfig(
        {
          KOVAN_HOOK_URL: 'https://x',
          KOVAN_HOOK_TOKEN: 'y',
          KOVAN_HOOK_TOKEN_HEADER: 'x-hook-token',
        },
        home,
      ),
    ).toEqual({ url: 'https://x', token: 'y', tokenHeader: 'x-hook-token' });
  });

  it('puts the token in the header you name, or in Authorization: Bearer', async () => {
    const f = await fakeHook(null);
    const n = createHookNotch({
      ...opts(f.url),
      config: { url: f.url, token: 'T', tokenHeader: 'x-hook-token' },
    });
    n.event('SessionStart');
    await n.flush?.();
    expect(f.headers).toEqual(['T']);
  });

  it('reports a session start, what it is doing, and the end, with the token', async () => {
    const f = await fakeHook(null);
    const n = createHookNotch(opts(f.url));
    n.event('SessionStart');
    n.event('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: '/p/src/a.ts' } });
    n.event('Stop');
    n.event('SessionEnd');
    await n.flush();
    await new Promise((r) => setTimeout(r, 900));
    await n.flush();
    expect(f.live.map((l) => l['event'])).toEqual(expect.arrayContaining(['start', 'idle', 'end']));
    expect(f.headers.every((h) => h === 'Bearer T')).toBe(true);
    expect(f.live[0]).toMatchObject({ session: 's1', cwd: '/proje' });
    expect(
      doingOf('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: '/p/src/a.ts' } }),
    ).toBe('Edit src/a.ts');
  });

  it('asks the server and returns the answer from the phone or the notch', async () => {
    const f = await fakeHook(2, 'always');
    const n = createHookNotch(opts(f.url));
    const d = await n.permission({ tool_name: 'Bash', tool_input: { command: 'npm test' } });
    expect(d).toBe('always');
    expect(f.asked[0]).toMatchObject({ session: 's1', tool: 'Bash', detail: 'npm test' });
  });

  it('withdraws the question when the terminal answered first', async () => {
    const f = await fakeHook(null);
    const n = createHookNotch(opts(f.url));
    const ac = new AbortController();
    const p = n.permission({ tool_name: 'Bash', tool_input: { command: 'ls' } }, ac.signal);
    await new Promise((r) => setTimeout(r, 150));
    ac.abort();
    expect(await p).toBeNull();
    await new Promise((r) => setTimeout(r, 100));
    expect(f.closed).toEqual(['q1']);
  });

  it('is silent when the server is unreachable', async () => {
    const n = createHookNotch(opts('http://127.0.0.1:1'));
    n.event('SessionStart');
    await n.flush();
    expect(await n.permission({ tool_name: 'Bash', tool_input: {} })).toBeNull();
  });
});

describe('combined notches', () => {
  const fixed = (d: 'allow' | 'deny' | null, ms: number): Notch & { aborted: boolean } => {
    const n = {
      aborted: false,
      event: () => {},
      permission: (_f: Record<string, unknown>, signal?: AbortSignal) =>
        new Promise((resolve) => {
          const t = setTimeout(() => resolve(d), ms);
          signal?.addEventListener('abort', () => {
            n.aborted = true;
            clearTimeout(t);
            resolve(null);
          });
        }),
      flush: async () => {},
    };
    return n as never;
  };
  it('the first real answer wins and the other question is withdrawn', async () => {
    const a = fixed('allow', 20);
    const b = fixed('deny', 500);
    expect(await combineNotches([a, b]).permission({})).toBe('allow');
    expect(b.aborted).toBe(true);
  });
  it('one that says nothing does not decide for the other', async () => {
    expect(await combineNotches([fixed(null, 10), fixed('deny', 30)]).permission({})).toBe('deny');
    expect(combineNotches([NOOP_NOTCH, NOOP_NOTCH])).toBe(NOOP_NOTCH);
  });
});

describe('terminal identity', () => {
  it('sends only the terminal facts that are set', async () => {
    const { terminalOf } = await import('./hook-notch.js');
    expect(terminalOf({})).toEqual({});
    expect(
      terminalOf({ TERM_PROGRAM: 'Apple_Terminal', TERM_SESSION_ID: 'W0T1P0', HOME: '/x' }),
    ).toEqual({
      program: 'Apple_Terminal',
      termSession: 'W0T1P0',
    });
  });
});
