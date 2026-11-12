import type { FastifyInstance, FastifyReply } from 'fastify';
import { t } from '../i18n/index.js';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { randomToken, safeEqual, sha256 } from '../crypto.js';
import { desktopLogins, emailTokens, users } from '../db/schema.js';
import { HttpError, notFound, unauthorized } from '../errors.js';
import { actionMail } from '../mail.js';
import { linkProfile, signInWithProfile, toUser, type Profile } from '../users.js';
import { codeMatches, signInCode } from './code.js';
import {
  checkEmailPage,
  chooserPage,
  codeEntryPage,
  doneHint,
  messagePage,
  RETURN_TO,
  reviewPasswordPage,
  signedInPage,
  verifyConfirmPage,
} from './pages.js';
import { authenticate, createSession, revokeSession } from './sessions.js';
import { bearerToken, requireUser } from './guard.js';

const LOGIN_MINUTES = 15;
const EMAIL_LINK_MINUTES = 20;
/** Wrong codes a sign-in link takes before it stops working. */
const CODE_ATTEMPTS = 5;

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
      // An emailed link's page asks for it; the app shows it while it waits.
      code: signInCode(id),
    };
  });

  // 2. The desktop app polls with its secret until the browser part is done.
  app.post('/auth/desktop/poll', async (req, reply) => {
    const body = z.object({ loginId: z.string(), secret: z.string() }).parse(req.body);
    const [login] = await db.select().from(desktopLogins).where(eq(desktopLogins.id, body.loginId));
    if (!login || !safeEqual(sha256(body.secret), login.secretHash))
      throw notFound("That sign-in isn't valid any more. Start signing in again from Kovan.");
    if (login.status === 'failed') return { status: 'failed', error: login.error };
    if (login.status === 'pending') {
      if (login.expiresAt < new Date())
        return { status: 'failed', error: 'Sign-in expired. Try again.' };
      return { status: 'pending' };
    }
    // A poll whose answer got lost on the way (it timed out on the client) may ask again for a
    // minute: only whoever holds the secret can, and the token stays theirs.
    const again = login.consumedAt && Date.now() - login.consumedAt.getTime() < 60_000;
    if (login.consumedAt && !(again && login.sessionTokenEnc)) {
      if (login.sessionTokenEnc)
        await db
          .update(desktopLogins)
          .set({ sessionTokenEnc: null })
          .where(eq(desktopLogins.id, login.id));
      return reply.code(410).send({
        error: {
          code: 'consumed',
          message: 'This sign-in was already finished. Start signing in again if you need to.',
        },
      });
    }
    if (!login.consumedAt)
      await db
        .update(desktopLogins)
        .set({ consumedAt: new Date() })
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

  // Email: a link that opens on any device and asks for the code the waiting screen shows.
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
        t('Sign in to Kovan'),
        t(
          "Open this link on any device. Its page asks for the code shown where you started signing in. Didn't try to sign in? Ignore this email: without that code nobody can use it.",
        ),
        t('Sign in to Kovan'),
        `${config.PUBLIC_URL}/auth/email/callback?token=${token}`,
        t,
      ),
    );
    return html(reply, checkEmailPage(form.data.email, signInCode(login.id)));
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

  /** An emailed link's token, while it can still be used; nothing is spent by looking. */
  async function peekEmailToken(token: string, purpose: 'login' | 'verify') {
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
    return row ?? null;
  }

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

  // Opening the link only asks for the code: mail scanners that open links can't use it up.
  app.get('/auth/email/callback', async (req, reply) => {
    const { token = '' } = req.query as { token?: string };
    const row = await peekEmailToken(token, 'login');
    if (!row?.loginId || !(await pendingLogin(row.loginId)))
      return html(
        reply,
        messagePage('Link expired', 'This link was already used or has expired.', true),
        410,
      );
    return html(reply, codeEntryPage(token));
  });

  app.post('/auth/email/confirm', async (req, reply) => {
    const form = z
      .object({ token: z.string().max(200), code: z.string().max(40) })
      .safeParse(req.body);
    const token = form.success ? form.data.token : '';
    const row = token ? await peekEmailToken(token, 'login') : null;
    if (!form.success || !row?.loginId || !(await pendingLogin(row.loginId)))
      return html(
        reply,
        messagePage('Link expired', 'This link was already used or has expired.', true),
        410,
      );
    if (!codeMatches(form.data.code, row.loginId)) {
      const attempts = row.attempts + 1;
      await db
        .update(emailTokens)
        .set(attempts >= CODE_ATTEMPTS ? { attempts, usedAt: new Date() } : { attempts })
        .where(eq(emailTokens.id, row.id));
      if (attempts >= CODE_ATTEMPTS)
        return html(
          reply,
          messagePage(
            'Link stopped',
            'The code was wrong too many times, so this link no longer works. Start signing in again from Kovan.',
            true,
          ),
          410,
        );
      return html(
        reply,
        codeEntryPage(
          token,
          "That code doesn't match. Check the screen where you started signing in. If you didn't, ignore this email.",
        ),
        400,
      );
    }
    const used = await useEmailToken(token, 'login');
    if (!used?.loginId)
      return html(
        reply,
        messagePage('Link expired', 'This link was already used or has expired.', true),
        410,
      );
    const email = used.email.toLowerCase();
    try {
      await complete(used.loginId, {
        provider: 'email',
        providerUserId: email,
        name: email.split('@')[0]!,
        email: used.email,
        emailVerified: true,
        avatarUrl: null,
        login: null,
        accessToken: null,
        scopes: null,
      });
      const [login] = await db
        .select({ returnTo: desktopLogins.returnTo })
        .from(desktopLogins)
        .where(eq(desktopLogins.id, used.loginId));
      return html(reply, signedInPage('You are signed in', login?.returnTo ?? null));
    } catch (e) {
      return html(
        reply,
        messagePage('Sign-in failed', e instanceof Error ? e.message : String(e), true),
        400,
      );
    }
  });

  // Opening a verification link shows whose account it confirms; the button confirms it.
  app.get('/auth/verify', async (req, reply) => {
    const { token = '' } = req.query as { token?: string };
    const row = await peekEmailToken(token, 'verify');
    const [owner] = row?.userId
      ? await db.select({ name: users.name }).from(users).where(eq(users.id, row.userId))
      : [];
    if (!row || !owner)
      return html(
        reply,
        messagePage('Link expired', 'This link was already used or has expired.', true),
        410,
      );
    return html(reply, verifyConfirmPage(token, row.email, owner.name));
  });

  app.post('/auth/verify', async (req, reply) => {
    const { token = '' } = z
      .object({ token: z.string().max(200).default('') })
      .parse(req.body ?? {});
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
    return html(reply, messagePage('Email verified', doneHint()));
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
