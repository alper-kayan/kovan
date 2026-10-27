import { execFile } from 'node:child_process';

export type HarnessId = 'kovan' | 'claude-code' | 'codex';

export interface ExternalAgent {
  id: 'claude-code' | 'codex' | 'opencode' | 'cursor';
  name: string;
  command: string;
  path: string | null;
  version: string | null;
  /** Kovan can run it (native chat and terminal). */
  supported: boolean;
  /** Why it's dimmed when it can't be used. */
  reason: string | null;
}

const KNOWN: {
  id: ExternalAgent['id'];
  name: string;
  command: string;
  supported: boolean;
  note: string;
}[] = [
  { id: 'claude-code', name: 'Claude Code', command: 'claude', supported: true, note: '' },
  { id: 'codex', name: 'Codex', command: 'codex', supported: true, note: '' },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    supported: false,
    note: 'Detected. Native support is planned; use it from the terminal for now.',
  },
  {
    id: 'cursor',
    name: 'Cursor Agent',
    command: 'cursor-agent',
    supported: false,
    note: 'Detected. Native support is planned; use it from the terminal for now.',
  },
];

function run(command: string, args: string[], timeoutMs = 8000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, env: process.env }, (error, stdout) =>
      resolve(error ? null : stdout.trim()),
    );
  });
}

let loginPath: string | null = null;
let firstDir: string | null = null;

/** Dev only: a folder searched before the user's PATH (end-to-end checks put stand-in CLIs there). */
export function searchFirst(dir: string): void {
  firstDir = dir;
  loginPath = null;
}

/** The PATH of the user's login shell; apps opened from the Dock don't inherit it. */
export async function userPath(): Promise<string> {
  if (loginPath !== null) return loginPath;
  if (process.platform === 'win32') return (loginPath = process.env['PATH'] ?? '');
  const shell = process.env['SHELL'] || '/bin/zsh';
  const out = await run(shell, ['-ilc', 'printf "%s" "$PATH"'], 8000);
  const login = out?.split('\n').pop() ?? '';
  // Started from a terminal, the app's own PATH may have more; keep both, login shell first.
  const dirs = [
    ...(firstDir ? [firstDir] : []),
    ...login.split(':'),
    ...(process.env['PATH'] ?? '').split(':'),
  ].filter(Boolean);
  loginPath = [...new Set(dirs)].join(':');
  return loginPath;
}

/** Finds supported agent CLIs on this machine. */
export async function detectAgents(): Promise<ExternalAgent[]> {
  const path = await userPath();
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  return Promise.all(
    KNOWN.map(async (k) => {
      const found = await new Promise<string | null>((resolve) =>
        execFile(lookup, [k.command], { env: { ...process.env, PATH: path } }, (error, stdout) =>
          resolve(error ? null : stdout.split('\n')[0]!.trim() || null),
        ),
      );
      const version = found ? await run(found, ['--version']) : null;
      return {
        id: k.id,
        name: k.name,
        command: k.command,
        path: found,
        version: version?.split('\n')[0] ?? null,
        supported: Boolean(found) && k.supported,
        reason: !found
          ? `${k.name} is not installed on this machine.`
          : k.supported
            ? null
            : k.note,
      };
    }),
  );
}
