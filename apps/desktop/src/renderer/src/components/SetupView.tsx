import { FolderSearch, GitBranch, Download } from 'lucide-react';
import { chooseLocalClone, cloneWorkspace } from '../services/team';
import { useStore } from '../store';
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
          <strong>{workspace.name}</strong> is shared with you, but this computer doesn't know where
          its code lives. Point Kovan at an existing clone, or clone it now with your own git
          credentials.
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
        </div>
      </div>
    </section>
  );
}
