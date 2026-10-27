import type { AgentEvent } from '@kovan/harness';
import type { ChildProcess } from 'node:child_process';

type Steer = { id: string; text: string; fromUserId?: string; fromName?: string };

/**
 * Claude Code's task on stdin (`--input-format stream-json`), so teammates' messages can follow
 * while it works: Claude Code takes a message at its next step, in the running turn. A message
 * counts as delivered once Claude Code answers after it; one that comes as the turn ends gets
 * one more turn. stdin closes after the turn, which ends the process.
 */
export class ClaudeLiveInput {
  private written: Steer[] = [];
  private open = false;

  constructor(
    private readonly child: ChildProcess,
    private readonly onEvent: (event: AgentEvent) => void,
  ) {
    child.stdin?.on('error', () => undefined);
  }

  /** Messages written to the turn that Claude Code hasn't answered after yet. */
  get pending(): number {
    return this.written.length;
  }

  /** Whether the turn still takes messages. */
  get running(): boolean {
    return this.open;
  }

  start(task: string): void {
    this.open = true;
    this.write(task);
  }

  steer(steer: Steer): boolean {
    if (!this.open) return false;
    const who = steer.fromName ? ` from ${steer.fromName}` : '';
    this.write(`Message${who} while you work: ${steer.text}`);
    this.written.push(steer);
    return true;
  }

  /** Sees each stream-json line first: false keeps it from the parser (an early result). */
  line(line: Record<string, unknown>): boolean {
    if (line['type'] === 'assistant' && this.written.length) {
      for (const s of this.written) this.onEvent({ type: 'steer', ...s, status: 'delivered' });
      this.written = [];
    }
    if (line['type'] === 'result') {
      if (this.written.length && this.open) return false;
      this.close();
    }
    return true;
  }

  /** The process ended: messages it never answered go back to whoever wrote them. */
  end(): void {
    this.open = false;
    for (const s of this.written) this.onEvent({ type: 'steer', ...s, status: 'returned' });
    this.written = [];
  }

  private write(text: string): void {
    this.child.stdin?.write(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      }) + '\n',
    );
  }

  private close(): void {
    if (!this.open) return;
    this.open = false;
    this.child.stdin?.end();
  }
}
