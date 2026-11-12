// The contract between the main process and the renderer.
// Main implements `InvokeContract` with ipcMain.handle; preload exposes it as `window.kovan`.

import type { BranchInfo, DiffSides, GraphCommit, RepoStatus } from '@kovan/git-engine';
import type { ModelInfo } from '@kovan/model-gateway';
import type {
  ArenaProgress,
  ChangeImpact,
  ArenaRequest,
  ArenaRun,
  Handoff,
  ServerMessage,
  SessionPr,
  Subagent,
  Swarm,
  User,
} from '@kovan/shared';

import type {
  AgentAccount,
  ExternalHarness,
  Attachment,
  Conversation,
  ConversationConfig,
  ConversationEvent,
  ConversationSummary,
  CustomProviderInfo,
  CustomProviderInput,
  Harness,
  IssueEdits,
  SessionLink,
  ProviderStatus,
  Readiness,
} from './agent.js';
import type { AgentLimit } from './limits.js';
import type { Settings } from './settings.js';

/** Where self-update stands. `ready` means a new version is downloaded and waiting. */
export interface UpdateState {
  status: 'unsupported' | 'idle' | 'checking' | 'current' | 'downloading' | 'ready' | 'error';
  currentVersion: string;
  /** The version being downloaded or staged. */
  version?: string;
  percent?: number;
  message?: string;
}

/** What the OS did with a notification. `skipped`: the window was in front, so none was sent. */
export interface NotifyResult {
  shown: boolean;
  skipped?: boolean;
  /** Why the OS refused, and what the person can do about it. */
  error?: string;
  hint?: string | null;
}

export interface AppInfo {
  name: string;
  version: string;
  platform: 'darwin' | 'win32' | 'linux' | (string & {});
  homeDir: string;
  /** The OS account name, used for the avatar until the person signs in. */
  userName: string;
  /** A screen reader (or other assistive tech) is running: the terminal then reads out. */
  screenReader?: boolean;
  /** The system's language ("tr-TR"). */
  locale?: string;
}

export interface WorkspaceInfo {
  /** Absolute path. When the opened folder is inside a git repo, this is the repo's top level. */
  root: string;
  name: string;
  isRepo: boolean;
  /** A session's own worktree: the repository's main checkout, and the session it is for. */
  repoRoot?: string;
  session?: { id: string; workspaceId: string; branch: string; title: string };
}

/** A teammate's version of a file kept beside yours when both changed the same lines. */
export interface SyncVersion {
  id: string;
  path: string;
  peerId: string;
  peerName: string;
  at: number;
  /** They deleted the file. */
  deleted: boolean;
}

/** How a session checkout syncs with the teammates in the session. */
export interface SyncState {
  sessionId: string;
  workspaceId: string;
  root: string;
  branch: string;
  /** The workspace's automatic Git sync switch. */
  enabled: boolean;
  status: 'on' | 'off' | 'syncing' | 'paused';
  /** branch: a manual branch switch paused the session; sync: the remote refused the snapshot. */
  paused: { kind: 'branch' | 'sync'; reason: string } | null;
  lastPushAt: number | null;
  lastPullAt: number | null;
  versions: SyncVersion[];
  /** Files teammates changed recently, and who. */
  editors: Record<string, { userId: string; name: string }[]>;
}

export interface RecentWorkspace {
  root: string;
  name: string;
  openedAt: number;
}

export interface DirEntry {
  name: string;
  /** Path relative to the workspace root, with forward slashes. */
  path: string;
  kind: 'file' | 'dir';
}

export type FileContent =
  { kind: 'text'; content: string } | { kind: 'binary' } | { kind: 'tooLarge'; size: number };

/** This computer's background agents (its own agentd, which outlives the app). */
export interface BackgroundStatus {
  enabled: boolean;
  running: boolean;
  /** Its machine name in Kovan. */
  name: string | null;
  /** Where it logs. */
  log: string | null;
}

/** A file on a session's branch on the remote (written by a machine), or why it isn't there. */
export type BranchFile =
  | { file: FileContent; remote: string; commit: string }
  | { missing: 'branch'; remote: string | null }
  | { missing: 'file'; remote: string; commit: string };

