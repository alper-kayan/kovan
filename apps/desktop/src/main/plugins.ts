import { discoverSkills } from '@kovan/harness';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, posix, relative, resolve } from 'node:path';
import type {
  PluginContents,
  PluginInfo,
  PluginListing,
  PluginManifestInfo,
  PluginPreview,
  PluginSourceInput,
  PluginUpdate,
} from '../shared/api.js';
import { readJson, writeJson } from '@kovan/runner';
import { repoIdentity } from './repoId.js';

/**
 * Plugins, in Claude Code's format: a folder with `.claude-plugin/plugin.json` (or Kovan's
 * `plugin.json`), skills in `skills/` and MCP servers in `.mcp.json`. They are fetched from git
 * or copied from a folder into `userData/plugins/<name>`; nothing in them runs on install (a
 * plugin's MCP servers ask first, like a repository's). Commands, agents and hooks are listed
 * as not used: Kovan doesn't read them yet.
 */

export const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MANIFESTS = ['.claude-plugin/plugin.json', 'plugin.json'];
const MARKETPLACE = '.claude-plugin/marketplace.json';
const GIT_TIMEOUT = 120_000;
const MAX_PATCH = 100_000;

type Source =
  { kind: 'git'; url: string; path: string; ref: string } | { kind: 'folder'; path: string };

export interface PluginRecord {
  name: string;
  version: string | null;
  description: string;
  author: string | null;
  homepage: string | null;
  /** What was given, so updates fetch from the same place. */
  input: PluginSourceInput;
  kind: 'git' | 'folder';
  commit: string | null;
  installedAt: string;
  updatedAt: string;
  everywhere: boolean;
  /** Per workspace (its repository's main checkout): on or off, over `everywhere`. */
  workspaces: Record<string, boolean>;
}

interface Manifest {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  author?: unknown;
  homepage?: unknown;
  skills?: unknown;
  commands?: unknown;
  agents?: unknown;
  hooks?: unknown;
  mcpServers?: unknown;
  outputStyles?: unknown;
  lspServers?: unknown;
}

interface Staged {
  /** The staging folder (removed on install or discard). */
  dir: string;
  /** The plugin inside it. */
  root: string;
  input: PluginSourceInput;
  kind: 'git' | 'folder';
  commit: string | null;
  manifest: PluginManifestInfo;
}

/** A plugin's MCP server as its files write it, for the registry to start (after asking). */
export interface PluginServer {
  plugin: string;
  name: string;
  raw: Record<string, unknown>;
  /** The plugin's folder: `${CLAUDE_PLUGIN_ROOT}`. */
  dir: string;
}

function git(args: string[], cwd?: string): Promise<{ stdout: string; code: number }> {
  return new Promise((done, fail) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: GIT_TIMEOUT,
        maxBuffer: 20 * 1024 * 1024,
        // Never stop to ask for a password: a private repository fails with git's message.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' },
      },
      (error, stdout, stderr) => {
        const code = typeof error?.code === 'number' ? error.code : error ? -1 : 0;
        // `git diff --no-index` says 1 when there are differences.
        if (error && !(args.includes('--no-index') && code === 1))
          fail(new Error(stderr.trim().split('\n').slice(-3).join('\n') || error.message));
        else done({ stdout, code });
      },
    );
  });
}

