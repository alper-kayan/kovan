import { execFile } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The providers he added in the desktop app (DeepInfra, Ollama, …). Their addresses and model lists sit in `custom-providers.json`, in the
 * clear; their keys are in `custom-provider-keys.bin`, encrypted by Electron with the key the app keeps in the macOS keychain
 * ("Kovan Safe Storage"). Listing the models needs no key. Using one asks the keychain for that item, so macOS asks him once to allow it
 * (Always Allow makes it silent). The key is held in memory for the session only and is never written anywhere or printed.
 */
export interface DesktopProvider {
  id: string;
  name: string;
  baseUrl: string;
  /** The server's own ids, as the app saved them (without the `@id/` prefix). */
  models: string[];
}

export function desktopProviders(dataDir: string): DesktopProvider[] {
  try {
    const list = JSON.parse(readFileSync(join(dataDir, 'custom-providers.json'), 'utf8')) as {
      id?: unknown;
      name?: unknown;
      baseUrl?: unknown;
      models?: { id?: unknown }[];
    }[];
    const out: DesktopProvider[] = [];
    for (const p of list) {
      if (typeof p.id !== 'string' || typeof p.name !== 'string' || typeof p.baseUrl !== 'string')
        continue;
      const prefix = `@${p.id}/`;
      const models = (p.models ?? [])
        .map((m) => (typeof m.id === 'string' ? m.id : ''))
        .filter(Boolean)
        .map((id) => (id.startsWith(prefix) ? id.slice(prefix.length) : id));
      out.push({ id: p.id, name: p.name, baseUrl: p.baseUrl, models });
    }
    return out;
  } catch {
    return [];
  }
}

/** The secret Electron's safeStorage encrypts with, from the keychain. */
export function keychainSecret(
  service = 'Kovan Safe Storage',
  account = 'Kovan Key',
): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      'security',
      ['find-generic-password', '-w', '-s', service, '-a', account],
      { timeout: 60_000 },
      (error, stdout) => {
        if (error) reject(new Error('anahtar zincirine erişilemedi (izin verilmedi mi?)'));
        else resolve(stdout.trim());
      },
    ),
  );
}

/** Chromium's `v10` format on macOS: AES-128-CBC, key = PBKDF2-SHA1(secret, "saltysalt", 1003), IV of 16 spaces. */
export function decryptSafeStorage(data: Buffer, secret: string): string {
  if (data.subarray(0, 3).toString() !== 'v10') throw new Error('bilinmeyen şifreleme biçimi');
  const key = pbkdf2Sync(secret, 'saltysalt', 1003, 16, 'sha1');
  const d = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  return Buffer.concat([d.update(data.subarray(3)), d.final()]).toString('utf8');
}

/** One provider's key. Asks the keychain on first use. */
export async function providerKey(
  dataDir: string,
  id: string,
  secret: () => Promise<string> = keychainSecret,
): Promise<string> {
  let raw: Buffer;
  try {
    raw = readFileSync(join(dataDir, 'custom-provider-keys.bin'));
  } catch {
    throw new Error('masaüstünde bu sağlayıcı için kayıtlı anahtar yok');
  }
  const keys = JSON.parse(decryptSafeStorage(raw, await secret())) as Record<string, string>;
  const key = keys[id];
  if (!key) throw new Error('bu sağlayıcının anahtarı masaüstünde kayıtlı değil');
  return key;
}
