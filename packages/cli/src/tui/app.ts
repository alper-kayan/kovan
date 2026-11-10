import type { ApprovalRequest, PermissionMode } from '@kovan/harness';
import { LineEditor } from './editor.js';
import { KeyParser, type Key } from './keys.js';
import {
  APPROVAL_CHOICES,
  buildFrame,
  filterItems,
  type Dialog,
  type ListItem,
  type View,
} from './layout.js';
import { Transcript, type TranscriptEvent } from './transcript.js';

/** The terminal, as the screen needs it. Real in io.ts; a stand-in in tests. */
export interface TuiIO {
  write(s: string): void;
  size(): { cols: number; rows: number };
  onData(cb: (data: Buffer | string) => void): void;
  onResize(cb: () => void): void;
  /** Raw mode, the alternate screen, bracketed paste. */
  setup(): void;
  /** Gives the terminal back as it was. Safe to call twice. */
  teardown(): void;
}

export type ApprovalAnswer = 'allow' | 'deny' | 'always';

/** What the screen asks of the agent side. Everything it shows or does goes through this, so the screen knows nothing of models or files. */
export interface TuiHost {
  header(): { model: string; provider: string; folder: string; managed: boolean };
  mode(): PermissionMode;
  setMode(m: PermissionMode): void;
  effort(): string;
  setEffort(e: string): void;
  efforts(): { levels: string[]; default: string };
  /** Resolves with a reason when the switch could not be made. */
  setModel(id: string): void | Promise<string | void>;
  /** The places a model can come from (an account, a provider), each with its own models. */
  models(): Promise<{ groups: ModelGroup[]; error?: string }>;
  /** Runs one turn and resolves when the agent is done with it. `shown` is what you typed (a custom command may send more text than that). */
  turn(send: string): Promise<void>;
  stop(): void;
  /** What a typed `/…` line is: a skill or custom command (`send` is what goes to the agent), or null for nothing known. */
  slash(line: string): Promise<{ send: string } | null>;
  /** Every command you can type: the built-ins, skills, custom commands. */
  palette(): Promise<ListItem[]>;
  sessions(): ListItem[];
  /** Switches to a saved conversation and returns what was said in it, or null when it cannot be loaded. */
  resume(id: string): TranscriptEvent[] | null;
  newChat(): void;
  history: string[];
  initialEvents: TranscriptEvent[];
  startLines: string[];
  notchEnabled: boolean;
  contextText: string;
  reasoning: boolean;
}

export interface ModelGroup {
  label: string;
  hint?: string;
  items: ListItem[];
  /** Said when the group has nothing to pick. */
  empty?: string;
}

export interface Ui {
  event(e: TranscriptEvent): void;
  /** Asks for permission on screen. Resolves with your answer, or null if the question was withdrawn (the notch answered first). */
  approve(r: ApprovalRequest, signal: AbortSignal): Promise<ApprovalAnswer | null>;
  note(text: string): void;
}

const MODE_CYCLE: PermissionMode[] = ['allow', 'plan', 'request', 'full'];

const BUILTINS: ListItem[] = [
  { label: '/help', hint: 'keys and commands', value: '/help' },
  { label: '/mode', hint: 'plan · request · allow · full', value: '/mode ' },
  { label: '/effort', hint: 'thinking effort (low … max)', value: '/effort ' },
  { label: '/models', hint: 'choose the model', value: '/models' },
  { label: '/resume', hint: 'continue an earlier chat', value: '/resume' },
  { label: '/sessions', hint: 'earlier chats', value: '/sessions' },
  { label: '/clear', hint: 'new chat', value: '/clear' },
  { label: '/cost', hint: 'tokens and cost', value: '/cost' },
  { label: '/context', hint: 'extra context given to this session', value: '/context' },
  { label: '/exit', hint: 'quit', value: '/exit' },
];

