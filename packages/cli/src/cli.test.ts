import type { ChatRequest, StreamEvent } from '@kovan/model-gateway';
import type { ModelStreamer } from '@kovan/harness';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from './args.js';
import { loadProvider } from './config.js';
import { Renderer } from './render.js';
import { main, type Terminal } from './run.js';
import { AuthStore } from './auth.js';
import {
  conversationsDirFor,
  ConversationStore,
  digestOf,
  type StoredConversation,
} from './store.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kovan-cli-'));
  await writeFile(join(dir, 'a.txt'), 'old\n');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ── a scripted model and a scripted terminal ─────────────────────────────────

type Step = StreamEvent[];
const text = (t: string): StreamEvent => ({ type: 'text', text: t });
const call = (id: string, name: string, args: object): StreamEvent => ({
  type: 'tool_call',
  call: { id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
});
const done = (cost = 0.002): StreamEvent => ({
  type: 'done',
  finishReason: 'stop',
  model: 'test/model',
  reasoningDetails: [],
  usage: { promptTokens: 100, completionTokens: 20, cachedTokens: 0, reasoningTokens: 0, cost },
});

function scripted(steps: Step[]): ModelStreamer & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    async *stream(request) {
      requests.push(structuredClone(request));
      const step = steps.shift();
      if (!step) throw new Error('No more scripted steps');
      for (const e of step) yield e;
    },
  };
}

/** What the model was told, without the temporary "Current mode" note the agent appends to each request. */
const convo = (req: ChatRequest) =>
  req.messages.filter((m, i) => !(i === req.messages.length - 1 && m.role === 'system'));

function terminal(lines: (string | null)[], isTTY = true) {
  const written: string[] = [];
  const prompts: string[] = [];
  const queue = [...lines];
  let interrupt: () => void = () => {};
  const t: Terminal = {
    isTTY,
    write: (s) => void written.push(s),
    readLine: async (p) => {
      prompts.push(p);
      return queue.length ? (queue.shift() ?? null) : null;
    },
    onInterrupt: (h) => {
      interrupt = h;
    },
    close: () => {},
  };
  // eslint-disable-next-line no-control-regex
  const plain = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');
  return { t, written, prompts, text: () => plain(written.join('')), interrupt: () => interrupt() };
}

function run(
  argv: string[],
  term: ReturnType<typeof terminal>,
  over: Partial<Parameters<typeof main>[1]> = {},
) {
  const errors: string[] = [];
  const store = over.store ?? new ConversationStore(join(dir, 'data'));
  const auth = over.auth ?? new AuthStore(join(dir, 'kovan-home'));
  const done = main(argv, {
    env: {},
    cwd: dir,
    terminal: term.t,
    store,
    auth,
    // A made-up home: a test must not read the real ~/.claude (skills, CLAUDE.md) of whoever runs it.
    home: join(dir, 'home'),
    err: (s) => errors.push(s),
    checkUpdates: false,
    stateDir: join(dir, 'state'),
    ...over,
  });
  return { done, errors, store, auth };
}

// ── arguments ────────────────────────────────────────────────────────────────

/** A command that writes `text` to `file` the same way on every system (PowerShell's `>` writes UTF-16). */
const writeCmd = (text: string, file: string) =>
  process.platform === 'win32'
    ? `Set-Content -Encoding ascii ${file} ${text}`
    : `echo ${text} > ${file}`;

