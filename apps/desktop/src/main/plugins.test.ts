import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../shared/settings.js';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}));

const { PluginManager, resolveSource } = await import('./plugins.js');
const { McpRegistry } = await import('./mcp.js');
const { SkillLibrary } = await import('./skills.js');

const FAKE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/mcp-client/test/fake-server.mjs',
);

let base: string;
let userData: string;
let plugins: InstanceType<typeof PluginManager>;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'kovan-plugins-'));
  userData = join(base, 'userData');
  await mkdir(userData);
  plugins = new PluginManager(userData);
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function write(path: string, content: string | object) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

/** A plugin as Claude Code lays one out. */
async function makePlugin(dir: string, name = 'release-tools', version = '1.0.0') {
  await write(join(dir, '.claude-plugin/plugin.json'), {
    name,
    version,
    description: 'Release notes and changelogs',
    author: { name: 'Acme' },
  });
  await write(
    join(dir, 'skills/notes/SKILL.md'),
    '---\nname: notes\ndescription: Writes release notes\n---\n\nSteps.\n',
  );
  await write(join(dir, '.mcp.json'), {
    mcpServers: { fake: { command: process.execPath, args: [FAKE, '${CLAUDE_PLUGIN_ROOT}'] } },
  });
  await write(join(dir, 'commands/ship.md'), 'Ship it');
  await write(join(dir, 'commands/tag.md'), 'Tag it');
  await write(join(dir, 'agents/reviewer.md'), 'Review');
  await write(join(dir, 'hooks/hooks.json'), { hooks: {} });
}

function gitRepo(dir: string) {
  const g = (...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });
  g('init', '-q', '-b', 'main');
  return {
    commit: (message: string) => {
      g('add', '-A');
      g('commit', '-qm', message);
    },
  };
}

const local = (source: string) => ({ source, path: '', ref: '' });

