import { execFile } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ids = new Map<string, Promise<string>>();

/**
 * What a workspace's settings are kept under: its repository's main checkout, the same in
 * every session worktree; a folder that isn't a repository is itself.
 */
export function repoIdentity(root: string): Promise<string> {
  let id = ids.get(root);
  if (!id) {
    id = run('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
      .then(({ stdout }) => {
        const dir = stdout.trim();
        return basename(dir) === '.git' ? dirname(dir) : dir;
      })
      .catch(() => resolve(root));
    ids.set(root, id);
  }
  return id;
}
