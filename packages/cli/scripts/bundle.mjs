#!/usr/bin/env node
/**
 * Builds `kovan` as one file, the form that can update itself.
 *
 *   pnpm --filter @kovan/cli bundle              dist-bundle/kovan.mjs and dist-bundle/latest.json
 *   pnpm --filter @kovan/cli bundle --install    ...and put the bundle at ~/.kovan/cli/kovan.mjs (the old one is kept as .old)
 *
 * Publishing is copying `dist-bundle/*` to the server's releases folder under `cli/` (the desktop's updates are served from
 * `<releases>/`, at `/updates/`), e.g.  rsync -av dist-bundle/ root@kovan-host:/srv/kovan/releases/cli/
 * From then on every installed `kovan` finds `latest.json`, checks the hash, and replaces itself.
 *
 * The harness and the model gateway are workspace packages that are compiled first (`pnpm -r build`), so they are bundled in from their `dist/`.
 */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const outDir = join(root, 'dist-bundle');
const outFile = join(outDir, 'kovan.mjs');

mkdirSync(outDir, { recursive: true });
await build({
  entryPoints: [join(root, 'src', 'index.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // The entry already starts with a shebang; the banner only gives bundled CommonJS code the `require` it expects.
  banner: {
    js: 'import { createRequire as __kovanRequire } from "node:module"; const require = __kovanRequire(import.meta.url);',
  },
  logLevel: 'warning',
});
chmodSync(outFile, 0o755);

const sha256 = createHash('sha256').update(readFileSync(outFile)).digest('hex');
writeFileSync(
  join(outDir, 'latest.json'),
  `${JSON.stringify({ version: pkg.version, url: 'kovan.mjs', sha256, builtAt: new Date().toISOString() }, null, 2)}\n`,
);
console.log(`kovan ${pkg.version}  ${outFile}  sha256 ${sha256.slice(0, 12)}…`);

if (process.argv.includes('--install')) {
  const dir = join(homedir(), '.kovan', 'cli');
  const target = join(dir, 'kovan.mjs');
  mkdirSync(dir, { recursive: true });
  if (existsSync(target)) renameSync(target, `${target}.old`);
  copyFileSync(outFile, target);
  chmodSync(target, 0o755);
  console.log(`kuruldu: ${target} (kendini güncelleyebilir)`);
}