export interface FsChangeEvent {
  /** Changed paths relative to the workspace root. */
  paths: string[];
  /** True when something under .git changed (HEAD, index, refs). */
  gitChanged: boolean;
}

/** What came of taking over a teammate's lane. */
export interface TakeoverResult {
  status: 'requested' | 'continued';
  /** "Resuming at step 2 of 3." when the plan had a step to resume. */
  resume: string | null;
  applied: 'fast-forward' | 'merged' | 'already' | 'none';
}

/** A live session a prompt would collide with, and why. */
export interface OverlapWarning {
  sessionId: string;
  title: string;
  people: string[];
  kind: 'overlapping' | 'adjacent';
  reason: string;
}

/** Why this machine can't join a session yet, and what fixes it. */
export type JoinCheck =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      fix: 'setup' | 'provider' | 'branch' | 'checkout' | 'watch' | null;
      branch?: string;
      /** For 'provider': the settings page that fixes it (a key, billing, an account). */
      section?: 'providers' | 'billing' | 'agents';
    };

/** A session as the checkout code needs it. */
export interface SessionCheckoutInput {
  id: string;
  workspaceId: string;
  title: string;
  branch: string | null;
}

export interface TerminalCreateOptions {
  cols: number;
  rows: number;
  /** Run this agent CLI's own TUI instead of a shell. */
  agent?: ExternalHarness;
  /** Runs the agent as one of the person's other accounts; `login` starts its sign-in. */
  account?: string;
  login?: boolean;
}

export type ConnectionState = 'offline' | 'connecting' | 'online';

export interface BrainStatus {
  serverUrl: string;
  signedIn: boolean;
  user: User | null;
  connection: ConnectionState;
}

/** A local folder looked at before it becomes (or is matched to) a workspace. */
export interface RepoInfo {
  root: string;
  name: string;
  isRepo: boolean;
  /** Normalised origin, e.g. "github.com/owner/repo". */
  remoteUrl: string | null;
  /** The origin exactly as configured, for cloning. */
  rawRemote: string | null;
  branch: string | null;
}

/** A skill as Settings lists it. */
export interface SkillInfo {
  name: string;
  description: string;
  /**
   * "repo" `.kovan/skills`, "repo-claude" `.claude/skills`, "user" Kovan's, "plugin" an
   * installed plugin's, "claude-code" ~/.claude.
   */
  source: 'repo' | 'repo-claude' | 'user' | 'plugin' | 'claude-code';
  /** The plugin it came with. */
  plugin: string | null;
  /** Its folder: relative inside the workspace, else absolute. */
  path: string;
  enabled: boolean;
}

/** Where a plugin comes from: a git URL (or GitHub's owner/repo) or a folder on this machine. */
export interface PluginSourceInput {
  source: string;
  /** A folder inside it ('' for the top). */
  path: string;
  /** A branch or tag ('' for the default). */
  ref: string;
}

export interface PluginManifestInfo {
  name: string;
  version: string | null;
  description: string;
  author: string | null;
  homepage: string | null;
}

/** What a plugin brings, and the parts Kovan doesn't use. */
export interface PluginContents {
  skills: { name: string; description: string }[];
  /** Its MCP servers and what each runs (or reaches). */
  mcpServers: { name: string; detail: string }[];
  /** Claude Code parts Kovan doesn't read yet, e.g. "3 commands", "hooks". */
  unused: string[];
  warnings: string[];
}

export type PluginPreview =
  | {
      kind: 'plugin';
      /** Fetched and waiting: install it with this, or discard it. */
      stagingId: string;
      manifest: PluginManifestInfo;
      contents: PluginContents;
      /** The commit fetched (git) or null (a folder). */
      commit: string | null;
      /** A plugin of that name is installed already. */
      installed: boolean;
    }
  | {
      kind: 'marketplace';
      name: string;
      plugins: { name: string; description: string; source: PluginSourceInput }[];
    };

export interface PluginInfo extends PluginManifestInfo {
  source: { kind: 'git' | 'folder'; label: string } & PluginSourceInput;
  commit: string | null;
  installedAt: string;
  updatedAt: string;
  contents: PluginContents;
  /** On for agents in the open workspace (null without one). */
  enabledHere: boolean | null;
  /** On in workspaces that weren't switched one way or the other. */
  everywhere: boolean;
  dir: string;
}