describe('arguments', () => {
  it('words are one message; flags are flags', () => {
    expect(parseArgs(['testleri', 'düzelt', '--mode', 'full', '-m', 'x/y'])).toMatchObject({
      command: 'chat',
      task: 'testleri düzelt',
      mode: 'full',
      model: 'x/y',
    });
  });
  it('no words opens the prompt', () => {
    expect(parseArgs([])).toMatchObject({ command: 'chat', task: '' });
    expect(parseArgs(['-c']).continueLast).toBe(true);
  });
  it('the first word can be a command', () => {
    expect(parseArgs(['sessions', '--json'])).toMatchObject({ command: 'sessions', json: true });
    expect(parseArgs(['sessions', 'export', 'kv_1']).sessionId).toBe('kv_1');
    expect(parseArgs(['help']).command).toBe('help');
    // …but only as the first word: later it is part of the message.
    expect(parseArgs(['bunu', 'config', 'yap']).task).toBe('bunu config yap');
  });
  it.each([
    [['--mode', 'bogus'], /unknown mode/],
    [['--effort', 'huge'], /unknown effort/],
    [['--model'], /needs a value/],
    [['--nope'], /unknown option/],
    [['sessions', 'export'], /needs a session id/],
  ])('%j is refused with a reason', (argv, why) => {
    expect(parseArgs(argv).error).toMatch(why);
  });
});

// ── which server, as whom ────────────────────────────────────────────────────

describe('provider', () => {
  const none = join(tmpdir(), 'kovan-no-such-config.json');
  it('OpenRouter by default, from its key', () => {
    const p = loadProvider({ OPENROUTER_API_KEY: 'k' }, none);
    expect(p).toMatchObject({
      ok: true,
      provider: { dialect: 'openrouter', model: 'openrouter/auto', label: 'openrouter.ai' },
    });
  });
  it('your own gateway needs a model, and no key when it needs none', () => {
    expect(loadProvider({ KOVAN_BASE_URL: 'http://localhost:20128/v1' }, none)).toMatchObject({
      ok: false,
    });
    const p = loadProvider(
      { KOVAN_BASE_URL: 'http://localhost:20128/v1/', KOVAN_MODEL: 'auto/best-coding-fast' },
      none,
    );
    expect(p).toMatchObject({
      ok: true,
      provider: {
        baseUrl: 'http://localhost:20128/v1',
        dialect: 'openai',
        apiKey: '',
        label: 'localhost:20128',
      },
    });
  });
  it('without any key it says what to set', () => {
    const p = loadProvider({}, none);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.why).toMatch(/OPENROUTER_API_KEY/);
  });
  it('the file is a fallback to the environment, and a bad file is no file', async () => {
    const file = join(dir, 'agent.json');
    await writeFile(
      file,
      JSON.stringify({ baseUrl: 'https://gw.test/v1', apiKey: 'fk', model: 'm1' }),
    );
    expect(loadProvider({}, file)).toMatchObject({
      ok: true,
      provider: { model: 'm1', apiKey: 'fk' },
    });
    expect(loadProvider({ KOVAN_MODEL: 'm2' }, file)).toMatchObject({
      ok: true,
      provider: { model: 'm2' },
    });
    await writeFile(file, '{not json');
    expect(loadProvider({ OPENROUTER_API_KEY: 'k' }, file).ok).toBe(true);
  });
  it('the key is never in anything it says', async () => {
    const term = terminal([]);
    const r = run(['config'], term, {
      env: { OPENROUTER_API_KEY: 'sk-or-SECRETVALUE', HOME: dir },
      configFile: join(dir, 'none.json'),
    });
    expect(await r.done).toBe(0);
    expect(term.text()).not.toContain('SECRETVALUE');
    expect(term.text()).toContain('key:    set');
  });
});

// ── what a turn looks like ───────────────────────────────────────────────────

