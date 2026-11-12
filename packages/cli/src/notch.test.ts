import type { ChatRequest, StreamEvent } from '@kovan/model-gateway';
import type { ModelStreamer } from '@kovan/harness';
import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthStore } from './auth.js';
import { createNotch, hookTool, notchEventsFor, notchSockets } from './notch.js';
import { main, type Terminal } from './run.js';
import { ConversationStore } from './store.js';

/**
 * Coucou's notch, as its own docs (docs/AGENTS.md, docs/INTEGRATIONS.md) describe it: a Unix socket that takes newline-terminated hook JSON,
 * and answers a PermissionRequest with {"permissionDecision": ...} on the same connection. This is a stand-in for it, on a real socket.
 */
let base: string;
let sockPath: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'kn-'));
  sockPath = join(base, 'nb.sock');
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

type Payload = Record<string, unknown> & { hook_event_name: string };

async function fakeCoucou(decide: (p: Payload) => string | 'hang' | null = () => null) {
  const received: Payload[] = [];
  const sockets: Socket[] = [];
  let permissionClosed = 0;
  const server: Server = createServer((sock) => {
    sockets.push(sock);
    let asked = false;
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const p = JSON.parse(buf.slice(0, i)) as Payload;
        buf = buf.slice(i + 1);
        received.push(p);
        if (p.hook_event_name === 'PermissionRequest') {
          asked = true;
          const d2 = decide(p);
          if (d2 && d2 !== 'hang') sock.write(`${JSON.stringify({ permissionDecision: d2 })}\n`);
        }
      }
    });
    sock.on('close', () => {
      if (asked) permissionClosed += 1;
    });
    sock.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(sockPath, r));
  return {
    received,
    names: () => received.map((r) => r.hook_event_name),
    permissionClosed: () => permissionClosed,
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

const wait = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
};

const opts = (over: Partial<Parameters<typeof createNotch>[0]> = {}) => ({
  env: { KOVAN_NOTCH_SOCKET: sockPath } as Record<string, string | undefined>,
  // Never the real home: it may hold a real status-hook address and token.
  home: mkdtempSync(join(tmpdir(), 'kv-home-')),
  sessionId: () => 'sess-1',
  cwd: '/Users/me/proj',
  title: () => 'Menüyü sadeleştir',
  ...over,
});

// ── the client ───────────────────────────────────────────────────────────────

/** A command that writes `text` to `file` the same way on every system (PowerShell's `>` writes UTF-16). */
const writeCmd = (text: string, file: string) =>
  process.platform === 'win32'
    ? `Set-Content -Encoding ascii ${file} ${text}`
    : `echo ${text} > ${file}`;

// Coucou is a macOS app on a Unix socket: its own tests run where it can exist.
const onUnix = process.platform !== 'win32';

