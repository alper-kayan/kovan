import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  Agent,
  buildSystemPrompt,
  discoverSkills,
  parseSkillCommand,
  type AgentEvent,
  type ApprovalRequest,
  type ModelStreamer,
  type PermissionMode,
} from '@kovan/harness';
import {
  estimateCost,
  OpenRouterClient,
  type ChatMessage,
  type ModelInfo,
} from '@kovan/model-gateway';
import { EFFORTS, MODES, parseArgs, type Args } from './args.js';
import {
  DEFAULT_SERVER,
  LoginError,
  login,
  logout,
  managedProvider,
  whoami,
  type Auth,
  type AuthStore,
} from './auth.js';
import { expandCommand, findCommand, skillPlaces, userNotes } from './extras.js';
import { CONFIG_FILE, loadProvider, type Provider, type ProviderResult } from './config.js';
import { NOOP_NOTCH, createNotch, notchEventsFor, hookTool, type Notch } from './notch.js';
import { cliDir, desktopDataDir } from './paths.js';
import {
  claudeAccounts,
  claudeEnv,
  ClaudeRunner,
  findBinary,
  findClaude,
  type ClaudeAccount,
} from './claude.js';
import { desktopProviders, providerKey } from './desktopKeys.js';
import { CodexRunner, codexEnv } from './codex.js';
import { claudeCatalog, codexCatalog, type EngineModel } from './catalogs.js';
import { Renderer } from './render.js';
import { TuiApp, type ModelGroup, type TuiHost, type TuiIO } from './tui/app.js';
import type { TranscriptEvent } from './tui/transcript.js';
import { digestOf, keepEvent, type ConversationStore, type StoredConversation } from './store.js';
import { bundlePath, checkAndUpdate, type UpdateResult } from './update.js';

export const VERSION = '0.4.5';

export const USAGE = `kovan ${VERSION}: Kovan's coding agent in the terminal.

  kovan                       chat with the agent in this folder
  kovan "fix the tests"       one message: it does the work and exits
  kovan -c                    continue the last chat in this folder
  kovan -r <name|id>          continue a chat by its name or id, in its own folder
  kovan login [--server <url>]  sign in to a Kovan account (confirmed in the browser)
  kovan logout | whoami       sign out | who you are signed in as
  kovan update                update itself
  kovan sessions [--json]     chats (the same list as in the Kovan desktop app)
  kovan sessions export <id>  a summary of one chat (JSON)
  kovan config                which server and model it talks to

  -m, --model <id>            model
  --mode <plan|request|allow|full>
                              plan: only read · request: ask before every edit and command · allow: edit, ask before commands (default) · full: never ask
  --effort <level>            none, minimal, low, medium, high, xhigh, max
  --context-file <file>       extra instructions added to the system prompt
  --reasoning                 show the model's thinking
  --cwd <folder>              work in another folder

Model: your own key comes first (OPENROUTER_API_KEY, or KOVAN_BASE_URL + KOVAN_MODEL [+ KOVAN_API_KEY]); without one, your Kovan account
from 'kovan login' (managed usage, billed to your account) if the server offers it. Chats also show in the Kovan desktop app's chat list.
Reads what Claude Code reads: skills in the repository and in ~/.claude (/skill-name), CLAUDE.md / AGENTS.md / KOVAN.md, ~/.claude/CLAUDE.md,
.claude/commands/*.md (custom commands). KOVAN_NO_CLAUDE=1 turns all of it off.
In a chat: /help /mode /model /models /clear /cost /context /skills /exit
`;

/** What `kovan` needs from the terminal. Real in index.ts, scripted in tests. */
export interface Terminal {
  readonly isTTY: boolean;
  write(s: string): void;
  /** `null` when the input has ended. */
  readLine(prompt: string, signal?: AbortSignal): Promise<string | null>;
  onInterrupt(handler: () => void): void;
  close(): void;
}

