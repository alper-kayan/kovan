import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * App-side encryption for secrets at rest (GitHub tokens, pending session tokens).
 * Format: "v<keyId>:<iv>:<tag>:<ciphertext>", all base64url. The highest key id encrypts;
 * every configured key can decrypt, so keys rotate without re-encrypting everything at once.
 */
export class Encryptor {
  private readonly keys = new Map<number, Buffer>();
  private readonly currentId: number;

  constructor(spec: string) {
    for (const part of spec
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)) {
      const [idText, keyText] = part.split(':');
      const id = Number(idText);
      const key = Buffer.from(keyText ?? '', 'base64');
      if (!Number.isInteger(id) || id < 1) throw new Error(`Bad encryption key id: ${idText}`);
      if (key.length !== 32) throw new Error(`Encryption key ${id} must be 32 bytes`);
      this.keys.set(id, key);
    }
    if (this.keys.size === 0) throw new Error('No encryption keys configured');
    this.currentId = Math.max(...this.keys.keys());
  }

  /** A throwaway key for development and tests, when ENCRYPTION_KEYS is empty. */
  static ephemeral(): Encryptor {
    return new Encryptor(`1:${randomBytes(32).toString('base64')}`);
  }

  encrypt(plaintext: string): string {
    const key = this.keys.get(this.currentId)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v' + this.currentId, iv, tag, data]
      .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
      .join(':');
  }

  decrypt(payload: string): string {
    const [version, iv, tag, data] = payload.split(':');
    const key = this.keys.get(Number(version?.slice(1)));
    if (!key || !iv || !tag || data === undefined)
      throw new Error('Cannot decrypt: unknown key or bad payload');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(data, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}

/** A random, URL-safe secret. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
