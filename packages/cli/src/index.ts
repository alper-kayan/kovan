#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { SessionStore } from './session.js';
import { main, type Terminal } from './run.js';

function nodeTerminal(): Terminal {
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: tty });
  let interrupt: () => void = () => {};
  rl.on('SIGINT', () => interrupt());
  return {
    isTTY: tty,
    write: (s) => void process.stdout.write(s),
    readLine: (prompt) =>
      new Promise((resolve) => {
        const onClose = () => resolve(null);
        rl.once('close', onClose);
        rl.question(prompt, (answer) => {
          rl.off('close', onClose);
          resolve(answer);
        });
      }),
    onInterrupt: (handler) => {
      interrupt = handler;
    },
    close: () => rl.close(),
  };
}

const terminal = nodeTerminal();
main(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  terminal,
  store: new SessionStore(),
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
