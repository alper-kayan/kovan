import { createSign } from 'node:crypto';
import type { SendResult } from './apns.js';

/** The fields of a Firebase service account key this needs. */
export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri: string;
}

export interface FcmOptions {
  account: ServiceAccount;
  /** Firebase's API; tests point it at a local server. */
  api?: string;
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/**
 * Sends to Firebase Cloud Messaging directly (HTTP v1). A short-lived OAuth token is made from
 * the service account and reused until shortly before it expires.
 */
export class Fcm {
  private access: { token: string; until: number } | null = null;

  constructor(private readonly options: FcmOptions) {}

  private async accessToken(): Promise<string> {
    if (this.access && Date.now() < this.access.until) return this.access.token;
    const { account } = this.options;
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
      iss: account.client_email,
      scope: SCOPE,
      aud: account.token_uri,
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = createSign('RSA-SHA256')
      .update(unsigned)
      .sign(account.private_key, 'base64url');
    const res = await fetch(account.token_uri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!res.ok || !body.access_token)
      throw new Error(`Firebase sign-in failed: ${body.error ?? `HTTP ${res.status}`}`);
    this.access = {
      token: body.access_token,
      until: Date.now() + ((body.expires_in ?? 3600) - 300) * 1000,
    };
    return this.access.token;
  }

  /** A data message (the app draws it, with its buttons) to one device. */
  async send(token: string, data: Record<string, string>, ttlSeconds = 3600): Promise<SendResult> {
    let access: string;
    try {
      access = await this.accessToken();
    } catch (error) {
      return { ok: false, gone: false, reason: (error as Error).message };
    }
    const api = this.options.api ?? 'https://fcm.googleapis.com';
    let res: Response;
    try {
      res = await fetch(`${api}/v1/projects/${this.options.account.project_id}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: { token, data, android: { priority: 'high', ttl: `${ttlSeconds}s` } },
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      return { ok: false, gone: false, reason: (error as Error).message };
    }
    if (res.ok) return { ok: true };
    if (res.status === 401) this.access = null;
    const body = (await res.json().catch(() => ({}))) as {
      error?: { status?: string; details?: { errorCode?: string }[] };
    };
    const code =
      body.error?.details?.find((d) => d.errorCode)?.errorCode ??
      body.error?.status ??
      `HTTP ${res.status}`;
    // The app was uninstalled or the token expired. (INVALID_ARGUMENT can also mean a bad
    // message, so it doesn't drop the device: a bug here must not unregister every phone.)
    return { ok: false, gone: code === 'UNREGISTERED' || res.status === 404, reason: code };
  }
}
