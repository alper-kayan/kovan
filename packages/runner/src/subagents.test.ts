import { git, listWorktrees } from '@kovan/git-engine';
import type { Subagent } from '@kovan/shared';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DetachedRun } from './run.js';
import { Bindings } from './bindings.js';
import { SessionCheckouts } from './sessionCheckouts.js';
import { SubagentRunner, untestedFiles, type SubagentOutcome } from './subagents.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
let dir: string;
let repo: string;
const sh = (cwd: string, ...args: string[]) => git(cwd, args);

/** A Brain that keeps subagents and hands out the integration claim once. */
function fakeBrain() {
  const subs = new Map<string, Subagent>();
  const keys = new Map<string, string>();
  const patches: Record<string, unknown>[] = [];
  let claims = 0;
  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    if (method === 'POST' && path.endsWith('/subagents')) {
      const key = (body as { requestKey?: string }).requestKey;
      const earlier = key ? [...subs.values()].find((x) => keys.get(x.id) === key) : undefined;
      if (earlier) return { subagent: earlier, existing: true } as T;
      const sub = {
        id: `aaaaaaaa-0000-4000-8000-00000000000${subs.size}`,
        sessionId: SESSION,
        parentUserId: 'me',
        parentName: 'Alice',
        task: (body as { task: string }).task,
        status: 'running',
        added: 0,
        removed: 0,
        checksPassed: 0,
        checksTotal: 0,
        rev: 0,
        baseSha: (body as { baseSha: string }).baseSha,
        detail: null,
        createdAt: '',
        updatedAt: '',
        integratedAt: null,
      } as Subagent;
      subs.set(sub.id, sub);
      if (key) keys.set(sub.id, key);
      return { subagent: sub, existing: false } as T;
    }
    const id = path.split('/')[3]!;
    const sub = subs.get(id)!;
    if (method === 'PATCH') {
      patches.push(body as Record<string, unknown>);
      Object.assign(sub, body);
      return { subagent: sub } as T;
    }
    if (path.endsWith('/integrate')) {
      if (sub.status !== 'passed') throw new Error('409 not passed');
      claims += 1;
      sub.status = 'integrated';
      return { subagent: sub } as T;
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { subs, patches, request, claims: () => claims };
}

/** Stands in for the model: does the task's edit in its own worktree. */
function fakeAgent(edit: (root: string) => Promise<void>) {
  return async (run: DetachedRun) => {
    run.onEvent({ type: 'turn_start', turnId: 't', model: 'test' });
    run.onEvent({
      type: 'tool_start',
      id: 'c1',
      name: 'write_file',
      summary: 'Write src/total.ts',
      args: { path: 'src/total.ts' },
    });
    await edit(run.root);
    run.onEvent({ type: 'tool_end', id: 'c1', ok: true, output: 'ok' });
    return { type: 'turn_end' as const, turnId: 't', reason: 'done' as const, cost: 0 };
  };
}

async function runner(edit: (root: string) => Promise<void>) {
  const brain = fakeBrain();
  const checkouts = new SessionCheckouts(
    new Bindings(join(dir, 'data')),
    join(dir, 'data'),
    async () => undefined,
    async () => false,
  );
  const r = new SubagentRunner({ request: brain.request, checkouts, run: fakeAgent(edit) });
  return { r, brain };
}

async function until(fn: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const start = (r: SubagentRunner) =>
  r.start({
    sessionId: SESSION,
    parentRoot: repo,
    task: 'Add a total helper',
    model: 'test',
    effort: null,
    parentMode: 'request',
  });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kovan-subagents-'));
  repo = join(dir, 'repo');
  await sh(dir, 'init', '-q', '-b', 'main', repo);
  await sh(repo, 'config', 'user.email', 't@kovan.test');
  await sh(repo, 'config', 'user.name', 'T');
  await writeFile(join(repo, 'seats.ts'), 'export const seats = 10;\n');
  await writeFile(
    join(repo, 'KOVAN.md'),
    '## Required Checks\n- `test -f src/total.ts`\n- `grep -q total src/total.ts`\n',
  );
  await sh(repo, 'add', '.');
  await sh(repo, 'commit', '-q', '-m', 'init');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('subagents', () => {
  it('works in its own worktree, passes its checks and joins the parent once', async () => {
    const { r, brain } = await runner(async (root) => {
      await sh(root, 'status'); // its own checkout
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(
        join(root, 'src/total.ts'),
        'export const total = (a: number[]) => a.length;\n',
      );
    });
    // The parent has unsaved work of its own; the child starts from it and leaves it alone.
    await writeFile(join(repo, 'seats.ts'), 'export const seats = 12;\n');
    const sub = await start(r);
    expect(await listWorktrees(repo)).toHaveLength(2);

    // Claimed, applied, and its worktree cleaned up.
    await until(() => brain.subs.get(sub.id)!.status === 'integrated' && r.pathOf(sub.id) === null);
    const done = brain.subs.get(sub.id)!;
    expect(done).toMatchObject({ checksPassed: 4, checksTotal: 4, rev: 1, added: 1, removed: 0 });
    expect(await readFile(join(repo, 'src/total.ts'), 'utf8')).toContain('total');
    expect(await readFile(join(repo, 'seats.ts'), 'utf8')).toBe('export const seats = 12;\n');
    expect(brain.claims()).toBe(1);
    // A second integration (a retry, another window) does nothing.
    expect(await r.integrate(sub.id)).toBeNull();
    expect(brain.claims()).toBe(1);
    expect(await listWorktrees(repo)).toHaveLength(1);
  });

  it('called in with @, it asks before acting and can finish with an answer alone', async () => {
    const brain = fakeBrain();
    const checkouts = new SessionCheckouts(
      new Bindings(join(dir, 'data')),
      join(dir, 'data'),
      async () => undefined,
      async () => false,
    );
    const asked: string[] = [];
    let mode: string | null = null;
    let allowed: boolean | null = null;
    const r = new SubagentRunner({
      request: brain.request,
      checkouts,
      run: async (run) => {
        mode = run.mode;
        allowed = await run.approve({
          id: 'r1',
          tool: 'run_shell',
          kind: 'command',
          title: 'Run this?',
          detail: 'pnpm test',
        });
        run.onEvent({ type: 'text', text: 'total() ignores negative numbers.' });
        return { type: 'turn_end' as const, turnId: 't', reason: 'done' as const, cost: 0 };
      },
    });
    let outcome: SubagentOutcome | null = null;
    const sub = await r.start({
      sessionId: SESSION,
      parentRoot: repo,
      task: 'Bob: Is total() right?',
      model: 'test',
      effort: null,
      parentMode: 'full',
      askFirst: async (request) => {
        asked.push(request.detail);
        return false;
      },
      onSettled: (o) => (outcome = o),
    });
    await until(() => outcome !== null && r.pathOf(sub.id) === null);
    expect(mode).toBe('request');
    expect(asked).toEqual(['pnpm test']);
    expect(allowed).toBe(false);
    expect(outcome).toMatchObject({
      status: 'answered',
      reply: 'total() ignores negative numbers.',
    });
    expect(brain.subs.get(sub.id)!.status).toBe('answered');
    expect(await listWorktrees(repo)).toHaveLength(1);
  });

  it("leaves the parent untouched when a check fails, and keeps the child's work to review", async () => {
    const { r, brain } = await runner(async (root) => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'src/total.ts'), 'export const sum = 1;\n');
    });
    const sub = await start(r);
    await until(() => brain.subs.get(sub.id)!.status === 'failed');
    expect(brain.subs.get(sub.id)!.detail).toMatch(/grep -q total src\/total.ts failed/);
    // Every check says what happened to it.
    expect(brain.subs.get(sub.id)!.checks.map((c) => [c.name, c.status])).toEqual([
      ['Applies to the parent', 'passed'],
      ['No conflict markers or whitespace errors', 'passed'],
      ['test -f src/total.ts', 'passed'],
      ['grep -q total src/total.ts', 'failed'],
    ]);
    await expect(readFile(join(repo, 'src/total.ts'), 'utf8')).rejects.toThrow();
    const path = r.pathOf(sub.id)!;
    expect(await readFile(join(path, 'src/total.ts'), 'utf8')).toBe('export const sum = 1;\n');
    await r.discard(sub.id);
    expect(brain.subs.get(sub.id)!.status).toBe('cancelled');
    expect(await listWorktrees(repo)).toHaveLength(1);
  });

  it("runs the task's proof after the project's checks, and fails the task when it fails", async () => {
    const { r, brain } = await runner(async (root) => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'src/total.ts'), 'export const total = 1;\n');
    });
    const sub = await r.start({
      sessionId: SESSION,
      parentRoot: repo,
      task: 'Add a total helper with an average',
      model: 'test',
      effort: null,
      parentMode: 'request',
      acceptanceCheck: 'grep -q average src/total.ts',
    });
    await until(() => brain.subs.get(sub.id)!.status === 'failed');
    expect(brain.subs.get(sub.id)!.checks.map((c) => [c.name, c.status])).toEqual([
      ['Applies to the parent', 'passed'],
      ['No conflict markers or whitespace errors', 'passed'],
      ['test -f src/total.ts', 'passed'],
      ['grep -q total src/total.ts', 'passed'],
      ['Done means: grep -q average src/total.ts', 'failed'],
    ]);
    expect(brain.subs.get(sub.id)!.detail).toMatch(
      /^Done means: grep -q average src\/total.ts failed/,
    );
    await r.discard(sub.id);
  });

  it('never runs a proof an unattended agent may not run', async () => {
    const { r, brain } = await runner(async (root) => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'src/total.ts'), 'export const total = 1;\n');
    });
    const sub = await r.start({
      sessionId: SESSION,
      parentRoot: repo,
      task: 'Add a total helper',
      model: 'test',
      effort: null,
      parentMode: 'request',
      acceptanceCheck: 'rm -rf src',
    });
    await until(() => brain.subs.get(sub.id)!.status === 'integrated' && r.pathOf(sub.id) === null);
    expect(brain.subs.get(sub.id)!.checks.map((c) => c.name)).not.toContain(
      'Done means: rm -rf src',
    );
    expect(await readFile(join(repo, 'src/total.ts'), 'utf8')).toContain('total');
  });

  it('marks a conflict when the parent changed the same lines meanwhile', async () => {
    const { r, brain } = await runner(async (root) => {
      await writeFile(join(root, 'seats.ts'), 'export const seats = 30;\n');
      // The parent edits the same line while the child works.
      await writeFile(join(repo, 'seats.ts'), 'export const seats = 20;\n');
    });
    const sub = await start(r);
    await until(() => brain.subs.get(sub.id)!.status === 'conflict');
    expect(brain.subs.get(sub.id)!.detail).toMatch(/seats.ts/);
    expect(await readFile(join(repo, 'seats.ts'), 'utf8')).toBe('export const seats = 20;\n');
    expect(r.pathOf(sub.id)).not.toBeNull();
  });

  it('reworks failed work in the same copy, then checks it again', async () => {
    let attempt = 0;
    const { r, brain } = await runner(async (root) => {
      attempt += 1;
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(
        join(root, 'src/total.ts'),
        attempt === 1 ? 'export const sum = 1;\n' : 'export const total = 1;\n',
      );
    });
    const sub = await start(r);
    await until(() => brain.subs.get(sub.id)!.status === 'failed');
    const outcome = await r.rework(sub.id, '- grep -q total src/total.ts: no match');
    expect(outcome).toMatchObject({ status: 'integrated', verification: 'verified' });
    expect(outcome.results.every((c) => c.status === 'passed')).toBe(true);
    expect(await readFile(join(repo, 'src/total.ts'), 'utf8')).toBe('export const total = 1;\n');
    // It went failed → running → checking → passed, never skipping a step.
    const statuses = brain.patches.flatMap((p) => (p['status'] ? [p['status']] : []));
    expect(statuses).toEqual(['checking', 'failed', 'running', 'checking', 'passed']);
  });

  it("runs the project's own tests with the main checkout's dependencies, and never moves them", async () => {
    await rm(join(repo, 'KOVAN.md'));
    await writeFile(join(repo, '.gitignore'), 'node_modules/\n');
    await writeFile(
      join(repo, 'package.json'),
      JSON.stringify({
        dependencies: { dep: '1.0.0' },
        scripts: {
          test: "node -e \"process.exit(require('dep').ok && require('./src/total.js').total ? 0 : 1)\"",
        },
      }),
    );
    await sh(repo, 'add', '.');
    await sh(repo, 'commit', '-q', '-m', 'package');
    await mkdir(join(repo, 'node_modules/dep'), { recursive: true });
    await writeFile(join(repo, 'node_modules/dep/index.js'), 'exports.ok = true;\n');

    const { r, brain } = await runner(async (root) => {
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'src/total.js'), 'exports.total = 1;\n');
    });
    const sub = await start(r);
    await until(() => brain.subs.get(sub.id)!.status === 'integrated');
    expect(brain.subs.get(sub.id)!.checks.map((c) => [c.name, c.status])).toEqual([
      ['Applies to the parent', 'passed'],
      ['No conflict markers or whitespace errors', 'passed'],
      ['npm run test', 'passed'],
    ]);
    // The worktree's link to the dependencies didn't come back into the parent.
    expect((await lstat(join(repo, 'node_modules'))).isDirectory()).toBe(true);
    expect(await sh(repo, 'ls-files', 'node_modules')).toBe('');
  });

  it('starts one subagent for a repeated request key', async () => {
    const { r, brain } = await runner(async (root) => {
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'src/total.ts'), 'export const total = 1;\n');
    });
    const input = {
      sessionId: SESSION,
      parentRoot: repo,
      task: 'Add a total helper',
      model: 'test',
      effort: null,
      parentMode: 'request' as const,
      requestKey: 'swarm-1:abcd:step-0:0',
    };
    const [a, b] = await Promise.all([r.start(input), r.start(input)]);
    expect(a.id).toBe(b.id);
    expect(brain.subs.size).toBe(1);
    await until(() => brain.subs.get(a.id)!.status === 'integrated');
    // Once it has worked, the same key can't start it over.
    await expect(r.start(input)).rejects.toThrow('was started already');
    expect(await listWorktrees(repo)).toHaveLength(1);
  });

  it('joins only after an independent review approves, and says what tests miss', async () => {
    const { r, brain } = await runner(async (root) => {
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'src/total.ts'), 'export const total = 1;\n');
    });
    const seen: string[] = [];
    let outcome: SubagentOutcome | null = null;
    const sub = await r.start({
      sessionId: SESSION,
      parentRoot: repo,
      task: 'Add a total helper',
      model: 'test',
      effort: null,
      parentMode: 'request',
      review: async ({ diff, root }) => {
        seen.push(diff);
        expect(await readFile(join(root, 'src/total.ts'), 'utf8')).toContain('total');
        return {
          approved: seen.length > 1,
          by: 'Wren',
          detail: seen.length > 1 ? null : 'No test for total',
        };
      },
      persona: { agentId: 'a', name: 'Moss', prompt: 'Add total', onSettled: (o) => (outcome = o) },
    });
    await until(() => brain.subs.get(sub.id)!.status === 'failed');
    expect(seen[0]).toContain('+export const total = 1;');
    expect(brain.subs.get(sub.id)!.checks.at(-1)).toMatchObject({
      name: 'Review by Wren',
      status: 'failed',
      detail: 'No test for total',
    });
    // Nothing joined the parent before the review said yes.
    await expect(readFile(join(repo, 'src/total.ts'), 'utf8')).rejects.toThrow();
    const again = await r.rework(sub.id, '- Review by Wren: No test for total');
    expect(again).toMatchObject({ status: 'integrated', verification: 'verified' });
    expect(again.results.at(-1)).toMatchObject({ name: 'Review by Wren', status: 'passed' });
    // KOVAN.md's checks grep for it, but no test file names total.ts.
    expect(again.untested).toEqual(['src/total.ts']);
    // What it can reach was mapped once its checks passed (nothing imports it yet).
    expect(again.impact).toMatchObject({ changed: ['src/total.ts'], links: [] });
    expect(outcome).not.toBeNull();
  });
});

describe('untestedFiles', () => {
  it('finds changed source files no test mentions, new tests included', async () => {
    const base = (await sh(repo, 'rev-parse', 'HEAD')).trim();
    await mkdir(join(repo, 'src'), { recursive: true });
    await mkdir(join(repo, 'test'), { recursive: true });
    await writeFile(join(repo, 'src/median.ts'), 'export const median = 1;\n');
    await writeFile(join(repo, 'src/mode.ts'), 'export const mode = 1;\n');
    await writeFile(join(repo, 'test/median.test.ts'), "import { median } from '../src/median';\n");
    await writeFile(join(repo, 'README.md'), '# docs\n');
    const { snapshotCommit } = await import('@kovan/git-engine');
    const { sha } = await snapshotCommit(repo, 'work');
    expect(await untestedFiles(repo, base, sha)).toEqual(['src/mode.ts']);
  });
});
