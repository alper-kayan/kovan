import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Encryptor, randomToken, sha256 } from './crypto.js';

const key = () => randomBytes(32).toString('base64');

describe('Encryptor', () => {
  it('round-trips and never repeats ciphertext', () => {
    const enc = new Encryptor(`1:${key()}`);
    const a = enc.encrypt('gho_secret');
    expect(enc.decrypt(a)).toBe('gho_secret');
    expect(enc.encrypt('gho_secret')).not.toBe(a);
  });

  it('encrypts with the newest key and still decrypts old payloads after rotation', () => {
    const k1 = key();
    const old = new Encryptor(`1:${k1}`).encrypt('before rotation');
    const rotated = new Encryptor(`1:${k1},2:${key()}`);
    expect(rotated.decrypt(old)).toBe('before rotation');
    expect(rotated.encrypt('after').startsWith('v2:')).toBe(true);
  });

  it('rejects tampering and unknown keys', () => {
    const enc = new Encryptor(`1:${key()}`);
    const payload = enc.encrypt('some secret');
    const parts = payload.split(':');
    const data = Buffer.from(parts[3]!, 'base64url');
    data[0] = data[0]! ^ 1;
    const tampered = [...parts.slice(0, 3), data.toString('base64url')].join(':');
    expect(() => enc.decrypt(tampered)).toThrow();
    expect(() => new Encryptor(`1:${key()}`).decrypt(payload)).toThrow();
  });

  it('validates key configuration', () => {
    expect(() => new Encryptor('')).toThrow();
    expect(() => new Encryptor('1:short')).toThrow('32 bytes');
  });
});

describe('tokens', () => {
  it('hashes deterministically and generates unique tokens', () => {
    expect(sha256('a')).toBe(sha256('a'));
    expect(randomToken()).not.toBe(randomToken());
  });
});
