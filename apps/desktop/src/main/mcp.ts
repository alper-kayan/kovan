import type { Tool } from '@kovan/harness';
import {
  maskSecrets,
  McpConnection,
  McpHub,
  mcpToolName,
  parseMcpConfig,
  secretValues,
  signIn,
  type McpServerConfig,
  type McpTool,
  type OAuthState,
  type OAuthStore,
} from '@kovan/mcp-client';
import { safeStorage } from 'electron';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  McpCheck,
  McpListing,
  McpServerInfo,
  McpServerInput,
  McpServerStatus,
} from '../shared/api.js';
import type { Settings } from '../shared/settings.js';
import { readJson, writeJson } from '@kovan/runner';
import type { PluginServer } from './plugins.js';
import { repoIdentity } from './repoId.js';

export interface McpDeps {
  userData: string;
  settings(): Promise<Settings>;
  /** The person's PATH (an app started from the Dock doesn't get the shell's). */
  path(): Promise<string>;
  version: string;
  /** The MCP servers of the plugins on in a workspace. */
  plugins?(root: string | null): Promise<PluginServer[]>;
}

/** What a server is doing, for Settings. */
export interface McpServerState {
  name: string;
  status: McpServerStatus;
  error: string | null;
  tools: string[];
}

/** A repository server waiting for the person's OK, as its card shows it. */
export interface TrustQuestion {
  key: string;
  name: string;
  /** A repository's file, or an installed plugin. */
  origin: 'repo' | 'plugin';
  /** The repository's file, or the plugin's name. */
  file: string;
  /** The server's own name in its file (a plugin's is `plugin_<plugin>_<server>` to agents). */
  label: string;
  /** What will run (or be reached), with `${VAR}`s as written in the file. */
  detail: string;
}

/** Asks the person; true runs the server (this time, or always if they chose that). */
export type AskTrust = (question: TrustQuestion) => Promise<boolean>;

/** Repository files, the first one winning when both name a server. */
const REPO_FILES = ['.kovan/mcp.json', '.mcp.json'];
const NAME = /^[A-Za-z0-9_-]{1,40}$/;

interface RawEntry {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** Kovan's own: turned off in Settings. */
  disabled?: boolean;
}

interface Secrets {
  servers: Record<string, { env?: Record<string, string>; headers?: Record<string, string> }>;
  /** Remote servers' sign-ins, by server URL. */
  oauth: Record<string, OAuthState>;
}

interface TrustRecord {
  decision: 'always' | 'deny';
  server: string;
  repo: string;
  file: string;
  at: string;
}

/** A server someone else wrote (a repository's or a plugin's): it starts once allowed. */
interface RepoServer {
  name: string;
  /** Its name in its file. */
  label: string;
  origin: 'repo' | 'plugin';
  file: string;
  raw: RawEntry;
  key: string;
  config: McpServerConfig | null;
  problem: string | null;
}

/**
 * The MCP servers Kovan's agents use: the person's own list (`mcp-servers.json`, Claude Code's
 * `.mcp.json` format, its env and header values in the keychain) and the open repository's
 * `.mcp.json` / `.kovan/mcp.json`, which start only once the person has allowed them. A
 * server starts the first time a turn needs its tools, keeps running for later turns, and
 * stops with the app or when it leaves the list.
 */
export class McpRegistry {
  readonly file: string;
  private readonly secretsFile: string;
  private readonly trustFile: string;
  private readonly hub: McpHub;
  private serverStates = new Map<string, McpServerState>();
  /** Tools to run without asking; kept current as Settings change, even mid-turn. */
  private allowed = new Set<string>();
  private secrets: Secrets | null = null;
  private trustRecords: Record<string, TrustRecord> | null = null;
  /** Repository servers allowed "once": until Kovan quits. */
  private onceTrusted = new Set<string>();
  /** The servers each workspace's agents last used. */
  private keysByRoot = new Map<string, string[]>();
  readonly oauth: OAuthStore;