describe('renderer', () => {
  const render = (
    events: Parameters<Renderer['event']>[0][],
    opts = { color: false, reasoning: false },
  ) => {
    const out: string[] = [];
    const r = new Renderer((s) => out.push(s), opts);
    for (const e of events) r.event(e);
    return { text: out.join(''), r };
  };
  const usage = {
    promptTokens: 10,
    completionTokens: 5,
    cachedTokens: 0,
    reasoningTokens: 0,
    cost: 0.0012,
  };

  it('streams text, then a tool line with its result, then the cost', () => {
    const { text } = render([
      { type: 'turn_start', turnId: 't', model: 'm/x' },
      { type: 'text', text: 'Bakıyorum.' },
      { type: 'tool_start', id: '1', name: 'edit_file', summary: 'Edit a.txt', args: {} },
      {
        type: 'tool_end',
        id: '1',
        ok: true,
        output: 'ok',
        meta: { path: 'a.txt', added: 2, removed: 1 },
      },
      { type: 'usage', usage, model: 'm/x', kind: 'model', estimated: false },
      { type: 'turn_end', turnId: 't', reason: 'done', cost: 0.0012 },
    ]);
    expect(text).toContain('Bakıyorum.\n● Edit a.txt'); // the tool line starts on its own line
    expect(text).toContain('✓ a.txt (+2 −1)');
    expect(text).toContain('── m/x · 10→5 tokens · $0.0012');
  });
  it('a failure shows its first lines, and an error turn says why', () => {
    const { text } = render([
      { type: 'turn_start', turnId: 't', model: 'm' },
      { type: 'tool_end', id: '1', ok: false, output: 'Not found: x.ts' },
      { type: 'turn_end', turnId: 't', reason: 'error', error: 'HTTP 402', cost: 0 },
    ]);
    expect(text).toContain('✗');
    expect(text).toContain('Not found: x.ts');
    expect(text).toContain('error: HTTP 402');
  });
  it('reasoning is one quiet line unless you ask for it', () => {
    const events = [
      { type: 'turn_start' as const, turnId: 't', model: 'm' },
      { type: 'reasoning' as const, text: 'önce şunu düşünelim' },
      { type: 'reasoning' as const, text: ' sonra bunu' },
    ];
    expect(render(events).text.match(/thinking/g)).toHaveLength(1);
    expect(render(events).text).not.toContain('önce şunu');
    expect(render(events, { color: false, reasoning: true }).text).toContain('önce şunu düşünelim');
  });
  it('colour only when it is a terminal', () => {
    const ev = [{ type: 'tool_start' as const, id: '1', name: 'x', summary: 'S', args: {} }];
    expect(render(ev).text).not.toContain('\u001b[');
    expect(render(ev, { color: true, reasoning: false }).text).toContain('\u001b[');
  });
  it('keeps running totals across turns', () => {
    const { r } = render([
      { type: 'usage', usage, model: 'm', kind: 'model', estimated: false },
      { type: 'usage', usage, model: 'm', kind: 'model', estimated: false },
    ]);
    expect(r.totals()).toMatchObject({ tokensIn: 20, tokensOut: 10 });
  });
});

// ── the agent, end to end, with a scripted model ─────────────────────────────

describe('one message', () => {
  it('does the work with real tools, prints it and exits 0', async () => {
    const model = scripted([
      [call('c1', 'read_file', { path: 'a.txt' }), done()],
      [call('c2', 'edit_file', { path: 'a.txt', old_string: 'old', new_string: 'new' }), done()],
      [text('a.txt güncellendi.'), done()],
    ]);
    const term = terminal([]);
    const r = run(['a.txt', 'içindeki', 'old', 'kelimesini', 'değiştir'], term, { model });
    expect(await r.done).toBe(0);
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('new\n');
    expect(term.text()).toContain('a.txt güncellendi.');
    expect(term.text()).toContain('● ');
    // The first thing the model saw was the user's sentence.
    expect(JSON.stringify(model.requests[0]!.messages)).toContain(
      'içindeki old kelimesini değiştir',
    );
  });

  it('a failed turn exits 1', async () => {
    const model: ModelStreamer = {
      // eslint-disable-next-line require-yield -- a request that fails before it says anything
      async *stream() {
        throw new Error('HTTP 500');
      },
    };
    const r = run(['bir şey'], terminal([]), { model });
    expect(await r.done).toBe(1);
  });
});

