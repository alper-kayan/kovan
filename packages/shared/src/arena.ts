import { z } from 'zod';
import { EffortSchema } from './swarm.js';
import type { CheckResult, Verification } from './tasks.js';

// ---------- Phase 15: Agent Arena ----------

/** One configuration to compare: Kovan's agent on a model (and effort). */
export const ArenaConfigSchema = z.object({
  model: z.string().trim().min(1).max(200),
  effort: EffortSchema.nullable().default(null),
});
export type ArenaConfig = z.infer<typeof ArenaConfigSchema>;

/** The same task, in the same commit, for each configuration (and each repeat). */
export const ArenaRequestSchema = z.object({
  task: z.string().trim().min(1).max(4000),
  configs: z.array(ArenaConfigSchema).min(1).max(4),
  repeats: z.number().int().min(1).max(5).default(1),
  /** Runs of the agent per try, reworks after failed checks included. */
  maxAttempts: z.number().int().min(1).max(3).default(2),
  /** Past this (USD, provider cost), a run is stopped. */
  budgetPerRun: z.number().min(0.01).max(20).default(0.5),
});
export type ArenaRequest = z.infer<typeof ArenaRequestSchema>;

/**
 * Whether a cost was reported by the provider (measured), worked out from catalog prices
 * (estimated), or partly unknown (a model with no price): never shown as more certain than it is.
 */
export type CostKind = 'measured' | 'estimated' | 'unknown';

/** One run of one configuration, and the conditions it ran under. */
export interface ArenaRun {
  id: string;
  arenaId: string;
  at: string;
  /** The repository folder's name and the commit every run of this arena started from. */
  repo: string;
  commit: string;
  task: string;
  /** From JevRouter's rules, so results can be compared by kind of work. */
  taskType: string;
  difficulty: number;
  config: ArenaConfig;
  /** Which repeat of this configuration (1-based). */
  repeat: number;
  status: 'passed' | 'failed' | 'error' | 'stopped' | 'over_budget';
  verification: Verification | 'none';
  checks: CheckResult[];
  attempts: number;
  durationMs: number;
  cost: number;
  costKind: CostKind;
  tokens: { prompt: number; completion: number };
  added: number;
  removed: number;
  error: string | null;
  kovanVersion: string;
}

/** How an arena is getting on, run by run. */
export interface ArenaProgress {
  arenaId: string;
  /** 1-based run of `total`. */
  run: number;
  total: number;
  config: ArenaConfig;
  repeat: number;
  phase: 'starting' | 'working' | 'checking' | 'done';
  result?: ArenaRun;
}

export interface ArenaRow {
  config: ArenaConfig;
  runs: number;
  passed: number;
  /** Of the passed runs, those the project's own checks verified. */
  verified: number;
  avgCost: number;
  costKind: CostKind;
  avgDurationMs: number;
  avgAttempts: number;
}

/** The fewest runs per configuration before the arena names one as the most reliable. */
export const ARENA_MIN_RUNS = 3;

const costRank: Record<CostKind, number> = { measured: 0, estimated: 1, unknown: 2 };

/**
 * Sums up runs of one task per configuration, and says what can honestly be said: with fewer
 * than ARENA_MIN_RUNS runs each, or a tie, it names no winner; a cheaper config wins a tie only
 * when both costs were measured.
 */
export function arenaSummary(runs: readonly ArenaRun[]): { rows: ArenaRow[]; verdict: string } {
  const byConfig = new Map<string, ArenaRun[]>();
  for (const r of runs) {
    const key = `${r.config.model}|${r.config.effort ?? ''}`;
    byConfig.set(key, [...(byConfig.get(key) ?? []), r]);
  }
  const rows: ArenaRow[] = [...byConfig.values()].map((list) => {
    const n = list.length;
    const avg = (f: (r: ArenaRun) => number) => list.reduce((s, r) => s + f(r), 0) / n;
    return {
      config: list[0]!.config,
      runs: n,
      passed: list.filter((r) => r.status === 'passed').length,
      verified: list.filter((r) => r.status === 'passed' && r.verification === 'verified').length,
      avgCost: avg((r) => r.cost),
      costKind: list.reduce<CostKind>(
        (worst, r) => (costRank[r.costKind] > costRank[worst] ? r.costKind : worst),
        'measured',
      ),
      avgDurationMs: avg((r) => r.durationMs),
      avgAttempts: avg((r) => r.attempts),
    };
  });
  rows.sort((a, b) => b.passed / b.runs - a.passed / a.runs || a.avgCost - b.avgCost);
  const name = (r: ArenaRow) =>
    `${r.config.model}${r.config.effort ? ` (${r.config.effort})` : ''}`;
  if (rows.length < 2) return { rows, verdict: 'Only one configuration ran: nothing to compare.' };
  const few = rows.filter((r) => r.runs < ARENA_MIN_RUNS);
  if (few.length)
    return {
      rows,
      verdict: `Not enough runs to name a best configuration: run each at least ${ARENA_MIN_RUNS} times (${few.map(name).join(', ')} ran fewer).`,
    };
  const [best, second] = rows as [ArenaRow, ArenaRow];
  const rate = (r: ArenaRow) => r.passed / r.runs;
  if (best.passed === 0)
    return { rows, verdict: 'No configuration finished the task with its checks passing.' };
  if (rate(best) === rate(second)) {
    const bothMeasured = best.costKind === 'measured' && second.costKind === 'measured';
    if (!bothMeasured || best.avgCost === second.avgCost)
      return {
        rows,
        verdict: `No clear winner: ${name(best)} and ${name(second)} passed equally often${bothMeasured ? '' : ', and not every cost was measured'}.`,
      };
    return {
      rows,
      verdict: `${name(best)} and ${name(second)} passed equally often; ${name(best)} cost less per run (measured). Only this task, in this repository.`,
    };
  }
  return {
    rows,
    verdict: `${name(best)} passed most often (${best.passed}/${best.runs}). Only this task, in this repository, at this commit.`,
  };
}
