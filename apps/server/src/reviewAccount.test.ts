import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, poll, startHarness, startLogin, type Harness } from './test/harness.js';

let h: Harness;
const EMAIL = 'appreview@kovan.alperkayan.dev';
const PASSWORD = 'correct-horse-battery';

beforeAll(async () => {
  h = await startHarness({ REVIEW_ACCOUNT_EMAIL: EMAIL, REVIEW_ACCOUNT_PASSWORD: PASSWORD });
});
afterAll(() => h.close());

const form = (url: string, body: Record<string, string>) =>
  h.app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(body).toString(),
  });

describe("the App Store reviewers' account", () => {
  it('asks for the password instead of sending an email, and signs in with it', async () => {
    const { loginId, secret } = await startLogin(h);
    const sentBefore = h.mailer.sent.length;
    const page = await form('/auth/email', {
      login: loginId,
      email: 'AppReview@kovan.alperkayan.dev',
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('type="password"');
    expect(page.body).toContain('action="/auth/review"');
    expect(h.mailer.sent.length).toBe(sentBefore);

    const done = await form('/auth/review', { login: loginId, password: PASSWORD });
    expect(done.statusCode).toBe(200);
    expect(done.body).toContain('You are signed in');
    const { body } = await poll(h, loginId, secret);
    expect(body.status).toBe('complete');
    const me = await h.app.inject({ method: 'GET', url: '/api/me', headers: auth(body.token!) });
    expect(me.json().user).toMatchObject({ email: EMAIL, name: 'App Review', emailVerified: true });
  });

  it('ends the sign-in at the first wrong password', async () => {
    const { loginId, secret } = await startLogin(h);
    const wrong = await form('/auth/review', { login: loginId, password: 'guess-guess-guess' });
    expect(wrong.statusCode).toBe(401);
    expect((await poll(h, loginId, secret)).body.status).toBe('failed');
    // The same sign-in can't be tried again.
    expect((await form('/auth/review', { login: loginId, password: PASSWORD })).statusCode).toBe(
      410,
    );
  });

  it('leaves everyone else on emailed links', async () => {
    const { loginId } = await startLogin(h);
    const page = await form('/auth/email', { login: loginId, email: 'someone@kovan.test' });
    expect(page.body).toContain('Check your email');
    expect(h.mailer.sent.at(-1)?.to).toBe('someone@kovan.test');
  });
});