export interface Deps {
  env: Record<string, string | undefined>;
  cwd: string;
  terminal: Terminal;
  store: ConversationStore;
  auth: AuthStore;
  err: (s: string) => void;
  configFile?: string;
  /** A scripted model, for tests. Otherwise the provider from the environment. */
  model?: ModelStreamer;
  catalog?: ModelInfo[];
  fetchImpl?: typeof fetch;
  open?: (url: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** The file that is running, to know whether it is a bundle that may replace itself. */
  argv1?: string | undefined;
  /** Look for a newer version in the background (off in tests that are not about it). */
  checkUpdates?: boolean;
  /** The release key's public half for updates; the one built into the bundle unless a test says otherwise. */
  updateKey?: string;
  /** Where the "when did I last look" stamp goes. */
  stateDir?: string;
  /** Your home folder (where `.claude` lives); the real one unless a test says otherwise. */
  home?: string;
  /** Coucou's notch; a stand-in in tests. Otherwise the real socket, when there is one. */
  notch?: Notch;
  /** The full-screen terminal, when there is one to draw on. Without it (tests, pipes) the plain prompt is used. */
  screen?: () => TuiIO;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The top of the repository this folder is in, or the folder itself: the app's "workspace" is the same folder. */
export function workspaceRoot(dir: string): { root: string; isRepo: boolean } {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return { root: d, isRepo: true };
    if (dirname(d) === d) return { root: dir, isRepo: false };
  }
}

/**
 * The person's own key or gateway comes first. Kovan's managed usage (billed to the account) is used only when nothing of their
 * own is set up and they are signed in, or when they ask for it with KOVAN_PROVIDER=managed. KOVAN_PROVIDER=own never falls back to it.
 */
export function resolveProvider(
  env: Record<string, string | undefined>,
  file: string | undefined,
  auth: Auth | null,
  model: string | null,
): ProviderResult {
  const managed = () =>
    ({ ok: true, provider: managedProvider(auth!, model ?? env['KOVAN_MODEL'] ?? null) }) as const;
  if (auth && env['KOVAN_PROVIDER'] === 'managed') return managed();
  const own = loadProvider(env, file);
  if (own.ok || !auth || env['KOVAN_PROVIDER'] === 'own') return own;
  // A gateway missing its model is theirs to fix, not a reason to bill the account.
  return own.noKey ? managed() : own;
}

export async function main(argv: readonly string[], deps: Deps): Promise<number> {
  const args = parseArgs(argv);
  const t = deps.terminal;
  const out = (s: string) => t.write(`${s}\n`);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const server = (
    args.server ??
    deps.env['KOVAN_SERVER'] ??
    deps.auth.load()?.server ??
    DEFAULT_SERVER
  ).replace(/\/$/, '');

  if (args.error) {
    deps.err(args.error);
    return 2;
  }
  switch (args.command) {
    case 'help':
      out(USAGE);
      return 0;
    case 'version':
      out(VERSION);
      return 0;
    case 'login': {
      try {
        const a = await login({
          server,
          machineId: deps.auth.machineId(),
          fetchImpl,
          open: deps.open ?? (() => {}),
          out,
          sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
        });
        deps.auth.save(a);
        out(`Signed in: ${a.user?.name ?? '—'} (${a.server})`);
        return 0;
      } catch (e) {
        deps.err(e instanceof LoginError ? e.message : String(e));
        return 1;
      }
    }
    case 'logout': {
      const a = deps.auth.load();
      if (!a) {
        out("You weren't signed in.");
        return 0;
      }
      await logout(a, fetchImpl);
      deps.auth.clear();
      out('Signed out.');
      return 0;
    }
    case 'whoami': {
      const a = deps.auth.load();
      if (!a) {
        out("You're not signed in. Sign in with 'kovan login'.");
        return 1;
      }
      try {
        const u = await whoami(a, fetchImpl);
        out(`${u.name}${u.email ? ` <${u.email}>` : ''} · ${a.server}`);
        return 0;
      } catch (e) {
        deps.err(e instanceof LoginError ? e.message : String(e));
        return 1;
      }
    }
    case 'update': {
      const r = await updateNow(deps, server, true);
      out(describeUpdate(r) ?? 'Up to date.');
      return r.status === 'failed' ? 1 : 0;
    }
    case 'config': {
      const auth = deps.auth.load();
      const p = resolveProvider(deps.env, deps.configFile, auth, null);
      const who = auth
        ? `signed in: ${auth.user?.name ?? 'yes'} (${auth.server})`
        : 'signed in: no';
      if (!p.ok) {
        out(`server: none\n${who}\n${p.why}`);
        return 1;
      }
      out(
        `server: ${p.provider.label}\nmodel:  ${p.provider.model}\nkey:    ${p.provider.apiKey ? 'set' : 'none (may not be needed)'}\n${who}\nfile:   ${deps.configFile ?? CONFIG_FILE}`,
      );
      return 0;
    }
    case 'sessions': {
      if (args.sessionId) {
        const c = deps.store.loadById(args.sessionId);
        if (!c) {
          deps.err(`No chat with id ${args.sessionId}`);
          return 1;
        }
        out(JSON.stringify(digestOf(c)));
        return 0;
      }
      const list = deps.store.list();
      if (args.json)
        out(
          JSON.stringify(
            list.map((c) => ({
              id: c.id,
              title: c.title,
              cwd: c.root,
              updatedAt: new Date(c.updatedAt).toISOString(),
              cost: c.cost,
              harness: c.harness,
            })),
          ),
        );
      else if (list.length === 0) out('No chats yet.');
      else
        for (const c of list)
          out(
            `${c.id}  ${new Date(c.updatedAt).toISOString().slice(0, 16).replace('T', ' ')}  ${basename(c.root).padEnd(18)} ${clip(c.title, 60)}`,
          );
      return 0;
    }
    default:
      return chat(args, deps, server);
  }
}

function describeUpdate(r: UpdateResult): string | null {
  switch (r.status) {
    case 'updated':
      return `kovan updated: ${r.from} → ${r.to} (takes effect next time you start it).`;
    case 'available':
      return `A new version is out: ${r.version}. This copy runs from a checkout; in the repository run: pnpm --filter @kovan/cli bundle --install`;
    case 'failed':
      return r.why ? `Couldn't update: ${r.why}` : null;
    default:
      return null;
  }
}

function updateNow(deps: Deps, server: string, force: boolean): Promise<UpdateResult> {
  return checkAndUpdate({
    server,
    current: VERSION,
    fetchImpl: deps.fetchImpl ?? fetch,
    target: bundlePath(deps.argv1),
    stampFile: join(deps.stateDir ?? cliDir(), 'update-check.json'),
    force,
    env: deps.env,
    ...(deps.updateKey !== undefined ? { publicKey: deps.updateKey } : {}),
  });
}

async function chat(args: Args, deps: Deps, server: string): Promise<number> {
  const t = deps.terminal;
  const out = (s: string) => t.write(`${s}\n`);
  // `kovan -r <name|id>`: that conversation, and the folder it was held in, wherever you are now.
  let found: { id: string; root: string } | null = null;
  if (args.resume) {
    const here = workspaceRoot(resolve(args.cwd ?? deps.cwd)).root;
    const { match, candidates } = deps.store.find(args.resume, here);
    if (!match) {
      deps.err(
        candidates.length
          ? `Several chats fit "${args.resume}"; give more of the name, or the id:\n${candidates
              .slice(0, 10)
              .map((c) => `  ${c.id.slice(0, 8)}  ${clip(c.title, 50).padEnd(50)}  ${c.root}`)
              .join('\n')}`
          : `No chat called "${args.resume}". 'kovan sessions' lists them all.`,
      );
      return 1;
    }
    if (!existsSync(match.root)) {
      deps.err(`That chat's folder isn't here any more: ${match.root}`);
      return 1;
    }
    found = { id: match.id, root: match.root };
  }
  const { root, isRepo } = workspaceRoot(found?.root ?? resolve(args.cwd ?? deps.cwd));
  let auth = deps.auth.load();

  // Looking for a newer version never holds the prompt up: it runs beside it and speaks at the end.
  const update: Promise<UpdateResult> | null =
    deps.checkUpdates && t.isTTY
      ? updateNow(deps, server, false).catch((): UpdateResult => ({ status: 'failed', why: '' }))
      : null;
  // The notch is made once the conversation exists; until then there is nothing to tell it.
  let notch: Notch = NOOP_NOTCH;
  let notchOpen = false;
  const finish = async (code: number): Promise<number> => {
    if (notchOpen) {
      notchOpen = false;
      notch.event('SessionEnd');
      await notch.flush();
    }
    const note = update ? describeUpdate(await update) : null;
    if (note) out(note);
    return code;
  };

  // Nothing of their own set up and no account: signing in comes first, in the same window, and the chat opens right after.
  const interactive = Boolean(deps.screen && t.isTTY && !args.plain && deps.env['TERM'] !== 'dumb');
  const own = loadProvider(deps.env, deps.configFile);
  if (
    !deps.model &&
    !auth &&
    !own.ok &&
    own.noKey &&
    deps.env['KOVAN_PROVIDER'] !== 'own' &&
    !args.task
  ) {
    if (!interactive) {
      deps.err("You're not signed in. Sign in to your Kovan account with 'kovan login'.");
      return 1;
    }
    out('Sign in to Kovan first. Once you confirm in the browser, the terminal opens.');
    try {
      auth = await login({
        server,
        machineId: deps.auth.machineId(),
        fetchImpl: deps.fetchImpl ?? fetch,
        open: deps.open ?? (() => {}),
        out,
        sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      });
      deps.auth.save(auth);
      out(`Signed in: ${auth.user?.name ?? '—'}`);
    } catch (e) {
      deps.err(e instanceof LoginError ? e.message : String(e));
      return 1;
    }
  }

  let provider: Provider;
  if (deps.model) {
    provider = {
      baseUrl: 'test',
      apiKey: '',
      model: args.model ?? 'test/model',
      dialect: 'openai',
      label: 'test',
      managed: false,
    };
  } else {
    const p = resolveProvider(deps.env, deps.configFile, auth, args.model);
    if (!p.ok) {
      deps.err(p.why);
      return 1;
    }
    provider = args.model ? { ...p.provider, model: args.model } : p.provider;
  }

  let contextText = '';
  if (args.contextFile) {
    try {
      contextText = readFileSync(args.contextFile, 'utf8').trim();
    } catch {
      deps.err(`Couldn't read the context file ${args.contextFile}; continuing without it.`);
    }
  }
  const ex = { env: deps.env, home: deps.home ?? homedir() };
  const base = await buildSystemPrompt({ root, name: basename(root), isRepo });
  const notes = await userNotes(ex);
  const system = [
    base,
    notes,
    contextText
      ? `Additional instructions from the tool that started this session:\n\n${contextText}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  let conv: StoredConversation | null = null;
  let resumed = false;
  if (found) {
    conv = deps.store.load(found.root, found.id);
    resumed = conv !== null;
  } else if (args.continueLast) {
    const latest = deps.store.latestFor(root);
    const saved = latest ? deps.store.load(root, latest.id) : null;
    if (saved) {
      conv = saved;
      resumed = true;
    } else deps.err('No chat to continue in this folder; starting a new one.');
  }
  let mode: PermissionMode = args.mode ?? (resumed ? conv!.mode : 'allow');
  let effort = args.effort;
  conv ??= deps.store.create(root, { model: provider.model, effort, mode });
  // The system prompt is rebuilt each time (a changed KOVAN.md applies); what was said before it is kept.
  const history: ChatMessage[] = resumed
    ? [{ role: 'system', content: system }, ...conv.messages.filter((m) => m.role !== 'system')]
    : [];

  let streamer: ModelStreamer;
  let catalog: ModelInfo[] = deps.catalog ?? [];
  let client: OpenRouterClient | null = null;
  if (deps.model) streamer = deps.model;
  else {
    client = new OpenRouterClient({
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      dialect: provider.dialect,
      appName: 'kovan',
      appUrl: 'https://kovan.alperkayan.dev',
      // Managed usage is filed under the run it belongs to (the same headers the desktop sends).
      ...(provider.managed
        ? {
            headers: {
              'X-Kovan-Run': conv.id,
              'X-Kovan-Run-Label': encodeURIComponent('Kovan terminal'),
            },
          }
        : {}),
    });
    streamer = client;
    // The catalogue prices a turn and gives the context window; the prompt does not wait for it.
    void client
      .listModels(AbortSignal.timeout(8000))
      .then((c) => (catalog = c))
      .catch(() => {});
  }

  const baseStreamer = streamer;
  const renderer = new Renderer((s) => t.write(s), {
    color: t.isTTY && !deps.env['NO_COLOR'],
    reasoning: args.reasoning,
  });
  const always = new Set<string>();
  let lastReason: string | null = null;

  // What the notch is told when something needs your say: the same tool name and input Claude Code's hook sends.
  const askNotch = (r: ApprovalRequest, signal?: AbortSignal) => {
    const input = hookTool(
      r.tool,
      r.path ? { path: r.path, command: r.detail } : { command: r.detail },
    );
    return notch.permission(
      {
        tool_name: input.tool_name,
        tool_input:
          r.kind === 'command'
            ? { command: r.detail }
            : { ...input.tool_input, description: r.detail },
      },
      signal,
    );
  };

  let tui: TuiApp | null = null;
  const approve = async (r: ApprovalRequest): Promise<boolean> => {
    if (always.has(r.tool)) return true;
    if (tui) {
      // On the full-screen interface the question is a dialog; the notch can still answer first.
      const ac = new AbortController();
      const fromNotch = askNotch(r, ac.signal).then((d) =>
        d === 'allow' || d === 'always' || d === 'deny'
          ? ({ from: 'notch', a: d } as const)
          : new Promise<never>(() => {}),
      );
      const fromScreen = tui.ui
        .approve(r, ac.signal)
        .then((a) => ({ from: 'screen', a: a ?? 'deny' }) as const);
      const first = await Promise.race([fromNotch, fromScreen]);
      ac.abort();
      if (first.a === 'always') always.add(r.tool);
      return first.a !== 'deny';
    }
    if (!t.isTTY) {
      // Nobody at the terminal: the notch can still be asked (your phone and lock screen too).
      const d = await askNotch(r);
      if (d === 'allow' || d === 'always') {
        if (d === 'always') always.add(r.tool);
        out(`  notch: approved (${r.title})`);
        return true;
      }
      out(
        d === 'deny'
          ? `  notch: denied (${r.title})`
          : `Permission needed, but there is nobody to ask: ${r.title} (${clip(r.detail, 120)}). Run with --mode full.`,
      );
      return false;
    }
    out(`\n? ${r.title}\n  ${clip(r.detail, 400)}`);
    // The terminal and the notch ask at once; the first real answer wins and the other question is withdrawn.
    // A notch that is absent, silent or says "ask" never decides: only the terminal does then.
    const ac = new AbortController();
    const fromNotch = askNotch(r, ac.signal).then((d) =>
      d === 'allow' || d === 'always' || d === 'deny'
        ? ({ from: 'notch', d } as const)
        : new Promise<never>(() => {}),
    );
    const fromTerminal = t
      .readLine('  allow? [y]es / [n]o / [a]lways (this session) › ', ac.signal)
      .then((a) => ({ from: 'terminal', a: a?.trim().toLowerCase() ?? '' }) as const);
    const first = await Promise.race([fromNotch, fromTerminal]);
    ac.abort();
    if (first.from === 'notch') {
      out(first.d === 'deny' ? '  notch: denied' : '  notch: approved');
      if (first.d === 'always') always.add(r.tool);
      return first.d !== 'deny';
    }
    if (first.a === 'a' || first.a === 'always') {
      always.add(r.tool);
      return true;
    }
    return first.a === 'y' || first.a === 'yes';
  };

  const toolNames = new Map<string, string>();
  const lastText = { value: '' };
  const onEvent = (e: AgentEvent) => {
    if (e.type === 'turn_end') {
      lastReason = e.reason;
      conv!.cost += e.cost;
    }
    if (keepEvent(e)) conv!.events.push(e);
    if (tui) tui.ui.event(e as TranscriptEvent);
    else renderer.event(e);
    for (const n of notchEventsFor(e, toolNames, lastText)) notch.event(n.name, n.fields);
  };
  const agent = new Agent(
    {
      model: streamer,
      modelId: provider.model,
      effort,
      mode,
      root,
      isRepo,
      systemPrompt: system,
      approve,
      contextWindow: (m) => catalog.find((c) => c.id === m)?.contextLength || null,
      price: (m, usage) => {
        const info = catalog.find((c) => c.id === m);
        return info ? estimateCost(info, usage) : null;
      },
      skills: () => discoverSkills(skillPlaces(root, ex)),
      onEvent: (e) => onEvent(e),
    },
    history,
  );

  // Claude Code as an engine: the accounts the desktop app already has, nothing to set up.
  const dataDir = desktopDataDir(deps.env, process.platform, ex.home);
  const claudeBin = deps.model ? null : findClaude(deps.env, ex.home);
  const claudeRunner = new ClaudeRunner();
  const codexBin = deps.model ? null : findBinary('codex', deps.env, ex.home);
  const codexRunner = new CodexRunner();
  let codex: { account: ClaudeAccount; model: string } | null = null;
  let codexThread: string | null = null;
  let claude: { account: ClaudeAccount; model: string } | null = null;
  let claudeSession: string | null = null;
  {
    // `-m claude:<account>:<model>` starts on Claude Code (an empty account is the CLI's own sign-in).
    const m = /^claude:([^:]*):(.+)$/.exec(args.model ?? '');
    const account = m ? claudeAccounts(dataDir).find((x) => (x.id ?? '') === m[1]) : undefined;
    if (m && account && claudeBin) claude = { account, model: m[2]! };
    const cm = /^codex:([^:]*):(.+)$/.exec(args.model ?? '');
    const cAccount = cm
      ? claudeAccounts(dataDir, 'codex').find((x) => (x.id ?? '') === cm[1])
      : undefined;
    if (cm && cAccount && codexBin) codex = { account: cAccount, model: cm[2]! };
  }
  // The models each CLI offers, as the CLI itself lists them (its own cache), per account.
  const claudeModelsOf = (id: string | null): EngineModel[] => {
    const own = id
      ? claudeCatalog(join(dataDir, 'agent-accounts', id))
      : claudeCatalog(deps.env['CLAUDE_CONFIG_DIR'] ?? join(ex.home, '.claude'));
    return own.length ? own : claudeCatalog(join(ex.home, '.claude'));
  };
  const codexModelsOf = (id: string | null): EngineModel[] => {
    const own = id
      ? codexCatalog(join(dataDir, 'agent-accounts', id))
      : codexCatalog(deps.env['CODEX_HOME'] ?? join(ex.home, '.codex'));
    return own.length ? own : codexCatalog(join(ex.home, '.codex'));
  };
  const nameOf = (list: EngineModel[], model: string) =>
    model === 'default' ? '' : (list.find((m) => m.id === model)?.name ?? model);
  const claudeLabel = (c: { account: ClaudeAccount; model: string }) => {
    const n = nameOf(claudeModelsOf(c.account.id), c.model);
    return `Claude Code · ${c.account.name}${n ? ` · ${n}` : ''}`;
  };
  /** The effort levels the chosen model takes, from the CLI's own list; the default model is the list's first. */
  const engineEfforts = (list: EngineModel[], model: string, fallback: string[]) => {
    const m = model === 'default' ? list[0] : list.find((x) => x.id === model);
    const levels = m?.levels ?? fallback;
    return { levels, default: m?.defaultLevel ?? 'medium' };
  };

  /** `/rename`: what the chat is called, here and in the desktop app's list; the first message no longer names it. */
  const rename = (name: string): string => {
    conv!.title = clip(name.replace(/\s+/g, ' ').trim(), 80);
    try {
      deps.store.save(conv!);
      return `Named: ${conv!.title}`;
    } catch (e) {
      return `Couldn't save the name: ${e instanceof Error ? e.message : String(e)}`;
    }
  };

