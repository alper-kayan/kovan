import type { AgentEvent } from '@kovan/harness';

export interface RenderOptions {
  color: boolean;
  /** Show the model's reasoning instead of one quiet line. */
  reasoning: boolean;
}

const ESC = '\u001b[';
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * What an agent turn looks like in a terminal: the answer streams as it is written, each tool call is one line with its result
 * under it, and a turn ends with what it cost. Pure: it takes events and writes strings, so it can be tested without a terminal.
 */
export class Renderer {
  private midLine = false;
  private thought = false;
  private model = '';
  private tokensIn = 0;
  private tokensOut = 0;
  private cost = 0;
  private turnIn = 0;
  private turnOut = 0;
  private turnCost = 0;

  constructor(
    private readonly out: (s: string) => void,
    private readonly opts: RenderOptions,
  ) {}

  private paint(code: string, s: string) {
    return this.opts.color ? `${ESC}${code}m${s}${ESC}0m` : s;
  }
  private dim = (s: string) => this.paint('2', s);
  private red = (s: string) => this.paint('31', s);
  private green = (s: string) => this.paint('32', s);
  private yellow = (s: string) => this.paint('33', s);
  private cyan = (s: string) => this.paint('36', s);

  private line(s: string) {
    if (this.midLine) this.out('\n');
    this.out(`${s}\n`);
    this.midLine = false;
  }

  totals() {
    return { tokensIn: this.tokensIn, tokensOut: this.tokensOut, cost: this.cost };
  }

  event(e: AgentEvent): void {
    switch (e.type) {
      case 'turn_start':
        this.model = e.model;
        this.thought = false;
        this.turnIn = this.turnOut = this.turnCost = 0;
        break;
      case 'reasoning':
        if (this.opts.reasoning) {
          this.out(this.dim(e.text));
          this.midLine = !e.text.endsWith('\n');
        } else if (!this.thought) {
          this.thought = true;
          this.line(this.dim('· düşünüyor'));
        }
        break;
      case 'text':
        this.out(e.text);
        this.midLine = !e.text.endsWith('\n');
        break;
      case 'tool_start':
        this.line(`${this.cyan('●')} ${e.summary}`);
        break;
      case 'tool_end': {
        const first = e.output.split('\n').find((l) => l.trim()) ?? '';
        if (!e.ok) {
          const body = e.output
            .split('\n')
            .slice(0, 6)
            .map((l) => `    ${clip(l, 160)}`)
            .join('\n');
          this.line(`  ${this.red('✗')}\n${this.red(body)}`);
        } else if (
          e.meta?.path !== undefined &&
          (e.meta.added !== undefined || e.meta.removed !== undefined)
        ) {
          this.line(
            `  ${this.green('✓')} ${this.dim(`${e.meta.path} (+${e.meta.added ?? 0} −${e.meta.removed ?? 0})`)}`,
          );
        } else if (e.meta?.exitCode !== undefined) {
          const tail = e.output
            .split('\n')
            .filter((l) => l.trim())
            .slice(-3)
            .map((l) => `    ${clip(l, 160)}`)
            .join('\n');
          this.line(
            `  ${this.green('✓')} ${this.dim(`çıkış ${e.meta.exitCode}`)}${tail ? `\n${this.dim(tail)}` : ''}`,
          );
        } else {
          this.line(`  ${this.green('✓')}${first ? ` ${this.dim(clip(first, 80))}` : ''}`);
        }
        break;
      }
      case 'approval_resolved':
        this.line(this.dim(e.approved ? '  onaylandı' : '  reddedildi'));
        break;
      case 'usage':
        this.tokensIn += e.usage.promptTokens;
        this.tokensOut += e.usage.completionTokens;
        this.cost += e.usage.cost ?? 0;
        this.turnIn += e.usage.promptTokens;
        this.turnOut += e.usage.completionTokens;
        this.turnCost += e.usage.cost ?? 0;
        break;
      case 'compacted':
        this.line(this.dim(`· konuşmanın eski kısmı özetlendi (${e.before} → ${e.after} jeton)`));
        break;
      case 'outcome_unknown':
        this.line(
          this.yellow(
            `! yarıda kesilen komutun sonucu bilinmiyor: ${clip(e.command, 100)}. Elle kontrol et.`,
          ),
        );
        break;
      case 'turn_end': {
        const tail = `── ${this.model || '—'} · ${this.turnIn}→${this.turnOut} jeton${this.turnCost > 0 ? ` · $${this.turnCost.toFixed(4)}` : ''}`;
        if (e.reason === 'error') this.line(this.red(`hata: ${e.error ?? 'bilinmeyen'}`));
        else if (e.reason === 'stopped') this.line(this.yellow('durduruldu'));
        else if (e.reason === 'step_limit')
          this.line(this.yellow('adım sınırına ulaştı; devam etmesini söyleyebilirsin'));
        this.line(this.dim(tail));
        break;
      }
      default:
        break; // route, steer, approval (asked by the prompt), tool_progress: nothing to show
    }
  }
}
