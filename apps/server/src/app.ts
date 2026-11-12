import { registerGitRelay } from './gitRelay.js';
import { registerEventRoutes } from './events/routes.js';
import { registerMachineRoutes } from './machineRoutes.js';
import { registerOrgIntegrationRoutes } from './orgIntegrations.js';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { readFile } from 'node:fs/promises';
import { eq, sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { registerApiRoutes } from './api/routes.js';
import { registerDeskRoutes } from './desk/routes.js';
import { registerPushRoutes } from './push/routes.js';
import { registerCollabRoutes } from './collab/routes.js';
import { registerSessionRoutes } from './sessions/routes.js';
import { registerSwarmRoutes } from './swarm/routes.js';
import { registerBillingRoutes } from './billing/routes.js';
import { signInCode } from './auth/code.js';
import { messagePage } from './auth/pages.js';
import { requestLocale, runInLocale, t } from './i18n/index.js';
import { sha256 } from './crypto.js';
import { emailTokens } from './db/schema.js';
import { registerAuthRoutes } from './auth/routes.js';
import type { AppContext } from './context.js';
import { ServerErrors } from './errorLog.js';
import { HttpError } from './errors.js';
import { OutboxMailer } from './mail.js';
import { registerMobileUpdateRoutes } from './mobileUpdates.js';
import { registerOpsRoutes } from './ops.js';
import { rateLimitKey, registerSecurityHeaders, registerSiteRoutes, siteNotFound } from './site.js';

export async function buildApp(
  ctx: AppContext,
  options: { logger?: boolean } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: ctx.config.TRUST_PROXY,
    bodyLimit: 256 * 1024,
  });

  // Browser forms post urlencoded bodies; parse them without another dependency.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    },
  );

  // Every API call counts against the signed-in person (or the address when signed out); pages,
  // sign-in (its own tighter limit below) and Stripe's webhooks don't.
  await app.register(rateLimit, {
    global: true,
    max: ctx.config.API_RATE_LIMIT,
    timeWindow: '1 minute',
    keyGenerator: rateLimitKey,
    allowList: (req) => !req.url.startsWith('/api/'),
  });
  registerSecurityHeaders(app, ctx);
  // Lane event batches carry tool output; the desktop keeps each batch well under this.
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  // Everything a request answers (pages, emails it sends, error texts) is in its language.
  app.addHook('onRequest', (req, _reply, done) => runInLocale(requestLocale(req.headers), done));

  const serverErrors = new ServerErrors(ctx.db);
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof HttpError) {
      return reply
        .code(error.status)
        .send({ error: { code: error.code, message: t(error.message) } });
    }
    if (error instanceof ZodError) {
      const message = error.issues.map((i) => t(plainIssue(i))).join(' ');
      return reply.code(400).send({ error: { code: 'bad_request', message } });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      const code = status === 429 ? 'rate_limited' : 'bad_request';
      return reply.code(status).send({ error: { code, message: (error as Error).message } });
    }
    req.log.error(error);
    if (process.env['KOVAN_DEBUG_ERRORS']) console.error(error);
    // The route's pattern, not the URL: no ids or query strings in the record.
    serverErrors.record(`${req.method} ${req.routeOptions.url ?? '(no route)'}`, error);
    // A reference to quote: the log has the details under the same id.
    return reply.code(500).send({
      error: {
        code: 'internal',
        message: t(
          "Something went wrong on Kovan's server. Try again; if it keeps happening, tell us at kovan@alperkayan.dev and mention {id}.",
          { id: req.id },
        ),
      },
    });
  });

  const notFoundPage = siteNotFound(ctx);
  app.setNotFoundHandler(async (req, reply) => {
    if (notFoundPage && req.method === 'GET' && !/^\/(api|auth|ws|updates)\b/.test(req.url))
      return reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send(await readFile(notFoundPage, 'utf8'));
    if (req.url.startsWith('/auth/')) {
      return reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send(messagePage(t('Not found'), t('That page does not exist.'), true));
    }
    return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
  });

  app.get('/health', async () => {
    await ctx.db.execute(sql`select 1`);
    return { ok: true };
  });

  await app.register(async (scoped) => {
    scoped.addHook(
      'onRequest',
      scoped.rateLimit({ max: ctx.config.AUTH_RATE_LIMIT, timeWindow: '1 minute' }),
    );
    registerAuthRoutes(scoped, ctx);
  });
  // Requests made for one run of a swarm: refused once the swarm was launched again elsewhere.
  app.addHook('preHandler', async (req) => {
    const fence = req.headers['x-kovan-fence'];
    if (typeof fence === 'string') await ctx.swarm.checkFence(fence);
  });
  registerApiRoutes(app, ctx);
  registerSessionRoutes(app, ctx);
  registerSwarmRoutes(app, ctx);
  registerBillingRoutes(app, ctx);
  registerCollabRoutes(app, ctx);
  registerDeskRoutes(app, ctx);
  registerEventRoutes(app, ctx);
  registerMachineRoutes(app, ctx);
  registerOrgIntegrationRoutes(app, ctx);
  registerPushRoutes(app, ctx);
  registerGitRelay(app, ctx);
  registerMobileUpdateRoutes(app, ctx);
  registerOpsRoutes(app, ctx, serverErrors);

  await registerSiteRoutes(app, ctx);

  app.get('/ws', { websocket: true }, (socket) => ctx.hub.handle(socket));

  // Development only: read the mail that would have been sent.
  if (ctx.mailer instanceof OutboxMailer && ctx.config.NODE_ENV !== 'production') {
    const outbox = ctx.mailer;
    app.get('/dev/outbox', async () => ({ mail: outbox.sent.slice(-20).reverse() }));
    // The code a sign-in link's page asks for, so a test can finish the sign-in from outside.
    app.get('/dev/sign-in-code', async (req) => {
      const { token = '' } = req.query as { token?: string };
      const [row] = await ctx.db
        .select({ loginId: emailTokens.loginId })
        .from(emailTokens)
        .where(eq(emailTokens.tokenHash, sha256(token)));
      return { code: row?.loginId ? signInCode(row.loginId) : null };
    });
  }

  return app;
}

