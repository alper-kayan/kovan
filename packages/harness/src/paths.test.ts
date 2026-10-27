import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PathOutsideWorkspaceError, resolveInside, toRelative } from './paths.js';

let base: string;
let root: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'kovan-paths-'));
  root = join(base, 'ws');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), '');
  await mkdir(join(base, 'secret'));
  await writeFile(join(base, 'secret', 'key'), 'x');
  await symlink(join(base, 'secret'), join(root, 'escape'));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('resolveInside', () => {
  it('resolves files and not-yet-existing paths inside the root', async () => {
    expect(await resolveInside(root, 'src/a.ts')).toBe(join(root, 'src', 'a.ts'));
    expect(await resolveInside(root, 'src/new/deep/file.ts')).toBe(
      join(root, 'src/new/deep/file.ts'),
    );
    expect(await resolveInside(root, '')).toBe(root);
  });

  it('rejects traversal and absolute paths', async () => {
    await expect(resolveInside(root, '../secret/key')).rejects.toBeInstanceOf(
      PathOutsideWorkspaceError,
    );
    await expect(resolveInside(root, 'src/../../secret')).rejects.toBeInstanceOf(
      PathOutsideWorkspaceError,
    );
    await expect(resolveInside(root, join(base, 'secret'))).rejects.toBeInstanceOf(
      PathOutsideWorkspaceError,
    );
  });

  it('rejects symlinks that point outside, even for new files under them', async () => {
    await expect(resolveInside(root, 'escape/key')).rejects.toBeInstanceOf(
      PathOutsideWorkspaceError,
    );
    await expect(resolveInside(root, 'escape/new.txt')).rejects.toBeInstanceOf(
      PathOutsideWorkspaceError,
    );
  });
});

describe('toRelative', () => {
  it('uses forward slashes', () => {
    expect(toRelative(root, join(root, 'src', 'a.ts'))).toBe('src/a.ts');
  });
});
