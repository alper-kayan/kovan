import type { DetachedRun } from '@kovan/runner';
import { mt } from './i18n.js';
import {
  Agent,
  buildSystemPrompt,
  isUsageLimit,
  readBeforeBuild,
  RULES_FILE,
  runShell,
  type AgentEvent,
  type Tool,
  type ApprovalRequest,
  type IssueEdits,
  type ModelStreamer,
  type SkillSet,
} from '@kovan/harness';
import {
  chooseAgent,
  classifyByModel,
  classifyByRules,
  JEV_CLASSIFIER_MODEL as CLASSIFIER_MODEL,
  JEV_MODEL_ID,
  JevRouter,
  parseAgentDirective,
  rulesUnsure,
} from '@kovan/jevrouter';
import {
  estimateCost,
  OpenRouterClient,
  type ChatMessage,
  type ContentPart,
  type ModelInfo,
  type Usage,
} from '@kovan/model-gateway';
import { safeStorage } from 'electron';
import type { AskTrust, TrustQuestion } from './mcp.js';
import { maskSecrets } from '@kovan/mcp-client';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, watch } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  compactEvents,
  foldEvents,
  type ReceiptLine,
  type AgentOption,
  type Readiness,
  type ReadyFix,
  type Harness,
  type Attachment,
  type Conversation,
  type ConversationConfig,
  type ConversationEvent,
  type ConversationSummary,
  type ExternalHarness,
  type ProviderStatus,
  type SessionLink,
  defaultOption,
  HARNESS_NAMES,
  optionLabel,
  parseCustomModelId,
  sameOption,
  withAccount,
} from '../shared/agent.js';
import {
  accountOf,
  claudeLimit,
  codexLimit,
  handoffNote,
  nextOption,
  resetFromMessage,
} from '../shared/limits.js';
import type { Settings } from '../shared/settings.js';
import type { AgentLimits } from './agentLimits.js';
import { ClaudeCodeRunner } from './harnesses/claudeCode.js';
import { CodexRunner, type McpServerSpec } from './harnesses/codex.js';
import { CodexAppServerRunner, codexHasAppServer } from './harnesses/codexAppServer.js';
import type { ExternalRunner, SubagentOutcome } from '@kovan/runner';
import { Delegations } from './delegations.js';
import { conversationDigest } from '../shared/mentions.js';
import type { CustomProviders } from './customProviders.js';
import type { TeamCaller, TeamTools } from './teamTools.js';
import { readJson, writeJson } from '@kovan/runner';
import { COMMIT_SYSTEM, cleanMessage, commitContext, commitPrompt } from './commitMessage.js';

const CATALOG_MAX_AGE_MS = 24 * 3_600_000;
/** Small, quick and cheap: commit messages don't need more. */
const COMMIT_MODEL = 'openai/gpt-5.6-luna';

/** The OpenRouter key: in the OS keychain, or (dev only) from the environment. */
export class ProviderKeys {
  private cached: string | null | undefined;

  constructor(
    private readonly dir: string,
    private readonly devEnvKey: string | null,
  ) {}

  private get file() {
    return join(this.dir, 'openrouter-key.bin');
  }

  async openRouterKey(): Promise<string | null> {
    if (this.cached !== undefined) return this.cached ?? this.devEnvKey;
    const stored = safeStorage.isEncryptionAvailable()
      ? await readFile(this.file).catch(() => null)
      : null;
    try {
      this.cached = stored ? safeStorage.decryptString(stored) : null;
    } catch {
      this.cached = null;
    }
    return this.cached ?? this.devEnvKey;
  }

  async status(): Promise<Pick<ProviderStatus, 'openrouter'>> {
    await this.openRouterKey();
    return {
      openrouter: {
        configured: Boolean(this.cached ?? this.devEnvKey),
        source: this.cached ? 'keychain' : this.devEnvKey ? 'environment' : null,
      },
    };
  }

  async setOpenRouterKey(key: string | null): Promise<void> {
    if (key === null) {
      await rm(this.file, { force: true });
      this.cached = null;
      return;
    }
    if (!safeStorage.isEncryptionAvailable())
      throw new Error('This system has no secure storage for keys');
    // Check the key before keeping it.
    const response = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!response.ok) throw new Error('OpenRouter did not accept that key');
    await writeFile(this.file, safeStorage.encryptString(key));
    this.cached = key;
  }
}

interface StoredConversation extends ConversationSummary, ConversationConfig {
  root: string;
  messages: ChatMessage[];
  events: ConversationEvent[];
  /** Claude Code's own session id, so the next turn resumes it. */
  claudeSessionId?: string;
  /** Codex's own thread id, likewise. */
  codexThreadId?: string;
  /** Which "Before Build" commands already ran in this conversation (a hash of them). */
  beforeBuild?: string;
  /** Set when this conversation is the person's lane in a shared session. */
  session?: SessionLink;
  /** Older conversations: the person agreed to continue on pay-per-use models, whoever pays. */
  paidSwitchOk?: boolean;
  /** Who the person agreed, in this conversation, may pay for a switch (see `payerOf`). */
  paidSwitchOkFor?: string[];
  /** Auto already chose this conversation's agent; it keeps it. */
  autoPicked?: boolean;
  /**
   * Who ran the conversation before it moved to another agent (or another account of one), by hand or by Auto. The next
   * turn tells the new one what was asked, said and changed, since it saw none of it. Cleared once that turn starts.
   */
  handoffFrom?: string;
}

interface Live {
  stored: StoredConversation;
  agent: Agent | null;
  /** Kept for the whole conversation so the router remembers the current task. */
  router: JevRouter | null;
  /** Who pays and which workspace the router's client files usage under; a change makes a new one. */
  routerKey?: string;
  /** The last turn went through Kovan's managed usage (the server files its usage). */
  managed?: boolean;
  /** Set when the conversation runs on the user's Claude Code or Codex. */
  external: ExternalRunner | null;
  /** Set while KOVAN.md's "Before Build" commands run, to stop them. */
  preparing: AbortController | null;
  pending: Map<string, (approved: boolean) => void>;
  /** What the person changed on a card before approving it (an issue's text). */
  edits: Map<string, IssueEdits>;
  /** Waiting for the conversation to go idle (takeovers wait for the checkpoint). */
  idle: (() => void)[];
  /** Tool calls in flight, to tell which files a lane changed. */
  toolArgs: Map<string, { name: string; args: Record<string, unknown> }>;
  /** Auto's own classifier call, filed with the turn it routed. */
  routingUsage?: Extract<AgentEvent, { type: 'usage' }>;
  /** Work this agent handed to subagents (delegate_task), and going on when it ends. */
  delegations?: Delegations;
}

/** Whose account a conversation's turns are billed to, in words for the turn's footer. */
function payerOf(live: Live): string {
  const s = live.stored;
  const harness = s.harness ?? 'kovan';
  if (harness === 'claude-code') return 'your Claude subscription';
  if (harness === 'codex') return 'your Codex (OpenAI) plan';
  const custom = parseCustomModelId(s.model);
  if (custom) return `your ${custom.provider} key`;
  return live.managed ? 'Kovan billing' : 'your OpenRouter key';
}

/** A copy for teammates: paths relative to the repo, since their checkout lives elsewhere. */
function forTeam(event: ConversationEvent, root: string): ConversationEvent {
  const rel = (p: unknown) =>
    typeof p === 'string' && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p;
  if (event.type === 'tool_progress') return { ...event, path: rel(event.path) as string | null };
  if (event.type === 'tool_start' && (event.args['file_path'] || event.args['path']))
    return {
      ...event,
      args: {
        ...event.args,
        ...(event.args['file_path'] ? { file_path: rel(event.args['file_path']) } : {}),
        ...(event.args['path'] ? { path: rel(event.args['path']) } : {}),
      },
    };
  return event;
}

