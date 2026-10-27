// node-pty's prebuilt `spawn-helper` can arrive without its execute bit (it does under pnpm),
// which makes every terminal fail with "posix_spawnp failed". Restore it after install.
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

if (process.platform !== 'win32') {
  const require = createRequire(join(import.meta.dirname, '../apps/desktop/package.json'));
  let root;
  try {
    root = dirname(require.resolve('node-pty/package.json'));
  } catch {
    process.exit(0); // node-pty not installed (yet).
  }
  const prebuilds = join(root, 'prebuilds');
  const helpers = existsSync(prebuilds)
    ? readdirSync(prebuilds).map((dir) => join(prebuilds, dir, 'spawn-helper'))
    : [];
  helpers.push(join(root, 'build', 'Release', 'spawn-helper'));
  for (const helper of helpers) {
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}
