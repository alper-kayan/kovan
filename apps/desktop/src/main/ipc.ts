import * as gitEngine from '@kovan/git-engine';
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { homedir, userInfo } from 'node:os';
import { z } from 'zod';
import { ArenaRequestSchema, normalizeRepoUrl } from '@kovan/shared';
import { basename, join } from 'node:path';
import type {
  ExternalAgentInfo,
  InvokeChannel,
  InvokeContract,
  JoinCheck,
  RepoInfo,
} from '../shared/api.js';
import type { ExternalHarness } from '../shared/agent.js';
import type { AgentLimit } from '../shared/limits.js';
import type { ProviderKeys } from './agents.js';
import type { CustomProviders } from './customProviders.js';
import type { TeamTools } from './teamTools.js';
import type { LaneFlow } from './laneFlow.js';
import { askForAttention, notifyNative } from './notifications.js';
import { checkOverlap } from './overlap.js';
import { isConnected, type SetupResult } from './repoSetup.js';
import { randomUUID } from 'node:crypto';
import type { Bindings } from '@kovan/runner';
import { BrainError, type BrainClient } from './brain.js';
import { currentBranch, finalDiff, pushProblem, switchToBranch } from '@kovan/runner';
import { SettingsPatchSchema } from '../shared/settings.js';
import { listWorkspaceFiles, readDirEntries, readTextFile, writeTextFile } from './files.js';
import type { RecentWorkspaces } from './recents.js';
import type { SettingsStore } from './settingsStore.js';
import type { Updater } from './updater.js';
import type { WindowContext } from './windowContext.js';
import type { BackgroundAgents } from './background.js';
import { branchFile } from './branchFile.js';
import type { AgentAccounts } from './agentAccounts.js';
import { bodyClosing, type GithubClient } from './github.js';
import type { IssueTool } from './issues.js';
import type { SessionCheckouts } from '@kovan/runner';
import type { SessionSync } from './sessionSync.js';
import type { SkillLibrary } from './skills.js';
import type { McpRegistry } from './mcp.js';
import type { PluginManager } from './plugins.js';
import type { SubagentRunner } from '@kovan/runner';
import type { ArenaRunner } from './arena.js';
import { changeImpact } from '@kovan/runner';
import type { SwarmRunner } from '@kovan/runner';
import type { Session, SessionPr } from '@kovan/shared';

const str = z.string();
const paths = z.array(z.string()).max(10_000);
const int = z.number().int();

/** Runtime argument schemas: the renderer is untrusted input as far as main is concerned. */
const checkoutInput = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  title: z.string().max(200),
  branch: z.string().min(1).max(200).nullable(),
});

const pluginSource = z.object({
  source: str.max(1000),
  path: str.max(300),
  ref: str.max(200),
});
const pluginName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const mcpPairs = z
  .array(z.object({ name: str.max(200), value: str.max(20_000).nullable() }))
  .max(50);
const mcpServerInput = z.object({
  name: str.max(40),
  previousName: str.max(40).nullable(),
  type: z.enum(['stdio', 'http']),
  command: str.max(2000),
  args: z.array(str.max(4000)).max(100),
  url: str.max(2000),
  env: mcpPairs,
  headers: mcpPairs,
});

