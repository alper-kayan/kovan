import { describe, expect, it, vi } from 'vitest';
import { LineEditor } from './editor.js';
import { KeyParser } from './keys.js';
import { renderMarkdown } from './markdown.js';
import { TuiApp, type TuiHost, type TuiIO } from './app.js';
import { Transcript } from './transcript.js';
import { stripAnsi, strWidth, truncate } from './text.js';

const names = (s: string) =>
  new KeyParser().feed(s).map((k) => (k.text ? `${k.name}:${k.text}` : k.name));

describe('keys', () => {
  it('reads plain, control, arrow and alt keys', () => {
    expect(names('ab')).toEqual(['char:ab']);
    expect(names('\r')).toEqual(['enter']);
    expect(names('\n')).toEqual(['newline']);
    expect(names('\u001b[A\u001b[B')).toEqual(['up', 'down']);
    expect(names('\u0003')).toEqual(['c']);
    expect(new KeyParser().feed('\u001b\r')[0]).toMatchObject({ name: 'enter', alt: true });
  });
  it('keeps a bracketed paste as one piece, newlines and all', () => {
    const k = new KeyParser().feed('\u001b[200~satır1\nsatır2\u001b[201~');
    expect(k).toEqual([{ name: 'paste', text: 'satır1\nsatır2' }]);
  });
  it('a lone escape comes out on flush', () => {
    const p = new KeyParser();
    expect(p.feed('\u001b')).toEqual([]);
    expect(p.flush().map((k) => k.name)).toEqual(['escape']);
  });
});

describe('editor', () => {
  it('edits, moves and remembers', () => {
    const e = new LineEditor();
    e.insert('merhaba dünya');
    e.wordLeft();
    e.insert('güzel ');
    expect(e.value).toBe('merhaba güzel dünya');
    e.killToStart();
    expect(e.value).toBe('dünya');
    e.setValue('a\nb');
    expect(e.up()).toBe(true);
    expect(e.up()).toBe(false);
    e.remember('önceki');
    e.clear();
    expect(e.historyPrev()).toBe(true);
    expect(e.value).toBe('önceki');
  });
  it('steps over an emoji as one character', () => {
    const e = new LineEditor();
    e.insert('a😀');
    e.backspace();
    expect(e.value).toBe('a');
  });
});

describe('text and markdown', () => {
  it('measures wide characters as two columns', () => {
    expect(strWidth('日本')).toBe(4);
    expect(strWidth(truncate('abcdefghij', 5))).toBeLessThanOrEqual(5);
  });
  it('lays out headings, lists, code and wraps to the width', () => {
    const lines = renderMarkdown(
      '# Başlık\n\n- bir **kalın** madde\n\n```ts\nconst x = 1;\n```\n' + 'söz '.repeat(30),
      40,
    );
    const plain = lines.map(stripAnsi);
    expect(plain.some((l) => l.includes('Başlık'))).toBe(true);
    expect(plain.some((l) => l.includes('• bir kalın madde'))).toBe(true);
    expect(plain.some((l) => l.includes('const x = 1;'))).toBe(true);
    expect(plain.every((l) => strWidth(l) <= 40)).toBe(true);
  });
});

describe('transcript', () => {
  it('builds blocks from events and finishes a tool that never reported', () => {
    const t = new Transcript();
    t.apply({ type: 'turn_start', model: 'm' } as never);
    t.apply({ type: 'text', text: 'Merhaba ' } as never);
    t.apply({ type: 'text', text: 'dünya' } as never);
    t.apply({
      type: 'tool_start',
      id: '1',
      name: 'read_file',
      summary: 'okuyor a.ts',
      args: {},
    } as never);
    t.apply({ type: 'turn_end', reason: 'stopped' } as never);
    const text = t.render(60, { reasoning: false, spin: 0 }).map(stripAnsi).join('\n');
    expect(text).toContain('Merhaba dünya');
    expect(text).toContain('okuyor a.ts');
    expect(text).toContain('durduruldu');
    expect(text).not.toContain('⠋ okuyor');
  });
});

// ── the controller, against a fake terminal ─────────────────────────────────

function fakeIO(cols = 80, rows = 24) {
  let data: (d: string) => void = () => {};
  const io: TuiIO & { out: string[]; send(s: string): void; tornDown: boolean } = {
    out: [],
    tornDown: false,
    write: (s) => void io.out.push(s),
    size: () => ({ cols, rows }),
    onData: (cb) => (data = cb as (d: string) => void),
    onResize: () => {},
    setup: () => {},
    teardown: () => {
      io.tornDown = true;
    },
    send: (s) => data(s),
  };
  return io;
}

function host(over: Partial<TuiHost> = {}): TuiHost {
  let mode: 'allow' | 'plan' | 'request' | 'full' = 'allow';
  return {
    header: () => ({ model: 'm/x', provider: 'test', folder: '~/proje', managed: false }),
    mode: () => mode,
    setMode: (m) => (mode = m),
    effort: () => 'medium',
    setEffort: () => {},
    efforts: () => ({ levels: ['low', 'medium', 'high'], default: 'medium' }),
    setModel: () => {},
    models: async () => ({
      items: [
        { label: 'a/one', value: 'a/one' },
        { label: 'b/two', value: 'b/two' },
      ],
    }),
    turn: async () => {},
    stop: () => {},
    slash: async () => null,
    palette: async () => [{ label: '/review', hint: 'kodu gözden geçir', value: '/review ' }],
    sessions: () => [],
    resume: () => null,
    newChat: () => {},
    history: [],
    initialEvents: [],
    startLines: [],
    notchEnabled: false,
    contextText: '',
    reasoning: false,
    ...over,
  };
}

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const screen = (app: TuiApp) => app.screen().map(stripAnsi);