const HELP = [
  'enter send · \\+enter or alt+enter new line · ↑↓ history / line',
  'tab change mode (allow → plan → request → full) · esc stop the running turn',
  'pageup / pagedown scroll the chat · end jump to the bottom · ctrl+l redraw',
  '/resume goes back to an earlier chat · ctrl+p command palette · typing / suggests commands, skills and custom commands',
  'ctrl+a / ctrl+e start / end of line · ctrl+w delete word · ctrl+u / ctrl+k delete line',
  'ctrl+c stops the running turn; pressed twice when idle it quits · ctrl+d quits when the input is empty',
  '',
  'permission prompt: y yes · n no · a always this session (or ←→ and enter)',
];

export class TuiApp {
  private editor: LineEditor;
  private transcript: Transcript;
  private parser = new KeyParser();
  private dialog: Dialog | null = null;
  private onBack: (() => void) | null = null;
  private onPick: ((value: string) => void) | null = null;
  private resolveApproval: ((a: ApprovalAnswer | null) => void) | null = null;
  private scroll = 0;
  private running = false;
  private spin = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private scheduled: ReturnType<typeof setTimeout> | null = null;
  private escTimer: ReturnType<typeof setTimeout> | null = null;
  private prevRows: string[] = [];
  private palette: ListItem[] = BUILTINS;
  private suggIndex = 0;
  private note: string | null = null;
  private noteTimer: ReturnType<typeof setTimeout> | null = null;
  private quitArmed = false;
  private done: ((code: number) => void) | null = null;
  private exited = false;
  private lastTranscriptWidth = 0;

  constructor(
    private readonly io: TuiIO,
    private readonly host: TuiHost,
  ) {
    this.editor = new LineEditor(host.history);
    this.transcript = Transcript.from(host.initialEvents);
  }

  /** What the agent side calls to put things on the screen. */
  readonly ui: Ui = {
    event: (e) => {
      this.transcript.apply(e);
      this.schedule();
    },
    approve: (r, signal) => this.askPermission(r, signal),
    note: (t) => this.flash(t),
  };

  /** Runs until you leave. Resolves with the exit code. */
  run(): Promise<number> {
    this.io.setup();
    this.io.onData((d) => this.onData(d));
    this.io.onResize(() => {
      this.prevRows = [];
      this.schedule();
    });
    void this.host.palette().then((p) => {
      this.palette = [...BUILTINS, ...p.filter((i) => !BUILTINS.some((b) => b.label === i.label))];
      this.schedule();
    });
    this.draw();
    return new Promise((resolve) => (this.done = resolve));
  }

  private exit(code = 0): void {
    if (this.exited) return;
    this.exited = true;
    if (this.ticker) clearInterval(this.ticker);
    if (this.scheduled) clearTimeout(this.scheduled);
    this.io.teardown();
    this.done?.(code);
  }

  // ── input ──────────────────────────────────────────────────────────────────

  private onData(d: Buffer | string): void {
    if (this.escTimer) clearTimeout(this.escTimer);
    for (const k of this.parser.feed(d)) this.key(k);
    // A lone Escape is only an Escape if nothing follows it.
    this.escTimer = setTimeout(() => {
      for (const k of this.parser.flush()) this.key(k);
    }, 25);
    this.schedule();
  }

