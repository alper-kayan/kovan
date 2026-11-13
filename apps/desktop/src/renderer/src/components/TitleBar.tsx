import { PRODUCT_NAME } from '@kovan/shared';
import { ChevronDown, FolderOpen, MessageSquare, Plus, Users } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { newConversation } from '../services/agent';
import { openNewSession } from '../services/sessions';
import { openWorkspaceDialog } from '../services/workspace';
import { setState, showView, useStore } from '../store';

const CONNECTION_LABEL = {
  offline: 'Offline',
  connecting: 'Connecting…',
  online: 'Online',
} as const satisfies Record<string, string>;

/** The one place to start anything, wherever you are in the app. */
function NewMenu() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const hasFolder = useStore((s) => s.workspace !== null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (
        e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [open]);
  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  return (
    <div className="new-menu" ref={box}>
      <button
        className="new-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Plus size={13} />
        <span>New</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="new-menu-list" role="menu">
          <button
            role="menuitem"
            onClick={run(() => {
              showView('sessions');
              openNewSession();
            })}
          >
            <Users size={14} />
            <span>
              <b>New session</b>
              <small>A task with your team</small>
            </span>
          </button>
          <button
            role="menuitem"
            disabled={!hasFolder}
            onClick={run(() => {
              showView('workspace');
              setState({ agentOpen: true });
              void newConversation();
            })}
          >
            <MessageSquare size={14} />
            <span>
              <b>New chat</b>
              <small>{hasFolder ? 'Just you and an AI agent' : 'Open a folder first'}</small>
            </span>
          </button>
          <button role="menuitem" onClick={run(() => void openWorkspaceDialog())}>
            <FolderOpen size={14} />
            <span>
              <b>Open folder</b>
              <small>Work on a project on this computer</small>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

export function TitleBar() {
  const workspace = useStore((s) => s.workspace);
  const view = useStore((s) => s.view);
  const connection = useStore((s) => s.connection);
  const isMac = useStore((s) => s.isMac);
  const isWin = useStore((s) => s.appInfo?.platform === 'win32');
  const signedIn = useStore((s) => s.signedIn);

  return (
    <header className={`titlebar ${isMac ? 'titlebar-mac' : ''} ${isWin ? 'titlebar-win' : ''}`}>
      <span>{PRODUCT_NAME}</span>
      {workspace && view === 'workspace' && <span className="crumb">— {workspace.name}</span>}
      <span className="titlebar-spacer" />
      <NewMenu />
      {/* Without an account there's no team server to be connected to. */}
      {signedIn && (
        <span
          className={`connection connection-${connection}`}
          title={
            connection === 'offline'
              ? t(
                  "Can't reach Kovan right now. Your files and agents keep working; team updates come in when it's back.",
                )
              : t('Connected to your team')
          }
        >
          <span className="connection-dot" />
          {t(CONNECTION_LABEL[connection])}
        </span>
      )}
    </header>
  );
}
