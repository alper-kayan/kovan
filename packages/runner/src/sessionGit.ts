import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, GitError, listBranches, snapshotCommit } from '@kovan/git-engine';

const MAX_DIFF = 400_000;

/** The branch checked out now, or null when HEAD is detached. */
export async function currentBranch(root: string): Promise<string | null> {
  const out = (await git(root, ['branch', '--show-current']).catch(() => '')).trim();
  return out || null;
}

/** The remote pushes go to: the branch's upstream remote, else origin, else the only one. */
export async function pushRemote(root: string): Promise<string | null> {
  const remotes = (await git(root, ['remote']).catch(() => ''))
    .split('\n')
    .map((r) => r.trim())
    .filter(Boolean);
  if (remotes.length === 0) return null;
  const upstream = (
    await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')
  ).trim();
  const fromUpstream = upstream.split('/')[0];
  if (fromUpstream && remotes.includes(fromUpstream)) return fromUpstream;
  return remotes.includes('origin') ? 'origin' : remotes[0]!;
}

/**
 * Whether this machine may push the session branch. A dry-run push reaches the server with the
 * person's own credentials; being behind ("rejected", "fetch first") still proves access.
 * Returns why not, or null. Repos without a remote have nothing to push to and pass.
 */
export async function pushProblem(root: string, branch: string): Promise<string | null> {
  const remote = await pushRemote(root);
  if (!remote) return null;
  try {
    await git(root, ['push', '--dry-run', '--porcelain', remote, `HEAD:refs/heads/${branch}`], {
      timeoutMs: 20_000,
    });
    return null;
  } catch (error) {
    const text = error instanceof GitError ? error.stderr || error.message : String(error);
    if (/non-fast-forward|fetch first|\[rejected\]|rejected/i.test(text)) return null;
    const line =
      text
        .split('\n')
        .map((l) => l.replace(/^(fatal|error|remote):\s*/i, '').trim())
        .find((l) => l && !/^To /.test(l)) ?? 'the push was refused';
    const why = /could not resolve host|unable to access|timed out|network is unreachable/i.test(
      text,
    )
      ? "can't reach the server that holds the repository: check your connection"
      : /not found|does not appear to be a git repository|no such/i.test(text)
        ? "the repository isn't at that address, or your Git account can't see it"
        : /denied|forbidden|403|401|authentication|could not read username|permission/i.test(text)
          ? "your Git account isn't allowed to push to it"
          : 'the push was refused';
    return `Kovan can't upload your work from this computer: ${why}. Ask the repository's owner for write access, or watch the session instead. (Git said: ${line})`;
  }
}

/** Switches to the session branch, creating it from the current commit when it doesn't exist. */
export async function switchToBranch(root: string, branch: string): Promise<void> {
  if (branch.startsWith('-')) throw new Error(`Invalid branch name: ${branch}`);
  await git(root, ['check-ref-format', '--branch', branch]);
  const local = (await listBranches(root)).some((b) => b.name === branch);
  if (local) {
    await git(root, ['switch', branch]);
    return;
  }
  // `git switch <name>` also picks up a branch that only exists on the remote.
  try {
    await git(root, ['switch', branch]);
  } catch {
    await git(root, ['switch', '-c', branch]);
  }
}

/**
 * The session's final diff on this machine: everything on this checkout since it left the base
 * branch, committed or not (tracked files). Null when there is nothing to show.
 */
export async function finalDiff(root: string, baseBranch: string): Promise<string | null> {
  const from = await forkPoint(root, baseBranch);
  const diff = await git(root, ['diff', '--no-color', '--no-ext-diff', from]).catch(() => '');
  return capped(diff);
}

/** Where this checkout left the base branch (HEAD when the base isn't known here). */
async function forkPoint(root: string, baseBranch: string | null): Promise<string> {
  for (const ref of baseBranch ? [`origin/${baseBranch}`, baseBranch] : []) {
    const ok = await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
      .then(() => true)
      .catch(() => false);
    if (ok) return (await git(root, ['merge-base', 'HEAD', ref]).catch(() => '')).trim() || 'HEAD';
  }
  return 'HEAD';
}

