import type { RepoStatus } from '@kovan/git-engine';
import { create } from 'zustand';
import type {
  UpdateState,
  AppInfo,
  ConnectionState,
  DirEntry,
  ExternalAgentInfo,
  RecentWorkspace,
  SyncState,
  WorkspaceInfo,
} from '../../shared/api';
import type {
  Activity,
  Comment,
  CommentAnchor,
  Handoff,
  Outcome,
  Invite,
  LaneEvent,
  Memory,
  Plan,
  Member,
  Org,
  PresenceEntry,
  Session,
  SessionApproval,
  Subagent,
  User,
  Workspace,
  AiAgent,
  Learning,
  Swarm,
  SwarmMessage,
} from '@kovan/shared';
import type { ModelInfo } from '@kovan/model-gateway';
import type {
  AgentAccount,
  Attachment,
  Conversation,
  ConversationSummary,
  ProviderStatus,
} from '../../shared/agent';
import type { JoinCheck } from '../../shared/api';
import type { LiveAgent } from './services/liveAgents';
import type { AgentLimit } from '../../shared/limits';
import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings';

export type Tab =
  | {
      id: string;
      kind: 'file';
      path: string;
      title: string;
      dirty: boolean;
      content: 'text' | 'binary' | 'tooLarge';
    }
  | {
      id: string;
      kind: 'diff';
      path: string;
      title: string;
      staged: boolean;
      /** A teammate's kept version of the file to compare with yours, instead of git's sides. */
      version?: string;
    }
  | {
      id: string;
      /** A file of a session that runs on another machine, read-only from its branch. */
      kind: 'branch';
      path: string;
      title: string;
      workspaceId: string;
      branch: string;
      /** The machine whose work it is. */
      where: string;
      line?: number;
    };

/** Top-level screens, matching the sidebar. */
export type View =
  'sessions' | 'session' | 'brain' | 'people' | 'agents' | 'workspace' | 'setup' | 'settings';

/** The session open in the room view. */
export interface Room {
  sessionId: string;
  session: Session | null;
  /** Every lane's events, by person, as the Brain streams them. */
  lanes: Record<string, LaneEvent[]>;
  /** Why this machine can't join yet, from the last join attempt. */
  blocker: Extract<JoinCheck, { ok: false }> | null;
  joining: boolean;
  /** Ended sessions: the final diff, when one was saved. */
  diff: string | null;
}

export interface QueuedPrompt {
  text: string;
  attachments: Attachment[];
}

/** The left side panel inside the workspace view. */
export type WorkspacePanel = 'comments';

/** The right panel's tabs: the agent, the files, source control. */
export type RightTab = 'agents' | 'explorer' | 'git';

export type SettingsSection =
  | 'general'
  | 'editor'
  | 'terminal'
  | 'keyboard'
  | 'providers'
  | 'agents'
  | 'models'
  | 'arena'
  | 'account'
  | 'billing'
  | 'organization'
  | 'privacy'
  | 'workspaces';

export interface TerminalTab {
  id: number;
  title: string;
  exited: boolean;
  /** The agent account this terminal signs in, if it is a sign-in. */
  signIn?: string;
}

export interface Notice {
  id: number;
  kind: 'error' | 'info';
  title?: string;
  message: string;
  action?: { label: string; run: () => void };
  /** Stays until dismissed instead of fading out. */
  sticky?: boolean;
}

interface State {
  /** The signed-in Kovan account, or null when working locally. */
  user: User | null;
  signedIn: boolean;
  serverUrl: string;
  loginPending: 'login' | 'link' | null;
  orgs: Org[];
  /** The organization the sidebar and Sessions show (see `currentOrg`); null: the default one. */
  currentOrgId: string | null;
  /** Shared workspaces the user belongs to. */
  teamWorkspaces: Workspace[];
  /** workspace id -> local folder on this machine. */
  bindings: Record<string, string>;
  presence: Record<string, PresenceEntry[]>;
  members: Record<string, { members: Member[]; invites: Invite[] }>;
  /** The shared workspace the "not set up on this machine" screen is about. */
  setupWorkspaceId: string | null;
  inviteOpen: boolean;
  /** When another verification email may be sent (ms since epoch). */
  verifyResendAt: number;