describe('TuiApp', () => {
  it('shows the logo and a boxed prompt on a new chat, every row within the width', async () => {
    const io = fakeIO(80, 24);
    const app = new TuiApp(io, host());
    void app.run();
    await tick();
    const rows = screen(app);
    expect(rows).toHaveLength(24);
    expect(rows[0]).toContain('kovan');
    expect(rows[0]).toContain('m/x');
    expect(rows.join('\n')).toContain('█▄▀');
    expect(rows.join('\n')).toContain('╭');
    expect(rows.join('\n')).toContain('● hazır');
    expect(rows.every((r) => strWidth(r) <= 80)).toBe(true);
    io.send('\u0004'); // ctrl+d on an empty box leaves
    await tick();
    expect(io.tornDown).toBe(true);
  });

  it('sends what he typed, shows the answer, and keeps the screen the right size', async () => {
    const io = fakeIO(80, 24);
    const ref: { app?: TuiApp } = {};
    const h = host({
      turn: async (send) => {
        ref.app!.ui.event({ type: 'turn_start', model: 'm/x' } as never);
        ref.app!.ui.event({ type: 'text', text: `cevap: ${send}` } as never);
        ref.app!.ui.event({ type: 'turn_end', reason: 'done' } as never);
      },
    });
    const app = new TuiApp(io, h);
    ref.app = app;
    void app.run();
    io.send('selam');
    io.send('\r');
    await tick(80);
    const text = screen(app).join('\n');
    expect(text).toContain('selam');
    expect(text).toContain('cevap: selam');
    expect(screen(app)).toHaveLength(24);
  });

  it('backslash + enter makes a new line instead of sending', async () => {
    const io = fakeIO();
    const turn = vi.fn(async () => {});
    const app = new TuiApp(io, host({ turn }));
    void app.run();
    io.send('ilk\\');
    io.send('\r');
    io.send('ikinci');
    await tick();
    expect(turn).not.toHaveBeenCalled();
    io.send('\r');
    await tick();
    expect(turn).toHaveBeenCalledWith('ilk\nikinci');
  });

  it('tab cycles the permission mode', async () => {
    const io = fakeIO();
    const h = host();
    const app = new TuiApp(io, h);
    void app.run();
    io.send('\t');
    await tick();
    expect(h.mode()).toBe('plan');
    expect(screen(app)[0]).toContain('plan');
  });

  it('typing / lists commands and skills; tab completes', async () => {
    const io = fakeIO();
    const app = new TuiApp(io, host());
    void app.run();
    await tick();
    io.send('/rev');
    await tick();
    expect(screen(app).join('\n')).toContain('/review');
    io.send('\t');
    await tick();
    expect(screen(app).join('\n')).toContain('› /review ');
  });

  it('asks permission in a dialog and passes his answer back', async () => {
    const io = fakeIO();
    const app = new TuiApp(io, host());
    void app.run();
    const ac = new AbortController();
    const answer = app.ui.approve(
      { tool: 'run_shell', title: 'npm test', detail: 'npm test', kind: 'command' } as never,
      ac.signal,
    );
    await tick();
    expect(screen(app).join('\n')).toContain('izin ister');
    io.send('t');
    expect(await answer).toBe('always');
    await tick();
    expect(screen(app).join('\n')).not.toContain('izin ister');
  });

  it('a withdrawn question (the notch answered) closes the dialog with no answer', async () => {
    const io = fakeIO();
    const app = new TuiApp(io, host());
    void app.run();
    const ac = new AbortController();
    const answer = app.ui.approve(
      { tool: 'run_shell', title: 'x', detail: 'x', kind: 'command' } as never,
      ac.signal,
    );
    await tick();
    ac.abort();
    expect(await answer).toBeNull();
  });

  it('escape stops a running turn', async () => {
    const io = fakeIO();
    let release!: () => void;
    const stop = vi.fn(() => release());
    const app = new TuiApp(io, host({ turn: () => new Promise<void>((r) => (release = r)), stop }));
    void app.run();
    io.send('uzun iş');
    io.send('\r');
    await tick();
    expect(screen(app).join('\n')).toContain('çalışıyor');
    io.send('\u001b');
    await tick(60);
    expect(stop).toHaveBeenCalled();
  });

  it('/models opens a picker that filters and selects', async () => {
    const io = fakeIO();
    const setModel = vi.fn();
    const app = new TuiApp(io, host({ setModel }));
    void app.run();
    io.send('/models');
    io.send('\r');
    await tick();
    expect(screen(app).join('\n')).toContain('a/one');
    io.send('two');
    await tick();
    io.send('\r');
    await tick();
    expect(setModel).toHaveBeenCalledWith('b/two');
  });

  it('survives a tiny terminal', async () => {
    const io = fakeIO(30, 8);
    const app = new TuiApp(io, host());
    void app.run();
    io.send('x'.repeat(100));
    await tick();
    const rows = screen(app);
    expect(rows.length).toBeLessThanOrEqual(8);
    expect(rows.every((r) => strWidth(r) <= 30)).toBe(true);
  });
});

describe('effort slider', () => {
  it('opens on /effort, moves with the arrows and applies on enter', async () => {
    const io = fakeIO();
    const setEffort = vi.fn();
    const app = new TuiApp(io, host({ setEffort }));
    void app.run();
    io.send('/effort');
    io.send('\r');
    await tick();
    const text = screen(app).join('\n');
    expect(text).toContain('Daha hızlı');
    expect(text).toContain('Daha akıllı');
    expect(text).toContain('▲');
    expect(text).toContain('varsayılan efor');
    io.send('\u001b[C'); // right
    io.send('\r');
    await tick();
    expect(setEffort).toHaveBeenCalledWith('high');
  });
});