describe.runIf(onUnix)('events', () => {
  it('are Claude Code hook JSON tagged coucou_agent=kovan, in order, with what the notch needs to jump back to the terminal', async () => {
    const c = await fakeCoucou();
    try {
      const n = createNotch(
        opts({
          env: {
            KOVAN_NOTCH_SOCKET: sockPath,
            TERM_PROGRAM: 'iTerm.app',
            ITERM_SESSION_ID: 'w0t1p0:ABC',
            __CFBundleIdentifier: 'com.googlecode.iterm2',
          },
        }),
      );
      n.event('SessionStart');
      n.event('UserPromptSubmit', { prompt: 'menüyü yap' });
      n.event('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'a.ts' } });
      await n.flush();
      await wait(() => c.received.length === 3);
      expect(c.names()).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse']);
      expect(c.received[1]).toMatchObject({
        coucou_agent: 'kovan',
        session_id: 'sess-1',
        cwd: '/Users/me/proj',
        prompt: 'menüyü yap',
        session_title: 'Menüyü sadeleştir',
        term_program: 'iTerm.app',
        iterm_session_id: 'w0t1p0:ABC',
        bundle_id: 'com.googlecode.iterm2',
      });
      expect(c.received[2]).toMatchObject({ tool_name: 'Edit', tool_input: { file_path: 'a.ts' } });
    } finally {
      c.close();
    }
  });

  it('a conversation not yet named has no title, and the agent name passes the notch’s own validation', async () => {
    const c = await fakeCoucou();
    try {
      const n = createNotch(opts({ title: () => 'New chat' }));
      n.event('SessionStart');
      await n.flush();
      await wait(() => c.received.length === 1);
      expect(c.received[0]).not.toHaveProperty('session_title');
      expect(String(c.received[0]!['coucou_agent'])).toMatch(/^[a-z0-9-]{1,24}$/);
    } finally {
      c.close();
    }
  });

  it('with no Coucou running nothing happens, and nothing waits', async () => {
    const n = createNotch(opts());
    n.event('SessionStart');
    await n.flush();
    expect(await n.permission({ tool_name: 'Bash', tool_input: { command: 'ls' } })).toBeNull();
  });

  it('a socket path that is a plain file is not Coucou', async () => {
    writeFileSync(sockPath, 'not a socket');
    const n = createNotch(opts());
    n.event('SessionStart');
    await n.flush();
    expect(await n.permission({ tool_name: 'Bash', tool_input: {} })).toBeNull();
  });

  it('KOVAN_NO_NOTCH=1 never touches the socket', async () => {
    const c = await fakeCoucou();
    try {
      const n = createNotch(opts({ env: { KOVAN_NOTCH_SOCKET: sockPath, KOVAN_NO_NOTCH: '1' } }));
      n.event('SessionStart');
      expect(await n.permission({ tool_name: 'Bash', tool_input: {} })).toBeNull();
      await n.flush();
      await new Promise((r) => setTimeout(r, 100));
      expect(c.received).toHaveLength(0);
    } finally {
      c.close();
    }
  });

  it('looks for the GitHub build’s socket first, then the App Store build’s', () => {
    const [a, b] = notchSockets({}, '/Users/me');
    expect(a).toBe('/Users/me/Library/Application Support/NotchBuddy/nb.sock');
    expect(b).toBe('/Users/me/Library/Containers/fr.louisraille.Coucou/Data/nb.sock');
  });
});

describe.runIf(onUnix)('permission', () => {
  const ask = { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } };

  it.each(['allow', 'always', 'deny', 'ask'] as const)(
    '%s comes back as it was said',
    async (d) => {
      const c = await fakeCoucou(() => d);
      try {
        expect(await createNotch(opts()).permission(ask)).toBe(d);
        expect(c.received[0]).toMatchObject({
          hook_event_name: 'PermissionRequest',
          tool_name: 'Bash',
          coucou_agent: 'kovan',
        });
      } finally {
        c.close();
      }
    },
  );

  it('an answer that is not one of those, or not JSON, is no answer', async () => {
    const c = await fakeCoucou();
    c.close();
    const bad = createServer((s) => s.write('garbage\n'));
    await new Promise<void>((r) => bad.listen(sockPath, r));
    try {
      expect(await createNotch(opts()).permission(ask)).toBeNull();
    } finally {
      bad.close();
    }
  });

  it('is withdrawn when the signal fires, and the notch sees the connection close', async () => {
    const c = await fakeCoucou(() => 'hang');
    try {
      const ac = new AbortController();
      const p = createNotch(opts()).permission(ask, ac.signal);
      await wait(() => c.received.length === 1);
      ac.abort();
      expect(await p).toBeNull();
      await wait(() => c.permissionClosed() === 1);
    } finally {
      c.close();
    }
  });

  it('a signal already fired asks nothing', async () => {
    const c = await fakeCoucou(() => 'allow');
    try {
      const ac = new AbortController();
      ac.abort();
      expect(await createNotch(opts()).permission(ask, ac.signal)).toBeNull();
      expect(c.received).toHaveLength(0);
    } finally {
      c.close();
    }
  });
});