describe('asking before it acts', () => {
  const editPlan = () => [
    [call('c1', 'run_shell', { command: writeCmd('merhaba', 'out.txt') }), done()],
    [text('bitti'), done()],
  ];

  it('allow mode: a command asks, yes runs it', async () => {
    const term = terminal(['y']);
    const r = run(['komutu çalıştır'], term, { model: scripted(editPlan()) });
    expect(await r.done).toBe(0);
    expect(term.prompts.some((p) => p.includes('allow?'))).toBe(true);
    expect(term.text()).toContain(writeCmd('merhaba', 'out.txt'));
    expect((await readFile(join(dir, 'out.txt'), 'utf8')).trim()).toBe('merhaba');
  });

  it('no (or anything else) does not run it', async () => {
    const term = terminal(['n']);
    const r = run(['komutu çalıştır'], term, { model: scripted(editPlan()) });
    await r.done;
    await expect(readFile(join(dir, 'out.txt'), 'utf8')).rejects.toThrow();
  });

  it('"t" allows that tool for the rest of the session: it asks once', async () => {
    const model = scripted([
      [call('c1', 'run_shell', { command: 'echo bir > o1.txt' }), done()],
      [call('c2', 'run_shell', { command: writeCmd('iki', 'o2.txt') }), done()],
      [text('tamam'), done()],
    ]);
    const term = terminal(['a']);
    const r = run(['iki komut çalıştır'], term, { model });
    await r.done;
    expect(term.prompts.filter((p) => p.includes('allow?'))).toHaveLength(1);
    expect((await readFile(join(dir, 'o2.txt'), 'utf8')).trim()).toBe('iki');
  });

  it('without a terminal there is nobody to ask: it refuses, and says how to allow', async () => {
    const term = terminal([], false);
    const r = run(['komutu çalıştır'], term, { model: scripted(editPlan()) });
    await r.done;
    expect(term.text()).toMatch(/nobody to ask/);
    expect(term.text()).toMatch(/--mode full/);
    await expect(readFile(join(dir, 'out.txt'), 'utf8')).rejects.toThrow();
  });

  it('--mode full does not ask', async () => {
    const term = terminal([], false);
    const r = run(['--mode', 'full', 'komutu çalıştır'], term, { model: scripted(editPlan()) });
    expect(await r.done).toBe(0);
    expect((await readFile(join(dir, 'out.txt'), 'utf8')).trim()).toBe('merhaba');
  });

  it('plan mode offers no editing tools at all', async () => {
    const model = scripted([[text('sadece okurum'), done()]]);
    await run(['--mode', 'plan', 'bir şey'], terminal([]), { model }).done;
    const names = (model.requests[0]!.tools ?? []).map((t) => t.name);
    expect(names).toContain('read_file');
    expect(names).not.toContain('edit_file');
    expect(names).not.toContain('run_shell');
  });
});