export interface PluginListing {
  plugins: PluginInfo[];
  root: string | null;
}

export type PluginUpdate =
  | { upToDate: true }
  | {
      upToDate: false;
      stagingId: string;
      from: { version: string | null; commit: string | null };
      to: { version: string | null; commit: string | null };
      /** `git diff --stat` of the change. */
      stat: string;
      patch: string;
      /** The patch was too long to show whole. */
      patchCut: boolean;
      contents: PluginContents;
    };

export interface SkillListing {
  skills: SkillInfo[];
  /** Skills that couldn't be read, and why. */
  warnings: { path: string; problem: string }[];
  /** The person's Kovan skills folder. */
  userDir: string;
  /** The open workspace, whose `.kovan/skills` and `.claude/skills` were read. */
  root: string | null;
}

/** A server as Settings edits it. Secret values: a new one, or null to keep the saved one. */
export interface McpServerInput {
  name: string;
  /** The name it was saved under, when editing (a rename keeps its secrets). */
  previousName: string | null;
  type: 'stdio' | 'http';
  command: string;
  args: string[];
  url: string;
  env: { name: string; value: string | null }[];
  headers: { name: string; value: string | null }[];
}

export type McpServerStatus =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'needs-auth'
  | 'failed'
  | 'closed'
  /** Turned off in Settings. */
  | 'off'
  /** A repository's server nobody has allowed yet (or that was declined). */
  | 'untrusted';

export interface McpServerInfo {
  name: string;
  /** The person's own list, an installed plugin, or a file in the open repository. */
  source: 'personal' | 'plugin' | 'repo';
  /** For repository servers: `.mcp.json` or `.kovan/mcp.json`; for a plugin's: its name. */
  file: string | null;
  type: 'stdio' | 'http';
  command: string;
  args: string[];
  url: string;
  /** Names only: the values stay in the keychain. */
  envNames: string[];
  headerNames: string[];
  /** Values written straight into the person's file (saving from Settings moves them). */
  plainValues: boolean;
  enabled: boolean;
  /** Repository servers: what the person decided ("once" lasts until Kovan quits). */
  trust: 'always' | 'once' | 'deny' | 'ask' | null;
  /** What the trust decision is kept under (changes with the server's config). */
  trustKey: string | null;
  status: McpServerStatus;
  error: string | null;
  tools: string[];
  /** A remote server Kovan holds sign-in tokens for. */
  signedIn: boolean;
  /** Shadowed by a repository server of the same name. */
  hidden: boolean;
}

export interface McpListing {
  servers: McpServerInfo[];
  problems: { source: 'personal' | 'plugin' | 'repo'; name: string; problem: string }[];
  /** The open workspace whose `.mcp.json` / `.kovan/mcp.json` were read. */
  root: string | null;
  /** Whether secrets can go to the OS keychain here. */
  keychain: boolean;
}

export interface McpCheck {
  ok: boolean;
  tools: string[];
  error: string | null;
  needsSignIn: boolean;
}

export interface ExternalAgentInfo {
  id: 'claude-code' | 'codex' | 'opencode' | 'cursor';
  name: string;
  command: string;
  path: string | null;
  version: string | null;
  supported: boolean;
  reason: string | null;
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** Request/response calls: channel -> handler signature. */
export interface InvokeContract {
  'app:info': () => AppInfo;
  'app:notify': (title: string, body: string, force?: boolean) => NotifyResult;
  'update:state': () => UpdateState;
  'update:check': () => UpdateState;
  /** Quits, installs the staged update and starts the new version. */
  'update:install': () => boolean;

  'workspace:openDialog': () => WorkspaceInfo | null;
  'workspace:open': (root: string) => WorkspaceInfo;
  'workspace:current': () => WorkspaceInfo | null;
  'workspace:recent': () => RecentWorkspace[];
  'workspace:forgetRecent': (root: string) => RecentWorkspace[];

  'fs:readDir': (path: string) => DirEntry[];
  'fs:readFile': (path: string) => FileContent;
  'fs:writeFile': (path: string, content: string) => void;
  'fs:listFiles': () => string[];

