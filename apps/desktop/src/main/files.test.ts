import { git } from '@kovan/git-engine';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FsChangeEvent } from '../shared/api.js';
import {
  listWorkspaceFiles,
  readDirEntries,
  readTextFile,
  watchWorkspace,
  writeTextFile,
} from './files.js';

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'kovan-files-')));
  await mkdir(join(root, 'src', 'deep'), { recursive: true });
  await writeFile(join(root, 'src', 'b.ts'), 'b');
  await writeFile(join(root, 'src', 'a10.ts'), 'a10');
  await writeFile(join(root, 'src', 'a2.ts'), 'a2');
  await writeFile(join(root, '.DS_Store'), '');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('workspace files', () => {
  it('lists folders first, sorts names naturally and hides .DS_Store', async () => {
    expect((await readDirEntries(root, 'src')).map((e) => e.path)).toEqual([
      'src/deep',
      'src/a2.ts',
      'src/a10.ts',
      'src/b.ts',
    ]);
    expect((await readDirEntries(root, '')).map((e) => e.name)).toEqual(['src']);
  });

  it('reads text, flags binary files and writes into new folders', async () => {
    await writeFile(join(root, 'img.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    expect(await readTextFile(root, 'img.bin')).toEqual({ kind: 'binary' });
    await writeTextFile(root, 'new/dir/file.txt', 'hello');
    expect(await readTextFile(root, 'new/dir/file.txt')).toEqual({
      kind: 'text',
      content: 'hello',
    });
  });

  it('refuses paths outside the workspace', async () => {
    await expect(readTextFile(root, '../outside.txt')).rejects.toThrow('outside the workspace');
    await expect(writeTextFile(root, '../outside.txt', 'x')).rejects.toThrow(
      'outside the workspace',
    );
  });

  it('lists tracked and untracked files in a repo, respecting .gitignore', async () => {
    await git(root, ['init', '-q']);
    await writeFile(join(root, '.gitignore'), 'ignored.txt\n');
    await writeFile(join(root, 'ignored.txt'), 'x');
    const files = await listWorkspaceFiles(root, true);
    expect(files.sort()).toEqual([
      '.DS_Store',
      '.gitignore',
      'src/a10.ts',
      'src/a2.ts',
      'src/b.ts',
    ]);
  });

  it('walks folders outside a repo, skipping node_modules', async () => {
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), '');
    const files = await listWorkspaceFiles(root, false);
    expect(files).toContain('src/b.ts');
    expect(files.some((f) => f.startsWith('node_modules'))).toBe(false);
  });

  it('reports batched changes from the recursive watcher', async () => {
    const events: FsChangeEvent[] = [];
    const stop = watchWorkspace(root, (e) => events.push(e), 50);
    try {
      await new Promise((r) => setTimeout(r, 100));
      await writeFile(join(root, 'src', 'deep', 'c.ts'), 'c');
      // FSEvents may first deliver events from the setup writes; wait for ours.
      const seen = () => events.flatMap((e) => e.paths);
      for (let i = 0; i < 60 && !seen().includes('src/deep/c.ts'); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(seen()).toContain('src/deep/c.ts');
    } finally {
      stop();
    }
  });
});