describe('the prompt', () => {
  it('each line is a turn; /exit ends it; slash commands are not turns', async () => {
    const model = scripted([
      [text('birinci'), done()],
      [text('ikinci'), done()],
    ]);
    const term = terminal(['merhaba', '', '/mode plan', '/cost', 'tekrar', '/exit', 'asla']);
    const r = run([], term, { model });
    expect(await r.done).toBe(0);
    expect(model.requests).toHaveLength(2);
    expect(term.text()).toContain('birinci');
    expect(term.text()).toContain('ikinci');
    expect(term.text()).toContain('mode: plan');
    expect(term.text()).toMatch(/\d+→\d+ tokens/);
  });

  it('the input ending ends the session', async () => {
    expect(
      await run([], terminal(['merhaba']), { model: scripted([[text('x'), done()]]) }).done,
    ).toBe(0);
  });

  it('/mode rejects what it does not know, /model switches, /foo is unknown', async () => {
    const term = terminal(['/mode keyfi', '/model baska/model', '/foo', '/exit']);
    await run([], term, { model: scripted([]) }).done;
    expect(term.text()).toContain("unknown mode 'keyfi'");
    expect(term.text()).toContain('model: baska/model');
    expect(term.text()).toContain('Unknown command');
  });

  it('Ctrl+C stops a running turn instead of leaving', async () => {
    const term = terminal(['uzun iş', '/exit']);
    let stopped = false;
    const model: ModelStreamer = {
      async *stream(_req, signal) {
        yield text('başladım');
        term.interrupt();
        if (signal?.aborted) stopped = true;
        else
          await new Promise((res) =>
            signal?.addEventListener(
              'abort',
              () => {
                stopped = true;
                res(null);
              },
              { once: true },
            ),
          );
        // A real request that is aborted throws; a stream that just ended would be a finished turn.
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
    };
    const r = run([], term, { model });
    expect(await r.done).toBe(0);
    expect(stopped).toBe(true);
    expect(term.text()).toContain('stopped');
  });
});

describe('extra instructions', () => {
  it('a context file is part of the system prompt, and a missing one is not fatal', async () => {
    await writeFile(join(dir, 'ctx.md'), 'GIZLI-KOD-ADI-7731');
    const model = scripted([[text('x'), done()]]);
    await run(['--context-file', join(dir, 'ctx.md'), 'selam'], terminal([]), { model }).done;
    const system = model.requests[0]!.messages[0]!;
    expect(system.role).toBe('system');
    expect(system.content).toContain('GIZLI-KOD-ADI-7731');
    expect(system.content).toContain('You are the Kovan coding agent');

    const model2 = scripted([[text('x'), done()]]);
    const r = run(['--context-file', join(dir, 'yok.md'), 'selam'], terminal([]), {
      model: model2,
    });
    expect(await r.done).toBe(0);
    expect(r.errors.join('\n')).toMatch(/Couldn't read the context file/);
  });

  it('the repository’s own KOVAN.md rules are in the prompt too', async () => {
    await writeFile(join(dir, 'KOVAN.md'), 'Her zaman Türkçe commit yaz.');
    const model = scripted([[text('x'), done()]]);
    await run(['selam'], terminal([]), { model }).done;
    expect(model.requests[0]!.messages[0]!.content).toContain('Her zaman Türkçe commit yaz.');
  });
});

describe('conversations, kept the way the desktop app keeps its own', () => {
  const file = (id: string, root = dir) =>
    join(conversationsDirFor(join(dir, 'data'), root), `${id}.json`);

  it('each turn is saved where the desktop lists chats, in its format, readable only by the user', async () => {
    const first = scripted([[text('ilk cevap'), done(0.01)]]);
    const r1 = run(['ilk soru'], terminal([]), { model: first });
    await r1.done;
    const [meta] = r1.store.list();
    expect(meta).toMatchObject({ title: 'ilk soru', root: dir, harness: 'kovan' });
    // Windows has no such modes; elsewhere only the user may read it.
    if (process.platform !== 'win32') expect(statSync(file(meta!.id)).mode & 0o777).toBe(0o600);

    const c = JSON.parse(await readFile(file(meta!.id), 'utf8')) as StoredConversation;
    expect(c).toMatchObject({
      id: meta!.id,
      title: 'ilk soru',
      root: dir,
      harness: 'kovan',
      auto: false,
      mode: 'allow',
      effort: null,
    });
    expect(typeof c.updatedAt).toBe('number');
    expect(c.cost).toBeCloseTo(0.01);
    // The transcript the screen replays: your message, then the turn, in the app's own event shapes.
    expect(c.events[0]).toMatchObject({ type: 'user', text: 'ilk soru', attachments: [] });
    expect(typeof (c.events[0] as { at: number }).at).toBe('number');
    expect(c.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['user', 'turn_start', 'text', 'turn_end']),
    );
    expect(c.events.some((e) => e.type === 'tool_progress')).toBe(false);
    // The model's own history, so the next turn (here, or in the app) can carry on.
    expect(c.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
  });

  it('the conversation belongs to the repository’s top, whichever folder inside it you are in', async () => {
    await mkdir(join(dir, '.git'));
    await mkdir(join(dir, 'src', 'deep'), { recursive: true });
    const r = run(['selam'], terminal([]), {
      model: scripted([[text('x'), done()]]),
      cwd: join(dir, 'src', 'deep'),
    });
    await r.done;
    expect(r.store.list(dir)).toHaveLength(1);
    expect(r.store.list(join(dir, 'src', 'deep'))).toHaveLength(0);
  });

  it('-c picks the last chat in this folder up, with its history, as the same conversation', async () => {
    const r1 = run(['ilk soru'], terminal([]), { model: scripted([[text('ilk cevap'), done()]]) });
    await r1.done;
    const second = scripted([[text('ikinci cevap'), done()]]);
    const r2 = run(['-c', 'ikinci soru'], terminal([]), { model: second, store: r1.store });
    await r2.done;
    expect(convo(second.requests[0]!).map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(JSON.stringify(second.requests[0]!.messages)).toContain('ilk soru');
    expect(r1.store.list()).toHaveLength(1);
    const c = r1.store.load(dir, r1.store.list()[0]!.id)!;
    expect(c.title).toBe('ilk soru'); // the first prompt names it, later ones do not
    expect(c.events.filter((e) => e.type === 'user')).toHaveLength(2);
  });

  it('-c with nothing to continue says so and starts fresh', async () => {
    const r = run(['-c', 'selam'], terminal([]), { model: scripted([[text('x'), done()]]) });
    expect(await r.done).toBe(0);
    expect(r.errors.join('\n')).toMatch(/No chat to continue/);
  });

  it('a chat the desktop made with Claude Code is not ours to continue; one made with Kovan’s agent is', async () => {
    const store = new ConversationStore(join(dir, 'data'));
    const mine = store.create(dir, { model: 'm', effort: null, mode: 'allow' });
    mine.title = 'masaüstünden';
    mine.messages = [
      { role: 'system', content: 'ESKI SISTEM' },
      { role: 'user', content: 'önce masaüstünde sordum' },
      { role: 'assistant', content: 'cevapladım' },
    ];
    mine.updatedAt = 1000;
    store.save(mine);
    // A newer one, but from another harness.
    const theirs = {
      ...store.create(dir, { model: 'haiku', effort: null, mode: 'request' }),
      harness: 'claude-code' as never,
      title: 'claude',
      updatedAt: 2000,
    };
    store.save(theirs as StoredConversation);

    const model = scripted([[text('devam ettim'), done()]]);
    await run(['-c', 'devam et'], terminal([]), { model, store }).done;
    const sent = JSON.stringify(convo(model.requests[0]!));
    expect(sent).toContain('önce masaüstünde sordum');
    expect(sent).not.toContain('ESKI SISTEM'); // the system prompt is rebuilt, not replayed
    expect(sent).toContain('You are the Kovan coding agent');
  });

  it('/clear starts a new conversation', async () => {
    const model = scripted([
      [text('a'), done()],
      [text('b'), done()],
    ]);
    const r = run([], terminal(['bir', '/clear', 'iki', '/exit']), { model });
    await r.done;
    expect(r.store.list()).toHaveLength(2);
    expect(JSON.stringify(model.requests[1]!.messages)).not.toContain('"bir"');
  });

  it('`sessions` lists them, and `sessions --json` is what a surrounding tool reads', async () => {
    const r = run(['bir şey yaz'], terminal([]), { model: scripted([[text('tamam'), done()]]) });
    await r.done;
    const [meta] = r.store.list();
    const listing = terminal([]);
    await run(['sessions'], listing, { store: r.store }).done;
    expect(listing.text()).toContain(meta!.id);
    const json = terminal([]);
    await run(['sessions', '--json'], json, { store: r.store }).done;
    expect(JSON.parse(json.text())).toEqual([
      expect.objectContaining({ id: meta!.id, cwd: dir, title: 'bir şey yaz', harness: 'kovan' }),
    ]);
    expect(JSON.parse(json.text())[0].updatedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('`sessions export` is what a surrounding tool may remember', async () => {
    const model = scripted([
      [call('c1', 'write_file', { path: 'yeni.txt', content: 'x' }), done()],
      [text('yeni.txt yazıldı.'), done()],
    ]);
    const r = run(['--mode', 'full', 'bir dosya yaz'], terminal([]), { model });
    await r.done;
    const [meta] = r.store.list();
    const exp = terminal([]);
    await run(['sessions', 'export', meta!.id], exp, { store: r.store }).done;
    expect(JSON.parse(exp.text())).toMatchObject({
      tool: 'kovan',
      sessionId: meta!.id,
      cwd: dir,
      firstPrompt: 'bir dosya yaz',
      lastAnswer: 'yeni.txt yazıldı.',
      files: ['yeni.txt'],
    });
  });

  it('an unknown id is an error', async () => {
    const r = run(['sessions', 'export', 'yok-boyle-bir-sey'], terminal([]));
    expect(await r.done).toBe(1);
  });

  it('a digest names no file for an edit whose arguments are not JSON', () => {
    const store = new ConversationStore(join(dir, 's'));
    const c = store.create(dir, { model: 'm', effort: null, mode: 'allow' });
    c.messages = [
      { role: 'user', content: 'x' },
      {
        role: 'assistant',
        content: 'y',
        tool_calls: [
          { id: '1', type: 'function', function: { name: 'edit_file', arguments: '{bozuk' } },
        ],
      },
    ];
    expect(digestOf(c).files).toEqual([]);
  });

  it('a file that is not a conversation is ignored, not a crash', async () => {
    const store = new ConversationStore(join(dir, 'data'));
    const c = store.create(dir, { model: 'm', effort: null, mode: 'allow' });
    store.save(c);
    await writeFile(file('bozuk'), '{not json');
    expect(store.list(dir).map((x) => x.id)).toEqual([c.id]);
  });
});

describe('a real server', () => {
  it('speaks to an OpenAI-compatible endpoint (streamed), tool call and all', async () => {
    const { createServer } = await import('node:http');
    const seen: {
      auth: string | undefined;
      body: { model: string; messages: { role: string }[] };
    }[] = [];
    let n = 0;
    const server = createServer((req, res) => {
      if (req.url?.endsWith('/models')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'gw/test-model' }] }));
        return;
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ auth: req.headers['authorization'], body: JSON.parse(body) });
        res.setHeader('content-type', 'text/event-stream');
        const chunk = (delta: object, finish: string | null = null) =>
          res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`);
        if (n++ === 0) {
          chunk(
            {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
                },
              ],
            },
            'tool_calls',
          );
        } else {
          chunk({ content: 'Dosyada ' });
          chunk({ content: '"old" yazıyor.' }, 'stop');
        }
        res.write(
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const term = terminal([]);
      const r = run(['a.txt', 'ne', 'yazıyor?'], term, {
        env: {
          KOVAN_BASE_URL: `http://127.0.0.1:${port}/v1`,
          KOVAN_MODEL: 'gw/test-model',
          KOVAN_API_KEY: 'gw-key',
        },
        configFile: join(dir, 'none.json'),
      });
      expect(await r.done).toBe(0);
      expect(term.text()).toContain('Dosyada "old" yazıyor.');
      expect(seen[0]!.auth).toBe('Bearer gw-key');
      expect(seen[0]!.body.model).toBe('gw/test-model');
      // The second request carries the tool result back.
      expect(
        seen[1]!.body.messages
          .map((m) => m.role)
          .filter((r, i, a) => !(i === a.length - 1 && r === 'system')),
      ).toEqual(['system', 'user', 'assistant', 'tool']);
    } finally {
      server.close();
    }
  });

  it('a provider that is not configured says so and starts nothing', async () => {
    const r = run(['selam'], terminal([]), { env: {}, configFile: join(dir, 'none.json') });
    expect(await r.done).toBe(1);
    expect(r.errors.join('\n')).toMatch(/OPENROUTER_API_KEY/);
  });
});
