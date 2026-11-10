import type { TuiIO } from './app.js';

/**
 * The real terminal: raw keys in, escape sequences out. Enters the alternate screen (so the shell's scrollback is untouched and comes back
 * on exit), turns on bracketed paste, and hands everything back however it ends: normal exit, signal, or a crash. No mouse capture, so
 * the terminal's own text selection keeps working.
 */
export function realIO(
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout,
): TuiIO {
  let active = false;
  let dataCb: ((d: Buffer | string) => void) | null = null;
  const restore = () => {
    if (!active) return;
    active = false;
    try {
      stdout.write('\u001b[?25h\u001b[?2004l\u001b[?1049l');
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
    } catch {
      // the terminal is already gone
    }
  };
  const onExit = () => restore();
  const onSignal = (sig: NodeJS.Signals) => () => {
    restore();
    process.kill(process.pid, sig);
  };
  const hup = onSignal('SIGHUP');
  const term = onSignal('SIGTERM');

  return {
    write: (s) => void stdout.write(s),
    size: () => ({
      cols: Math.max(20, stdout.columns || 80),
      rows: Math.max(8, stdout.rows || 24),
    }),
    onData: (cb) => {
      dataCb = cb;
      stdin.on('data', (d: Buffer | string) => dataCb?.(d));
    },
    onResize: (cb) => void stdout.on('resize', cb),
    setup: () => {
      if (active) return;
      active = true;
      if (stdin.isTTY) stdin.setRawMode(true);
      stdin.resume();
      stdout.write('\u001b[?1049h\u001b[?2004h\u001b[2J\u001b[H');
      process.once('exit', onExit);
      process.once('SIGHUP', hup);
      process.once('SIGTERM', term);
    },
    teardown: () => {
      restore();
      process.off('exit', onExit);
      process.off('SIGHUP', hup);
      process.off('SIGTERM', term);
    },
  };
}