function capped(diff: string): string | null {
  if (!diff.trim()) return null;
  return diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n… (diff truncated)\n` : diff;
}

/** The repository's default branch as this checkout knows it (origin's HEAD, else main/master). */
export async function defaultBranch(root: string): Promise<string | null> {
  const head = (
    await git(root, ['rev-parse', '--abbrev-ref', 'origin/HEAD']).catch(() => '')
  ).trim();
  if (head && head !== 'origin/HEAD') return head.replace(/^origin\//, '');
  for (const name of ['main', 'master'])
    if (
      await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])
        .then(() => true)
        .catch(() => false)
    )
      return name;
  return null;
}

/**
 * The session's changes on this machine while it is live, for teammates and the phone: like the
 * final diff, but new files count too. They are staged into a throwaway index, so the person's
 * own staging area is untouched. Returns the diff (null when clean) and the commit it sits on.
 */
export async function liveDiff(
  root: string,
  baseBranch: string | null,
): Promise<{ diff: string | null; commit: string | null }> {
  const from = await forkPoint(root, baseBranch);
  const commit = (await git(root, ['rev-parse', 'HEAD']).catch(() => '')).trim() || null;
  const dir = await mkdtemp(join(tmpdir(), 'kovan-diff-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    await git(root, ['read-tree', 'HEAD'], { env });
    await git(root, ['add', '-A', '--', '.', ':(exclude,glob)**/node_modules'], { env });
    const diff = await git(root, ['diff', '--cached', '--no-color', '--no-ext-diff', from], {
      env,
    });
    return { diff: capped(diff), commit };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Where a lane's checkpoint snapshots live on the person's remote. */
export function snapshotRef(sessionId: string, userId: string): string {
  return `refs/kovan/snapshots/${sessionId}/${userId}`;
}

/**
 * A checkpoint of this checkout: the working tree (tracked and new files, not ignored ones)
 * as a commit on top of HEAD, made with a throwaway index so the person's branch and staging
 * area are untouched, and pushed with their own credentials to a shadow ref on their remote.
 * Returns null when there is no remote to push to (the snapshot then stays local).
 */
export async function pushSnapshot(
  root: string,
  ref: string,
  message: string,
): Promise<{ sha: string; ref: string; tree: string } | null> {
  const remote = await pushRemote(root);
  const { sha, tree } = await snapshotCommit(root, message);
  if (!remote) return null;
  await git(root, ['push', '--force', '--no-verify', remote, `${sha}:${ref}`], {
    timeoutMs: 60_000,
  });
  return { sha, ref, tree };
}

/**
 * Brings a teammate's snapshot into this checkout to continue their work: fetched from the
 * remote, then fast-forwarded (or merged) onto the current branch. Needs a clean checkout so
 * nothing of the person's own is overwritten.
 */
export async function applySnapshot(
  root: string,
  ref: string,
  sha: string,
): Promise<'fast-forward' | 'merged' | 'already'> {
  const status = (await git(root, ['status', '--porcelain'])).trim();
  if (status)
    throw new Error(
      'Your checkout has uncommitted changes. Commit or stash them, then take over again.',
    );
  const remote = await pushRemote(root);
  if (remote) await git(root, ['fetch', remote, `+${ref}:${ref}`], { timeoutMs: 60_000 });
  const have = await git(root, ['cat-file', '-e', `${sha}^{commit}`])
    .then(() => true)
    .catch(() => false);
  if (!have) throw new Error("The snapshot isn't on the remote (it may not have been pushed).");
  const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
  if (head === sha) return 'already';
  const ancestor = await git(root, ['merge-base', '--is-ancestor', 'HEAD', sha])
    .then(() => true)
    .catch(() => false);
  if (ancestor) {
    await git(root, ['merge', '--ff-only', sha]);
    return 'fast-forward';
  }
  try {
    await git(root, ['merge', '--no-edit', sha]);
    return 'merged';
  } catch (error) {
    await git(root, ['merge', '--abort']).catch(() => undefined);
    throw new Error(
      `The snapshot conflicts with your branch: ${(error as Error).message.split('\n')[0]}`,
      { cause: error },
    );
  }
}
