import { formatAccelerator } from '../../../shared/keybindings';
import { BranchFileView } from './BranchFileView';
import { currentKeybindings } from '../commands';
import { useMemo } from 'react';
import { showsHere } from '../services/liveAgents';
import { worksIn } from './liveTyping';
import { openSessionCheckout } from '../services/sessions';
import { reportError, useStore } from '../store';
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
  return (
    <div className="editor-empty">
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

/**
 * Agents writing this file in another checkout of it (a session with its own worktree): their
 * typing shows there, not here, so say where and offer to go.
 */
function ElsewhereBar({ path }: { path: string }) {
  const all = useStore((s) => s.liveAgents);
  const root = useStore((s) => s.workspace?.root);
  const roots = useStore((s) => s.liveRoots);
  const sessions = useStore((s) => s.sessions);
  const away = useMemo(
    () =>
      Object.values(all).filter(
        (a) => worksIn(a, path) && a.sessionId !== null && !showsHere(a, root, roots),
      ),
    [all, path, root, roots],
  );
  const first = away[0];
  if (!first?.sessionId) return null;
  const session = Object.values(sessions)
    .flat()
    .find((x) => x.id === first.sessionId);
  const names = [...new Set(away.map((a) => a.name))].join(', ');
  return (
    <div className="editor-elsewhere" style={{ ['--agent' as string]: first.color }}>
      <i />
      <span>
        <b>{names}</b> {away.length === 1 ? 'is' : 'are'} writing this file in{' '}
        <b>{first.sessionTitle ?? 'a session'}</b>, in that session&rsquo;s own copy.
      </span>
      {session && session.status === 'active' && (
        <button
          className="btn btn-sm"
          onClick={() => void openSessionCheckout(session).catch(reportError)}
        >
          Watch it there
        </button>
      )}
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
  else if (tab.content === 'binary')
    body = <div className="editor-message">This file is binary and can't be shown.</div>;
  else if (tab.content === 'tooLarge')
    body = <div className="editor-message">This file is too large to open in the editor.</div>;
  else body = <CodeEditor path={tab.path} />;

  return (
    <div className="editor-area">
      <TabBar />
      {tab?.kind === 'file' && <ElsewhereBar path={tab.path} />}
      <div className="editor-body">{body}</div>
    </div>
  );
}