/** What the person typed: a folder, GitHub's owner/repo, or a git URL. */
export async function resolveSource(input: PluginSourceInput): Promise<Source> {
  const text = input.source.trim();
  const path = normalizeSub(input.path);
  if (!text) throw new Error('Give a git URL, owner/repo or a folder');
  const local = text.startsWith('~') ? join(homedir(), text.slice(1)) : text;
  if (isAbsolute(local)) {
    if (!(await stat(local).catch(() => null))?.isDirectory())
      throw new Error(`No folder at ${local}`);
    return { kind: 'folder', path: join(local, path) };
  }
  const ref = input.ref.trim();
  if (ref && !/^[\w./-]+$/.test(ref)) throw new Error(`"${ref}" isn't a branch or tag name`);
  if (/^[\w.-]+\/[\w.-]+$/.test(text))
    return { kind: 'git', url: `https://github.com/${text.replace(/\.git$/, '')}.git`, path, ref };
  if (/^(https?|ssh|file):\/\//.test(text) || /^[\w.-]+@[\w.-]+:[\w./~-]+$/.test(text))
    return { kind: 'git', url: text, path, ref };
  throw new Error('Give a git URL (https://… or git@…), owner/repo or a folder path');
}

function normalizeSub(path: string): string {
  const clean = posix.normalize(path.trim().replace(/\\/g, '/')).replace(/^\.?\/+|\/+$/g, '');
  if (clean === '.' || clean === '') return '';
  if (clean.startsWith('..') || posix.isAbsolute(clean))
    throw new Error(`"${path}" leaves the source`);
  return clean;
}

/** `rel` inside `root`, or null when it would step outside. */
function inside(root: string, rel: string): string | null {
  const full = resolve(root, rel);
  const r = relative(root, full);
  return r.startsWith('..') || isAbsolute(r) ? null : full;
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

async function readManifest(
  root: string,
): Promise<{ manifest: Manifest | null; problem: string | null }> {
  for (const file of MANIFESTS) {
    const path = join(root, file);
    if (!(await exists(path))) continue;
    try {
      const data = JSON.parse(await readFile(path, 'utf8')) as unknown;
      if (!data || typeof data !== 'object' || Array.isArray(data))
        return { manifest: null, problem: `${file} isn't a JSON object` };
      return { manifest: data as Manifest, problem: null };
    } catch (error) {
      return { manifest: null, problem: `${file} can't be read: ${(error as Error).message}` };
    }
  }
  return { manifest: null, problem: null };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const paths = (v: unknown): string[] =>
  typeof v === 'string'
    ? [v]
    : Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string')
      : [];

function manifestInfo(manifest: Manifest | null, root: string): PluginManifestInfo {
  const author = manifest?.author;
  return {
    name:
      str(manifest?.name) ??
      basename(root)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-'),
    version: str(manifest?.version),
    description: str(manifest?.description) ?? '',
    author:
      str(author) ??
      (author && typeof author === 'object' ? str((author as { name?: unknown }).name) : null),
    homepage: str(manifest?.homepage),
  };
}

async function countFiles(dir: string, ext: string): Promise<number> {
  let n = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) n += await countFiles(join(dir, e.name), ext);
    else if (e.name.endsWith(ext)) n++;
  }
  return n;
}

/** The skill folders a plugin has: `skills/` and any its manifest adds. */
async function skillFolders(root: string, manifest: Manifest | null): Promise<string[]> {
  const dirs = ['skills', ...paths(manifest?.skills)]
    .map((p) => inside(root, p))
    .filter((p): p is string => p !== null);
  const out: string[] = [];
  for (const d of [...new Set(dirs)])
    if ((await stat(d).catch(() => null))?.isDirectory()) out.push(d);
  return out;
}

/** Its MCP servers, as written: `.mcp.json`, or what the manifest's `mcpServers` points to. */
async function serverEntries(
  root: string,
  manifest: Manifest | null,
  warnings: string[],
): Promise<Record<string, Record<string, unknown>>> {
  const out: Record<string, Record<string, unknown>> = {};
  const add = (map: unknown, from: string) => {
    const servers =
      map && typeof map === 'object' && 'mcpServers' in (map as object)
        ? (map as { mcpServers: unknown }).mcpServers
        : map;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
      warnings.push(`${from}: no "mcpServers" object`);
      return;
    }
    for (const [name, entry] of Object.entries(servers as Record<string, unknown>))
      if (entry && typeof entry === 'object' && !Array.isArray(entry))
        out[name] = entry as Record<string, unknown>;
  };
  const sources =
    manifest?.mcpServers === undefined
      ? ['.mcp.json']
      : Array.isArray(manifest.mcpServers)
        ? manifest.mcpServers
        : [manifest.mcpServers];
  for (const src of sources) {
    if (typeof src !== 'string') {
      add(src, 'plugin.json');
      continue;
    }
    const file = inside(root, src);
    if (!file) {
      warnings.push(`${src} is outside the plugin`);
      continue;
    }
    if (!(await exists(file))) {
      if (src !== '.mcp.json') warnings.push(`${src} isn't there`);
      continue;
    }
    try {
      add(JSON.parse(await readFile(file, 'utf8')), src);
    } catch (error) {
      warnings.push(`${src} can't be read: ${(error as Error).message}`);
    }
  }
  return out;
}

