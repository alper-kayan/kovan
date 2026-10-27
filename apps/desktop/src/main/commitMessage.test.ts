import { git } from '@kovan/git-engine';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanMessage, commitContext, commitPrompt } from './commitMessage.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'kovan-commit-'));
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 't@kovan.dev']);
  await git(repo, ['config', 'user.name', 'Test']);
  await writeFile(join(repo, 'a.js'), 'export const a = 1;\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'feat: add a']);
});
afterEach(() => rm(repo, { recursive: true, force: true }));

describe('commitContext', () => {
  it('uses the staged changes when there are some', async () => {
    await writeFile(join(repo, 'a.js'), 'export const a = 2;\n');
    await writeFile(join(repo, 'b.js'), 'export const b = 1;\n');
    await git(repo, ['add', 'b.js']);
    const c = (await commitContext(repo))!;
    expect(c.scope).toBe('staged');
    expect(c.stat).toContain('b.js');
    expect(c.stat).not.toContain('a.js');
    expect(c.recent).toEqual(['feat: add a']);
    expect(commitPrompt(c)).toContain('- feat: add a');
  });

  it('falls back to every change, new files included, when nothing is staged', async () => {
    await writeFile(join(repo, 'a.js'), 'export const a = 2;\n');
    await writeFile(join(repo, 'c.js'), 'export const c = 1;\n');
    const c = (await commitContext(repo))!;
    expect(c.scope).toBe('all');
    expect(c.diff).toContain('+export const a = 2;');
    expect(c.untracked).toEqual(['c.js']);
  });

  it('has nothing to say without changes', async () => {
    expect(await commitContext(repo)).toBeNull();
  });
});

describe('cleanMessage', () => {
  it('strips fences, quotes and a lead-in, and keeps one blank line before the body', () => {
    expect(cleanMessage('```\nAdd median()\n\n\n\nIt was missing.\n```')).toBe(
      'Add median()\n\nIt was missing.',
    );
    expect(cleanMessage('Commit message: "Fix the 429 path"')).toBe('Fix the 429 path');
    expect(cleanMessage('  Add sum  ')).toBe('Add sum');
  });
});
