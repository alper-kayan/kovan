import { AgentPanel } from './AgentPanel';

/** Beside the editor, on the right: the agents. The files and source control live in the side bar on the left. */
export function RightPanel() {
  return (
    <aside className="right-panel">
      <div className="right-body">
        <AgentPanel />
      </div>
    </aside>
  );
}
