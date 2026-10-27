import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().default('postgres://kovan:kovan@localhost:5433/kovan'),
  SERVER_HOST: z.string().default('127.0.0.1'),
  SERVER_PORT: z.coerce.number().int().default(4807),
  /** Where browsers and desktop apps reach this server. */
  PUBLIC_URL: z.string().url().default('http://localhost:4807'),
  /**
   * App-side encryption keys as "id:base64key" pairs separated by commas; the highest id
   * encrypts, every id can decrypt (rotation). Each key is 32 random bytes.
   */
  ENCRYPTION_KEYS: z.string().default(''),
  GITHUB_CLIENT_ID: z.string().default(''),
  GITHUB_CLIENT_SECRET: z.string().default(''),
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  /** SMTP connection string; when empty, mail goes to the dev outbox instead of being sent. */
  SMTP_URL: z.string().default(''),
  MAIL_FROM: z.string().default('Kovan <hello@kovan.local>'),
  /** Sign-in requests allowed per IP per minute. */
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(30),
  /**
   * Set when the server sits behind a reverse proxy (it does in deploy/): the caller's address
   * is then read from X-Forwarded-For. Off otherwise, so nobody can forge their address.
   */
  TRUST_PROXY: z
    .enum(['true', 'false', '1', '0', ''])
    .default('')
    .transform((v) => v === 'true' || v === '1'),
  /** Requests allowed per signed-in person (or per IP when signed out) per minute. */
  API_RATE_LIMIT: z.coerce.number().int().positive().default(600),
  /** Where security researchers write; published in /.well-known/security.txt. */
  SECURITY_CONTACT: z.string().default('kovan@alperkayan.dev'),
  /**
   * Webhook targets allowed although they are private or plain http, as exact "host:port"
   * entries, comma separated (e.g. "founderos:4100"). Everything else must be public https.
   */
  KOVAN_WEBHOOK_ALLOW: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  /**
   * Development and tests only: where the git relay finds repositories instead of their host
   * (`<this>/<repoUrl>.git`), e.g. a local git server.
   */
  KOVAN_GIT_UPSTREAM: z.string().default(''),
  /** The built website (apps/web/dist); empty serves no site. */
  WEB_DIR: z.string().default(''),
  /**
   * Where release files live (installers and update manifests), e.g. a GitHub release's
   * "latest/download" URL. /download/* and /updates/* redirect there.
   */
  DOWNLOAD_BASE_URL: z.string().default(''),
  /** A local folder of release files, served at /updates/* instead of redirecting (testing). */
  RELEASES_DIR: z.string().default(''),
  /**
   * App Store review: one account that signs in with a password instead of an emailed link
   * (reviewers can't read our mail). Both empty: no such account.
   */
  REVIEW_ACCOUNT_EMAIL: z.string().default(''),
  REVIEW_ACCOUNT_PASSWORD: z
    .string()
    .default('')
    .refine((v) => v === '' || v.length >= 12, 'REVIEW_ACCOUNT_PASSWORD needs 12 characters'),
  /**
   * The outside monitor (deploy/monitor): with this token it fetches the phones of OPS_EMAIL's
   * account while the server is up, to warn them when it goes down. Empty: no such endpoint.
   */
  OPS_TOKEN: z
    .string()
    .default('')
    .refine((v) => v === '' || v.length >= 32, 'OPS_TOKEN needs 32 characters'),
  OPS_EMAIL: z.string().default(''),
  /** The host's report for the monitor (deploy/ops-status.py); empty: none. */
  OPS_STATUS_FILE: z.string().default(''),
  /** The mobile app's over-the-air updates, written by `apps/mobile/scripts/updates.mjs`. */
  MOBILE_UPDATES_DIR: z.string().default(''),
  /** Kovan's own provider key for managed usage; empty turns managed usage off. */
  MANAGED_OPENROUTER_API_KEY: z.string().default(''),
  MANAGED_OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  /** Stripe (test or live mode, by key); empty turns payments off. */
  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default(''),
  STRIPE_API_BASE: z.string().url().default('https://api.stripe.com'),
  /** Balances under this carry forward to the next day. Stripe's own minimum is 50 cents. */
  BILLING_MINIMUM_CENTS: z.coerce.number().int().min(1).default(50),
  /** The daily off-session charge runs at this hour (UTC). */
  BILLING_CHARGE_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(3),
  /**
   * Push to iPhones, straight to Apple: the .p8 key file and its ids. Empty: no iOS push.
   * Relative paths are from the server's working directory.
   */
  APNS_KEY_FILE: z.string().default(''),
  APNS_KEY_ID: z.string().default(''),
  APNS_TEAM_ID: z.string().default(''),
  /** The mobile app's bundle id. */
  APNS_TOPIC: z.string().default('dev.alperkayan.kovan'),
  /** Apple's hosts, for tests. */
  APNS_PRODUCTION_HOST: z.string().default('https://api.push.apple.com'),
  APNS_SANDBOX_HOST: z.string().default('https://api.sandbox.push.apple.com'),
  /**
   * Sign in with Apple: a key with "Sign in with Apple" on, for trading the phone's code for a
   * refresh token and revoking it when the account is deleted. Empty: the APNs key and ids
   * (one key can do both). Checking a sign-in needs no key.
   */
  APPLE_SIGNIN_KEY_FILE: z.string().default(''),
  APPLE_SIGNIN_KEY_ID: z.string().default(''),
  APPLE_TEAM_ID: z.string().default(''),
  /** Apple's sign-in host, for tests. */
  APPLE_ID_HOST: z.string().default('https://appleid.apple.com'),
  /** Push to Android, straight to Firebase: the service account key file. Empty: none. */
  FCM_KEY_FILE: z.string().default(''),
  FCM_API: z.string().url().default('https://fcm.googleapis.com'),
});

export type Config = z.infer<typeof EnvSchema> & {
  githubEnabled: boolean;
  googleEnabled: boolean;
  /** Managed usage needs both a provider key and payments. */
  managedEnabled: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.parse(env);
  if (parsed.NODE_ENV === 'production') {
    if (!parsed.ENCRYPTION_KEYS) throw new Error('ENCRYPTION_KEYS is required in production');
    if (!parsed.SMTP_URL) throw new Error('SMTP_URL is required in production');
    const host = new URL(parsed.PUBLIC_URL).hostname;
    if (!parsed.PUBLIC_URL.startsWith('https://') && host !== 'localhost' && host !== '127.0.0.1')
      throw new Error('PUBLIC_URL must be https in production');
    if (parsed.BILLING_MINIMUM_CENTS < 50)
      throw new Error(
        "BILLING_MINIMUM_CENTS can't be under Stripe's 50-cent minimum in production",
      );
    if (parsed.STRIPE_SECRET_KEY && !parsed.STRIPE_WEBHOOK_SECRET)
      throw new Error('STRIPE_WEBHOOK_SECRET is required with STRIPE_SECRET_KEY in production');
  }
  return {
    ...parsed,
    githubEnabled: Boolean(parsed.GITHUB_CLIENT_ID && parsed.GITHUB_CLIENT_SECRET),
    googleEnabled: Boolean(parsed.GOOGLE_CLIENT_ID && parsed.GOOGLE_CLIENT_SECRET),
    managedEnabled: Boolean(parsed.MANAGED_OPENROUTER_API_KEY && parsed.STRIPE_SECRET_KEY),
  };
}
