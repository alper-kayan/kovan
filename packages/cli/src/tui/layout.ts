import type { LineEditor } from './editor.js';
import { hardWrap } from './editor.js';
import { MODE_STYLE, S, paint } from './style.js';
import { SPINNER } from './transcript.js';
import { padEnd, strWidth, truncate } from './text.js';

/**
 * The whole screen as a list of rows, from a description of what is on it. No terminal, no state: the same view gives the same rows, so the
 * screen can be checked as text. The controller (app.ts) decides what the view is; this decides where everything goes.
 *
 *   ┌ header: name, model, folder, mode, cost
 *   │ the conversation (or the start screen), newest at the bottom when it overflows
 *   │ slash suggestions (when typing /…)
 *   ├ the box you type in (or a dialog: permission, picker, help)
 *   └ status: what it is doing, tokens, the keys that matter
 */
export interface ListItem {
  label: string;
  hint?: string;
  value: string;
}

export type Dialog =
  | { kind: 'approval'; title: string; detail: string; choice: number; notch: boolean }
  | { kind: 'list'; title: string; items: ListItem[]; filter: string; index: number; empty: string }
  | { kind: 'help'; lines: string[] }
  | { kind: 'slider'; title: string; levels: string[]; index: number; defaultIndex: number };

export interface View {
  width: number;
  height: number;
  header: {
    model: string;
    provider: string;
    folder: string;
    mode: string;
    effort: string;
    cost: number;
  };
  transcript: string[];
  hasBlocks: boolean;
  /** Lines scrolled up from the newest; 0 follows the tail. */
  scroll: number;
  editor: LineEditor;
  running: boolean;
  spin: number;
  dialog: Dialog | null;
  /** Slash suggestions under the transcript, above the box. */
  suggestions: { items: ListItem[]; index: number } | null;
  status: { tokens: string; cost: number; note: string | null };
  /** Extra lines for the start screen (what is loaded, what is connected). */
  startLines: string[];
}

export interface Frame {
  rows: string[];
  /** Where the real cursor goes (inside the input box), or null when a dialog has the keyboard. */
  cursor: { row: number; col: number } | null;
}

const LOGO = ['█▄▀ █▀█ █ █ ▄▀█ █▄ █', '█ █ █▄█ ▀▄▀ █▀█ █ ▀█'];

export const APPROVAL_CHOICES = [
  { key: 'y', label: 'yes', value: 'allow' },
  { key: 'n', label: 'no', value: 'deny' },
  { key: 'a', label: 'always this session', value: 'always' },
] as const;

export const KEY_HINTS = 'tab mode · / commands · ctrl+p palette · esc stop · ctrl+c quit';

/** A bordered box with a title on the top edge; every row is exactly `width` columns. */
export function box(
  title: string,
  lines: string[],
  width: number,
  border = S.gray,
  titleStyle = S.accentBold,
): string[] {
  const inner = Math.max(4, width - 4);
  const label = title ? ` ${title} ` : '';
  const top = `${paint(border, '╭─')}${paint(titleStyle, truncate(label, inner))}${paint(border, `${'─'.repeat(Math.max(0, inner + 1 - strWidth(truncate(label, inner))))}╮`)}`;
  const mid = lines.map((l) => `${paint(border, '│')} ${padEnd(l, inner)} ${paint(border, '│')}`);
  const bottom = paint(border, `╰${'─'.repeat(inner + 2)}╯`);
  return [top, ...mid, bottom];
}

function headerRows(v: View): string[] {
  const { header } = v;
  const modeStyle = MODE_STYLE[header.mode] ?? S.dim;
  const left = ` ${paint(S.accentBold, 'kovan')}${paint(S.dim, '  ·  ')}${header.model}${paint(S.dim, '  ·  ')}${paint(S.dim, header.provider)}${paint(S.dim, '  ·  ')}${header.folder}`;
  const right = `${paint(modeStyle, header.mode)}${header.cost > 0 ? paint(S.dim, `  $${header.cost.toFixed(2)}`) : ''} `;
  const gap = v.width - strWidth(left) - strWidth(right);
  const line =
    gap >= 1
      ? left + ' '.repeat(gap) + right
      : truncate(left, v.width - strWidth(right) - 1) + ' ' + right;
  return [line, paint(S.gray, '─'.repeat(v.width))];
}

