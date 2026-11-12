import { execFile } from 'node:child_process';

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
    readonly stdout = '',
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitRunOptions {
  /** Text written to git's stdin. */
  input?: string;
  /** Kill git after this many milliseconds. */
  timeoutMs?: number;
  /** Extra environment (e.g. GIT_INDEX_FILE for a throwaway index). */
  env?: Record<string, string>;
}

const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * A failed git command in words: what went wrong and what to do, for the cases people meet
 * (no connection, no access, no such repository, the remote moved on, changes that overlap).
 * Git's own first line stays at the end. Anything else reads as before.
 */
export function plainGitError(args: readonly string[], detail: string): string {
  const command = args[0] ?? '';
  const line =
    detail
      .split('\n')
      .map((l) => l.replace(/^(fatal|error|remote):\s*/i, '').trim())
      .find((l) => l && !/^(To |hint:)/.test(l)) ?? detail.trim();
  const said = ` (git said: ${line.slice(0, 240)})`;
  const remoteWork = ['push', 'fetch', 'pull', 'clone', 'ls-remote'].includes(command);
  const kept = command === 'push' ? ' Your commits are still saved on this computer.' : '';
  if (
    remoteWork &&
    /could not resolve host|unable to access|timed out|network is unreachable|connection refused/i.test(
      detail,
    )
  )
    return `Git couldn't reach the server that holds the repository: check your connection.${kept}${said}`;
  if (
    remoteWork &&
    /permission denied|access denied|denied to|403|authentication failed|could not read username|invalid credentials/i.test(
      detail,
    )
  )
    return `Your Git account isn't allowed to ${command === 'push' ? 'push to' : 'read'} this repository: ask its owner for access.${kept}${said}`;
  if (
    remoteWork &&
    /repository not found|does not appear to be a git repository|not found/i.test(detail)
  )
    return `Git found no repository at that address, or your account can't see it.${kept}${said}`;
  if (command === 'push' && /non-fast-forward|fetch first|\[rejected\]/i.test(detail))
    return `The remote has changes this copy doesn't have yet: get them first, then push again.${kept}${said}`;
  if (/CONFLICT|merge conflict|could not apply/i.test(detail))
    return `The changes overlap with others on the same lines, so Git couldn't combine them by itself.${said}`;
  return `git ${command} failed: ${detail}`;
}

/**
 * Runs the system `git` in `cwd` and resolves with stdout.
 * Uses the user's own git config and credentials; never a shell.
 */
export function git(
  cwd: string,
  args: readonly string[],
  options: GitRunOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        maxBuffer: MAX_BUFFER,
        timeout: options.timeoutMs ?? 0,
        env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = typeof error.code === 'number' ? error.code : null;
          const detail = stderr.trim() || error.message;
          reject(new GitError(plainGitError(args, detail), args, code, stderr, stdout));
          return;
        }
        resolve(stdout);
      },
    );
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}

/** Like `git`, for output that may be binary (blob contents). */
export function gitBuffer(cwd: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'buffer',
        maxBuffer: MAX_BUFFER,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = typeof error.code === 'number' ? error.code : null;
          const detail = stderr.toString('utf8').trim() || error.message;
          reject(new GitError(plainGitError(args, detail), args, code, detail));
          return;
        }
        resolve(stdout);
      },
    );
  });
}
