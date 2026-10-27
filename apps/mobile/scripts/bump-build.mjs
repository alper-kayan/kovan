// Every upload to App Store Connect and Play needs a build number it hasn't seen. This raises
// the iOS build number and the Android version code together in app.json; with --version it
// also sets the version people see (and starts the build numbers over at 1 for iOS).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const path = join(import.meta.dirname, '..', 'app.json');
const app = JSON.parse(readFileSync(path, 'utf8'));
const expo = app.expo;
const at = process.argv.indexOf('--version');
const version = at === -1 ? null : process.argv[at + 1];
if (at !== -1 && !/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('Usage: node scripts/bump-build.mjs [--version 1.2.3]');
  process.exit(1);
}
if (version) expo.version = version;
// Android's version code only ever goes up, across versions too.
expo.android.versionCode = (expo.android.versionCode ?? 0) + 1;
expo.ios.buildNumber = version ? '1' : String(Number(expo.ios.buildNumber ?? '0') + 1);
writeFileSync(path, `${JSON.stringify(app, null, 2)}\n`);
console.log(
  `Kovan ${expo.version}: iOS build ${expo.ios.buildNumber}, Android version code ${expo.android.versionCode}`,
);
