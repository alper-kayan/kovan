import { getState, reportError, setState, toast } from '../store';
import { api } from './api';

let inFlight: Promise<void> | null = null;
let again = false;

/** Refreshes git status; overlapping calls collapse into one follow-up refresh. */
export function refreshGitStatus(): Promise<void> {
  if (inFlight) {
    again = true;
    return inFlight;
  }
  inFlight = (async () => {
    try {
      if (!getState().workspace?.isRepo) {
        setState({ gitStatus: null });
        return;
      }
      setState({ gitStatus: await api.invoke('git:status') });
    } catch (error) {
      reportError(error);
    } finally {
      inFlight = null;
      if (again) {
        again = false;
        void refreshGitStatus();
      }
    }
  })();
  return inFlight;
}

async function run(action: () => Promise<unknown>): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (error) {
    reportError(error);
    return false;
  } finally {
    await refreshGitStatus();
  }
}

export const stage = (paths: string[]) => run(() => api.invoke('git:stage', paths));
export const unstage = (paths: string[]) => run(() => api.invoke('git:unstage', paths));

export async function discard(paths: string[]): Promise<void> {
  const what = paths.length === 1 ? paths[0] : `${paths.length} files`;
  if (!window.confirm(`Discard changes to ${what}? This cannot be undone.`)) return;
  await run(() => api.invoke('git:discard', paths));
}

export async function commit(message: string): Promise<boolean> {
  const ok = await run(async () => {
    const hash = await api.invoke('git:commit', message);
    toast(`Committed ${hash.slice(0, 7)}`);
  });
  return ok;
}

export const checkout = (branch: string) => run(() => api.invoke('git:checkout', branch));
export const createBranch = (branch: string) => run(() => api.invoke('git:createBranch', branch));
