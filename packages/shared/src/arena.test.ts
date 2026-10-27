import { describe, expect, it } from 'vitest';
import { arenaSummary, type ArenaRun } from './arena.js';

const run = (
  model: string,
  status: ArenaRun['status'],
  over: Partial<ArenaRun> = {},
): ArenaRun => ({
  id: Math.random().toString(36),
  arenaId: 'a',
  at: '',
  repo: 'repo',
  commit: 'abc1234',
  task: 'Add median()',
  taskType: 'feature',
  difficulty: 2,
  config: { model, effort: null },
  repeat: 1,
  status,
  verification: status === 'passed' ? 'verified' : 'failed',
  checks: [],
  attempts: 1,
  durationMs: 1000,
  cost: 0.01,
  costKind: 'measured',
  tokens: { prompt: 1, completion: 1 },
  added: 1,
  removed: 0,
  error: null,
  kovanVersion: '0.1.0',
  ...over,
});

describe('arenaSummary', () => {
  it('names no winner before every configuration ran enough times', () => {
    const { rows, verdict } = arenaSummary([run('a', 'passed'), run('b', 'failed')]);
    expect(rows.map((r) => [r.config.model, r.passed, r.runs])).toEqual([
      ['a', 1, 1],
      ['b', 0, 1],
    ]);
    expect(verdict).toContain('Not enough runs to name a best configuration');
  });

  it('names the most reliable configuration, only for this task', () => {
    const runs = [
      ...['passed', 'passed', 'passed'].map((s) => run('a', s as ArenaRun['status'])),
      ...['passed', 'failed', 'failed'].map((s) => run('b', s as ArenaRun['status'])),
    ];
    const { rows, verdict } = arenaSummary(runs);
    expect(rows[0]).toMatchObject({ runs: 3, passed: 3, verified: 3 });
    expect(verdict).toBe(
      'a passed most often (3/3). Only this task, in this repository, at this commit.',
    );
  });

  it('calls a tie a tie unless both costs were measured', () => {
    const tie = (kind: ArenaRun['costKind']) => [
      ...[1, 2, 3].map(() => run('a', 'passed', { cost: 0.02 })),
      ...[1, 2, 3].map(() => run('b', 'passed', { cost: 0.01, costKind: kind })),
    ];
    expect(arenaSummary(tie('estimated')).verdict).toContain(
      'No clear winner: b and a passed equally often, and not every cost was measured',
    );
    expect(arenaSummary(tie('measured')).verdict).toContain('b cost less per run (measured)');
  });

  it('says so when nothing passed', () => {
    const runs = [1, 2, 3].flatMap(() => [run('a', 'failed'), run('b', 'error')]);
    expect(arenaSummary(runs).verdict).toBe(
      'No configuration finished the task with its checks passing.',
    );
  });
});
