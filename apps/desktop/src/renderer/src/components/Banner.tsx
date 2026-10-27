import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { dismissNoticeForever } from '../services/settings';
import { activeTeamWorkspace, setState, showView, useStore } from '../store';

const LOCAL_NOTICE = 'local-mode';
const REPORTS_NOTICE = 'error-reports';

/** The thin notice strip under the title bar. Each notice shows until dismissed. */
export function Banner() {
  const dismissed = useStore((s) => s.settings.dismissedNotices);
  const user = useStore((s) => s.user);
  const team = useStore((s) => activeTeamWorkspace(s));
  const view = useStore((s) => s.view);
  const recommended = team?.recommendedPlugins ?? [];
  const names = recommended.map((r) => r.name).sort();
  // Shown again when the list changes.
  const pluginsNotice = team ? `plugins:${team.id}:${names.join(',')}` : null;
  const [missing, setMissing] = useState<string[]>([]);
  useEffect(() => {
    if (!names.length) {
      setMissing([]);
      return;
    }
    // Coming back from Settings may mean they were just installed.
    void api.invoke('plugins:list').then(
      (l) => {
        const have = new Set(l.plugins.map((p) => p.name));
        setMissing(names.filter((n) => !have.has(n)));
      },
      () => setMissing([]),
    );
  }, [pluginsNotice, view]);

  if (team && pluginsNotice && missing.length && !dismissed.includes(pluginsNotice)) {
    return (
      <div className="banner" role="status">
        <span className="banner-text">
          {team.name} recommends {missing.length === 1 ? 'a plugin' : `${missing.length} plugins`}:{' '}
          {missing.join(', ')}. Nothing installs until you choose to.
        </span>
        <button
          className="btn btn-sm"
          onClick={() => {
            setState({ settingsSection: 'agents' });
            showView('settings');
            setTimeout(
              () => document.getElementById('settings-plugins')?.scrollIntoView({ block: 'start' }),
              100,
            );
          }}
        >
          Review
        </button>
        <button className="btn btn-sm" onClick={() => dismissNoticeForever(pluginsNotice)}>
          Dismiss
        </button>
      </div>
    );
  }

  if (user?.errorReports && !dismissed.includes(REPORTS_NOTICE)) {
    return (
      <div className="banner" role="status">
        <span className="banner-text">
          Kovan automatically shares error reports linked to your account to help fix failures.
          Prompts and code are excluded.
        </span>
        <button
          className="btn btn-sm"
          onClick={() => {
            setState({ settingsSection: 'privacy' });
            showView('settings');
          }}
        >
          Privacy settings
        </button>
        <button className="btn btn-sm" onClick={() => dismissNoticeForever(REPORTS_NOTICE)}>
          Dismiss
        </button>
      </div>
    );
  }
  if (!user && !dismissed.includes(LOCAL_NOTICE)) {
    return (
      <div className="banner" role="status">
        <span className="banner-text">
          You're working locally. Sign in to share workspaces with your team; your code never leaves
          this machine.
        </span>
        <button className="btn btn-sm" onClick={() => dismissNoticeForever(LOCAL_NOTICE)}>
          Dismiss
        </button>
      </div>
    );
  }
  return null;
}
