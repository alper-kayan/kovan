import type { AgentEvent } from '@kovan/harness';
import { renderMarkdown } from './markdown.js';
import { S, paint } from './style.js';
import { layoutSpans, truncate } from './text.js';

/** What the screen replays: his messages and the agent's events, in the order they happened (the same shapes the desktop app stores). */
export type TranscriptEvent =
  AgentEvent | { type: 'user'; text: string; attachments?: string[]; at?: number };

type ToolMeta = { path?: string; added?: number; removed?: number; exitCode?: number | null };

export type Block =
  | { kind: 'user'; text: string; rev: number }
  | { kind: 'assistant'; text: string; rev: number }
  | { kind: 'thinking'; text: string; rev: number }
  | {
      kind: 'tool';
      id: string;
      name: string;
      summary: string;
      args: Record<string, unknown>;
      status: 'running' | 'ok' | 'fail';
      output: string;
      meta?: ToolMeta | undefined;
      rev: number;
    }
  | { kind: 'notice'; text: string; tone: 'dim' | 'warn' | 'error'; rev: number }
  | { kind: 'footer'; text: string; rev: number };

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface RenderOptions {
  /** Show the model's reasoning instead of one quiet line. */
  reasoning: boolean;
  /** Which frame of the spinner a running tool shows. */
  spin: number;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export class Transcript {
  blocks: Block[] = [];
  model = '';
  totals = { tokensIn: 0, tokensOut: 0, cost: 0 };
  private turn = { tokensIn: 0, tokensOut: 0, cost: 0 };
  private assistant: Extract<Block, { kind: 'assistant' }> | null = null;
  private thinking: Extract<Block, { kind: 'thinking' }> | null = null;
  private cache = new WeakMap<Block, { key: string; lines: string[] }>();

  static from(events: TranscriptEvent[]): Transcript {
    const t = new Transcript();
    for (const e of events) t.apply(e);
    return t;
  }

  get running(): boolean {
    return this.blocks.some((b) => b.kind === 'tool' && b.status === 'running');
  }

  addUser(text: string): void {
    this.assistant = this.thinking = null;
    this.blocks.push({ kind: 'user', text, rev: 0 });
  }

  notice(text: string, tone: 'dim' | 'warn' | 'error' = 'dim'): void {
    this.blocks.push({ kind: 'notice', text, tone, rev: 0 });
  }

  clear(): void {
    this.blocks = [];
    this.assistant = this.thinking = null;
  }

  apply(e: TranscriptEvent): void {
    switch (e.type) {
      case 'user':
        this.addUser(e.text);
        return;
      case 'turn_start':
        this.model = e.model;
        this.turn = { tokensIn: 0, tokensOut: 0, cost: 0 };
        this.assistant = this.thinking = null;
        return;
      case 'reasoning': {
        if (!this.thinking) {
          this.thinking = { kind: 'thinking', text: '', rev: 0 };
          this.blocks.push(this.thinking);
        }
        this.thinking.text += e.text;
        this.thinking.rev++;
        return;
      }
      case 'text': {
        this.thinking = null;
        if (!this.assistant) {
          this.assistant = { kind: 'assistant', text: '', rev: 0 };
          this.blocks.push(this.assistant);
        }
        this.assistant.text += e.text;
        this.assistant.rev++;
        return;
      }
      case 'tool_start':
        this.assistant = this.thinking = null;
        this.blocks.push({
          kind: 'tool',
          id: e.id,
          name: e.name,
          summary: e.summary,
          args: e.args,
          status: 'running',
          output: '',
          rev: 0,
        });
        return;
      case 'tool_end': {
        const b = [...this.blocks]
          .reverse()
          .find((x): x is Extract<Block, { kind: 'tool' }> => x.kind === 'tool' && x.id === e.id);
        if (b) {
          b.status = e.ok ? 'ok' : 'fail';
          b.output = e.output;
          b.meta = e.meta;
          b.rev++;
        }
        return;
      }
      case 'usage':
        this.turn.tokensIn += e.usage.promptTokens;
        this.turn.tokensOut += e.usage.completionTokens;
        this.turn.cost += e.usage.cost ?? 0;
        this.totals.tokensIn += e.usage.promptTokens;
        this.totals.tokensOut += e.usage.completionTokens;
        this.totals.cost += e.usage.cost ?? 0;
        return;
      case 'compacted':
        this.notice(`konuşmanın eski kısmı özetlendi (${e.before} → ${e.after} jeton)`);
        return;
      case 'outcome_unknown':
        this.notice(
          `yarıda kesilen komutun sonucu bilinmiyor: ${clip(e.command, 100)}. Elle kontrol et.`,
          'warn',
        );
        return;
      case 'turn_end': {
        // A tool that never reported back (the turn was stopped) is not still running.
        for (const b of this.blocks) {
          if (b.kind === 'tool' && b.status === 'running') {
            b.status = 'fail';
            b.rev++;
          }
        }
        if (e.reason === 'error') this.notice(`hata: ${e.error ?? 'bilinmeyen'}`, 'error');
        else if (e.reason === 'stopped') this.notice('durduruldu', 'warn');
        else if (e.reason === 'step_limit')
          this.notice('adım sınırına ulaştı; devam etmesini söyleyebilirsin', 'warn');
        const t = this.turn;
        this.blocks.push({
          kind: 'footer',
          text: `${this.model || '—'} · ${t.tokensIn}→${t.tokensOut} jeton${t.cost > 0 ? ` · $${t.cost.toFixed(4)}` : ''}`,
          rev: 0,
        });
        this.assistant = this.thinking = null;
        return;
      }
      default:
        return; // route, steer, approval (asked by a dialog), tool_progress, approval_resolved
    }
  }

  /** The whole conversation as lines for `width` columns. Blocks that have not changed are not laid out again. */
  render(width: number, o: RenderOptions): string[] {
    const out: string[] = [];
    let prev: Block | null = null;
    for (const b of this.blocks) {
      const key = `${width}|${o.reasoning ? 1 : 0}|${b.kind === 'tool' && b.status === 'running' ? o.spin : 0}|${b.rev}`;
      let hit = this.cache.get(b);
      if (!hit || hit.key !== key) {
        hit = { key, lines: this.renderBlock(b, width, o) };
        this.cache.set(b, hit);
      }
      // Tool calls sit tight together; everything else is set apart by a blank line.
      const tight = prev && prev.kind === 'tool' && b.kind === 'tool';
      const quiet = b.kind === 'footer' || b.kind === 'notice';
      if (out.length && !tight && !quiet) out.push('');
      out.push(...hit.lines);
      prev = b;
    }
    return out;
  }

  private renderBlock(b: Block, width: number, o: RenderOptions): string[] {
    switch (b.kind) {
      case 'user': {
        const bar = paint(S.userBar, '┃ ');
        return layoutSpans([{ text: b.text, style: S.bold }], width - 2, bar, bar);
      }
      case 'assistant':
        return renderMarkdown(b.text.replace(/^\n+/, ''), width, '  ');
      case 'thinking':
        return o.reasoning
          ? layoutSpans([{ text: b.text.trim(), style: S.dim + S.italic }], width - 2, '  ', '  ')
          : [`  ${paint(S.dim, '· düşünüyor')}`];
      case 'notice': {
        const style = b.tone === 'error' ? S.red : b.tone === 'warn' ? S.yellow : S.dim;
        return layoutSpans([{ text: b.text, style }], width - 2, '  · ', '    ');
      }
      case 'footer':
        return [`  ${paint(S.dim, `── ${b.text}`)}`];
      case 'tool':
        return this.renderTool(b, width, o);
    }
  }

  private renderTool(
    b: Extract<Block, { kind: 'tool' }>,
    width: number,
    o: RenderOptions,
  ): string[] {
    const icon =
      b.status === 'running'
        ? paint(S.accent, SPINNER[o.spin % SPINNER.length]!)
        : b.status === 'ok'
          ? paint(S.green, '✓')
          : paint(S.red, '✗');
    const head = `  ${icon} ${truncate(b.summary, width - 6)}`;
    const body: string[] = [];
    const pad = '      ';
    const room = width - pad.length;
    const args = b.args;

    if (b.name === 'edit_file' && typeof args['old_string'] === 'string') {
      const rows = (s: string, mark: string, style: string) =>
        s
          .split('\n')
          .slice(0, 6)
          .map((l) => `${pad}${paint(style, `${mark} ${truncate(l, room - 2, '…')}`)}`);
      body.push(
        ...rows(String(args['old_string']), '-', S.del),
        ...rows(String(args['new_string'] ?? ''), '+', S.add),
      );
    } else if (b.name === 'write_file' && typeof args['content'] === 'string') {
      const n = String(args['content']).split('\n').length;
      body.push(`${pad}${paint(S.dim, `${n} satır yazıldı`)}`);
    } else if (b.name === 'run_shell') {
      const cmd = String(args['command'] ?? '');
      body.push(
        ...cmd
          .split('\n')
          .slice(0, 4)
          .map(
            (l, i) => `${pad}${paint(S.dim, `${i === 0 ? '$' : ' '} ${truncate(l, room - 2)}`)}`,
          ),
      );
      if (b.status !== 'running') {
        const tail = b.output
          .split('\n')
          .filter((l) => l.trim())
          .slice(-6);
        body.push(
          ...tail.map(
            (l) => `${pad}${paint(b.status === 'fail' ? S.red : S.dim, truncate(l, room))}`,
          ),
        );
      }
    }
    if (b.status === 'fail' && b.name !== 'run_shell') {
      body.push(
        ...b.output
          .split('\n')
          .filter((l) => l.trim())
          .slice(0, 4)
          .map((l) => `${pad}${paint(S.red, truncate(l, room))}`),
      );
    }
    return [head, ...body];
  }
}
