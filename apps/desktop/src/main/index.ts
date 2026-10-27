import { PRODUCT_NAME } from '@kovan/shared';
import {
  app,
  BrowserWindow,
  Menu,
  nativeTheme,
  safeStorage,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import { BackgroundAgents } from './background.js';
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Bridge } from './bridge.js';
import { LiveDiffs } from './liveDiffs.js';
import { currentBranch, defaultBranch, liveDiff, pushSnapshot, snapshotRef } from '@kovan/runner';
import { checkOverlap } from './overlap.js';
import { TeamTools, type TeamCaller } from './teamTools.js';
import { Desk } from './desk.js';
import { LaneFlow } from './laneFlow.js';
import { connectRepo, isConnected } from './repoSetup.js';
import { GithubClient } from './github.js';
import { SessionCheckouts } from '@kovan/runner';
import { SessionSync } from './sessionSync.js';
import { SubagentRunner } from '@kovan/runner';
import { SwarmRunner } from '@kovan/runner';
import { KOVAN_APPEND_PROMPT } from './harnesses/claudeCode.js';
import { codexMcpArgs, type McpServerSpec } from './harnesses/codex.js';
import { detectAgents, searchFirst, userPath, type ExternalAgent } from './harnesses/detect.js';
import { registerIpc, sendMenuCommand } from './ipc.js';
import { askForAttention, notifyNative } from './notifications.js';
import { HARNESS_NAMES } from '../shared/agent.js';
import type { EventChannel, EventContract } from '../shared/api.js';
import { AgentManager, ProviderKeys } from './agents.js';
import { AgentAccounts, signedIn } from './agentAccounts.js';
import { AgentLimits } from './agentLimits.js';
import { ArenaRunner } from './arena.js';
import { ISSUE_TOOL, IssueTool } from './issues.js';
import { Bindings } from '@kovan/runner';
import { CustomProviders } from './customProviders.js';
import { BrainClient } from './brain.js';
import { buildMenu } from './menu.js';
import { RecentWorkspaces } from './recents.js';
import { SettingsStore } from './settingsStore.js';
import { SkillLibrary } from './skills.js';
import { McpRegistry } from './mcp.js';
import { PluginManager } from './plugins.js';
import { WindowContext } from './windowContext.js';
import { BUILT_SERVER_URL, UPDATE_PUBLIC_KEY } from './buildInfo.js';
import { runSelfTest } from './selfTest.js';
import { Updater, type UpdateBackend } from './updater.js';

const isDev = !app.isPackaged;
const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
const rendererFile = join(import.meta.dirname, '../renderer/index.html');
const rendererOrigin = devServerUrl ? new URL(devServerUrl).origin : null;

app.setName(PRODUCT_NAME);

// Dev only: a separate profile, so end-to-end checks never touch real settings.
const userDataOverride = process.env['KOVAN_USER_DATA'];
if (isDev && userDataOverride) app.setPath('userData', userDataOverride);

// Lets end-to-end checks drive a dev build over the DevTools protocol without focusing it.
const debugPort = process.env['KOVAN_REMOTE_DEBUG_PORT'];
if (isDev && debugPort) app.commandLine.appendSwitch('remote-debugging-port', debugPort);

// Dev only: stand-in agent CLIs for end-to-end checks (a Claude Code that runs out of usage).
const agentPath = process.env['KOVAN_AGENT_PATH'];
if (isDev && agentPath) searchFirst(agentPath);

/** A folder passed on the command line (`kovan ~/code/repo`), opened in the first window. */
function folderFromArgs(): string | null {
  const args = process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-'));
  for (const candidate of [...args, process.env['KOVAN_OPEN_FOLDER']]) {
    if (!candidate) continue;
    try {
      const path = resolve(candidate);
      if (statSync(path).isDirectory() && path !== process.cwd()) return path;
    } catch {
      // Not a folder; ignore.
    }
  }
  return null;
}

