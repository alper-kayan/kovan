import { git, listWorktrees } from '@kovan/git-engine';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DetachedRun } from './agents.js';
import { ArenaRunner, type ArenaProgress } from './arena.js';

let dir: string;
let repo: string;
const sh = (cwd: string, ...args: string[]) => git(cwd, args);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kovan-arena-'));
  repo = join(dir, 'repo');
  await sh(dir, 'init', '-q', '-b', 'main', repo);
  await sh(repo, 'config', 'user.email', 't@kovan.test');
  await sh(repo, 'config', 'user.name', 'T');
  await writeFile(
    join(repo, 'package.json'),
    JSON.stringify({
      scripts: { test: 'node -e "process.exit(require(\'./median.js\').ok ? 0 : 1)"' },
    }),
  );
  await sh(repo, 'add', '.');
  await sh(repo, 'commit', '-q', '-m', 'init');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

/** Stands in for the model: "good" gets it right, "bad" never does, "pricey" overspends. */
function fakeRun(seen: string[]) {
  return async (run: DetachedRun) => {
    seen.push(`${run.model}:${run.root}`);
    run.onEvent({ type: 'turn_start', turnId: 't', model: run.model });
    const cost = run.model === 'pricey' ? 1 : run.model === 'unpriced' ? null : 0.01;
    run.onEvent({
      type: 'usage',
      usage: { promptTokens: 100, completionTokens: 20, cachedTokens: 0, reasoningTokens: 0, cost },
      model: run.model,
      kind: 'model',
      estimated: false,
    });
    if (run.signal.aborted)
      return { type: 'turn_end' as const, turnId: 't', reason: 'stopped' as const, cost: 0 };
    await writeFile(
      join(run.root, 'median.js'),
      `exports.ok = ${run.model === 'bad' ? 'false' : 'true'};\n`,
    );
    return { type: 'turn_end' as const, turnId: 't', reason: 'done' as const, cost: 0 };
  };
}

async function arena(models: string[], repeats = 1) {
  const progress: ArenaProgress[] = [];
  const seen: string[] = [];
  const runner = new ArenaRunner({
    dir: join(dir, 'data'),
    run: fakeRun(seen),
    version: '0.1.0',
    onProgress: (p) => progress.push(p),
  });
  await mkdir(join(dir, 'data'), { recursive: true });
  const { commit } = await runner.start(repo, {
    task: 'Add median() with its test',
    configs: models.map((model) => ({ model, effort: null })),
    repeats,
    maxAttempts: 2,
    budgetPerRun: 0.5,
  });
  const total = models.length * repeats;
  const start = Date.now();
  while (progress.filter((p) => p.phase === 'done').length < total) {
    if (Date.now() - start > 20_000) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
  return { runner, progress, seen, commit, runs: await runner.runs() };
}

describe('ArenaRunner', () => {
  it('runs each configuration on the same commit, apart from your checkout, and measures it', async () => {
    const { runs, seen, commit } = await arena(['good', 'bad']);
    expect(runs.map((r) => [r.config.model, r.status, r.attempts, r.verification])).toEqual([
      ['good', 'passed', 1, 'verified'],
      ['bad', 'failed', 2, 'none'],
    ]);
    const good = runs[0]!;
    expect(good).toMatchObject({
      repo: 'repo',
      commit,
      taskType: 'feature',
      cost: 0.01,
      costKind: 'measured',
      tokens: { prompt: 100, completion: 20 },
      added: 1,
      kovanVersion: '0.1.0',
    });
    expect(good.checks.map((c) => [c.name, c.status])).toEqual([['npm run test', 'passed']]);
    // The failing one got its failed check back once, in the same copy.
    expect(runs[1]!.checks[0]!.status).toBe('failed');
    // Each run had its own worktree, all gone now; the person's checkout never changed.
    expect(new Set(seen.map((s) => s.split(':')[1])).size).toBe(2);
    expect(seen.every((s) => !s.endsWith(`:${repo}`))).toBe(true);
    expect(await listWorktrees(repo)).toHaveLength(1);
    await expect(readFile(join(repo, 'median.js'), 'utf8')).rejects.toThrow();
    expect(await readdir(join(dir, 'data', 'arena-worktrees'))).toEqual([]);
  });

  it('stops a run at its budget, and says when a cost is unknown', async () => {
    const { runs } = await arena(['pricey', 'unpriced']);
    expect(runs.map((r) => [r.config.model, r.status, r.costKind])).toEqual([
      ['pricey', 'over_budget', 'measured'],
      ['unpriced', 'passed', 'unknown'],
    ]);
  });

  it('keeps every result, with the repeats numbered', async () => {
    const { runs } = await arena(['good'], 2);
    expect(runs.map((r) => r.repeat)).toEqual([1, 2]);
    expect(new Set(runs.map((r) => r.arenaId)).size).toBe(1);
  });
});
