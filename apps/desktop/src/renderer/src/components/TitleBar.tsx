import { PRODUCT_NAME } from '@kovan/shared';
import { t } from '../i18n';
import { useStore } from '../store';

const CONNECTION_LABEL = {
  offline: 'Offline',
  connecting: 'Connecting…',
  online: 'Online',
} as const satisfies Record<string, string>;

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
