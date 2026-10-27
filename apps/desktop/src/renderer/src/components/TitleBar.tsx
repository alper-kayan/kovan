import { PRODUCT_NAME } from '@kovan/shared';
import { useStore } from '../store';

const CONNECTION_LABEL = {
  offline: 'Offline',
  connecting: 'Connecting…',
  online: 'Online',
} as const;

export function TitleBar() {
  const workspace = useStore((s) => s.workspace);
  const view = useStore((s) => s.view);
  const connection = useStore((s) => s.connection);
  const isMac = useStore((s) => s.isMac);

  return (
    <header className={`titlebar ${isMac ? 'titlebar-mac' : ''}`}>
      <span>{PRODUCT_NAME}</span>
      {workspace && view === 'workspace' && <span className="crumb">— {workspace.name}</span>}
      <span className="titlebar-spacer" />
      <span className={`connection connection-${connection}`} title="Connection to the team server">
        <span className="connection-dot" />
        {CONNECTION_LABEL[connection]}
      </span>
    </header>
  );
}
