import { t } from './i18n';
import { initResync } from './services/resync';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { api } from './services/api';
import { initAgent, loadExternalAgents, loadModels, loadProviders } from './services/agent';
import { initCollab } from './services/collab';
import { initLiveAgents } from './services/liveAgents';
import { initFlow } from './services/flow';
import { initSync } from './services/sync';
import { initSwarm } from './services/swarm';
import { initSessions } from './services/sessions';
import { initTeam } from './services/team';
import { initUpdates, installUpdate } from './services/settings';
import { restoreWorkspace } from './services/workspace';
import type { UpdateState } from '../../shared/api';
import { dismissNotice, notify, setState } from './store';
import '@fontsource-variable/dm-sans';
import '@fontsource-variable/geist-mono';
import '@fontsource-variable/lilex';
import './styles.css';

async function boot(): Promise<void> {
  const [appInfo, settings] = await Promise.all([
    api.invoke('app:info'),
    api.invoke('settings:get'),
  ]);
  setState({ appInfo, isMac: appInfo.platform === 'darwin', settings });
  api.on('settings:changed', (next) => setState({ settings: next }));
  api.on('connection:state', (connection) => setState({ connection }));
  // A downloaded update waits for the person; one card per version says so, and goes away if
  // the update turns out not to be installable after all.
  let announced: { version: string | undefined; notice: number } | null = null;
  const announce = (update: UpdateState) => {
    if (update.status !== 'ready') {
      if (announced && update.status === 'error') {
        dismissNotice(announced.notice);
        announced = null;
      }
      return;
    }
    if (announced?.version === update.version) return;
    announced = {
      version: update.version,
      notice: notify({
        kind: 'info',
        sticky: true,
        title: t('Kovan {version} is ready', { version: update.version ?? '' }),
        message: 'Restart to finish updating. Running agents stop when the app restarts.',
        action: { label: 'Restart to update', run: installUpdate },
      }),
    };
  };
  api.on('update:state', announce);
  void api.invoke('update:state').then(announce);
  initAgent();
  initResync();
  await Promise.all([initTeam(), loadProviders()]);
  initSessions();
  initCollab();
  initLiveAgents();
  initFlow();
  initSync();
  initUpdates();
  initSwarm();
  void loadModels();
  void loadExternalAgents();
  await restoreWorkspace();

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
