import { formatAccelerator } from '../../../shared/keybindings';
import { BranchFileView, DraftFileView } from './BranchFileView';
import { currentKeybindings } from '../commands';
import { MessageSquare, Users } from 'lucide-react';
import { newConversation } from '../services/agent';
import { openNewSession } from '../services/sessions';
import { setState, showView, useStore } from '../store';
import { CodeEditor } from './CodeEditor';
import { DiffView } from './DiffView';
import { TabBar } from './TabBar';

function EmptyEditor() {
  const isMac = useStore((s) => s.isMac);
  const keys = currentKeybindings();
  const hints: [string, string][] = [
    ['Go to file', 'palette.files'],
    ['All commands', 'palette.commands'],
    ['Toggle terminal', 'view.toggleTerminal'],
    ['Source control', 'view.git'],
  ];
  const startSession = () => {
    showView('sessions');
    openNewSession();
  };
  const startChat = () => {
    setState({ agentOpen: true });
    void newConversation();
  };
  return (
    <div className="editor-empty">
      <div className="start-here">
        <h2 className="start-title">What would you like to do?</h2>
        <button className="start-card" onClick={startSession}>
          <Users size={20} />
          <span className="start-card-text">
            <span className="start-card-title">New session</span>
            <span className="start-card-desc">
              One task you work on with your team. Everyone joins with their own AI agent.
            </span>
          </span>
        </button>
        <button className="start-card" onClick={startChat}>
          <MessageSquare size={20} />
          <span className="start-card-text">
            <span className="start-card-title">New chat</span>
            <span className="start-card-desc">
              Ask an AI agent about this folder. Just you, nobody else sees it.
            </span>
          </span>
        </button>
      </div>
      <dl>
        {hints.map(([label, id]) =>
          keys[id] ? (
            <div key={id}>
              <dt>{label}</dt>
              <dd>
                <kbd>{formatAccelerator(keys[id], isMac)}</kbd>
              </dd>
            </div>
          ) : null,
        )}
      </dl>
    </div>
  );
}

export function EditorArea() {
  const tab = useStore((s) => s.tabs.find((t) => t.id === s.activeTabId));

  let body;
  if (!tab) body = <EmptyEditor />;
  else if (tab.kind === 'diff')
    body = <DiffView key={tab.id} path={tab.path} staged={tab.staged} version={tab.version} />;
  else if (tab.kind === 'branch') body = <BranchFileView key={tab.id} tab={tab} />;
  else if (tab.kind === 'draft') body = <DraftFileView key={tab.id} tab={tab} />;
  else if (tab.content === 'binary')
    body = <div className="editor-message">This file is binary and can't be shown.</div>;
  else if (tab.content === 'tooLarge')
    body = <div className="editor-message">This file is too large to open in the editor.</div>;
  else body = <CodeEditor path={tab.path} />;

  return (
    <div className="editor-area">
      <TabBar />
      <div className="editor-body">{body}</div>
    </div>
  );
}
