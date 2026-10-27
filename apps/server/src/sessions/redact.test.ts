import { describe, expect, it } from 'vitest';
import { redact, redactText } from './redact.js';

describe('redactText', () => {
  it('removes keys and tokens agents tend to print', () => {
    const samples = [
      'OPENROUTER_API_KEY=sk-or-v1-0123456789abcdef0123456789abcdef',
      'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'aws AKIAABCDEFGHIJKLMNOP here',
      'stripe sk_live_abcdefghijklmnop1234',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlLXZhbHVl',
      'kovan kvn_abcdefghijklmnopqrstuvwx',
    ];
    for (const s of samples) {
      const out = redactText(s);
      expect(out).toContain('[redacted]');
      expect(out).not.toMatch(
        /0123456789abcdef0123|abcdefghijklmnopqrstuvwxyz0123|AKIAABCD|eyJzdWIi/,
      );
    }
  });

  it('keeps the name of an assignment and drops its value', () => {
    expect(redactText('DB_PASSWORD="hunter2hunter2"')).toBe('DB_PASSWORD="[redacted]"');
    expect(redactText('Authorization: Bearer abc.def.ghi-123456')).toBe(
      'Authorization: Bearer [redacted]',
    );
    expect(redactText('postgres://kovan:s3cretpass@localhost:5433/db')).toBe(
      'postgres://kovan:[redacted]@localhost:5433/db',
    );
  });

  it('removes private key blocks', () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3Nza\n-----END OPENSSH PRIVATE KEY-----';
    expect(redactText(`key:\n${key}\nend`)).toBe('key:\n[redacted]\nend');
  });

  it('leaves ordinary code alone', () => {
    const code = 'export function add(a: number, b: number) {\n  return a + b; // token count\n}';
    expect(redactText(code)).toBe(code);
    expect(redactText('const tokens = countTokens(text);')).toBe(
      'const tokens = countTokens(text);',
    );
    expect(redactText('const password = form.get("password");')).toBe(
      'const password = form.get("password");',
    );
    expect(redactText('{"password": "correct-horse-battery"}')).toBe('{"password": "[redacted]"}');
  });
});

describe('redact', () => {
  it('walks events', () => {
    const event = {
      type: 'tool_end',
      ok: true,
      output: 'export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      meta: { lines: [1, 2] },
    };
    expect(redact(event)).toEqual({
      type: 'tool_end',
      ok: true,
      output: 'export GITHUB_TOKEN=[redacted]',
      meta: { lines: [1, 2] },
    });
  });
});
