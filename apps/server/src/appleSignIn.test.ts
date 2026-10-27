import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identities } from './db/schema.js';
import { auth, oauthLogin, startHarness, type Harness } from './test/harness.js';

const BUNDLE = 'dev.alperkayan.kovan';

// Apple's side: its signing keys, and our "Sign in with Apple" key it checks client secrets with.
const appleKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const strangerKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ourKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });

let apple: Server;
let host = '';
let dir: string;
let h: Harness;
const seen: { path: string; form: URLSearchParams; secretOk: boolean }[] = [];

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

function idToken(claims: Record<string, unknown>, key: KeyObject = appleKey.privateKey): string {
  const unsigned = `${b64({ alg: 'RS256', kid: 'apple-1' })}.${b64({
    iss: host,
    aud: BUNDLE,
    exp: Math.floor(Date.now() / 1000) + 600,
    iat: Math.floor(Date.now() / 1000),
    ...claims,
  })}`;
  return `${unsigned}.${sign('sha256', Buffer.from(unsigned), key).toString('base64url')}`;
}

/** Checks the client secret the way Apple does: our key, our team, our app. */
function secretOk(secret: string | null): boolean {
  const [h, p, s] = (secret ?? '').split('.');
  if (!h || !p || !s) return false;
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>;
  const head = JSON.parse(Buffer.from(h, 'base64url').toString()) as Record<string, unknown>;
  return (
    head['kid'] === 'KEY123' &&
    claims['iss'] === 'TEAM123' &&
    claims['sub'] === BUNDLE &&
    verify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      { key: ourKey.publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(s, 'base64url'),
    )
  );
}

beforeAll(async () => {
  apple = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.url === '/auth/keys') {
        const jwk = appleKey.publicKey.export({ format: 'jwk' });
        res.setHeader('content-type', 'application/json');
        return res.end(
          JSON.stringify({ keys: [{ ...jwk, kid: 'apple-1', alg: 'RS256', use: 'sig' }] }),
        );
      }
      const form = new URLSearchParams(raw);
      const ok = secretOk(form.get('client_secret'));
      seen.push({ path: req.url ?? '', form, secretOk: ok });
      res.setHeader('content-type', 'application/json');
      if (!ok) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'invalid_client' }));
      }
      if (req.url === '/auth/token')
        return res.end(JSON.stringify({ refresh_token: `r_${form.get('code')}`, id_token: 'x' }));
      if (req.url === '/auth/revoke') return res.end('');
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((r) => apple.listen(0, '127.0.0.1', () => r()));
  const address = apple.address();
  host = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  dir = mkdtempSync(join(tmpdir(), 'kovan-apple-'));
  writeFileSync(
    join(dir, 'key.p8'),
    ourKey.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
  );
  h = await startHarness({
    APPLE_ID_HOST: host,
    APPLE_SIGNIN_KEY_FILE: join(dir, 'key.p8'),
    APPLE_SIGNIN_KEY_ID: 'KEY123',
    APPLE_TEAM_ID: 'TEAM123',
  });
});
afterAll(async () => {
  await h.close();
  apple.close();
  rmSync(dir, { recursive: true, force: true });
});

/** What the phone sends: Apple's token for the hash of a fresh nonce, and the nonce. */
function phone(claims: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const nonce = randomBytes(16).toString('hex');
  return {
    identityToken: idToken({ nonce: sha256hex(nonce), ...claims }),
    authorizationCode: `code-${randomBytes(4).toString('hex')}`,
    nonce,
    ...extra,
  };
}
const post = (payload: object) => h.app.inject({ method: 'POST', url: '/auth/apple', payload });

describe('Sign in with Apple from the phone', () => {
  it('signs a new person in, named as Apple says the first time, and keeps the token to revoke', async () => {
    const body = phone(
      { sub: 'apple-ada', email: 'ada@privaterelay.appleid.com', email_verified: 'true' },
      { name: { givenName: 'Ada', familyName: 'Lovelace' } },
    );
    const res = await post(body);
    expect(res.statusCode).toBe(200);
    const { token, user } = res.json() as { token: string; user: { id: string; name: string } };
    expect(user.name).toBe('Ada Lovelace');
    const me = await h.app.inject({ method: 'GET', url: '/api/me', headers: auth(token) });
    expect(me.json().user.email).toBe('ada@privaterelay.appleid.com');
    expect(me.json().user.emailVerified).toBe(true);
    // The code went to Apple with our signed client secret.
    expect(seen.at(-1)).toMatchObject({ path: '/auth/token', secretOk: true });
    expect(seen.at(-1)!.form.get('code')).toBe(body.authorizationCode);
    const [row] = await h.ctx.db
      .select()
      .from(identities)
      .where(eq(identities.providerUserId, 'apple-ada'));
    expect(row!.provider).toBe('apple');
    expect(h.ctx.enc.decrypt(row!.accessTokenEnc!)).toBe(`r_${body.authorizationCode}`);

    // Next time Apple gives no name: same account, same name.
    const again = await post(phone({ sub: 'apple-ada', email: 'ada@privaterelay.appleid.com' }));
    expect((again.json() as { user: { id: string; name: string } }).user).toMatchObject({
      id: user.id,
      name: 'Ada Lovelace',
    });
  });

  it('links to the account that already has the same verified email', async () => {
    const existing = await oauthLogin(h, 'github', 'grace', {
      name: 'Grace',
      email: 'grace@kovan.test',
      emailVerified: true,
      login: 'grace',
    });
    const res = await post(
      phone({ sub: 'apple-grace', email: 'grace@kovan.test', email_verified: true }),
    );
    expect((res.json() as { user: { id: string } }).user.id).toBe(existing.user.id);
  });

  it('refuses tokens that are not for us, not fresh, not signed by Apple, or replayed', async () => {
    const claims = { sub: 'apple-eve', email: 'eve@kovan.test', email_verified: true };
    const otherApp = phone({ ...claims, aud: 'com.example.other' });
    const expired = phone({ ...claims, exp: Math.floor(Date.now() / 1000) - 3600 });
    const forged = phone(claims);
    forged.identityToken = idToken(
      { ...claims, nonce: sha256hex(forged.nonce) },
      strangerKey.privateKey,
    );
    // Someone's token, sent with a nonce of their own.
    const replayed = { ...phone(claims), nonce: randomBytes(16).toString('hex') };
    for (const body of [otherApp, expired, forged, replayed]) {
      const res = await post(body);
      expect(res.statusCode).toBe(401);
    }
    expect((await post({ ...phone(claims), identityToken: 'nope' })).statusCode).toBe(400);
  });

  it("revokes the person's Apple sign-in when the account is deleted", async () => {
    const body = phone({ sub: 'apple-del', email: 'del@kovan.test', email_verified: true });
    const { token } = (await post(body)).json() as { token: string };
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/me/delete',
      headers: auth(token),
      payload: { confirm: true },
    });
    expect(res.statusCode).toBe(200);
    const revoke = seen.find((s) => s.path === '/auth/revoke');
    expect(revoke?.secretOk).toBe(true);
    expect(revoke!.form.get('token')).toBe(`r_${body.authorizationCode}`);
    expect(revoke!.form.get('token_type_hint')).toBe('refresh_token');
  });
});