/** Tools that change files, and where each one names the file. */
function changedPaths(name: string, args: Record<string, unknown>): string[] {
  if (['edit_file', 'write_file', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(name)) {
    const path = args['path'] ?? args['file_path'] ?? args['notebook_path'];
    return typeof path === 'string' ? [path] : [];
  }
  if (name === 'apply_patch' && Array.isArray(args['changes']))
    return (args['changes'] as { path?: unknown }[])
      .map((c) => c.path)
      .filter((p): p is string => typeof p === 'string');
  return [];
}

export interface AgentHost {
  emit(conversationId: string, event: ConversationEvent): void;
  /** Plans, Brain notes and team context for agents. */
  team: Pick<TeamTools, 'harnessTools' | 'turnNote'> & Partial<Pick<TeamTools, 'checkWrite'>>;
  /** Pushes a checkpoint snapshot of the checkout for a session lane (null without a remote). */
  snapshot(session: SessionLink, root: string): Promise<{ sha: string; ref: string } | null>;
  /** Sends a session lane's events to the team (Brain), with the files they changed. */
  mirror(session: SessionLink, event: ConversationEvent, touched: string[], root: string): void;
  /** Shows a system notification when the window is in the background. */
  notify(title: string, body: string): void;
  isRepo(root: string): boolean;
  /** Files a finished turn's calls with the account, when signed in. Must not throw. */
  reportUsage(root: string, conversationId: string, receipt: ReceiptLine[]): void;
  /** Where an agent CLI lives on this machine, if it does. */
  agentBinary(harness: ExternalHarness): Promise<string | null>;
  /**
   * What the CLI's process needs to run as one of the person's accounts (its folder). Null when
   * that account is gone from this machine.
   */
  accountEnv?(
    harness: ExternalHarness,
    account: string | undefined,
  ): Promise<Record<string, string> | null>;
  /**
   * The first account the person added for this agent. Claude Code and Codex only run as an
   * account added in Settings → Agents → Accounts, never as the CLI's own sign-in.
   */
  firstAccount?(harness: ExternalHarness): Promise<string | undefined>;
  pathEnv(): Promise<string>;
  /** Writes the MCP config that connects a Kovan-launched agent back to Kovan. */
  mcpConfig(conversationId: string, root: string): Promise<string>;
  /** The same MCP server as a command line, for CLIs configured by flags (Codex). */
  mcpServer(conversationId: string, root: string): McpServerSpec;
  /** Why a session checkout's agents must wait (a manual branch switch), or null. */
  paused?(root: string): string | null;
  /** A session lane finished a turn: teammates' snapshots held back meanwhile can apply now. */
  laneIdle?(sessionId: string, root: string): void;
  /**
   * Kovan's managed endpoint, when the agent should use it (your settings, your key, signed
   * in), with the token that bills you; null to use your own OpenRouter key.
   */
  managed?(): Promise<{ baseUrl: string; token: string } | null>;
  /** Why managed usage can't bill this person, in words, when signed in (null otherwise). */
  managedWhyNot?(): Promise<string | null>;
  /** The shared workspace a folder belongs to, for filing managed usage under it. */
  workspaceOf?(root: string): Promise<string | null>;
  /** What this machine knows about each agent's account limit. */
  limits: Pick<AgentLimits, 'open' | 'report' | 'full' | 'list'>;
  /** Tools Kovan's own agent gets besides the team's (creating an issue). */
  tools?(conversationId: string, root: string): Tool[];
  /** Hands a task to a subagent beside this session lane; `onSettled` hears how it ended. */
  delegate?(
    conversationId: string,
    task: string,
    onSettled: (outcome: SubagentOutcome) => void,
  ): Promise<{ id: string }>;
  settings(): Promise<Settings>;
  /** The skills Kovan's agent may use in `root` (read each turn). */
  skills?(root: string): Promise<SkillSet>;
  /**
   * MCP servers' tools for an agent working in `root` (read each turn). `ask` puts a
   * repository server nobody has allowed yet in front of the person; without it such a
   * server doesn't start.
   */
  mcpTools?(root: string, ask?: AskTrust): Promise<Tool[]>;
}

export type { DetachedRun };

/** Conversations with the native agent for one window, saved per workspace on disk. */
export class AgentManager {
  private readonly live = new Map<string, Live>();
  private catalog: { fetchedAt: number; models: ModelInfo[] } | null = null;

  constructor(
    private readonly dataDir: string,
    private readonly keys: ProviderKeys,
    private readonly custom: CustomProviders,
    private readonly host: AgentHost,
  ) {}

  private dirFor(root: string): string {
    return join(
      this.dataDir,
      'conversations',
      createHash('sha1').update(root).digest('hex').slice(0, 16),
    );
  }

  /**
   * The model client: your own OpenRouter key, or Kovan's managed endpoint (billed to you at
   * provider cost × 1.05; the run and workspace go along so usage is filed under them).
   */
  private async client(run?: {
    id: string;
    root: string;
    label: string;
  }): Promise<{ client: OpenRouterClient; managed: boolean }> {
    const managed = (await this.host.managed?.()) ?? null;
    if (managed)
      return {
        managed: true,
        client: new OpenRouterClient({
          apiKey: managed.token,
          baseUrl: managed.baseUrl,
          appName: 'Kovan',
          headers: run
            ? {
                'X-Kovan-Run': run.id,
                'X-Kovan-Workspace': (await this.host.workspaceOf?.(run.root)) ?? '',
                'X-Kovan-Run-Label': encodeURIComponent(run.label.slice(0, 120)),
              }
            : {},
        }),
      };
    const apiKey = await this.keys.openRouterKey();
    if (!apiKey) {
      const whyNot = await this.host.managedWhyNot?.();
      throw new Error(
        whyNot
          ? `${whyNot} Or add your own OpenRouter key in Settings → Model keys & spend.`
          : 'Add an OpenRouter key in Settings → Model keys & spend, or sign in to pay through Kovan billing.',
      );
    }
    return {
      managed: false,
      client: new OpenRouterClient({
        apiKey,
        appName: 'Kovan',
        appUrl: 'https://kovan.alperkayan.dev',
      }),
    };
  }

  /**
   * A commit message for the changes in `root` (staged ones, or all when nothing is staged),
   * written by a small model in the repository's own style. Paid like any agent call: your
   * OpenRouter key, or managed usage.
   */
  async commitMessage(root: string): Promise<{ message: string; cost: number | null }> {
    const context = await commitContext(root);
    if (!context) throw new Error('There are no changes to describe.');
    const id = `commit-${randomUUID()}`;
    const made = await this.client({ id, root, label: 'Commit message' });
    let text = '';
    let usage: Usage | null = null;
    for await (const event of made.client.stream(
      {
        model: COMMIT_MODEL,
        effort: 'none',
        maxTokens: 400,
        messages: [
          { role: 'system', content: COMMIT_SYSTEM },
          { role: 'user', content: commitPrompt(context) },
        ],
      },
      AbortSignal.timeout(60_000),
    )) {
      if (event.type === 'text') text += event.text;
      if (event.type === 'done') usage = event.usage;
    }
    const message = cleanMessage(text);
    if (!message) throw new Error("The model didn't write a message; try again.");
    // Managed usage is filed by the server; your own key's call goes on your usage like others.
    if (usage && !made.managed)
      this.host.reportUsage(root, id, [
        {
          model: COMMIT_MODEL,
          kind: 'model',
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          cachedTokens: usage.cachedTokens,
          cost: usage.cost ?? 0,
          estimated: usage.cost === null,
        },
      ]);
    return { message, cost: usage?.cost ?? null };
  }

  /** The person's custom providers' models, then OpenRouter's catalog. */
  async models(refresh = false): Promise<ModelInfo[]> {
    const custom = await this.custom.models();
    try {
      return [...custom, ...(await this.openRouterModels(refresh))];
    } catch (error) {
      if (custom.length) return custom;
      throw error;
    }
  }

  private async openRouterModels(refresh: boolean): Promise<ModelInfo[]> {
    const file = join(this.dataDir, 'model-catalog.json');
    this.catalog ??= ((await readJson(file)) as typeof this.catalog) ?? null;
    if (!refresh && this.catalog && Date.now() - this.catalog.fetchedAt < CATALOG_MAX_AGE_MS)
      return this.catalog.models;
    try {
      const models = (
        await (await this.client()).client.listModels(AbortSignal.timeout(20_000))
      ).filter((m) => m.tools);
      this.catalog = { fetchedAt: Date.now(), models };
      await writeJson(file, this.catalog);
    } catch (error) {
      if (!this.catalog) throw error;
    }
    return this.catalog!.models;
  }

  catalogFetchedAt(): number | null {
    return this.catalog?.fetchedAt ?? null;
  }

  async list(root: string): Promise<ConversationSummary[]> {
    const dir = this.dirFor(root);
    const names = await readdir(dir).catch(() => [] as string[]);
    const out: ConversationSummary[] = [];
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      const c = (await readJson(join(dir, name))) as StoredConversation | undefined;
      if (c?.id)
        out.push({
          id: c.id,
          title: c.title,
          updatedAt: c.updatedAt,
          cost: c.cost,
          ...(c.session ? { session: c.session } : {}),
        });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Watches this folder's conversations for writes from elsewhere: the `kovan` terminal agent keeps its chats here, in this format.
   * A conversation written there while it sits idle here is let go from memory (so the next open reads the new turns, and a save
   * here can't write over them), and `onChange` hears which ones changed, to list them again. This window's own saves leave the
   * file as old as the copy in memory, so they don't count.
   */
  watch(root: string, onChange: (ids: string[]) => void): () => void {
    const dir = this.dirFor(root);
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      return () => {};
    }
    const changed = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = async () => {
      timer = null;
      const ids = [...changed];
      changed.clear();
      // Only what someone else wrote (the terminal agent, say): this app's own saves are no news.
      const others: string[] = [];
      for (const id of ids) {
        const live = this.live.get(id);
        if (live && this.isRunning(live)) continue;
        const disk = (await readJson(join(dir, `${id}.json`))) as StoredConversation | undefined;
        if (live && disk && disk.updatedAt <= live.stored.updatedAt) continue;
        if (live) this.live.delete(id);
        others.push(id);
      }
      if (others.length) onChange(others);
    };
    let watcher: ReturnType<typeof watch>;
    try {
      watcher = watch(dir, (_event, name) => {
        const file = name ? String(name) : '';
        if (!file.endsWith('.json')) return;
        changed.add(file.slice(0, -'.json'.length));
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void settle(), 250);
      });
    } catch {
      return () => {};
    }
    watcher.on('error', () => {});
    return () => {
      if (timer) clearTimeout(timer);
      watcher.close();
    };
  }

  private async load(root: string, id: string): Promise<Live> {
    const existing = this.live.get(id);
    if (existing) return existing;
    const stored = (await readJson(join(this.dirFor(root), `${id}.json`))) as
      StoredConversation | undefined;
    if (!stored) throw new Error('Conversation not found');
    // Kovan was closed (or crashed) while a turn ran: nothing is running now, so close the turn
    // and say so, instead of leaving a conversation that looks mid-work forever.
    const open = stored.events.findLastIndex((e) => e.type === 'turn_start');
    const started = stored.events[open];
    if (
      started?.type === 'turn_start' &&
      !stored.events.slice(open).some((e) => e.type === 'turn_end')
    )
      stored.events.push({
        type: 'turn_end',
        turnId: started.turnId,
        reason: 'error',
        cost: 0,
        error:
          'Kovan was closed while this was running. Press Try again to run your last message again.',
      });
    const live: Live = {
      stored,
      agent: null,
      router: null,
      external: null,
      preparing: null,
      pending: new Map(),
      edits: new Map(),
      toolArgs: new Map(),
      idle: [],
    };
    this.live.set(id, live);
    return live;
  }

  private async save(live: Live): Promise<void> {
    const s = live.stored;
    s.events = compactEvents(s.events);
    s.messages = live.agent ? [...live.agent.messages] : s.messages;
    await mkdir(this.dirFor(s.root), { recursive: true });
    await writeJson(join(this.dirFor(s.root), `${s.id}.json`), s);
  }

  private view(live: Live): Conversation {
    // The model-facing history stays in the main process; the UI gets the events.
    const rest: Partial<StoredConversation> = { ...live.stored };
    delete rest.messages;
    return {
      ...(rest as Omit<StoredConversation, 'messages'>),
      running: this.isRunning(live),
    };
  }

  async create(
    root: string,
    config: ConversationConfig,
    session?: SessionLink,
  ): Promise<Conversation> {
    const now = Date.now();
    const stored: StoredConversation = {
      id: randomUUID(),
      title: session?.title ?? 'New chat',
      ...(session ? { session } : {}),
      updatedAt: now,
      cost: 0,
      root,
      messages: [],
      events: [],
      ...config,
    };
    const live: Live = {
      stored,
      agent: null,
      router: null,
      external: null,
      preparing: null,
      pending: new Map(),
      edits: new Map(),
      toolArgs: new Map(),
      idle: [],
    };
    this.live.set(stored.id, live);
    return this.view(live);
  }

  async open(root: string, id: string): Promise<Conversation> {
    return this.view(await this.load(root, id));
  }

  async remove(root: string, id: string): Promise<void> {
    this.stop(id);
    this.live.delete(id);
    await rm(join(this.dirFor(root), `${id}.json`), { force: true });
  }

  async configure(
    root: string,
    id: string,
    patch: Partial<ConversationConfig>,
  ): Promise<Conversation> {
    const live = await this.load(root, id);
    const modeChanged = patch.mode !== undefined && patch.mode !== live.stored.mode;
    const before = live.stored.harness ?? 'kovan';
    const modelBefore = live.stored.model;
    const accountBefore = live.stored.account;
    Object.assign(live.stored, patch);
    // Picking an agent by hand ends Auto; turning Auto on lets it choose at the next prompt.
    if (patch.auto === undefined && patch.harness) live.stored.auto = false;
    if (patch.auto) delete live.stored.autoPicked;
    // Teammates in a session hear about it (loudly for Full: no more approvals).
    if (modeChanged && live.stored.session)
      this.onAgentEvent(live, { type: 'mode', mode: patch.mode! });
    // Another sign-in of the same agent: the CLI session belongs to the old one.
    const accountChanged = 'account' in patch && patch.account !== accountBefore;
    if (accountChanged) this.forgetCliSession(live.stored);
    if ((patch.harness && patch.harness !== before) || accountChanged) {
      // Switching who runs the conversation starts that runner fresh; its first turn is told what came before.
      if (live.stored.events.some((e) => e.type === 'user'))
        live.stored.handoffFrom ??= optionLabel({
          harness: before,
          model: modelBefore,
          ...(accountBefore ? { account: accountBefore } : {}),
        });
      live.agent = null;
      live.external?.stop();
      live.external = null;
    }
    live.external?.configure({
      ...(patch.model ? { model: patch.model } : {}),
      ...(patch.mode ? { mode: patch.mode } : {}),
    });
    live.agent?.configure({
      ...(patch.model ? { modelId: patch.model } : {}),
      ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
      ...(patch.mode ? { mode: patch.mode } : {}),
    });
    if (live.stored.events.length) await this.save(live);
    return this.view(live);
  }

  /** Starts a turn; progress arrives as events. Resolves once the turn has started. */
  async send(
    root: string,
    id: string,
    text: string,
    attachments: Attachment[],
    /** Kovan going on by itself (delegated results), not the person writing. */
    automatic = false,
  ): Promise<void> {
    const live = await this.load(root, id);
    if (!automatic) live.delegations?.personWrote();
    if (this.isRunning(live)) throw new Error('The agent is still working. Stop it first or wait.');
    const paused = this.host.paused?.(root);
    if (paused) throw new Error(`This session is paused: ${paused}`);
    let prompt = live.stored.auto ? await this.autoPick(live, text, attachments) : text;
    // A new agent on this conversation saw none of it: its first prompt starts with what came before.
    const from = live.stored.handoffFrom;
    if (from && live.stored.events.some((e) => e.type === 'user')) {
      const context = this.laneContext(live.stored.id, 'the person moved this conversation to you');
      prompt = `${handoffNote({
        from,
        why: 'the person moved this conversation to you',
        lastPrompts: context.lastPrompts,
        lastReply: context.lastReply,
        touchedFiles: context.touchedFiles,
        unknownOutcomes: [],
      })}\n\nThe person's new message:\n${prompt}`;
    }
    delete live.stored.handoffFrom;
    const start = await this.readyTurn(live, root, prompt, attachments);
    this.recordPrompt(live, text, attachments);
    this.onAgentEvent(live, { type: 'payer', payer: payerOf(live) });
    const commands = await this.beforeBuildNeeded(live, root);
    if (!commands) {
      start();
      return;
    }
    void this.runBeforeBuild(live, root, commands).then((ok) => {
      if (ok) start();
    });
  }

  /**
   * Auto: JevRouter reads the prompt and picks who runs the conversation, from the person's
   * order, what is installed and what has usage left. The choice holds for the conversation; a
   * later "[jev: codex]" moves it. Returns the prompt without the agent directive.
   */
  private async autoPick(live: Live, text: string, attachments: Attachment[]): Promise<string> {
    const s = live.stored;
    const { agent: asked, cleaned } = parseAgentDirective(text);
    if (s.autoPicked && !asked) return text;

    const settings = await this.host.settings();
    const limits = await this.host.limits.list();
    // An agent named in the prompt can run even when the order leaves it out.
    const order =
      asked && !settings.agentOrder.some((o) => o.harness === asked)
        ? [...settings.agentOrder, defaultOption(asked)]
        : settings.agentOrder;
    const candidates = await Promise.all(
      order.map(async (step) => {
        const option = (await this.withAccount(step)) ?? step;
        const account = accountOf(option);
        return {
          option,
          agent: option.harness,
          model: option.model,
          account,
          usable: await this.usable(option),
          nearLimit: limits.find((l) => l.account === account)?.status === 'near',
        };
      }),
    );
    const canClassify = Boolean((await this.keys.openRouterKey()) ?? (await this.host.managed?.()));
    const messages: ChatMessage[] = [
      ...s.events.flatMap((e): ChatMessage[] =>
        e.type === 'user' ? [{ role: 'user', content: e.text }] : [],
      ),
      { role: 'user', content: cleaned },
    ];
    let classification = classifyByRules(messages);
    // The small model is asked only when the rules can't tell and someone can pay for the call.
    if (!asked && rulesUnsure(cleaned, classification) && canClassify) {
      const made = await this.client({ id: s.id, root: s.root, label: 'Auto' }).catch(() => null);
      const byModel = made ? await classifyByModel(made.client, CLASSIFIER_MODEL, messages) : null;
      if (byModel) {
        classification = byModel.classification;
        // Shown in the turn's receipt either way: with Kovan billing it is billed too, so the
        // receipt adds up to the invoice.
        if (byModel.usage)
          live.routingUsage = {
            type: 'usage',
            usage: byModel.usage,
            model: CLASSIFIER_MODEL,
            kind: 'routing',
            estimated: byModel.usage.cost === null,
          };
      }
    }
    const choice = chooseAgent({
      order: candidates,
      classification,
      takesImages: ['kovan'],
      hasImages: attachments.some((a) => a.kind === 'image'),
      asked,
    });
    if (!choice) {
      // Said before sending too; this is for a send that slipped past it.
      const why = await this.readiness({ auto: true, harness: 'kovan', model: s.model });
      throw new Error(why.ready ? 'Nothing in your order can start yet.' : why.why);
    }

    s.autoPicked = true;
    const from = s.harness ?? 'kovan';
    // Which sign-in of the agent: the ranked step's (one agent may be ranked with several).
    const picked = candidates.find((c) => c.account === choice.account && c.agent === choice.agent);
    const account = choice.agent === 'kovan' ? undefined : picked?.option.account;
    const moved = choice.agent !== from || choice.model !== s.model || account !== s.account;
    if (moved || s.events.length === 0 || asked) {
      if (moved) {
        if (s.events.some((e) => e.type === 'user'))
          s.handoffFrom ??= optionLabel({ harness: from, model: s.model });
        live.agent = null;
        live.external?.stop();
        live.external = null;
      }
      if (account !== s.account) this.forgetCliSession(s);
      s.harness = choice.agent;
      s.model = choice.model;
      s.account = account;
      s.effort = choice.agent === 'kovan' ? settings.agentEffort : null;
      live.external?.configure({ model: s.model });
      this.onAgentEvent(live, {
        type: 'auto',
        to: choice.agent,
        model: choice.model,
        reason: choice.reason,
      });
    }
    return cleaned;
  }

  /** Readies whichever agent runs the conversation; returns what starts the turn. */
  private readyTurn(
    live: Live,
    root: string,
    text: string,
    attachments: Attachment[],
  ): Promise<() => void> {
    const harness = live.stored.harness ?? 'kovan';
    return harness === 'kovan'
      ? this.kovanTurn(live, root, text, attachments)
      : this.externalTurn(live, harness, root, text, attachments);
  }

  private isRunning(live: Live): boolean {
    return Boolean(live.agent?.running || live.external?.running || live.preparing);
  }

  /** KOVAN.md's "Before Build" commands, when this conversation hasn't run them yet. */
  private async beforeBuildNeeded(live: Live, root: string): Promise<string[] | null> {
    if (live.stored.mode === 'plan') return null;
    const commands = await readBeforeBuild(root);
    if (commands.length === 0) return null;
    // Run once per conversation, and again whenever the commands change.
    const key = createHash('sha1').update(commands.join('\0')).digest('hex');
    return live.stored.beforeBuild === key ? null : commands;
  }

  /**
   * Runs the "Before Build" commands as tool rows of the turn. Outside Full mode each one asks
   * first: they come from the repository, and a cloned repository isn't necessarily trusted.
   */
  private async runBeforeBuild(live: Live, root: string, commands: string[]): Promise<boolean> {
    const s = live.stored;
    const abort = new AbortController();
    live.preparing = abort;
    const turnId = randomUUID();
    this.onAgentEvent(live, { type: 'turn_start', turnId, model: 'Before Build' });
    const fail = (reason: 'error' | 'stopped', error?: string) => {
      live.preparing = null;
      this.onAgentEvent(live, {
        type: 'turn_end',
        turnId,
        reason,
        cost: 0,
        ...(error ? { error } : {}),
      });
      return false;
    };
    for (const command of commands) {
      const id = randomUUID();
      const title = command.split('\n')[0]!;
      this.onAgentEvent(live, {
        type: 'tool_start',
        id,
        name: 'before_build',
        // Reads like Kovan's other rows: a verb, then what it acted on.
        summary: `Prepared ${title}${command.includes('\n') ? ' …' : ''}`,
        args: { command },
      });
      if (s.mode !== 'full') {
        const request: ApprovalRequest = {
          id,
          tool: 'before_build',
          kind: 'command',
          title: `Run this from ${RULES_FILE} before building?`,
          detail: command,
        };
        this.onAgentEvent(live, { type: 'approval', request });
        const approved = await this.waitForApproval(live, request);
        this.onAgentEvent(live, { type: 'approval_resolved', id, approved });
        if (!approved) {
          this.onAgentEvent(live, { type: 'tool_end', id, ok: false, output: 'Declined.' });
          if (abort.signal.aborted) return fail('stopped');
          return fail('error', `Declined a Before Build command, so the agent didn't start.`);
        }
      }
      const result = await runShell(command, root, {
        timeoutMs: 15 * 60_000,
        signal: abort.signal,
      });
      const ok = result.exitCode === 0;
      this.onAgentEvent(live, { type: 'tool_end', id, ok, output: result.output });
      if (abort.signal.aborted) return fail('stopped');
      if (!ok)
        return fail(
          'error',
          `Before Build failed: ${title} (${result.timedOut ? 'timed out' : `exit ${result.exitCode}`}). Fix it or edit ${RULES_FILE}, then send again.`,
        );
    }
    s.beforeBuild = createHash('sha1').update(commands.join('\0')).digest('hex');
    live.preparing = null;
    return true;
  }

  /** Readies Kovan's own agent for a turn; returns what starts it. */
  private async kovanTurn(
    live: Live,
    root: string,
    text: string,
    attachments: Attachment[],
  ): Promise<() => void> {
    const s = live.stored;
    const { streamer, price, managed } = await this.streamerFor(s.model, live, {
      id: s.id,
      root,
      label: s.title === 'New chat' ? text.split('\n')[0]!.slice(0, 120) : s.title,
    });
    live.managed = managed;

    if (!live.agent) {
      live.agent = new Agent(
        {
          model: streamer,
          modelId: s.model,
          effort: s.effort,
          mode: s.mode,
          root,
          isRepo: this.host.isRepo(root),
          systemPrompt: await buildSystemPrompt({
            root,
            name: basename(root),
            isRepo: this.host.isRepo(root),
          }),
          approve: (request) => this.waitForApproval(live, request),
          onEvent: (event) => this.onAgentEvent(live, event),
          price,
          // The team's tools and memory, read fresh each turn.
          extraTools: [
            ...this.host.team.harnessTools(() => this.caller(live)),
            ...(this.host.tools?.(s.id, root) ?? []),
            ...(this.host.delegate && s.session ? [this.delegationsOf(live).tool()] : []),
          ],
          turnContext: () => this.host.team.turnNote(this.caller(live)),
          // A write that collides with another live session's work is held once, with why.
          // Near this, the older part of the conversation is summarized (catalog's numbers).
          contextWindow: (model) =>
            this.catalog?.models.find((m) => m.id === model)?.contextLength || null,
          checkWrite: async (path) =>
            (await this.host.team.checkWrite?.(this.caller(live), path)) ?? null,
          skills: () => this.host.skills?.(root) ?? Promise.resolve(null),
          turnTools: () =>
            this.host.mcpTools?.(root, (q) => this.askTrust(live, q)) ?? Promise.resolve([]),
        },
        s.messages,
      );
    } else {
      live.agent.configure({ model: streamer, modelId: s.model, effort: s.effort, mode: s.mode });
    }

    const agent = live.agent;
    const content: string | ContentPart[] = attachments.length
      ? [
          { type: 'text', text },
          ...attachments.map((a): ContentPart =>
            a.kind === 'image'
              ? { type: 'image_url', image_url: { url: a.content } }
              : { type: 'text', text: `Attached file ${a.name}:\n\n${a.content}` },
          ),
        ]
      : text;
    return () => void agent.send(content).finally(() => void this.save(live));
  }

  /** The model client for a model id (custom provider, JevRouter or OpenRouter) and its prices. */
  private async streamerFor(
    model: string,
    live: Pick<Live, 'router' | 'routerKey'> | null,
    run: { id: string; root: string; label: string },
  ): Promise<{
    streamer: ModelStreamer;
    price: (modelId: string, usage: Parameters<typeof estimateCost>[1]) => number | null;
    /** Billed through Kovan's managed usage (the server files it, not this app). */
    managed: boolean;
  }> {
    const catalog = await this.models().catch(() => [] as ModelInfo[]);
    const custom = await this.custom.resolve(model);
    let streamer: ModelStreamer;
    let managed = false;
    if (custom) {
      // A custom provider gets its own client and the server's own model id.
      streamer = {
        stream: (request, signal) =>
          custom.client.stream({ ...request, model: custom.model }, signal),
      };
    } else {
      const made = await this.client(run);
      const client = made.client;
      managed = made.managed;
      streamer = client;
      // JevRouter stands in for the model when it's chosen; it streams through the same client.
      if (model === JEV_MODEL_ID) {
        const pool = catalog.filter((m) => !parseCustomModelId(m.id));
        if (pool.length === 0)
          throw new Error(
            "Automatic model choice (JevRouter) needs the list of models, and it couldn't be loaded. Check your connection, and that Kovan billing or your OpenRouter key is set up.",
          );
        // A router keeps its client; a new one comes when the billing source changes, or the
        // folder became (part of) a shared workspace since, so usage is filed under it.
        const key = `${managed}:${(run && (await this.host.workspaceOf?.(run.root))) ?? ''}`;
        const router =
          live?.router && live.routerKey === key
            ? live.router
            : new JevRouter({ client, catalog: pool, classifierModel: CLASSIFIER_MODEL });
        if (live) {
          live.router = router;
          live.routerKey = key;
        }
        streamer = router;
      }
    }
    const price = (modelId: string, usage: Parameters<typeof estimateCost>[1]) => {
      const info = catalog.find((m) => m.id === modelId);
      return info ? estimateCost(info, usage) : null;
    };
    return { streamer, price, managed };
  }

  /**
   * Runs Kovan's agent on one task in `root`, outside any conversation (a subagent in its own
   * worktree). Usage is filed like any other turn. Resolves when the turn ends.
   */
  async runDetached(run: DetachedRun): Promise<Extract<AgentEvent, { type: 'turn_end' }>> {
    const runId = `run-${randomUUID()}`;
    const { streamer, price, managed } = await this.streamerFor(run.model, null, {
      id: runId,
      root: run.root,
      label:
        run.task
          .split('\n')
          .find((l) => l.startsWith('Your task:'))
          ?.slice(11) ?? 'Subagent',
    });
    let end: Extract<AgentEvent, { type: 'turn_end' }> | null = null;
    const events: ConversationEvent[] = [];
    const agent = new Agent({
      model: streamer,
      modelId: run.model,
      effort: run.effort,
      mode: run.mode,
      root: run.root,
      isRepo: true,
      systemPrompt: await buildSystemPrompt({
        root: run.root,
        name: basename(run.root),
        isRepo: true,
      }),
      approve: run.approve,
      ...(run.tools ? { extraTools: run.tools } : {}),
      // Swarm agents, subagents and AI teammates get the same skills.
      skills: () => this.host.skills?.(run.root) ?? Promise.resolve(null),
      turnTools: () => this.host.mcpTools?.(run.root) ?? Promise.resolve([]),
      // A swarm's run: its check before each write, and the team's work between steps.
      ...(run.checkWrite ? { checkWrite: run.checkWrite } : {}),
      ...(run.turnContext ? { turnContext: run.turnContext } : {}),
      onEvent: (event) => {
        if (event.type !== 'tool_progress') events.push(event);
        if (event.type === 'turn_end') end = event;
        run.onEvent(event);
      },
      price,
    });
    run.signal.addEventListener('abort', () => agent.stop(), { once: true });
    run.onAgent?.(agent);
    await agent.send(run.task);
    const receipt = foldEvents(events).findLast((i) => i.kind === 'end');
    if (
      receipt?.kind === 'end' &&
      receipt.receipt.length &&
      !parseCustomModelId(run.model) &&
      !managed
    )
      this.host.reportUsage(run.root, runId, receipt.receipt);
    return (
      end ?? {
        type: 'turn_end',
        turnId: '',
        reason: 'error',
        cost: 0,
        error: 'The agent did not finish',
      }
    );
  }

  private recordPrompt(live: Live, text: string, attachments: Attachment[]): void {
    const s = live.stored;
    // The first prompt names the conversation (Auto's note may already be there).
    if (!s.events.some((e) => e.type === 'user'))
      s.title = parseAgentDirective(text).cleaned.split('\n')[0]!.slice(0, 80) || 'New chat';
    const userEvent: ConversationEvent = {
      type: 'user',
      text,
      attachments: attachments.map((a) => a.name),
      at: Date.now(),
    };
    s.events.push(userEvent);
    s.updatedAt = userEvent.at;
    this.emit(live, userEvent);
    // Save now so the conversation shows in the list while its first turn is still running.
    void this.save(live);
  }

  /** Readies the user's Claude Code or Codex, connected back to Kovan over MCP, for a turn. */
  private async externalTurn(
    live: Live,
    harness: ExternalHarness,
    root: string,
    text: string,
    attachments: Attachment[],
  ): Promise<() => void> {
    const s = live.stored;
    if (!live.external) {
      const binary = await this.host.agentBinary(harness);
      if (!binary)
        throw new Error(
          `${HARNESS_NAMES[harness]} is not installed on this machine. Install it, then pick it again.`,
        );
      s.account ??= await this.host.firstAccount?.(harness);
      if (!s.account)
        throw new Error(
          `Add a ${HARNESS_NAMES[harness]} account first, in Settings → Agents → Accounts. Kovan only runs ${HARNESS_NAMES[harness]} as an account you added there.`,
        );
      const env = await this.host.accountEnv?.(harness, s.account);
      if (!env)
        throw new Error(
          `That ${HARNESS_NAMES[harness]} account isn't on this machine any more. Pick another in the agent menu, or add it again in Settings → Agents.`,
        );
      const account = accountOf({ harness, model: s.model, account: s.account });
      const common = {
        binary,
        root,
        model: s.model,
        mode: s.mode,
        env,
        onEvent: (event: AgentEvent) => this.onAgentEvent(live, event),
        onLimit: (info: Record<string, unknown>) =>
          void this.host.limits.report(
            account,
            harness === 'claude-code' ? claudeLimit(info) : codexLimit(info),
          ),
        pathEnv: await this.host.pathEnv(),
      };
      live.external =
        harness === 'claude-code'
          ? new ClaudeCodeRunner({
              ...common,
              mcpConfigFile: await this.host.mcpConfig(s.id, root),
              sessionId: s.claudeSessionId ?? null,
              onSession: (sessionId) => {
                s.claudeSessionId = sessionId;
              },
            })
          : // Codex's app server takes teammates' messages mid-turn; older Codex runs `exec`.
            new ((await codexHasAppServer(binary, common.pathEnv))
              ? CodexAppServerRunner
              : CodexRunner)({
              ...common,
              mcpServer: this.host.mcpServer(s.id, root),
              threadId: s.codexThreadId ?? null,
              onThread: (threadId) => {
                s.codexThreadId = threadId;
              },
            });
    }
    const runner = live.external;
    // Both CLIs take text here; Markdown files go inline and images are left out (the UI says so).
    const content = [
      text,
      ...attachments
        .filter((a) => a.kind === 'markdown')
        .map((a) => `Attached file ${a.name}:\n\n${a.content}`),
    ].join('\n\n');
    return () => void runner.send(content).finally(() => void this.save(live));
  }

  /**
   * A permission prompt from a Kovan-launched Claude Code (via the MCP bridge): shows an approval
   * card in that conversation and waits for the person.
   */
  has(conversationId: string): boolean {
    return this.live.has(conversationId);
  }

  async approvalFromAgent(
    conversationId: string,
    toolName: string,
    input: Record<string, unknown>,
    toolUseId: string | null,
  ): Promise<boolean> {
    const live = this.live.get(conversationId);
    if (!live) return false;
    const id = toolUseId ?? randomUUID();
    const isCommand = toolName === 'Bash';
    const isEdit = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(toolName);
    // Someone else's tool, like Kovan's own MCP card: server · tool, secret values hidden.
    const mcp = /^mcp__([^_].*?)__(.+)$/.exec(toolName);
    // "Always allow" chosen on an earlier card holds in this lane too.
    if (mcp && (await this.host.settings()).mcpAlwaysAllow.includes(toolName)) return true;
    const request: ApprovalRequest = {
      id,
      tool: toolName,
      kind: isCommand ? 'command' : isEdit ? 'edit' : mcp ? 'external' : 'read',
      title: isCommand
        ? 'Run this?'
        : isEdit
          ? 'Make this edit?'
          : mcp
            ? 'Use this tool?'
            : `Allow ${toolName}?`,
      detail: isCommand
        ? String(input['command'] ?? '')
        : isEdit
          ? `${String(input['file_path'] ?? '')}\n${String(input['new_string'] ?? input['content'] ?? '').slice(0, 2000)}`
          : mcp
            ? `${mcp[1]} · ${mcp[2]}\n${JSON.stringify(maskSecrets(input), null, 2)}`.slice(0, 2000)
            : JSON.stringify(input, null, 2).slice(0, 2000),
      ...(typeof input['file_path'] === 'string'
        ? { path: input['file_path'].replace(`${live.stored.root}/`, '') }
        : {}),
    };
    this.onAgentEvent(live, { type: 'approval', request });
    const approved = await this.waitForApproval(live, request);
    this.onAgentEvent(live, { type: 'approval_resolved', id, approved });
    return approved;
  }

  /**
   * A card Kovan itself raises in a conversation (an issue about to be created): a row, the
   * question, the person's answer with any edits. `finish` closes the row with what happened.
   */
  async card(
    conversationId: string,
    card: { name: string; summary: string; request: Omit<ApprovalRequest, 'id'> },
  ): Promise<{
    approved: boolean;
    edits: IssueEdits | null;
    finish(ok: boolean, output: string): void;
  } | null> {
    const live = this.live.get(conversationId);
    if (!live) return null;
    const id = randomUUID();
    const request: ApprovalRequest = { ...card.request, id };
    this.onAgentEvent(live, {
      type: 'tool_start',
      id,
      name: card.name,
      summary: card.summary,
      args: {},
    });
    this.onAgentEvent(live, { type: 'approval', request });
    const approved = await this.waitForApproval(live, request);
    const edits = live.edits.get(id) ?? null;
    live.edits.delete(id);
    this.onAgentEvent(live, { type: 'approval_resolved', id, approved });
    return {
      approved,
      edits,
      finish: (ok, output) => this.onAgentEvent(live, { type: 'tool_end', id, ok, output }),
    };
  }

  private onAgentEvent(live: Live, event: ConversationEvent): void {
    const s = live.stored;
    // An edit being typed: shown live, not kept (the finished edit is in the tool row).
    if (event.type === 'tool_progress') {
      this.emit(live, event);
      return;
    }
    s.events.push(event);
    s.updatedAt = Date.now();
    // Auto's classifier call belongs to the turn it routed.
    if (event.type === 'turn_start' && live.routingUsage) {
      const usage = live.routingUsage;
      delete live.routingUsage;
      this.onAgentEvent(live, usage);
    }
    if (event.type === 'turn_end') {
      s.cost += event.cost;
      const turnStart = s.events.findLastIndex((e) => e.type === 'turn_start');
      const receipt = foldEvents(s.events.slice(turnStart)).findLast((i) => i.kind === 'end');
      // Claude Code, Codex and custom providers bill the person's own account; only OpenRouter
      // calls through Kovan's agent are filed as usage.
      // Managed usage is filed by the server itself.
      const ownBilling =
        (s.harness ?? 'kovan') !== 'kovan' ||
        parseCustomModelId(s.model) !== null ||
        live.managed === true;
      if (receipt?.kind === 'end' && receipt.receipt.length && !ownBilling)
        this.host.reportUsage(s.root, s.id, receipt.receipt);
      const what =
        event.reason === 'error'
          ? `Stopped with an error: ${event.error}`
          : event.reason === 'stopped'
            ? 'Stopped.'
            : 'Finished.';
      this.host.notify(s.title, what);
    }
    if (event.type === 'approval')
      this.host.notify(
        'Your agent needs approval',
        event.request.detail.split('\n')[0]!.slice(0, 120),
      );
    // Save before announcing the end of a turn, so anything reloading the list sees the new title and cost.
    if (event.type === 'turn_end') {
      void this.save(live).finally(() => {
        this.emit(live, event);
        this.afterTurn(live, event);
      });
      return;
    }
    this.emit(live, event);
  }

  /** To this window, and to the team when the conversation is a session lane. */
  private emit(live: Live, event: ConversationEvent): void {
    const s = live.stored;
    this.host.emit(s.id, event);
    if (!s.session) return;
    let touched: string[] = [];
    if (event.type === 'tool_start')
      live.toolArgs.set(event.id, { name: event.name, args: event.args });
    if (event.type === 'tool_end') {
      const call = live.toolArgs.get(event.id);
      live.toolArgs.delete(event.id);
      if (call && event.ok)
        touched = changedPaths(call.name, call.args).map((p) =>
          p.startsWith(`${s.root}/`) ? p.slice(s.root.length + 1) : p,
        );
    }
    this.host.mirror(s.session, forTeam(event, s.root), touched, s.root);
  }

  /**
   * After a turn. An account that ran out hands the conversation to the next agent in the
   * person's chain; with nobody left, a session lane goes up for takeover. Every turn end is a
   * safe checkpoint, so a lane's work so far is snapshotted for whoever continues it.
   */
  private delegationsOf(live: Live): Delegations {
    live.delegations ??= new Delegations({
      delegate: (task, onSettled) => this.host.delegate!(live.stored.id, task, onSettled),
      running: () => this.isRunning(live),
      notice: (text) => this.notice(live, 'info', text),
      resume: (text) => this.send(live.stored.root, live.stored.id, text, [], true),
    });
    return live.delegations;
  }

  private afterTurn(live: Live, event: Extract<AgentEvent, { type: 'turn_end' }>): void {
    // Delegated work still running (or just finished): wait, or go on with it.
    queueMicrotask(() => live.delegations?.check());
    const ranOut = event.reason === 'error' && event.error && isUsageLimit(event.error);
    if (!ranOut) {
      this.settle(live, null);
      return;
    }
    const reason = event.error!.slice(0, 300);
    void this.failover(live, reason)
      .catch((error: unknown) => {
        this.notice(
          live,
          'warn',
          `Couldn't hand the task to the next agent: ${String((error as Error).message ?? error).replace(/[.!]?\s*$/, '.')} The task isn't finished: send it again, or pick another agent below.`,
        );
        return false;
      })
      .then((continued) => {
        if (continued) return;
        this.settle(live, reason);
        // Whatever showed it as working (a reload during the switch) learns it stopped.
        this.host.emit(live.stored.id, { type: 'idle' });
      });
  }

  /** The conversation is idle: waiters go on, and a session lane reports and snapshots. */
  private settle(live: Live, ranOut: string | null): void {
    for (const resolve of live.idle.splice(0)) resolve();
    const session = live.stored.session;
    if (!session) return;
    this.host.laneIdle?.(session.id, live.stored.root);
    if (ranOut) this.onAgentEvent(live, { type: 'limit_hit', reason: ranOut });
    if (this.host.isRepo(live.stored.root))
      void this.host
        .snapshot(session, live.stored.root)
        .then((snap) => snap && this.onAgentEvent(live, { type: 'snapshot', ...snap }))
        .catch(() => undefined);
  }

  private notice(live: Live, tone: 'info' | 'warn', text: string): void {
    this.onAgentEvent(live, { type: 'notice', tone, text });
  }

  /**
   * Claude Code and Codex run only as an account the person added: a step that names none takes
   * the first one added for that agent. Null when there is none.
   */
  private async withAccount(option: AgentOption): Promise<AgentOption | null> {
    if (option.harness === 'kovan' || option.account) return option;
    return withAccount(option, await this.host.firstAccount?.(option.harness));
  }

  /**
   * Why a step of the order can't take a turn now, in words for the person, and where that is
   * fixed; null when it can. The same checks as `usable`, said instead of answered.
   */
  private async whyNot(step: AgentOption): Promise<{ why: string; fix: ReadyFix } | null> {
    if (step.harness !== 'kovan') {
      const name = HARNESS_NAMES[step.harness];
      const option = await this.withAccount(step);
      if (!option)
        return {
          why: mt(
            "{name} isn't set up in Kovan yet. In Settings → Agents, use this computer's {name} sign-in, or add a separate account.",
            { name },
          ),
          fix: 'accounts',
        };
      if (!(await this.host.limits.open(accountOf(option))))
        return { why: mt('{name} is out of usage for now.', { name }), fix: 'wait' };
      const harness = step.harness;
      if (!(await this.host.accountEnv?.(harness, option.account)))
        return {
          why: mt("{name}'s account in Kovan needs signing in again.", { name }),
          fix: 'accounts',
        };
      if ((await this.host.agentBinary(harness)) === null)
        return { why: mt("{name} isn't installed on this computer.", { name }), fix: 'install' };
      return null;
    }
    if (!(await this.host.limits.open(accountOf(step))))
      return {
        why: mt('{name} is out of usage for now.', { name: optionLabel(step) }),
        fix: 'wait',
      };
    const custom = parseCustomModelId(step.model);
    if (custom)
      return (await this.custom.list()).some((p) => p.id === custom.provider)
        ? null
        : {
            why: mt('The provider "{name}" isn\'t set up any more.', { name: custom.provider }),
            fix: 'provider',
          };
    if ((await this.keys.openRouterKey()) || (await this.host.managed?.())) return null;
    const managed = await this.host.managedWhyNot?.();
    if (managed && !/doesn't (offer|sell)/.test(managed))
      return {
        why: mt("Kovan's agent needs a model to call. {why}", { why: managed }),
        fix: 'billing',
      };
    return {
      why: mt(
        "Kovan's agent needs a model to call: add your OpenRouter key, or a provider of your own.",
      ),
      fix: 'provider',
    };
  }

  /**
   * Whether a conversation set up like this can take a turn now; on Auto, whether anything in the
   * order can. Asked before sending, so a first message never fails for a missing account.
   */
  async readiness(choice: {
    auto: boolean;
    harness: Harness;
    model: string;
    account?: string | undefined;
  }): Promise<Readiness> {
    if (!choice.auto) {
      const why = await this.whyNot({
        harness: choice.harness,
        model: choice.model,
        ...(choice.account ? { account: choice.account } : {}),
      });
      return why ? { ready: false, ...why } : { ready: true };
    }
    const reasons: { why: string; fix: ReadyFix }[] = [];
    for (const step of (await this.host.settings()).agentOrder) {
      const why = await this.whyNot(step);
      if (!why) return { ready: true };
      reasons.push(why);
    }
    if (reasons.length === 0)
      return {
        ready: false,
        why: mt('Auto has nothing to pick from: your order is empty.'),
        fix: 'order',
      };
    // The quickest way to a working agent first: a model for Kovan's own, then an account.
    const best =
      reasons.find((r) => r.fix === 'billing') ??
      reasons.find((r) => r.fix === 'provider') ??
      reasons[0]!;
    return {
      ready: false,
      why: mt('Nothing in your order can start yet. {why}', { why: best.why }),
      fix: best.fix,
    };
  }

  /**
   * Who pays for a step's turns: a subscription account (Claude Code, Codex), a gateway of your
   * own, Kovan managed usage or your OpenRouter key. `label` says it to the person.
   */
  private async payerOf(option: AgentOption): Promise<{ id: string; label: string }> {
    if (option.harness !== 'kovan')
      return {
        id: `account:${option.harness}:${option.account ?? ''}`,
        label: `your ${HARNESS_NAMES[option.harness]} account`,
      };
    const custom = parseCustomModelId(option.model);
    if (custom) {
      const name = (await this.custom.list()).find((p) => p.id === custom.provider)?.name;
      return {
        id: `provider:${custom.provider}`,
        label: `your ${name ?? custom.provider} account`,
      };
    }
    return (await this.host.managed?.())
      ? { id: 'managed', label: 'Kovan billing (what the model costs × 1.05)' }
      : { id: 'openrouter', label: 'your OpenRouter key' };
  }

  /** Whether a step of the order can take a turn now: installed (or keyed), not out of usage. */
  private async usable(step: AgentOption): Promise<boolean> {
    const option = await this.withAccount(step);
    if (!option) return false;
    if (!(await this.host.limits.open(accountOf(option)))) return false;
    if (option.harness !== 'kovan') {
      if (!(await this.host.accountEnv?.(option.harness, option.account))) return false;
      return (await this.host.agentBinary(option.harness)) !== null;
    }
    const custom = parseCustomModelId(option.model);
    if (custom) return (await this.custom.list()).some((p) => p.id === custom.provider);
    return Boolean((await this.keys.openRouterKey()) ?? (await this.host.managed?.()));
  }

  /**
   * The conversation's agent ran out: continues the same conversation with the next agent in
   * the chain, told what was asked, what was done and what must not be repeated. Resolves false
   * when nothing took over.
   */
  private async failover(live: Live, reason: string): Promise<boolean> {
    const s = live.stored;
    const from: AgentOption = { harness: s.harness ?? 'kovan', model: s.model, account: s.account };
    const limit = await this.host.limits.full(
      accountOf(from),
      reason,
      resetFromMessage(reason, Date.now()),
    );
    const settings = await this.host.settings();
    if (!settings.agentFailover) return false;

    const usable = new Map<AgentOption, boolean>();
    for (const o of settings.agentOrder) usable.set(o, await this.usable(o));
    const step = nextOption(settings.agentOrder, from, (o) => usable.get(o) === true);
    const to = step && ((await this.withAccount(step)) ?? step);
    if (!to) {
      if (!s.session)
        this.notice(
          live,
          'warn',
          `${optionLabel(from)} ran out and nothing else in your order is ready. Add a step in Settings → Agents, or wait for it to open again.`,
        );
      return false;
    }
    // Held as "running" while it switches, so a prompt can't slip in and Stop works.
    const abort = new AbortController();
    live.preparing = abort;
    try {
      // The person decides where the conversation goes on: each ready agent in turn, the
      // next in their order first. A step onto pay-per-use models by someone other than who
      // paid so far also says who pays, and its yes counts as the consent for that payer.
      const candidates: AgentOption[] = [step!];
      for (const o of settings.agentOrder)
        if (
          usable.get(o) === true &&
          !sameOption(o, from) &&
          !candidates.some((c) => sameOption(c, o))
        )
          candidates.push(o);
      const choose = settings.agentFailoverChoose !== false;
      const fromPayer = await this.payerOf(from);
      let chosen: AgentOption | null = null;
      for (let i = 0; i < candidates.length; i++) {
        const cand = (await this.withAccount(candidates[i]!)) ?? candidates[i]!;
        const candLabel = optionLabel(cand);
        const candPayer = await this.payerOf(cand);
        const paidAsk =
          cand.harness === 'kovan' &&
          candPayer.id !== fromPayer.id &&
          settings.agentFailoverAskPaid &&
          !s.paidSwitchOk &&
          !s.paidSwitchOkFor?.includes(candPayer.id);
        if (!choose && !paidAsk) {
          chosen = cand;
          break;
        }
        const id = randomUUID();
        const others = candidates
          .slice(i + 1)
          .map((o) => optionLabel(o))
          .join(', ');
        this.onAgentEvent(live, {
          type: 'tool_start',
          id,
          name: 'switch_agent',
          summary: `Switching to ${candLabel}`,
          args: { from: from.harness, to: cand.harness, model: cand.model },
        });
        const request: ApprovalRequest = {
          id,
          tool: 'switch_agent',
          kind: 'command',
          title: `${optionLabel(from)} ran out. Continue with ${candLabel}?`,
          detail: [
            paidAsk
              ? `${candLabel} uses models paid by use, through ${candPayer.label}.${cand.model === JEV_MODEL_ID ? ' JevRouter picks the model.' : ''}`
              : `${candLabel} is next in your order.`,
            others ? `If not, you'll be asked about: ${others}.` : 'It is the last one ready.',
            'You can change this in Settings → Agents.',
          ].join(' '),
        };
        this.onAgentEvent(live, { type: 'approval', request });
        const approved = await this.waitForApproval(live, request);
        this.onAgentEvent(live, { type: 'approval_resolved', id, approved });
        this.onAgentEvent(live, {
          type: 'tool_end',
          id,
          ok: approved,
          output: approved ? `Continuing with ${candLabel}.` : 'Declined.',
        });
        if (abort.signal.aborted) return false;
        if (approved) {
          if (paidAsk) s.paidSwitchOkFor = [...(s.paidSwitchOkFor ?? []), candPayer.id];
          chosen = cand;
          break;
        }
        if (!choose) return false;
      }
      if (!chosen) {
        this.notice(
          live,
          'info',
          `${optionLabel(from)} ran out and you chose not to continue elsewhere. Send the task again when it opens, or pick an agent yourself.`,
        );
        return false;
      }
      const to = chosen;

      const context = this.laneContext(s.id, reason);
      const turnStart = s.events.findLastIndex((e) => e.type === 'turn_start');
      const note = handoffNote({
        from: optionLabel(from),
        why: 'its account reached a usage limit',
        lastPrompts: context.lastPrompts,
        lastReply: context.lastReply,
        touchedFiles: context.touchedFiles,
        unknownOutcomes: s.events
          .slice(Math.max(0, turnStart))
          .flatMap((e) => (e.type === 'outcome_unknown' ? [e.command] : [])),
      });

      // Another account (even of the same agent) has none of this one's CLI session.
      if (to.harness !== from.harness || to.account !== from.account) this.forgetCliSession(s);
      s.harness = to.harness;
      s.model = to.model;
      s.account = to.harness === 'kovan' ? undefined : to.account;
      s.effort = to.harness === 'kovan' ? settings.agentEffort : null;
      live.agent = null;
      live.external = null;
      this.onAgentEvent(live, {
        type: 'switch',
        from: from.harness,
        to: to.harness,
        model: to.model,
        fromModel: from.model,
        reason: 'usage limit reached',
        resetsAt: limit.resetsAt,
      });
      const start = await this.readyTurn(live, s.root, note, []);
      if (abort.signal.aborted) return false;
      live.preparing = null;
      // The receipt that follows names who pays now, not the agent that ran out.
      this.onAgentEvent(live, { type: 'payer', payer: payerOf(live) });
      start();
      return true;
    } finally {
      if (live.preparing === abort) live.preparing = null;
    }
  }

  /** The CLI's own session lives with the account that made it: another account starts afresh. */
  private forgetCliSession(s: StoredConversation): void {
    delete s.claudeSessionId;
    delete s.codexThreadId;
  }

  /** Resolves once the conversation has no turn running. */
  idle(conversationId: string): Promise<void> {
    const live = this.live.get(conversationId);
    if (!live || !this.isRunning(live)) return Promise.resolve();
    return new Promise((resolve) => live.idle.push(resolve));
  }

  /**
   * Guidance for the running turn. Kovan's agent takes it before its next step, Codex and
   * Claude Code in the running turn too (their runners say when it arrived); otherwise it
   * comes back at once.
   */
  steer(
    conversationId: string,
    steer: { id: string; text: string; fromUserId?: string; fromName?: string },
  ): boolean {
    const live = this.live.get(conversationId);
    if (live?.agent?.steer(steer)) return true;
    if (live?.external?.running && live.external.steer?.(steer)) return true;
    if (live) this.onAgentEvent(live, { type: 'steer', ...steer, status: 'returned' });
    return false;
  }

  /**
   * Calling an AI teammate in with @ from a session conversation: the session, and the
   * conversation as the teammate reads it.
   */
  async mentionContext(
    root: string,
    conversationId: string,
    person: string,
  ): Promise<{ sessionId: string; context: string | null }> {
    const s = (await this.load(root, conversationId)).stored;
    if (!s.session) throw new Error('Call a teammate in from a session: open one and take a lane.');
    return { sessionId: s.session.id, context: conversationDigest(s.events, person) };
  }

  /** Keeps a call to a teammate in the conversation (the team sees it in the lane too). */
  async recordMention(
    root: string,
    conversationId: string,
    mention: { agentId: string; name: string; text: string; requestId: string },
  ): Promise<void> {
    const live = await this.load(root, conversationId);
    this.onAgentEvent(live, { type: 'mention', ...mention, at: Date.now() });
    await this.save(live);
  }

  /** Stops at a safe checkpoint (Kovan's agent finishes the action in flight first). */
  async stopAtCheckpoint(conversationId: string): Promise<void> {
    const live = this.live.get(conversationId);
    if (!live || !this.isRunning(live)) return;
    if (live.agent?.running) live.agent.stopAtCheckpoint();
    else this.stop(conversationId);
    await this.idle(conversationId);
  }

  /** What someone continuing this lane needs: the last prompts, the last reply, files touched. */
  laneContext(
    conversationId: string,
    reason: string,
  ): {
    lastPrompts: string[];
    lastReply: string | null;
    touchedFiles: string[];
    reason: string;
  } {
    const events = this.live.get(conversationId)?.stored.events ?? [];
    const prompts = events.flatMap((e) => (e.type === 'user' ? [e.text.slice(0, 2000)] : []));
    const items = foldEvents(events);
    const reply = items.findLast((i) => i.kind === 'text');
    const touched = new Set<string>();
    for (const i of items)
      if (i.kind === 'tool' && i.meta?.path && /^(Edited|Wrote|Created)/.test(i.summary))
        touched.add(i.meta.path);
    return {
      lastPrompts: prompts.slice(-3),
      lastReply: reply?.kind === 'text' ? reply.text.slice(0, 4000) : null,
      touchedFiles: [...touched].slice(0, 30),
      reason,
    };
  }

  /** Whether a conversation has a turn running now. */
  running(conversationId: string): boolean {
    const live = this.live.get(conversationId);
    return live ? this.isRunning(live) : false;
  }

  /** The folder a live conversation works in. */
  rootOf(conversationId: string): string | null {
    return this.live.get(conversationId)?.stored.root ?? null;
  }

  /** The live lane conversation for a session in this window, if any. */
  laneConversation(sessionId: string): string | null {
    for (const [id, live] of this.live) if (live.stored.session?.id === sessionId) return id;
    return null;
  }

  /** The person's lane conversation for a session in this workspace, if there is one. */
  async laneOf(root: string, sessionId: string): Promise<Conversation | null> {
    for (const live of this.live.values())
      if (live.stored.session?.id === sessionId && live.stored.root === root)
        return this.view(live);
    const found = (await this.list(root)).find((c) => c.session?.id === sessionId);
    return found ? this.open(root, found.id) : null;
  }

  /** Who an agent works for, as the team tools see it. */
  private caller(live: Live): TeamCaller {
    const s = live.stored;
    const harness = s.harness ?? 'kovan';
    const model = s.model === JEV_MODEL_ID ? 'JevRouter' : s.model === 'default' ? null : s.model;
    return {
      root: s.root,
      session: s.session ?? null,
      agent: model ? `${HARNESS_NAMES[harness]} · ${model}` : HARNESS_NAMES[harness],
    };
  }

  callerOf(conversationId: string): TeamCaller | null {
    const live = this.live.get(conversationId);
    return live ? this.caller(live) : null;
  }

  /** A conversation's model settings and checkout, for a subagent it starts. */
  configOf(conversationId: string):
    | (Omit<ConversationConfig, 'harness'> & {
        harness: ConversationConfig['harness'] | undefined;
        root: string;
        session: SessionLink | null;
      })
    | null {
    const s = this.live.get(conversationId)?.stored;
    if (!s) return null;
    return {
      harness: s.harness,
      model: s.model,
      effort: s.effort,
      mode: s.mode,
      root: s.root,
      session: s.session ?? null,
    };
  }

  sessionOf(conversationId: string): SessionLink | null {
    return this.live.get(conversationId)?.stored.session ?? null;
  }

  /** A teammate answered this lane's approval card through the Brain. */
  /** A teammate the person called in with @ is at work, or answered: into their lane conversation. */
  teammateReply(
    sessionId: string,
    reply: Omit<Extract<ConversationEvent, { type: 'teammate' }>, 'type' | 'at'>,
    asked: string | null,
  ): void {
    for (const live of this.live.values())
      if (live.stored.session?.id === sessionId) {
        // Called from the phone: the call goes in first, so the answer has its question.
        const seen = live.stored.events.some(
          (e) => e.type === 'mention' && e.requestId === reply.requestId,
        );
        if (asked && !seen)
          this.onAgentEvent(live, {
            type: 'mention',
            agentId: reply.agentId,
            name: reply.name,
            text: asked,
            requestId: reply.requestId,
            at: Date.now(),
          });
        this.onAgentEvent(live, { type: 'teammate', ...reply, at: Date.now() });
        void this.save(live);
      }
  }

  /**
   * A teammate (or this person, from another device) answered a lane approval. Who it was is
   * kept in the lane, beside the step, so everyone (the owner first) can see it.
   */
  answerFromTeam(
    sessionId: string,
    requestId: string,
    approved: boolean,
    by: string | null = null,
  ): void {
    for (const [id, live] of this.live)
      if (live.stored.session?.id === sessionId && live.pending.has(requestId)) {
        if (by) this.notice(live, 'info', `${by} ${approved ? 'approved' : 'denied'} this step.`);
        this.approve(id, requestId, approved);
      }
  }

  /**
   * A repository's MCP server wants to start: a row in the turn with the card (once / always /
   * no; the card saves "always" and "no" itself). Asked in every mode: it is code the
   * repository brings, not something the agent decided to run.
   */
  private async askTrust(live: Live, q: TrustQuestion): Promise<boolean> {
    const id = randomUUID();
    this.onAgentEvent(live, {
      type: 'tool_start',
      id,
      name: 'mcp_trust',
      summary: `Started ${q.label} from ${q.origin === 'plugin' ? `plugin ${q.file}` : q.file}`,
      args: { server: q.name, file: q.file },
    });
    const request: ApprovalRequest = {
      id,
      tool: 'mcp_trust',
      kind: 'external',
      title:
        q.origin === 'plugin'
          ? `The plugin "${q.file}" wants to start its MCP server "${q.label}"`
          : `This repository wants to start the MCP server "${q.name}"`,
      detail:
        q.origin === 'plugin'
          ? `${q.detail}\n\nFrom the plugin ${q.file}. Its tools would be available to agents where the plugin is on.`
          : `${q.detail}\n\nFrom ${q.file}. Its tools would be available to agents in this repository.`,
      trustKey: q.key,
    };
    this.onAgentEvent(live, { type: 'approval', request });
    const approved = await this.waitForApproval(live, request);
    this.onAgentEvent(live, { type: 'approval_resolved', id, approved });
    this.onAgentEvent(live, {
      type: 'tool_end',
      id,
      ok: approved,
      output: approved ? `Allowed ${q.name}.` : `Didn't start ${q.name}.`,
    });
    return approved;
  }

  private waitForApproval(live: Live, request: ApprovalRequest): Promise<boolean> {
    return new Promise((resolve) => live.pending.set(request.id, resolve));
  }

  approve(id: string, approvalId: string, approved: boolean, edits?: IssueEdits): void {
    const live = this.live.get(id);
    const resolve = live?.pending.get(approvalId);
    if (!resolve) return;
    if (approved && edits) live!.edits.set(approvalId, edits);
    live!.pending.delete(approvalId);
    resolve(approved);
  }

  stop(id: string): void {
    const live = this.live.get(id);
    if (!live) return;
    for (const [approvalId, resolve] of live.pending) {
      live.pending.delete(approvalId);
      resolve(false);
    }
    live.preparing?.abort();
    live.agent?.stop();
    live.external?.stop();
  }

  stopAll(): void {
    for (const id of this.live.keys()) this.stop(id);
  }
}
