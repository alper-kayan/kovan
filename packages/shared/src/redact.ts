/**
 * Pattern-based secret redaction. The server runs it before lane events are stored or sent to
 * anyone else, and the app before text leaves the machine (a GitHub issue), so a key an agent
 * printed doesn't spread.
 */
const PATTERNS: RegExp[] = [
  // Private keys, whole block.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // Provider keys and tokens.
  /\bsk-(?:or-v1-|ant-|proj-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/g,
  /\bxox[abpors]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bkvn_[A-Za-z0-9_-]{20,}/g,
  // JSON Web Tokens.
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Credentials in URLs: scheme://user:password@host
  /(?<=:\/\/[^/\s:@]+:)[^@\s/]{3,}(?=@)/g,
];

/** Keep the name, drop the value: `Bearer x`, `API_KEY=x` (env style), `"password": "x"`. */
const BEARER = /\b(bearer\s+)([A-Za-z0-9._~+/-]{8,}=*)/gi;
const ENV_ASSIGNMENT =
  /\b([A-Z0-9_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD)[A-Z0-9_]*\s*[:=]\s*["']?)([^\s"']{6,})/g;
const QUOTED_ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|token|password|passwd)[A-Za-z0-9_]*["']?\s*[:=]\s*)(["'])([^"'\s]{6,})\2/gi;

export const REDACTED = '[redacted]';

export function redactText(text: string): string {
  let out = text;
  for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED);
  const keep = (value: string) => value.startsWith(REDACTED);
  out = out.replace(BEARER, (m, name: string, value: string) =>
    keep(value) ? m : `${name}${REDACTED}`,
  );
  out = out.replace(ENV_ASSIGNMENT, (m, name: string, value: string) =>
    keep(value) ? m : `${name}${REDACTED}`,
  );
  out = out.replace(QUOTED_ASSIGNMENT, (m, name: string, quote: string, value: string) =>
    keep(value) ? m : `${name}${quote}${REDACTED}${quote}`,
  );
  return out;
}

/** Redacts every string inside a JSON value; returns a new value. */
export function redact<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as T;
  if (Array.isArray(value)) return value.map(redact) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v);
    return out as T;
  }
  return value;
}
