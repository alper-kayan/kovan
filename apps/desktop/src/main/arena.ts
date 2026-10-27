import { addDetachedWorktree, git, mainCheckout, removeWorktree } from '@kovan/git-engine';
import type { AgentEvent } from '@kovan/harness';
import { classifyByRules } from '@kovan/jevrouter';
import {
  verificationOf,
  type ArenaConfig,
  type ArenaProgress,
  type ArenaRequest,
  type ArenaRun,
  type CheckResult,
  type CostKind,
} from '@kovan/shared';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { DetachedRun } from './agents.js';

export type { ArenaProgress };
import { readJson, writeJson } from '@kovan/runner';
import { detectChecks, linkDependencies, runChecks } from '@kovan/runner';

const CHECK_TIMEOUT_MS = 10 * 60_000;
/** Results kept on disk, newest last. */
const MAX_KEPT = 500;

export interface ArenaDeps {
  /** Where results and the throwaway worktrees live (the app's data folder). */
  dir: string;
  run(run: DetachedRun): Promise<Extract<AgentEvent, { type: 'turn_end' }>>;
  version: string;
  onProgress(progress: ArenaProgress): void;
}

/**
 * Agent Arena: the same task, from the same commit, for several configurations of Kovan's
 * agent, each run in its own throwaway worktree (the person's checkout is never touched),
 * checked with the project's own checks, and measured: passed or not, attempts, time, tokens,
 * cost (and whether that cost was measured). Runs go one after another, so they share the
 * machine on equal terms. Results stay on this machine with the conditions they ran under.
 */
export class ArenaRunner {
  private current: { id: string; abort: AbortController } | null = null;

  constructor(private readonly deps: ArenaDeps) {}

  private get file() {
    return join(this.deps.dir, 'arena-results.json');
  }

  async runs(): Promise<ArenaRun[]> {
    return ((await readJson(this.file)) as ArenaRun[] | undefined) ?? [];
  }

  isRunning(): boolean {
    return this.current !== null;
  }

  stop(): void {
    this.current?.abort.abort();
  }

  /** Starts an arena in the repository at `root`; progress and results arrive as events. */
  async start(root: string, request: ArenaRequest): Promise<{ arenaId: string; commit: string }> {
    if (this.current) throw new Error('An arena is running already; stop it or wait.');
    const main = await mainCheckout(root);
    const commit = (await git(main, ['rev-parse', 'HEAD'])).trim();
    const id = randomUUID();
    const abort = new AbortController();
    this.current = { id, abort };
    void this.all(id, main, commit, request, abort.signal)
      .catch((error: unknown) => console.warn('Arena failed:', error))
      .finally(() => {
        if (this.current?.id === id) this.current = null;
      });
    return { arenaId: id, commit };
  }

  private async all(
    arenaId: string,
    main: string,
    commit: string,
    request: ArenaRequest,
    signal: AbortSignal,
  ): Promise<void> {
    const c = classifyByRules([{ role: 'user', content: request.task }]);
    const plan = request.configs.flatMap((config) =>
      Array.from({ length: request.repeats }, (_, i) => ({ config, repeat: i + 1 })),
    );
    for (const [i, { config, repeat }] of plan.entries()) {
      if (signal.aborted) break;
      const progress = (phase: ArenaProgress['phase'], result?: ArenaRun) =>
        this.deps.onProgress({
          arenaId,
          run: i + 1,
          total: plan.length,
          config,
          repeat,
          phase,
          ...(result ? { result } : {}),
        });
      progress('starting');
      const result = await this.one({
        arenaId,
        main,
        commit,
        request,
        config,
        repeat,
        taskType: c.task,
        difficulty: c.difficulty,
        signal,
        phase: (p) => progress(p),
      });
      const runs = [...(await this.runs()), result].slice(-MAX_KEPT);
      await writeJson(this.file, runs);
      progress('done', result);
    }
  }

