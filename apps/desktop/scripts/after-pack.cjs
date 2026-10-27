// node-pty's `spawn-helper` can lose its execute bit on the way into the package (it does under
// pnpm); without it every terminal fails with "posix_spawnp failed".
const { chmodSync, existsSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

function helpers(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) helpers(path, found);
    else if (entry.name === 'spawn-helper') found.push(path);
  }
  return found;
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName === 'win32') return;
  const resources =
    context.electronPlatformName === 'darwin'
      ? join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          'Contents',
          'Resources',
        )
      : join(context.appOutDir, 'resources');
  const unpacked = join(resources, 'app.asar.unpacked');
  if (!existsSync(unpacked)) throw new Error(`node-pty was not unpacked into ${unpacked}`);
  const found = helpers(unpacked);
  if (!found.length) throw new Error('node-pty spawn-helper is missing from the package');
  for (const helper of found) chmodSync(helper, 0o755);
};
