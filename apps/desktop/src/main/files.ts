import { git } from '@kovan/git-engine';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import type { DirEntry, FileContent, FsChangeEvent } from '../shared/api.js';
import { resolveInside, toRelative } from './paths.js';

/** Files larger than this open as "too large" instead of in the editor. */
export const MAX_EDITOR_BYTES = 10 * 1024 * 1024;
const MAX_LISTED_FILES = 50_000;
const HIDDEN_NAMES = new Set(['.git', '.DS_Store']);
const WALK_SKIP = new Set(['.git', 'node_modules', 'dist', 'out', 'build', '.turbo', '.next']);

export async function readDirEntries(root: string, path: string): Promise<DirEntry[]> {
  const dir = await resolveInside(root, path);
  const entries = await readdir(dir, { withFileTypes: true });
  const out: DirEntry[] = [];
  for (const entry of entries) {
    if (HIDDEN_NAMES.has(entry.name)) continue;
    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try {
        isDir = (await stat(join(dir, entry.name))).isDirectory();
      } catch {
        // Broken symlink: show it as a file.
      }
    }
    out.push({
      name: entry.name,
      path: toRelative(root, join(dir, entry.name)),
      kind: isDir ? 'dir' : 'file',
    });
  }
  return out.sort((a, b) =>
    a.kind === b.kind
      ? a.name.localeCompare(b.name, undefined, { numeric: true })
      : a.kind === 'dir'
        ? -1
        : 1,
  );
}

export function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8000);
  return sample.includes(0);
}

export async function readTextFile(root: string, path: string): Promise<FileContent> {
  const file = await resolveInside(root, path);
  const info = await stat(file);
  if (info.size > MAX_EDITOR_BYTES) return { kind: 'tooLarge', size: info.size };
  const buffer = await readFile(file);
  if (looksBinary(buffer)) return { kind: 'binary' };
  return { kind: 'text', content: buffer.toString('utf8') };
}

export async function writeTextFile(root: string, path: string, content: string): Promise<void> {
  const file = await resolveInside(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}

/**
 * Every file in the workspace for quick open. Inside a git repo this is tracked plus untracked
 * (respecting .gitignore); otherwise a bounded walk that skips build output.
 */
export async function listWorkspaceFiles(root: string, isRepo: boolean): Promise<string[]> {
  if (isRepo) {
    const out = await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
    return [...new Set(out.split('\0').filter(Boolean))].slice(0, MAX_LISTED_FILES);
  }
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (files.length >= MAX_LISTED_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_LISTED_FILES) return;
      if (entry.isDirectory()) {
        if (!WALK_SKIP.has(entry.name)) await walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        files.push(toRelative(root, join(dir, entry.name)));
      }
    }
  }
  await walk(root);
  return files;
}

/**
 * Watches the whole workspace with one native recursive watcher (FSEvents on macOS,
 * ReadDirectoryChangesW on Windows) and reports batched changes.
 */
export function watchWorkspace(
  root: string,
  onChange: (event: FsChangeEvent) => void,
  debounceMs = 120,
): () => void {
  let watcher: FSWatcher | null = null;
  const pending = new Set<string>();
  let gitChanged = false;
  let timer: NodeJS.Timeout | null = null;

  const flush = () => {
    timer = null;
    if (pending.size === 0 && !gitChanged) return;
    onChange({ paths: [...pending], gitChanged });
    pending.clear();
    gitChanged = false;
  };

  try {
    watcher = watch(root, { recursive: true }, (_type, filename) => {
      if (!filename) return;
      const rel = filename.toString().split(sep).join('/');
      if (rel === '.git' || rel.startsWith('.git/')) {
        // Only the files that change what `git status` reports.
        if (/^\.git\/(HEAD|index|refs\/|MERGE_HEAD|REBASE_HEAD)/.test(rel)) gitChanged = true;
      } else if (!rel.split('/').includes('node_modules')) {
        pending.add(rel);
      }
      if (!timer) timer = setTimeout(flush, debounceMs);
    });
    watcher.on('error', () => {
      // The watched folder went away; the renderer will notice on its next read.
    });
  } catch {
    // Recursive watching is unavailable: the explorer still works, it just won't live-update.
  }

  return () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}
