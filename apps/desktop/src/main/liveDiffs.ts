import { createHash } from 'node:crypto';

export interface LiveDiffDeps {
  /** The Brain; errors carry the HTTP status (0 when the server can't be reached). */
  request(method: 'PUT', path: string, body: unknown): Promise<unknown>;
  /** The checkout's changes against the base branch, and the commit it sits on. */
  read(root: string): Promise<{ diff: string | null; commit: string | null }>;
  signedIn(): boolean;
  /** How long changes settle before they are read (agents write files in bursts). */
  delayMs?: number;
  /** How long to wait before trying again when the server can't be reached. */
  retryMs?: number;
}

const DELAY_MS = 3_000;
const RETRY_MS = 30_000;

/**
 * Keeps the server's view of each live session's changes on this machine current, so phones
 * and teammates can read the diff and comment on its lines while agents still work. A view
 * goes out only when it differs from the last one sent; a session that ended (or that this
 * person can't work in) is left alone from then on.
 */
export class LiveDiffs {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly roots = new Map<string, string>();
  private readonly sent = new Map<string, string>();
  private readonly busy = new Map<string, Promise<void>>();
  private readonly gone = new Set<string>();

  constructor(private readonly deps: LiveDiffDeps) {}

  /** Files may have changed in the session's checkout at `root`. */
  changed(sessionId: string, root: string, delayMs = this.deps.delayMs ?? DELAY_MS): void {
    if (this.gone.has(sessionId)) return;
    this.roots.set(sessionId, root);
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.set(
      sessionId,
      setTimeout(() => {
        this.timers.delete(sessionId);
        void this.send(sessionId);
      }, delayMs),
    );
  }

  /** Resolves when nothing is waiting or going out (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.timers.size || this.busy.size) {
      await Promise.all(this.busy.values());
      if (this.timers.size) await new Promise((r) => setTimeout(r, 10));
    }
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private async send(sessionId: string): Promise<void> {
    // One read at a time per session; a change during it gets its own turn after.
    await this.busy.get(sessionId);
    const root = this.roots.get(sessionId);
    if (!root || this.gone.has(sessionId) || !this.deps.signedIn()) return;
    const job = this.upload(sessionId, root).finally(() => this.busy.delete(sessionId));
    this.busy.set(sessionId, job);
    await job;
  }

  private async upload(sessionId: string, root: string): Promise<void> {
    let view: { diff: string | null; commit: string | null };
    try {
      view = await this.deps.read(root);
    } catch {
      return; // the checkout went away or isn't a repository any more
    }
    const hash = createHash('sha256')
      .update(`${view.commit ?? ''}\n${view.diff ?? ''}`)
      .digest('hex');
    if (this.sent.get(sessionId) === hash) return;
    try {
      await this.deps.request('PUT', `/api/sessions/${sessionId}/changes`, view);
      this.sent.set(sessionId, hash);
    } catch (error) {
      const status = (error as { status?: number }).status ?? 0;
      if (status === 0 || status >= 500)
        this.changed(sessionId, root, this.deps.retryMs ?? RETRY_MS);
      else if (status !== 401) this.gone.add(sessionId);
    }
  }
}
