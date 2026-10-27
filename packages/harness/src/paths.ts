import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export class PathOutsideWorkspaceError extends Error {
  constructor(path: string) {
    super(`Path is outside the workspace: ${path}`);
    this.name = 'PathOutsideWorkspaceError';
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Resolves a renderer-supplied relative path against the workspace root and refuses anything
 * that escapes it, including through symlinks. The deepest existing ancestor is resolved with
 * realpath, so a path to a file that doesn't exist yet is still checked.
 */
export async function resolveInside(root: string, path: string): Promise<string> {
  if (isAbsolute(path) || path.includes('\0')) throw new PathOutsideWorkspaceError(path);
  const target = resolve(root, path);
  if (!isInside(root, target)) throw new PathOutsideWorkspaceError(path);

  const realRoot = await realpath(root);
  let existing = target;
  let suffix = '';
  for (;;) {
    try {
      const real = await realpath(existing);
      const full = suffix ? resolve(real, suffix) : real;
      if (!isInside(realRoot, full)) throw new PathOutsideWorkspaceError(path);
      return target;
    } catch (error) {
      if (error instanceof PathOutsideWorkspaceError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      suffix = suffix
        ? `${existing.slice(parent.length + 1)}${sep}${suffix}`
        : existing.slice(parent.length + 1);
      existing = parent;
    }
  }
}

/**
 * A path the agent may read: inside the workspace, or an absolute path inside one of
 * `readRoots` (folders outside it opened for reading only, such as the person's skills).
 */
export async function resolveReadable(
  root: string,
  path: string,
  readRoots: readonly string[] = [],
): Promise<string> {
  if (!isAbsolute(path) || readRoots.length === 0 || path.includes('\0'))
    return resolveInside(root, path);
  const real = await realpath(path);
  if (readRoots.some((r) => isInside(r, real))) return real;
  throw new PathOutsideWorkspaceError(path);
}

/** Workspace-relative path with forward slashes, for sending to the renderer. */
export function toRelative(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/');
}
