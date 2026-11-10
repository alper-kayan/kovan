import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  Agent,
  buildSystemPrompt,
  discoverSkills,
  parseSkillCommand,
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
import { MODES, parseArgs, type Args } from './args.js';
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
import { cliDir } from './paths.js';
import { Renderer } from './render.js';
import { digestOf, keepEvent, type ConversationStore, type StoredConversation } from './store.js';
import { bundlePath, checkAndUpdate, type UpdateResult } from './update.js';

export const VERSION = '0.2.1';

export const USAGE = `kovan ${VERSION}: terminalde Kovan'ın kodlama ajanı.

  kovan                       sohbet: bu klasörde ajanla konuş
  kovan "testleri düzelt"     tek mesaj, işi yapıp çıkar
  kovan -c                    bu klasördeki son sohbete devam et
  kovan login [--server <url>]  Kovan hesabına gir (tarayıcıda onaylanır)
  kovan logout | whoami       çıkış | kim olduğum
  kovan update                kendini güncelle
  kovan sessions [--json]     sohbetler (Kovan masaüstündeki sohbet listesiyle aynı)
  kovan sessions export <id>  bir sohbetin özeti (JSON)
  kovan config                hangi sunucuyla, hangi modelle konuşuyor

  -m, --model <id>            model
  --mode <plan|request|allow|full>
                              plan: sadece oku · request: her düzenlemeyi ve komutu sor · allow: düzenle, komutu sor (varsayılan) · full: sorma
  --effort <seviye>           none, minimal, low, medium, high, xhigh, max
  --context-file <dosya>      sistem istemine eklenecek ek talimat
  --reasoning                 modelin düşüncesini göster
  --cwd <klasör>              başka bir klasörde çalış

Model: kendi anahtarın (OPENROUTER_API_KEY, ya da KOVAN_BASE_URL + KOVAN_MODEL [+ KOVAN_API_KEY]) önce gelir; yoksa 'kovan login' ile Kovan hesabın
(yönetilen kullanım, hesabına yazılır). Sohbetler Kovan masaüstünün sohbet listesinde de görünür.
Claude'un okuduklarını okur: depodaki ve ~/.claude'daki skill'ler (/skill-adı), CLAUDE.md / AGENTS.md / KOVAN.md, ~/.claude/CLAUDE.md,
.claude/commands/*.md (özel komutlar). KOVAN_NO_CLAUDE=1 hepsini kapatır.
Sohbette: /help /mode /model /models /clear /cost /context /skills /exit
`;

/** What `kovan` needs from the terminal. Real in index.ts, scripted in tests. */
export interface Terminal {
  readonly isTTY: boolean;
  write(s: string): void;
  /** `null` when the input has ended. */
  readLine(prompt: string): Promise<string | null>;
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
  /** Where the "when did I last look" stamp goes. */
  stateDir?: string;
  /** His home folder (where `.claude` lives); the real one unless a test says otherwise. */
  home?: string;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The top of the repository this folder is in, or the folder itself: the app's "workspace" is the same folder. */
export function workspaceRoot(dir: string): { root: string; isRepo: boolean } {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return { root: d, isRepo: true };
    if (dirname(d) === d) return { root: dir, isRepo: false };
  }
}