/** A field name for people: "monthlyLimit" → "monthly limit", the last part of its path. */
function fieldName(path: readonly PropertyKey[]): string {
  const last = [...path].reverse().find((p) => typeof p === 'string') as string | undefined;
  return last ? last.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() : 'that';
}

/** One validation problem as a sentence; messages written for people pass through. */
function plainIssue(issue: ZodError['issues'][number]): string {
  const field = fieldName(issue.path);
  const i = issue as unknown as {
    code: string;
    minimum?: number | bigint;
    maximum?: number | bigint;
    origin?: string;
    format?: string;
    message: string;
    input?: unknown;
  };
  const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  if (i.code === 'too_small')
    return i.origin === 'string'
      ? Number(i.minimum) <= 1
        ? `${capital(field)} can't be empty.`
        : `${capital(field)} needs at least ${i.minimum} characters.`
      : i.origin === 'array'
        ? `${capital(field)} needs at least ${i.minimum}.`
        : `${capital(field)} must be at least ${i.minimum}.`;
  if (i.code === 'too_big')
    return i.origin === 'string'
      ? `${capital(field)} can be at most ${i.maximum} characters.`
      : `${capital(field)} can be at most ${i.maximum}.`;
  if (i.code === 'invalid_type')
    return i.input === undefined
      ? `${capital(field)} is missing.`
      : `${capital(field)} isn't valid.`;
  if (i.code === 'invalid_format' && i.format === 'email')
    return `${capital(field)} isn't a valid email address.`;
  // Messages written in the schemas themselves ("Not a valid GitHub username") are kept.
  if (i.code === 'custom' || (i.code === 'invalid_format' && !/^Invalid/.test(i.message)))
    return i.message;
  return `${capital(field)} isn't valid.`;
}