function startScreen(v: View, room: number): string[] {
  const center = (s: string) =>
    ' '.repeat(Math.max(0, Math.floor((v.width - strWidth(s)) / 2))) + s;
  const lines = [
    ...LOGO.map((l) => center(paint(S.accentBold, l))),
    '',
    center(paint(S.dim, `${v.header.model} · ${v.header.provider}`)),
    center(paint(S.dim, v.header.folder)),
    '',
    ...v.startLines.map((l) => center(l)),
    '',
    center(
      `${paint(S.accent, '/')} ${paint(S.dim, "komutlar ve skill'ler")}    ${paint(S.accent, 'tab')} ${paint(S.dim, 'mod')}    ${paint(S.accent, 'ctrl+p')} ${paint(S.dim, 'palet')}`,
    ),
    center(
      `${paint(S.accent, '\\')}${paint(S.dim, '+enter or ')}${paint(S.accent, 'alt+enter')} ${paint(S.dim, 'new line')}    ${paint(S.accent, 'ctrl+c')} ${paint(S.dim, 'quit')}`,
    ),
  ];
  const top = Math.max(0, Math.floor((room - lines.length) / 3));
  return [...Array<string>(top).fill(''), ...lines];
}

function inputBox(v: View): { rows: string[]; cursor: { row: number; col: number } } {
  const inner = Math.max(8, v.width - 4);
  const avail = inner - 2; // the prompt glyph takes two columns
  const ed = v.editor;
  const wrapped: { text: string; first: boolean }[] = [];
  const logical = ed.lines();
  logical.forEach((line, li) =>
    hardWrap(line, avail).forEach((piece, pi) =>
      wrapped.push({ text: piece, first: li === 0 && pi === 0 }),
    ),
  );

  // Where the cursor falls among the wrapped rows.
  const { row: crow, col: ccol } = ed.cursorRowCol();
  let cursorRow = 0;
  for (let li = 0; li < crow; li++) cursorRow += hardWrap(logical[li]!, avail).length;
  cursorRow += Math.floor(ccol / avail);
  const cursorCol = ccol % avail;
  if (cursorRow >= wrapped.length) cursorRow = wrapped.length - 1;

  const MAX = 8;
  let start = 0;
  if (wrapped.length > MAX)
    start = Math.min(Math.max(0, cursorRow - MAX + 1), wrapped.length - MAX);
  const shown = wrapped.slice(start, start + MAX);

  const placeholder = v.running
    ? 'working… esc to stop'
    : 'type something · / commands · \\+enter new line';
  const rows = shown.map((w, i) => {
    const glyph = w.first ? paint(v.running ? S.dim : S.accentBold, '› ') : '  ';
    const text = ed.empty && i === 0 ? paint(S.dim, placeholder) : w.text;
    return glyph + text;
  });
  const modeLabel = `${paint(MODE_STYLE[v.header.mode] ?? S.dim, v.header.mode)}${paint(S.dim, ` · efor: ${v.header.effort}`)}`;
  const boxed = box(modeLabel, rows, v.width, v.running ? S.gray : S.accent, '');
  return { rows: boxed, cursor: { row: 1 + (cursorRow - start), col: 2 + 2 + cursorCol } };
}

function dialogRows(d: Dialog, v: View): string[] {
  if (d.kind === 'approval') {
    const detail = d.detail
      .split('\n')
      .slice(0, 6)
      .map((l) => truncate(l, v.width - 6));
    const choices = APPROVAL_CHOICES.map((c, i) => {
      const label = `[${c.key}] ${c.label}`;
      return i === d.choice
        ? paint(S.inverse + S.accent, ` ${label} `)
        : paint(S.dim, ` ${label} `);
    }).join('  ');
    const note = d.notch ? [paint(S.dim, 'can also be answered from the notch')] : [];
    return box(
      'asks permission',
      [
        paint(S.bold, truncate(d.title, v.width - 6)),
        ...detail.map((l) => paint(S.dim, l)),
        '',
        choices,
        ...note,
      ],
      v.width,
      S.yellow,
      S.yellow + S.bold,
    );
  }
  if (d.kind === 'slider') {
    // Faster ←→ Smarter: one mark under the chosen level, labels spread evenly.
    const inner = Math.max(20, v.width - 6);
    const n = d.levels.length;
    const slot = Math.floor(inner / n);
    const cell = (s: string, style = '') => {
      const pad = Math.max(0, slot - strWidth(s));
      const left = Math.floor(pad / 2);
      return ' '.repeat(left) + (style ? paint(style, s) : s) + ' '.repeat(pad - left);
    };
    const marker = d.levels.map((_, i) => cell(i === d.index ? '▲' : '', S.accentBold)).join('');
    const track = paint(S.gray, '─'.repeat(slot * n));
    const labels = d.levels.map((l, i) => cell(l, i === d.index ? S.accentBold : S.dim)).join('');
    const head = `${paint(S.dim, 'Faster')}${' '.repeat(Math.max(1, slot * n - strWidth('Faster') - strWidth('Smarter')))}${paint(S.dim, 'Smarter')}`;
    const note = d.index === d.defaultIndex ? "This model's default effort." : '';
    return box(
      d.title,
      [
        head,
        marker,
        track,
        labels,
        paint(S.dim, note),
        paint(S.dim, '←/→ adjust · enter confirm · esc cancel'),
      ],
      v.width,
    );
  }
  if (d.kind === 'help')
    return box(
      'help',
      d.lines.map((l) => truncate(l, v.width - 4)),
      v.width,
    );
  const items = filterItems(d.items, d.filter);
  const MAX = Math.max(3, Math.min(10, v.height - 12));
  const start = Math.min(Math.max(0, d.index - MAX + 1), Math.max(0, items.length - MAX));
  const rows = items.slice(start, start + MAX).map((it, i) => {
    const line = `${it.label}${it.hint ? paint(S.dim, `  ${it.hint}`) : ''}`;
    return start + i === d.index
      ? paint(S.inverse, ` ${padEnd(stripToWidth(line, v.width - 8), v.width - 8)} `)
      : `  ${truncate(line, v.width - 8)}`;
  });
  const filter = `${paint(S.accent, '› ')}${d.filter}${paint(S.dim, d.filter ? '' : 'filter…')}`;
  return box(
    d.title,
    [
      filter,
      ...(rows.length ? rows : [paint(S.dim, d.empty)]),
      paint(S.dim, '↑↓ choose · enter ok · esc cancel'),
    ],
    v.width,
  );
}

