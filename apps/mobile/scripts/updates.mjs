// Publishes the app's JavaScript and assets as an over-the-air update, rolls one back, or shows
// what phones get. Phones only run what this script signed with the private key, which stays
// on this Mac; the server only hands the files out (apps/server/src/mobileUpdates.ts has the
// layout). An update reaches only builds with the same runtime version, which is the app's
// `version`: a change to native code needs a new version and a new store build.
//
//   node scripts/updates.mjs publish [--platform ios|android|all] [--message "…"]
//   node scripts/updates.mjs rollback [--platform …] [--embedded]
//   node scripts/updates.mjs status
//
// Where: KOVAN_UPDATES_TARGET (a folder, or host:folder over ssh; default the production
// server), KOVAN_UPDATES_SERVER (the address phones download from), KOVAN_UPDATES_KEY (the
// private key; default secrets/mobile-updates/private-key.pem).
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID, sign } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const APP = join(import.meta.dirname, '..');
const REPO = join(APP, '..', '..');
const TARGET = process.env.KOVAN_UPDATES_TARGET ?? 'root@31.57.156.109:/srv/kovan/mobile-updates';
const SERVER = (process.env.KOVAN_UPDATES_SERVER ?? 'https://kovan.alperkayan.dev').replace(
  /\/$/,
  '',
);
const KEY = process.env.KOVAN_UPDATES_KEY ?? join(REPO, 'secrets/mobile-updates/private-key.pem');

const args = process.argv.slice(2);
const command = args[0];
const option = (name) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const flag = (name) => args.includes(`--${name}`);

// ---------- where the updates live: a local folder or one on another machine ----------

const remote = /^[^/]+:/.test(TARGET);
const [host, base] = remote
  ? [TARGET.slice(0, TARGET.indexOf(':')), TARGET.slice(TARGET.indexOf(':') + 1)]
  : [null, TARGET];
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;