const contexts = new Map<number, WindowContext>();
const settings = new SettingsStore(app.getPath('userData'));
/** A web page in the person's browser; dev end-to-end runs read it from the log instead. */
function openExternal(url: string): void {
  if (isDev && process.env['KOVAN_E2E_NO_BROWSER']) console.log(`[e2e] would open ${url}`);
  else if (/^https?:\/\//.test(url)) void shell.openExternal(url);
}

const plugins = new PluginManager(app.getPath('userData'));
void plugins.init();
const skills = new SkillLibrary(
  app.getPath('userData'),
  () => settings.get(),
  undefined,
  (root) => plugins.skillDirs(root),
);
const mcp = new McpRegistry({
  userData: app.getPath('userData'),
  settings: () => settings.get(),
  path: () => userPath(),
  version: app.getVersion(),
  plugins: (root) => plugins.servers(root),
});
const recents = new RecentWorkspaces(app.getPath('userData'));
const bindings = new Bindings(app.getPath('userData'));
// Release builds talk to the server they were built for; KOVAN_SERVER_URL points anywhere else
// (a self-hosted server, or a local one in development).
const serverUrl = process.env['KOVAN_SERVER_URL'] ?? (BUILT_SERVER_URL || 'http://localhost:4807');
// Dev builds may take the key from the environment; packaged builds only use the keychain.
const keys = new ProviderKeys(
  app.getPath('userData'),
  isDev ? (process.env['OPENROUTER_API_KEY'] ?? null) : null,
);
const customProviders = new CustomProviders(app.getPath('userData'));

function broadcast<C extends EventChannel>(channel: C, ...args: EventContract[C]): void {
  for (const ctx of contexts.values()) ctx.send(channel, ...args);
}

const brain = new BrainClient(
  serverUrl,
  app.getPath('userData'),
  {
    user: (user) => broadcast('brain:user', user),
    connection: (state) => {
      for (const ctx of contexts.values()) {
        ctx.connection = state;
        ctx.updateTitle();
        ctx.send('connection:state', state);
      }
    },
    message: (message) => {
      // A teammate answered one of this person's lane approvals: the agent here acts on it.
      if (
        message.type === 'approval' &&
        message.approval.laneUserId === brain.status().user?.id &&
        (message.approval.status === 'approved' || message.approval.status === 'denied')
      ) {
        for (const ctx of contexts.values())
          ctx.agents?.answerFromTeam(
            message.approval.sessionId,
            message.approval.requestId,
            message.approval.status === 'approved',
          );
      }
      // A teammate this person called in with @ is at work, or answered.
      if (message.type === 'teammate.reply')
        for (const ctx of contexts.values())
          ctx.agents?.teammateReply(
            message.sessionId,
            {
              agentId: message.agentId,
              name: message.name,
              requestId: message.requestId,
              status: message.status,
              text: message.text,
            },
            message.asked,
          );
      void flow.onMessage(message).catch((error: unknown) => console.warn('Lane flow:', error));
      void desk.onMessage(message).catch((error: unknown) => console.warn('Desk:', error));
      sessionSync.onMessage(message);
      swarms.onMessage(message);
      // Someone wrote in the lane of an AI teammate this machine runs.
      if (message.type === 'steer' && message.laneUserId !== brain.status().user?.id)
        void swarms
          .direct({
            sessionId: message.sessionId,
            agentId: message.laneUserId,
            text: message.text,
            id: message.id,
            fromUserId: message.fromUserId,
            fromName: message.fromName,
            mention: message.mention,
          })
          .catch((error: unknown) => console.warn('AI teammate task:', error));
      broadcast('brain:message', message);
    },
  },
  app.getVersion(),
);
/** This computer's own agentd: swarms sent to it keep going after the app quits. */
const background = new BackgroundAgents({
  dataDir: app.getPath('userData'),
  agentdScript: join(import.meta.dirname, 'agentd.js'),
  mcpScript: join(import.meta.dirname, 'claude-mcp.js'),
  execPath: process.execPath,
  serverUrl,
  request: (method, path, body) => brain.request(method, path, body),
  checkouts: () => bindings.all(),
  pathEnv: () => userPath(),
  encrypt: (text) => safeStorage.encryptString(text),
  decrypt: (data) => safeStorage.decryptString(data),
  log: (line) => console.log(line),
});

// ---------- external agents (Claude Code, Codex) ----------

/** Each agent's account limit as this machine last saw it; every window is told of changes. */
const agentLimits = new AgentLimits(join(app.getPath('userData'), 'agent-limits.json'));
/** The person's other Claude Code and Codex accounts, each with its own sign-in folder. */
const agentAccounts = new AgentAccounts(app.getPath('userData'));
agentLimits.onChange((limits) => broadcast('agents:limits', limits));

let detected: Promise<ExternalAgent[]> | null = null;
/** Agent CLIs on this machine, detected once per launch (or on demand). */
function externalAgents(refresh = false): Promise<ExternalAgent[]> {
  if (refresh || !detected) detected = detectAgents();
  return detected;
}

/** Kovan's MCP server, run with Electron's own Node so users need nothing else installed. */
// Packaged builds carry both scripts beside the archive (they run as their own processes).
const packagedMcp = app.isPackaged ? join(process.resourcesPath, 'mcp', 'dist') : null;
const mcpServerPath = packagedMcp
  ? join(packagedMcp, 'main.js')
  : createRequire(import.meta.url).resolve('@kovan/mcp-coordination/main');

function mcpServerSpec(conversationId: string | null, root: string): McpServerSpec {
  return {
    command: process.execPath,
    args: [mcpServerPath],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      KOVAN_BRIDGE_FILE: bridge.file,
      KOVAN_WORKSPACE_ROOT: root,
      ...(conversationId ? { KOVAN_CONVERSATION_ID: conversationId } : {}),
    },
  };
}

