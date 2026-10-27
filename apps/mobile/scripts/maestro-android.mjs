#!/usr/bin/env node
// Runs a Maestro flow on the Android emulator with its text typed by adb: Maestro's inputText
// stalls there. The flow is cut at each top-level `inputText`; the pieces run in turn and the
// text goes in between. Usage: node scripts/maestro-android.mjs e2e/review.yaml <out dir> [KEY=value…]
// The emulator is DEVICE (default emulator-5554).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const DEVICE = process.env.DEVICE ?? 'emulator-5554';
const ADB = join(homedir(), 'Library/Android/sdk/platform-tools/adb');
const MAESTRO = join(homedir(), '.maestro/bin/maestro');
const [flow, out, ...vars] = process.argv.slice(2);
if (!flow || !out) {
  console.error('usage: maestro-android.mjs <flow.yaml> <out dir> [KEY=value…]');
  process.exit(2);
}
mkdirSync(out, { recursive: true });

/** The flow's top-level commands (each a list of lines), with `runFlow`s inlined. */
function commands(path) {
  const [head, body] = readFileSync(path, 'utf8').split('\n---\n');
  const env = Object.fromEntries(
    [...head.matchAll(/^ {2}(\w+): (.*)$/gm)].map((m) => [m[1], m[2]]),
  );
  const items = [];
  for (const line of body.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    if (line.startsWith('- ')) items.push([line]);
    else items.at(-1).push(line);
  }
  return {
    env,
    items: items.flatMap((item) => {
      const sub = /^- runFlow: (\S+)$/.exec(item[0]);
      return sub ? commands(join(dirname(path), sub[1])).items : [item];
    }),
  };
}

const { env, items } = commands(flow);
for (const v of vars) env[v.slice(0, v.indexOf('='))] = v.slice(v.indexOf('=') + 1);
const fill = (s) => s.replace(/\$\{(\w+)\}/g, (_, k) => env[k]);
const unquote = (s) => {
  s = s.trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"')))
    s = s.slice(1, -1);
  return s.replaceAll("''", "'");
};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function type(text) {
  // The field was just tapped: a field that selects its text on focus does it a moment later
  // (a person's first key comes after the keyboard is up; adb's would come before).
  sleep(1000);
  // Typed as key events: in a dev build two R keys within 200 ms inside a modal (where the
  // activity doesn't see a focused text field) reload the app. One R per chunk, then a pause.
  for (const chunk of text.match(/[^rR]*[rR]?/g).filter(Boolean)) {
    const escaped = chunk.replace(/[()<>|;&*~"'`$!?[\]{}#\\]/g, '\\$&').replaceAll(' ', '%s');
    spawnSync(ADB, ['-s', DEVICE, 'shell', `input text ${escaped}`], { stdio: 'inherit' });
    sleep(300);
  }
}

let part = 0;
function run(segment) {
  if (segment.length === 0) return;
  part += 1;
  const name = String(part).padStart(2, '0');
  const file = join(out, `part${name}.yaml`);
  writeFileSync(
    file,
    `appId: dev.alperkayan.kovan\n---\n${segment.map((i) => i.join('\n')).join('\n')}\n`,
  );
  const r = spawnSync(
    MAESTRO,
    ['--device', DEVICE, 'test', file, '--test-output-dir', join(out, `debug${name}`)],
    { encoding: 'utf8' },
  );
  console.log((r.stdout ?? '').split('\n').slice(2).join('\n').trim());
  if (r.status !== 0) {
    console.log(`FAILED in part ${part}`);
    process.exit(1);
  }
}

let segment = [];
for (const item of items) {
  const input = item.length === 1 ? /^- inputText: (.*)$/.exec(item[0]) : null;
  if (!input) {
    segment.push(item.map(fill));
    continue;
  }
  run(segment);
  segment = [];
  const text = fill(unquote(input[1]));
  console.log(`  adb input text ${JSON.stringify(text.slice(0, 60))}…`);
  type(text);
}
run(segment);
console.log('FLOW PASSED');
