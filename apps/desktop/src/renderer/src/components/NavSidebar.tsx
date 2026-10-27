import { openSession, sessionState } from '../services/sessions';
import {
  Brain,
  Building2,
  ChevronsUpDown,
  Download,
  LayoutGrid,
  PanelLeft,
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
import { runCommand } from '../commands';
import { activeTeamWorkspace, setState, showView, useStore, writeLocal, type View } from '../store';
import { KovanMark, Wordmark } from './Logo';
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

export function NavSidebar() {
  const view = useStore((s) => s.view);
  const width = useStore((s) => s.navWidth);
  const recent = useStore((s) => s.recent);
  const workspace = useStore((s) => s.workspace);
  const onboarding = useStore((s) => s.settings.onboarding);
  const userName = useStore((s) => s.appInfo?.userName ?? 'you');
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
  const done = doneCount(onboarding);
  const update = useStore((s) => s.update);

  // Folders opened on this machine that aren't linked to a shared workspace.
  const boundPaths = new Set(Object.values(bindings));
  const localOnly = recent.filter((r) => !boundPaths.has(r.root));

  return (
    <>
      <nav className="nav" style={{ width }}>
        <div className="nav-top">
          <span className="nav-logo">
            <KovanMark size={20} />
            <Wordmark />
          </span>
          <button
            className="icon-btn"
            title="Hide sidebar"
            onClick={() => runCommand('view.toggleSidebar')}
          >
            <PanelLeft size={15} />
          </button>
        </div>

        <div className="nav-section">
          <button className="nav-item" onClick={() => setState({ gettingStartedOpen: true })}>
            <ProgressRing value={done} total={STEPS.length} />
            <span>Getting started</span>
            <span className="nav-meta">
              {done}/{STEPS.length}
            </span>
          </button>
          {NAV.map(({ view: v, label, icon: NavIcon }) => (
            <button
              key={v}
              className={`nav-item ${view === v ? 'active' : ''}`}
              onClick={() => showView(v)}
            >
              <NavIcon size={15} className="nav-icon" />
              <span>{label}</span>
            </button>
          ))}
        </div>

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
        <div className="nav-heading">
          <span>Workspaces</span>
          <button className="icon-btn" title="Add a workspace" onClick={() => void addWorkspace()}>
            <Plus size={13} />
          </button>
        </div>
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
          {signedIn && localOnly.length > 0 && (
            <div className="nav-subheading">On this machine</div>
          )}
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
        <div className="nav-bottom">
          <span className="nav-user">
            <Avatar name={user?.name ?? userName} src={user?.avatarUrl ?? null} size={26} />
            <span>
              {user?.name ?? userName}
              <span className="sub">
                {user
                  ? user.githubLogin
                    ? `@${user.githubLogin}`
                    : (user.email ?? 'signed in')
                  : 'local'}
              </span>
            </span>
          </span>
          <button
            className={`icon-btn ${view === 'settings' ? 'on' : ''}`}
            title="Settings"
            onClick={() => showView('settings')}
          >
            <Settings size={15} />
          </button>
        </div>
      </nav>
      <Resizer />
    </>
  );
}
