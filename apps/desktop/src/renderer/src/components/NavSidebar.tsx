import { openSession, sessionState } from '../services/sessions';
import {
  Brain,
  Building2,
  ChevronsUpDown,
  Download,
  FolderOpen,
  FolderTree,
  GitCompare,
  Layers,
  LayoutGrid,
  Plus,
  RefreshCw,
  Settings,
  Users,
  Workflow,
} from 'lucide-react';
import { useRef } from 'react';
import { doneCount, STEPS } from '../services/onboarding';
import {
  addWorkspace,
  currentOrg,
  openTeamWorkspace,
  switchOrg,
  useOrgWorkspaces,
} from '../services/team';
import { installUpdate } from '../services/settings';
import { openWorkspace } from '../services/workspace';
import { runCommand, toggleSide } from '../commands';
import {
  activeTeamWorkspace,
  setState,
  showView,
  useStore,
  writeLocal,
  type SideView,
  type View,
} from '../store';
import { Explorer } from './Explorer';
import { GitPanel } from './GitPanel';
import { KovanMark } from './Logo';
import { Avatar, ProgressRing, WorkspaceIcon } from './ui';

const NAV: { view: View; label: string; icon: typeof LayoutGrid }[] = [
  { view: 'sessions', label: 'Sessions', icon: LayoutGrid },
  { view: 'brain', label: 'Brain', icon: Brain },
  { view: 'people', label: 'People', icon: Users },
  { view: 'agents', label: 'Agents', icon: Workflow },
];

const MIN_WIDTH = 190;
const MAX_WIDTH = 380;

function Resizer() {
  const handle = useRef<HTMLDivElement>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    const startX = e.clientX;
    const startWidth = useStore.getState().navWidth;
    handle.current?.classList.add('dragging');
    const move = (ev: PointerEvent) => {
      const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + ev.clientX - startX));
      setState({ navWidth: width });
    };
    const up = () => {
      handle.current?.classList.remove('dragging');
      writeLocal('kovan.navWidth', useStore.getState().navWidth);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div
      className="nav-resizer"
      ref={handle}
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation="vertical"
    />
  );
}

/** The switcher's last entry: opens Settings → Organization to make one. */
const NEW_ORG = '__new';

/**
 * The far-left strip, as in VS Code: the views of the side bar (files, source control, workspaces) on top, the app's pages
 * below them, and getting started, the update, you and Settings at the bottom. A side-bar view's icon shows or hides it.
 */