// eslint-disable-next-line no-control-regex
const stripToWidth = (s: string, w: number) => truncate(s.replace(/\u001b\[[0-9;]*m/g, ''), w);

export function filterItems(items: ListItem[], filter: string): ListItem[] {
  const f = filter.trim().toLowerCase();
  return f ? items.filter((i) => `${i.label} ${i.hint ?? ''}`.toLowerCase().includes(f)) : items;
}

function suggestionRows(v: View): string[] {
  const s = v.suggestions;
  if (!s || s.items.length === 0) return [];
  const MAX = 6;
  const start = Math.min(Math.max(0, s.index - MAX + 1), Math.max(0, s.items.length - MAX));
  return s.items.slice(start, start + MAX).map((it, i) => {
    const text = `${it.label}${it.hint ? `  ${it.hint}` : ''}`;
    return start + i === s.index
      ? paint(S.inverse + S.accent, ` ${padEnd(truncate(text, v.width - 4), v.width - 4)} `)
      : ` ${paint(S.accent, truncate(it.label, 28))}${it.hint ? paint(S.dim, `  ${truncate(it.hint, v.width - 34)}`) : ''}`;
  });
}

function statusRow(v: View): string {
  const state = v.running
    ? paint(S.accent, `${SPINNER[v.spin % SPINNER.length]} working`)
    : paint(S.green, '● ready');
  const left = ` ${state}${paint(S.dim, `  ${v.status.tokens}`)}${v.status.note ? `  ${paint(S.yellow, v.status.note)}` : ''}`;
  const right = `${paint(S.dim, KEY_HINTS)} `;
  const gap = v.width - strWidth(left) - strWidth(right);
  return gap >= 2 ? left + ' '.repeat(gap) + right : truncate(left, v.width);
}

export function buildFrame(v: View): Frame {
  const head = headerRows(v);
  const input = v.dialog ? null : inputBox(v);
  const bottom = v.dialog ? dialogRows(v.dialog, v) : input!.rows;
  const sugg = v.dialog ? [] : suggestionRows(v);
  const status = statusRow(v);
  const area = Math.max(1, v.height - head.length - bottom.length - sugg.length - 1);

  // The conversation (or the start screen), with the newest lines in view.
  let body: string[];
  if (!v.hasBlocks) body = startScreen(v, area);
  else {
    const all = v.transcript;
    const maxScroll = Math.max(0, all.length - area);
    const scroll = Math.min(Math.max(0, v.scroll), maxScroll);
    const end = all.length - scroll;
    body = all.slice(Math.max(0, end - area), end);
    if (scroll > 0 && body.length)
      body[body.length - 1] = paint(S.yellow, ` ↓ ${scroll} more lines below · pagedown or end`);
  }
  const blank = Array<string>(Math.max(0, area - body.length)).fill('');
  const rows = [...head, ...body.slice(0, area), ...blank, ...sugg, ...bottom, status].map((r) =>
    truncate(r, v.width, ''),
  );
  // Never taller than the screen.
  const framed = rows.slice(0, v.height);
  const cursor = input
    ? { row: head.length + area + sugg.length + input.cursor.row, col: input.cursor.col }
    : null;
  return { rows: framed, cursor };
}
