import { spawn } from 'node:child_process';

export interface ShellResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  aborted: boolean;
}

const MAX_OUTPUT = 30_000;

/** Keeps the start and end of long output, which is where errors usually are. */
export function clip(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max * 0.3);
  const tail = text.slice(-max * 0.7);
  return `${head}\n… [${text.length - head.length - tail.length} characters omitted] …\n${tail}`;
}

/**
 * Runs a shell command in its own process group so stopping it (Esc, timeout) takes down
 * everything it started, not just the shell.
 */
export function runShell(
  command: string,
  cwd: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const child = spawn(
      isWindows ? 'powershell.exe' : '/bin/sh',
      isWindows ? ['-NoProfile', '-Command', command] : ['-c', command],
      {
        cwd,
        detached: !isWindows,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', CI: '1', TERM: 'dumb', PAGER: 'cat' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    let timedOut = false;
    let aborted = false;
    const collect = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > MAX_OUTPUT * 4) output = clip(output, MAX_OUTPUT * 2);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const kill = () => {
      try {
        if (!isWindows && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs ?? 120_000);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode: code, output: clip(output), timedOut, aborted });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, output: error.message, timedOut, aborted });
    });
  });
}