  const turn = async (text: string) => {
    lastReason = null;
    conv!.events.push({ type: 'user', text, attachments: [], at: Date.now() });
    notch.event('UserPromptSubmit', { prompt: text });
    if (codex && codexBin) {
      codexThread = await codexRunner.send(text, {
        binary: codexBin,
        root,
        model: codex.model,
        mode,
        threadId: codexThread,
        effort,
        env: codexEnv(dataDir, codex.account.id),
        baseEnv: deps.env,
        onEvent,
      });
    } else if (claude && claudeBin) {
      claudeSession = await claudeRunner.send(text, {
        binary: claudeBin,
        root,
        model: claude.model,
        mode,
        effort,
        sessionId: claudeSession,
        env: claudeEnv(dataDir, claude.account.id),
        baseEnv: deps.env,
        onEvent,
      });
    } else await agent.send(text);
    conv!.messages = [...agent.messages];
    conv!.updatedAt = Date.now();
    conv!.model = provider.model;
    conv!.mode = mode;
    if (conv!.title === 'New chat')
      conv!.title = clip(text.replace(/\s+/g, ' ').trim(), 80) || 'New chat';
    try {
      deps.store.save(conv!);
    } catch (e) {
      deps.err(`Couldn't save the chat: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  notch =
    deps.notch ??
    createNotch({
      env: deps.env,
      home: ex.home,
      sessionId: () => conv!.id,
      cwd: root,
      title: () => conv!.title,
    });
  notchOpen = true;
  notch.event('SessionStart');

  let leaving = false;
  t.onInterrupt(() => {
    if (agent.running) agent.stop();
    else {
      leaving = true;
      t.close();
    }
  });

  /** What a typed line becomes: a custom command's text, or itself (a skill is recognised by the agent). Null: not a command at all. */
  const slash = async (line: string): Promise<{ send: string } | null> => {
    const m = /^\/([A-Za-z0-9][A-Za-z0-9:_-]*)(?:\s+([\s\S]*))?$/.exec(line);
    if (!m) return null;
    const name = m[1]!;
    const skills = (await discoverSkills(skillPlaces(root, ex)).catch(() => null))?.skills ?? [];
    if (parseSkillCommand(`/${name}`, skills)) return { send: line };
    const cmd = await findCommand(name, root, ex);
    return cmd ? { send: expandCommand(cmd.body, (m[2] ?? '').trim()) } : null;
  };

  // One message: do it and go.
  if (args.task) {
    const s = args.task.startsWith('/') ? await slash(args.task) : null;
    await turn(s ? s.send : args.task);
    return finish(lastReason === 'done' ? 0 : 1);
  }

  if (deps.screen && t.isTTY && !args.plain && deps.env['TERM'] !== 'dumb') {
    const host: TuiHost = {
      header: () => ({
        model: codex
          ? `Codex · ${codex.account.name}${nameOf(codexModelsOf(codex.account.id), codex.model) ? ` · ${nameOf(codexModelsOf(codex.account.id), codex.model)}` : ''}`
          : claude
            ? claudeLabel(claude)
            : provider.model,
        provider: codex
          ? 'ChatGPT account (from the Kovan desktop app)'
          : claude
            ? 'Claude account (from the Kovan desktop app)'
            : provider.label,
        folder: root.replace(ex.home, '~'),
        managed: provider.managed,
      }),
      mode: () => mode,
      effort: () => effort ?? 'default',
      setEffort: (e) => {
        effort = e as typeof effort;
        agent.configure({ effort });
      },
      efforts: () =>
        codex
          ? engineEfforts(codexModelsOf(codex.account.id), codex.model, [
              'minimal',
              'low',
              'medium',
              'high',
            ])
          : claude
            ? engineEfforts(claudeModelsOf(claude.account.id), claude.model, [
                'low',
                'medium',
                'high',
                'xhigh',
                'max',
              ])
            : { levels: [...EFFORTS], default: 'medium' },
      setMode: (m) => {
        mode = m;
        agent.configure({ mode });
      },
      setModel: async (id) => {
        const custom = /^@([a-z0-9-]+)\/(.+)$/.exec(id);
        if (custom) {
          // A provider you added in the desktop app: its key comes from the keychain, once, and stays in memory.
          const p = desktopProviders(dataDir).find((x) => x.id === custom[1]);
          if (!p) return "Couldn't find that provider in the desktop app";
          try {
            const key = await providerKey(dataDir, p.id);
            agent.configure({
              model: new OpenRouterClient({ apiKey: key, baseUrl: p.baseUrl, dialect: 'openai' }),
              modelId: custom[2]!,
            });
          } catch (e) {
            return e instanceof Error ? e.message : String(e);
          }
          provider = { ...provider, model: custom[2]!, label: p.name, managed: false };
          claude = null;
          codex = null;
          conv!.model = id;
          return;
        }
        agent.configure({ model: baseStreamer });
        const cx = /^codex:([^:]*):(.+)$/.exec(id);
        if (cx) {
          const account = claudeAccounts(dataDir, 'codex').find((a) => (a.id ?? '') === cx[1]);
          if (account) {
            if (!codex || codex.account.id !== account.id) codexThread = null;
            codex = { account, model: cx[2]! };
            claude = null;
            return;
          }
        }
        const m = /^claude:([^:]*):(.+)$/.exec(id);
        if (m) {
          const account = claudeAccounts(dataDir).find((a) => (a.id ?? '') === m[1]);
          if (account) {
            if (!claude || claude.account.id !== account.id) claudeSession = null;
            claude = { account, model: m[2]! };
            codex = null;
            return;
          }
        }
        claude = null;
        codex = null;
        provider = { ...provider, model: id };
        agent.configure({ modelId: id });
        conv!.model = id;
      },
      models: async () => {
        let modelError = 'no models on this account';
        // The account's own list, asked for fresh: what you can use, not a guess.
        if (client) {
          try {
            catalog = await client.listModels(AbortSignal.timeout(10_000));
          } catch (e) {
            modelError = `couldn't load the list: ${e instanceof Error ? e.message : String(e)}`;
          }
        }
        const groups: ModelGroup[] = [];
        const engineItems = (
          list: EngineModel[],
          prefix: string,
          accountId: string | null,
          fallback: string[],
        ) => {
          const item = (m: EngineModel, hint: string) => ({
            label: m.name,
            hint,
            value: `${prefix}:${accountId ?? ''}:${m.id}`,
          });
          if (!list.length)
            return fallback.map((m) => ({
              label: m,
              value: `${prefix}:${accountId ?? ''}:${m}`,
            }));
          const first = list[0]!;
          return [
            {
              label: 'Default (recommended)',
              hint: `${first.name}${first.description ? ` · ${first.description}` : ''}`,
              value: `${prefix}:${accountId ?? ''}:default`,
            },
            ...list.filter((m) => m.main).map((m) => item(m, m.description)),
            ...list
              .filter((m) => !m.main)
              .map((m) => item(m, m.description ? `older · ${m.description}` : 'older')),
          ];
        };
        if (claudeBin)
          for (const a of claudeAccounts(dataDir))
            groups.push({
              label: `Claude Code · ${a.name}`,
              hint: 'your Claude account',
              items: engineItems(claudeModelsOf(a.id), 'claude', a.id, [
                'default',
                'sonnet',
                'opus',
                'haiku',
              ]),
            });
        if (codexBin)
          for (const a of claudeAccounts(dataDir, 'codex'))
            groups.push({
              label: `Codex · ${a.name}`,
              hint: 'your ChatGPT account',
              items: engineItems(codexModelsOf(a.id), 'codex', a.id, ['default']),
            });
        for (const p of desktopProviders(dataDir))
          groups.push({
            label: p.name,
            hint: 'a provider you added in the desktop app',
            items: p.models.map((m) => ({ label: m, value: `@${p.id}/${m}` })),
            empty: 'No saved models for this provider; refresh the list in the desktop app',
          });
        if (client)
          groups.push({
            label: 'Kovan account',
            hint: catalog.length ? `${catalog.length} model` : modelError,
            items: catalog.map((c) => ({ label: c.id, value: c.id })),
            empty: modelError,
          });
        return groups.length ? { groups } : { groups, error: modelError };
      },
      turn,
      stop: () => (codex ? codexRunner.stop() : claude ? claudeRunner.stop() : agent.stop()),
      slash,
      palette: async () => {
        const set = await discoverSkills(skillPlaces(root, ex)).catch(() => null);
        return (set?.skills ?? []).map((k) => ({
          label: `/${k.name}`,
          hint: clip(k.description, 70),
          value: `/${k.name} `,
        }));
      },
      // Every chat of Kovan's own agent on this machine: this folder's first, then the others with where they were held.
      sessions: () => {
        const all = deps.store.list().filter((c) => c.harness === 'kovan');
        const when = (c: { updatedAt: number }) => new Date(c.updatedAt).toLocaleString();
        return [...all.filter((c) => c.root === root), ...all.filter((c) => c.root !== root)].map(
          (c) => ({
            label: clip(c.title, 60),
            hint: c.root === root ? when(c) : `${basename(c.root)} · ${when(c)}`,
            value: c.id,
          }),
        );
      },
      resume: (id) => {
        const saved = deps.store.loadById(id);
        if (!saved) return null;
        // Its files are in another folder: the agent would work in the wrong one, so say how to open it there.
        if (saved.root !== root) return { elsewhere: saved.root, id: saved.id };
        conv = saved;
        agent.messages.splice(
          1,
          agent.messages.length,
          ...saved.messages.filter((m) => m.role !== 'system'),
        );
        return { events: saved.events as TranscriptEvent[] };
      },
      rename,
      title: () => conv!.title,
      newChat: () => {
        agent.messages.splice(1);
        conv = deps.store.create(root, { model: provider.model, effort, mode });
      },
      history: conv.events.flatMap((e) => (e.type === 'user' ? [e.text] : [])),
      initialEvents: resumed ? (conv.events as TranscriptEvent[]) : [],
      startLines: resumed ? [`continuing: ${conv.title}`] : [],
      notchEnabled: notch !== NOOP_NOTCH,
      contextText,
      reasoning: args.reasoning,
    };
    const app = new TuiApp(deps.screen(), host);
    tui = app;
    // An update that lands while the screen is open shows in the status row, the way Claude Code's does.
    void update?.then((r) => {
      if (r.status === 'updated') app.markUpdated();
    });
    const code = await app.run();
    tui = null;
    return finish(code);
  }

  out(`kovan · ${provider.model} · ${provider.label} · mode: ${mode} · ${root}`);
  out(
    resumed
      ? `continuing: ${conv.title}`
      : 'New chat. /help lists the commands; Ctrl+C stops a turn.',
  );

  while (!leaving) {
    const raw = await t.readLine('\n› ');
    if (raw === null) break;
    const line = raw.trim();
    if (!line) continue;
    if (line === '/exit' || line === '/quit') break;
    if (line === '/help') {
      out(USAGE);
      continue;
    }
    if (line === '/cost') {
      const c = renderer.totals();
      out(`${c.tokensIn}→${c.tokensOut} tokens${c.cost > 0 ? ` · $${c.cost.toFixed(4)}` : ''}`);
      continue;
    }
    if (line === '/context') {
      out(contextText ? clip(contextText, 600) : 'No extra context was given to this chat.');
      continue;
    }
    if (/^\/rename(\s|$)/.test(line)) {
      const name = line.slice(7).trim();
      if (!name) out(`name: ${conv.title}  (/rename <name> changes it)`);
      else out(rename(name));
      continue;
    }
    if (line === '/clear') {
      agent.messages.splice(1);
      conv = deps.store.create(root, { model: provider.model, effort, mode });
      out('Cleared: new chat.');
      continue;
    }
    if (/^\/mode(\s|$)/.test(line)) {
      const m = line.slice(5).trim();
      if (!m) out(`mode: ${mode} (${MODES.join(', ')})`);
      else if ((MODES as readonly string[]).includes(m)) {
        mode = m as PermissionMode;
        agent.configure({ mode });
        out(`mode: ${mode}`);
      } else out(`unknown mode '${m}' (${MODES.join(', ')})`);
      continue;
    }
    if (/^\/models(\s|$)/.test(line)) {
      const q = line.slice(7).trim().toLowerCase();
      const ids = catalog
        .map((c) => c.id)
        .filter((id) => id.toLowerCase().includes(q))
        .slice(0, 15);
      out(ids.length ? ids.join('\n') : "Couldn't load the model list, or nothing matched.");
      continue;
    }
    if (/^\/model(\s|$)/.test(line)) {
      const id = line.slice(6).trim();
      if (!id) out(`model: ${provider.model}`);
      else {
        provider = { ...provider, model: id };
        agent.configure({ modelId: id });
        out(`model: ${id}`);
      }
      continue;
    }
    if (/^\/skills(\s|$)/.test(line)) {
      const q = line.slice(7).trim().toLowerCase();
      const set = await discoverSkills(skillPlaces(root, ex)).catch(() => null);
      const rows = (set?.skills ?? [])
        .filter((k) => !q || k.name.toLowerCase().includes(q))
        .map((k) => `/${k.name}  (${k.source})  ${clip(k.description, 80)}`);
      out(
        rows.length
          ? rows.join('\n')
          : 'No skills. Folders with a SKILL.md go under .kovan/skills, .claude/skills or ~/.claude/skills.',
      );
      // A skill that could not be read is said, not silently missing.
      for (const w of set?.warnings ?? [])
        out(`! skipped: ${w.path.replace(ex.home, '~')} — ${w.problem}`);
      continue;
    }
    if (line.startsWith('/')) {
      const s = await slash(line);
      if (!s) {
        out('Unknown command. See /help and /skills.');
        continue;
      }
      await turn(s.send);
      continue;
    }
    await turn(line);
  }
  return finish(0);
}
