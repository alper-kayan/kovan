#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { AuthStore } from './auth.js';
import { main, type Terminal } from './run.js';
import { ConversationStore } from './store.js';

function nodeTerminal(): Terminal {
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: tty });
  let interrupt: () => void = () => {};
  rl.on('SIGINT', () => interrupt());
  return {
    isTTY: tty,
    write: (s) => void process.stdout.write(s),
    readLine: (prompt, signal) =>
      new Promise((resolve) => {
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
    close: () => rl.close(),
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
