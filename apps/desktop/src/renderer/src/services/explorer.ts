import { getState, reportError, setState } from '../store';
import { api } from './api';

export function parentDir(path: string): string {
  const at = path.lastIndexOf('/');
  return at === -1 ? '' : path.slice(0, at);
}

export async function loadDir(dir: string): Promise<void> {
  try {
    const entries = await api.invoke('fs:readDir', dir);
    setState((s) => ({ dirs: { ...s.dirs, [dir]: entries } }));
  } catch (error) {
    // A directory that vanished just drops out of the tree.
    setState((s) => {
      const dirs = { ...s.dirs };
      delete dirs[dir];
      return { dirs };
    });
    if (dir === '') reportError(error);
  }
}

export async function toggleDir(dir: string): Promise<void> {
  const open = !getState().expanded[dir];
  setState((s) => ({ expanded: { ...s.expanded, [dir]: open } }));
  if (open && !getState().dirs[dir]) await loadDir(dir);
}

/** Re-reads every loaded directory that contains one of the changed paths. */
export async function refreshDirsFor(paths: string[]): Promise<void> {
  const loaded = getState().dirs;
  const stale = new Set<string>();
  for (const path of paths) {
    const parent = parentDir(path);
    if (parent in loaded) stale.add(parent);
    if (path in loaded) stale.add(path);
  }
  await Promise.all([...stale].map(loadDir));
}

/** Expands every ancestor of `path` so it is visible in the tree. */
export async function reveal(path: string): Promise<void> {
  const parts = path.split('/').slice(0, -1);
  let dir = '';
  for (const part of parts) {
    dir = dir ? `${dir}/${part}` : part;
    setState((s) => ({ expanded: { ...s.expanded, [dir]: true } }));
    if (!getState().dirs[dir]) await loadDir(dir);
  }
}
