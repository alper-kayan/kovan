import type { WorkspaceInfo } from '../../../shared/api';
import { getState, reportError, setState, writeLocal } from '../store';
import { loadConversations } from './agent';
import { completeStep } from './onboarding';
import { api } from './api';
import { hasUnsavedChanges, reloadChangedFiles, resetEditor } from './editor';
import { loadDir, refreshDirsFor } from './explorer';
import { refreshGitStatus } from './git';
import { resetTerminals } from './terminal';
import { loadSync } from './sync';

async function adopt(info: WorkspaceInfo): Promise<void> {
  resetEditor();
  resetTerminals();
  // A folder just opened shows its files, as in any editor: not the list it was picked from.
  if (getState().sideView === 'workspaces' || getState().navCollapsed) {
    setState({ sideView: 'explorer', navCollapsed: false });
    writeLocal('kovan.sideView', 'explorer');
    writeLocal('kovan.navCollapsed', false);
  }
  setState({
    workspace: info,
    agentFiles: {},
    dirs: {},
    expanded: { '': true },
    gitStatus: null,
    sync: null,
    view: 'workspace',
    lastAppView: 'workspace',
  });
  completeStep('start');
  await Promise.all([
    loadDir(''),
    refreshGitStatus(),
    refreshRecent(),
    loadConversations(true),
    loadSync(),
  ]);
}

export async function refreshRecent(): Promise<void> {
  try {
    setState({ recent: await api.invoke('workspace:recent') });
  } catch (error) {
    reportError(error);
  }
}

export async function forgetRecent(root: string): Promise<void> {
  try {
    setState({ recent: await api.invoke('workspace:forgetRecent', root) });
  } catch (error) {
    reportError(error);
  }
}

function confirmLeave(): boolean {
  return (
    !hasUnsavedChanges() ||
    window.confirm('You have unsaved changes. Open another folder and discard them?')
  );
}

export async function openWorkspaceDialog(): Promise<void> {
  if (!confirmLeave()) return;
  try {
    const info = await api.invoke('workspace:openDialog');
    if (info) await adopt(info);
  } catch (error) {
    reportError(error);
  }
}

export async function openWorkspace(root: string): Promise<void> {
  if (getState().workspace?.root === root) {
    setState({ view: 'workspace', lastAppView: 'workspace' });
    return;
  }
  if (getState().workspace && !confirmLeave()) return;
  try {
    await adopt(await api.invoke('workspace:open', root));
  } catch (error) {
    reportError(error);
  }
}

/** Restores the window's workspace after a renderer reload. */
export async function restoreWorkspace(): Promise<void> {
  const info = await api.invoke('workspace:current');
  await refreshRecent();
  if (info) {
    setState({
      workspace: info,
      dirs: {},
      expanded: { '': true },
      view: 'workspace',
      lastAppView: 'workspace',
    });
    completeStep('start');
    await Promise.all([loadDir(''), refreshGitStatus(), loadConversations(true), loadSync()]);
  }
}

api.on('fs:changed', (event) => {
  if (event.paths.length > 0) {
    void refreshDirsFor(event.paths);
    void reloadChangedFiles(event.paths);
  }
  void refreshGitStatus();
});
