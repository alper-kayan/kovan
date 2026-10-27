import { git, GitError } from './git.js';

export interface WorktreeInfo {
  path: string;
  /** Commit checked out there, or null before the first commit. */
  head: string | null;
  /** Branch checked out there, or null when detached. */
  branch: string | null;
  /** The repository's main checkout (the first entry git lists). */
  main: boolean;
}

/** Every worktree of the repository `root` belongs to, the main checkout first. */
export async function listWorktrees(root: string): Promise<WorktreeInfo[]> {
  const out = await git(root, ['worktree', 'list', '--porcelain', '-z']);
  const list: WorktreeInfo[] = [];
  let current: WorktreeInfo | null = null;
  for (const entry of out.split('\0')) {
    if (entry === '') {
      if (current) list.push(current);
      current = null;
      continue;
    }
    const space = entry.indexOf(' ');
    const key = space === -1 ? entry : entry.slice(0, space);
    const value = space === -1 ? '' : entry.slice(space + 1);
    if (key === 'worktree') {
      if (current) list.push(current);
      current = { path: value, head: null, branch: null, main: list.length === 0 };
    } else if (current && key === 'HEAD') current.head = /^0+$/.test(value) ? null : value;
    else if (current && key === 'branch') current.branch = value.replace(/^refs\/heads\//, '');
  }
  if (current) list.push(current);
  return list;
}

/** The main checkout of the repository `root` is in (itself, when it is the main checkout). */
export async function mainCheckout(root: string): Promise<string> {
  return (await listWorktrees(root))[0]?.path ?? root;
}

/** Where `branch` is checked out right now, if anywhere. */
export async function worktreeOfBranch(root: string, branch: string): Promise<string | null> {
  return (await listWorktrees(root)).find((w) => w.branch === branch)?.path ?? null;
}

async function refExists(root: string, ref: string): Promise<boolean> {
  return git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    .then(() => true)
    .catch(() => false);
}

/**
 * Adds a worktree at `path` with `branch` checked out. The branch is created when it doesn't
 * exist yet: from the remote's branch of that name when there is one, else from `startPoint`
 * (HEAD by default).
 */
export async function addWorktree(
  root: string,
  path: string,
  branch: string,
  startPoint = 'HEAD',
): Promise<void> {
  if (branch.startsWith('-') || startPoint.startsWith('-'))
    throw new Error(`Invalid branch name: ${branch}`);
  await git(root, ['check-ref-format', '--branch', branch]);
  if (await refExists(root, `refs/heads/${branch}`)) {
    await git(root, ['worktree', 'add', '--', path, branch]);
    return;
  }
  const remote = (
    await git(root, ['for-each-ref', '--format=%(refname)', `refs/remotes/*/${branch}`])
  )
    .split('\n')
    .find(Boolean);
  await git(root, [
    'worktree',
    'add',
    ...(remote ? ['--track'] : []),
    '-b',
    branch,
    '--',
    path,
    remote ?? startPoint,
  ]);
}

/** Adds a worktree at `path` with `commit` checked out on no branch (a detached HEAD). */
export async function addDetachedWorktree(
  root: string,
  path: string,
  commit: string,
): Promise<void> {
  if (commit.startsWith('-')) throw new Error(`Invalid commit: ${commit}`);
  await git(root, ['worktree', 'add', '--detach', '--', path, commit]);
}

/** Removes a worktree and its files (even with changes in it); the branch stays. */
export async function removeWorktree(root: string, path: string): Promise<void> {
  try {
    await git(root, ['worktree', 'remove', '--force', '--', path]);
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    // Already gone from disk: forget it.
    await git(root, ['worktree', 'prune']);
  }
}