  'git:status': () => RepoStatus | null;
  /** A file as it is on a branch on the remote, in a workspace's checkout here. */
  'git:branchFile': (
    workspaceId: string,
    branch: string,
    path: string,
    refresh: boolean,
  ) => BranchFile;
  /** The commit checked out now, to pin notes and comments to. */
  'git:head': () => string | null;
  'git:diffSides': (path: string, staged: boolean) => DiffSides;
  'git:stage': (paths: string[]) => void;
  'git:unstage': (paths: string[]) => void;
  'git:discard': (paths: string[]) => void;
  'git:commit': (message: string) => string;
  /** A commit message written by a small model for the staged (or all) changes. */
  'git:suggestMessage': () => { message: string; cost: number | null };
  'git:branches': () => BranchInfo[];
  'git:checkout': (branch: string) => void;
  'git:createBranch': (branch: string) => void;

  'terminal:create': (options: TerminalCreateOptions) => number;
  'terminal:write': (id: number, data: string) => void;
  'terminal:resize': (id: number, cols: number, rows: number) => void;
  'terminal:kill': (id: number) => void;
  /** The person's other Claude Code and Codex accounts on this machine. */
  'accounts:list': () => AgentAccount[];
  /** `home`: the CLI's own sign-in on this computer, not one kept by Kovan. */
  'accounts:add': (harness: ExternalHarness, name: string, home?: boolean) => AgentAccount;
  'accounts:remove': (id: string) => void;
  /** Asks the CLI whether it is signed in as the account (null: the default sign-in). */
  'accounts:status': (
    harness: ExternalHarness,
    account: string | null,
  ) => { signedIn: boolean; who: string | null } | null;

  'settings:get': () => Settings;
  'settings:update': (patch: Partial<Settings>) => Settings;

  'brain:status': () => BrainStatus;
  'brain:login': (intent: 'login' | 'link') => User;
  'brain:cancelLogin': () => void;
  'brain:logout': () => void;
  'brain:request': (method: HttpMethod, path: string, body?: unknown) => unknown;
  'brain:presence': (workspaceId: string | null, status: 'active' | 'idle') => void;
  'brain:subscribe': (workspaceId: string) => void;
  'brain:reportError': (message: string, stack: string | null) => void;

  /** Which local folder each shared workspace lives in on this machine. */
  'bindings:get': () => Record<string, string>;
  'bindings:set': (workspaceId: string, path: string | null) => Record<string, string>;
  'repo:choose': () => string | null;
  'repo:inspect': (path: string) => RepoInfo;
  /** Makes the open folder a Git repository (so the agent's changes can be seen and undone). */
  'repo:init': () => void;
  'repo:clone': (url: string, name: string) => string | null;