  constructor(private readonly deps: McpDeps) {
    this.file = join(deps.userData, 'mcp-servers.json');
    this.secretsFile = join(deps.userData, 'mcp-secrets.bin');
    this.trustFile = join(deps.userData, 'mcp-trust.json');
    this.oauth = {
      get: async (url) => (await this.loadSecrets()).oauth[url],
      set: async (url, state) => {
        const secrets = await this.loadSecrets();
        if (state) secrets.oauth[url] = state;
        else delete secrets.oauth[url];
        // Without a keychain a sign-in lasts until Kovan quits.
        if (this.keychain()) await this.saveSecrets(secrets);
      },
    };
    this.hub = new McpHub({ client: { name: 'kovan', version: deps.version }, oauth: this.oauth });
  }

  keychain(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  // ---- storage ----

  private async loadSecrets(): Promise<Secrets> {
    if (this.secrets) return this.secrets;
    const empty: Secrets = { servers: {}, oauth: {} };
    const raw = this.keychain() ? await readFile(this.secretsFile).catch(() => null) : null;
    try {
      this.secrets = raw
        ? { ...empty, ...(JSON.parse(safeStorage.decryptString(raw)) as Secrets) }
        : empty;
    } catch {
      this.secrets = empty;
    }
    return this.secrets;
  }

  private async saveSecrets(secrets: Secrets): Promise<void> {
    this.secrets = secrets;
    if (!Object.keys(secrets.servers).length && !Object.keys(secrets.oauth).length) {
      await rm(this.secretsFile, { force: true });
      return;
    }
    await writeFile(this.secretsFile, safeStorage.encryptString(JSON.stringify(secrets)), {
      mode: 0o600,
    });
  }

  /** The person's list as written, with Kovan's `disabled` marks. */
  private async rawPersonal(): Promise<{
    entries: Record<string, RawEntry>;
    problem: string | null;
  }> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: {}, problem: null };
      return { entries: {}, problem: `${this.file} can't be read: ${(error as Error).message}` };
    }
    const map = (raw as { mcpServers?: unknown } | null)?.mcpServers;
    if (!map || typeof map !== 'object' || Array.isArray(map))
      return { entries: {}, problem: `${this.file} has no "mcpServers" object` };
    return { entries: map as Record<string, RawEntry>, problem: null };
  }

  private async writePersonal(entries: Record<string, RawEntry>): Promise<void> {
    await writeJson(this.file, { mcpServers: entries });
  }

  private async loadTrust(): Promise<Record<string, TrustRecord>> {
    this.trustRecords ??=
      ((await readJson(this.trustFile)) as Record<string, TrustRecord> | undefined) ?? {};
    return this.trustRecords;
  }

  // ---- reading the lists ----

  /** The person's enabled servers, secrets filled in from the keychain. */
  async personal(): Promise<ReturnType<typeof parseMcpConfig>> {
    const { entries, problem } = await this.rawPersonal();
    const secrets = await this.loadSecrets();
    const filled: Record<string, RawEntry> = {};
    for (const [name, entry] of Object.entries(entries)) {
      if (!entry || typeof entry !== 'object' || entry.disabled) continue;
      const saved = secrets.servers[name];
      filled[name] = {
        ...entry,
        ...(entry.env || saved?.env ? { env: { ...entry.env, ...saved?.env } } : {}),
        ...(entry.headers || saved?.headers
          ? { headers: { ...entry.headers, ...saved?.headers } }
          : {}),
      };
      delete filled[name].disabled;
    }
    const parsed = parseMcpConfig({ mcpServers: filled }, process.env);
    if (problem) parsed.problems.unshift({ name: '', problem });
    return parsed;
  }

  private repoId(root: string): Promise<string> {
    return repoIdentity(root);
  }

  /** The open repository's servers, each with the key its trust decision is kept under. */
  async repoServers(
    root: string,
  ): Promise<{ servers: RepoServer[]; problems: { name: string; problem: string }[] }> {
    const repo = await this.repoId(root);
    const servers: RepoServer[] = [];
    const problems: { name: string; problem: string }[] = [];
    for (const file of REPO_FILES) {
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(join(root, file), 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          problems.push({
            name: '',
            problem: `${file} can't be read: ${(error as Error).message}`,
          });
        continue;
      }
      const map = (raw as { mcpServers?: unknown } | null)?.mcpServers;
      if (!map || typeof map !== 'object' || Array.isArray(map)) {
        problems.push({ name: '', problem: `${file} has no "mcpServers" object` });
        continue;
      }
      const parsed = parseMcpConfig(raw, process.env);
      for (const [name, entry] of Object.entries(map as Record<string, RawEntry>)) {
        if (servers.some((s) => s.name === name)) continue;
        const problem = parsed.problems.find((p) => p.name === name)?.problem ?? null;
        if (!NAME.test(name)) {
          problems.push({ name, problem: problem ?? 'Bad name' });
          continue;
        }
        servers.push({
          name,
          label: name,
          origin: 'repo',
          file,
          raw: entry,
          // Anything in the entry changing (command, args, env, URL) asks again.
          key: createHash('sha256')
            .update(`${repo}\0${name}\0${JSON.stringify(entry)}`)
            .digest('hex')
            .slice(0, 32),
          config: parsed.servers[name] ?? null,
          problem,
        });
      }
    }
    return { servers, problems };
  }

  /**
   * The plugins' servers, named `plugin_<plugin>_<server>` as Claude Code names them, with
   * `${CLAUDE_PLUGIN_ROOT}` pointing at the plugin's folder.
   */
  async pluginServers(root: string | null): Promise<RepoServer[]> {
    const out: RepoServer[] = [];
    for (const p of (await this.deps.plugins?.(root).catch(() => [])) ?? []) {
      const vars = { ...process.env, CLAUDE_PLUGIN_ROOT: p.dir, KOVAN_PLUGIN_ROOT: p.dir };
      const parsed = parseMcpConfig({ mcpServers: { [p.name]: p.raw } }, vars);
      let config = parsed.servers[p.name] ?? null;
      if (config?.type === 'stdio')
        config = { ...config, env: { CLAUDE_PLUGIN_ROOT: p.dir, ...config.env } };
      out.push({
        name: `plugin_${p.plugin}_${p.name}`.slice(0, 80),
        label: p.name,
        origin: 'plugin',
        file: p.plugin,
        raw: p.raw as RawEntry,
        key: createHash('sha256')
          .update(`plugin\0${p.plugin}\0${p.name}\0${JSON.stringify(p.raw)}`)
          .digest('hex')
          .slice(0, 32),
        config,
        problem: parsed.problems[0]?.problem ?? null,
      });
    }
    return out;
  }

  /** Servers that start only once allowed: the plugins', then the repository's. */
  private async guarded(root: string | null): Promise<RepoServer[]> {
    return [
      ...(await this.pluginServers(root)),
      ...(root ? (await this.repoServers(root)).servers : []),
    ];
  }

  private async decision(key: string): Promise<'always' | 'once' | 'deny' | 'ask'> {
    const saved = (await this.loadTrust())[key]?.decision;
    if (saved) return saved;
    return this.onceTrusted.has(key) ? 'once' : 'ask';
  }

  // ---- what agents get ----

  /**
   * The tools of every server an agent working in `root` may use this turn. A repository
   * server nobody has allowed yet is asked about through `ask` (the chat agent's card); an
   * agent with nobody to ask (Swarm, a teammate) leaves it out.
   */
  async toolsFor(root: string, ask?: AskTrust): Promise<Tool[]> {
    const servers = await this.effective(root, ask);
    this.allow((await this.deps.settings()).mcpAlwaysAllow);
    const allowed = this.allowed;
    const env = { PATH: await this.deps.path() };
    const tools: Tool[] = [];
    const keys: string[] = [];
    await Promise.all(
      [...servers].map(async ([name, config]) => {
        const connection = this.hub.connection(name, withEnv(config, env), root);
        keys.push(connection.key);
        try {
          const listed = await connection.listTools();
          this.serverStates.set(name, {
            name,
            status: 'ready',
            error: null,
            tools: listed.map((t) => t.name),
          });
          for (const t of listed) tools.push(toTool(name, config, connection, t, allowed));
        } catch (error) {
          // A server that won't start leaves its tools out; the rest still work.
          this.serverStates.set(name, {
            name,
            status: connection.status,
            error: error instanceof Error ? error.message : String(error),
            tools: [],
          });
        }
      }),
    );
    // Servers no longer in any workspace's list stop (another window's keep running).
    this.keysByRoot.set(root, keys);
    await this.hub.keepOnly([...this.keysByRoot.values()].flat());
    return tools.sort((a, b) => a.spec.name.localeCompare(b.spec.name));
  }

  /** The servers to run in `root`: the person's, then the allowed repository ones over them. */
  private async effective(root: string, ask?: AskTrust): Promise<Map<string, McpServerConfig>> {
    const servers = new Map(Object.entries((await this.personal()).servers));
    for (const s of await this.guarded(root)) {
      if (!s.config) continue;
      let decision = await this.decision(s.key);
      if (decision === 'ask' && ask) {
        const yes = await ask({
          key: s.key,
          name: s.name,
          label: s.label,
          origin: s.origin,
          file: s.file,
          detail: describe(s.raw),
        });
        // "Always" / "never" were saved by the card itself; a plain yes lasts until Kovan quits.
        if (yes) this.onceTrusted.add(s.key);
        decision = await this.decision(s.key);
      }
      if (decision === 'always' || decision === 'once') servers.set(s.name, s.config);
      else {
        servers.delete(s.name);
        this.serverStates.set(s.name, {
          name: s.name,
          status: 'untrusted',
          error: null,
          tools: [],
        });
      }
    }
    return servers;
  }

  allow(names: readonly string[]): void {
    this.allowed.clear();
    for (const n of names) this.allowed.add(n);
  }

  states(): McpServerState[] {
    return [...this.serverStates.values()];
  }

  async stop(): Promise<void> {
    await this.hub.closeAll();
  }

  // ---- Settings ----

  async listing(root: string | null): Promise<McpListing> {
    const { entries, problem } = await this.rawPersonal();
    const secrets = await this.loadSecrets();
    const personal = await this.personal();
    const repo = root ? await this.repoServers(root) : { servers: [], problems: [] };
    const repoNames = new Set(repo.servers.map((s) => s.name));
    const servers: McpServerInfo[] = [];
    const info = (
      name: string,
      raw: RawEntry,
      extra: Pick<McpServerInfo, 'source' | 'file' | 'enabled' | 'trust' | 'trustKey'> & {
        status?: McpServerStatus;
        error?: string | null;
        hidden?: boolean;
      },
    ): McpServerInfo => {
      const state = this.serverStates.get(name);
      const http = isHttp(raw);
      const url = typeof raw.url === 'string' ? raw.url : '';
      return {
        name,
        source: extra.source,
        file: extra.file,
        type: http ? 'http' : 'stdio',
        command: typeof raw.command === 'string' ? raw.command : '',
        args: Array.isArray(raw.args) ? raw.args.filter((a) => typeof a === 'string') : [],
        url,
        envNames: names(
          raw.env,
          extra.source === 'personal' ? secrets.servers[name]?.env : undefined,
        ),
        headerNames: names(
          raw.headers,
          extra.source === 'personal' ? secrets.servers[name]?.headers : undefined,
        ),
        plainValues:
          extra.source === 'personal' &&
          [...Object.values(raw.env ?? {}), ...Object.values(raw.headers ?? {})].some(
            (v) => typeof v === 'string' && v !== '' && !v.includes('${'),
          ),
        enabled: extra.enabled,
        trust: extra.trust,
        trustKey: extra.trustKey,
        status: extra.status ?? state?.status ?? 'idle',
        error: extra.error ?? state?.error ?? null,
        tools: state?.tools ?? [],
        signedIn: http && Boolean(url && secrets.oauth[url]?.tokens),
        hidden: extra.hidden ?? false,
      };
    };
    for (const [name, raw] of Object.entries(entries)) {
      if (!raw || typeof raw !== 'object') continue;
      const enabled = !raw.disabled;
      const broken = personal.problems.find((p) => p.name === name)?.problem ?? null;
      servers.push(
        info(name, raw, {
          source: 'personal',
          file: null,
          enabled,
          trust: null,
          trustKey: null,
          ...(enabled ? {} : { status: 'off' as const, error: null }),
          ...(enabled && broken ? { status: 'failed' as const, error: broken } : {}),
          hidden: repoNames.has(name),
        }),
      );
    }
    for (const s of [...(await this.pluginServers(root)), ...repo.servers]) {
      const trust = await this.decision(s.key);
      const trusted = trust === 'always' || trust === 'once';
      servers.push(
        info(s.name, s.raw, {
          source: s.origin,
          file: s.file,
          enabled: trusted,
          trust,
          trustKey: s.key,
          ...(s.problem ? { status: 'failed' as const, error: s.problem } : {}),
          ...(!s.problem && !trusted ? { status: 'untrusted' as const, error: null } : {}),
        }),
      );
    }
    return {
      servers,
      problems: [
        ...(problem ? [{ source: 'personal' as const, name: '', problem }] : []),
        ...repo.problems.map((p) => ({ source: 'repo' as const, ...p })),
      ],
      root,
      keychain: this.keychain(),
    };
  }

  /** Adds or edits one of the person's servers; values go to the keychain, names to the file. */
  async save(input: McpServerInput): Promise<void> {
    const name = input.name.trim();
    if (!NAME.test(name))
      throw new Error('Use letters, digits, "-" and "_" (at most 40) for the name');
    const { entries } = await this.rawPersonal();
    const previous = input.previousName ?? null;
    if (name !== previous && entries[name])
      throw new Error(`There is already a server named ${name}`);
    const secrets = await this.loadSecrets();
    const old = previous ? secrets.servers[previous] : undefined;
    const pairs = (list: McpServerInput['env'], kept: Record<string, string> | undefined) => {
      const out: Record<string, string> = {};
      for (const { name: key, value } of list) {
        const k = key.trim();
        if (!k) continue;
        const v = value ?? kept?.[k] ?? (previous ? entries[previous]?.env?.[k] : undefined) ?? '';
        out[k] = v;
      }
      return out;
    };
    const env = input.type === 'stdio' ? pairs(input.env, old?.env) : {};
    const headers = input.type === 'http' ? pairs(input.headers, old?.headers) : {};
    if (
      !this.keychain() &&
      [...Object.values(env), ...Object.values(headers)].some((v) => v && !v.includes('${'))
    )
      throw new Error(
        "This system has no keychain Kovan can use, so it can't keep these values safe",
      );
    const entry: RawEntry =
      input.type === 'stdio'
        ? {
            command: input.command.trim(),
            args: input.args,
            // The values are in the keychain; the names stay here so the file still reads.
            env: Object.fromEntries(
              Object.entries(env).map(([k, v]) => [k, v.includes('${') ? v : '']),
            ),
          }
        : {
            type: 'http',
            url: input.url.trim(),
            headers: Object.fromEntries(
              Object.entries(headers).map(([k, v]) => [k, v.includes('${') ? v : '']),
            ),
          };
    // What it says must parse as a server, or nothing is saved.
    const check = parseMcpConfig(
      { mcpServers: { [name]: { ...entry, env, headers } } },
      process.env,
    );
    const problem = check.problems[0]?.problem;
    if (problem) throw new Error(problem);
    if (previous && entries[previous]?.disabled) entry.disabled = true;
    const next: Record<string, RawEntry> = {};
    for (const [k, v] of Object.entries(entries))
      next[k === previous ? name : k] = k === previous ? entry : v;
    if (!previous) next[name] = entry;
    if (previous && previous !== name) delete secrets.servers[previous];
    const kept = (m: Record<string, string>) =>
      Object.fromEntries(Object.entries(m).filter(([, v]) => v && !v.includes('${')));
    secrets.servers[name] = {
      ...(Object.keys(kept(env)).length ? { env: kept(env) } : {}),
      ...(Object.keys(kept(headers)).length ? { headers: kept(headers) } : {}),
    };
    if (!secrets.servers[name].env && !secrets.servers[name].headers) delete secrets.servers[name];
    if (this.keychain()) await this.saveSecrets(secrets);
    await this.writePersonal(next);
    if (previous) await this.hub.reset(previous);
    await this.hub.reset(name);
    this.serverStates.delete(name);
  }

  async remove(name: string): Promise<void> {
    const { entries } = await this.rawPersonal();
    const entry = entries[name];
    if (!entry) return;
    delete entries[name];
    await this.writePersonal(entries);
    const secrets = await this.loadSecrets();
    delete secrets.servers[name];
    // Its sign-in goes too, unless another of the person's servers is the same URL.
    if (entry.url && !Object.values(entries).some((e) => e.url === entry.url))
      delete secrets.oauth[entry.url];
    if (this.keychain()) await this.saveSecrets(secrets);
    await this.hub.reset(name);
    this.serverStates.delete(name);
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const { entries } = await this.rawPersonal();
    const entry = entries[name];
    if (!entry) return;
    if (enabled) delete entry.disabled;
    else entry.disabled = true;
    await this.writePersonal(entries);
    if (!enabled) {
      await this.hub.reset(name);
      this.serverStates.delete(name);
    }
  }

  /** Starts the form's server on its own (nothing saved) and lists its tools. */
  async test(input: McpServerInput, root: string | null): Promise<McpCheck> {
    const { entries } = await this.rawPersonal();
    const secrets = await this.loadSecrets();
    const old = input.previousName ? secrets.servers[input.previousName] : undefined;
    const fill = (list: McpServerInput['env'], kept?: Record<string, string>) =>
      Object.fromEntries(
        list
          .filter((p) => p.name.trim())
          .map((p) => [
            p.name.trim(),
            p.value ??
              kept?.[p.name.trim()] ??
              (input.previousName
                ? entries[input.previousName]?.env?.[p.name.trim()]
                : undefined) ??
              '',
          ]),
      );
    const raw =
      input.type === 'stdio'
        ? { command: input.command, args: input.args, env: fill(input.env, old?.env) }
        : { type: 'http', url: input.url, headers: fill(input.headers, old?.headers) };
    const name = NAME.test(input.name.trim()) ? input.name.trim() : 'server';
    const parsed = parseMcpConfig({ mcpServers: { [name]: raw } }, process.env);
    const config = parsed.servers[name];
    if (!config)
      return {
        ok: false,
        tools: [],
        error: parsed.problems[0]?.problem ?? 'Not a server',
        needsSignIn: false,
      };
    const connection = new McpConnection(name, withEnv(config, { PATH: await this.deps.path() }), {
      cwd: root ?? this.deps.userData,
      client: { name: 'kovan', version: this.deps.version },
      oauth: this.oauth,
    });
    try {
      const tools = await connection.listTools();
      return { ok: true, tools: tools.map((t) => t.name), error: null, needsSignIn: false };
    } catch (error) {
      return {
        ok: false,
        tools: [],
        error: error instanceof Error ? error.message : String(error),
        needsSignIn: connection.status === 'needs-auth',
      };
    } finally {
      await connection.close();
    }
  }

  /** Starts a saved server again (a failed one gets a fresh try) and lists its tools. */
  async check(name: string, root: string | null): Promise<McpCheck> {
    await this.hub.reset(name);
    this.serverStates.delete(name);
    await this.toolsFor(root ?? this.deps.userData);
    const state = this.serverStates.get(name);
    if (!state)
      return {
        ok: false,
        tools: [],
        error: `${name} isn't on (or isn't allowed)`,
        needsSignIn: false,
      };
    return {
      ok: state.status === 'ready',
      tools: state.tools,
      error: state.error,
      needsSignIn: state.status === 'needs-auth',
    };
  }

  private async configOf(name: string, root: string | null): Promise<McpServerConfig | null> {
    const guarded = (await this.guarded(root)).find((s) => s.name === name);
    if (guarded) return guarded.config;
    return (await this.personal()).servers[name] ?? null;
  }

  /** Signs in to a remote server in the browser, then starts it. */
  async signIn(
    name: string,
    root: string | null,
    open: (url: URL) => void | Promise<void>,
  ): Promise<McpCheck> {
    const config = await this.configOf(name, root);
    if (config?.type !== 'http') throw new Error(`${name} isn't a remote server`);
    await signIn(config.url, this.oauth, { open, clientName: 'Kovan' });
    return this.check(name, root);
  }

  async signOut(name: string, root: string | null): Promise<void> {
    const config = await this.configOf(name, root);
    if (config?.type !== 'http') return;
    await this.oauth.set(config.url, undefined);
    await this.hub.reset(name);
    this.serverStates.delete(name);
  }

  /** Saves (or forgets) a repository server's trust decision. */
  async trust(key: string, decision: 'always' | 'deny' | null, root: string | null): Promise<void> {
    const records = await this.loadTrust();
    if (decision === null) {
      delete records[key];
      this.onceTrusted.delete(key);
    } else {
      const s = (await this.guarded(root)).find((r) => r.key === key);
      records[key] = {
        decision,
        server: s?.name ?? '',
        repo: s?.origin === 'plugin' ? '' : root ? await this.repoId(root) : '',
        file: s?.file ?? '',
        at: new Date().toISOString(),
      };
      if (decision === 'deny') this.onceTrusted.delete(key);
    }
    await writeJson(this.trustFile, records);
    if (decision !== 'always') {
      const s = (await this.guarded(root)).find((r) => r.key === key);
      if (s) {
        await this.hub.reset(s.name);
        this.serverStates.delete(s.name);
      }
    }
  }
}

