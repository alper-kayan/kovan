import type { Settings } from '../../../shared/settings';
import { getState, reportError, setState } from '../store';
import { api } from './api';

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  try {
    setState({ settings: await api.invoke('settings:update', patch) });
  } catch (error) {
    reportError(error);
  }
}

export function isNoticeDismissed(id: string): boolean {
  return getState().settings.dismissedNotices.includes(id);
}

export function dismissNoticeForever(id: string): void {
  const { dismissedNotices } = getState().settings;
  if (!dismissedNotices.includes(id))
    void updateSettings({ dismissedNotices: [...dismissedNotices, id] });
}

/** Follows the app's update (checked and downloaded in the background) for the sidebar. */
export function initUpdates(): void {
  void api
    .invoke('update:state')
    .then((update) => setState({ update }))
    .catch(() => {});
  api.on('update:state', (update) => setState({ update }));
}

/** Quits, installs the downloaded update and reopens Kovan; says why when it can't. */
export function installUpdate(): void {
  void api
    .invoke('update:install')
    .then(async (started) => {
      if (started) return;
      const state = await api.invoke('update:state');
      reportError(state.message ?? 'The update is not ready to install yet.');
    })
    .catch(reportError);
}
