import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { desktopLogins, identities } from './db/schema.js';
import {
  auth,
  finishEmailLink,
  lastLink,
  oauthLogin,
  poll,
  startHarness,
  startLogin,
  type Harness,
} from './test/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

describe('email sign-in', () => {
  it('signs in with an emailed link and the code shown where it started, and hands the token to the app once', async () => {
    const { loginId, secret, code } = await startLogin(h);
    expect(code).toMatch(/^\d{3} \d{3}$/);
    expect((await poll(h, loginId, secret)).body.status).toBe('pending');

    const chooser = await h.app.inject({ method: 'GET', url: `/auth/start?login=${loginId}` });
    expect(chooser.statusCode).toBe(200);
    expect(chooser.body).toContain('Continue with email');

    const sent = await h.app.inject({
      method: 'POST',
      url: '/auth/email',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `login=${loginId}&email=Ada%40Example.com`,
    });
    expect(sent.body).toContain('Check your email');
    // The screen that asked shows the code; the email never carries it.
    expect(sent.body).toContain(code);
    const mail = [...h.mailer.sent].reverse().find((m) => m.to === 'Ada@Example.com')!;
    expect(mail.text).not.toContain(code);
    expect(mail.text).toContain('any device');

    // Opening the link (as a mail scanner would) only asks for the code; it spends nothing.
    const link = new URL(lastLink(h, 'Ada@Example.com'));
    for (let i = 0; i < 2; i++) {
      const opened = await h.app.inject({ method: 'GET', url: link.pathname + link.search });
      expect(opened.statusCode).toBe(200);
      expect(opened.body).toContain('Finish signing in');
    }
    expect((await poll(h, loginId, secret)).body.status).toBe('pending');

    const wrong = await h.app.inject({
      method: 'POST',
      url: '/auth/email/confirm',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `token=${encodeURIComponent(link.searchParams.get('token')!)}&code=000000`,
    });
    expect(wrong.statusCode).toBe(code.replace(' ', '') === '000000' ? 200 : 400);
    expect((await poll(h, loginId, secret)).body.status).toBe('pending');

    const opened = await finishEmailLink(h, 'Ada@Example.com', code.replace(' ', '-'));
    expect(opened.body).toContain('You are signed in');

    const done = await poll(h, loginId, secret);
    expect(done.body.status).toBe('complete');
    expect(done.body.token).toMatch(/^kvn_/);
    expect(done.body.user?.emailVerified).toBe(true);

    // An answer lost on the way can be asked for again for a minute (same secret, same token);
    // after that it's gone. The link works once.
    expect((await poll(h, loginId, secret)).body.token).toBe(done.body.token);
    await h.ctx.db
      .update(desktopLogins)
      .set({ consumedAt: new Date(Date.now() - 61_000) })
      .where(eq(desktopLogins.id, loginId));
    expect((await poll(h, loginId, secret)).status).toBe(410);
    expect(
      (await h.app.inject({ method: 'GET', url: link.pathname + link.search })).statusCode,
    ).toBe(410);
    expect((await finishEmailLink(h, 'Ada@Example.com', code)).statusCode).toBe(410);

    const me = await h.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: auth(done.body.token!),
    });
    expect(me.json().orgs).toHaveLength(1);
    expect(me.json().orgs[0].role).toBe('owner');
  });

  it('sends a sign-in started on the phone back to the app, and only to the app', async () => {
    const { loginId, secret, code } = await startLogin(h, { returnTo: 'kovan://signed-in' });
    await h.app.inject({
      method: 'POST',
      url: '/auth/email',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `login=${loginId}&email=phone%40example.com`,
    });
    const opened = await finishEmailLink(h, 'phone@example.com', code);
    expect(opened.body).toContain('<meta http-equiv="refresh" content="0;url=kovan://signed-in">');
    expect(opened.body).toContain('href="kovan://signed-in"');
    expect((await poll(h, loginId, secret)).body.status).toBe('complete');

    // A desktop sign-in still just says so.
    const desktop = await startLogin(h);
    await h.app.inject({
      method: 'POST',
      url: '/auth/email',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `login=${desktop.loginId}&email=desk%40example.com`,
    });
    const deskPage = await finishEmailLink(h, 'desk@example.com', desktop.code);
    expect(deskPage.body).toContain('You can close this tab');
    expect(deskPage.body).not.toContain('http-equiv="refresh"');

    // Anything but the app's own scheme is refused: no open redirect.
    for (const returnTo of ['https://evil.example/', 'javascript:alert(1)', 'kovan://x"><script>'])
      await expect(startLogin(h, { returnTo })).rejects.toThrow(/start failed 400/);
  });

  it('keeps a sign-in someone else started with your address from finishing on your click', async () => {
    // The attacker's screen holds the code; the victim only has the email.
    const attacker = await startLogin(h);
    await h.app.inject({
      method: 'POST',
      url: '/auth/email',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `login=${attacker.loginId}&email=victim%40example.com`,
    });
    const link = new URL(lastLink(h, 'victim@example.com'));
    const token = encodeURIComponent(link.searchParams.get('token')!);
    const guess = (n: number) =>
      h.app.inject({
        method: 'POST',
        url: '/auth/email/confirm',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: `token=${token}&code=${String(n).padStart(6, '0')}`,
      });
    const real = attacker.code.replace(' ', '');
    const guesses = [1, 2, 3, 4, 5].map((n) => (String(n).padStart(6, '0') === real ? 6 : n));
    for (const n of guesses.slice(0, 4)) expect((await guess(n)).statusCode).toBe(400);
    const last = await guess(guesses[4]!);
    expect(last.statusCode).toBe(410);
    expect(last.body).toContain('too many times');
    // Even the right code is refused now, and the attacker's app never got a token.
    expect((await finishEmailLink(h, 'victim@example.com', attacker.code)).statusCode).toBe(410);
    expect((await poll(h, attacker.loginId, attacker.secret)).body.status).toBe('pending');
  });

  it('refuses to poll with the wrong secret', async () => {
    const { loginId } = await startLogin(h);
    expect((await poll(h, loginId, 'not-the-secret')).status).toBe(404);
  });

  it('rejects requests without a valid session', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
    expect(
      (await h.app.inject({ method: 'GET', url: '/api/me', headers: auth('kvn_nope') })).statusCode,
    ).toBe(401);
  });
});

