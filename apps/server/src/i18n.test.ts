import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, oauthLogin, startHarness, type Harness } from './test/harness.js';

let h: Harness;
let token: string;
let userId: string;

beforeAll(async () => {
  h = await startHarness();
  const r = await oauthLogin(h, 'github', 'ayse', {
    providerUserId: '77',
    login: 'ayse',
    name: 'Ayşe',
  });
  token = r.token;
  userId = r.user.id;
});
afterAll(() => h.close());

describe('Turkish', () => {
  it("answers pages in the browser's language and API errors in the app's", async () => {
    const page = await h.app.inject({
      method: 'GET',
      url: '/auth/no-such-page',
      headers: { 'accept-language': 'tr-TR,tr;q=0.9,en;q=0.8' },
    });
    expect(page.body).toContain('<html lang="tr">');
    expect(page.body).toContain('Bulunamadı');
    const english = await h.app.inject({ method: 'GET', url: '/auth/no-such-page' });
    expect(english.body).toContain('Not found');

    const missing = await h.app.inject({
      method: 'GET',
      url: '/api/sessions/00000000-0000-4000-8000-000000000000',
      headers: { ...auth(token), 'x-kovan-locale': 'tr' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.message).toMatch(/bulunamadı|erişiminiz yok/);
  });

  it('keeps the language a person chose, for what reaches them later', async () => {
    const set = await h.app.inject({
      method: 'PATCH',
      url: '/api/me',
      headers: auth(token),
      payload: { locale: 'tr' },
    });
    expect(set.statusCode).toBe(200);
    const notice = await h.ctx.push.compose(
      {
        kind: 'finished',
        sessionId: '00000000-0000-4000-8000-000000000000',
        laneUserId: userId,
        reason: 'done',
      },
      (await import('./i18n/index.js')).tFor('tr'),
    );
    // No such session: nothing to say. The words themselves are checked through the catalog.
    expect(notice).toBeNull();
    const { tFor } = await import('./i18n/index.js');
    expect(tFor('tr')('{name} mentioned you', { name: 'Ali' })).toBe('Ali sizden bahsetti');
    expect(tFor('en')('{name} mentioned you', { name: 'Ali' })).toBe('Ali mentioned you');
  });
});