function readTarget(path) {
  if (!remote) return existsSync(join(base, path)) ? readFileSync(join(base, path), 'utf8') : null;
  try {
    return execFileSync('ssh', [host, `cat ${quote(`${base}/${path}`)}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function listTarget(path) {
  if (!remote) return existsSync(join(base, path)) ? readdirSync(join(base, path)) : [];
  try {
    return execFileSync('ssh', [host, `ls -1 ${quote(`${base}/${path}`)}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Copies a staged folder's contents into the target; the `current` pointers go last. */
function upload(staged) {
  const to = remote ? `${host}:${base}/` : `${base}/`;
  if (!remote) mkdirSync(base, { recursive: true });
  else execFileSync('ssh', [host, `mkdir -p ${quote(base)}`], { stdio: 'inherit' });
  // Each file lands under a temporary name and is renamed into place, so a phone never
  // reads half of one.
  const rsync = (filters) =>
    execFileSync('rsync', ['-rt', '--chmod=D755,F644', ...filters, `${staged}/`, to], {
      stdio: 'inherit',
    });
  rsync(['--exclude', 'current']);
  rsync(['--include', '*/', '--include', 'current', '--exclude', '*']);
}

// ---------- signing ----------

function signer() {
  if (!existsSync(KEY)) {
    console.error(`No signing key at ${KEY} (see deploy/README.md, "Over-the-air updates").`);
    process.exit(1);
  }
  const key = readFileSync(KEY, 'utf8');
  const { keyid } = appConfig().updates.codeSigningMetadata;
  return (body) =>
    `sig="${sign('sha256', Buffer.from(body, 'utf8'), key).toString('base64')}", keyid="${keyid}"`;
}

function appConfig() {
  return JSON.parse(readFileSync(join(APP, 'app.json'), 'utf8')).expo;
}

function runtimeVersion() {
  const expo = appConfig();
  const rv = expo.runtimeVersion;
  if (typeof rv === 'string') return rv;
  if (rv?.policy === 'appVersion') return expo.version;
  console.error(`Runtime version policy ${JSON.stringify(rv)} isn't supported here.`);
  process.exit(1);
}

const platforms = () => {
  const p = option('platform') ?? 'all';
  if (!['ios', 'android', 'all'].includes(p)) {
    console.error('--platform is ios, android or all');
    process.exit(1);
  }
  return p === 'all' ? ['ios', 'android'] : [p];
};

/** Folder names sort by time: 20261025-084512-1a2b3c4d. */
const entryName = (id) =>
  `${new Date()
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 14)
    .replace(/(\d{8})(\d{6})/, '$1-$2')}-${id.slice(0, 8)}`;

function stageNoUpdate(staged, signed) {
  const body = JSON.stringify({ type: 'noUpdateAvailable' });
  writeFileSync(join(staged, 'no-update.json'), body);
  writeFileSync(join(staged, 'no-update.sig'), signed(body));
}

// ---------- publish ----------

const ASSET_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
};

function writeAsset(dir, name, bytes) {
  writeFileSync(join(dir, name), bytes);
  // Phones ask for brotli or gzip; a 6 MB bundle is about a third of that compressed.
  writeFileSync(
    join(dir, `${name}.br`),
    brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }),
  );
  writeFileSync(join(dir, `${name}.gz`), gzipSync(bytes, { level: 9 }));
}

function publish() {
  const signed = signer();
  const runtime = runtimeVersion();
  const targets = platforms();
  const message = option('message') ?? '';
  const work = mkdtempSync(join(tmpdir(), 'kovan-update-'));
  try {
    console.log('Building the packages the app uses…');
    execFileSync('pnpm', ['--filter', '@kovan/mobile^...', 'build'], {
      cwd: REPO,
      stdio: 'inherit',
    });
    const out = join(work, 'export');
    execFileSync(
      'npx',
      ['expo', 'export', ...targets.flatMap((p) => ['--platform', p]), '--output-dir', out],
      { cwd: APP, stdio: 'inherit' },
    );
    const metadata = JSON.parse(readFileSync(join(out, 'metadata.json'), 'utf8'));
    const expoClient = JSON.parse(
      execFileSync('npx', ['expo', 'config', '--type', 'public', '--json'], {
        cwd: APP,
        encoding: 'utf8',
      }),
    );
    const staged = join(work, 'staged');
    mkdirSync(staged, { recursive: true });
    stageNoUpdate(staged, signed);
    const published = [];
    for (const platform of targets) {
      const files = metadata.fileMetadata[platform];
      const id = randomUUID();
      const entry = entryName(id);
      const dir = join(staged, runtime, platform, entry);
      const assetsDir = join(dir, 'assets');
      mkdirSync(assetsDir, { recursive: true });
      const url = (file) =>
        `${SERVER}/api/mobile/updates/assets/${encodeURIComponent(runtime)}/${platform}/${entry}/${file}`;
      const describe = (bytes, file, contentType, ext) => ({
        hash: createHash('sha256').update(bytes).digest('base64url'),
        key: createHash('md5').update(bytes).digest('hex'),
        contentType,
        ...(ext ? { fileExtension: ext } : {}),
        url: url(file),
      });
      const bundle = readFileSync(join(out, files.bundle));
      const bundleFile = `bundle${extname(files.bundle) || '.js'}`;
      writeAsset(assetsDir, bundleFile, bundle);
      const assets = files.assets.map((a) => {
        const bytes = readFileSync(join(out, a.path));
        const ext = `.${a.ext}`;
        const key = createHash('md5').update(bytes).digest('hex');
        writeAsset(assetsDir, `${key}${ext}`, bytes);
        return describe(bytes, `${key}${ext}`, ASSET_TYPES[ext] ?? 'application/octet-stream', ext);
      });
      const manifest = JSON.stringify({
        id,
        createdAt: new Date().toISOString(),
        runtimeVersion: runtime,
        launchAsset: describe(bundle, bundleFile, 'application/javascript'),
        assets,
        metadata: {},
        extra: { expoClient },
      });
      writeFileSync(join(dir, 'manifest.json'), manifest);
      writeFileSync(join(dir, 'signature'), signed(manifest));
      writeFileSync(join(dir, 'info.json'), JSON.stringify({ message, kind: 'update' }));
      writeFileSync(join(staged, runtime, platform, 'current'), `${entry}\n`);
      published.push(`${platform}: ${entry} (${assets.length + 1} files)`);
    }
    upload(staged);
    console.log(`\nPublished for runtime ${runtime}:\n  ${published.join('\n  ')}`);
    console.log('Phones pick it up the next time the app opens or comes back.');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---------- rollback ----------

function entries(runtime, platform) {
  return listTarget(`${runtime}/${platform}`)
    .filter((e) => /^\d{8}-\d{6}-/.test(e))
    .sort();
}

function rollback() {
  const signed = signer();
  const runtime = runtimeVersion();
  const work = mkdtempSync(join(tmpdir(), 'kovan-rollback-'));
  try {
    const staged = join(work, 'staged');
    mkdirSync(staged, { recursive: true });
    stageNoUpdate(staged, signed);
    for (const platform of platforms()) {
      const at = `${runtime}/${platform}`;
      const info = (e) => JSON.parse(readTarget(`${at}/${e}/info.json`) ?? '{}');
      const current = readTarget(`${at}/current`)?.trim() ?? '';
      // What phones run now: a republished update counts as the one it copies.
      const now = current && info(current).kind === 'republish' ? info(current).of : current;
      // The update published before that one (not a rollback, not a copy).
      const before = flag('embedded')
        ? undefined
        : entries(runtime, platform)
            .filter((e) => e < now)
            .slice(-20)
            .reverse()
            .find((e) => info(e).kind === 'update');
      const id = randomUUID();
      const entry = entryName(id);
      const dir = join(staged, runtime, platform, entry);
      mkdirSync(dir, { recursive: true });
      if (before) {
        // A phone runs the newest update it holds, so going back means publishing the old
        // files again as a new update. Its files stay where they are.
        const old = JSON.parse(readTarget(`${runtime}/${platform}/${before}/manifest.json`));
        const manifest = JSON.stringify({ ...old, id, createdAt: new Date().toISOString() });
        writeFileSync(join(dir, 'manifest.json'), manifest);
        writeFileSync(join(dir, 'signature'), signed(manifest));
        writeFileSync(join(dir, 'info.json'), JSON.stringify({ kind: 'republish', of: before }));
        console.log(`${platform}: back to ${before} (as ${entry})`);
      } else {
        const directive = JSON.stringify({
          type: 'rollBackToEmbedded',
          parameters: { commitTime: new Date().toISOString() },
        });
        writeFileSync(join(dir, 'directive.json'), directive);
        writeFileSync(join(dir, 'signature'), signed(directive));
        writeFileSync(join(dir, 'info.json'), JSON.stringify({ kind: 'rollback' }));
        console.log(`${platform}: back to the build's own code (${entry})`);
      }
      writeFileSync(join(staged, runtime, platform, 'current'), `${entry}\n`);
    }
    upload(staged);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---------- status ----------

function status() {
  const runtime = runtimeVersion();
  console.log(`Runtime ${runtime} at ${TARGET}`);
  for (const platform of ['ios', 'android']) {
    const current = readTarget(`${runtime}/${platform}/current`)?.trim();
    const all = entries(runtime, platform);
    console.log(`\n${platform}: ${current ? `phones get ${current}` : 'nothing published'}`);
    for (const e of all.slice(-8)) {
      const info = JSON.parse(readTarget(`${runtime}/${platform}/${e}/info.json`) ?? '{}');
      const what =
        info.kind === 'rollback'
          ? "the build's own code"
          : info.kind === 'republish'
            ? `again ${info.of}`
            : info.message || 'update';
      console.log(`  ${e === current ? '→' : ' '} ${e}  ${what}`);
    }
  }
}

if (command === 'publish') publish();
else if (command === 'rollback') rollback();
else if (command === 'status') status();
else {
  console.error('Usage: node scripts/updates.mjs publish | rollback | status (see the header)');
  process.exit(1);
}
