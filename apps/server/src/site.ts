import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { messagePage } from './auth/pages.js';
import { bearerToken } from './auth/guard.js';
import type { AppContext } from './context.js';

/** The installer each download link points at; the names the release build produces. */
export const RELEASE_FILES = {
  mac: 'Kovan-mac-arm64.dmg',
  'windows-x64': 'Kovan-win-x64.exe',
  'windows-arm64': 'Kovan-win-arm64.exe',
  linux: 'Kovan-linux-x86_64.AppImage',
} as const;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

/** Who a request counts against for rate limits: the signed-in session, else the address. */
export function rateLimitKey(req: FastifyRequest): string {
  const token = bearerToken(req);
  return token ? `t:${createHash('sha256').update(token).digest('hex').slice(0, 32)}` : req.ip;
}

/** Security headers on every answer; a strict CSP on every page the server sends. */
export function registerSecurityHeaders(app: FastifyInstance, ctx: AppContext): void {
  const https = ctx.config.PUBLIC_URL.startsWith('https://');
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    reply.header('x-frame-options', 'SAMEORIGIN');
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    if (https) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    const type = String(reply.getHeader('content-type') ?? '');
    if (type.startsWith('text/html')) reply.header('content-security-policy', CSP);
    // Answers about a person's account are never cached by anything in between.
    if (req.url.startsWith('/api/') && !reply.hasHeader('cache-control'))
      reply.header('cache-control', 'no-store');
  });
}

export async function registerSiteRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { config } = ctx;

  // RFC 9116: where to report a vulnerability.
  app.get('/.well-known/security.txt', async (_req, reply) => {
    const expires = new Date(Date.now() + 180 * 86_400_000).toISOString();
    const contact = config.SECURITY_CONTACT.includes(':')
      ? config.SECURITY_CONTACT
      : `mailto:${config.SECURITY_CONTACT}`;
    return reply
      .type('text/plain; charset=utf-8')
      .send(
        [
          `Contact: ${contact}`,
          `Expires: ${expires}`,
          'Preferred-Languages: en, tr',
          `Canonical: ${config.PUBLIC_URL}/.well-known/security.txt`,
          `Policy: ${config.PUBLIC_URL}/security/`,
          '',
        ].join('\n'),
      );
  });

  // The public model catalog for the website: names, context and prices, no key needed.
  let catalog: { at: number; body: unknown } | null = null;
  app.get(
    '/api/catalog/models',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator: (r) => r.ip } } },
    async (_req, reply) => {
      if (!catalog || Date.now() - catalog.at > 3_600_000) {
        const res = await fetch(`${config.MANAGED_OPENROUTER_BASE_URL.replace(/\/$/, '')}/models`, {
          signal: AbortSignal.timeout(15_000),
        }).catch(() => null);
        if (!res?.ok) {
          if (catalog) return catalog.body;
          return reply.code(502).send({
            error: { code: 'unavailable', message: "The model catalog can't be reached" },
          });
        }
        const { data } = (await res.json()) as { data?: Record<string, unknown>[] };
        catalog = {
          at: Date.now(),
          body: {
            data: (data ?? []).map((m) => ({
              id: m['id'],
              name: m['name'],
              context_length: m['context_length'],
              pricing: m['pricing'],
            })),
          },
        };
      }
      return reply.header('cache-control', 'public, max-age=600').send(catalog.body);
    },
  );

  // ---------- installers and update files ----------

  const releases = config.RELEASES_DIR ? resolve(config.RELEASES_DIR) : '';
  const base = config.DOWNLOAD_BASE_URL.replace(/\/$/, '');
  if (releases)
    await app.register(fastifyStatic, {
      root: releases,
      prefix: '/updates/',
      decorateReply: false,
      index: false,
      cacheControl: false,
    });
  else
    app.get('/updates/:file', async (req, reply) => {
      const { file } = req.params as { file: string };
      if (!base || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file)) return reply.callNotFound();
      return reply.redirect(`${base}/${file}`, 302);
    });

  for (const [platform, file] of Object.entries(RELEASE_FILES))
    app.get(`/download/${platform}`, async (_req, reply) => {
      // A platform whose installer isn't out yet gets the page below, not a 404.
      if (releases && existsSync(join(releases, file)))
        return reply.redirect(`/updates/${file}`, 302);
      if (!releases && base) return reply.redirect(`${base}/${file}`, 302);
      return reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send(messagePage('Not available yet', 'This build has not been published yet.', true));
    });

  // ---------- the website ----------

  const site = config.WEB_DIR ? resolve(config.WEB_DIR) : '';
  if (site && existsSync(site)) {
    await app.register(fastifyStatic, {
      root: site,
      prefix: '/',
      redirect: true,
      cacheControl: false,
      // Hashed assets never change; pages are checked again each visit.
      setHeaders: (res, path) => {
        res.setHeader(
          'cache-control',
          path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });
  } else {
    app.get('/download', async (_req, reply) =>
      reply
        .type('text/html; charset=utf-8')
        .send(messagePage('Get Kovan', 'Downloads for macOS, Windows and Linux.')),
    );
  }
}

/** The site's own 404 page, when the site is being served. */
export function siteNotFound(ctx: AppContext): string | null {
  const site = ctx.config.WEB_DIR ? resolve(ctx.config.WEB_DIR) : '';
  const page = site ? resolve(site, '404.html') : '';
  return page && existsSync(page) ? page : null;
}
