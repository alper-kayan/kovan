import { git } from '@kovan/git-engine';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectRepo, isConnected } from './repoSetup.js';

let root: string;
const mcp = { command: '/Apps/Kovan', args: ['/k/main.js'], env: { ELECTRON_RUN_AS_NODE: '1' } };
const hook = {
  node: '/Apps/Kovan',
  script: '/k/hook.js',
  env: { ELECTRON_RUN_AS_NODE: '1', KOVAN_BRIDGE_FILE: "/a b/it's.json" },
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kovan-setup-'));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.email', 't@kovan.test']);
  await git(root, ['config', 'user.name', 'T']);
  // The team already has a CLAUDE.md in the repo; the person has their own Claude hook.
  await writeFile(join(root, 'CLAUDE.md'), '# Team rules\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'init']);
  await writeFile(
    join(root, '.mcp.json'),
    JSON.stringify({ mcpServers: { theirs: { command: 'x' } } }),
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('connectRepo', () => {
  it('writes hooks, MCP and instructions locally, never into commits, and keeps what is theirs', async () => {
    const result = await connectRepo(root, mcp, hook);
    expect(result.skipped).toEqual(['CLAUDE.md']);
    expect(result.written.sort()).toEqual([
      '.claude/settings.json',
      '.codex/config.toml',
      '.mcp.json',
      'AGENTS.md',
    ]);
    expect(await readFile(join(root, 'CLAUDE.md'), 'utf8')).toBe('# Team rules\n');

    const settings = JSON.parse(await readFile(join(root, '.claude/settings.json'), 'utf8'));
    expect(Object.keys(settings.hooks)).toEqual([
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Stop',
    ]);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(
      `ELECTRON_RUN_AS_NODE='1' KOVAN_BRIDGE_FILE='/a b/it'\\''s.json' '/Apps/Kovan' '/k/hook.js' PreToolUse # kovan-hook`,
    );
    const mcpJson = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8'));
    expect(Object.keys(mcpJson.mcpServers)).toEqual(['theirs', 'kovan']);
    expect(await readFile(join(root, '.codex/config.toml'), 'utf8')).toContain(
      '[mcp_servers.kovan]',
    );
    expect(await isConnected(root)).toBe(true);

    // Nothing shows up as a change to commit.
    expect((await git(root, ['status', '--porcelain'])).trim()).toBe('');

    // Running it again replaces Kovan's entries instead of piling them up.
    await connectRepo(root, mcp, hook);
    const again = JSON.parse(await readFile(join(root, '.claude/settings.json'), 'utf8'));
    expect(again.hooks.Stop).toHaveLength(1);
    expect(
      (await readFile(join(root, '.codex/config.toml'), 'utf8')).match(/\[mcp_servers\.kovan\]/g),
    ).toHaveLength(1);
    expect((await readFile(join(root, 'AGENTS.md'), 'utf8')).match(/kovan:start/g)).toHaveLength(1);
  });
});

describe('connectRepo in a worktree', () => {
  it('uses the shared exclude file and writes nothing else into the worktree', async () => {
    const wt = join(root, '..', `${root.split('/').pop()}-wt`);
    await git(root, ['worktree', 'add', '-q', '-b', 'kovan/wt', wt]);
    try {
      await connectRepo(wt, mcp, hook);
      // Only the setup files; no stray folders from an absolute git path.
      expect((await git(wt, ['status', '--porcelain', '--untracked-files=all'])).trim()).toBe('');
      const common = (await git(root, ['rev-parse', '--git-common-dir'])).trim();
      expect(await readFile(join(root, common, 'info', 'exclude'), 'utf8')).toContain(
        '/.claude/settings.json',
      );
    } finally {
      await rm(wt, { recursive: true, force: true });
    }
  });
});