export function ActivityBar() {
  const view = useStore((s) => s.view);
  const side = useStore((s) => s.sideView);
  const sideOpen = useStore((s) => !s.navCollapsed);
  const isRepo = useStore((s) => s.workspace?.isRepo ?? false);
  const changes = useStore((s) => s.gitStatus?.files.length ?? 0);
  const conflicts = useStore((s) => s.sync?.versions.length ?? 0);
  const onboarding = useStore((s) => s.settings.onboarding);
  const userName = useStore((s) => s.appInfo?.userName ?? 'you');
  const user = useStore((s) => s.user);
  const update = useStore((s) => s.update);
  const done = doneCount(onboarding);

  const sideItem = (
    id: SideView,
    label: string,
    Icon: typeof LayoutGrid,
    badge?: number,
    warn?: boolean,
  ) => (
    <button
      key={id}
      className={`activity-item ${sideOpen && side === id ? 'on' : ''}`}
      title={label}
      aria-label={label}
      aria-pressed={sideOpen && side === id}
      onClick={() => toggleSide(id)}
    >
      <Icon size={19} />
      {badge ? <span className={`activity-badge ${warn ? 'warn' : ''}`}>{badge}</span> : null}
    </button>
  );

  return (
    <nav className="activity" aria-label="Views">
      <span className="activity-logo" title="Kovan">
        <KovanMark size={20} />
      </span>
      {sideItem('explorer', 'Explorer', FolderTree, conflicts, conflicts > 0)}
      {isRepo && sideItem('git', 'Source Control', GitCompare, changes)}
      {sideItem('workspaces', 'Workspaces', Layers)}
      <span className="activity-sep" />
      {NAV.map(({ view: v, label, icon: Icon }) => (
        <button
          key={v}
          className={`activity-item ${view === v ? 'on' : ''}`}
          title={label}
          aria-label={label}
          onClick={() => showView(v)}
        >
          <Icon size={19} />
        </button>
      ))}
      <span className="spacer" />
      <button
        className="activity-item"
        title={`Getting started · ${done}/${STEPS.length}`}
        onClick={() => setState({ gettingStartedOpen: true })}
      >
        <ProgressRing value={done} total={STEPS.length} />
      </button>
      {update?.status === 'downloading' && (
        <span
          className="activity-item busy"
          role="status"
          title={`Downloading ${update.version ? `Kovan ${update.version}` : 'an update'} · ${update.percent ?? 0}%. Kovan keeps working while it downloads.`}
        >
          <Download size={18} />
        </span>
      )}
      {update?.status === 'ready' && (
        <button
          className="activity-item update-ready"
          title={`${update.version ? `Kovan ${update.version}` : 'An update'} is ready: restart to install`}
          onClick={installUpdate}
        >
          <RefreshCw size={18} />
        </button>
      )}
      <button
        className="activity-item"
        title={
          user
            ? `${user.name}${user.githubLogin ? ` · @${user.githubLogin}` : ''}`
            : `${userName} · local`
        }
        onClick={() => {
          setState({ settingsSection: 'account', settingsQuery: '' });
          showView('settings');
        }}
      >
        <Avatar name={user?.name ?? userName} src={user?.avatarUrl ?? null} size={24} />
      </button>
      <button
        className={`activity-item ${view === 'settings' ? 'on' : ''}`}
        title="Settings"
        onClick={() => showView('settings')}
      >
        <Settings size={19} />
      </button>
    </nav>
  );
}

const SIDE_TITLES: Record<SideView, string> = {
  explorer: 'Explorer',
  git: 'Source Control',
  workspaces: 'Workspaces',
};

/** The side bar next to the strip: the files, source control or the workspaces, resizable. */
export function SideBar() {
  const side = useStore((s) => s.sideView);
  const width = useStore((s) => s.navWidth);
  const workspace = useStore((s) => s.workspace);
  // Files and source control need an open folder; without one the side bar offers to open it.
  const current: SideView =
    !workspace && side !== 'workspaces'
      ? 'workspaces'
      : side === 'git' && !workspace?.isRepo
        ? 'explorer'
        : side;
  return (
    <>
      <aside className="side" style={{ width }} aria-label={SIDE_TITLES[current]}>
        <div className="side-title">
          <span>{SIDE_TITLES[current]}</span>
          {current === 'workspaces' && (
            <button
              className="icon-btn"
              title="Add a workspace"
              onClick={() => void addWorkspace()}
            >
              <Plus size={13} />
            </button>
          )}
          {current === 'explorer' && (
            <button
              className="icon-btn"
              title="Open another folder"
              onClick={() => runCommand('workspace.open')}
            >
              <FolderOpen size={13} />
            </button>
          )}
        </div>
        <div className="side-body">
          {current === 'explorer' && <Explorer />}
          {current === 'git' && <GitPanel />}
          {current === 'workspaces' && <WorkspacesList />}
        </div>
        <UpdateNotice />
      </aside>
      <Resizer />
    </>
  );
}

/** The update, while it downloads and once it is ready. */
function UpdateNotice() {
  const update = useStore((s) => s.update);
  return (
    <>
      {update?.status === 'downloading' && (
        <div
          className="nav-update busy"
          role="status"
          title="Kovan keeps working while it downloads; you restart when it's ready."
        >
          <Download size={14} />
          <span>
            Downloading update
            <span className="sub">
              {update.version ? `Kovan ${update.version} · ` : ''}
              {update.percent ?? 0}%
            </span>
            <span className="nav-update-bar">
              <span style={{ width: `${update.percent ?? 0}%` }} />
            </span>
          </span>
        </div>
      )}
      {update?.status === 'ready' && (
        <button
          className="nav-update"
          title="It was downloaded in the background. Kovan closes, installs it and opens again."
          onClick={installUpdate}
        >
          <RefreshCw size={14} />
          <span>
            Update ready
            <span className="sub">
              {update.version ? `Kovan ${update.version} · ` : ''}restart to install
            </span>
          </span>
        </button>
      )}
    </>
  );
}

