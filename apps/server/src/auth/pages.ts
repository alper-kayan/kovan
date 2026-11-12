// Small server-rendered pages the browser sees during sign-in, in Kovan's design language.

const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const MARK = `<svg width="56" height="56" viewBox="0 0 32 32" fill="none" aria-hidden="true">${[
  30, 90, 150, 210, 270, 330,
]
  .map((deg) => {
    const a = (deg * Math.PI) / 180;
    return `<path d="${hex(16 + 8.5 * Math.cos(a), 16 + 8.5 * Math.sin(a), 3.6)}" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>`;
  })
  .join('')}<path d="${hex(16, 16, 3.6)}" fill="currentColor"/></svg>`;

function hex(cx: number, cy: number, r: number): string {
  return (
    'M' +
    Array.from({ length: 6 }, (_, i) => {
      const a = (Math.PI / 3) * i - Math.PI / 2;
      return `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
    }).join('L') +
    'Z'
  );
}

import { currentLocale, t } from '../i18n/index.js';

export function page(title: string, body: string, head = ''): string {
  return `<!doctype html><html lang="${currentLocale()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${head}
<title>${escape(title)} · Kovan</title>
<style>
:root{--bg:#101010;--bg2:#0b0b0b;--line:#303030;--fg:#d8d8d8;--fg2:#a7a7a7;--fg3:#858585;--pop:#e8e8e8;--popfg:#111;--danger:#e5484d;color-scheme:dark}
@media (prefers-color-scheme:light){:root{--bg:#fff;--bg2:#f6f6f7;--line:#d0d0d6;--fg:#18181b;--fg2:#52525b;--fg3:#71717a;--pop:#18181b;--popfg:#fff;color-scheme:light}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:14px/1.5 'DM Sans',system-ui,-apple-system,sans-serif;padding:24px}
main{width:100%;max-width:340px;text-align:center}.mark{color:var(--fg)}h1{font-size:20px;font-weight:500;margin:18px 0 6px}p{color:var(--fg2);margin:0 0 22px}
.btn{display:flex;align-items:center;justify-content:center;width:100%;height:40px;border-radius:8px;border:1px solid var(--line);background:var(--bg2);color:var(--fg);font:inherit;font-weight:500;text-decoration:none;cursor:pointer;margin-top:10px}
.btn.primary{background:var(--pop);color:var(--popfg);border-color:transparent}
input{width:100%;height:40px;padding:0 12px;border-radius:8px;border:1px solid var(--line);background:var(--bg2);color:var(--fg);font:inherit}
.sep{display:flex;align-items:center;gap:10px;color:var(--fg3);font-size:12px;margin:18px 0 8px}.sep:before,.sep:after{content:"";flex:1;height:1px;background:var(--line)}
.note{font-size:12px;color:var(--fg3);margin-top:16px}.note a{color:inherit}.error{color:var(--danger)}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.code{font:600 30px/1.2 ui-monospace,'Geist Mono',Menlo,monospace;letter-spacing:.12em;color:var(--fg);margin:4px 0 18px}
input.code-input{text-align:center;font:600 20px ui-monospace,'Geist Mono',Menlo,monospace;letter-spacing:.12em}
</style></head><body><main><div class="mark">${MARK}</div>${body}</main></body></html>`;
}

export function chooserPage(
  loginId: string,
  intent: 'login' | 'link',
  providers: { id: string; label: string; enabled: boolean }[],
): string {
  // A provider this server has no keys for isn't offered at all.
  const offered = providers.filter((p) => p.enabled);
  const buttons = offered
    .map(
      (p, i) =>
        `<a class="btn${i === 0 ? ' primary' : ''}" href="/auth/${p.id}?login=${encodeURIComponent(loginId)}">${escape(t('Continue with {name}', { name: p.label }))}</a>`,
    )
    .join('');
  const email =
    intent === 'login'
      ? `${offered.length ? `<div class="sep">${t('or')}</div>` : ''}<form method="post" action="/auth/email"><input type="hidden" name="login" value="${escape(loginId)}"><label class="sr-only" for="email">${t('Email address')}</label><input type="email" id="email" name="email" required placeholder="${t('you@company.com')}" autocomplete="email"><button class="btn${offered.length ? '' : ' primary'}" type="submit">${t('Continue with email')}</button></form>`
      : '';
  const terms =
    intent === 'login'
      ? `<p class="note">${t('By continuing you accept the {terms} and the {privacy}.', { terms: `<a href="/terms/" target="_blank">${t('terms of service')}</a>`, privacy: `<a href="/privacy/" target="_blank">${t('privacy policy')}</a>` })}</p>`
      : '';
  return page(
    intent === 'link' ? t('Connect an account') : t('Sign in'),
    `<h1>${intent === 'link' ? t('Connect your account') : t('Sign in to Kovan')}</h1><p>${intent === 'link' ? t('Link another way to sign in.') : t('New here? Signing in creates your account.')}</p>${buttons || (intent === 'link' ? `<p class="note">${t('This server has no other way to sign in set up.')}</p>` : '')}${email}${terms}`,
  );
}

/** The review account's sign-in: a password instead of an emailed link. */
export const reviewPasswordPage = (loginId: string, email: string) =>
  page(
    t('Sign in'),
    `<h1>${t('Sign in to Kovan')}</h1><p>${escape(email)}</p><form method="post" action="/auth/review"><input type="hidden" name="login" value="${escape(loginId)}"><input type="password" name="password" required placeholder="${t('Password')}" autocomplete="current-password" autofocus><button class="btn primary" type="submit">${t('Sign in')}</button></form>`,
  );

export const messagePage = (
  title: string,
  message: string,
  isError = false,
  back?: { href: string; label: string },
) =>
  // Fixed texts come out in the request's language (the catalog has them); others as given.
  page(
    t(title),
    `<h1>${escape(t(title))}</h1><p class="${isError ? 'error' : ''}">${escape(t(message))}</p>${
      back ? `<p><a class="btn" href="${escape(back.href)}">${escape(t(back.label))}</a></p>` : ''
    }`,
  );

/** Said at the end of a sign-in in the browser (a function: it's in the request's language). */
export const doneHint = () => t('You can close this tab and return to Kovan.');

/** After asking for an email link: the code the link's page will ask for. */
export const checkEmailPage = (email: string, code: string) =>
  page(
    t('Check your email'),
    `<h1>${t('Check your email')}</h1><p>${escape(t('We sent a sign-in link to {email}. You can open it on any device, your phone too.', { email }))}</p><p>${t('Its page asks for this code:')}</p><div class="code" aria-label="${escape(t('Your code: {code}', { code: code.split('').join(' ') }))}">${escape(code)}</div><p class="note">${t("Keep this screen open, or note the code. The email doesn't contain it.")}</p>`,
  );

/** The page an emailed sign-in link opens: the code from the screen that asked for it. */
export const codeEntryPage = (token: string, error: string | null = null) =>
  page(
    t('Finish signing in'),
    `<h1>${t('Finish signing in')}</h1><p>${t('Type the code shown where you started signing in: in Kovan, or on the page that sent this email.')}</p>${error ? `<p class="error">${escape(t(error))}</p>` : ''}<form method="post" action="/auth/email/confirm"><input type="hidden" name="token" value="${escape(token)}"><input class="code-input" name="code" required inputmode="numeric" autocomplete="one-time-code" placeholder="123 456" maxlength="12" autofocus aria-label="${t('Code')}"><button class="btn primary" type="submit">${t('Sign in')}</button></form><p class="note">${t("Didn't try to sign in? Ignore this email. Without the code, nobody can sign in with it.")}</p>`,
  );

/** The page an email verification link opens: which account the address is confirmed for. */
export const verifyConfirmPage = (token: string, email: string, name: string) =>
  page(
    t('Confirm your email'),
    `<h1>${t('Confirm your email')}</h1><p>${t('Confirm {email} for the Kovan account of {name}? Only confirm it if that is your account.', { email: escape(email), name: `<strong>${escape(name)}</strong>` })}</p><form method="post" action="/auth/verify"><input type="hidden" name="token" value="${escape(token)}"><button class="btn primary" type="submit">${t('Confirm my email')}</button></form><p class="note">${t('Not your account? Close this page; the address stays unconfirmed.')}</p>`,
  );

/** Only the Kovan app's own links: a sign-in can't be turned into a redirect to anywhere else. */
export const RETURN_TO = /^kovan:\/\/[a-z0-9/_-]*$/i;

/**
 * The end of a sign-in. Started from the phone, the browser goes straight back to the app (and a
 * button does, where a browser won't follow the redirect on its own).
 */
export function signedInPage(title: string, returnTo: string | null): string {
  if (!returnTo || !RETURN_TO.test(returnTo)) return messagePage(title, doneHint());
  const to = escape(returnTo);
  return page(
    t(title),
    `<h1>${escape(t(title))}</h1><p>${t('Going back to the Kovan app.')}</p><a class="btn primary" href="${to}">${t('Open Kovan')}</a>`,
    `<meta http-equiv="refresh" content="0;url=${to}">`,
  );
}