describe('OAuth sign-in', () => {
  it('signs in with GitHub, stores the token encrypted, and logs out', async () => {
    const { token, user } = await oauthLogin(h, 'github', 'gh-grace', {
      providerUserId: '1001',
      login: 'grace-h',
      name: 'Grace Hopper',
      email: 'grace@example.com',
      emailVerified: true,
      accessToken: 'gho_very_secret',
    });
    expect(user.githubLogin).toBe('grace-h');

    const [identity] = await h.ctx.db
      .select()
      .from(identities)
      .where(eq(identities.providerUserId, '1001'));
    expect(identity!.accessTokenEnc).not.toContain('gho_very_secret');
    expect(h.ctx.enc.decrypt(identity!.accessTokenEnc!)).toBe('gho_very_secret');

    expect(
      (await h.app.inject({ method: 'POST', url: '/auth/logout', headers: auth(token) }))
        .statusCode,
    ).toBe(200);
    expect(
      (await h.app.inject({ method: 'GET', url: '/api/me', headers: auth(token) })).statusCode,
    ).toBe(401);
  });

  it('joins a Google sign-in with the same verified email to the existing account', async () => {
    const github = await oauthLogin(h, 'github', 'gh-linus', {
      providerUserId: '2002',
      login: 'linus',
      email: 'linus@example.com',
      emailVerified: true,
    });
    const google = await oauthLogin(h, 'google', 'g-linus', {
      providerUserId: 'g-2002',
      email: 'linus@example.com',
      emailVerified: true,
    });
    expect(google.user.id).toBe(github.user.id);
  });

  it('connects GitHub to an email account, and refuses a GitHub account owned by someone else', async () => {
    const { loginId, secret, code } = await startLogin(h);
    await h.app.inject({
      method: 'POST',
      url: '/auth/email',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `login=${loginId}&email=margaret%40example.com`,
    });
    await finishEmailLink(h, 'margaret@example.com', code);
    const { token } = (await poll(h, loginId, secret)).body;

    h.profiles.github['gh-margaret'] = { providerUserId: '3003', login: 'mham' };
    const linkStart = await startLogin(h, { intent: 'link', token: token! });
    const redirect = await h.app.inject({
      method: 'GET',
      url: `/auth/github?login=${linkStart.loginId}`,
    });
    const state = new URL(redirect.headers.location as string).searchParams.get('state');
    const cb = await h.app.inject({
      method: 'GET',
      url: `/auth/github/callback?code=gh-margaret&state=${state}`,
    });
    expect(cb.body).toContain('Account connected');
    const me = await h.app.inject({ method: 'GET', url: '/api/me', headers: auth(token!) });
    expect(me.json().user.githubLogin).toBe('mham');

    // Grace's GitHub account (id 1001) can't be linked to Margaret.
    h.profiles.github['gh-grace-again'] = { providerUserId: '1001', login: 'grace-h' };
    const second = await startLogin(h, { intent: 'link', token: token! });
    const r2 = await h.app.inject({ method: 'GET', url: `/auth/github?login=${second.loginId}` });
    const s2 = new URL(r2.headers.location as string).searchParams.get('state');
    const cb2 = await h.app.inject({
      method: 'GET',
      url: `/auth/github/callback?code=gh-grace-again&state=${s2}`,
    });
    expect(cb2.statusCode).toBe(409);
    expect((await poll(h, second.loginId, second.secret)).body.status).toBe('failed');

    // Her own name and Kovan's picture over GitHub's, which signing in with GitHub keeps.
    const patch = (payload: object) =>
      h.app.inject({ method: 'PATCH', url: '/api/me', headers: auth(token!), payload });
    const kovan = await patch({ name: 'Margaret H.', photo: 'kovan' });
    expect(kovan.json().user).toMatchObject({ name: 'Margaret H.', avatarUrl: 'kovan:dark' });
    const again = await oauthLogin(h, 'github', 'gh-margaret', {
      providerUserId: '3003',
      login: 'mham',
      avatarUrl: 'https://avatars.githubusercontent.com/u/3003?v=4',
    });
    expect(again.user).toMatchObject({ name: 'Margaret H.', avatarUrl: 'kovan:dark' });
    expect((await patch({ photo: 'github' })).json().user.avatarUrl).toBe(
      'https://avatars.githubusercontent.com/u/3003?v=4',
    );
  });

  it("offers GitHub's photo only once GitHub is connected", async () => {
    const { token } = await oauthLogin(h, 'google', 'g-photo', {
      providerUserId: 'g-6006',
      email: 'photo@example.com',
    });
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/api/me',
      headers: auth(token),
      payload: { photo: 'github' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('email verification', () => {
  it('sends a link, verifies on open, and rate-limits resends', async () => {
    const { token } = await oauthLogin(h, 'github', 'gh-unverified', {
      providerUserId: '4004',
      login: 'barbara',
      email: 'barbara@example.com',
      emailVerified: false,
    });
    const me = await h.app.inject({ method: 'GET', url: '/api/me', headers: auth(token) });
    expect(me.json().user.emailVerified).toBe(false);

    const send = await h.app.inject({
      method: 'POST',
      url: '/api/me/verification-email',
      headers: auth(token),
    });
    expect(send.json()).toEqual({ sentTo: 'barbara@example.com', retryAfter: 60 });
    const again = await h.app.inject({
      method: 'POST',
      url: '/api/me/verification-email',
      headers: auth(token),
    });
    expect(again.statusCode).toBe(429);
    expect(Number(again.headers['retry-after'])).toBeGreaterThan(0);

    // Opening the link says whose account it confirms; only the button confirms it.
    const link = new URL(lastLink(h, 'barbara@example.com'));
    const shown = await h.app.inject({ method: 'GET', url: link.pathname + link.search });
    expect(shown.body).toContain('Confirm barbara@example.com for the Kovan account of');
    const before = await h.app.inject({ method: 'GET', url: '/api/me', headers: auth(token) });
    expect(before.json().user.emailVerified).toBe(false);
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: '/auth/verify',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          payload: `token=${encodeURIComponent(link.searchParams.get('token')!)}`,
        })
      ).body,
    ).toContain('Email verified');
    const after = await h.app.inject({ method: 'GET', url: '/api/me', headers: auth(token) });
    expect(after.json().user.emailVerified).toBe(true);
  });

  it('merges onboarding progress instead of replacing it', async () => {
    const { token } = await oauthLogin(h, 'github', 'gh-onboard', {
      providerUserId: '5005',
      login: 'onboarder',
    });
    await h.app.inject({
      method: 'PATCH',
      url: '/api/me',
      headers: auth(token),
      payload: { onboarding: { start: true } },
    });
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/api/me',
      headers: auth(token),
      payload: { onboarding: { notifications: true } },
    });
    expect(res.json().user.onboarding).toEqual({ start: true, notifications: true });
  });
});
