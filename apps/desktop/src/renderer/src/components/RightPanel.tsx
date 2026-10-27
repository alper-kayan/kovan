import { Bot, FolderTree, GitBranch } from 'lucide-react';
import { refreshGitStatus } from '../services/git';
import { setState, useStore, writeLocal, type RightTab } from '../store';
import { AgentPanel } from './AgentPanel';
import { Explorer } from './Explorer';
import { GitPanel } from './GitPanel';

const TABS: { id: RightTab; label: string; icon: typeof Bot }[] = [
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'explorer', label: 'Explorer', icon: FolderTree },
  { id: 'git', label: 'Source Control', icon: GitBranch },
];

/** Beside the editor: the agent, the files, and source control, one tab at a time. */
export function RightPanel() {
  const tab = useStore((s) => s.rightTab);
  const isRepo = useStore((s) => s.workspace?.isRepo ?? false);
  const changes = useStore((s) => s.gitStatus?.files.length ?? 0);
  const conflicts = useStore((s) => s.sync?.versions.length ?? 0);
  const running = useStore((s) => s.conversation?.running ?? false);
  const current = !isRepo && tab === 'git' ? 'explorer' : tab;

  return (
    <aside className="right-panel">
      <div className="right-tabs" role="tablist">
        {TABS.filter((t) => isRepo || t.id !== 'git').map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={current === t.id}
            className={`right-tab ${current === t.id ? 'on' : ''}`}
            onClick={() => {
              if (current === t.id) return;
              setState({ rightTab: t.id });
              writeLocal('kovan.rightTab', t.id);
              if (t.id === 'git') void refreshGitStatus();
            }}
          >
            <t.icon size={13} />
            {t.label}
            {t.id === 'agents' && running && <span className="right-tab-dot" />}
            {t.id === 'explorer' && conflicts > 0 && (
              <span className="count-pill warn">{conflicts}</span>
            )}
            {t.id === 'git' && changes > 0 && <span className="count-pill">{changes}</span>}
          </button>
        ))}
      </div>
      <div className="right-body">
        {current === 'agents' && <AgentPanel />}
        {current === 'explorer' && <Explorer />}
        {current === 'git' && <GitPanel />}
      </div>
    </aside>
  );
}
