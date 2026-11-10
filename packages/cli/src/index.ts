#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { AuthStore } from './auth.js';
import { main, type Terminal } from './run.js';
import { ConversationStore } from './store.js';
import { realIO } from './tui/io.js';

function nodeTerminal(): Terminal {
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  // Made on first use: the full-screen interface reads the keys itself and must not have readline holding stdin.
  let made: ReturnType<typeof createInterface> | null = null;
  let interrupt: () => void = () => {};
  const get = () => {
    if (!made) {
      made = createInterface({ input: process.stdin, output: process.stdout, terminal: tty });
      made.on('SIGINT', () => interrupt());
    }
    return made;
  };
  return {
    isTTY: tty,
    write: (s) => void process.stdout.write(s),
    readLine: (prompt, signal) =>
      new Promise((resolve) => {
        const rl = get();
        const onClose = () => resolve(null);
        rl.once('close', onClose);
        const finish = (answer: string | null) => {
          rl.off('close', onClose);
          resolve(answer);
        };
        // Withdrawn (the notch answered first): the question goes away and nobody waits for it.
        if (signal?.aborted) return finish(null);
        signal?.addEventListener('abort', () => finish(null), { once: true });
        if (signal) rl.question(prompt, { signal }, (answer) => finish(answer));
        else rl.question(prompt, (answer) => finish(answer));
      }),
    onInterrupt: (handler) => {
      interrupt = handler;
    },
    close: () => made?.close(),
  };
}

/** The browser, for the sign-in page. Best effort: the address is printed as well. */
function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true })
    .on('error', () => {})
    .unref();
}

const terminal = nodeTerminal();
main(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  terminal,
  store: new ConversationStore(),
  auth: new AuthStore(),
  argv1: process.argv[1],
  checkUpdates: true,
  screen: () => realIO(),
  open: openBrowser,
  err: (s) => console.error(s),
}).then(
  (code) => {
    terminal.close();
    process.exit(code);
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
