import { createHash, createPublicKey, verify } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname } from 'node:path';

/**
 * `kovan` keeping itself current, the way the desktop app does: the server publishes a small manifest next to the files, and a newer
 * version is fetched, checked against the manifest's SHA-256 and swapped in. Same server, same `/updates` folder as the desktop's releases.
 *
 * Only a single-file bundle (`kovan.mjs`, from `pnpm --filter @kovan/cli bundle --install`) can replace itself. A checkout run from `dist/` is
 * the developer's own build: there it says a newer one exists and leaves the files alone.
 *
 * Code fetched over the network is code run on this machine, so: the manifest must carry a signature (`latest.json.sig`) made with the
 * release key, checked against the public half built into the bundle (KOVAN_UPDATE_PUBLIC_KEY, the desktop's Linux update key); the
 * address must be on the same origin as the server; the bytes must match the manifest's hash; the old file is kept as `.old`; and
 * `KOVAN_NO_UPDATE=1` turns the whole thing off. A bundle built without the public key never replaces itself.
 */
declare const __KOVAN_UPDATE_PUBLIC_KEY__: string | undefined;

/** The public half of the release key (Ed25519, base64 SPKI), set when the bundle was built. */
export const UPDATE_PUBLIC_KEY: string =
  typeof __KOVAN_UPDATE_PUBLIC_KEY__ === 'string' ? __KOVAN_UPDATE_PUBLIC_KEY__ : '';

/** True when `signature` (base64) is the release key's signature over `text`. */
export function verifyManifest(text: string, signature: string, publicKey: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return verify(null, Buffer.from(text), key, Buffer.from(signature.trim(), 'base64'));
  } catch {
    return false;
  }
}

export interface Manifest {
  version: string;
  url: string;
  sha256: string;
}

const CHECK_EVERY_MS = 12 * 3_600_000;

/** "0.10.2" is newer than "0.9.9": compared by number, not by text. */
export function isNewer(candidate: string, current: string): boolean {
  const n = (v: string) => v.split('.').map((p) => Number.parseInt(p, 10) || 0);
  const a = n(candidate);
  const b = n(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/** The running file, when it is a self-contained bundle that may replace itself. */
export function bundlePath(argv1: string | undefined): string | null {
  return argv1 && basename(argv1) === 'kovan.mjs' ? argv1 : null;
}

export function manifestUrl(server: string): string {
  return `${server.replace(/\/$/, '')}/updates/cli/latest.json`;
}

const isManifest = (m: Partial<Manifest>): m is Manifest =>
  typeof m.version === 'string' &&
  typeof m.url === 'string' &&
  typeof m.sha256 === 'string' &&
  /^[0-9a-f]{64}$/.test(m.sha256);

/** The manifest, and its text as served (the signature is over those exact bytes). */
export async function fetchManifest(
  server: string,
  fetchImpl: typeof fetch,
): Promise<{ manifest: Manifest; text: string } | null> {
  try {
    const res = await fetchImpl(manifestUrl(server), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const text = await res.text();
    const m = JSON.parse(text) as Partial<Manifest>;
    return isManifest(m) ? { manifest: m, text } : null;
  } catch {
    return null;
  }
}

async function fetchSignature(server: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(`${manifestUrl(server)}.sig`, {
      signal: AbortSignal.timeout(8000),
    });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

export type UpdateResult =
  | { status: 'current' }
  | { status: 'skipped'; why: string }
  | { status: 'available'; version: string }
  | { status: 'updated'; from: string; to: string }
  | { status: 'failed'; why: string };

export interface UpdateDeps {
  server: string;
  current: string;
  fetchImpl: typeof fetch;
  /** The bundle to replace; null when running from a checkout. */
  target: string | null;
  /** Remembers when it last looked, so starting `kovan` ten times a day asks once. */
  stampFile: string;
  now?: () => number;
  /** `kovan update`: look now, whatever the last time was. */
  force?: boolean;
  /** The release key's public half; without it nothing is installed. Defaults to the one built in. */
  publicKey?: string;
  env?: Record<string, string | undefined>;
}

export async function checkAndUpdate(d: UpdateDeps): Promise<UpdateResult> {
  const env = d.env ?? process.env;
  if (env['KOVAN_NO_UPDATE'] === '1') return { status: 'skipped', why: 'KOVAN_NO_UPDATE=1' };
  const now = (d.now ?? Date.now)();
  if (!d.force) {
    try {
      const { checkedAt } = JSON.parse(readFileSync(d.stampFile, 'utf8')) as { checkedAt: number };
      if (now - checkedAt < CHECK_EVERY_MS) return { status: 'skipped', why: 'checked recently' };
    } catch {
      /* never looked */
    }
  }

  const found = await fetchManifest(d.server, d.fetchImpl);
  try {
    mkdirSync(dirname(d.stampFile), { recursive: true });
    writeFileSync(d.stampFile, JSON.stringify({ checkedAt: now }));
  } catch {
    /* the stamp is a courtesy */
  }
  if (!found) return { status: 'failed', why: "couldn't read the update information" };
  const { manifest, text } = found;
  if (!isNewer(manifest.version, d.current)) return { status: 'current' };
  if (!d.target) return { status: 'available', version: manifest.version };

  const publicKey = d.publicKey ?? UPDATE_PUBLIC_KEY;
  if (!publicKey)
    return {
      status: 'failed',
      why: `${manifest.version} is out, but this copy was built without the release key, so it can't check it. Install the signed one: curl -fsSL https://kovan.alperkayan.dev/install.sh | sh (Windows: irm https://kovan.alperkayan.dev/install.ps1 | iex)`,
    };
  const signature = await fetchSignature(d.server, d.fetchImpl);
  if (!signature || !verifyManifest(text, signature, publicKey))
    return {
      status: 'failed',
      why: "the update isn't signed with the release key, so it was not downloaded",
    };

  let url: URL;
  try {
    url = new URL(manifest.url, manifestUrl(d.server));
  } catch {
    return { status: 'failed', why: 'the update address is invalid' };
  }
  if (url.origin !== new URL(d.server).origin)
    return { status: 'failed', why: 'the update is on another server, so it was not downloaded' };

  let bytes: Buffer;
  try {
    const res = await d.fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return { status: 'failed', why: `couldn't download it (HTTP ${res.status})` };
    bytes = Buffer.from(await res.arrayBuffer());
  } catch {
    return { status: 'failed', why: "couldn't download it" };
  }
  if (createHash('sha256').update(bytes).digest('hex') !== manifest.sha256)
    return {
      status: 'failed',
      why: "the downloaded file doesn't match the manifest's hash, so it was not used",
    };

  const fresh = `${d.target}.new`;
  const old = `${d.target}.old`;
  try {
    writeFileSync(fresh, bytes, { mode: 0o755 });
    chmodSync(fresh, 0o755);
    if (existsSync(d.target)) renameSync(d.target, old);
    try {
      renameSync(fresh, d.target);
    } catch (error) {
      if (existsSync(old)) renameSync(old, d.target); // never leave you without a working kovan
      throw error;
    }
  } catch {
    rmSync(fresh, { force: true });
    return { status: 'failed', why: "couldn't replace the file" };
  }
  return { status: 'updated', from: d.current, to: manifest.version };
}