describe('what an agent event becomes', () => {
  it('Claude Code’s tool names and input fields, which is what the notch’s rows and cards read', () => {
    expect(hookTool('read_file', { path: 'src/a.ts' })).toEqual({
      tool_name: 'Read',
      tool_input: { file_path: 'src/a.ts' },
    });
    expect(hookTool('edit_file', { path: 'a.ts', old_string: 'x', new_string: 'y' })).toEqual({
      tool_name: 'Edit',
      tool_input: { file_path: 'a.ts' },
    });
    expect(hookTool('write_file', { path: 'a.ts', content: 'secret' })).toEqual({
      tool_name: 'Write',
      tool_input: { file_path: 'a.ts' },
    });
    expect(hookTool('run_shell', { command: 'npm test' })).toEqual({
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });
    expect(hookTool('grep', { pattern: 'foo', path: 'lib' })).toEqual({
      tool_name: 'Grep',
      tool_input: { pattern: 'foo', path: 'lib' },
    });
    expect(hookTool('mcp_thing', { a: 1 })).toEqual({
      tool_name: 'mcp_thing',
      tool_input: { a: 1 },
    });
  });

  it('a turn is PreToolUse, PostToolUse (or its failure), then Stop with the last words, or StopFailure', () => {
    const tools = new Map<string, string>();
    const text = { value: '' };
    const run = (e: Parameters<typeof notchEventsFor>[0]) =>
      notchEventsFor(e, tools, text).map((x) => x.name);
    expect(run({ type: 'turn_start', turnId: 't', model: 'm' })).toEqual([]);
    expect(run({ type: 'text', text: 'Bakıyorum. ' })).toEqual([]);
    expect(
      run({
        type: 'tool_start',
        id: '1',
        name: 'run_shell',
        summary: 's',
        args: { command: 'ls' },
      }),
    ).toEqual(['PreToolUse']);
    expect(run({ type: 'tool_end', id: '1', ok: true, output: '' })).toEqual(['PostToolUse']);
    expect(run({ type: 'tool_start', id: '2', name: 'edit_file', summary: 's', args: {} })).toEqual(
      ['PreToolUse'],
    );
    expect(run({ type: 'tool_end', id: '2', ok: false, output: 'x' })).toEqual([
      'PostToolUseFailure',
    ]);
    expect(run({ type: 'text', text: 'Bitti.' })).toEqual([]);
    const stop = notchEventsFor(
      { type: 'turn_end', turnId: 't', reason: 'done', cost: 0 },
      tools,
      text,
    );
    expect(stop).toEqual([
      { name: 'Stop', fields: { last_assistant_message: 'Bakıyorum. Bitti.' } },
    ]);
    expect(
      notchEventsFor(
        { type: 'turn_end', turnId: 't', reason: 'error', error: 'HTTP 402', cost: 0 },
        tools,
        text,
      )[0],
    ).toEqual({
      name: 'StopFailure',
      fields: { error: 'HTTP 402' },
    });
    expect(tools.size).toBe(0); // nothing is left remembered
  });
});

// ── the agent with a notch ───────────────────────────────────────────────────