function isHttp(raw: RawEntry): boolean {
  return typeof raw.type === 'string' ? raw.type !== 'stdio' : Boolean(raw.url);
}

function names(inFile: unknown, inKeychain: Record<string, string> | undefined): string[] {
  const out = new Set<string>();
  if (inFile && typeof inFile === 'object') for (const k of Object.keys(inFile)) out.add(k);
  for (const k of Object.keys(inKeychain ?? {})) out.add(k);
  return [...out];
}

/** The card's text: what runs (or is reached), as the file writes it. */
function describe(raw: RawEntry): string {
  if (isHttp(raw)) {
    const headers = Object.keys(raw.headers ?? {});
    return [
      `Connects to ${raw.url ?? ''}`,
      ...(headers.length ? [`Headers: ${headers.join(', ')}`] : []),
    ].join('\n');
  }
  const command = [raw.command ?? '', ...(raw.args ?? [])].map(quote).join(' ');
  const env = Object.entries(raw.env ?? {}).map(([k, v]) => `${k}=${v}`);
  return [`Runs ${command}`, ...(env.length ? [`With ${env.join(' ')}`] : [])].join('\n');
}

function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The PATH an agent CLI would see, under the server's own env. */
function withEnv(config: McpServerConfig, env: Record<string, string>): McpServerConfig {
  return config.type === 'stdio' ? { ...config, env: { ...env, ...config.env } } : config;
}

function toTool(
  server: string,
  config: McpServerConfig,
  connection: McpConnection,
  tool: McpTool,
  allowed: Set<string>,
): Tool {
  const name = mcpToolName(server, tool.name);
  const secrets = secretValues(config);
  const label = tool.title ?? tool.name;
  return {
    kind: 'external',
    spec: {
      name,
      description: `${tool.description || label} (from the "${server}" MCP server)`.slice(0, 1024),
      parameters:
        tool.inputSchema['type'] === 'object'
          ? tool.inputSchema
          : { type: 'object', properties: {} },
    },
    readOnly: tool.readOnly,
    origin: `${server} · ${tool.name}`,
    describe: () => `Used ${server} · ${label}`,
    display: (args) => maskSecrets(args, secrets),
    allowed: () => allowed.has(name),
    async run(args, ctx) {
      const result = await connection.callTool(tool.name, args, { signal: ctx.signal });
      // What comes back goes to the model, the transcript and the team: no secrets in it.
      return { ok: !result.isError, output: maskSecrets(result.text, secrets) };
    },
  };
}
