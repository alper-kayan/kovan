import type { FastifyInstance, FastifyReply } from 'fastify';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { randomToken, safeEqual, sha256 } from '../crypto.js';
import { desktopLogins, emailTokens, users } from '../db/schema.js';
import { HttpError, notFound, unauthorized } from '../errors.js';
import { actionMail } from '../mail.js';
import { linkProfile, signInWithProfile, toUser, type Profile } from '../users.js';
import {
  chooserPage,
  doneHint,
  messagePage,
  RETURN_TO,
  reviewPasswordPage,
  signedInPage,
} from './pages.js';
import { authenticate, createSession, revokeSession } from './sessions.js';
import { bearerToken, requireUser } from './guard.js';

const LOGIN_MINUTES = 15;
const EMAIL_LINK_MINUTES = 20;

const html = (reply: FastifyReply, body: string, status = 200) =>
  reply.code(status).type('text/html; charset=utf-8').send(body);

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, enc, config, mailer } = ctx;
  const callbackUrl = (provider: string) => `${config.PUBLIC_URL}/auth/${provider}/callback`;

  async function pendingLogin(id: string) {
    const [login] = await db
      .select()
      .from(desktopLogins)
      .where(
        and(
          eq(desktopLogins.id, id),
          eq(desktopLogins.status, 'pending'),
          gt(desktopLogins.expiresAt, new Date()),
        ),
      );
    return login ?? null;
  }

  /** Finishes a desktop sign-in with a verified profile. */
  async function complete(loginId: string, profile: Profile): Promise<void> {
    const login = await pendingLogin(loginId);
    if (!login)
      throw new HttpError(410, 'expired', 'This sign-in link has expired. Start again from Kovan.');
    try {
      if (login.intent === 'link') {
        const user = await linkProfile(db, enc, login.linkUserId!, profile);
        await db
          .update(desktopLogins)
          .set({ status: 'complete', userId: user.id })
          .where(eq(desktopLogins.id, loginId));
        ctx.hub.sendUser(user.id, { type: 'user', user: toUser(user) });
      } else {
        const user = await signInWithProfile(db, enc, profile);
        const token = await createSession(db, user.id, login.machineId);
        await ctx.audit.record({
          actor: user,
          action: 'auth.signed_in',
          meta: { provider: profile.provider },
        });
        await db
          .update(desktopLogins)
          .set({ status: 'complete', userId: user.id, sessionTokenEnc: enc.encrypt(token) })
          .where(eq(desktopLogins.id, loginId));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db
        .update(desktopLogins)
        .set({ status: 'failed', error: message })
        .where(eq(desktopLogins.id, loginId));
      throw error;
    }
  }

  // 1. The desktop app starts a sign-in and gets a URL to open in the browser.
  app.post('/auth/desktop/start', async (req) => {
    const body = z
      .object({
        secretHash: z.string().min(20).max(100),
        intent: z.enum(['login', 'link']).default('login'),
        machineId: z.string().max(100).nullable().default(null),
        returnTo: z.string().max(100).regex(RETURN_TO).nullable().default(null),
      })
      .parse(req.body);
    let linkUserId: string | null = null;
    if (body.intent === 'link') linkUserId = (await requireUser(ctx, req)).id;
    const id = randomToken(18);
    await db.insert(desktopLogins).values({
      id,
      secretHash: body.secretHash,
      intent: body.intent,
      linkUserId,
      machineId: body.machineId,
      returnTo: body.returnTo,
      expiresAt: new Date(Date.now() + LOGIN_MINUTES * 60_000),
    });
    return {
      loginId: id,
      url: `${config.PUBLIC_URL}/auth/start?login=${id}`,
      expiresInSeconds: LOGIN_MINUTES * 60,
    };
  });

  // 2. The desktop app polls with its secret until the browser part is done.
  app.post('/auth/desktop/poll', async (req, reply) => {
    const body = z.object({ loginId: z.string(), secret: z.string() }).parse(req.body);
    const [login] = await db.select().from(desktopLogins).where(eq(desktopLogins.id, body.loginId));
    if (!login || !safeEqual(sha256(body.secret), login.secretHash))
      throw notFound('Unknown sign-in');
    if (login.status === 'failed') return { status: 'failed', error: login.error };
    if (login.status === 'pending') {
      if (login.expiresAt < new Date())
        return { status: 'failed', error: 'Sign-in expired. Try again.' };
      return { status: 'pending' };
    }
    if (login.consumedAt)
      return reply.code(410).send({ error: { code: 'consumed', message: 'Already collected' } });
    await db
      .update(desktopLogins)
      .set({ consumedAt: new Date(), sessionTokenEnc: null })
      .where(eq(desktopLogins.id, login.id));
    const [user] = await db.select().from(users).where(eq(users.id, login.userId!));
    return {
      status: 'complete',
      token: login.sessionTokenEnc ? enc.decrypt(login.sessionTokenEnc) : null,
      user: user ? toUser(user) : null,
    };
  });

  // 3. The browser chooses how to sign in.
  app.get('/auth/start', async (req, reply) => {
    const { login: loginId = '' } = req.query as { login?: string };
    const login = await pendingLogin(loginId);
    if (!login)
      return html(
        reply,
        messagePage('Link expired', 'Start signing in again from Kovan.', true),
        410,
      );
    return html(
      reply,
      chooserPage(loginId, login.intent, [
        { id: 'github', label: 'GitHub', enabled: Boolean(ctx.providers.github) },
        ...(login.intent === 'login'
          ? [{ id: 'google', label: 'Google', enabled: Boolean(ctx.providers.google) }]
          : []),
      ]),
    );
  });

  for (const providerId of ['github', 'google'] as const) {
    app.get(`/auth/${providerId}`, async (req, reply) => {
      const provider = ctx.providers[providerId];
      if (!provider)
        return html(
          reply,
          messagePage('Not available', `${providerId} sign-in isn't configured.`, true),
          400,
        );
      const { login: loginId = '' } = req.query as { login?: string };
      const login = await pendingLogin(loginId);
      if (!login)
        return html(
          reply,
          messagePage('Link expired', 'Start signing in again from Kovan.', true),
          410,
        );
      const state = randomToken(18);
      await db
        .update(desktopLogins)
        .set({ oauthState: state })
        .where(eq(desktopLogins.id, loginId));
      return reply.redirect(provider.authorizeUrl(state, callbackUrl(providerId)));
    });

    app.get(`/auth/${providerId}/callback`, async (req, reply) => {
      const provider = ctx.providers[providerId];
      const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
      if (!provider || !state)
        return html(reply, messagePage('Sign-in failed', 'Missing sign-in details.', true), 400);
      const [login] = await db
        .select()
        .from(desktopLogins)
        .where(eq(desktopLogins.oauthState, state));
      if (!login)
        return html(
          reply,
          messagePage('Link expired', 'Start signing in again from Kovan.', true),
          410,
        );
      if (error || !code) {
        await db
          .update(desktopLogins)
          .set({ status: 'failed', error: 'Sign-in was cancelled' })
          .where(eq(desktopLogins.id, login.id));
        return html(
          reply,
          messagePage('Sign-in cancelled', 'Nothing changed. You can try again from Kovan.', true),
          400,
        );
      }
      try {
        await complete(login.id, await provider.complete(code, callbackUrl(providerId)));
        return html(
          reply,
          signedInPage(
            login.intent === 'link' ? 'Account connected' : 'You are signed in',
            login.returnTo,
          ),
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return html(
          reply,
          messagePage('Sign-in failed', message, true),
          e instanceof HttpError ? e.status : 500,
        );
      }
    });
  }

  // Email: a magic link that must be opened on the same computer to finish the sign-in.
  app.post('/auth/email', async (req, reply) => {
    const form = z
      .object({ login: z.string(), email: z.string().trim().email() })
      .safeParse(req.body);
    if (!form.success)
      return html(
        reply,
        messagePage('Check the address', 'That email address does not look right.', true),
        400,
      );
    const login = await pendingLogin(form.data.login);
    if (!login || login.intent !== 'login')
      return html(
        reply,
        messagePage('Link expired', 'Start signing in again from Kovan.', true),
        410,
      );
    // The App Store's reviewers get a password page instead of an email they can't read.
    const review = config.REVIEW_ACCOUNT_EMAIL.toLowerCase();
    if (review && config.REVIEW_ACCOUNT_PASSWORD && form.data.email.toLowerCase() === review)
      return html(reply, reviewPasswordPage(login.id, form.data.email));
    const token = randomToken();
    await db.insert(emailTokens).values({
      tokenHash: sha256(token),
      email: form.data.email,
      purpose: 'login',
      loginId: login.id,
      expiresAt: new Date(Date.now() + EMAIL_LINK_MINUTES * 60_000),
    });
    await mailer.send(
      actionMail(
        form.data.email,
        'Sign in to Kovan',
        'Open this link on the computer where Kovan is waiting to finish signing in.',
        'Sign in to Kovan',
        `${config.PUBLIC_URL}/auth/email/callback?token=${token}`,
      ),
    );
    return html(
      reply,
      messagePage(
        'Check your email',
        `We sent a sign-in link to ${form.data.email}. Open it on this device.`,
      ),
    );
  });

  // Sign in with Apple, from the iPhone app: no browser, the phone hands over Apple's token.
  app.post('/auth/apple', async (req) => {
    const body = z
      .object({
        identityToken: z.string().min(20).max(8000),
        authorizationCode: z.string().max(1000).nullable().default(null),
        nonce: z.string().min(16).max(200),
        // Apple tells the app the name only the first time someone signs in.
        name: z
          .object({
            givenName: z.string().max(100).nullable().optional(),
            familyName: z.string().max(100).nullable().optional(),
          })
          .nullable()
          .default(null),
      })
      .parse(req.body);
    let identity;
    try {
      identity = await ctx.apple.verify(body.identityToken, body.nonce);
    } catch (error) {
      throw unauthorized(error instanceof Error ? error.message : String(error));
    }
    const refresh = body.authorizationCode
      ? await ctx.apple.refreshToken(body.authorizationCode).catch((error: unknown) => {
          // Signing in still works; only revoking at deletion needs it.
          req.log.warn({ err: error }, 'Apple refresh token not received');
          return null;
        })
      : null;
    const given = [body.name?.givenName, body.name?.familyName].filter(Boolean).join(' ').trim();
    const user = await signInWithProfile(db, enc, {
      provider: 'apple',
      providerUserId: identity.sub,
      name: given || identity.email?.split('@')[0] || 'Kovan user',
      email: identity.email,
      emailVerified: identity.emailVerified,
      avatarUrl: null,
      login: null,
      accessToken: refresh,
      scopes: null,
    });
    const token = await createSession(db, user.id, null);
    await ctx.audit.record({ actor: user, action: 'auth.signed_in', meta: { provider: 'apple' } });
    return { token, user: toUser(user) };
  });

  app.post('/auth/review', async (req, reply) => {
    const form = z.object({ login: z.string(), password: z.string().max(200) }).safeParse(req.body);
    const email = config.REVIEW_ACCOUNT_EMAIL;
    const login = form.success ? await pendingLogin(form.data.login) : null;
    if (!email || !config.REVIEW_ACCOUNT_PASSWORD || !login || login.intent !== 'login')
      return html(
        reply,
        messagePage('Link expired', 'Start signing in again from Kovan.', true),
        410,
      );
    // One try per sign-in: a wrong password ends it, and guessing means starting over each time.
    if (!safeEqual(sha256(form.data!.password), sha256(config.REVIEW_ACCOUNT_PASSWORD))) {
      await db
        .update(desktopLogins)
        .set({ status: 'failed', error: 'Wrong password. Start signing in again.' })
        .where(eq(desktopLogins.id, login.id));
      return html(
        reply,
        messagePage('Wrong password', 'Start signing in again from Kovan.', true),
        401,
      );
    }
    await complete(login.id, {
      provider: 'email',
      providerUserId: email.toLowerCase(),
      name: 'App Review',
      email,
      emailVerified: true,
      avatarUrl: null,
      login: null,
      accessToken: null,
      scopes: null,
    });
    return html(reply, signedInPage('You are signed in', login.returnTo));
  });

  async function useEmailToken(token: string, purpose: 'login' | 'verify') {
    const [row] = await db
      .select()
      .from(emailTokens)
      .where(
        and(
          eq(emailTokens.tokenHash, sha256(token)),
          eq(emailTokens.purpose, purpose),
          isNull(emailTokens.usedAt),
          gt(emailTokens.expiresAt, new Date()),
        ),
      );
    if (!row) return null;
    await db.update(emailTokens).set({ usedAt: new Date() }).where(eq(emailTokens.id, row.id));
    return row;
  }

  app.get('/auth/email/callback', async (req, reply) => {
    const { token = '' } = req.query as { token?: string };
    const row = await useEmailToken(token, 'login');
    if (!row?.loginId)
      return html(
        reply,
        messagePage('Link expired', 'This link was already used or has expired.', true),
        410,
      );
    const email = row.email.toLowerCase();
    try {
      await complete(row.loginId, {
        provider: 'email',
        providerUserId: email,
        name: email.split('@')[0]!,
        email: row.email,
        emailVerified: true,
        avatarUrl: null,
        login: null,
        accessToken: null,
        scopes: null,
      });
      const [login] = await db
        .select({ returnTo: desktopLogins.returnTo })
        .from(desktopLogins)
        .where(eq(desktopLogins.id, row.loginId));
      return html(reply, signedInPage('You are signed in', login?.returnTo ?? null));
    } catch (e) {
      return html(
        reply,
        messagePage('Sign-in failed', e instanceof Error ? e.message : String(e), true),
        400,
      );
    }
  });

  app.get('/auth/verify', async (req, reply) => {
    const { token = '' } = req.query as { token?: string };
    const row = await useEmailToken(token, 'verify');
    if (!row?.userId)
      return html(
        reply,
        messagePage('Link expired', 'This link was already used or has expired.', true),
        410,
      );
    const [user] = await db
      .update(users)
      .set({ emailVerifiedAt: new Date() })
      .where(and(eq(users.id, row.userId), eq(users.email, row.email)))
      .returning();
    if (!user)
      return html(
        reply,
        messagePage('Email changed', 'Your account email changed since this link was sent.', true),
        409,
      );
    ctx.hub.sendUser(user.id, { type: 'user', user: toUser(user) });
    return html(reply, messagePage('Email verified', doneHint));
  });

  app.post('/auth/logout', async (req) => {
    const token = bearerToken(req);
    if (!token) throw unauthorized();
    const user = await authenticate(db, token);
    await revokeSession(db, token);
    if (user) await ctx.audit.record({ actor: user, action: 'auth.signed_out', req });
    return { ok: true };
  });
}