/** The organizations, the shared workspaces with their sessions, and the folders opened on this machine. */
function WorkspacesList() {
  const view = useStore((s) => s.view);
  const recent = useStore((s) => s.recent);
  const workspace = useStore((s) => s.workspace);
  const user = useStore((s) => s.user);
  const signedIn = useStore((s) => s.signedIn);
  const team = useOrgWorkspaces();
  const orgs = useStore((s) => s.orgs);
  const org = useStore(currentOrg);
  const bindings = useStore((s) => s.bindings);
  const presence = useStore((s) => s.presence);
  const setupId = useStore((s) => s.setupWorkspaceId);
  const sessions = useStore((s) => s.sessions);
  const roomId = useStore((s) => s.room?.sessionId ?? null);
  const active = useStore(activeTeamWorkspace);

  // Folders opened on this machine that aren't linked to a shared workspace.
  const boundPaths = new Set(Object.values(bindings));
  const localOnly = recent.filter((r) => !boundPaths.has(r.root));

  return (
    <div className="side-workspaces">
      {signedIn && orgs.length > 1 && (
        <label className="nav-org" title="The organization whose workspaces and sessions show">
          <Building2 size={13} />
          <select
            value={org?.id ?? ''}
            onChange={(e) => {
              if (e.target.value !== NEW_ORG) return switchOrg(e.target.value);
              setState({ settingsSection: 'organization', settingsQuery: '' });
              showView('settings');
            }}
          >
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
            <option value={NEW_ORG}>New organization…</option>
          </select>
          <ChevronsUpDown size={12} />
        </label>
      )}
      <div className="nav-workspaces">
        {signedIn &&
          team.map((w) => {
            const online = (presence[w.id] ?? []).filter((p) => p.userId !== user?.id).length;
            const isActive =
              (view === 'workspace' && active?.id === w.id) ||
              (view === 'setup' && setupId === w.id);
            return (
              <div key={w.id} className="nav-ws-group">
                <button
                  className={`nav-ws ${isActive ? 'active' : ''} ${bindings[w.id] ? '' : 'unbound'}`}
                  title={bindings[w.id] ?? `${w.name} is not set up on this machine`}
                  onClick={() => void openTeamWorkspace(w)}
                >
                  <WorkspaceIcon name={w.name} color={w.color} />
                  <span>{w.name}</span>
                  {online > 0 && (
                    <span
                      className="nav-online"
                      title={`${online} teammate${online > 1 ? 's' : ''} online`}
                    >
                      {online}
                    </span>
                  )}
                </button>
                {(sessions[w.id] ?? []).map((s) => (
                  <button
                    key={s.id}
                    className={`nav-session ${view === 'session' && roomId === s.id ? 'active' : ''}`}
                    title={s.title}
                    onClick={() => void openSession(s.id)}
                  >
                    <span className={`nav-dot state-${sessionState(s)}`} />
                    <span>{s.title}</span>
                  </button>
                ))}
              </div>
            );
          })}
        {signedIn && localOnly.length > 0 && <div className="nav-subheading">On this machine</div>}
        {localOnly.map((r) => (
          <button
            key={r.root}
            className={`nav-ws ${view === 'workspace' && workspace?.root === r.root ? 'active' : ''}`}
            title={r.root}
            onClick={() => void openWorkspace(r.root)}
          >
            <WorkspaceIcon name={r.name} />
            <span>{r.name}</span>
          </button>
        ))}
        {team.length === 0 && localOnly.length === 0 && (
          <div className="nav-empty">No workspaces yet.</div>
        )}
      </div>
    </div>
  );
}
