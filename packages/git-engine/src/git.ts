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
          reject(
            new GitError(`git ${args[0] ?? ''} failed: ${detail}`, args, code, stderr, stdout),
          );
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
          reject(new GitError(`git ${args[0] ?? ''} failed: ${detail}`, args, code, detail));
          return;
        }
        resolve(stdout);
      },
    );
  });
}