const done: StreamEvent = {
  type: 'done',
  finishReason: 'stop',
  model: 'm',
  reasoningDetails: [],
  usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0, reasoningTokens: 0, cost: 0 },
};
const call = (id: string, name: string, args: object): StreamEvent => ({
  type: 'tool_call',
  call: { id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
});
const scripted = (steps: StreamEvent[][]): ModelStreamer & { requests: ChatRequest[] } => {
  const requests: ChatRequest[] = [];
  return {
    requests,
    async *stream(r) {
      requests.push(structuredClone(r));
      for (const e of steps.shift() ?? []) yield e;
    },
  };
};

/** A terminal whose question is answered by `answer(prompt)`, or stays open until it is withdrawn. */
function terminal(opts: {
  tty: boolean;
  answer?: (prompt: string) => string | null | 'never';
  delayMs?: number;
}) {
  const written: string[] = [];
  const prompts: { prompt: string; aborted: boolean }[] = [];
  const t: Terminal = {
    isTTY: opts.tty,
    write: (s) => void written.push(s),
    readLine: (prompt, signal) =>
      new Promise((resolve) => {
        const rec = { prompt, aborted: false };
        prompts.push(rec);
        const a = opts.answer?.(prompt) ?? null;
        // A person takes a moment: long enough for the notch's card to have been shown.
        if (a !== 'never') return void setTimeout(() => resolve(a), opts.delayMs ?? 0);
        signal?.addEventListener(
          'abort',
          () => {
            rec.aborted = true;
            resolve(null);
          },
          { once: true },
        );
      }),
    onInterrupt: () => {},
    close: () => {},
  };
  return { t, text: () => written.join(''), prompts };
}

function run(
  argv: string[],
  model: ModelStreamer,
  term: ReturnType<typeof terminal>,
  env: Record<string, string> = {},
) {
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  return main(argv, {
    env: { KOVAN_NOTCH_SOCKET: sockPath, KOVAN_DATA_DIR: join(base, 'data'), ...env },
    cwd: base,
    home,
    terminal: term.t,
    store: new ConversationStore(join(base, 'conv')),
    auth: new AuthStore(join(base, 'k')),
    err: () => {},
    model,
    checkUpdates: false,
  });
}

describe('kovan in the notch', () => {
  it.runIf(onUnix)(
    'a session shows up, and each tool call and the end of the turn after it',
    async () => {
      writeFileSync(join(base, 'a.txt'), 'merhaba\n');
      const c = await fakeCoucou();
      try {
        const m = scripted([
          [call('c1', 'read_file', { path: 'a.txt' }), done],
          [{ type: 'text', text: 'Dosyada merhaba yazıyor.' }, done],
        ]);
        expect(await run(['a.txt ne yazıyor'], m, terminal({ tty: false }))).toBe(0);
        await wait(() => c.names().includes('SessionEnd'));
        expect(c.names()).toEqual([
          'SessionStart',
          'UserPromptSubmit',
          'PreToolUse',
          'PostToolUse',
          'Stop',
          'SessionEnd',
        ]);
        expect(c.received[1]).toMatchObject({ prompt: 'a.txt ne yazıyor' });
        expect(c.received[2]).toMatchObject({
          tool_name: 'Read',
          tool_input: { file_path: 'a.txt' },
        });
        expect(c.received[4]).toMatchObject({ last_assistant_message: 'Dosyada merhaba yazıyor.' });
        // One conversation, one id, from start to end, and it is the id the desktop app lists it under.
        const ids = new Set(c.received.map((r) => r['session_id']));
        expect(ids.size).toBe(1);
        expect([...ids][0]).toBe(new ConversationStore(join(base, 'conv')).list()[0]!.id);
      } finally {
        c.close();
      }
    },
  );

  const shell = () =>
    scripted([
      [call('c1', 'run_shell', { command: writeCmd('merhaba', 'out.txt') }), done],
      [{ type: 'text', text: 'bitti' }, done],
    ]);

  it.runIf(onUnix)(
    'with nobody at the terminal, the notch can approve a command (your lock screen and phone too)',
    async () => {
      const c = await fakeCoucou((p) =>
        p.hook_event_name === 'PermissionRequest' ? 'allow' : null,
      );
      try {
        expect(await run(['komutu çalıştır'], shell(), terminal({ tty: false }))).toBe(0);
        expect(readFileSync(join(base, 'out.txt'), 'utf8').trim()).toBe('merhaba');
        const ask = c.received.find((r) => r.hook_event_name === 'PermissionRequest')!;
        expect(ask).toMatchObject({
          tool_name: 'Bash',
          tool_input: { command: writeCmd('merhaba', 'out.txt') },
        });
      } finally {
        c.close();
      }
    },
  );

  it.runIf(onUnix)('and the notch can refuse it', async () => {
    const c = await fakeCoucou(() => 'deny');
    try {
      const term = terminal({ tty: false });
      await run(['komutu çalıştır'], shell(), term);
      expect(existsSync(join(base, 'out.txt'))).toBe(false);
      expect(term.text()).toContain('notch: denied');
    } finally {
      c.close();
    }
  });

  it.runIf(onUnix)(
    'a notch that does not answer is not a yes: with nobody at the terminal it refuses and says how to allow',
    async () => {
      const c = await fakeCoucou(() => 'ask');
      try {
        const term = terminal({ tty: false });
        await run(['komutu çalıştır'], shell(), term);
        expect(existsSync(join(base, 'out.txt'))).toBe(false);
        expect(term.text()).toMatch(/--mode full/);
      } finally {
        c.close();
      }
    },
  );

  it.runIf(onUnix)(
    'at a terminal both ask at once: the notch’s yes runs it and withdraws the terminal’s question',
    async () => {
      const c = await fakeCoucou(() => 'allow');
      try {
        const term = terminal({
          tty: true,
          answer: (p) => (p.includes('allow?') ? 'never' : null),
        });
        expect(await run(['komutu çalıştır'], shell(), term)).toBe(0);
        expect(readFileSync(join(base, 'out.txt'), 'utf8').trim()).toBe('merhaba');
        expect(term.prompts.find((p) => p.prompt.includes('allow?'))!.aborted).toBe(true);
        expect(term.text()).toContain('notch: approved');
      } finally {
        c.close();
      }
    },
  );

  it.runIf(onUnix)(
    '…and the terminal’s answer, when it comes first, withdraws the notch’s card',
    async () => {
      const c = await fakeCoucou(() => 'hang');
      try {
        const term = terminal({
          tty: true,
          delayMs: 150,
          answer: (p) => (p.includes('allow?') ? 'y' : null),
        });
        expect(await run(['komutu çalıştır'], shell(), term)).toBe(0);
        expect(readFileSync(join(base, 'out.txt'), 'utf8').trim()).toBe('merhaba');
        await wait(() => c.permissionClosed() >= 1);
      } finally {
        c.close();
      }
    },
  );

  it.runIf(onUnix)('a notch that says "ask" leaves it to the terminal', async () => {
    const c = await fakeCoucou(() => 'ask');
    try {
      const term = terminal({ tty: true, answer: (p) => (p.includes('allow?') ? 'n' : null) });
      await run(['komutu çalıştır'], shell(), term);
      expect(existsSync(join(base, 'out.txt'))).toBe(false); // the terminal said no, and the notch’s "ask" did not decide
    } finally {
      c.close();
    }
  });

  it.runIf(onUnix)(
    '"always" from the notch allows that command for the rest of the session',
    async () => {
      const c = await fakeCoucou(() => 'always');
      try {
        const m = scripted([
          [call('c1', 'run_shell', { command: writeCmd('bir', 'o1.txt') }), done],
          [call('c2', 'run_shell', { command: writeCmd('bir', 'o1.txt') }), done],
          [{ type: 'text', text: 'tamam' }, done],
        ]);
        await run(['iki komut'], m, terminal({ tty: false }));
        expect(existsSync(join(base, 'o1.txt'))).toBe(true);
        expect(c.received.filter((r) => r.hook_event_name === 'PermissionRequest')).toHaveLength(1);
      } finally {
        c.close();
      }
    },
  );

  it('without Coucou, the terminal works exactly as before', async () => {
    const term = terminal({ tty: true, answer: (p) => (p.includes('allow?') ? 'y' : null) });
    expect(await run(['komutu çalıştır'], shell(), term)).toBe(0);
    expect(readFileSync(join(base, 'out.txt'), 'utf8').trim()).toBe('merhaba');
  });

  it.runIf(onUnix)('KOVAN_NO_NOTCH=1 keeps a running Coucou out of it', async () => {
    const c = await fakeCoucou(() => 'allow');
    try {
      await run(
        ['selam'],
        scripted([[{ type: 'text', text: 'x' }, done]]),
        terminal({ tty: false }),
        { KOVAN_NO_NOTCH: '1' },
      );
      await new Promise((r) => setTimeout(r, 100));
      expect(c.received).toHaveLength(0);
    } finally {
      c.close();
    }
  });
});
