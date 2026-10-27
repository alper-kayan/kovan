import type { PermissionMode } from '@kovan/harness';
import { spawn, type ChildProcess } from 'node:child_process';

export interface JsonLinesRun {
  child: ChildProcess;
  /** Resolves when the process exits, with an error message unless it exited cleanly. */
  done: Promise<string | undefined>;
}

/**
 * Runs an agent CLI headless and hands each JSON line of its stdout to `onLine`. The process gets
 * its own group so stopping it also stops the commands it started.
 */
export function runJsonLines(
  binary: string,
  args: string[],
  options: {
    cwd: string;
    pathEnv: string;
    name: string;
    input?: boolean;
    /** More variables, e.g. the account's folder (CLAUDE_CONFIG_DIR, CODEX_HOME). */
    env?: Record<string, string>;
  },
  onLine: (line: Record<string, unknown>) => void,
): JsonLinesRun {
  const child = spawn(binary, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env, PATH: options.pathEnv },
    // stdin stays closed (both CLIs wait for more input on an open pipe), unless the caller
    // writes the prompt there and closes it itself.
    stdio: [options.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let buffer = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('{')) continue;
      try {
        onLine(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // A partial or non-JSON line; skip it.
      }
    }
  });
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const done = new Promise<string | undefined>((resolve) => {
    child.on('error', (error) => resolve(`Could not start ${options.name}: ${error.message}`));
    child.on('close', (code) =>
      resolve(
        code === 0
          ? undefined
          : stderr.trim().split('\n').slice(-3).join(' ') ||
              `${options.name} exited with code ${code}`,
      ),
    );
  });
  return { child, done };
}

/** Stops a process started by `runJsonLines` and everything it spawned. */
export function stopGroup(child: ChildProcess | null): void {
  if (!child?.pid) return;
  const pid = child.pid;
  try {
    process.kill(-pid, 'SIGTERM');
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }, 2000);
  } catch {
    child.kill('SIGKILL');
  }
}

/** What an external agent's chat turn needs from Kovan, whichever CLI it is. */
export interface ExternalRunner {
  readonly running: boolean;
  configure(patch: { model?: string; mode?: PermissionMode }): void;
  send(prompt: string): Promise<void>;
  stop(): void;
  /**
   * A teammate's message for the running turn: true when handed over (the runner then says
   * "delivered" once the agent has it, or "returned" if the turn ended first).
   */
  steer?(steer: { id: string; text: string; fromUserId?: string; fromName?: string }): boolean;
}