/** His own key or gateway first; Kovan's managed usage only when there is none and he is signed in. */
export function resolveProvider(
  env: Record<string, string | undefined>,
  file: string | undefined,
  auth: Auth | null,
  model: string | null,
): ProviderResult {
  const own = loadProvider(env, file);
  if (own.ok || !auth) return own;
  // A custom gateway that is half configured is his to fix; only the "no key at all" case falls back to the account.
  if (/model adı yok/.test(own.why)) return own;
  return { ok: true, provider: managedProvider(auth, model ?? env['KOVAN_MODEL'] ?? null) };
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
        out(`giriş yapıldı: ${a.user?.name ?? '—'} (${a.server})`);
        return 0;
      } catch (e) {
        deps.err(e instanceof LoginError ? e.message : String(e));
        return 1;
      }
    }
    case 'logout': {
      const a = deps.auth.load();
      if (!a) {
        out('zaten girişli değilsin.');
        return 0;
      }
      await logout(a, fetchImpl);
      deps.auth.clear();
      out('çıkış yapıldı.');
      return 0;
    }
    case 'whoami': {
      const a = deps.auth.load();
      if (!a) {
        out("girişli değilsin. 'kovan login' ile gir.");
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
      out(describeUpdate(r) ?? 'güncel.');
      return r.status === 'failed' ? 1 : 0;
    }
    case 'config': {
      const auth = deps.auth.load();
      const p = resolveProvider(deps.env, deps.configFile, auth, null);
      const who = auth ? `giriş: ${auth.user?.name ?? 'evet'} (${auth.server})` : 'giriş: yok';
      if (!p.ok) {
        out(`sunucu: yok\n${who}\n${p.why}`);
        return 1;
      }
      out(
        `sunucu: ${p.provider.label}\nmodel:  ${p.provider.model}\nanahtar: ${p.provider.apiKey ? 'var' : 'yok (gerekmeyebilir)'}\n${who}\ndosya:  ${deps.configFile ?? CONFIG_FILE}`,
      );
      return 0;
    }
    case 'sessions': {
      if (args.sessionId) {
        const c = deps.store.loadById(args.sessionId);
        if (!c) {
          deps.err(`sohbet bulunamadı: ${args.sessionId}`);
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
      else if (list.length === 0) out('henüz sohbet yok.');
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
      return `kovan güncellendi: ${r.from} → ${r.to} (bir sonraki açılışta geçerli).`;
    case 'available':
      return `yeni sürüm var: ${r.version}. Bu kopya depodan çalışıyor; depoda: pnpm --filter @kovan/cli bundle --install`;
    case 'failed':
      return r.why ? `güncellenemedi: ${r.why}` : null;
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
  });
}

async function chat(args: Args, deps: Deps, server: string): Promise<number> {
  const t = deps.terminal;
  const out = (s: string) => t.write(`${s}\n`);
  const { root, isRepo } = workspaceRoot(resolve(args.cwd ?? deps.cwd));
  const auth = deps.auth.load();

  // Looking for a newer version never holds the prompt up: it runs beside it and speaks at the end.
  const update: Promise<UpdateResult> | null =
    deps.checkUpdates && t.isTTY
      ? updateNow(deps, server, false).catch((): UpdateResult => ({ status: 'failed', why: '' }))
      : null;
  const finish = async (code: number): Promise<number> => {
    const note = update ? describeUpdate(await update) : null;
    if (note) out(note);
    return code;
  };

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
      deps.err(`bağlam dosyası okunamadı: ${args.contextFile} (onsuz devam ediyorum)`);
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
  if (args.continueLast) {
    const latest = deps.store.latestFor(root);
    const saved = latest ? deps.store.load(root, latest.id) : null;
    if (saved) {
      conv = saved;
      resumed = true;
    } else deps.err('bu klasörde devam edilecek sohbet yok; yenisi başlıyor.');
  }
  let mode: PermissionMode = args.mode ?? (resumed ? conv!.mode : 'allow');
  conv ??= deps.store.create(root, { model: provider.model, effort: args.effort, mode });
  // The system prompt is rebuilt each time (a changed KOVAN.md applies); what was said before it is kept.
  const history: ChatMessage[] = resumed
    ? [{ role: 'system', content: system }, ...conv.messages.filter((m) => m.role !== 'system')]
    : [];

  let streamer: ModelStreamer;
  let catalog: ModelInfo[] = deps.catalog ?? [];
  if (deps.model) streamer = deps.model;
  else {
    const client = new OpenRouterClient({
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

  const renderer = new Renderer((s) => t.write(s), {
    color: t.isTTY && !deps.env['NO_COLOR'],
    reasoning: args.reasoning,
  });
  const always = new Set<string>();
  let lastReason: string | null = null;

  const approve = async (r: ApprovalRequest): Promise<boolean> => {
    if (always.has(r.tool)) return true;
    if (!t.isTTY) {
      out(
        `izin gerekiyor ama soracak kimse yok: ${r.title} (${clip(r.detail, 120)}). --mode full ile çalıştır.`,
      );
      return false;
    }
    out(`\n? ${r.title}\n  ${clip(r.detail, 400)}`);
    const a =
      (await t.readLine('  izin ver? [e]vet / [h]ayır / [t]ümüne (bu oturumda) › '))
        ?.trim()
        .toLowerCase() ?? '';
    if (a === 't') {
      always.add(r.tool);
      return true;
    }
    return a === 'e' || a === 'evet' || a === 'y' || a === 'yes';
  };

  const agent = new Agent(
    {
      model: streamer,
      modelId: provider.model,
      effort: args.effort,
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
      onEvent: (e) => {
        if (e.type === 'turn_end') {
          lastReason = e.reason;
          conv!.cost += e.cost;
        }
        if (keepEvent(e)) conv!.events.push(e);
        renderer.event(e);
      },
    },
    history,
  );

  const turn = async (text: string) => {
    lastReason = null;
    conv!.events.push({ type: 'user', text, attachments: [], at: Date.now() });
    await agent.send(text);
    conv!.messages = [...agent.messages];
    conv!.updatedAt = Date.now();
    conv!.model = provider.model;
    conv!.mode = mode;
    if (conv!.title === 'New chat')
      conv!.title = clip(text.replace(/\s+/g, ' ').trim(), 80) || 'New chat';
    try {
      deps.store.save(conv!);
    } catch (e) {
      deps.err(`sohbet kaydedilemedi: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

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

  out(`kovan · ${provider.model} · ${provider.label} · mod: ${mode} · ${root}`);
  out(
    resumed
      ? `sohbet devam ediyor: ${conv.title}`
      : 'yeni sohbet. /help ile komutlar, Ctrl+C durdurur.',
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
      out(`${c.tokensIn}→${c.tokensOut} jeton${c.cost > 0 ? ` · $${c.cost.toFixed(4)}` : ''}`);
      continue;
    }
    if (line === '/context') {
      out(contextText ? clip(contextText, 600) : 'bu sohbete ek bağlam verilmedi.');
      continue;
    }
    if (line === '/clear') {
      agent.messages.splice(1);
      conv = deps.store.create(root, { model: provider.model, effort: args.effort, mode });
      out('temizlendi: yeni sohbet.');
      continue;
    }
    if (/^\/mode(\s|$)/.test(line)) {
      const m = line.slice(5).trim();
      if (!m) out(`mod: ${mode} (${MODES.join(', ')})`);
      else if ((MODES as readonly string[]).includes(m)) {
        mode = m as PermissionMode;
        agent.configure({ mode });
        out(`mod: ${mode}`);
      } else out(`bilinmeyen mod '${m}' (${MODES.join(', ')})`);
      continue;
    }
    if (/^\/models(\s|$)/.test(line)) {
      const q = line.slice(7).trim().toLowerCase();
      const ids = catalog
        .map((c) => c.id)
        .filter((id) => id.toLowerCase().includes(q))
        .slice(0, 15);
      out(ids.length ? ids.join('\n') : 'model listesi alınamadı ya da eşleşen yok.');
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
          : 'skill yok. SKILL.md içeren klasörler .kovan/skills, .claude/skills ya da ~/.claude/skills altında olmalı.',
      );
      // A skill that could not be read is said, not silently missing.
      for (const w of set?.warnings ?? [])
        out(`! atlandı: ${w.path.replace(ex.home, '~')} — ${w.problem}`);
      continue;
    }
    if (line.startsWith('/')) {
      const s = await slash(line);
      if (!s) {
        out("bilinmeyen komut. /help ve /skills'e bak.");
        continue;
      }
      await turn(s.send);
      continue;
    }
    await turn(line);
  }
  return finish(0);
}
