import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git, GitError, gitBuffer } from './git.js';

/** The repository's (or worktree's) own git directory, absolute. */
export async function gitDir(root: string): Promise<string> {
  return (await git(root, ['rev-parse', '--absolute-git-dir'])).trim();
}

export async function revParse(root: string, rev: string): Promise<string | null> {
  if (rev.startsWith('-')) return null;
  return (
    (await git(root, ['rev-parse', '--verify', '--quiet', rev]).catch(() => '')).trim() || null
  );
}

export async function isAncestor(root: string, ancestor: string, of: string): Promise<boolean> {
  return git(root, ['merge-base', '--is-ancestor', ancestor, of])
    .then(() => true)
    .catch(() => false);
}

/**
 * The working tree (tracked and new files, not ignored ones) as a commit on top of HEAD, made
 * with a throwaway index: the branch, the staging area and the files stay as they are.
 */
export async function snapshotCommit(
  root: string,
  message: string,
): Promise<{ sha: string; tree: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'kovan-snap-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    await git(root, ['read-tree', 'HEAD'], { env });
    // Never node_modules: a worktree links the main checkout's dependencies in for its checks.
    await git(root, ['add', '-A', '--', '.', ':(exclude,glob)**/node_modules'], { env });
    const tree = (await git(root, ['write-tree'], { env })).trim();
    const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
    const sha = (
      await git(root, ['commit-tree', tree, '-p', head, '-m', message], {
        env: {
          GIT_AUTHOR_NAME: 'Kovan',
          GIT_AUTHOR_EMAIL: 'snapshots@kovan.local',
          GIT_COMMITTER_NAME: 'Kovan',
          GIT_COMMITTER_EMAIL: 'snapshots@kovan.local',
        },
      })
    ).trim();
    return { sha, tree };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface TreeEntry {
  mode: string;
  oid: string;
}

async function treeEntries(
  root: string,
  rev: string,
  paths: readonly string[],
): Promise<Map<string, TreeEntry>> {
  const map = new Map<string, TreeEntry>();
  if (paths.length === 0) return map;
  const out = await git(root, ['ls-tree', '-r', '-z', '--full-tree', rev, '--', ...paths]);
  for (const line of out.split('\0')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    const [mode = '', , oid = ''] = line.slice(0, tab).split(' ');
    map.set(line.slice(tab + 1), { mode, oid });
  }
  return map;
}

/** The blob id the working file would have, or null when it doesn't exist. */
async function workingOid(root: string, path: string): Promise<string | null> {
  const stat = await lstat(join(root, path)).catch(() => null);
  if (!stat || stat.isDirectory()) return null;
  return (await git(root, ['hash-object', '--', path])).trim();
}

/** Paths from a tree are repo-relative already; refuse anything that could leave the checkout. */
function safePath(path: string): boolean {
  return (
    path !== '' &&
    !path.startsWith('/') &&
    !path.split('/').some((part) => part === '..' || part === '' || part.toLowerCase() === '.git')
  );
}

export interface SyncConflict {
  path: string;
  /** Their version (null: they deleted the file). */
  theirs: Buffer | null;
}

export interface SyncResult {
  /** Files that only they changed: their version is here now. */
  taken: string[];
  /** Files both changed in different places: merged cleanly. */
  merged: string[];
  /** Files both changed in the same place: this checkout keeps its version, theirs is returned. */
  conflicts: SyncConflict[];
  /** Files they changed that this checkout already had the same way. */
  same: string[];
  /** Their branch was ahead and this checkout followed it (files untouched by the move). */
  movedHead: boolean;
}

/**
 * Brings a teammate's snapshot (a commit, already fetched) into this working tree, checked three
 * ways per file against `base`: the last snapshot of theirs this checkout took in, or where the
 * two lines of work met. Only files they changed since `base` are considered.
 * - unchanged here: their version is written;
 * - changed here the same way: nothing to do;
 * - changed here differently: merged when the changes don't touch, otherwise this checkout keeps
 *   its version and theirs is returned as a conflict ("2 versions"). Nothing is overwritten.
 * When their branch is ahead of this one (and nothing is staged here), HEAD follows theirs so
 * their commits don't show up as this person's changes.
 *
 * `dryRun` only reports what would happen; `atomic` writes nothing when any file conflicts
 * (a subagent's work joins its parent whole or not at all); `followHead: false` leaves HEAD.
 */
export async function syncFromSnapshot(
  root: string,
  snapshot: string,
  base: string | null,
  options: { dryRun?: boolean; atomic?: boolean; followHead?: boolean } = {},
): Promise<SyncResult> {
  const result: SyncResult = { taken: [], merged: [], conflicts: [], same: [], movedHead: false };
  const head = await revParse(root, 'HEAD');
  const from =
    base ?? (head ? (await git(root, ['merge-base', head, snapshot]).catch(() => '')).trim() : '');
  if (!from) throw new Error('The snapshot shares no history with this checkout.');

  const changed = (await git(root, ['diff', '--name-only', '-z', '--no-renames', from, snapshot]))
    .split('\0')
    .filter((p) => p && safePath(p));
  const before = await treeEntries(root, from, changed);
  const after = await treeEntries(root, snapshot, changed);

  const take: string[] = [];
  const merges = new Map<string, Buffer>();
  for (const path of changed) {
    const b = before.get(path) ?? null;
    const t = after.get(path) ?? null;
    if (b?.mode === '160000' || t?.mode === '160000') continue; // submodules move with git
    const mine = await workingOid(root, path);
    const theirs = t?.oid ?? null;
    if (mine === theirs) {
      result.same.push(path);
      continue;
    }
    if (mine === (b?.oid ?? null)) {
      take.push(path);
      continue;
    }
    // Both sides changed the file. Merge text when the changes don't overlap.
    if (mine && b && t && b.mode !== '120000' && t.mode !== '120000') {
      const merged = await mergeBlobs(root, path, b.oid, t.oid);
      if (merged) {
        merges.set(path, merged);
        result.merged.push(path);
        continue;
      }
    }
    result.conflicts.push({
      path,
      theirs: theirs ? await gitBuffer(root, ['cat-file', 'blob', theirs]) : null,
    });
  }

  result.taken = take;
  if (options.dryRun || (options.atomic && result.conflicts.length > 0)) return result;

  for (const [path, content] of merges) await writeFile(join(root, path), content);
  const restore = take.filter((p) => after.has(p));
  for (const path of take.filter((p) => !after.has(p))) await rm(join(root, path), { force: true });
  if (restore.length > 0)
    await git(root, ['restore', `--source=${snapshot}`, '--worktree', '--', ...restore]);

  if (options.followHead === false) return result;
  const theirHead = await revParse(root, `${snapshot}^`);
  if (head && theirHead && theirHead !== head && (await isAncestor(root, head, theirHead))) {
    const staged = await git(root, ['diff', '--cached', '--quiet'])
      .then(() => false)
      .catch(() => true);
    if (!staged) {
      await git(root, ['reset', '-q', '--mixed', theirHead]);
      result.movedHead = true;
    }
  }
  return result;
}

/** Three-way merge of the working file with their blob; null when the changes collide. */
async function mergeBlobs(
  root: string,
  path: string,
  baseOid: string,
  theirOid: string,
): Promise<Buffer | null> {
  const mine = (await git(root, ['hash-object', '-w', '--', path])).trim();
  try {
    const oid = (await git(root, ['merge-file', '--object-id', mine, baseOid, theirOid])).trim();
    return await gitBuffer(root, ['cat-file', 'blob', oid]);
  } catch (error) {
    // A positive exit code counts the conflicts; binary files can't be merged at all.
    if (error instanceof GitError) return null;
    throw error;
  }
}

/** Writes `content` as the working file at `path` (null deletes it). */
export async function writeWorkingFile(
  root: string,
  path: string,
  content: Buffer | null,
): Promise<void> {
  if (!safePath(path)) throw new Error(`Invalid path: ${path}`);
  const file = join(root, path);
  if (content === null) {
    await rm(file, { force: true });
    return;
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}
