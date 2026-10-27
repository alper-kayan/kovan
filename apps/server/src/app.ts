import { registerGitRelay } from './gitRelay.js';
import { registerEventRoutes } from './events/routes.js';
import { registerMachineRoutes } from './machineRoutes.js';
import { registerOrgIntegrationRoutes } from './orgIntegrations.js';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { registerApiRoutes } from './api/routes.js';
import { registerDeskRoutes } from './desk/routes.js';
import { registerPushRoutes } from './push/routes.js';
import { registerCollabRoutes } from './collab/routes.js';
import { registerSessionRoutes } from './sessions/routes.js';
import { registerSwarmRoutes } from './swarm/routes.js';
import { registerBillingRoutes } from './billing/routes.js';
import { messagePage } from './auth/pages.js';
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

  const serverErrors = new ServerErrors(ctx.db);
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof ZodError) {
      const message = error.issues
        .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
        .join('; ');
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
    return reply
      .code(500)
      .send({ error: { code: 'internal', message: 'Something went wrong on the server' } });
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
        .send(messagePage('Not found', 'That page does not exist.', true));
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
  }

  return app;
}
