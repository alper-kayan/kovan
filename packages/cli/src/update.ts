import { createHash } from 'node:crypto';
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
 * Code fetched over the network is code run on this machine, so: the address must be on the same origin as the server he signed in to or
 * configured, the bytes must match the manifest's hash, the old file is kept as `.old`, and `KOVAN_NO_UPDATE=1` turns the whole thing off.
 */
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

export async function fetchManifest(
  server: string,
  fetchImpl: typeof fetch,
): Promise<Manifest | null> {
  try {
    const res = await fetchImpl(manifestUrl(server), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const m = (await res.json()) as Partial<Manifest>;
    return typeof m.version === 'string' &&
      typeof m.url === 'string' &&
      typeof m.sha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(m.sha256)
      ? (m as Manifest)
      : null;
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
  env?: Record<string, string | undefined>;
}

export async function checkAndUpdate(d: UpdateDeps): Promise<UpdateResult> {
  const env = d.env ?? process.env;
  if (env['KOVAN_NO_UPDATE'] === '1') return { status: 'skipped', why: 'KOVAN_NO_UPDATE=1' };
  const now = (d.now ?? Date.now)();
  if (!d.force) {
    try {
      const { checkedAt } = JSON.parse(readFileSync(d.stampFile, 'utf8')) as { checkedAt: number };
      if (now - checkedAt < CHECK_EVERY_MS)
        return { status: 'skipped', why: 'yakın zamanda bakıldı' };
    } catch {
      /* never looked */
    }
  }

  const manifest = await fetchManifest(d.server, d.fetchImpl);
  try {
    mkdirSync(dirname(d.stampFile), { recursive: true });
    writeFileSync(d.stampFile, JSON.stringify({ checkedAt: now }));
  } catch {
    /* the stamp is a courtesy */
  }
  if (!manifest) return { status: 'failed', why: 'güncelleme bilgisi alınamadı' };
  if (!isNewer(manifest.version, d.current)) return { status: 'current' };
  if (!d.target) return { status: 'available', version: manifest.version };

  let url: URL;
  try {
    url = new URL(manifest.url, manifestUrl(d.server));
  } catch {
    return { status: 'failed', why: 'güncelleme adresi geçersiz' };
  }
  if (url.origin !== new URL(d.server).origin)
    return { status: 'failed', why: 'güncelleme başka bir adresten geliyor, indirilmedi' };

  let bytes: Buffer;
  try {
    const res = await d.fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return { status: 'failed', why: `indirilemedi (HTTP ${res.status})` };
    bytes = Buffer.from(await res.arrayBuffer());
  } catch {
    return { status: 'failed', why: 'indirilemedi' };
  }
  if (createHash('sha256').update(bytes).digest('hex') !== manifest.sha256)
    return { status: 'failed', why: 'indirilen dosya manifestteki özetle tutmuyor, kullanılmadı' };

  const fresh = `${d.target}.new`;
  const old = `${d.target}.old`;
  try {
    writeFileSync(fresh, bytes, { mode: 0o755 });
    chmodSync(fresh, 0o755);
    if (existsSync(d.target)) renameSync(d.target, old);
    try {
      renameSync(fresh, d.target);
    } catch (error) {
      if (existsSync(old)) renameSync(old, d.target); // never leave him without a working kovan
      throw error;
    }
  } catch {
    rmSync(fresh, { force: true });
    return { status: 'failed', why: 'dosya değiştirilemedi' };
  }
  return { status: 'updated', from: d.current, to: manifest.version };
}
