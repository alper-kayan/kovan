import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Config } from '../config.js';

/**
 * Sign in with Apple from the iPhone app. The phone gets an identity token from Apple and hands
 * it over; the server checks it against Apple's public keys (no key of ours is needed for that).
 * With our "Sign in with Apple" key the server also trades the one-time code for a refresh token,
 * which is what Apple wants revoked when the account is deleted.
 */

export interface AppleIdentity {
  /** Apple's stable id for this person in our team's apps. */
  sub: string;
  email: string | null;
  emailVerified: boolean;
}

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
}

const KEYS_MS = 60 * 60_000;
const SKEW_S = 60;

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
const part = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as unknown;

export class AppleSignIn {
  private keys: { at: number; byKid: Map<string, KeyObject> } | null = null;
  private signingKey: KeyObject | null | undefined;

  constructor(private readonly config: Config) {}

  private get host(): string {
    return this.config.APPLE_ID_HOST.replace(/\/$/, '');
  }

  /** Our key with "Sign in with Apple" on: its own settings, else the push key's. */
  private keySettings() {
    const c = this.config;
    return {
      file: c.APPLE_SIGNIN_KEY_FILE || c.APNS_KEY_FILE,
      keyId: c.APPLE_SIGNIN_KEY_ID || c.APNS_KEY_ID,
      teamId: c.APPLE_TEAM_ID || c.APNS_TEAM_ID,
    };
  }

  private async publicKey(kid: string): Promise<KeyObject | null> {
    const fresh = this.keys && Date.now() - this.keys.at < KEYS_MS;
    // A key we haven't seen may be one Apple just started using.
    if (!fresh || !this.keys!.byKid.has(kid)) {
      const res = await fetch(`${this.host}/auth/keys`);
      if (!res.ok) throw new Error(`Apple's keys didn't load (${res.status})`);
      const { keys } = (await res.json()) as { keys: Jwk[] };
      this.keys = {
        at: Date.now(),
        byKid: new Map(keys.map((k) => [k.kid, createPublicKey({ key: k, format: 'jwk' })])),
      };
    }
    return this.keys!.byKid.get(kid) ?? null;
  }

  /**
   * The person an identity token names, once its signature, issuer, audience, expiry and nonce
   * check out. The phone sends Apple the SHA-256 of a random nonce and us the nonce itself, so a
   * token lifted from somewhere else can't be replayed here.
   */
  async verify(identityToken: string, nonce: string): Promise<AppleIdentity> {
    const fail = (why: string): never => {
      throw new Error(`Apple's sign-in didn't check out: ${why}`);
    };
    const [h, p, s] = identityToken.split('.');
    if (!h || !p || !s) fail('not a token');
    const header = part(h!) as { alg?: string; kid?: string };
    if (header.alg !== 'RS256' || !header.kid) fail('unexpected algorithm');
    const key = await this.publicKey(header.kid!);
    if (!key) fail('unknown key');
    const ok = verify('sha256', Buffer.from(`${h}.${p}`), key!, Buffer.from(s!, 'base64url'));
    if (!ok) fail('bad signature');
    const claims = part(p!) as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);
    if (claims['iss'] !== this.host && claims['iss'] !== 'https://appleid.apple.com')
      fail('wrong issuer');
    const aud = claims['aud'];
    const audiences = Array.isArray(aud) ? aud : [aud];
    if (!audiences.includes(this.config.APNS_TOPIC)) fail('meant for another app');
    if (typeof claims['exp'] !== 'number' || claims['exp'] + SKEW_S < now) fail('expired');
    // Apple puts the value the phone asked with into the token; accept it hashed once more too.
    const hashed = sha256hex(nonce);
    if (claims['nonce'] !== hashed && claims['nonce'] !== sha256hex(hashed)) fail('wrong nonce');
    if (typeof claims['sub'] !== 'string' || !claims['sub']) fail('no subject');
    const email = typeof claims['email'] === 'string' ? claims['email'] : null;
    // Apple writes booleans as strings in some tokens.
    const verified = claims['email_verified'] === true || claims['email_verified'] === 'true';
    return { sub: claims['sub'] as string, email, emailVerified: !!email && verified };
  }

  private async clientSecret(): Promise<string | null> {
    const { file, keyId, teamId } = this.keySettings();
    if (!file || !keyId || !teamId) return null;
    if (this.signingKey === undefined)
      this.signingKey = createPrivateKey(await readFile(file, 'utf8'));
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64({ alg: 'ES256', kid: keyId })}.${b64({
      iss: teamId,
      iat: now,
      exp: now + 300,
      aud: 'https://appleid.apple.com',
      sub: this.config.APNS_TOPIC,
    })}`;
    const signature = sign('sha256', Buffer.from(unsigned), {
      key: this.signingKey!,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    return `${unsigned}.${signature}`;
  }

  /** Whether we hold a key Apple takes for trading codes and revoking. */
  get canRevoke(): boolean {
    const { file, keyId, teamId } = this.keySettings();
    return !!(file && keyId && teamId);
  }

  private async post(path: string, form: Record<string, string>): Promise<Response | null> {
    const secret = await this.clientSecret();
    if (!secret) return null;
    return fetch(`${this.host}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.APNS_TOPIC,
        client_secret: secret,
        ...form,
      }),
    });
  }

  /** Trades the phone's one-time code for a refresh token; null without our key. */
  async refreshToken(authorizationCode: string): Promise<string | null> {
    const res = await this.post('/auth/token', {
      code: authorizationCode,
      grant_type: 'authorization_code',
    });
    if (!res) return null;
    if (!res.ok) throw new Error(`Apple didn't take the sign-in code (${res.status})`);
    const body = (await res.json()) as { refresh_token?: string };
    return body.refresh_token ?? null;
  }

  /** Tells Apple the person's sign-in with us is gone (account deletion). */
  async revoke(refreshToken: string): Promise<void> {
    const res = await this.post('/auth/revoke', {
      token: refreshToken,
      token_type_hint: 'refresh_token',
    });
    if (res && !res.ok) throw new Error(`Apple didn't revoke the sign-in (${res.status})`);
  }
}