/** The card's line for a server: what it runs or reaches. */
function serverDetail(raw: Record<string, unknown>): string {
  if (typeof raw['url'] === 'string') return `Connects to ${raw['url']}`;
  const args = Array.isArray(raw['args']) ? raw['args'].filter((a) => typeof a === 'string') : [];
  return `Runs ${[String(raw['command'] ?? ''), ...args].join(' ')}`;
}

async function readContents(
  name: string,
  root: string,
  manifest: Manifest | null,
): Promise<PluginContents> {
  const warnings: string[] = [];
  const found = await discoverSkills({
    root: null,
    userDir: null,
    claudeDir: null,
    plugins: (await skillFolders(root, manifest)).map((dir) => ({ name, dir })),
  });
  for (const w of found.warnings) warnings.push(`${relative(root, w.path)}: ${w.problem}`);
  const servers = await serverEntries(root, manifest, warnings);
  const unused: string[] = [];
  const count = async (dir: string, extra: unknown, word: string) => {
    let n = await countFiles(join(root, dir), '.md');
    for (const p of paths(extra)) {
      const full = inside(root, p);
      if (!full) continue;
      n += (await stat(full).catch(() => null))?.isDirectory() ? await countFiles(full, '.md') : 1;
    }
    if (n) unused.push(`${n} ${word}${n === 1 ? '' : 's'}`);
  };
  await count('commands', manifest?.commands, 'command');
  await count('agents', manifest?.agents, 'agent');
  if (manifest?.hooks !== undefined || (await exists(join(root, 'hooks', 'hooks.json'))))
    unused.push('hooks');
  if (manifest?.outputStyles !== undefined || (await exists(join(root, 'output-styles'))))
    unused.push('output styles');
  if (manifest?.lspServers !== undefined || (await exists(join(root, '.lsp.json'))))
    unused.push('LSP servers');
  return {
    skills: found.skills.map((s) => ({ name: s.name, description: s.description })),
    mcpServers: Object.entries(servers).map(([n, raw]) => ({ name: n, detail: serverDetail(raw) })),
    unused,
    warnings,
  };
}

/** `git diff --stat` of old/ against new/, with the folder names taken out. */
function cleanStat(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(/^(\s*)\{old => new\}\//, '$1')
        .replace(/^(\s*)\/dev\/null => new\/(\S+)/, '$1$2 (new)')
        .replace(/^(\s*)old\/(\S+) => \/dev\/null/, '$1$2 (removed)'),
    )
    .join('\n');
}

