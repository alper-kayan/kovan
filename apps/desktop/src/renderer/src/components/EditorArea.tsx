import { useState } from 'react';
import { formatAccelerator } from '../../../shared/keybindings';
import { BranchFileView, DraftFileView } from './BranchFileView';
import { currentKeybindings } from '../commands';
import { newConversation } from '../services/agent';
import { startFromGoal } from '../services/quickStart';
import { openNewSession } from '../services/sessions';
import { Hexagon, Users } from 'lucide-react';
import { activeTeamWorkspace, isWelcome, setState, showView, useStore } from '../store';
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
  const welcome = useStore(isWelcome);
  const team = useStore((st) => st.signedIn && activeTeamWorkspace(st) !== null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const started = await startFromGoal(text);
    setBusy(false);
    if (started) setText('');
  };
  const startSession = () => {
    showView('sessions');
    openNewSession();
  };
  const startChat = () => {
    void newConversation().then(() => setState({ agentOpen: true, startScreenOff: true }));
  };
  // Back to the one box: no conversation open, so nothing else to type into.
  const newTask = () => setState({ conversation: null, startScreenOff: false });
  return (
    <div className="editor-empty">
      {welcome ? (
        <div className="quick-start">
          <h2 className="start-title">What would you like to do?</h2>
          <form
            className="quick-box"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <textarea
              className="quick-input"
              rows={3}
              autoFocus
              placeholder={
                team
                  ? 'Tell the lead what to build, e.g. Add total, product and mean helpers with tests'
                  : 'Ask your agent anything about this folder'
              }
              value={text}
              disabled={busy}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            <div className="quick-foot">
              <span className="quick-hint">
                {team
                  ? "The lead splits it up and opens its own agents. You'll see their screens here, one after another."
                  : 'It goes to your agent. Share this folder and sign in to let a lead open a whole team.'}
              </span>
              <button className="btn btn-primary" disabled={busy || !text.trim()}>
                {busy ? 'Starting…' : team ? 'Start with a lead' : 'Send'}
              </button>
            </div>
          </form>
          <div className="quick-links">
            <button className="link-btn" onClick={startSession}>
              New session, set up by hand
            </button>
            <button className="link-btn" onClick={startChat}>
              Just a chat with one agent
            </button>
          </div>
        </div>
      ) : (
        <div className="start-here">
          <h2 className="start-title">What would you like to do?</h2>
          <button className="start-card" onClick={newTask}>
            <Hexagon size={20} />
            <span className="start-card-text">
              <span className="start-card-title">A new task for a lead</span>
              <span className="start-card-desc">
                Write the goal; the lead opens its own agents and you watch their screens.
              </span>
            </span>
          </button>
          <button className="start-card" onClick={startSession}>
            <Users size={20} />
            <span className="start-card-text">
              <span className="start-card-title">New session, set up by hand</span>
              <span className="start-card-desc">
                One task you work on with your team. Everyone joins with their own AI agent.
              </span>
            </span>
          </button>
        </div>
      )}
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
