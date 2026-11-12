import { FolderSearch, GitBranch, Download, Eye } from 'lucide-react';
import { chooseLocalClone, cloneWorkspace } from '../services/team';
import { setState, showView, useStore } from '../store';
import { WorkspaceIcon } from './ui';

/** Shown for a shared workspace that has no local folder on this machine yet. */
export function SetupView() {
  const workspace = useStore((s) => s.teamWorkspaces.find((w) => w.id === s.setupWorkspaceId));
  if (!workspace) return null;
  return (
    <section className="page">
      <div className="setup">
        <WorkspaceIcon name={workspace.name} color={workspace.color} />
        <h1 className="page-title">Workspace not set up on this machine</h1>
        <p className="setup-text">
          <strong>{workspace.name}</strong> is shared with you. To work on its code here, Kovan
          needs a copy of the repository on this computer: pick one you already have, or let Kovan
          download it with your own Git access. To only follow along, you need no copy.
        </p>
        {workspace.repoUrl && (
          <div className="setup-repo mono">
            <GitBranch size={13} /> {workspace.repoUrl} · {workspace.defaultBranch}
          </div>
        )}
        <div className="setup-actions">
          <button className="btn btn-primary" onClick={() => void chooseLocalClone(workspace)}>
            <FolderSearch size={14} /> Choose local clone
          </button>
          {workspace.repoUrl && (
            <button className="btn" onClick={() => void cloneWorkspace(workspace)}>
              <Download size={14} /> Clone repository
            </button>
          )}
          <button
            className="btn"
            onClick={() => {
              setState({ boardWorkspace: workspace.id, setupWorkspaceId: null });
              showView('sessions');
            }}
          >
            <Eye size={14} /> Just follow along
          </button>
        </div>
        <p className="setup-text muted small">
          Following along shows the team's sessions, every agent's work and its changes, and lets
          you comment. Downloading needs access to the repository on GitHub: if it fails, ask the
          person who invited you to add you there.
        </p>
      </div>
    </section>
  );
}
