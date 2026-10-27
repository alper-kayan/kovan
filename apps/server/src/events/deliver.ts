import { createHmac } from 'node:crypto';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

/** How long one attempt may take. */
export const DELIVERY_TIMEOUT_MS = 10_000;

/** `sha256=<hex>`: HMAC-SHA256 of the exact body with the webhook's secret. */
export function signature(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** "host:port" as the allowlist names it, with the scheme's default port filled in. */
export function hostPort(url: URL): string {
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return `${url.hostname.toLowerCase().replace(/^\[|\]$/g, '')}:${port}`;
}

/**
 * Addresses a webhook may never reach unless allowlisted: this machine, private networks,
 * link-local (cloud metadata), carrier NAT, multicast and reserved ranges.
 */
export function isPrivateAddress(address: string): boolean {
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/i.exec(address);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = address.toLowerCase();
  return (
    v6 === '::' ||
    v6 === '::1' ||
    /^f[cd]/.test(v6) || // unique local
    /^fe[89ab]/.test(v6) || // link-local
    /^ff/.test(v6) // multicast
  );
}

/** Why this address can't be a webhook target, or null when it can be. */
export function targetProblem(raw: string, allow: readonly string[]): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Not a valid address.';
  }
  if (url.username || url.password) return 'The address must not contain a user name or password.';
  if (allow.includes(hostPort(url))) return null;
  if (url.protocol !== 'https:') return 'Webhooks must use https.';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal'))
    return 'That address is on a private network.';
  if (isIP(host) && isPrivateAddress(host)) return 'That address is on a private network.';
  return null;
}

export interface Outcome {
  ok: boolean;
  code: number | null;
  error: string | null;
}

/**
 * Posts one signed delivery. The address is checked again where it matters, when connecting:
 * a name that resolves to a private address is refused even if it didn't when the webhook was
 * made. Redirects are not followed.
 */
export function deliver(
  target: string,
  allow: readonly string[],
  secret: string,
  delivery: { id: string; type: string; body: string },
): Promise<Outcome> {
  const problem = targetProblem(target, allow);
  if (problem) return Promise.resolve({ ok: false, code: null, error: problem });
  const url = new URL(target);
  const allowed = allow.includes(hostPort(url));
  const lookup = (
    hostname: string,
    options: object,
    callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void,
  ) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      const list = addresses as LookupAddress[];
      if (!allowed && list.some((a) => isPrivateAddress(a.address)))
        return callback(new Error('That address is on a private network.'), []);
      const all = (options as { all?: boolean }).all;
      if (all) return callback(null, list);
      callback(null, list[0]!.address, list[0]!.family);
    });
  };
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve) => {
    const req = send(
      url,
      {
        method: 'POST',
        lookup: lookup as never,
        timeout: DELIVERY_TIMEOUT_MS,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(delivery.body),
          'user-agent': 'Kovan-Webhook/1',
          'x-kovan-event': delivery.type,
          'x-kovan-delivery': delivery.id,
          'x-kovan-signature': signature(secret, delivery.body),
        },
      },
      (res) => {
        const code = res.statusCode ?? 0;
        res.resume();
        res.on('end', () =>
          resolve(
            code >= 200 && code < 300
              ? { ok: true, code, error: null }
              : {
                  ok: false,
                  code,
                  error:
                    code >= 300 && code < 400
                      ? 'It answered with a redirect; redirects are not followed.'
                      : `It answered ${code}.`,
                },
          ),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error('No answer within 10 seconds.')));
    req.on('error', (error) => resolve({ ok: false, code: null, error: error.message }));
    req.end(delivery.body);
  });
}
