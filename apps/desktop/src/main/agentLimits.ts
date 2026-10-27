import { limitNow, type AgentLimit, type LimitAccount } from '../shared/limits.js';
import { readJson, writeJson } from '@kovan/runner';

/**
 * What this machine knows about each account's limit (an agent's, or a model provider's): how full its usage windows are and,
 * once it ran out, when it opens again. Agents report it as they run; nothing is asked of them.
 */
export class AgentLimits {
  private limits: Record<string, AgentLimit> = {};
  private loaded: Promise<void> | null = null;
  private readonly listeners = new Set<(limits: AgentLimit[]) => void>();

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  private load(): Promise<void> {
    this.loaded ??= readJson(this.file).then((raw) => {
      if (!raw || typeof raw !== 'object') return;
      // Files written before limits were per account have no `account` field: the key is it.
      for (const [account, limit] of Object.entries(raw as Record<string, AgentLimit>))
        this.limits[account] = { ...limit, account: account as LimitAccount };
    });
    return this.loaded;
  }

  /** Every known limit as it stands now (a full one whose reset time passed is open again). */
  async list(): Promise<AgentLimit[]> {
    await this.load();
    return Object.values(this.limits).map((l) => limitNow(l, this.now()));
  }

  /** Whether the account has not run out, as far as this machine knows. */
  async open(account: LimitAccount): Promise<boolean> {
    await this.load();
    const limit = this.limits[account];
    return !limit || limitNow(limit, this.now()).status !== 'full';
  }

  /** An agent reported its account's usage windows during a turn. */
  async report(
    account: LimitAccount,
    limit: Pick<AgentLimit, 'status' | 'windows' | 'resetsAt'>,
  ): Promise<void> {
    await this.load();
    const before = this.limits[account];
    // A report with no windows says nothing new; keep what is known.
    if (limit.windows.length === 0 && limit.status === 'ok' && before) return;
    // A report written just before the agent ran out must not reopen it.
    if (
      before?.status === 'full' &&
      limit.status !== 'full' &&
      this.now() - before.updatedAt < 30_000
    )
      return;
    this.limits[account] = {
      account,
      ...limit,
      reason: limit.status === 'full' ? (before?.reason ?? null) : null,
      updatedAt: this.now(),
    };
    await this.changed();
  }

  /** A turn ended because the account ran out. */
  async full(account: LimitAccount, reason: string, resetsAt: number | null): Promise<AgentLimit> {
    await this.load();
    const before = this.limits[account];
    const fullest = [...(before?.windows ?? [])].sort((a, b) => b.used - a.used)[0];
    const known = before?.status === 'full' ? before.resetsAt : (fullest?.resetsAt ?? null);
    const limit: AgentLimit = {
      account,
      status: 'full',
      windows: before?.windows ?? [],
      resetsAt: resetsAt ?? (known && known > this.now() ? known : null),
      reason,
      updatedAt: this.now(),
    };
    this.limits[account] = limit;
    await this.changed();
    return limit;
  }

  onChange(listener: (limits: AgentLimit[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async changed(): Promise<void> {
    await writeJson(this.file, this.limits).catch(() => undefined);
    const limits = await this.list();
    for (const listener of this.listeners) listener(limits);
  }
}