  private async one(input: {
    arenaId: string;
    main: string;
    commit: string;
    request: ArenaRequest;
    config: ArenaConfig;
    repeat: number;
    taskType: string;
    difficulty: number;
    signal: AbortSignal;
    phase(phase: 'working' | 'checking'): void;
  }): Promise<ArenaRun> {
    const { request, config } = input;
    const started = Date.now();
    const id = randomUUID();
    const path = join(this.deps.dir, 'arena-worktrees', id.slice(0, 8));
    const usage = { cost: 0, kind: 'measured' as CostKind, prompt: 0, completion: 0 };
    let checks: CheckResult[] = [];
    let attempts = 0;
    let status: ArenaRun['status'] = 'failed';
    let error: string | null = null;
    let diff = { added: 0, removed: 0 };
    // Its own stop: the arena's, or its budget running out.
    const run = new AbortController();
    const stopRun = () => run.abort();
    input.signal.addEventListener('abort', stopRun);
    let overBudget = false;
    try {
      await mkdir(join(this.deps.dir, 'arena-worktrees'), { recursive: true });
      await addDetachedWorktree(input.main, path, input.commit);
      const project = await detectChecks(path);
      const hasNodeModules = project.some((c) => c.needsNodeModules)
        ? await linkDependencies(input.main, path)
        : true;
      let feedback = '';
      while (attempts < request.maxAttempts) {
        attempts += 1;
        input.phase('working');
        const end = await this.deps.run({
          root: path,
          model: config.model,
          effort: config.effort,
          // Edits are free in its own copy; commands would need a person, so none run.
          mode: 'allow',
          task: [
            'You are working alone in a copy of the repository, for a comparison of agents.',
            `Your task: ${request.task}`,
            '',
            'Make the change in the files here; do not commit, push or switch branches.',
            "Your work is checked when you're done: the repository's own tests and checks must pass.",
            "When you're done, reply in one sentence.",
            feedback
              ? `\nYour earlier attempt is in these files, but it didn't pass its checks:\n${feedback}\nFix what failed.`
              : '',
          ].join('\n'),
          approve: async () => false,
          onEvent: (event) => {
            if (event.type !== 'usage') return;
            if (event.usage.cost === null) usage.kind = 'unknown';
            else {
              usage.cost += event.usage.cost;
              if (event.estimated && usage.kind === 'measured') usage.kind = 'estimated';
            }
            usage.prompt += event.usage.promptTokens;
            usage.completion += event.usage.completionTokens;
            if (usage.cost >= request.budgetPerRun) {
              overBudget = true;
              run.abort();
            }
          },
          signal: run.signal,
        });
        diff = await changes(path);
        if (overBudget) {
          status = 'over_budget';
          break;
        }
        if (end.reason === 'stopped' || input.signal.aborted) {
          status = 'stopped';
          break;
        }
        if (end.reason !== 'done') {
          status = 'error';
          error = end.error ?? `The run ended: ${end.reason}`;
          break;
        }
        if (diff.added + diff.removed === 0) {
          status = 'failed';
          error = 'It finished without changing anything';
          break;
        }
        input.phase('checking');
        checks = await runChecks(path, project, {
          hasNodeModules,
          timeoutMs: CHECK_TIMEOUT_MS,
          signal: run.signal,
        });
        if (checks.every((c) => c.status === 'passed')) {
          status = 'passed';
          break;
        }
        status = 'failed';
        // Only failed checks are worth another try; a check that couldn't run won't change.
        if (!checks.some((c) => c.status === 'failed')) break;
        feedback = checks
          .filter((c) => c.status === 'failed')
          .map((c) => `- ${c.name}: ${c.detail ?? 'failed'}`)
          .join('\n');
      }
    } catch (e) {
      status = 'error';
      error = (e as Error).message;
    } finally {
      input.signal.removeEventListener('abort', stopRun);
      await removeWorktree(input.main, path).catch(() => undefined);
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    }
    return {
      id,
      arenaId: input.arenaId,
      at: new Date(started).toISOString(),
      repo: basename(input.main),
      commit: input.commit,
      task: request.task,
      taskType: input.taskType,
      difficulty: input.difficulty,
      config,
      repeat: input.repeat,
      status,
      verification:
        status === 'passed' ? (checks.length ? verificationOf(checks) : 'unverified') : 'none',
      checks,
      attempts,
      durationMs: Date.now() - started,
      cost: usage.cost,
      costKind: usage.kind,
      tokens: { prompt: usage.prompt, completion: usage.completion },
      added: diff.added,
      removed: diff.removed,
      error,
      kovanVersion: this.deps.version,
    };
  }
}

/** Lines the run changed in its worktree, new files included (node_modules never counts). */
async function changes(root: string): Promise<{ added: number; removed: number }> {
  await git(root, ['add', '-A', '--', '.', ':(exclude,glob)**/node_modules']).catch(() => '');
  const out = await git(root, ['diff', '--cached', '--numstat']).catch(() => '');
  let added = 0;
  let removed = 0;
  for (const line of out.split('\n')) {
    const [a, r] = line.split('\t');
    added += Number(a) || 0;
    removed += Number(r) || 0;
  }
  return { added, removed };
}
