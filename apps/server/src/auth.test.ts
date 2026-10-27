import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identities } from './db/schema.js';
import {
  auth,
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
  it('signs in with a magic link opened in the browser and hands the token to the app once', async () => {
    const { loginId, secret } = await startLogin(h);
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

    const link = new URL(lastLink(h, 'Ada@Example.com'));
    const opened = await h.app.inject({ method: 'GET', url: link.pathname + link.search });
    expect(opened.body).toContain('You are signed in');

    const done = await poll(h, loginId, secret);
    expect(done.body.status).toBe('complete');
    expect(done.body.token).toMatch(/^kvn_/);
    expect(done.body.user?.emailVerified).toBe(true);

    // The token is handed out exactly once, and the link works once.
    expect((await poll(h, loginId, secret)).status).toBe(410);
    expect(
      (await h.app.inject({ method: 'GET', url: link.pathname + link.search })).statusCode,
    ).toBe(410);

    const me = await h.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: auth(done.body.token!),
    });
    expect(me.json().orgs).toHaveLength(1);
    expect(me.json().orgs[0].role).toBe('owner');
  });

  it('sends a sign-in started on the phone back to the app, and only to the app', async () => {
    const { loginId, secret } = await startLogin(h, { returnTo: 'kovan://signed-in' });
    await h.app.inject({
      method: 'POST',
      url: '/auth/email',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `login=${loginId}&email=phone%40example.com`,
    });
    const link = new URL(lastLink(h, 'phone@example.com'));
    const opened = await h.app.inject({ method: 'GET', url: link.pathname + link.search });
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
    const deskLink = new URL(lastLink(h, 'desk@example.com'));
    const deskPage = await h.app.inject({
      method: 'GET',
      url: deskLink.pathname + deskLink.search,
    });
    expect(deskPage.body).toContain('You can close this tab');
    expect(deskPage.body).not.toContain('http-equiv="refresh"');

    // Anything but the app's own scheme is refused: no open redirect.
    for (const returnTo of ['https://evil.example/', 'javascript:alert(1)', 'kovan://x"><script>'])
      await expect(startLogin(h, { returnTo })).rejects.toThrow(/start failed 400/);
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
    const { loginId, secret } = await startLogin(h);
    await h.app.inject({
      method: 'POST',
      url: '/auth/email',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `login=${loginId}&email=margaret%40example.com`,
    });
    const link = new URL(lastLink(h, 'margaret@example.com'));
    await h.app.inject({ method: 'GET', url: link.pathname + link.search });
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

    const link = new URL(lastLink(h, 'barbara@example.com'));
    expect(
      (await h.app.inject({ method: 'GET', url: link.pathname + link.search })).body,
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