  'agent:list': () => ConversationSummary[];
  'agent:create': () => Conversation;
  'agent:open': (id: string) => Conversation;
  'agent:remove': (id: string) => void;
  'agent:configure': (id: string, patch: Partial<ConversationConfig>) => Conversation;
  /** Whether an agent set up like this can start now, and if not why (asked before sending). */
  'agent:readiness': (choice: {
    auto: boolean;
    harness: Harness;
    model: string;
    account?: string;
  }) => Readiness;
  'agent:send': (id: string, text: string, attachments: Attachment[]) => void;
  'agent:stop': (id: string) => void;
  'agent:approve': (id: string, approvalId: string, approved: boolean) => void;
  /** Where a person's own issue can go (this checkout's repositories), and look-alikes. */
  'issue:draft': (title: string) => {
    repos: string[];
    similar: { number: number; title: string; url: string }[];
  };
  'issue:similar': (
    repo: string,
    title: string,
  ) => { number: number; title: string; url: string }[];
  /** Opens it on GitHub as the person (git's credentials), or comments on an open one. */
  'issue:file': (edits: IssueEdits) => { url: string; text: string };
  /** Approves an issue card with what the person changed on it. */
  'agent:approveIssue': (id: string, approvalId: string, edits: IssueEdits) => void;
  /** Guidance for your running turn; false when the agent can't take it mid-turn. */
  'agent:steer': (id: string, text: string) => boolean;
  /** Calls an AI teammate into this session conversation with @; it answers here. */
  'agent:mention': (id: string, agentId: string, name: string, text: string) => void;
  /** This person's lane conversation for a session (created on first use) in this window. */
  'session:lane': (session: SessionLink) => Conversation;
  /** The checks this machine runs before joining: setup, agent, branch, push access. */
  'session:precheck': (input: {
    sessionId?: string | undefined;
    workspaceId: string;
    branch: string | null;
    harness: Harness;
  }) => JoinCheck;
  'session:switchBranch': (branch: string) => void;
  'session:currentBranch': () => string | null;
  'session:finalDiff': (baseBranch: string) => string | null;
  /** Follow a session live (snapshot, then lane events) while a view shows it. */
  'session:follow': (sessionId: string) => void;
  /** Checks pinned notes and comments against this checkout after HEAD moved. */
  'brain:verifyAnchors': () => { flagged: number; outdated: number };
  /** Guidance for a running lane: your own (here) or a teammate's (through the Brain). */
  'session:steer': (sessionId: string, laneUserId: string, text: string) => { sent: boolean };
  /** Takes over a teammate's lane; continues at once if it's ready, else when they checkpoint. */
  'session:takeover': (sessionId: string, laneUserId: string) => TakeoverResult;
  /** Accepts work handed to you: apply the snapshot, carry on from the plan. */
  'session:continue': (handoffId: string) => TakeoverResult;
  /** Gives your lane's work to a teammate. */
  'session:handoff': (sessionId: string, toUserId: string) => Handoff;
  /** Before a prompt: does it collide with a teammate's live session? */
  'overlap:check': (input: { text: string; paths: string[] }) => OverlapWarning[];
  /** Connects the agent CLIs in this repo to Kovan (hooks, MCP, instructions), kept local. */
  'repo:connectAgents': () => { written: string[]; excluded: string[]; skipped: string[] };
  'repo:agentsConnected': () => boolean;
  'session:unfollow': (sessionId: string) => void;
  /** The session's checkout here (its own worktree unless the main checkout is on its branch). */
  'session:checkout': (session: SessionCheckoutInput) => { root: string; created: boolean };
  'session:checkoutOf': (session: SessionCheckoutInput) => string | null;
  /** Removes a finished session's worktree; its branch stays. */
  'session:removeCheckout': (sessionId: string) => void;
  /** Starts syncing this window's checkout with the session's teammates. */
  'sync:attach': (link: { sessionId: string; workspaceId: string; branch: string }) => SyncState;
  'sync:state': () => SyncState | null;
  'sync:setEnabled': (workspaceId: string, on: boolean) => void;
  /** Retry after a refused sync, or resume after switching back to the session's branch. */
  'sync:resume': () => SyncState | null;
  'sync:switchBack': () => SyncState | null;
  'sync:version': (id: string) => string | null;
  'sync:resolve': (id: string, keep: 'mine' | 'theirs') => SyncState;
  /** Keeps the file on disk as a version before your unsaved buffer replaces it. */
  'sync:keepDisk': (path: string) => void;
  /** Starts a subagent beside a lane, from a snapshot of its checkout. */
  'subagent:start': (conversationId: string, task: string) => Subagent;
  'subagent:retry': (id: string) => void;
  'subagent:discard': (id: string) => void;
  /** Where a subagent's work is on this machine (to review it), or null. */
  'subagent:path': (id: string) => string | null;
  'git:push': () => string;
  'git:graph': (limit: number) => GraphCommit[];
  /** What the open changes (staged, unstaged, new files) can reach: tests, modules, routes. */
  'impact:working': () => ChangeImpact;
  /** Opens the session's pull request with your GitHub credentials. */
  'pr:create': (
    sessionId: string,
    input: { title: string; body: string; base: string },
  ) => SessionPr;
  /** Checks the PR on GitHub; a merged PR completes the session. */
  'pr:refresh': (sessionId: string) => SessionPr | null;
  /** Launches (or resumes) the session's swarm on this machine; you pay for its agents. */
  'swarm:launch': (swarmId: string) => Swarm;
  'swarm:running': (swarmId: string) => boolean;
  /** Runs the same task for several configurations of Kovan's agent, apart from your checkout. */
  'arena:start': (request: ArenaRequest) => { arenaId: string; commit: string };
  'arena:stop': () => void;
  'arena:running': () => boolean;
  /** Every arena run kept on this machine, oldest first. */
  'arena:runs': () => ArenaRun[];
  'models:list': (refresh: boolean) => ModelInfo[];
  /** When the catalog's prices were last fetched (ms since epoch). */
  'models:checkedAt': () => number | null;
  'providers:status': () => ProviderStatus;
  'background:status': () => BackgroundStatus;
  /** On: a machine key for the organization, then agentd; off: stopped and the key revoked. */
  'background:set': (enabled: boolean) => BackgroundStatus;
  /** Agent CLIs found on this machine (Claude Code, Codex, …). */
  'agents:external': (refresh: boolean) => ExternalAgentInfo[];
  /** The skills Kovan's agent sees in this window's workspace. */
  'skills:list': () => SkillListing;
  /** Opens the person's skills folder (made if missing). */
  'skills:openFolder': () => void;
  /** The person's MCP servers and the open repository's, with how each is doing. */
  'mcp:list': () => McpListing;
  /** Adds or edits a server of the person's (secret values go to the keychain). */
  'mcp:save': (input: McpServerInput) => void;
  'mcp:remove': (name: string) => void;
  'mcp:setEnabled': (name: string, enabled: boolean) => void;
  /** Starts a server from the form (not saved) and lists its tools. */
  'mcp:test': (input: McpServerInput) => McpCheck;
  /** Starts a saved server again and lists its tools. */
  'mcp:check': (name: string) => McpCheck;
  /** Signs in to a remote server in the browser; resolves once it's done (or failed). */
  'mcp:signIn': (name: string) => McpCheck;
  'mcp:signOut': (name: string) => void;
  /** A repository server: always / never, or null to ask again. */
  'mcp:trust': (key: string, decision: 'always' | 'deny' | null) => void;
  'plugins:list': () => PluginListing;
  /** Fetches a plugin (or a marketplace's list) without installing anything. */
  'plugins:preview': (input: PluginSourceInput) => PluginPreview;
  'plugins:install': (stagingId: string) => void;
  'plugins:discard': (stagingId: string) => void;
  /** Fetches the plugin's source again and shows what would change. */
  'plugins:checkUpdate': (name: string) => PluginUpdate;
  'plugins:update': (name: string, stagingId: string) => void;
  'plugins:remove': (name: string) => void;
  /** On or off in the open workspace. */
  'plugins:setEnabled': (name: string, enabled: boolean) => void;
  'plugins:setEverywhere': (name: string, everywhere: boolean) => void;
  'plugins:chooseFolder': () => string | null;
  /** Each agent's account limit, as this machine last saw it. */
  'agents:limits': () => AgentLimit[];
  'providers:setOpenRouterKey': (key: string | null) => ProviderStatus;
  'providers:custom:list': () => CustomProviderInfo[];
  /** Checks the endpoint by listing its models, then saves it (and its key, in the keychain). */
  'providers:custom:save': (input: CustomProviderInput) => CustomProviderInfo[];
  'providers:custom:refresh': (id: string) => CustomProviderInfo[];
  'providers:custom:remove': (id: string) => CustomProviderInfo[];
}

export type InvokeChannel = keyof InvokeContract;

/** Main -> renderer events: channel -> payload arguments. */
export interface EventContract {
  'fs:changed': [event: FsChangeEvent];
  'terminal:data': [id: number, data: string];
  'terminal:exit': [id: number, exitCode: number];
  'settings:changed': [settings: Settings];
  'update:state': [state: UpdateState];
  'menu:command': [commandId: string];
  'connection:state': [state: ConnectionState];
  'brain:user': [user: User | null];
  /** While a sign-in waits: the code an emailed sign-in link asks for. */
  'brain:loginCode': [code: string | null];
  'brain:message': [message: ServerMessage];
  'agent:event': [conversationId: string, event: ConversationEvent];
  /** Conversations of the open folder written from elsewhere (the terminal agent). */
  'agent:changed': [conversationIds: string[]];
  'agents:limits': [limits: AgentLimit[]];
  'arena:progress': [progress: ArenaProgress];
  'sync:state': [state: SyncState | null];
}

export type EventChannel = keyof EventContract;

type Promisify<F> = F extends (...args: infer A) => infer R ? (...args: A) => Promise<R> : never;

export type Unsubscribe = () => void;

/** The API the renderer sees as `window.kovan`. */
export interface KovanApi {
  invoke<C extends InvokeChannel>(
    channel: C,
    ...args: Parameters<InvokeContract[C]>
  ): ReturnType<Promisify<InvokeContract[C]>>;
  on<C extends EventChannel>(
    channel: C,
    listener: (...args: EventContract[C]) => void,
  ): Unsubscribe;
}

export const INVOKE_CHANNELS = [
  'app:info',
  'app:notify',
  'update:state',
  'update:check',
  'update:install',
  'workspace:openDialog',
  'workspace:open',
  'workspace:current',
  'workspace:recent',
  'workspace:forgetRecent',
  'fs:readDir',
  'fs:readFile',
  'fs:writeFile',
  'fs:listFiles',
  'git:status',
  'git:branchFile',
  'git:head',
  'git:diffSides',
  'git:stage',
  'git:unstage',
  'git:discard',
  'git:commit',
  'git:suggestMessage',
  'git:branches',
  'git:checkout',
  'git:createBranch',
  'terminal:create',
  'terminal:write',
  'terminal:resize',
  'terminal:kill',
  'accounts:list',
  'accounts:add',
  'accounts:remove',
  'accounts:status',
  'settings:get',
  'settings:update',
  'brain:status',
  'brain:login',
  'brain:cancelLogin',
  'brain:logout',
  'brain:request',
  'brain:presence',
  'brain:subscribe',
  'brain:reportError',
  'bindings:get',
  'bindings:set',
  'repo:choose',
  'repo:inspect',
  'repo:init',
  'repo:clone',
  'agent:list',
  'agent:create',
  'agent:open',
  'agent:remove',
  'agent:configure',
  'agent:readiness',
  'agent:send',
  'agent:stop',
  'agent:approve',
  'agent:approveIssue',
  'issue:draft',
  'issue:similar',
  'issue:file',
  'agent:steer',
  'agent:mention',
  'session:lane',
  'session:precheck',
  'session:switchBranch',
  'session:currentBranch',
  'session:finalDiff',
  'session:follow',
  'brain:verifyAnchors',
  'session:steer',
  'session:takeover',
  'session:continue',
  'session:handoff',
  'overlap:check',
  'repo:connectAgents',
  'repo:agentsConnected',
  'session:unfollow',
  'session:checkout',
  'session:checkoutOf',
  'session:removeCheckout',
  'sync:attach',
  'sync:state',
  'sync:setEnabled',
  'sync:resume',
  'sync:switchBack',
  'sync:version',
  'sync:resolve',
  'sync:keepDisk',
  'subagent:start',
  'subagent:retry',
  'subagent:discard',
  'subagent:path',
  'git:push',
  'git:graph',
  'impact:working',
  'pr:create',
  'pr:refresh',
  'swarm:launch',
  'swarm:running',
  'arena:start',
  'arena:stop',
  'arena:running',
  'arena:runs',
  'models:list',
  'models:checkedAt',
  'providers:status',
  'background:status',
  'background:set',
  'agents:external',
  'skills:list',
  'skills:openFolder',
  'mcp:list',
  'mcp:save',
  'mcp:remove',
  'mcp:setEnabled',
  'mcp:test',
  'mcp:check',
  'mcp:signIn',
  'mcp:signOut',
  'mcp:trust',
  'plugins:list',
  'plugins:preview',
  'plugins:install',
  'plugins:discard',
  'plugins:checkUpdate',
  'plugins:update',
  'plugins:remove',
  'plugins:setEnabled',
  'plugins:setEverywhere',
  'plugins:chooseFolder',
  'agents:limits',
  'providers:setOpenRouterKey',
  'providers:custom:list',
  'providers:custom:save',
  'providers:custom:refresh',
  'providers:custom:remove',
] as const satisfies readonly InvokeChannel[];

export const EVENT_CHANNELS = [
  'fs:changed',
  'terminal:data',
  'terminal:exit',
  'settings:changed',
  'update:state',
  'menu:command',
  'connection:state',
  'brain:user',
  'brain:loginCode',
  'brain:message',
  'agent:event',
  'agent:changed',
  'agents:limits',
  'arena:progress',
  'sync:state',
] as const satisfies readonly EventChannel[];
