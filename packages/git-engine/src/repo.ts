import { git, GitError } from './git.js';
import { parseStatus, type RepoStatus } from './status.js';

/** Returns the top-level directory of the repository containing `dir`, or null if none. */
export async function findRepoRoot(dir: string): Promise<string | null> {
  try {
    return (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
  } catch (error) {
    if (error instanceof GitError) return null;
    throw error;
  }
}

export async function getStatus(root: string): Promise<RepoStatus> {
  const out = await git(root, [
    'status',
    '--porcelain=v2',
    '--branch',
    '-z',
    '--untracked-files=all',
  ]);
  return parseStatus(out);
}

export interface DiffSides {
  /** Content before the change ('' when the file is new). */
  original: string;
  /** Content after the change ('' when the file is deleted). Null means "read it from disk". */
  modified: string | null;
}

async function showOrEmpty(root: string, spec: string): Promise<string> {
  try {
    return await git(root, ['show', spec]);
  } catch (error) {
    if (error instanceof GitError) return '';
    throw error;
  }
}

/**
 * Both sides of a file's change, for a side-by-side diff view.
 * Staged: HEAD vs index. Unstaged: index vs working tree (read from disk by the caller).
 */
export async function getDiffSides(
  root: string,
  path: string,
  staged: boolean,
): Promise<DiffSides> {
  if (staged) {
    return {
      original: await showOrEmpty(root, `HEAD:${path}`),
      modified: await showOrEmpty(root, `:${path}`),
    };
  }
  return { original: await showOrEmpty(root, `:${path}`), modified: null };
}

export async function stage(root: string, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  await git(root, ['add', '-A', '--', ...paths]);
}

export async function unstage(root: string, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  const status = await getStatus(root);
  if (status.head === null) {
    // No HEAD to restore from yet: drop the paths from the index instead.
    await git(root, ['rm', '-r', '--cached', '--quiet', '--', ...paths]);
    return;
  }
  await git(root, ['restore', '--staged', '--', ...paths]);
}

/** Throws away unstaged changes. Untracked files are deleted. */
export async function discard(root: string, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  const status = await getStatus(root);
  const untracked = new Set(status.files.filter((f) => f.kind === 'untracked').map((f) => f.path));
  const tracked = paths.filter((p) => !untracked.has(p));
  const fresh = paths.filter((p) => untracked.has(p));
  if (tracked.length > 0) await git(root, ['restore', '--worktree', '--', ...tracked]);
  if (fresh.length > 0) await git(root, ['clean', '-f', '-q', '--', ...fresh]);
}

/** Commits what is staged and returns the new commit hash. */
export async function commit(root: string, message: string): Promise<string> {
  if (message.trim() === '') throw new Error('Commit message is empty');
  await git(root, ['commit', '-F', '-'], { input: message });
  return (await git(root, ['rev-parse', 'HEAD'])).trim();
}

export interface BranchInfo {
  name: string;
  current: boolean;
  upstream: string | null;
}

export async function listBranches(root: string): Promise<BranchInfo[]> {
  const out = await git(root, [
    'for-each-ref',
    '--format=%(HEAD)%00%(refname:short)%00%(upstream:short)',
    'refs/heads',
  ]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [head = '', name = '', upstream = ''] = line.split('\0');
      return { name, current: head === '*', upstream: upstream || null };
    });
}

/** Rejects names git would not accept as a branch, including ones that look like options. */
async function assertBranchName(root: string, branch: string): Promise<void> {
  if (branch.startsWith('-')) throw new Error(`Invalid branch name: ${branch}`);
  await git(root, ['check-ref-format', '--branch', branch]);
}

export async function checkout(root: string, branch: string): Promise<void> {
  await assertBranchName(root, branch);
  await git(root, ['switch', branch]);
}

export async function createBranch(root: string, branch: string): Promise<void> {
  await assertBranchName(root, branch);
  await git(root, ['switch', '-c', branch]);
}

/** The URL of a remote ("origin" by default), or null when it isn't configured. */
export async function getRemoteUrl(root: string, remote = 'origin'): Promise<string | null> {
  try {
    return (await git(root, ['remote', 'get-url', remote])).trim() || null;
  } catch (error) {
    if (error instanceof GitError) return null;
    throw error;
  }
}

/** Clones `url` into `dest` (which must not exist yet) using the user's own git credentials. */
export async function cloneRepo(url: string, dest: string): Promise<void> {
  if (url.startsWith('-')) throw new Error(`Invalid repository URL: ${url}`);
  await git(process.cwd(), ['clone', '--', url, dest], { timeoutMs: 10 * 60_000 });
}

/**
 * Pushes the current branch with the person's own credentials, setting its upstream on the
 * first push. Returns the remote it went to.
 */
export async function push(root: string): Promise<string> {
  const status = await getStatus(root);
  if (!status.branch) throw new Error('Check out a branch to push (HEAD is detached).');
  const remotes = (await git(root, ['remote'])).split('\n').filter(Boolean);
  if (remotes.length === 0) throw new Error('This repository has no remote to push to.');
  if (status.upstream) {
    await git(root, ['push', '--porcelain'], { timeoutMs: 120_000 });
    return status.upstream.split('/')[0]!;
  }
  const remote = remotes.includes('origin') ? 'origin' : remotes[0]!;
  await git(root, ['push', '--porcelain', '-u', remote, `HEAD:refs/heads/${status.branch}`], {
    timeoutMs: 120_000,
  });
  return remote;
}

export interface GraphCommit {
  sha: string;
  parents: string[];
  subject: string;
  author: string;
  /** ISO date. */
  date: string;
  /** Branch and tag names pointing here. */
  refs: string[];
}

/** Recent history of all local and remote branches, newest first, for a commit graph. */
export async function logGraph(root: string, limit = 200): Promise<GraphCommit[]> {
  const out = await git(root, [
    'log',
    '--branches',
    '--remotes',
    '--tags',
    'HEAD',
    '--topo-order',
    `--max-count=${Math.max(1, Math.min(limit, 2000))}`,
    '--format=%H%x00%P%x00%s%x00%an%x00%aI%x00%D%x1e',
  ]).catch((error: unknown) => {
    // A repository without commits has no history yet.
    if (error instanceof GitError) return '';
    throw error;
  });
  return out
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha = '', parents = '', subject = '', author = '', date = '', refs = ''] =
        record.split('\0');
      return {
        sha,
        parents: parents.split(' ').filter(Boolean),
        subject,
        author,
        date,
        refs: refs
          .split(', ')
          .map((r) => r.replace(/^HEAD -> /, '').replace(/^tag: /, ''))
          .filter((r) => r && r !== 'HEAD' && !r.endsWith('/HEAD')),
      };
    });
}