describe('plugins', () => {
  it('shows what a folder plugin holds, installs nothing until asked, then copies it in', async () => {
    const src = join(base, 'src');
    await makePlugin(src);
    const preview = await plugins.preview(local(src));
    if (preview.kind !== 'plugin') throw new Error('expected a plugin');
    expect(preview.manifest).toEqual({
      name: 'release-tools',
      version: '1.0.0',
      description: 'Release notes and changelogs',
      author: 'Acme',
      homepage: null,
    });
    expect(preview.contents).toEqual({
      skills: [{ name: 'release-tools:notes', description: 'Writes release notes' }],
      mcpServers: [
        { name: 'fake', detail: `Runs ${process.execPath} ${FAKE} \${CLAUDE_PLUGIN_ROOT}` },
      ],
      unused: ['2 commands', '1 agent', 'hooks'],
      warnings: [],
    });
    expect((await plugins.listing(null)).plugins).toEqual([]);

    await plugins.install(preview.stagingId);
    const [info] = (await plugins.listing(null)).plugins;
    expect(info).toMatchObject({
      name: 'release-tools',
      source: { kind: 'folder', label: src },
      enabledHere: null,
      everywhere: true,
      dir: join(userData, 'plugins', 'release-tools'),
    });
    // A copy: changing the folder doesn't reach agents until an update.
    await write(join(src, 'skills/extra/SKILL.md'), '---\ndescription: Extra\n---\n');
    expect((await plugins.listing(null)).plugins[0]!.contents.skills).toHaveLength(1);
    const again = await plugins.preview(local(src));
    expect(again).toMatchObject({ kind: 'plugin', installed: true });
    if (again.kind === 'plugin')
      await expect(plugins.install(again.stagingId)).rejects.toThrow(/installed already/);
    // Nothing left behind in staging.
    expect(await readdir(join(userData, 'plugins', '.staging'))).toEqual([]);
  });

  it('installs from git (a folder of a repository), shows an update as a diff, then applies it', async () => {
    const repo = join(base, 'repo');
    await makePlugin(join(repo, 'plugins/tools'), 'tools', '1.0.0');
    await write(join(repo, 'README.md'), 'Not the plugin');
    const g = gitRepo(repo);
    g.commit('First');
    const input = { source: `file://${repo}`, path: 'plugins/tools', ref: '' };
    const preview = await plugins.preview(input);
    if (preview.kind !== 'plugin') throw new Error('expected a plugin');
    expect(preview.commit).toMatch(/^[0-9a-f]{40}$/);
    await plugins.install(preview.stagingId);
    expect(await plugins.checkUpdate('tools')).toEqual({ upToDate: true });

    await makePlugin(join(repo, 'plugins/tools'), 'tools', '1.1.0');
    await write(
      join(repo, 'plugins/tools/skills/notes/SKILL.md'),
      '---\ndescription: Better notes\n---\n',
    );
    await write(join(repo, 'plugins/tools/skills/tags/SKILL.md'), '---\ndescription: Tags\n---\n');
    await rm(join(repo, 'plugins/tools/agents'), { recursive: true });
    g.commit('Second');
    const update = await plugins.checkUpdate('tools');
    if (update.upToDate) throw new Error('expected an update');
    expect(update.from.version).toBe('1.0.0');
    expect(update.to.version).toBe('1.1.0');
    expect(update.stat).toContain('.claude-plugin/plugin.json');
    expect(update.stat).toContain('skills/tags/SKILL.md (new)');
    expect(update.stat).toContain('agents/reviewer.md (removed)');
    expect(update.stat).not.toMatch(/\bold\/|\bnew\/|staging/);
    expect(update.patch).toContain('+++ b/skills/notes/SKILL.md');
    expect(update.patch).toContain('+description: Better notes');
    expect(update.contents.skills.map((s) => s.name)).toEqual(['tools:notes', 'tools:tags']);
    // Not applied until the person says so.
    expect((await plugins.listing(null)).plugins[0]!.version).toBe('1.0.0');

    await plugins.update('tools', update.stagingId);
    const [info] = (await plugins.listing(null)).plugins;
    expect(info!.version).toBe('1.1.0');
    expect(info!.commit).toBe(update.to.commit);
    expect(info!.contents.unused).toEqual(['2 commands', 'hooks']);
    expect(await plugins.checkUpdate('tools')).toEqual({ upToDate: true });

    await plugins.remove('tools');
    expect((await plugins.listing(null)).plugins).toEqual([]);
    expect(await readdir(join(userData, 'plugins'))).toEqual(['.staging']);
  });

  it("offers a marketplace's plugins to choose from", async () => {
    const repo = join(base, 'market');
    await makePlugin(join(repo, 'plugins/a'), 'a');
    await makePlugin(join(repo, 'plugins/b'), 'b');
    await write(join(repo, '.claude-plugin/marketplace.json'), {
      name: 'acme-tools',
      owner: { name: 'Acme' },
      plugins: [
        { name: 'a', description: 'Plugin A', source: './plugins/a' },
        { name: 'b', source: './plugins/b' },
        { name: 'remote', source: { source: 'github', repo: 'acme/remote' } },
      ],
    });
    gitRepo(repo).commit('Market');
    const listed = await plugins.preview({ source: `file://${repo}`, path: '', ref: '' });
    expect(listed).toEqual({
      kind: 'marketplace',
      name: 'acme-tools',
      plugins: [
        {
          name: 'a',
          description: 'Plugin A',
          source: { source: `file://${repo}`, path: 'plugins/a', ref: '' },
        },
        {
          name: 'b',
          description: '',
          source: { source: `file://${repo}`, path: 'plugins/b', ref: '' },
        },
        { name: 'remote', description: '', source: { source: 'acme/remote', path: '', ref: '' } },
      ],
    });
    if (listed.kind !== 'marketplace') throw new Error('expected a marketplace');
    const b = await plugins.preview(listed.plugins[1]!.source);
    expect(b).toMatchObject({ kind: 'plugin', manifest: { name: 'b' } });
  });

  it('turns on per workspace, over "everywhere"', async () => {
    const src = join(base, 'src');
    await makePlugin(src);
    const preview = await plugins.preview(local(src));
    if (preview.kind === 'plugin') await plugins.install(preview.stagingId);
    const here = join(base, 'here');
    const there = join(base, 'there');
    await mkdir(here);
    await mkdir(there);
    await plugins.setEnabled('release-tools', here, false);
    expect(await plugins.enabled(here)).toEqual([]);
    expect((await plugins.enabled(there)).map((p) => p.name)).toEqual(['release-tools']);
    await plugins.setEverywhere('release-tools', false);
    await plugins.setEnabled('release-tools', here, true);
    expect((await plugins.enabled(here)).map((p) => p.name)).toEqual(['release-tools']);
    expect(await plugins.enabled(there)).toEqual([]);
    expect((await plugins.listing(there)).plugins[0]).toMatchObject({
      enabledHere: false,
      everywhere: false,
    });

    // Skills follow: only where it is on.
    const settings = async () => ({ ...DEFAULT_SETTINGS });
    const library = new SkillLibrary(userData, settings, base, (root) => plugins.skillDirs(root));
    expect((await library.forRoot(here)).skills.map((s) => s.name)).toEqual([
      'release-tools:notes',
    ]);
    expect((await library.forRoot(there)).skills).toEqual([]);
  });

  it("starts a plugin's MCP server only once allowed, with its folder as CLAUDE_PLUGIN_ROOT", async () => {
    const src = join(base, 'src');
    await makePlugin(src);
    await write(join(src, '.mcp.json'), {
      mcpServers: {
        fake: {
          command: process.execPath,
          args: [FAKE],
          env: { FAKE_TOKEN: '${CLAUDE_PLUGIN_ROOT}' },
        },
      },
    });
    const preview = await plugins.preview(local(src));
    if (preview.kind === 'plugin') await plugins.install(preview.stagingId);
    const registry = new McpRegistry({
      userData,
      settings: async () => ({ ...DEFAULT_SETTINGS }),
      path: async () => process.env['PATH'] ?? '',
      version: 'test',
      plugins: (root) => plugins.servers(root),
    });
    try {
      const root = join(base, 'ws');
      await mkdir(root);
      expect(await registry.toolsFor(root)).toEqual([]);
      const listed = (await registry.listing(root)).servers;
      expect(listed).toEqual([
        expect.objectContaining({
          name: 'plugin_release-tools_fake',
          source: 'plugin',
          file: 'release-tools',
          status: 'untrusted',
        }),
      ]);
      const asked: { origin: string; file: string }[] = [];
      const tools = await registry.toolsFor(root, async (q) => {
        asked.push(q);
        return true;
      });
      expect(asked).toEqual([expect.objectContaining({ origin: 'plugin', file: 'release-tools' })]);
      const env = tools.find((t) => t.spec.name === 'mcp__plugin_release-tools_fake__env')!;
      const out = await env.run({}, { root, isRepo: false, signal: new AbortController().signal });
      // The plugin's folder (long, so masked as a value the server was given).
      expect(out.output).toBe('token is ••••••');
      // Off in this workspace: gone.
      await plugins.setEnabled('release-tools', root, false);
      expect(await registry.toolsFor(root)).toEqual([]);
    } finally {
      await registry.stop();
    }
  });

  it('refuses what it cannot use', async () => {
    await expect(resolveSource(local('not a source'))).rejects.toThrow(/git URL/);
    await expect(resolveSource({ source: 'acme/tools', path: '../up', ref: '' })).rejects.toThrow(
      /leaves/,
    );
    await expect(resolveSource({ source: 'acme/tools', path: '', ref: 'a b' })).rejects.toThrow(
      /branch or tag/,
    );
    expect(await resolveSource({ source: 'acme/tools', path: 'x/', ref: 'v1' })).toEqual({
      kind: 'git',
      url: 'https://github.com/acme/tools.git',
      path: 'x',
      ref: 'v1',
    });
    const empty = join(base, 'empty');
    await mkdir(empty);
    await expect(plugins.preview(local(empty))).rejects.toThrow(/No plugin here/);
    const bad = join(base, 'bad');
    await write(join(bad, 'plugin.json'), { name: 'Bad Name' });
    await expect(plugins.preview(local(bad))).rejects.toThrow(/isn't a plugin name/);
    expect(await readdir(join(userData, 'plugins', '.staging'))).toEqual([]);
  });
});