const ARGS: { [C in InvokeChannel]: z.ZodType<Parameters<InvokeContract[C]>> } = {
  'app:info': z.tuple([]),
  'app:notify': z
    .tuple([str.max(200), str.max(1000)])
    .or(z.tuple([str.max(200), str.max(1000), z.boolean()])),
  'update:state': z.tuple([]),
  'update:check': z.tuple([]),
  'update:install': z.tuple([]),
  'workspace:openDialog': z.tuple([]),
  'workspace:open': z.tuple([str]),
  'workspace:current': z.tuple([]),
  'workspace:recent': z.tuple([]),
  'workspace:forgetRecent': z.tuple([str]),
  'fs:readDir': z.tuple([str]),
  'fs:readFile': z.tuple([str]),
  'fs:writeFile': z.tuple([str, str]),
  'fs:listFiles': z.tuple([]),
  'git:status': z.tuple([]),
  'git:branchFile': z.tuple([str, str, str, z.boolean()]),
  'git:diffSides': z.tuple([str, z.boolean()]),
  'git:stage': z.tuple([paths]),
  'git:unstage': z.tuple([paths]),
  'git:discard': z.tuple([paths]),
  'git:commit': z.tuple([str]),
  'git:suggestMessage': z.tuple([]),
  'git:branches': z.tuple([]),
  'git:checkout': z.tuple([str]),
  'git:createBranch': z.tuple([str]),
  'terminal:create': z.tuple([
    z.object({
      cols: int.min(1).max(1000),
      rows: int.min(1).max(1000),
      agent: z.enum(['claude-code', 'codex']).optional(),
      /** Runs the agent as one of the person's other accounts; `login` starts its sign-in. */
      account: z.string().max(64).optional(),
      login: z.boolean().optional(),
    }),
  ]) as unknown as z.ZodType<Parameters<InvokeContract['terminal:create']>>,
  'accounts:list': z.tuple([]),
  'accounts:add': z.tuple([z.enum(['claude-code', 'codex']), str.max(40)]),
  'accounts:remove': z.tuple([str.max(64)]),
  'accounts:status': z.tuple([z.enum(['claude-code', 'codex']), str.max(64).nullable()]),
  'terminal:write': z.tuple([int, str]),
  'terminal:resize': z.tuple([int, int.min(1).max(1000), int.min(1).max(1000)]),
  'terminal:kill': z.tuple([int]),
  'settings:get': z.tuple([]),
  'settings:update': z.tuple([SettingsPatchSchema]) as unknown as z.ZodType<
    Parameters<InvokeContract['settings:update']>
  >,
  'brain:status': z.tuple([]),
  'brain:login': z.tuple([z.enum(['login', 'link'])]),
  'brain:cancelLogin': z.tuple([]),
  'brain:logout': z.tuple([]),
  'brain:request': z
    .tuple([z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']), str.startsWith('/api/').max(500)])
    .or(
      z.tuple([
        z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']),
        str.startsWith('/api/').max(500),
        z.unknown(),
      ]),
    ),
  'brain:presence': z.tuple([str.nullable(), z.enum(['active', 'idle'])]),
  'brain:subscribe': z.tuple([str]),
  'brain:reportError': z.tuple([str.max(2000), str.max(20_000).nullable()]),
  'bindings:get': z.tuple([]),
  'bindings:set': z.tuple([str, str.nullable()]),
  'repo:choose': z.tuple([]),
  'repo:inspect': z.tuple([str]),
  'repo:clone': z.tuple([str.max(500), str.max(200)]),
  'agent:list': z.tuple([]),
  'agent:create': z.tuple([]),
  'agent:open': z.tuple([str]),
  'agent:remove': z.tuple([str]),
  'agent:configure': z.tuple([
    str,
    z
      .object({
        model: str.max(200),
        effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).nullable(),
        mode: z.enum(['plan', 'request', 'allow', 'full']),
        harness: z.enum(['kovan', 'claude-code', 'codex']),
        auto: z.boolean(),
        account: z.string().max(64).optional(),
      })
      .partial()
      .strict(),
  ]) as unknown as z.ZodType<Parameters<InvokeContract['agent:configure']>>,
  'agent:send': z.tuple([
    str,
    str.max(200_000),
    z
      .array(
        z.object({
          kind: z.enum(['markdown', 'image']),
          name: str.max(300),
          content: str.max(15_000_000),
        }),
      )
      .max(10),
  ]),
  'issue:draft': z.tuple([str.max(240)]),
  'issue:similar': z.tuple([str.max(200), str.max(240)]),
  'issue:file': z.tuple([
    z.object({
      repo: str.max(200),
      title: str.max(240),
      body: str.max(60_000),
      labels: z.array(str.max(50)).max(10),
      commentOn: z.number().int().positive().nullable(),
      dontAsk: z.boolean(),
    }),
  ]),
  'agent:stop': z.tuple([str]),
  'agent:approve': z.tuple([str, str, z.boolean()]),
  'agent:approveIssue': z.tuple([
    str,
    str,
    z.object({
      repo: str.max(200),
      title: str.max(240),
      body: str.max(60_000),
      labels: z.array(str.max(100)).max(10),
      commentOn: z.number().int().positive().nullable(),
      dontAsk: z.boolean(),
    }),
  ]),
  'agent:steer': z.tuple([str, str.min(1).max(10_000)]),
  'agent:mention': z.tuple([str, z.string().uuid(), str.max(80), str.min(1).max(10_000)]),
  'session:lane': z.tuple([
    z.object({ id: z.string().uuid(), workspaceId: z.string().uuid(), title: str.max(200) }),
  ]),
  'session:precheck': z.tuple([
    z.object({
      sessionId: z.string().uuid().optional(),
      workspaceId: z.string().uuid(),
      branch: str.max(200).nullable(),
      harness: z.enum(['kovan', 'claude-code', 'codex']),
    }),
  ]),
  'session:switchBranch': z.tuple([str.min(1).max(200)]),
  'session:currentBranch': z.tuple([]),
  'session:finalDiff': z.tuple([str.min(1).max(200)]),
  'session:follow': z.tuple([z.string().uuid()]),
  'git:head': z.tuple([]),
  'brain:verifyAnchors': z.tuple([]),
  'repo:connectAgents': z.tuple([]),
  'repo:agentsConnected': z.tuple([]),
  'session:steer': z.tuple([z.string().uuid(), z.string().uuid(), str.min(1).max(10_000)]),
  'session:takeover': z.tuple([z.string().uuid(), z.string().uuid()]),
  'session:continue': z.tuple([z.string().uuid()]),
  'session:handoff': z.tuple([z.string().uuid(), z.string().uuid()]),
  'overlap:check': z.tuple([
    z.object({ text: str.max(20_000), paths: z.array(str.max(500)).max(200) }),
  ]),
  'session:unfollow': z.tuple([z.string().uuid()]),
  'session:checkout': z.tuple([checkoutInput]),
  'session:checkoutOf': z.tuple([checkoutInput]),
  'session:removeCheckout': z.tuple([z.string().uuid()]),
  'sync:attach': z.tuple([
    z.object({
      sessionId: z.string().uuid(),
      workspaceId: z.string().uuid(),
      branch: str.min(1).max(200),
    }),
  ]),
  'sync:state': z.tuple([]),
  'sync:setEnabled': z.tuple([z.string().uuid(), z.boolean()]),
  'sync:resume': z.tuple([]),
  'sync:switchBack': z.tuple([]),
  'sync:version': z.tuple([str.max(40)]),
  'sync:resolve': z.tuple([str.max(40), z.enum(['mine', 'theirs'])]),
  'sync:keepDisk': z.tuple([str.max(4096)]),
  'subagent:start': z.tuple([str, str.min(1).max(2000)]),
  'subagent:retry': z.tuple([z.string().uuid()]),
  'subagent:discard': z.tuple([z.string().uuid()]),
  'subagent:path': z.tuple([z.string().uuid()]),
  'git:push': z.tuple([]),
  'git:graph': z.tuple([z.number().int().min(1).max(2000)]),
  'impact:working': z.tuple([]),
  'pr:create': z.tuple([
    z.string().uuid(),
    z.object({ title: str.min(1).max(250), body: str.max(60_000), base: str.min(1).max(200) }),
  ]),
  'pr:refresh': z.tuple([z.string().uuid()]),
  'swarm:launch': z.tuple([z.string().uuid()]),
  'arena:start': z.tuple([ArenaRequestSchema]),
  'arena:stop': z.tuple([]),
  'arena:running': z.tuple([]),
  'arena:runs': z.tuple([]),
  'swarm:running': z.tuple([z.string().uuid()]),
  'models:list': z.tuple([z.boolean()]),
  'models:checkedAt': z.tuple([]),
  'providers:status': z.tuple([]),
  'background:status': z.tuple([]),
  'background:set': z.tuple([z.boolean()]),
  'agents:external': z.tuple([z.boolean()]),
  'skills:list': z.tuple([]),
  'skills:openFolder': z.tuple([]),
  'mcp:list': z.tuple([]),
  'mcp:save': z.tuple([mcpServerInput]),
  'mcp:remove': z.tuple([str.max(40)]),
  'mcp:setEnabled': z.tuple([str.max(40), z.boolean()]),
  'mcp:test': z.tuple([mcpServerInput]),
  'mcp:check': z.tuple([str.max(40)]),
  'mcp:signIn': z.tuple([str.max(40)]),
  'mcp:signOut': z.tuple([str.max(40)]),
  'plugins:list': z.tuple([]),
  'plugins:preview': z.tuple([pluginSource]),
  'plugins:install': z.tuple([z.string().uuid()]),
  'plugins:discard': z.tuple([z.string().uuid()]),
  'plugins:checkUpdate': z.tuple([pluginName]),
  'plugins:update': z.tuple([pluginName, z.string().uuid()]),
  'plugins:remove': z.tuple([pluginName]),
  'plugins:setEnabled': z.tuple([pluginName, z.boolean()]),
  'plugins:setEverywhere': z.tuple([pluginName, z.boolean()]),
  'plugins:chooseFolder': z.tuple([]),
  'mcp:trust': z.tuple([z.string().regex(/^[0-9a-f]{32}$/), z.enum(['always', 'deny']).nullable()]),
  'agents:limits': z.tuple([]),
  'providers:setOpenRouterKey': z.tuple([str.min(10).max(300).nullable()]),
  'providers:custom:list': z.tuple([]),
  'providers:custom:save': z.tuple([
    z.object({
      id: z
        .string()
        .regex(/^[a-z0-9-]{1,40}$/)
        .optional(),
      name: str.min(1).max(60),
      baseUrl: str.min(8).max(500),
      apiKey: str.max(500).nullable().optional(),
    }),
  ]),
  'providers:custom:refresh': z.tuple([z.string().regex(/^[a-z0-9-]{1,40}$/)]),
  'providers:custom:remove': z.tuple([z.string().regex(/^[a-z0-9-]{1,40}$/)]),
};

type Handler<C extends InvokeChannel> = (
  ctx: WindowContext,
  ...args: Parameters<InvokeContract[C]>
) => ReturnType<InvokeContract[C]> | Promise<ReturnType<InvokeContract[C]>>;

export interface IpcDeps {
  contextFor(event: IpcMainInvokeEvent): WindowContext | undefined;
  isTrustedSender(event: IpcMainInvokeEvent): boolean;
  settings: SettingsStore;
  recents: RecentWorkspaces;
  brain: BrainClient;
  bindings: Bindings;
  keys: ProviderKeys;
  customProviders: CustomProviders;
  team: TeamTools;
  flow: LaneFlow;
  connectRepo: (root: string) => Promise<SetupResult>;
  /** Kovan's agent would use managed usage now (signed in, billing choice). */
  managedAvailable: () => Promise<boolean>;
  updater: Updater;
  checkouts: SessionCheckouts;
  sessionSync: SessionSync;
  subagents: SubagentRunner;
  swarms: SwarmRunner;
  arena: ArenaRunner;
  github: GithubClient;
  issues: Pick<IssueTool, 'draft' | 'similarIn' | 'file'>;
  externalAgents: (refresh: boolean) => Promise<ExternalAgentInfo[]>;
  agentLimits: () => Promise<AgentLimit[]>;
  background: BackgroundAgents;
  skills: SkillLibrary;
  mcp: McpRegistry;
  plugins: PluginManager;
  /** Opens a web page in the person's browser (dev end-to-end runs log it instead). */
  openExternal: (url: string) => void;
  /** The command line for an agent's own TUI, wired to Kovan over MCP. */
  agentProgram: (
    agent: ExternalHarness,
    root: string,
    as?: { account?: string | undefined; login?: boolean | undefined },
  ) => Promise<{ file: string; args: string[]; env: Record<string, string> }>;
  accounts: Pick<AgentAccounts, 'list' | 'add' | 'remove'>;
  /** Whether the CLI is signed in as the account (null: the CLI isn't installed). */
  accountStatus: (
    harness: ExternalHarness,
    account: string | undefined,
  ) => Promise<{ signedIn: boolean; who: string | null } | null>;
}

export function registerIpc(deps: IpcDeps): void {
  function handle<C extends InvokeChannel>(channel: C, handler: Handler<C>): void {
    ipcMain.handle(channel, async (event, ...raw: unknown[]) => {
      if (!deps.isTrustedSender(event)) throw new Error('Untrusted sender');
      const ctx = deps.contextFor(event);
      if (!ctx) throw new Error('Unknown window');
      const args = ARGS[channel].parse(raw) as Parameters<InvokeContract[C]>;
      return handler(ctx, ...args);
    });
  }

  const gitRoot = (ctx: WindowContext): string | null =>
    ctx.workspace?.isRepo ? ctx.workspace.root : null;
  const requireGitRoot = (ctx: WindowContext): string => {
    const root = gitRoot(ctx);
    if (!root) throw new Error('This folder is not a git repository');
    return root;
  };

  handle('app:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    homeDir: homedir(),
    userName: userInfo().username,
  }));
  handle('update:state', () => deps.updater.current);
  handle('update:check', () => deps.updater.check());
  handle('update:install', () => deps.updater.install());
  handle('app:notify', (ctx, title, body, force = false) => {
    // Only interrupt when the person is looking elsewhere, unless they asked for it (a test).
    if (!force && ctx.window.isFocused()) return { shown: false, skipped: true };
    return notifyNative(title, body, {
      onClick: () => {
        if (ctx.window.isDestroyed()) return;
        if (ctx.window.isMinimized()) ctx.window.restore();
        ctx.window.focus();
      },
      onBlocked: () => askForAttention(ctx.window),
    });
  });

  handle('workspace:openDialog', async (ctx) => {
    const result = await dialog.showOpenDialog(ctx.window, {
      title: 'Open a repository or folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    const folder = result.filePaths[0];
    if (result.canceled || !folder) return null;
    const info = await ctx.openWorkspace(folder);
    // A session's worktree is reached through its session, not the recent list.
    if (!info.session) await deps.recents.add(info.root, info.name);
    return info;
  });
  handle('workspace:open', async (ctx, folder) => {
    const info = await ctx.openWorkspace(folder);
    // A session's worktree is reached through its session, not the recent list.
    if (!info.session) await deps.recents.add(info.root, info.name);
    return info;
  });
  handle('workspace:current', (ctx) => ctx.workspace);
  handle('workspace:recent', () => deps.recents.list());
  handle('workspace:forgetRecent', (_ctx, root) => deps.recents.forget(root));

  handle('fs:readDir', (ctx, path) => readDirEntries(ctx.requireRoot(), path));
  handle('fs:readFile', (ctx, path) => readTextFile(ctx.requireRoot(), path));
  handle('git:branchFile', async (ctx, workspaceId, branch, path, refresh) => {
    // The workspace's checkout here (any one of them works: only its remote is used).
    const root = (await deps.bindings.all())[workspaceId] ?? ctx.requireRoot();
    return branchFile(root, branch, path, { refresh });
  });
  handle('fs:writeFile', (ctx, path, content) => writeTextFile(ctx.requireRoot(), path, content));
  handle('fs:listFiles', (ctx) =>
    listWorkspaceFiles(ctx.requireRoot(), ctx.workspace?.isRepo ?? false),
  );

  handle('git:status', (ctx) => {
    const root = gitRoot(ctx);
    return root ? gitEngine.getStatus(root) : null;
  });
  handle('git:diffSides', (ctx, path, staged) =>
    gitEngine.getDiffSides(requireGitRoot(ctx), path, staged),
  );
  handle('git:stage', (ctx, files) => gitEngine.stage(requireGitRoot(ctx), files));
  handle('git:unstage', (ctx, files) => gitEngine.unstage(requireGitRoot(ctx), files));
  handle('git:discard', (ctx, files) => gitEngine.discard(requireGitRoot(ctx), files));
  handle('git:commit', (ctx, message) => gitEngine.commit(requireGitRoot(ctx), message));
  handle('git:branches', (ctx) => gitEngine.listBranches(requireGitRoot(ctx)));
  handle('git:checkout', (ctx, branch) => gitEngine.checkout(requireGitRoot(ctx), branch));
  handle('git:createBranch', (ctx, branch) => gitEngine.createBranch(requireGitRoot(ctx), branch));

  handle('terminal:create', async (ctx, { cols, rows, agent, account, login }) => {
    const cwd = ctx.workspace?.root ?? homedir();
    if (!agent) return ctx.terminals.create(cwd, cols, rows);
    const program = await deps.agentProgram(agent, cwd, { account, login });
    return ctx.terminals.create(cwd, cols, rows, program);
  });
  handle('accounts:list', () => deps.accounts.list());
  handle('accounts:add', (_ctx, harness, name) => deps.accounts.add(harness, name));
  handle('accounts:remove', (_ctx, id) => deps.accounts.remove(id));
  handle('accounts:status', (_ctx, harness, account) =>
    deps.accountStatus(harness, account ?? undefined),
  );
  handle('terminal:write', (ctx, id, data) => ctx.terminals.write(id, data));
  handle('terminal:resize', (ctx, id, cols, rows) => ctx.terminals.resize(id, cols, rows));
  handle('terminal:kill', (ctx, id) => ctx.terminals.kill(id));

  handle('settings:get', () => deps.settings.get());
  handle('settings:update', (_ctx, patch) => deps.settings.update(patch));

  const { brain, bindings } = deps;
  handle('brain:status', () => brain.status());
  handle('brain:login', (_ctx, intent) => brain.login(intent));
  handle('brain:cancelLogin', () => brain.cancelLogin());
  handle('brain:logout', () => brain.logout());
  handle('brain:request', (_ctx, method, path, body) => brain.request(method, path, body));
  handle('brain:presence', (_ctx, workspaceId, status) => brain.setPresence(workspaceId, status));
  handle('brain:subscribe', (_ctx, workspaceId) => brain.subscribe(workspaceId));
  handle('brain:reportError', (_ctx, message, stack) =>
    brain.reportError('renderer', message, stack),
  );

  handle('bindings:get', () => bindings.all());
  handle('bindings:set', (_ctx, workspaceId, path) => bindings.set(workspaceId, path));

  handle('repo:choose', async (ctx) => {
    const result = await dialog.showOpenDialog(ctx.window, {
      title: 'Choose a repository',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  handle('repo:inspect', async (_ctx, folder): Promise<RepoInfo> => {
    const repoRoot = await gitEngine.findRepoRoot(folder);
    const root = repoRoot ?? folder;
    const rawRemote = repoRoot ? await gitEngine.getRemoteUrl(root) : null;
    const status = repoRoot ? await gitEngine.getStatus(root).catch(() => null) : null;
    return {
      root,
      name: basename(root),
      isRepo: repoRoot !== null,
      remoteUrl: rawRemote ? normalizeRepoUrl(rawRemote) : null,
      rawRemote,
      branch: status?.branch ?? null,
    };
  });

  const agents = (ctx: WindowContext) => {
    if (!ctx.agents) throw new Error('Agents are not ready');
    return ctx.agents;
  };
  handle('git:suggestMessage', (ctx) => agents(ctx).commitMessage(requireGitRoot(ctx)));
  handle('agent:list', (ctx) => (ctx.workspace ? agents(ctx).list(ctx.workspace.root) : []));
  handle('agent:create', async (ctx) => {
    const s = await deps.settings.get();
    const external = s.agentHarness !== 'kovan';
    return agents(ctx).create(ctx.requireRoot(), {
      harness: s.agentHarness,
      auto: s.agentAuto,
      model: external ? 'default' : s.agentModel,
      effort: external ? null : s.agentEffort,
      mode: s.agentMode,
    });
  });
  handle('agent:open', (ctx, id) => agents(ctx).open(ctx.requireRoot(), id));
  handle('agent:remove', (ctx, id) => agents(ctx).remove(ctx.requireRoot(), id));
  handle('agent:configure', async (ctx, id, patch) => {
    const updated = await agents(ctx).configure(ctx.requireRoot(), id, patch);
    // The last choice becomes the default for new conversations. Claude Code's and Codex's models
    // aren't OpenRouter models, so only Kovan conversations set the default model.
    const kovan = (updated.harness ?? 'kovan') === 'kovan';
    await deps.settings.update({
      ...(patch.model && kovan ? { agentModel: patch.model } : {}),
      ...(patch.effort !== undefined && kovan ? { agentEffort: patch.effort } : {}),
      ...(patch.mode ? { agentMode: patch.mode } : {}),
      ...(patch.harness ? { agentHarness: patch.harness } : {}),
      // Picking an agent by hand turns Auto off for new conversations too.
      ...(patch.auto !== undefined
        ? { agentAuto: patch.auto }
        : patch.harness
          ? { agentAuto: false }
          : {}),
    });
    return updated;
  });
  handle('agent:send', (ctx, id, text, attachments) =>
    agents(ctx).send(ctx.requireRoot(), id, text, attachments),
  );
  handle('agent:stop', (ctx, id) => agents(ctx).stop(id));
  handle('agent:approve', async (ctx, id, approvalId, approved) => {
    // In a session the answer goes through the Brain, so the whole team sees it and only the
    // first answer counts. Offline, the person answers here and the agent goes on (fail open).
    const session = agents(ctx).sessionOf(id);
    const me = deps.brain.status();
    if (session && me.connection === 'online' && me.user) {
      try {
        await deps.brain.request('POST', `/api/sessions/${session.id}/approvals`, {
          laneUserId: me.user.id,
          requestId: approvalId,
          approved,
        });
      } catch (error) {
        // Someone else answered first; their answer is on its way here.
        if (error instanceof BrainError && error.status === 409) return;
        if (error instanceof BrainError && error.status < 500) throw error;
      }
    }
    agents(ctx).approve(id, approvalId, approved);
  });

  // The person's own issues (from a comment or an agent's reply), to this checkout's repositories.
  handle('issue:draft', (ctx, title) => deps.issues.draft(requireGitRoot(ctx), title));
  handle('issue:similar', (ctx, repo, title) =>
    deps.issues.similarIn(requireGitRoot(ctx), repo, title),
  );
  handle('issue:file', (ctx, edits) => deps.issues.file(requireGitRoot(ctx), edits));
  handle('agent:approveIssue', (ctx, id, approvalId, edits) =>
    agents(ctx).approve(id, approvalId, true, edits),
  );
  handle('agent:steer', (ctx, id, text) => agents(ctx).steer(id, { id: randomUUID(), text }));
  // An AI teammate called in with @: it reads this conversation and answers in it.
  handle('agent:mention', async (ctx, id, agentId, name, text) => {
    const root = ctx.requireRoot();
    const me = deps.brain.status().user;
    if (!me) throw new Error('Sign in to call a teammate in.');
    const call = await agents(ctx).mentionContext(root, id, me.name);
    const { id: requestId } = await deps.brain.request<{ id: string }>(
      'POST',
      `/api/sessions/${call.sessionId}/mention`,
      { agentId, text, context: call.context, reply: { kind: 'lane', laneUserId: me.id } },
    );
    await agents(ctx).recordMention(root, id, { agentId, name, text, requestId });
  });
  handle('session:lane', async (ctx, session) => {
    const root = ctx.requireRoot();
    const existing = await agents(ctx).laneOf(root, session.id);
    if (existing) return existing;
    const s = await deps.settings.get();
    const external = s.agentHarness !== 'kovan';
    // Agents in a shared session start by asking before every action.
    return agents(ctx).create(
      root,
      {
        harness: s.agentHarness,
        model: external ? 'default' : s.agentModel,
        effort: external ? null : s.agentEffort,
        mode: 'request',
      },
      session,
    );
  });
  handle('session:precheck', async (ctx, input): Promise<JoinCheck> => {
    const bound = (await deps.bindings.all())[input.workspaceId];
    if (!bound)
      return {
        ok: false,
        reason: "This workspace isn't set up on this machine yet.",
        fix: 'setup',
      };
    const ws = ctx.workspace;
    // The main checkout, or this session's own worktree.
    const here =
      ws &&
      (ws.session ? ws.session.id === input.sessionId : ws.root === bound) &&
      (ws.repoRoot ?? ws.root) === bound;
    if (!here || !ws)
      return {
        ok: false,
        reason: "Open this session's checkout in this window to join.",
        fix: 'checkout',
      };
    if (input.harness === 'kovan') {
      const status = await deps.keys.status();
      const custom = (await deps.customProviders.models()).length;
      if (!status.openrouter.configured && custom === 0)
        return {
          ok: false,
          reason: 'Your agent needs a model provider: add an OpenRouter key or a custom provider.',
          fix: 'provider',
        };
    } else {
      const cli = (await deps.externalAgents(false)).find((a) => a.id === input.harness);
      if (!cli?.supported)
        return {
          ok: false,
          reason: cli?.reason ?? 'That agent is not available on this machine.',
          fix: 'provider',
        };
    }
    if (input.branch && ws.isRepo) {
      const current = await currentBranch(ws.root);
      if (current !== input.branch && !ws.session)
        return {
          ok: false,
          reason: `This session works on ${input.branch}; your checkout is on ${current ?? 'a detached HEAD'}. Kovan opens it in its own worktree, leaving your checkout as it is.`,
          fix: 'checkout',
          branch: input.branch,
        };
      const push = await pushProblem(ws.root, input.branch);
      if (push) return { ok: false, reason: push, fix: null };
    }
    return { ok: true };
  });
  handle('session:switchBranch', (ctx, branch) => switchToBranch(requireGitRoot(ctx), branch));
  handle('session:currentBranch', (ctx) => {
    const root = gitRoot(ctx);
    return root ? currentBranch(root) : null;
  });
  handle('session:finalDiff', (ctx, base) => {
    const root = gitRoot(ctx);
    return root ? finalDiff(root, base) : null;
  });
  handle('session:follow', (_ctx, sessionId) => deps.brain.followSession(sessionId));
  handle('repo:connectAgents', (ctx) => deps.connectRepo(requireGitRoot(ctx)));
  handle('repo:agentsConnected', (ctx) => {
    const root = gitRoot(ctx);
    return root ? isConnected(root) : false;
  });
  handle('session:steer', (ctx, sessionId, laneUserId, text) => {
    const id = randomUUID();
    const me = deps.brain.status().user?.id;
    const local = ctx.agents?.laneConversation(sessionId);
    if (laneUserId === me && local) return { sent: ctx.agents!.steer(local, { id, text }) };
    return { sent: deps.brain.steer(sessionId, laneUserId, id, text) };
  });
  handle('session:takeover', (_ctx, sessionId, laneUserId) =>
    deps.flow.takeover(sessionId, laneUserId),
  );
  handle('session:continue', (_ctx, handoffId) => deps.flow.continueWith(handoffId));
  handle('session:handoff', (_ctx, sessionId, toUserId) => deps.flow.handoff(sessionId, toUserId));
  handle('overlap:check', async (ctx, input) => {
    const root = ctx.workspace?.root;
    const workspaceId = root ? await deps.bindings.idFor(root) : null;
    if (!workspaceId || deps.brain.status().connection !== 'online') return [];
    const branch = ctx.workspace?.isRepo ? await currentBranch(root!) : null;
    // Fails open: no answer in time means no warning.
    return Promise.race([
      checkOverlap(deps.brain, { workspaceId, ...input, branch }, await deps.keys.openRouterKey()),
      new Promise<[]>((resolve) => setTimeout(() => resolve([]), 8000)),
    ]).catch(() => []);
  });
  handle('git:head', async (ctx) => {
    const root = gitRoot(ctx);
    if (!root) return null;
    return (await gitEngine.git(root, ['rev-parse', 'HEAD']).catch(() => '')).trim() || null;
  });
  // After HEAD moves (merge, pull, checkout, commit): flag notes and label comments whose code
  // moved or changed. Only when HEAD really changed since the last check of this checkout.
  const checkedHead = new Map<string, string>();
  handle('brain:verifyAnchors', async (ctx) => {
    const root = gitRoot(ctx);
    if (!root) return { flagged: 0, outdated: 0 };
    const head = (await gitEngine.git(root, ['rev-parse', 'HEAD']).catch(() => '')).trim();
    if (head && checkedHead.get(root) === head) return { flagged: 0, outdated: 0 };
    const result = await deps.team.verifyAnchors(root);
    if (head) checkedHead.set(root, head);
    return result;
  });
  handle('session:unfollow', (_ctx, sessionId) => deps.brain.unfollowSession(sessionId));

  // ---------- Phase 9: checkouts, sync, subagents, finishing ----------

  handle('session:checkout', (_ctx, session) => deps.checkouts.ensure(session));
  handle('session:checkoutOf', (_ctx, session) => deps.checkouts.existing(session));
  handle('session:removeCheckout', async (ctx, sessionId) => {
    if (ctx.workspace?.session?.id === sessionId)
      throw new Error("Open another folder first: this window shows the session's checkout.");
    await deps.checkouts.remove(sessionId);
  });
  handle('sync:attach', (ctx, link) => deps.sessionSync.attach(requireGitRoot(ctx), link));
  handle('sync:state', (ctx) => {
    const root = gitRoot(ctx);
    return root ? deps.sessionSync.state(root) : null;
  });
  handle('sync:setEnabled', (_ctx, workspaceId, on) =>
    deps.sessionSync.setEnabled(workspaceId, on),
  );
  handle('sync:resume', (ctx) => deps.sessionSync.resume(requireGitRoot(ctx)));
  handle('sync:switchBack', (ctx) => deps.sessionSync.switchBack(requireGitRoot(ctx)));
  handle('sync:version', (ctx, id) => deps.sessionSync.versionContent(requireGitRoot(ctx), id));
  handle('sync:resolve', (ctx, id, keep) =>
    deps.sessionSync.resolveVersion(requireGitRoot(ctx), id, keep),
  );
  handle('sync:keepDisk', (ctx, path) =>
    deps.sessionSync.keepDiskVersion(requireGitRoot(ctx), path),
  );
  handle('subagent:start', async (ctx, conversationId, task) => {
    const config = agents(ctx).configOf(conversationId);
    if (!config?.session) throw new Error('Subagents run beside a session lane.');
    const s = await deps.settings.get();
    // Subagents run on Kovan's own agent; a lane on Claude Code or Codex lends its defaults.
    const native = (config.harness ?? 'kovan') === 'kovan';
    return deps.subagents.start({
      sessionId: config.session.id,
      parentRoot: config.root,
      task,
      model: native ? config.model : s.agentModel,
      effort: native ? config.effort : s.agentEffort,
      parentMode: config.mode,
    });
  });
  handle('subagent:retry', (_ctx, id) => deps.subagents.retry(id));
  handle('subagent:discard', (_ctx, id) => deps.subagents.discard(id));
  handle('subagent:path', (_ctx, id) => deps.subagents.pathOf(id));
  handle('git:push', (ctx) => gitEngine.push(requireGitRoot(ctx)));
  handle('git:graph', (ctx, limit) => gitEngine.logGraph(requireGitRoot(ctx), limit));
  handle('impact:working', async (ctx) => {
    const root = requireGitRoot(ctx);
    const status = await gitEngine.git(root, ['status', '--porcelain', '-uall']);
    const changed = status
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(3).split(' -> ').pop()!.replace(/^"|"$/g, ''));
    return changeImpact(root, changed);
  });
  handle('pr:create', async (ctx, sessionId, input) => {
    const root = requireGitRoot(ctx);
    const head = await currentBranch(root);
    if (!head) throw new Error('Check out the session branch to open a pull request.');
    // GitHub needs the branch on the remote first.
    await gitEngine.push(root);
    // A session started for an issue closes it when its pull request merges.
    const { session } = await deps.brain.request<{ session: Session }>(
      'GET',
      `/api/sessions/${sessionId}`,
    );
    const body = bodyClosing(input.body, session.issue);
    const pr = await deps.github.createPr(root, { ...input, body, head });
    await deps.brain.request('POST', `/api/sessions/${sessionId}/pr`, pr);
    return pr;
  });
  // The swarm runs on this machine, in the session's checkout this window has open.
  handle('swarm:launch', (ctx, swarmId) => deps.swarms.launch(swarmId, requireGitRoot(ctx)));
  handle('arena:start', (ctx, request) => deps.arena.start(requireGitRoot(ctx), request));
  handle('arena:stop', () => deps.arena.stop());
  handle('arena:running', () => deps.arena.isRunning());
  handle('arena:runs', () => deps.arena.runs());
  handle('swarm:running', (_ctx, swarmId) => deps.swarms.isRunning(swarmId));
  handle('pr:refresh', async (ctx, sessionId) => {
    const root = requireGitRoot(ctx);
    const { session } = await deps.brain.request<{ session: Session }>(
      'GET',
      `/api/sessions/${sessionId}`,
    );
    if (!session.pr) return null;
    const state = await deps.github.prState(root, session.pr.number);
    if (state === session.pr.state) return session.pr;
    const pr: SessionPr = { ...session.pr, state };
    // A merged PR completes the session; its final diff is what this checkout holds.
    const base = await gitEngine
      .git(root, ['rev-parse', '--abbrev-ref', 'origin/HEAD'])
      .then((r) => r.trim().replace(/^origin\//, ''))
      .catch(() => 'main');
    const diff = state === 'merged' ? await finalDiff(root, base).catch(() => null) : null;
    await deps.brain.request('POST', `/api/sessions/${sessionId}/pr`, { ...pr, diff });
    return pr;
  });
  handle('models:list', (ctx, refresh) => agents(ctx).models(refresh));
  handle('models:checkedAt', (ctx) => agents(ctx).catalogFetchedAt());
  const providerStatus = async () => ({
    ...(await deps.keys.status()),
    customModels: (await deps.customProviders.models()).length,
    managed: await deps.managedAvailable(),
  });
  handle('providers:status', providerStatus);
  handle('background:status', () => deps.background.status());
  handle('background:set', (_ctx, enabled) =>
    enabled ? deps.background.enable() : deps.background.disable(),
  );
  handle('agents:external', (_ctx, refresh) => deps.externalAgents(refresh));
  handle('skills:list', (ctx) => deps.skills.listing(ctx.workspace?.root ?? null));
  const mcpRoot = (ctx: { workspace?: { root: string } | null }) => ctx.workspace?.root ?? null;
  handle('mcp:list', (ctx) => deps.mcp.listing(mcpRoot(ctx)));
  handle('mcp:save', (_ctx, input) => deps.mcp.save(input));
  handle('mcp:remove', (_ctx, name) => deps.mcp.remove(name));
  handle('mcp:setEnabled', (_ctx, name, enabled) => deps.mcp.setEnabled(name, enabled));
  handle('mcp:test', (ctx, input) => deps.mcp.test(input, mcpRoot(ctx)));
  handle('mcp:check', (ctx, name) => deps.mcp.check(name, mcpRoot(ctx)));
  handle('mcp:signIn', (ctx, name) =>
    deps.mcp.signIn(name, mcpRoot(ctx), (url) => deps.openExternal(url.href)),
  );
  handle('mcp:signOut', (ctx, name) => deps.mcp.signOut(name, mcpRoot(ctx)));
  handle('mcp:trust', (ctx, key, decision) => deps.mcp.trust(key, decision, mcpRoot(ctx)));
  handle('plugins:list', (ctx) => deps.plugins.listing(mcpRoot(ctx)));
  handle('plugins:preview', (_ctx, input) => deps.plugins.preview(input));
  handle('plugins:install', async (_ctx, id) => void (await deps.plugins.install(id)));
  handle('plugins:discard', (_ctx, id) => deps.plugins.discard(id));
  handle('plugins:checkUpdate', (_ctx, name) => deps.plugins.checkUpdate(name));
  handle('plugins:update', (_ctx, name, id) => deps.plugins.update(name, id));
  handle('plugins:remove', (_ctx, name) => deps.plugins.remove(name));
  handle('plugins:setEnabled', async (ctx, name, enabled) => {
    const root = mcpRoot(ctx);
    if (!root) throw new Error('Open a workspace first');
    await deps.plugins.setEnabled(name, root, enabled);
  });
  handle('plugins:setEverywhere', (_ctx, name, on) => deps.plugins.setEverywhere(name, on));
  handle('plugins:chooseFolder', async (ctx) => {
    const result = await dialog.showOpenDialog(ctx.window, {
      title: 'Choose a plugin folder',
      properties: ['openDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  handle('skills:openFolder', async () => {
    const error = await shell.openPath(await deps.skills.ensureUserDir());
    if (error) throw new Error(error);
  });
  handle('agents:limits', () => deps.agentLimits());
  handle('providers:setOpenRouterKey', async (_ctx, key) => {
    await deps.keys.setOpenRouterKey(key);
    return providerStatus();
  });
  handle('providers:custom:list', () => deps.customProviders.list());
  handle('providers:custom:save', (_ctx, input) => deps.customProviders.save(input));
  handle('providers:custom:refresh', (_ctx, id) => deps.customProviders.refresh(id));
  handle('providers:custom:remove', (_ctx, id) => deps.customProviders.remove(id));

  handle('repo:clone', async (ctx, url, name) => {
    const result = await dialog.showOpenDialog(ctx.window, {
      title: `Choose where to clone ${name}`,
      buttonLabel: 'Clone here',
      properties: ['openDirectory', 'createDirectory'],
    });
    const parent = result.filePaths[0];
    if (result.canceled || !parent) return null;
    const dest = join(parent, basename(name).replace(/[^\w.-]/g, '-'));
    await gitEngine.cloneRepo(url, dest);
    return dest;
  });
}

/** Sends a menu command to whichever window is focused. */
export function sendMenuCommand(contexts: Map<number, WindowContext>, commandId: string): void {
  const focused = BrowserWindow.getFocusedWindow();
  if (!focused) return;
  contexts.get(focused.webContents.id)?.send('menu:command', commandId);
}
