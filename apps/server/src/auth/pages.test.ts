import { describe, expect, it } from 'vitest';
import { chooserPage } from './pages.js';

describe('sign-in chooser', () => {
  it('offers only the providers this server has keys for, and links the terms', () => {
    const page = chooserPage('abc', 'login', [
      { id: 'github', label: 'GitHub', enabled: false },
      { id: 'google', label: 'Google', enabled: true },
    ]);
    expect(page).not.toContain('Continue with GitHub');
    expect(page).toContain('class="btn primary" href="/auth/google?login=abc"');
    expect(page).toContain('Continue with email');
    expect(page).toContain('href="/terms/"');
    expect(page).toContain('href="/privacy/"');
  });

  it('makes email the main button when it is the only way in', () => {
    const page = chooserPage('abc', 'login', [{ id: 'github', label: 'GitHub', enabled: false }]);
    expect(page).not.toContain('<div class="sep">');
    expect(page).toContain('<button class="btn primary" type="submit">Continue with email');
  });

  it('says so when there is nothing else to link', () => {
    const page = chooserPage('abc', 'link', [{ id: 'github', label: 'GitHub', enabled: false }]);
    expect(page).toContain('no other way to sign in');
    expect(page).not.toContain('href="/terms/"');
  });
});