  private flash(text: string, ms = 2500): void {
    this.note = text;
    if (this.noteTimer) clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => {
      this.note = null;
      this.quitArmed = false;
      this.schedule();
    }, ms);
    this.schedule();
  }

  private key(k: Key): void {
    if (this.dialog) return this.dialogKey(k);
    const e = this.editor;
    const suggestions = this.suggestions();

    if (k.ctrl && k.name === 'c') {
      if (this.running) return void this.host.stop();
      if (!e.empty) return e.clear();
      if (this.quitArmed) return this.exit(0);
      this.quitArmed = true;
      return this.flash('press ctrl+c again to quit');
    }
    if (k.ctrl && k.name === 'd') return e.empty ? this.exit(0) : e.del();
    if (k.name === 'escape') {
      if (this.running) return void this.host.stop();
      if (suggestions.length) return void (this.suggDismissed = e.value);
      this.scroll = 0;
      return;
    }
    if (k.ctrl && k.name === 'l') {
      this.prevRows = [];
      return;
    }
    if (k.ctrl && k.name === 'p') return this.openPalette();
    if (k.name === 'pageup') return void (this.scroll += Math.max(3, this.io.size().rows - 8));
    if (k.name === 'pagedown')
      return void (this.scroll = Math.max(0, this.scroll - Math.max(3, this.io.size().rows - 8)));
    if (k.ctrl && k.name === 'end') return void (this.scroll = 0);

    if (k.name === 'tab') {
      if (suggestions.length) return this.complete(suggestions);
      return this.cycleMode();
    }
    if (k.name === 'backtab') return this.cycleMode(-1);
    if (k.name === 'enter' && !k.alt) {
      if (suggestions.length) {
        const item = suggestions[Math.min(this.suggIndex, suggestions.length - 1)]!;
        const typed = e.value.trim();
        // Enter on a half-typed command finishes it; on a finished one it sends it.
        if (typed !== item.label && typed !== item.value.trim()) return this.complete(suggestions);
      }
      if (e.value.endsWith('\\')) {
        e.value = e.value.slice(0, -1);
        e.cursor = e.value.length;
        return e.newline();
      }
      return void this.submit(e.value);
    }
    if (k.name === 'newline' || (k.name === 'enter' && k.alt)) return e.newline();

    if (suggestions.length && (k.name === 'up' || k.name === 'down')) {
      const n = suggestions.length;
      this.suggIndex = (this.suggIndex + (k.name === 'down' ? 1 : -1) + n) % n;
      return;
    }
    if (k.name === 'up' && k.shift) return void (this.scroll += 1);
    if (k.name === 'down' && k.shift) return void (this.scroll = Math.max(0, this.scroll - 1));

    switch (k.name) {
      case 'char':
        if (k.alt) {
          if (k.text === 'b') return e.wordLeft();
          if (k.text === 'f') return e.wordRight();
          if (k.text === 'd') return e.killWord();
          return;
        }
        e.insert(k.text ?? '');
        this.scroll = 0;
        return;
      case 'paste':
        e.insert(k.text ?? '');
        return;
      case 'backspace':
        return k.alt ? e.killWord() : e.backspace();
      case 'delete':
        return e.del();
      case 'left':
        return k.ctrl || k.alt ? e.wordLeft() : e.left();
      case 'right':
        return k.ctrl || k.alt ? e.wordRight() : e.right();
      case 'home':
        return e.home();
      case 'end':
        return e.end();
      case 'up':
        if (e.up()) return;
        if (e.historyPrev()) return;
        return void (this.scroll += 1);
      case 'down':
        if (e.down()) return;
        if (e.historyNext()) return;
        return void (this.scroll = Math.max(0, this.scroll - 1));
    }
    if (k.ctrl) {
      switch (k.name) {
        case 'a':
          return e.home();
        case 'e':
          return e.end();
        case 'b':
          return e.left();
        case 'f':
          return e.right();
        case 'w':
          return e.killWord();
        case 'u':
          return e.killToStart();
        case 'k':
          return e.killToEnd();
      }
    }
  }

  private suggDismissed = '';

  private cycleMode(dir = 1): void {
    const i = MODE_CYCLE.indexOf(this.host.mode());
    const next = MODE_CYCLE[(i + dir + MODE_CYCLE.length) % MODE_CYCLE.length]!;
    this.host.setMode(next);
    this.flash(`mod: ${next}`);
  }

  /** Slash suggestions: only while typing the command name itself, on a single line. */
  private suggestions(): ListItem[] {
    const v = this.editor.value;
    if (!v.startsWith('/') || v.includes('\n') || v.includes(' ') || v === this.suggDismissed)
      return [];
    const q = v.slice(1).toLowerCase();
    const all = this.palette.filter((i) => i.label.slice(1).toLowerCase().includes(q));
    return [
      ...all.filter((i) => i.label.slice(1).toLowerCase().startsWith(q)),
      ...all.filter((i) => !i.label.slice(1).toLowerCase().startsWith(q)),
    ];
  }

  private complete(items: ListItem[]): void {
    const item = items[Math.min(this.suggIndex, items.length - 1)]!;
    this.editor.setValue(
      item.value.endsWith(' ') || item.value === item.label ? `${item.label} ` : item.value,
    );
    this.suggIndex = 0;
  }

  private openPalette(): void {
    this.openList('commands', this.palette, 'no commands', (v) => {
      this.editor.setValue(v.endsWith(' ') ? v : `${v} `);
      if (!v.endsWith(' ')) void this.submit(v);
    });
  }

  private openList(
    title: string,
    items: ListItem[],
    empty: string,
    pick: (value: string) => void,
    back: (() => void) | null = null,
  ): void {
    this.dialog = { kind: 'list', title, items, filter: '', index: 0, empty };
    this.onPick = pick;
    this.onBack = back;
  }

  private dialogKey(k: Key): void {
    const d = this.dialog!;
    if (d.kind === 'help') {
      this.dialog = null;
      return;
    }
    if (d.kind === 'slider') {
      if (k.name === 'escape' || (k.ctrl && k.name === 'c')) this.dialog = null;
      else if (k.name === 'left') d.index = Math.max(0, d.index - 1);
      else if (k.name === 'right') d.index = Math.min(d.levels.length - 1, d.index + 1);
      else if (k.name === 'enter') {
        const level = d.levels[d.index]!;
        this.dialog = null;
        this.host.setEffort(level);
        this.flash(`effort: ${level}`);
      }
      return;
    }
    if (d.kind === 'approval') {
      const answer = (a: ApprovalAnswer) => this.closeApproval(a);
      if (k.name === 'escape' || (k.ctrl && k.name === 'c')) return answer('deny');
      if (k.name === 'char' && k.text) {
        const hit = APPROVAL_CHOICES.find((c) => c.key === k.text!.toLowerCase());
        if (hit) return answer(hit.value);
      }
      if (k.name === 'left' || k.name === 'backtab')
        d.choice = (d.choice + APPROVAL_CHOICES.length - 1) % APPROVAL_CHOICES.length;
      else if (k.name === 'right' || k.name === 'tab')
        d.choice = (d.choice + 1) % APPROVAL_CHOICES.length;
      else if (k.name === 'enter') return answer(APPROVAL_CHOICES[d.choice]!.value);
      return;
    }
    // a picker
    const items = filterItems(d.items, d.filter);
    if (k.name === 'escape' || (k.ctrl && k.name === 'c')) {
      const back = this.onBack;
      this.dialog = null;
      back?.();
      return;
    }
    if (k.name === 'enter') {
      const it = items[Math.min(d.index, items.length - 1)];
      const pick = this.onPick;
      this.dialog = null;
      if (it && pick) pick(it.value);
      return;
    }
    if (k.name === 'up') d.index = Math.max(0, d.index - 1);
    else if (k.name === 'down') d.index = Math.min(Math.max(0, items.length - 1), d.index + 1);
    else if (k.name === 'backspace') {
      d.filter = d.filter.slice(0, -1);
      d.index = 0;
    } else if ((k.name === 'char' || k.name === 'paste') && k.text) {
      d.filter += k.text;
      d.index = 0;
    }
  }

  private closeApproval(a: ApprovalAnswer | null): void {
    const r = this.resolveApproval;
    this.resolveApproval = null;
    this.dialog = null;
    r?.(a);
    this.schedule();
  }

  private askPermission(r: ApprovalRequest, signal: AbortSignal): Promise<ApprovalAnswer | null> {
    return new Promise((resolve) => {
      this.dialog = {
        kind: 'approval',
        title: r.title,
        detail: r.detail,
        choice: 0,
        notch: this.host.notchEnabled,
      };
      this.resolveApproval = resolve;
      // Withdrawn (the notch answered first): the question goes away and nobody waits for it.
      signal.addEventListener('abort', () => this.closeApproval(null), { once: true });
      this.schedule();
    });
  }

  // ── what you sent ───────────────────────────────────────────────────────────

  private async submit(raw: string): Promise<void> {
    const text = raw.trim();
    if (!text) return;
    if (this.running) return this.flash('working: press esc to stop it, then send');
    this.editor.remember(text);
    this.editor.clear();
    this.scroll = 0;
    this.suggDismissed = '';

    if (text.startsWith('/')) {
      if (await this.builtin(text)) return;
      const s = await this.host.slash(text);
      if (!s) return this.flash('unknown command: see /help and ctrl+p');
      return this.run1(s.send, text);
    }
    return this.run1(text, text);
  }

  /** The built-in commands. True when `text` was one of them. */
  private async builtin(text: string): Promise<boolean> {
    const [cmd = '', ...rest] = text.split(/\s+/);
    const arg = rest.join(' ').trim();
    switch (cmd) {
      case '/exit':
      case '/quit':
        this.exit(0);
        return true;
      case '/help':
        this.dialog = { kind: 'help', lines: HELP };
        return true;
      case '/clear':
        this.host.newChat();
        this.transcript.clear();
        this.flash('new chat');
        return true;
      case '/cost': {
        const t = this.transcript.totals;
        this.transcript.notice(
          `${t.tokensIn}→${t.tokensOut} tokens${t.cost > 0 ? ` · $${t.cost.toFixed(4)}` : ''}`,
        );
        return true;
      }
      case '/context':
        this.transcript.notice(
          this.host.contextText
            ? this.host.contextText.slice(0, 600)
            : 'No extra context was given to this chat.',
        );
        return true;
      case '/mode': {
        const m = (['plan', 'request', 'allow', 'full'] as const).find((x) => x === arg);
        if (m) {
          this.host.setMode(m);
          this.flash(`mod: ${m}`);
        } else
          this.openList(
            'mod',
            ['plan', 'request', 'allow', 'full'].map((m2) => ({
              label: m2,
              hint: MODE_HINT[m2] ?? '',
              value: m2,
            })),
            '',
            (v) => {
              this.host.setMode(v as PermissionMode);
              this.flash(`mod: ${v}`);
            },
          );
        return true;
      }
      case '/effort': {
        const { levels, default: def } = this.host.efforts();
        const e = levels.find((x) => x === arg);
        if (e) {
          this.host.setEffort(e);
          this.flash(`effort: ${e}`);
        } else {
          const cur = levels.indexOf(this.host.effort());
          const defaultIndex = Math.max(0, levels.indexOf(def));
          this.dialog = {
            kind: 'slider',
            title: 'Effort',
            levels,
            index: cur >= 0 ? cur : defaultIndex,
            defaultIndex,
          };
        }
        return true;
      }
      case '/model':
      case '/models':
        if (cmd === '/model' && arg) {
          this.chooseModel(arg);
        } else {
          // First the places (accounts, providers); the models of the one you pick come second.
          this.openList('model', [], 'loading accounts…', () => {});
          const d = this.dialog;
          void this.host.models().then((m) => {
            if (!d || d.kind !== 'list' || this.dialog !== d) return;
            const showGroups = () => {
              this.openList(
                'model · choose an account',
                m.groups.map((g, i) => ({ label: g.label, hint: g.hint ?? '', value: String(i) })),
                m.error ?? 'no accounts available',
                (v) => {
                  const g = m.groups[Number(v)];
                  if (!g) return;
                  this.openList(
                    g.label,
                    g.items,
                    g.empty ?? 'no models on this account',
                    (id) => this.chooseModel(id),
                    showGroups,
                  );
                },
              );
            };
            showGroups();
            this.schedule();
          });
        }
        return true;
      case '/resume':
      case '/sessions':
        this.openList('chats', this.host.sessions(), 'no chats in this folder', (id) => {
          const events = this.host.resume(id);
          if (!events) return this.flash("couldn't load the chat");
          this.transcript = Transcript.from(events);
          this.scroll = 0;
          this.flash('chat opened');
        });
        return true;
      case '/skills':
        this.openList(
          'skills and commands',
          this.palette.filter((i) => !BUILTINS.some((b) => b.label === i.label)),
          'No skills: folders with a SKILL.md go under .claude/skills or ~/.claude/skills',
          (v) => this.editor.setValue(v),
        );
        return true;
      default:
        return false;
    }
  }

  private chooseModel(id: string): void {
    this.flash(`model: ${id}`, 8000);
    void Promise.resolve(this.host.setModel(id)).then((why) => {
      if (why) this.flash(why, 6000);
    });
  }

  private async run1(send: string, shown: string): Promise<void> {
    this.transcript.addUser(shown);
    this.running = true;
    this.ticker = setInterval(() => {
      this.spin += 1;
      this.schedule();
    }, 90);
    this.schedule();
    try {
      await this.host.turn(send);
    } catch (e) {
      this.transcript.notice(`error: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      this.running = false;
      if (this.ticker) clearInterval(this.ticker);
      this.ticker = null;
      this.schedule();
    }
  }

  // ── drawing ────────────────────────────────────────────────────────────────

  private schedule(): void {
    if (this.scheduled || this.exited) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      this.draw();
    }, 16);
  }

  /** The view as it is right now. Also what tests look at. */
  view(): View {
    const { cols, rows } = this.io.size();
    const h = this.host.header();
    this.lastTranscriptWidth = cols;
    const sugg = this.suggestions();
    const t = this.transcript.totals;
    return {
      width: cols,
      height: rows,
      header: {
        model: h.model,
        provider: h.provider,
        folder: h.folder,
        mode: this.host.mode(),
        effort: this.host.effort(),
        cost: t.cost,
      },
      transcript: this.transcript.render(cols, { reasoning: this.host.reasoning, spin: this.spin }),
      hasBlocks: this.transcript.blocks.length > 0,
      scroll: this.scroll,
      editor: this.editor,
      running: this.running,
      spin: this.spin,
      dialog: this.dialog,
      suggestions: sugg.length
        ? { items: sugg, index: Math.min(this.suggIndex, sugg.length - 1) }
        : null,
      status: {
        tokens: t.tokensIn || t.tokensOut ? `${t.tokensIn}→${t.tokensOut} tokens` : '',
        cost: t.cost,
        note: this.note,
      },
      startLines: this.host.startLines,
    };
  }

  draw(): void {
    if (this.exited) return;
    const frame = buildFrame(this.view());
    let out = '\u001b[?2026h';
    frame.rows.forEach((row, i) => {
      if (this.prevRows[i] !== row) out += `\u001b[${i + 1};1H${row}\u001b[0m\u001b[K`;
    });
    // Rows that used to be there and are not any more.
    for (let i = frame.rows.length; i < this.prevRows.length; i++)
      out += `\u001b[${i + 1};1H\u001b[K`;
    out += frame.cursor
      ? `\u001b[${frame.cursor.row + 1};${frame.cursor.col + 1}H\u001b[?25h`
      : '\u001b[?25l';
    out += '\u001b[?2026l';
    this.prevRows = frame.rows;
    this.io.write(out);
  }

  /** For tests: the rows of the screen right now. */
  screen(): string[] {
    return buildFrame(this.view()).rows;
  }
}

const MODE_HINT: Record<string, string> = {
  plan: 'only reads, changes nothing',
  request: 'asks before every edit and command',
  allow: 'edits files, asks before commands',
  full: 'asks nothing',
};