function cleanPatch(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(/^diff --git a\/(?:old|new)\/(.*) b\/(?:old|new)\/(.*)$/, 'diff --git a/$1 b/$2')
        .replace(/^--- a\/(?:old|new)\//, '--- a/')
        .replace(/^\+\+\+ b\/(?:old|new)\//, '+++ b/'),
    )
    .join('\n');
}

export class PluginManager {
  readonly dir: string;
  private readonly file: string;
  private readonly stagingDir: string;
  private records: PluginRecord[] | null = null;
  private staged = new Map<string, Staged>();

  constructor(userData: string) {
    this.dir = join(userData, 'plugins');
    this.file = join(userData, 'plugins.json');
    this.stagingDir = join(this.dir, '.staging');
  }

  /** Clears what an earlier run fetched and never installed. */
  async init(): Promise<void> {
    await rm(this.stagingDir, { recursive: true, force: true });
  }

  private async load(): Promise<PluginRecord[]> {
    this.records ??=
      ((await readJson(this.file)) as { plugins?: PluginRecord[] } | undefined)?.plugins ?? [];
    return this.records;
  }

  private async save(): Promise<void> {
    await writeJson(this.file, { plugins: this.records ?? [] });
  }

  private pluginDir(name: string): string {
    return join(this.dir, name);
  }

  // ---- fetching ----

  /** Fetches into a staging folder: a shallow clone (without its .git) or a copy. */
  private async fetch(input: PluginSourceInput): Promise<{
    dir: string;
    base: string;
    kind: 'git' | 'folder';
    commit: string | null;
    sub: string;
  }> {
    const source = await resolveSource(input);
    const dir = join(this.stagingDir, randomUUID());
    const base = join(dir, 'src');
    await mkdir(dir, { recursive: true });
    try {
      if (source.kind === 'git') {
        await git([
          'clone',
          '--depth',
          '1',
          '--quiet',
          ...(source.ref ? ['--branch', source.ref] : []),
          '--',
          source.url,
          base,
        ]);
        const commit = (await git(['-C', base, 'rev-parse', 'HEAD'])).stdout.trim();
        await rm(join(base, '.git'), { recursive: true, force: true });
        return { dir, base, kind: 'git', commit, sub: source.path };
      }
      // A copy, so later changes to the folder reach agents only through an update.
      await cp(source.path, base, {
        recursive: true,
        filter: (from) => basename(from) !== '.git',
      });
      return { dir, base, kind: 'folder', commit: null, sub: '' };
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  /** Fetches a plugin and says what it holds; nothing is installed until `install`. */
  async preview(input: PluginSourceInput): Promise<PluginPreview> {
    const fetched = await this.fetch(input);
    try {
      const root = fetched.sub ? inside(fetched.base, fetched.sub) : fetched.base;
      if (!root || !(await stat(root).catch(() => null))?.isDirectory())
        throw new Error(`No folder "${input.path}" in it`);
      const { manifest, problem } = await readManifest(root);
      if (problem) throw new Error(problem);
      if (!manifest) {
        const market = await this.marketplace(root, input);
        if (market) {
          await rm(fetched.dir, { recursive: true, force: true });
          return market;
        }
        const looksLike =
          (await exists(join(root, 'skills'))) || (await exists(join(root, '.mcp.json')));
        if (!looksLike)
          throw new Error(
            'No plugin here: no .claude-plugin/plugin.json, plugin.json, skills/ or .mcp.json',
          );
      }
      const info = manifestInfo(manifest, root);
      if (!PLUGIN_NAME.test(info.name))
        throw new Error(
          `"${info.name}" isn't a plugin name: lowercase letters, digits and hyphens`,
        );
      const contents = await readContents(info.name, root, manifest);
      if (!manifest) contents.warnings.unshift('No plugin.json: named after its folder');
      const stagingId = basename(fetched.dir);
      this.staged.set(stagingId, {
        dir: fetched.dir,
        root,
        input: {
          source: input.source.trim(),
          path: fetched.kind === 'git' ? fetched.sub : '',
          ref: input.ref.trim(),
        },
        kind: fetched.kind,
        commit: fetched.commit,
        manifest: info,
      });
      // A folder is kept as given, its subfolder included.
      if (fetched.kind === 'folder')
        this.staged.get(stagingId)!.input.source = (await resolveSource(input)).path;
      const installed = (await this.load()).some((p) => p.name === info.name);
      return {
        kind: 'plugin',
        stagingId,
        manifest: info,
        contents,
        commit: fetched.commit,
        installed,
      };
    } catch (error) {
      await rm(fetched.dir, { recursive: true, force: true });
      throw error;
    }
  }

  /** A marketplace (a list of plugins, Claude Code's `marketplace.json`) to choose from. */
  private async marketplace(root: string, input: PluginSourceInput): Promise<PluginPreview | null> {
    const file = join(root, MARKETPLACE);
    if (!(await exists(file))) return null;
    let data: { name?: unknown; metadata?: { pluginRoot?: unknown }; plugins?: unknown };
    try {
      data = JSON.parse(await readFile(file, 'utf8')) as typeof data;
    } catch (error) {
      throw new Error(`${MARKETPLACE} can't be read: ${(error as Error).message}`, {
        cause: error,
      });
    }
    const pluginRoot = str(data.metadata?.pluginRoot) ?? '';
    const plugins: { name: string; description: string; source: PluginSourceInput }[] = [];
    for (const p of Array.isArray(data.plugins) ? data.plugins : []) {
      const entry = p as { name?: unknown; description?: unknown; source?: unknown };
      const name = str(entry.name);
      if (!name) continue;
      const src = entry.source;
      let source: PluginSourceInput | null = null;
      if (typeof src === 'string') {
        // A folder of this same repository (or folder).
        const local = isAbsolute(input.source.trim()) || input.source.trim().startsWith('~');
        const sub = posix.join(
          input.path || '',
          src.startsWith('./') || src.startsWith('../') ? src : posix.join(pluginRoot, src),
        );
        source = local
          ? { source: join(input.source.trim(), sub), path: '', ref: '' }
          : { source: input.source, path: sub, ref: input.ref };
      } else if (src && typeof src === 'object') {
        const s = src as {
          source?: unknown;
          repo?: unknown;
          url?: unknown;
          ref?: unknown;
          path?: unknown;
        };
        const ref = str(s.ref) ?? '';
        const path = str(s.path) ?? '';
        if (s.source === 'github' && str(s.repo)) source = { source: str(s.repo)!, path, ref };
        else if ((s.source === 'url' || s.source === 'git') && str(s.url))
          source = { source: str(s.url)!, path, ref };
      }
      if (source) plugins.push({ name, description: str(entry.description) ?? '', source });
    }
    return { kind: 'marketplace', name: str(data.name) ?? basename(root), plugins };
  }

  async discard(stagingId: string): Promise<void> {
    const staged = this.staged.get(stagingId);
    this.staged.delete(stagingId);
    if (staged) await rm(staged.dir, { recursive: true, force: true });
  }

  private take(stagingId: string): Staged {
    const staged = this.staged.get(stagingId);
    if (!staged) throw new Error('That download is gone: look at the plugin again');
    this.staged.delete(stagingId);
    return staged;
  }

  async install(stagingId: string): Promise<PluginRecord> {
    const staged = this.take(stagingId);
    try {
      const records = await this.load();
      const { name } = staged.manifest;
      if (records.some((p) => p.name === name))
        throw new Error(`${name} is installed already: use "Check for update"`);
      await mkdir(this.dir, { recursive: true });
      await rename(staged.root, this.pluginDir(name));
      const now = new Date().toISOString();
      const record: PluginRecord = {
        ...staged.manifest,
        input: staged.input,
        kind: staged.kind,
        commit: staged.commit,
        installedAt: now,
        updatedAt: now,
        everywhere: true,
        workspaces: {},
      };
      records.push(record);
      records.sort((a, b) => a.name.localeCompare(b.name));
      await this.save();
      return record;
    } finally {
      await rm(staged.dir, { recursive: true, force: true });
    }
  }

  // ---- updates ----

  async checkUpdate(name: string): Promise<PluginUpdate> {
    const record = (await this.load()).find((p) => p.name === name);
    if (!record) throw new Error(`${name} isn't installed`);
    const preview = await this.preview(record.input);
    if (preview.kind !== 'plugin') throw new Error('Its source is a list of plugins now');
    const staged = this.staged.get(preview.stagingId)!;
    if (preview.manifest.name !== name) {
      await this.discard(preview.stagingId);
      throw new Error(`The new version calls itself "${preview.manifest.name}"`);
    }
    if (record.kind === 'git' && staged.commit === record.commit) {
      await this.discard(preview.stagingId);
      return { upToDate: true };
    }
    // Both trees side by side as old/ and new/, so the diff reads like a normal one.
    await cp(this.pluginDir(name), join(staged.dir, 'old'), { recursive: true });
    await rename(staged.root, join(staged.dir, 'new'));
    staged.root = join(staged.dir, 'new');
    const diff = (extra: string[]) =>
      git(['diff', '--no-index', '--no-color', ...extra, '--', 'old', 'new'], staged.dir);
    const stat = cleanStat((await diff(['--stat=120'])).stdout);
    if (!stat.trim()) {
      await this.discard(preview.stagingId);
      return { upToDate: true };
    }
    const patch = cleanPatch((await diff([])).stdout);
    return {
      upToDate: false,
      stagingId: preview.stagingId,
      from: { version: record.version, commit: record.commit },
      to: { version: preview.manifest.version, commit: preview.commit },
      stat: stat.trimEnd(),
      patch: patch.slice(0, MAX_PATCH),
      patchCut: patch.length > MAX_PATCH,
      contents: preview.contents,
    };
  }

  async update(name: string, stagingId: string): Promise<void> {
    const staged = this.take(stagingId);
    try {
      const records = await this.load();
      const record = records.find((p) => p.name === name);
      if (!record || staged.manifest.name !== name) throw new Error(`${name} isn't installed`);
      const dir = this.pluginDir(name);
      const old = join(this.stagingDir, `old-${randomUUID()}`);
      await rename(dir, old);
      try {
        await rename(staged.root, dir);
      } catch (error) {
        await rename(old, dir);
        throw error;
      }
      await rm(old, { recursive: true, force: true });
      Object.assign(record, staged.manifest, {
        commit: staged.commit,
        updatedAt: new Date().toISOString(),
      });
      await this.save();
    } finally {
      await rm(staged.dir, { recursive: true, force: true });
    }
  }

  async remove(name: string): Promise<void> {
    const records = await this.load();
    const at = records.findIndex((p) => p.name === name);
    if (at === -1) return;
    records.splice(at, 1);
    await this.save();
    await rm(this.pluginDir(name), { recursive: true, force: true });
  }

  // ---- where they are on ----

  private async isOn(record: PluginRecord, root: string | null): Promise<boolean> {
    if (!root) return record.everywhere;
    return record.workspaces[await repoIdentity(root)] ?? record.everywhere;
  }

  async setEnabled(name: string, root: string, enabled: boolean): Promise<void> {
    const record = (await this.load()).find((p) => p.name === name);
    if (!record) return;
    record.workspaces[await repoIdentity(root)] = enabled;
    await this.save();
  }

  async setEverywhere(name: string, everywhere: boolean): Promise<void> {
    const record = (await this.load()).find((p) => p.name === name);
    if (!record) return;
    record.everywhere = everywhere;
    await this.save();
  }

  /** The plugins on for agents in `root` (all that are on everywhere without one). */
  async enabled(root: string | null): Promise<PluginRecord[]> {
    const out: PluginRecord[] = [];
    for (const r of await this.load()) if (await this.isOn(r, root)) out.push(r);
    return out;
  }

  /** Their skill folders, for the skill library. */
  async skillDirs(root: string | null): Promise<{ name: string; dir: string }[]> {
    const out: { name: string; dir: string }[] = [];
    for (const r of await this.enabled(root)) {
      const dir = this.pluginDir(r.name);
      const { manifest } = await readManifest(dir);
      for (const d of await skillFolders(dir, manifest)) out.push({ name: r.name, dir: d });
    }
    return out;
  }

  /** Their MCP servers, for the registry (which asks before starting one). */
  async servers(root: string | null): Promise<PluginServer[]> {
    const out: PluginServer[] = [];
    for (const r of await this.enabled(root)) {
      const dir = this.pluginDir(r.name);
      const { manifest } = await readManifest(dir);
      for (const [name, raw] of Object.entries(await serverEntries(dir, manifest, [])))
        out.push({ plugin: r.name, name, raw, dir });
    }
    return out;
  }

  async listing(root: string | null): Promise<PluginListing> {
    const plugins: PluginInfo[] = [];
    for (const r of await this.load()) {
      const dir = this.pluginDir(r.name);
      const { manifest } = await readManifest(dir);
      plugins.push({
        name: r.name,
        version: r.version,
        description: r.description,
        author: r.author,
        homepage: r.homepage,
        source: {
          kind: r.kind,
          label:
            r.kind === 'folder'
              ? r.input.source
              : `${r.input.source}${r.input.path ? ` · ${r.input.path}` : ''}${r.input.ref ? ` @ ${r.input.ref}` : ''}`,
          ...r.input,
        },
        commit: r.commit,
        installedAt: r.installedAt,
        updatedAt: r.updatedAt,
        contents: await readContents(r.name, dir, manifest),
        enabledHere: root ? await this.isOn(r, root) : null,
        everywhere: r.everywhere,
        dir,
      });
    }
    return { plugins, root };
  }
}
