import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { branchFile } from './branchFile.js';

let dir: string;
let mine: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kovan-branch-'));
  const origin = join(dir, 'origin.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  // A machine clones, works on the session branch and pushes it.
  const machine = join(dir, 'machine');
  git(dir, 'clone', '-q', origin, machine);
  git(machine, 'config', 'user.email', 'm@example.com');
  git(machine, 'config', 'user.name', 'm');
  await writeFile(join(machine, 'README.md'), 'hi\n');
  git(machine, 'add', '.');
  git(machine, 'commit', '-qm', 'start');
  git(machine, 'push', '-q', 'origin', 'HEAD:main');
  // The person's checkout, on main with their own unsaved work.
  mine = join(dir, 'mine');
  git(dir, 'clone', '-q', origin, mine);
  await writeFile(join(mine, 'notes.txt'), 'mine\n');
  git(machine, 'checkout', '-qb', 'kovan/inventory');
  await mkdir(join(machine, 'docs'));
  await writeFile(join(machine, 'docs', 'inventory.md'), '# Inventory\n');
  git(machine, 'add', '.');
  git(machine, 'commit', '-qm', 'inventory');
  git(machine, 'push', '-q', 'origin', 'kovan/inventory');
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("a file on a session's branch", () => {
  it('is read from the remote branch, leaving the checkout as it is', async () => {
    const got = await branchFile(mine, 'kovan/inventory', 'docs/inventory.md');
    expect(got).toMatchObject({
      file: { kind: 'text', content: '# Inventory\n' },
      remote: 'origin',
    });
    expect(git(mine, 'branch', '--show-current').trim()).toBe('main');
    expect(git(mine, 'status', '--short')).toContain('notes.txt');
  });

  it("says when the file or the branch isn't there yet", async () => {
    expect(await branchFile(mine, 'kovan/inventory', 'docs/later.md')).toMatchObject({
      missing: 'file',
    });
    expect(await branchFile(mine, 'kovan/nothing', 'docs/inventory.md')).toMatchObject({
      missing: 'branch',
    });
  });

  it('refuses paths outside the repository and odd branch names', async () => {
    await expect(branchFile(mine, 'kovan/inventory', '../secret')).rejects.toThrow(/Not a path/);
    await expect(branchFile(mine, 'kovan/inventory', '/etc/passwd')).rejects.toThrow(/Not a path/);
    await expect(branchFile(mine, '-x', 'README.md')).rejects.toThrow();
  });
});
