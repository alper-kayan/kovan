import { readRequiredChecks, runShell } from '@kovan/harness';
import type { CheckResult } from '@kovan/shared';
import { execFile } from 'node:child_process';
import { access, lstat, readFile, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** A check the project itself defines: a command, and where it came from. */
export interface ProjectCheck {
  name: string;
  command: string;
  /** "KOVAN.md", "package.json", "Cargo.toml" or "go.mod". */
  source: string;
  /** Needs the JavaScript dependencies installed (node_modules). */
  needsNodeModules: boolean;
}

/** package.json scripts worth running to verify a change, cheapest first. */
const SCRIPTS = ['typecheck', 'lint', 'test', 'build'] as const;
/** What `npm init` writes as the test script: not a test. */
const PLACEHOLDER_TEST = /no test specified/i;

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

async function packageRunner(root: string): Promise<string> {
  if (await exists(join(root, 'pnpm-lock.yaml'))) return 'pnpm run';
  if (await exists(join(root, 'yarn.lock'))) return 'yarn run';
  if ((await exists(join(root, 'bun.lock'))) || (await exists(join(root, 'bun.lockb'))))
    return 'bun run';
  return 'npm run';
}

/**
 * The checks a change in this repository should pass. The team's "Required Checks" in KOVAN.md
 * win; without them, the project's own scripts (package.json typecheck, lint, test, build), or
 * `cargo test` / `go test ./...`. Nothing is made up: a project with none of these has no checks.
 */
export async function detectChecks(root: string): Promise<ProjectCheck[]> {
  const required = await readRequiredChecks(root);
  if (required.length)
    return required.map((command) => ({
      name: command.split('\n')[0]!.slice(0, 120),
      command,
      source: 'KOVAN.md',
      needsNodeModules: false,
    }));

  const checks: ProjectCheck[] = [];
  const pkg = await readFile(join(root, 'package.json'), 'utf8')
    .then(
      (text) =>
        JSON.parse(text) as {
          scripts?: Record<string, unknown>;
          dependencies?: Record<string, unknown>;
          devDependencies?: Record<string, unknown>;
        },
    )
    .catch(() => null);
  if (pkg?.scripts) {
    const runner = await packageRunner(root);
    // A package with no dependencies runs without node_modules.
    const hasDependencies =
      Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length >
      0;
    for (const script of SCRIPTS) {
      const body = pkg.scripts[script];
      if (typeof body !== 'string' || !body.trim()) continue;
      if (script === 'test' && PLACEHOLDER_TEST.test(body)) continue;
      checks.push({
        name: `${runner} ${script}`,
        command: `${runner} ${script}`,
        source: 'package.json',
        needsNodeModules: hasDependencies,
      });
    }
  }
  if (await exists(join(root, 'Cargo.toml')))
    checks.push({
      name: 'cargo test',
      command: 'cargo test',
      source: 'Cargo.toml',
      needsNodeModules: false,
    });
  if (await exists(join(root, 'go.mod')))
    checks.push({
      name: 'go test ./...',
      command: 'go test ./...',
      source: 'go.mod',
      needsNodeModules: false,
    });
  return checks;
}

/**
 * A fresh worktree has no installed dependencies. Links each package's node_modules from the
 * main checkout, where the person installed them. Returns whether the root has them now.
 */
export async function linkDependencies(mainRoot: string, root: string): Promise<boolean> {
  const { stdout } = await run('git', ['ls-files', '--', 'package.json', '**/package.json'], {
    cwd: root,
    maxBuffer: 4 * 1024 * 1024,
  }).catch(() => ({ stdout: '' }));
  const dirs = stdout
    .split('\n')
    .filter(Boolean)
    .slice(0, 200)
    .map((file) => dirname(file));
  for (const dir of dirs) {
    const from = join(mainRoot, dir, 'node_modules');
    const to = join(root, dir, 'node_modules');
    if (!(await exists(from))) continue;
    if (
      await lstat(to).then(
        () => true,
        () => false,
      )
    )
      continue;
    await symlink(from, to, 'dir').catch(() => undefined);
  }
  return exists(join(root, 'node_modules'));
}

function tail(output: string): string {
  return output.trim().split('\n').slice(-6).join('\n').slice(-1500);
}

/**
 * Runs the checks in order. After a failure the rest are `not_run`; a check that can't run here
 * (its tool isn't installed, dependencies are missing, the run was stopped) is `blocked`.
 */
export async function runChecks(
  root: string,
  checks: readonly ProjectCheck[],
  options: {
    hasNodeModules: boolean;
    timeoutMs: number;
    signal?: AbortSignal;
    /** A check is about to run; `done` holds the results so far. */
    onStart?(check: ProjectCheck, done: CheckResult[]): void | Promise<void>;
    onResult?(results: CheckResult[]): void | Promise<void>;
  },
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  let failed = false;
  for (const check of checks) {
    const base = { name: check.name, command: check.command };
    if (failed) {
      results.push({ ...base, status: 'not_run', detail: 'An earlier check failed', ms: null });
      continue;
    }
    if (options.signal?.aborted) {
      results.push({ ...base, status: 'blocked', detail: 'Stopped before it ran', ms: null });
      continue;
    }
    if (check.needsNodeModules && !options.hasNodeModules) {
      results.push({
        ...base,
        status: 'blocked',
        detail: "Dependencies aren't installed: there is no node_modules in the main checkout",
        ms: null,
      });
      failed = true;
      continue;
    }
    await options.onStart?.(check, results);
    const started = Date.now();
    const result = await runShell(check.command, root, {
      timeoutMs: options.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const ms = Date.now() - started;
    if (result.exitCode === 0) {
      results.push({ ...base, status: 'passed', detail: null, ms });
    } else if (result.aborted) {
      results.push({ ...base, status: 'blocked', detail: 'Stopped while it ran', ms });
      failed = true;
    } else if (result.exitCode === 127) {
      results.push({
        ...base,
        status: 'blocked',
        detail: `Its command isn't installed here: ${tail(result.output)}`,
        ms,
      });
      failed = true;
    } else {
      results.push({
        ...base,
        status: 'failed',
        detail: `${result.timedOut ? 'Timed out. ' : ''}${tail(result.output)}`,
        ms,
      });
      failed = true;
    }
    await options.onResult?.(results);
  }
  return results;
}
