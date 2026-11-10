import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  Agent,
  buildSystemPrompt,
  discoverSkills,
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
import { CONFIG_FILE, loadProvider, type Provider } from './config.js';
import { Renderer } from './render.js';
import { digestOf, type SessionMeta, type SessionStore } from './session.js';

export const VERSION = '0.1.0';

export const USAGE = `kovan ${VERSION}: terminalde Kovan'ın kodlama ajanı.

  kovan                       sohbet: bu klasörde ajanla konuş
  kovan "testleri düzelt"     tek mesaj, işi yapıp çıkar
  kovan -c                    bu klasördeki son oturuma devam et
  kovan sessions [--json]     oturumlar
  kovan sessions export <id>  bir oturumun özeti (JSON)
  kovan config                hangi sunucuyla, hangi modelle konuşuyor

  -m, --model <id>            model
  --mode <plan|request|allow|full>
                              plan: sadece oku · request: her düzenlemeyi ve komutu sor · allow: düzenle, komutu sor (varsayılan) · full: sorma
  --effort <seviye>           none, minimal, low, medium, high, xhigh, max
  --context-file <dosya>      sistem istemine eklenecek ek talimat
  --reasoning                 modelin düşüncesini göster
  --cwd <klasör>              başka bir klasörde çalış

Model sunucusu: OPENROUTER_API_KEY, ya da KOVAN_BASE_URL + KOVAN_MODEL (+ KOVAN_API_KEY) ile OpenAI uyumlu herhangi bir ağ geçidi.
Sohbette: /help /mode /model /models /clear /cost /context /exit
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
  store: SessionStore;
  err: (s: string) => void;
  configFile?: string;
  /** A scripted model, for tests. Otherwise the provider from the environment. */
  model?: ModelStreamer;
  catalog?: ModelInfo[];
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function isRepoDir(root: string): boolean {
  for (let dir = root; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return true;
    if (dirname(dir) === dir) return false;
  }
}

export async function main(argv: readonly string[], deps: Deps): Promise<number> {
  const args = parseArgs(argv);
  const t = deps.terminal;
  const out = (s: string) => t.write(`${s}\n`);

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
    case 'config': {
      const p = loadProvider(deps.env, deps.configFile);
      if (!p.ok) {
        out(`sunucu: yok\n${p.why}`);
        return 1;
      }
      out(
        `sunucu: ${p.provider.label}\nmodel:  ${p.provider.model}\nanahtar: ${p.provider.apiKey ? 'var' : 'yok (gerekmeyebilir)'}\ndosya:  ${deps.configFile ?? CONFIG_FILE}`,
      );
      return 0;
    }
    case 'sessions': {
      if (args.sessionId) {
        const s = deps.store.load(args.sessionId);
        if (!s) {
          deps.err(`oturum bulunamadı: ${args.sessionId}`);
          return 1;
        }
        out(JSON.stringify(digestOf(s.meta, s.messages)));
        return 0;
      }
      const list = deps.store.list();
      if (args.json) out(JSON.stringify(list));
      else if (list.length === 0) out('henüz oturum yok.');
      else
        for (const m of list)
          out(
            `${m.id}  ${m.updatedAt.slice(0, 16).replace('T', ' ')}  ${basename(m.cwd).padEnd(18)} ${clip(m.title || '(boş)', 60)}`,
          );
      return 0;
    }
    default:
      return chat(args, deps);
  }
}

async function chat(args: Args, deps: Deps): Promise<number> {
  const t = deps.terminal;
  const out = (s: string) => t.write(`${s}\n`);
  const root = resolve(args.cwd ?? deps.cwd);
  const isRepo = isRepoDir(root);

  let provider: Provider;
  let streamer: ModelStreamer;
  let catalog: ModelInfo[] = deps.catalog ?? [];
  if (deps.model) {
    provider = {
      baseUrl: 'test',
      apiKey: '',
      model: args.model ?? 'test/model',
      dialect: 'openai',
      label: 'test',
    };
    streamer = deps.model;
  } else {
    const p = loadProvider(deps.env, deps.configFile);
    if (!p.ok) {
      deps.err(p.why);
      return 1;
    }
    provider = args.model ? { ...p.provider, model: args.model } : p.provider;
    const client = new OpenRouterClient({
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      dialect: provider.dialect,
      appName: 'kovan',
      appUrl: 'https://kovan.alperkayan.dev',
    });
    streamer = client;
    // The catalogue prices a turn and gives the context window; the prompt does not wait for it.
    void client
      .listModels(AbortSignal.timeout(8000))
      .then((c) => (catalog = c))
      .catch(() => {});
  }

  let contextText = '';
  if (args.contextFile) {
    try {
      contextText = readFileSync(args.contextFile, 'utf8').trim();
    } catch {
      deps.err(`bağlam dosyası okunamadı: ${args.contextFile} (onsuz devam ediyorum)`);
    }
  }
  const base = await buildSystemPrompt({ root, name: basename(root), isRepo });
  const system = contextText
    ? `${base}\n\nAdditional instructions from the tool that started this session:\n\n${contextText}`
    : base;

  let session: SessionMeta | null = null;
  let history: ChatMessage[] = [];
  let resumed = false;
  if (args.continueLast) {
    const meta = deps.store.latestFor(root);
    const saved = meta ? deps.store.load(meta.id) : null;
    if (saved) {
      session = saved.meta;
      history = [{ role: 'system', content: system }, ...saved.messages];
      resumed = true;
    } else {
      deps.err('bu klasörde devam edilecek oturum yok; yenisi başlıyor.');
    }
  }
  session ??= deps.store.create(root, provider.model);

  let mode: PermissionMode = args.mode ?? 'allow';
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
      skills: () =>
        discoverSkills({ root, userDir: join(homedir(), '.kovan', 'skills'), claudeDir: null }),
      onEvent: (e) => {
        if (e.type === 'turn_end') lastReason = e.reason;
        renderer.event(e);
      },
    },
    history,
  );

  const turn = async (text: string) => {
    lastReason = null;
    await agent.send(text);
    session!.turns += 1;
    session!.updatedAt = new Date().toISOString();
    session!.model = provider.model;
    if (!session!.title) session!.title = clip(text.replace(/\s+/g, ' '), 80);
    try {
      deps.store.save(session!, agent.messages.slice(1));
    } catch (e) {
      deps.err(`oturum kaydedilemedi: ${e instanceof Error ? e.message : String(e)}`);
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

  // One message: do it and go.
  if (args.task) {
    await turn(args.task);
    return lastReason === 'done' ? 0 : 1;
  }

  out(`kovan · ${provider.model} · ${provider.label} · mod: ${mode} · ${root}`);
  out(
    resumed
      ? `oturum devam ediyor: ${session.title || session.id}`
      : 'yeni oturum. /help ile komutlar, Ctrl+C durdurur.',
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
      out(contextText ? clip(contextText, 600) : 'bu oturuma ek bağlam verilmedi.');
      continue;
    }
    if (line === '/clear') {
      agent.messages.splice(1);
      session = deps.store.create(root, provider.model);
      out('temizlendi: yeni oturum.');
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
    if (line.startsWith('/')) {
      out("bilinmeyen komut. /help'e bak.");
      continue;
    }
    await turn(line);
  }
  return 0;
}
