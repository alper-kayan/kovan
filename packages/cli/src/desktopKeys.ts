import { execFile } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The providers you added in the desktop app (DeepInfra, Ollama, …). Their addresses and model lists sit in `custom-providers.json`, in the
 * clear; their keys are in `custom-provider-keys.bin`, encrypted by Electron with the key the app keeps in the macOS keychain
 * ("Kovan Safe Storage") or, on Windows, in its `Local State` sealed with DPAPI. Listing the models needs no key. On macOS using one asks the keychain for that item, so macOS asks you once to allow
 * it (Always Allow makes it silent); on Windows DPAPI opens it for the same user without asking. The key is held in memory for the session only and is never written anywhere or printed.
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
        if (error) reject(new Error("Couldn't read the keychain (was access denied?)"));
        else resolve(stdout.trim());
      },
    ),
  );
}

/** Chromium's `v10` format on macOS: AES-128-CBC, key = PBKDF2-SHA1(secret, "saltysalt", 1003), IV of 16 spaces. */
export function decryptSafeStorage(data: Buffer, secret: string): string {
  if (data.subarray(0, 3).toString() !== 'v10') throw new Error('Unknown encryption format');
  const key = pbkdf2Sync(secret, 'saltysalt', 1003, 16, 'sha1');
  const d = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  return Buffer.concat([d.update(data.subarray(3)), d.final()]).toString('utf8');
}

/**
 * Windows: Chromium keeps a random AES-256 key in the app's `Local State`, sealed with DPAPI for this Windows user, and seals each
 * value as `v10` + a 12-byte nonce + AES-256-GCM ciphertext + its 16-byte tag.
 */
export function decryptWindows(data: Buffer, key: Buffer): string {
  if (data.subarray(0, 3).toString() !== 'v10' || data.length < 3 + 12 + 16)
    throw new Error('Unknown encryption format');
  const d = createDecipheriv('aes-256-gcm', key, data.subarray(3, 15));
  d.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([d.update(data.subarray(15, data.length - 16)), d.final()]).toString('utf8');
}

/** The AES key from `Local State`, unsealed by DPAPI as the Windows user running this. */
export async function windowsKey(
  dataDir: string,
  unprotect: (sealed: Buffer) => Promise<Buffer> = dpapiUnprotect,
): Promise<Buffer> {
  let sealed: Buffer;
  try {
    const state = JSON.parse(readFileSync(join(dataDir, 'Local State'), 'utf8')) as {
      os_crypt?: { encrypted_key?: string };
    };
    sealed = Buffer.from(state.os_crypt?.encrypted_key ?? '', 'base64');
  } catch {
    throw new Error("Couldn't read the desktop app's key store (Local State)");
  }
  if (sealed.subarray(0, 5).toString() !== 'DPAPI') throw new Error('Unknown encryption format');
  return unprotect(sealed.subarray(5));
}

/**
 * DPAPI's CryptUnprotectData for the current user, through PowerShell's own .NET (no native module). The script goes as an encoded
 * command and the sealed bytes through stdin, so nothing secret is on a command line.
 */
export function dpapiUnprotect(sealed: Buffer): Promise<Buffer> {
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$in = [Console]::In.ReadToEnd().Trim()',
    "$out = [System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in), $null, 'CurrentUser')",
    '[Console]::Out.Write([Convert]::ToBase64String($out))',
  ].join('; ');
  return new Promise((resolve, reject) => {
    const child = execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { timeout: 60_000, windowsHide: true },
      (error, stdout) => {
        const out = Buffer.from(String(stdout).trim(), 'base64');
        if (error || out.length !== 32)
          reject(
            new Error("Couldn't unlock the desktop app's keys (is this the same Windows user?)"),
          );
        else resolve(out);
      },
    );
    child.stdin?.end(sealed.toString('base64'));
  });
}

/** How the desktop app's keys are opened on this machine; tests hand in their own. */
export interface KeyReaders {
  /** macOS: the keychain's secret for "Kovan Safe Storage". */
  keychain?: () => Promise<string>;
  /** Windows: DPAPI for this user. */
  unprotect?: (sealed: Buffer) => Promise<Buffer>;
}

/** One provider's key. On macOS the keychain is asked on first use; on Windows DPAPI opens it for this user. */
export async function providerKey(
  dataDir: string,
  id: string,
  platform: string = process.platform,
  readers: KeyReaders = {},
): Promise<string> {
  if (platform !== 'darwin' && platform !== 'win32')
    throw new Error(
      'Keys of providers added in the desktop app can be read on macOS and Windows. Here, use the provider with KOVAN_BASE_URL, KOVAN_API_KEY and KOVAN_MODEL.',
    );
  let raw: Buffer;
  try {
    raw = readFileSync(join(dataDir, 'custom-provider-keys.bin'));
  } catch {
    throw new Error('The desktop app has no saved keys');
  }
  const json =
    platform === 'win32'
      ? decryptWindows(raw, await windowsKey(dataDir, readers.unprotect))
      : decryptSafeStorage(raw, await (readers.keychain ?? keychainSecret)());
  const keys = JSON.parse(json) as Record<string, string>;
  const key = keys[id];
  if (!key) throw new Error('The desktop app has no key saved for this provider');
  return key;
}