  /** The right panel beside the editor (agent, explorer, source control). */
  agentOpen: boolean;
  rightTab: RightTab;
  explorerTab: 'files' | 'conflicts';
  gitTab: 'changes' | 'graph';
  /** How this window's session checkout syncs with teammates. */
  sync: SyncState | null;
  /** Subagents per session. */
  subagents: Record<string, Subagent[]>;
  /** AI teammates per workspace. */
  aiAgents: Record<string, AiAgent[]>;
  /** Each session's swarm and its chat. */
  swarms: Record<string, { swarm: Swarm | null; messages: SwarmMessage[] }>;
  /** Shared knowledge and this person's own preferences, per workspace. */
  learnings: Record<string, Learning[]>;
  conversations: ConversationSummary[];
  conversation: Conversation | null;
  models: ModelInfo[];
  providers: ProviderStatus | null;
  externalAgents: ExternalAgentInfo[];
  /** The person's other Claude Code and Codex accounts on this machine. */
  agentAccounts: AgentAccount[];
  /** Each agent's account limit, as this machine last saw it. */
  agentLimits: AgentLimit[];

  appInfo: AppInfo | null;
  isMac: boolean;
  connection: ConnectionState;
  settings: Settings;
  workspace: WorkspaceInfo | null;
  recent: RecentWorkspace[];

  view: View;
  /** Where "Back to app" returns to from settings. */
  lastAppView: Exclude<View, 'settings' | 'setup'>;
  settingsSection: SettingsSection;
  settingsQuery: string;
  navCollapsed: boolean;
  navWidth: number;
  gettingStartedOpen: boolean;

  panel: WorkspacePanel | null;
  /** Loaded directory listings, keyed by workspace-relative dir path ('' is the root). */
  dirs: Record<string, DirEntry[]>;
  expanded: Record<string, boolean>;

  tabs: Tab[];
  activeTabId: string | null;

  gitStatus: RepoStatus | null;

  terminalOpen: boolean;
  terminals: TerminalTab[];
  activeTerminal: number | null;

  palette: 'commands' | 'files' | null;
  notices: Notice[];

  /** Live sessions per shared workspace (Mission Control). */
  sessions: Record<string, Session[]>;
  /** Ended sessions per workspace, loaded when History is opened. */
  history: Record<string, Session[]>;
  /** Approval cards waiting in live sessions, across workspaces (the alerts strip). */
  approvals: SessionApproval[];
  room: Room | null;
  /** What the open session shows: its lanes, task graph, replay, final diff or swarm chat. */
  roomTab: 'lanes' | 'tasks' | 'replay' | 'diff' | 'swarm';
  boardWorkspace: string | null;
  boardTab: 'active' | 'history';
  newSessionOpen: boolean;
  /** A GitHub issue the person is writing from a comment or an agent's reply (the dialog). */
  issueDraft: { title: string; body: string } | null;
  /** The app's own update: once one is downloaded, the sidebar offers the restart. */
  update: UpdateState | null;
  /** Composer drafts and queued prompts, per conversation (lane). */
  drafts: Record<string, string>;
  queues: Record<string, QueuedPrompt[]>;

  /** Session plans, by session. */
  plans: Record<string, Plan>;
  /** Comments per workspace, as the Brain sends them (threads are built from parentId). */
  comments: Record<string, Comment[]>;
  /** Brain notes per workspace (live ones; retired ones load on demand). */
  memories: Record<string, Memory[]>;
  /** Session activity feeds, newest first. */
  activity: Record<string, Activity[]>;
  /** Open handoffs and unknown outcomes per workspace (the alerts strip). */
  flow: Record<string, { handoffs: Handoff[]; outcomes: Outcome[] }>;
  /** Agents working in files right now: carets, typing and tab badges. */
  liveAgents: Record<string, LiveAgent>;
  /** Where each followed session's checkout is on this machine (null: none here). */
  liveRoots: Record<string, string | null>;
  /** A comment being written on code (from the editor or a diff). */
  commentDraft: { workspaceId: string; anchor: CommentAnchor; sessionId: string | null } | null;
}

