import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { connect, type ClientHttp2Session } from 'node:http2';

/** How a send went: delivered, or not, and whether the token is dead for good. */
export type SendResult = { ok: true } | { ok: false; gone: boolean; reason: string };

export interface ApnsOptions {
  /** The .p8 key from Apple, PEM. */
  key: string;
  keyId: string;
  teamId: string;
  /** The app's bundle id. */
  topic: string;
  /** Apple's hosts; tests point them at a local HTTP/2 server. */
  production?: string;
  sandbox?: string;
}

export interface ApnsMessage {
  payload: Record<string, unknown>;
  /** Replaces an earlier notification with the same id on the phone (max 64 bytes). */
  collapseId?: string;
  /** Seconds after which Apple stops trying to deliver it. */
  ttl?: number;
}

/** Apple says these when the device token will never work again. */
const GONE = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);
/** Apple wants a provider token renewed at most every 20 minutes and accepts it for an hour. */
const TOKEN_MS = 45 * 60_000;

/**
 * Sends to Apple's push service directly (HTTP/2, token auth). One connection per host is kept
 * open, as Apple asks, and the signed provider token is reused until it is due.
 */
export class Apns {
  private readonly key: KeyObject;
  private jwt: { token: string; at: number } | null = null;
  private readonly sessions = new Map<string, ClientHttp2Session>();

  constructor(private readonly options: ApnsOptions) {
    this.key = createPrivateKey(options.key);
  }

  private providerToken(fresh = false): string {
    if (!fresh && this.jwt && Date.now() - this.jwt.at < TOKEN_MS) return this.jwt.token;
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'ES256', kid: this.options.keyId })}.${b64({
      iss: this.options.teamId,
      iat: Math.floor(Date.now() / 1000),
    })}`;
    const signature = sign('sha256', Buffer.from(unsigned), {
      key: this.key,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    this.jwt = { token: `${unsigned}.${signature}`, at: Date.now() };
    return this.jwt.token;
  }

  private session(host: string): ClientHttp2Session {
    const open = this.sessions.get(host);
    if (open && !open.closed && !open.destroyed) return open;
    const session = connect(host);
    session.on('error', () => this.sessions.delete(host));
    session.on('close', () => this.sessions.delete(host));
    // Idle for a while: let it go, the next send opens a new one.
    session.setTimeout(10 * 60_000, () => session.close());
    session.unref();
    this.sessions.set(host, session);
    return session;
  }

  async send(token: string, sandbox: boolean, message: ApnsMessage): Promise<SendResult> {
    const first = await this.post(token, sandbox, message, false);
    // A provider token Apple calls expired is made again once.
    if (!first.ok && first.reason === 'ExpiredProviderToken')
      return this.post(token, sandbox, message, true);
    return first;
  }

  private post(
    token: string,
    sandbox: boolean,
    message: ApnsMessage,
    freshToken: boolean,
  ): Promise<SendResult> {
    const host = sandbox
      ? (this.options.sandbox ?? 'https://api.sandbox.push.apple.com')
      : (this.options.production ?? 'https://api.push.apple.com');
    return new Promise((resolve) => {
      let request;
      try {
        request = this.session(host).request({
          ':method': 'POST',
          ':path': `/3/device/${encodeURIComponent(token)}`,
          authorization: `bearer ${this.providerToken(freshToken)}`,
          'apns-topic': this.options.topic,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-expiration': String(Math.floor(Date.now() / 1000) + (message.ttl ?? 3600)),
          ...(message.collapseId ? { 'apns-collapse-id': message.collapseId.slice(0, 64) } : {}),
        });
      } catch (error) {
        resolve({ ok: false, gone: false, reason: String(error) });
        return;
      }
      let status = 0;
      let body = '';
      request.setTimeout(15_000, () => request.close());
      request.on('response', (headers) => (status = Number(headers[':status'])));
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('error', (error) => resolve({ ok: false, gone: false, reason: error.message }));
      request.on('close', () => {
        if (status === 200) return resolve({ ok: true });
        let reason = `HTTP ${status || 'no answer'}`;
        try {
          reason = (JSON.parse(body) as { reason?: string }).reason ?? reason;
        } catch {
          // Not JSON: keep the status.
        }
        resolve({ ok: false, gone: status === 410 || GONE.has(reason), reason });
      });
      request.end(JSON.stringify(message.payload));
    });
  }

  close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}
