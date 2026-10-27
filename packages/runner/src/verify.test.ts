import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectChecks, runChecks, type ProjectCheck } from './verify.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kovan-verify-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const pkg = (scripts: Record<string, string>) =>
  writeFile(join(dir, 'package.json'), JSON.stringify({ scripts }));

describe('detectChecks', () => {
  it("uses the project's own scripts, cheapest first, with its package manager", async () => {
    await pkg({ build: 'tsc', test: 'vitest run', dev: 'vite', lint: 'eslint .' });
    await writeFile(join(dir, 'pnpm-lock.yaml'), '');
    expect((await detectChecks(dir)).map((c) => c.command)).toEqual([
      'pnpm run lint',
      'pnpm run test',
      'pnpm run build',
    ]);
  });

  it('needs installed dependencies only when the package has some', async () => {
    await pkg({ test: 'node --test' });
    expect((await detectChecks(dir))[0]).toMatchObject({
      command: 'npm run test',
      needsNodeModules: false,
    });
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run' }, devDependencies: { vitest: '5' } }),
    );
    expect((await detectChecks(dir))[0]!.needsNodeModules).toBe(true);
  });

  it('skips the placeholder test script npm init writes', async () => {
    await pkg({ test: 'echo "Error: no test specified" && exit 1' });
    expect(await detectChecks(dir)).toEqual([]);
  });

  it('lets KOVAN.md decide when it lists Required Checks', async () => {
    await pkg({ test: 'vitest run' });
    await writeFile(join(dir, 'KOVAN.md'), '## Required Checks\n- `make check`\n');
    expect(await detectChecks(dir)).toEqual([
      { name: 'make check', command: 'make check', source: 'KOVAN.md', needsNodeModules: false },
    ]);
  });

  it('knows Cargo and Go projects, and finds nothing in an empty one', async () => {
    expect(await detectChecks(dir)).toEqual([]);
    await writeFile(join(dir, 'Cargo.toml'), '[package]\n');
    await writeFile(join(dir, 'go.mod'), 'module x\n');
    expect((await detectChecks(dir)).map((c) => c.command)).toEqual([
      'cargo test',
      'go test ./...',
    ]);
  });
});

describe('runChecks', () => {
  const check = (command: string, needsNodeModules = false): ProjectCheck => ({
    name: command,
    command,
    source: 'KOVAN.md',
    needsNodeModules,
  });
  const run = (checks: ProjectCheck[], hasNodeModules = true) =>
    runChecks(dir, checks, { hasNodeModules, timeoutMs: 10_000 });

  it('marks what passed, what failed, and what never ran after a failure', async () => {
    const results = await run([check('true'), check('echo boom && exit 3'), check('true')]);
    expect(results.map((r) => r.status)).toEqual(['passed', 'failed', 'not_run']);
    expect(results[1]!.detail).toBe('boom');
    expect(results[2]!.detail).toBe('An earlier check failed');
  });

  it("calls a check blocked when it can't run here", async () => {
    const missing = await run([check('kovan-no-such-tool --check'), check('true')]);
    expect(missing.map((r) => r.status)).toEqual(['blocked', 'not_run']);
    expect(missing[0]!.detail).toContain("isn't installed here");

    const noDeps = await run([check('npm run test', true)], false);
    expect(noDeps[0]).toMatchObject({ status: 'blocked', ms: null });
    expect(noDeps[0]!.detail).toContain('no node_modules');
  });

  it('runs in the given folder', async () => {
    await mkdir(join(dir, 'src'));
    await writeFile(join(dir, 'src/x.txt'), 'x');
    expect((await run([check('test -f src/x.txt')]))[0]!.status).toBe('passed');
  });
});