/** Per-viewer layout preferences; storage can be unavailable, so every access is guarded. */
export function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeLocal(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not persisting a layout preference is harmless.
  }
}

export const useStore = create<State>(() => ({
  user: null,
  signedIn: false,
  serverUrl: '',
  loginPending: null,
  orgs: [],
  currentOrgId: readLocal<string | null>('kovan.org', null),
  teamWorkspaces: [],
  bindings: {},
  presence: {},
  members: {},
  setupWorkspaceId: null,
  inviteOpen: false,
  verifyResendAt: 0,
  agentOpen: readLocal('kovan.agentOpen', true),
  rightTab: readLocal<RightTab>('kovan.rightTab', 'agents'),
  explorerTab: 'files',
  gitTab: 'changes',
  sync: null,
  subagents: {},
  aiAgents: {},
  swarms: {},
  learnings: {},
  conversations: [],
  conversation: null,
  models: [],
  providers: null,
  externalAgents: [],
  agentAccounts: [],
  agentLimits: [],
  appInfo: null,
  isMac: navigator.userAgent.includes('Mac'),
  connection: 'offline',
  settings: DEFAULT_SETTINGS,
  workspace: null,
  recent: [],
  view: 'sessions',
  lastAppView: 'sessions',
  settingsSection: 'general',
  settingsQuery: '',
  navCollapsed: readLocal('kovan.navCollapsed', false),
  navWidth: readLocal('kovan.navWidth', 224),
  gettingStartedOpen: false,
  panel: null,
  dirs: {},
  expanded: { '': true },
  tabs: [],
  activeTabId: null,
  gitStatus: null,
  terminalOpen: false,
  terminals: [],
  activeTerminal: null,
  palette: null,
  notices: [],
  sessions: {},
  history: {},
  approvals: [],
  room: null,
  roomTab: 'lanes',
  boardWorkspace: null,
  boardTab: 'active',
  newSessionOpen: false,
  issueDraft: null,
  update: null,
  drafts: {},
  queues: {},
  plans: {},
  comments: {},
  memories: {},
  commentDraft: null,
  liveAgents: {},
  liveRoots: {},
  activity: {},
  flow: {},
}));

export const setState = useStore.setState;
export const getState = useStore.getState;

export function showView(view: View): void {
  setState((s) => ({
    view,
    lastAppView: view === 'settings' || view === 'setup' ? s.lastAppView : view,
  }));
}

/** The shared workspace whose local folder is open right now, if any. */
export function activeTeamWorkspace(
  s: Pick<State, 'workspace' | 'bindings' | 'teamWorkspaces'>,
): Workspace | null {
  if (!s.workspace) return null;
  // A session's own worktree belongs to the workspace its main checkout is bound to.
  const root = s.workspace.repoRoot ?? s.workspace.root;
  const id = Object.entries(s.bindings).find(([, path]) => path === root)?.[0];
  return s.teamWorkspaces.find((w) => w.id === id) ?? null;
}

let noticeId = 0;

export function notify(notice: Omit<Notice, 'id'>): number {
  const id = ++noticeId;
  setState((s) => ({ notices: [...s.notices, { ...notice, id }] }));
  if (!notice.sticky) {
    setTimeout(() => dismissNotice(id), notice.kind === 'error' ? 7000 : 3500);
  }
  return id;
}

export function dismissNotice(id: number): void {
  setState((s) => ({ notices: s.notices.filter((n) => n.id !== id) }));
}

export function toast(message: string, kind: Notice['kind'] = 'info'): void {
  notify({ kind, message });
}

export function reportError(error: unknown): void {
  toast(error instanceof Error ? error.message : String(error), 'error');
}

export function updateTab(id: string, patch: Partial<Tab>): void {
  setState((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? ({ ...t, ...patch } as Tab) : t)) }));
}
