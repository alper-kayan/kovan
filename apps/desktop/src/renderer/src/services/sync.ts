import type { Session, SessionPr, Subagent } from '@kovan/shared';
import type { SyncVersion } from '../../../shared/api';
import { getState, reportError, setState, toast } from '../store';
import { api } from './api';
import { closeTab, openVersion } from './editor';
import { refreshGitStatus } from './git';
import { setWorkspaceGitSync } from './team';

const NONE: Subagent[] = [];

export function initSync(): void {
  api.on('sync:state', (state) => {
    if (state && state.root !== getState().workspace?.root) return;
    const before = getState().sync;
    setState({ sync: state });
    // A worktree's HEAD lives outside its folder, so the file watcher misses branch switches.
    if (before?.paused?.kind !== state?.paused?.kind || state?.lastPullAt !== before?.lastPullAt)
      void refreshGitStatus();
    // Versions resolved (here or because the files now match): their compare tabs go too.
    const left = new Set(state?.versions.map((v) => v.id));
    for (const tab of getState().tabs)
      if (tab.kind === 'diff' && tab.version && !left.has(tab.version)) closeTab(tab.id);
  });
  api.on('brain:message', (message) => {
    if (message.type !== 'subagent') return;
    const sub = message.subagent;
    setState((s) => {
      const list = s.subagents[sub.sessionId] ?? NONE;
      const next = list.some((x) => x.id === sub.id)
        ? list.map((x) => (x.id === sub.id ? sub : x))
        : [...list, sub];
      return { subagents: { ...s.subagents, [sub.sessionId]: next } };
    });
  });
}

/** The sync state of the checkout this window shows (after opening a workspace). */
export async function loadSync(): Promise<void> {
  setState({ sync: await api.invoke('sync:state').catch(() => null) });
}

/** Starts syncing this window's checkout with the session's teammates. */
export async function attachSync(session: Session): Promise<void> {
  const ws = getState().workspace;
  if (!ws?.isRepo || !session.branch || session.status !== 'active') return;
  try {
    const sync = await api.invoke('sync:attach', {
      sessionId: session.id,
      workspaceId: session.workspaceId,
      branch: ws.session?.branch ?? session.branch,
    });
    setState({ sync });
  } catch (error) {
    reportError(error);
  }
}

/** The checkout's workspace switch: shared, so it turns sync on or off for the whole team. */
export async function setSyncEnabled(on: boolean): Promise<void> {
  const sync = getState().sync;
  if (sync) await setWorkspaceGitSync(sync.workspaceId, on);
}

export async function resumeSync(): Promise<void> {
  try {
    const sync = await api.invoke('sync:resume');
    if (sync) setState({ sync });
  } catch (error) {
    reportError(error);
  }
}

export async function switchBackAndResume(): Promise<void> {
  try {
    const sync = await api.invoke('sync:switchBack');
    if (sync) setState({ sync });
    void refreshGitStatus();
  } catch (error) {
    reportError(error);
  }
}

export function compareVersion(v: SyncVersion): void {
  openVersion(v.path, { id: v.id, peerName: v.peerName });
}

export async function pickVersion(v: SyncVersion, keep: 'mine' | 'theirs'): Promise<void> {
  try {
    setState({ sync: await api.invoke('sync:resolve', v.id, keep) });
    toast(keep === 'mine' ? `Kept your ${v.path}.` : `Took ${v.peerName}'s ${v.path}.`);
    void refreshGitStatus();
  } catch (error) {
    reportError(error);
  }
}

// ---------- subagents ----------

export async function loadSubagents(sessionId: string): Promise<void> {
  const r = await api
    .invoke('brain:request', 'GET', `/api/sessions/${sessionId}/subagents`)
    .catch(() => null);
  const list = (r as { subagents?: Subagent[] } | null)?.subagents;
  if (list) setState((s) => ({ subagents: { ...s.subagents, [sessionId]: list } }));
}

export async function startSubagent(conversationId: string, task: string): Promise<boolean> {
  try {
    await api.invoke('subagent:start', conversationId, task);
    toast('Subagent started in its own worktree. Your lane keeps going.');
    return true;
  } catch (error) {
    reportError(error);
    return false;
  }
}

export async function retrySubagent(id: string): Promise<void> {
  await api.invoke('subagent:retry', id).catch(reportError);
}

export async function discardSubagent(id: string): Promise<void> {
  if (!window.confirm("Discard this subagent's work? Its worktree is removed.")) return;
  await api.invoke('subagent:discard', id).catch(reportError);
}

export async function subagentPath(id: string): Promise<string | null> {
  return api.invoke('subagent:path', id).catch(() => null);
}

// ---------- finishing: push, pull request ----------

export async function pushBranch(): Promise<boolean> {
  try {
    const remote = await api.invoke('git:push');
    toast(`Pushed to ${remote}.`);
    return true;
  } catch (error) {
    reportError(error);
    return false;
  } finally {
    void refreshGitStatus();
  }
}

export async function createPr(
  session: Session,
  input: { title: string; body: string; base: string },
): Promise<SessionPr | null> {
  try {
    const pr = await api.invoke('pr:create', session.id, input);
    toast(`Opened PR #${pr.number}.`);
    return pr;
  } catch (error) {
    reportError(error);
    return null;
  }
}

export async function refreshPr(session: Session): Promise<SessionPr | null> {
  try {
    const pr = await api.invoke('pr:refresh', session.id);
    if (pr?.state === 'merged') toast(`PR #${pr.number} was merged. The session is complete.`);
    return pr;
  } catch (error) {
    reportError(error);
    return null;
  }
}