async function writeMcpConfig(conversationId: string | null, root: string): Promise<string> {
  const dir = join(app.getPath('userData'), 'mcp');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${conversationId ?? 'terminal'}.json`);
  const config = { mcpServers: { kovan: mcpServerSpec(conversationId, root) } };
  await writeFile(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  return file;
}

const team = new TeamTools(brain, bindings);
const flow = new LaneFlow({
  brain,
  bindings,
  contexts: () => [...contexts.values()],
  settings: () => settings.get(),
  checkout: async (session) =>
    (
      await checkouts.ensure({
        id: session.id,
        workspaceId: session.workspaceId,
        title: session.title,
        branch: session.branch,
      })
    ).root,
});

/** Who an MCP call comes from: a conversation (native mode) or a terminal session. */
function callerFor(root: string, conversationId: string | null): TeamCaller {
  const ctx = [...contexts.values()].find((c) => conversationId && c.agents?.has(conversationId));
  const lane = conversationId ? ctx?.agents?.callerOf(conversationId) : null;
  return lane ?? { root, session: null, agent: 'An agent in the terminal' };
}

const bridge = new Bridge(app.getPath('userData'), async ({ tool, args, root, conversationId }) => {
  if (tool === 'approval_prompt') {
    const input = (args['input'] ?? {}) as Record<string, unknown>;
    const toolName = String(args['tool_name'] ?? 'a tool');
    const ctx = [...contexts.values()].find((c) => conversationId && c.agents?.has(conversationId));
    const approved =
      ctx && conversationId
        ? await ctx.agents!.approvalFromAgent(
            conversationId,
            toolName,
            input,
            typeof args['tool_use_id'] === 'string' ? args['tool_use_id'] : null,
          )
        : false;
    // Claude Code's permission-prompt-tool contract.
    return {
      text: JSON.stringify(
        approved
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'The person denied this in Kovan.' },
      ),
    };
  }
  if (tool === 'hook') {
    const workspaceId = await bindings.idFor(root);
    const text = await team
      .hook(
        String(args['event'] ?? ''),
        (args['input'] ?? {}) as Record<string, unknown>,
        { root, session: null, agent: 'An agent in the terminal' },
        async (prompt, paths) =>
          workspaceId
            ? checkOverlap(
                brain,
                {
                  workspaceId,
                  text: prompt,
                  paths,
                  branch: await currentBranch(root).catch(() => null),
                },
                await keys.openRouterKey(),
              )
            : [],
      )
      .catch(() => '');
    return { text };
  }
  if (tool === ISSUE_TOOL.name) return issues.run(args, { root, conversationId });
  return team.call(tool, args, callerFor(root, conversationId));
});

/** Kovan's hook script, run (like the MCP server) with Electron's own Node. */
const hookScriptPath = packagedMcp
  ? join(packagedMcp, 'hook.js')
  : createRequire(import.meta.url).resolve('@kovan/mcp-coordination/hook');

/** Writes Kovan's local agent setup (hooks, MCP, instructions) into a checkout. */
function connectAgentsTo(root: string) {
  return connectRepo(root, mcpServerSpec(null, root), {
    node: process.execPath,
    script: hookScriptPath,
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      KOVAN_BRIDGE_FILE: bridge.file,
      KOVAN_WORKSPACE_ROOT: root,
    },
  });
}

/** Whether this person's agent is mid-turn in a session's lane, in any window. */
function laneRunning(sessionId: string): boolean {
  for (const ctx of contexts.values()) {
    const id = ctx.agents?.laneConversation(sessionId);
    if (id && ctx.agents!.running(id)) return true;
  }
  return false;
}

const checkouts = new SessionCheckouts(
  bindings,
  app.getPath('userData'),
  connectAgentsTo,
  isConnected,
);
/** Each live session's changes on this machine, for the phone and teammates to read. */
const liveDiffs = new LiveDiffs({
  request: (method, path, body) => brain.request(method, path, body),
  read: async (root) => liveDiff(root, await defaultBranch(root)),
  signedIn: () => brain.status().signedIn,
});
const sessionSync = new SessionSync({
  userData: app.getPath('userData'),
  changed: (sessionId, root) => liveDiffs.changed(sessionId, root),
  me: () => brain.status().user,
  request: (method, path) => brain.request(method, path),
  laneEvent: (sessionId, event) => {
    if (brain.status().signedIn) brain.laneEvent(sessionId, event, []);
  },
  emit: (root, state) => {
    for (const ctx of contexts.values())
      if (ctx.workspace?.root === root) ctx.send('sync:state', state);
  },
  laneRunning,
});
const subagents = new SubagentRunner({
  request: (method, path, body) => brain.request(method, path, body),
  checkouts,
  run: (run) => runDetached(run),
  changed: (sessionId, root) => liveDiffs.changed(sessionId, root),
});
/** Kovan's managed usage for the agent, by the person's billing choice (see Settings). */
async function managedEndpoint(): Promise<{ baseUrl: string; token: string } | null> {
  const mode = (await settings.get()).modelBilling;
  if (mode === 'own') return null;
  if (mode === 'auto' && (await keys.openRouterKey())) return null;
  return brain.managedEndpoint();
}

function runDetached(run: Parameters<AgentManager['runDetached']>[0]) {
  const ctx = [...contexts.values()].find((c) => c.agents);
  if (!ctx) throw new Error('Open a window to run AI agents.');
  return ctx.agents!.runDetached(run);
}

const arena = new ArenaRunner({
  dir: app.getPath('userData'),
  run: (run) => runDetached(run),
  version: app.getVersion(),
  onProgress: (progress) => broadcast('arena:progress', progress),
});

const swarms = new SwarmRunner({
  request: (method, path, body, options) => brain.request(method, path, body, options),
  me: () => brain.status().user,
  laneEvent: (sessionId, event, touched, agentId) => {
    if (brain.status().signedIn) brain.laneEvent(sessionId, event, touched, agentId);
  },
  subagents,
  run: runDetached,
  checkoutOf: (session) =>
    checkouts.existing({
      id: session.id,
      workspaceId: session.workspaceId,
      title: session.title,
      branch: session.branch,
    }),
  notify: (title, body) => {
    void notifyNative(title, body, {
      onBlocked: () => askForAttention(BrowserWindow.getAllWindows()[0] ?? null),
    });
  },
});

/** Work asked for on the person's phone that this machine does (it runs their agents). */
const desk = new Desk({
  request: (method, path, body) => brain.request(method, path, body),
  machineId: () => brain.machineId,
  canCarry: (sessionId, workspaceId) => flow.canCarry(sessionId, workspaceId),
  hasWorkspace: async (workspaceId) => Boolean((await bindings.all())[workspaceId]),
  takeover: (sessionId, laneUserId) => flow.takeover(sessionId, laneUserId),
  continueWith: (handoffId) => flow.continueWith(handoffId),
  handoff: (sessionId, toUserId) => flow.handoff(sessionId, toUserId),
  checkout: (session) => checkouts.ensure(session),
  launchSwarm: (swarmId, root) => swarms.launch(swarmId, root),
  prompt: (session, text) => flow.prompt(session, text),
});
const github = new GithubClient({
  apiBase: process.env['KOVAN_GITHUB_API'],
  envToken: process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN'] ?? null,
});

/** Agents' GitHub issues: drafted by the agent, approved (and edited) by the person on a card. */
const issues = new IssueTool({
  github,
  otherRoots: async (root) =>
    (await recents.list())
      .map((r) => r.root)
      .filter((r) => r !== root)
      .slice(0, 8),
  card: async (conversationId, card) => {
    const ctx = [...contexts.values()].find((c) => c.agents?.has(conversationId));
    return ctx ? ctx.agents!.card(conversationId, card) : null;
  },
  noAsk: async () => (await settings.get()).issueNoAsk,
  rememberNoAsk: async (repo) => {
    const current = (await settings.get()).issueNoAsk;
    if (!current.includes(repo)) await settings.update({ issueNoAsk: [...current, repo] });
  },
});

// Crashes in the main process go to the error reporter (when signed in and allowed).
process.on('uncaughtException', (error) => {
  console.error(error);
  void brain.reportError('main', error.message, error.stack ?? null);
});
process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  console.error(error);
  void brain.reportError('main', error.message, error.stack ?? null);
});

function isAppUrl(url: string): boolean {
  if (rendererOrigin) return new URL(url).origin === rendererOrigin;
  return url.startsWith(pathToFileURL(rendererFile).href);
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url;
  return typeof url === 'string' && isAppUrl(url);
}

async function createWindow(folder: string | null = null): Promise<BrowserWindow> {
  const isMac = process.platform === 'darwin';
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: PRODUCT_NAME,
    ...(isDev && process.platform !== 'darwin' ? { icon: devIcon } : {}),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#101010' : '#ffffff',
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 12 } }
      : {}),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      // Keep rendering while a remote-debugged dev window sits behind other windows.
      backgroundThrottling: !(isDev && debugPort),
    },
  });

  const ctx = new WindowContext(window, (root) => bindings.worktree(root), {
    files: (root) => sessionSync.onFilesChanged(root),
    closed: (root) => {
      if (![...contexts.values()].some((c) => c !== ctx && c.workspace?.root === root))
        sessionSync.detach(root);
    },
  });
  ctx.agents = new AgentManager(app.getPath('userData'), keys, customProviders, {
    emit: (conversationId, event) => ctx.send('agent:event', conversationId, event),
    team,
    snapshot: async (session, root) => {
      const me = brain.status().user;
      if (!me) return null;
      return pushSnapshot(
        root,
        snapshotRef(session.id, me.id),
        `Kovan snapshot: ${me.name} in "${session.title}"`,
      );
    },
    mirror: (session, event, touched, root) => {
      if (brain.status().signedIn) brain.laneEvent(session.id, event, touched);
      if (touched.length > 0 || event.type === 'turn_end') liveDiffs.changed(session.id, root);
    },
    notify: (title, body) => {
      if (window.isDestroyed() || window.isFocused()) return;
      void notifyNative(title, body, {
        onClick: () => {
          if (window.isDestroyed()) return;
          if (window.isMinimized()) window.restore();
          window.focus();
        },
        onBlocked: () => askForAttention(window),
      });
    },
    // A lane started from the phone works in a session worktree this window doesn't show.
    isRepo: (root) =>
      ctx.workspace?.root === root
        ? ctx.workspace.isRepo
        : Boolean(statSync(join(root, '.git'), { throwIfNoEntry: false })),
    accountEnv: async (harness, account) => {
      if (!account) return {};
      const env = await agentAccounts.env(harness, account);
      return Object.keys(env).length ? env : null;
    },
    agentBinary: async (harness) =>
      (await externalAgents()).find((a) => a.id === harness && a.supported)?.path ?? null,
    pathEnv: userPath,
    mcpConfig: (conversationId, root) => writeMcpConfig(conversationId, root),
    mcpServer: (conversationId, root) => mcpServerSpec(conversationId, root),
    paused: (root) => sessionSync.pausedReason(root),
    managed: () => managedEndpoint(),
    workspaceOf: (root) => bindings.idFor(root),
    limits: agentLimits,
    settings: () => settings.get(),
    skills: (root) => skills.forRoot(root),
    mcpTools: (root, ask) => mcp.toolsFor(root, ask),
    tools: (conversationId, root) => [issues.harnessTool(() => ({ root, conversationId }))],
    // Kovan's agent hands work to a subagent beside its session lane (as the person can).
    delegate: async (conversationId, task, onSettled) => {
      const config = ctx.agents?.configOf(conversationId);
      if (!config?.session) throw new Error('Subagents run beside a session lane.');
      const sub = await subagents.start({
        sessionId: config.session.id,
        parentRoot: config.root,
        task,
        model: config.model,
        effort: config.effort,
        parentMode: config.mode,
        onSettled,
      });
      return { id: sub.id };
    },
    laneIdle: (sessionId) => sessionSync.laneIdle(sessionId),
    reportUsage: (root, conversationId, receipt) => {
      if (!brain.status().signedIn) return;
      void (async () => {
        // A shared workspace's usage is filed under it; anything else under the person only.
        const workspaceId = await bindings.idFor(root);
        await brain.request('POST', '/api/usage', {
          workspaceId,
          conversationId,
          records: receipt,
        });
      })().catch((error: unknown) => console.warn('Could not file usage:', error));
    },
  });
  const id = window.webContents.id;
  contexts.set(id, ctx);
  window.on('closed', () => {
    ctx.close();
    contexts.delete(id);
  });

  // Never navigate the app window away; open web links in the system browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });

  // The window title carries the workspace and connection state; don't let <title> replace it.
  window.on('page-title-updated', (event) => event.preventDefault());
  window.once('ready-to-show', () => (debugPort && isDev ? window.showInactive() : window.show()));
  ctx.updateTitle();

  if (folder) {
    try {
      const info = await ctx.openWorkspace(folder);
      if (!info.session) await recents.add(info.root, info.name);
    } catch (error) {
      console.error(`Could not open ${folder}:`, error);
    }
  }

  if (devServerUrl) await window.loadURL(devServerUrl);
  else await window.loadFile(rendererFile);
  ctx.connection = brain.status().connection;
  ctx.updateTitle();
  ctx.send('connection:state', ctx.connection);
  return window;
}

// Packaged builds get their icon from the bundle; dev builds set it so the Dock shows Kovan.
const devIcon = join(import.meta.dirname, '../../build/icon.png');

let updater: Updater;

const selfTest = process.argv.includes('--self-test');
if (selfTest) app.dock?.hide();

void app.whenReady().then(async () => {
  if (selfTest) {
    const ok = await runSelfTest(
      {
        renderer: rendererFile,
        preload: join(import.meta.dirname, '../preload/index.cjs'),
        mcpServer: mcpServerPath,
        hookScript: hookScriptPath,
      },
      app.getVersion(),
      app.getPath('userData'),
    );
    app.exit(ok ? 0 : 1);
    return;
  }
  if (isDev && process.platform === 'darwin') app.dock?.setIcon(devIcon);
  // Loaded here, not at the top: electron-updater reads app paths as soon as it is imported.
  // Dev only: KOVAN_DEV_UPDATE_FEED runs the real updater against a local feed
  // (dev-app-update.yml), to exercise checking and downloading without a packaged build.
  const devFeed = isDev ? process.env['KOVAN_DEV_UPDATE_FEED'] : undefined;
  const electronUpdater = isDev && !devFeed ? null : await import('electron-updater');
  const autoUpdater = (electronUpdater?.default ?? electronUpdater)?.autoUpdater;
  if (autoUpdater && devFeed) autoUpdater.forceDevUpdateConfig = true;
  updater = new Updater({
    backend: (autoUpdater ?? {}) as UpdateBackend,
    feedUrl: devFeed ?? `${serverUrl.replace(/\/$/, '')}/updates`,
    platform: process.platform,
    packaged: app.isPackaged || Boolean(devFeed),
    currentVersion: app.getVersion(),
    publicKey: UPDATE_PUBLIC_KEY,
    onState: (state) => {
      broadcast('update:state', state);
      // A short trail for support: what the updater did and when.
      void appendFile(
        join(app.getPath('userData'), 'update.log'),
        `${new Date().toISOString()} ${state.status}${state.version ? ` ${state.version}` : ''}${state.message ? ` · ${state.message}` : ''}\n`,
      ).catch(() => {});
    },
    beforeInstall: () => bridge.stop(),
  });
  const initial = await settings.get();
  nativeTheme.themeSource = initial.theme;
  settings.onChange((next) => {
    nativeTheme.themeSource = next.theme;
    updater.setAutomatic(next.autoUpdate);
    mcp.allow(next.mcpAlwaysAllow);
    for (const ctx of contexts.values()) ctx.send('settings:changed', next);
  });

  await brain.init();
  await bridge.start();
  // Background agents that were on keep running (started again if they stopped).
  void background.start().catch((error: unknown) => console.warn('Background agents:', error));
  registerIpc({
    contextFor: (event) => contexts.get(event.sender.id),
    isTrustedSender,
    settings,
    recents,
    brain,
    bindings,
    keys,
    customProviders,
    team,
    flow,
    connectRepo: connectAgentsTo,
    managedAvailable: async () => (await managedEndpoint()) !== null,
    updater,
    checkouts,
    sessionSync,
    subagents,
    swarms,
    arena,
    github,
    issues,
    externalAgents,
    agentLimits: () => agentLimits.list(),
    background,
    skills,
    mcp,
    plugins,
    openExternal,
    accounts: agentAccounts,
    accountStatus: async (harness, account) => {
      const cli = (await externalAgents()).find((a) => a.id === harness && a.supported);
      if (!cli?.path) return null;
      return signedIn(cli.path, harness, {
        PATH: await userPath(),
        ...(await agentAccounts.env(harness, account)),
      });
    },
    agentProgram: async (agent, root, as) => {
      const cli = (await externalAgents()).find((a) => a.id === agent && a.supported);
      if (!cli?.path) throw new Error(`${HARNESS_NAMES[agent]} is not installed on this machine.`);
      const accountEnv = await agentAccounts.env(agent, as?.account);
      // Signing an account in: the CLI's own sign-in, in that account's folder.
      if (as?.login)
        return {
          file: cli.path,
          args: agent === 'codex' ? ['login'] : ['auth', 'login'],
          env: { PATH: await userPath(), ...accountEnv },
        };
      const args =
        agent === 'claude-code'
          ? [
              '--mcp-config',
              await writeMcpConfig(null, root),
              '--append-system-prompt',
              KOVAN_APPEND_PROMPT,
            ]
          : codexMcpArgs(mcpServerSpec(null, root));
      return { file: cli.path, args, env: { PATH: await userPath(), ...accountEnv } };
    },
  });
  Menu.setApplicationMenu(buildMenu((commandId) => sendMenuCommand(contexts, commandId), isDev));

  await createWindow(folderFromArgs());
  updater.setAutomatic(initial.autoUpdate);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('will-quit', () => void bridge.stop());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let swarmsPaused = false;
app.on('before-quit', (event) => {
  // Swarms this app runs pause first (a moment), so nobody takes them for still working.
  if (!swarmsPaused) {
    swarmsPaused = true;
    if (swarms.runningIds().length) {
      event.preventDefault();
      void swarms
        .pauseAll('The app running it was closed: resume it to go on')
        .finally(() => app.quit());
      return;
    }
  }
  for (const ctx of contexts.values()) ctx.close();
  sessionSync.detachAll();
  liveDiffs.stop();
  subagents.stopAll();
  swarms.stopAll();
  arena.stop();
  // MCP servers started for agents stop with the app.
  void mcp.stop();
});
