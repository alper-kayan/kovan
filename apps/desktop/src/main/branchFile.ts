import { git, gitBuffer } from '@kovan/git-engine';
import { pushRemote } from '@kovan/runner';
import type { BranchFile } from '../shared/api.js';
import { looksBinary, MAX_EDITOR_BYTES } from './files.js';

/** When each branch was last fetched, so opening several of its files fetches once. */
const fetched = new Map<string, number>();
const FRESH_MS = 15_000;

/**
 * A file as it is on a session's branch on the remote: what a machine (agentd) wrote, read
 * without touching this checkout's own branch or files. The branch is fetched first (at most
 * every few seconds); a file the machine hasn't pushed yet comes back as missing.
 */
export async function branchFile(
  root: string,
  branch: string,
  path: string,
  options: { refresh?: boolean } = {},
): Promise<BranchFile> {
  const clean = path.replace(/^\.\//, '');
  if (!clean || clean.startsWith('/') || clean.startsWith('-') || clean.split('/').includes('..'))
    throw new Error(`Not a path in the repository: ${path}`);
  await git(root, ['check-ref-format', '--branch', branch]);
  const remote = await pushRemote(root);
  if (!remote) return { missing: 'branch', remote: null };
  const key = `${root}\0${remote}\0${branch}`;
  if (options.refresh || Date.now() - (fetched.get(key) ?? 0) > FRESH_MS) {
    const ok = await git(
      root,
      ['fetch', '--no-tags', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
      { timeoutMs: 60_000 },
    )
      .then(() => true)
      .catch(() => false);
    if (ok) fetched.set(key, Date.now());
  }
  const ref = `refs/remotes/${remote}/${branch}`;
  const has = await git(root, ['rev-parse', '--verify', '--quiet', ref])
    .then((out) => out.trim())
    .catch(() => '');
  if (!has) return { missing: 'branch', remote };
  const size = Number(
    (await git(root, ['cat-file', '-s', `${ref}:${clean}`]).catch(() => '')).trim() || NaN,
  );
  if (Number.isNaN(size)) return { missing: 'file', remote, commit: has.slice(0, 7) };
  if (size > MAX_EDITOR_BYTES)
    return { file: { kind: 'tooLarge', size }, remote, commit: has.slice(0, 7) };
  const buffer = await gitBuffer(root, ['cat-file', 'blob', `${ref}:${clean}`]);
  return {
    file: looksBinary(buffer)
      ? { kind: 'binary' }
      : { kind: 'text', content: buffer.toString('utf8') },
    remote,
    commit: has.slice(0, 7),
  };
}
