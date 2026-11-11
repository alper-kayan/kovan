import {
  Bot,
  GitBranch,
  GitFork,
  MessageSquare,
  PanelLeft,
  PauseCircle,
  SquareTerminal,
} from 'lucide-react';
import { runCommand } from '../commands';
import { resumeSync, switchBackAndResume } from '../services/sync';
import type { PresenceEntry } from '@kovan/shared';
import { activeTeamWorkspace, setState, useStore } from '../store';
import { BottomPanel } from './BottomPanel';
import { CommentsPanel } from './Comments';
import { EditorArea } from './EditorArea';
import { RightPanel } from './RightPanel';
import { Avatar } from './ui';

const NO_PRESENCE: PresenceEntry[] = [];

/** A paused session checkout: a manual branch switch, or a sync the remote refused. */
function SyncBanner() {
  const sync = useStore((s) => s.sync);
  if (!sync?.paused) return null;
  const branch = sync.paused.kind === 'branch';
  return (
    <div className="sync-banner" role="alert">
      <PauseCircle size={15} />
      <div className="sync-banner-text">
        <b>{branch ? 'Session paused' : 'Sync paused'}</b>
        <span>{sync.paused.reason}</span>
      </div>
      {branch ? (
        <>
          <button className="btn btn-sm" onClick={() => void switchBackAndResume()}>
            Switch back to {sync.branch}
          </button>
          <button className="btn btn-sm" onClick={() => void resumeSync()}>
            Resume
          </button>
        </>
      ) : (
        <button className="btn btn-sm" onClick={() => void resumeSync()}>
          Retry
        </button>
      )}
    </div>
  );
}

/** The editor: a workspace's files and changes, its open tabs, and the terminal. */
export function WorkspaceView() {
  const workspace = useStore((s) => s.workspace);
  const status = useStore((s) => s.gitStatus);
  const panel = useStore((s) => s.panel);
  const terminalOpen = useStore((s) => s.terminalOpen);
  const agentOpen = useStore((s) => s.agentOpen);
  const agentRunning = useStore((s) => s.conversation?.running ?? false);
  const navCollapsed = useStore((s) => s.navCollapsed);
  const team = useStore(activeTeamWorkspace);
  const me = useStore((s) => s.user?.id);
  const online = useStore((s) => (team ? s.presence[team.id] : undefined)) ?? NO_PRESENCE;
  if (!workspace) return null;
  const others = online.filter((p) => p.userId !== me);

  const changes = status?.files.length ?? 0;

  return (
    <section className="content">
      <div className="ws-header">
        {navCollapsed && (
          <button
            className="icon-btn"
            title="Show sidebar"
            onClick={() => runCommand('view.toggleSidebar')}
          >
            <PanelLeft size={15} />
          </button>
        )}
        <span className="ws-title">{workspace.name}</span>
        {status && (
          <span className="ws-branch" title="Current branch">
            <GitBranch size={11} />
            {status.branch ?? 'detached'}
            {(status.ahead > 0 || status.behind > 0) && ` ↑${status.ahead} ↓${status.behind}`}
          </span>
        )}
        {workspace.session && (
          <span
            className="ws-worktree"
            title={`This session's own worktree at ${workspace.root}; your main checkout (${workspace.repoRoot}) is untouched`}
          >
            <GitFork size={11} /> worktree · {workspace.session.title}
          </span>
        )}
        {changes > 0 && <span className="ws-changes">{changes} changed</span>}
        <span className="spacer" />
        {others.length > 0 && (
          <span
            className="ws-presence"
            title={others.map((p) => `${p.name}${p.inWorkspace ? ' (here)' : ''}`).join(', ')}
          >
            {others.slice(0, 5).map((p) => (
              <Avatar
                key={p.userId}
                name={p.name}
                src={p.avatarUrl}
                size={22}
                online={p.inWorkspace && p.status === 'active'}
              />
            ))}
          </span>
        )}
        {team && <span className="ws-role">{team.role}</span>}
        {team && (
          <button
            className={`icon-btn ${panel === 'comments' ? 'on' : ''}`}
            title="Comments"
            onClick={() => setState((s) => ({ panel: s.panel === 'comments' ? null : 'comments' }))}
          >
            <MessageSquare size={15} />
          </button>
        )}
        <button
          className={`icon-btn ${agentOpen ? 'on' : ''} ${agentRunning ? 'busy' : ''}`}
          title="Agent"
          onClick={() => runCommand('view.agent')}
        >
          <Bot size={15} />
        </button>
        <button
          className={`icon-btn ${terminalOpen ? 'on' : ''}`}
          title="Terminal"
          onClick={() => runCommand('view.toggleTerminal')}
        >
          <SquareTerminal size={15} />
        </button>
      </div>
      <SyncBanner />
      <div className="ws-body">
        {panel === 'comments' && <CommentsPanel />}
        <div className="main">
          <EditorArea />
          <BottomPanel />
        </div>
        {agentOpen && <RightPanel />}
      </div>
    </section>
  );
}
