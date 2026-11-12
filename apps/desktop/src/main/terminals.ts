import { spawn, type IPty } from 'node-pty';
import { existsSync } from 'node:fs';

function defaultShell(): string {
  if (process.platform === 'win32') return 'powershell.exe';
  const shell = process.env['SHELL'];
  if (shell && existsSync(shell)) return shell;
  return existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash';
}

export interface TerminalSink {
  data(id: number, data: string): void;
  exit(id: number, exitCode: number): void;
}

/** The PTYs one window owns. Bytes pass through untouched in both directions. */
export class TerminalManager {
  private static nextId = 1;
  private readonly ptys = new Map<number, IPty>();

  constructor(private readonly sink: TerminalSink) {}

  /**
   * Starts a shell, or (with `program`) an agent CLI such as Claude Code directly in the PTY so
   * its own TUI and keys (Shift+Tab for permission modes) work exactly as outside Kovan.
   */
  create(
    cwd: string,
    cols: number,
    rows: number,
    program?: { file: string; args: string[]; env?: Record<string, string> },
  ): number {
    const id = TerminalManager.nextId++;
    const shell = program?.file ?? defaultShell();
    let pty: IPty;
    try {
      pty = spawn(shell, program ? program.args : process.platform === 'win32' ? [] : ['-l'], {
        name: 'xterm-256color',
        cols: Math.max(2, cols),
        rows: Math.max(1, rows),
        cwd,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          TERM_PROGRAM: 'Kovan',
          ...program?.env,
        },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `The terminal couldn't start ${shell} (${reason}). Pick another shell in Settings → Terminal.`,
        { cause: error },
      );
    }
    pty.onData((data) => this.sink.data(id, data));
    pty.onExit(({ exitCode }) => {
      this.ptys.delete(id);
      this.sink.exit(id, exitCode);
    });
    this.ptys.set(id, pty);
    return id;
  }

  write(id: number, data: string): void {
    this.ptys.get(id)?.write(data);
  }

  resize(id: number, cols: number, rows: number): void {
    try {
      this.ptys.get(id)?.resize(Math.max(2, cols), Math.max(1, rows));
    } catch {
      // The process exited between the resize request and now.
    }
  }

  kill(id: number): void {
    const pty = this.ptys.get(id);
    if (!pty) return;
    this.ptys.delete(id);
    pty.kill();
  }

  killAll(): void {
    for (const id of [...this.ptys.keys()]) this.kill(id);
  }
}
