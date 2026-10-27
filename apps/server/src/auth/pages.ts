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

export function page(title: string, body: string, head = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${head}
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
        `<a class="btn${i === 0 ? ' primary' : ''}" href="/auth/${p.id}?login=${encodeURIComponent(loginId)}">Continue with ${escape(p.label)}</a>`,
    )
    .join('');
  const email =
    intent === 'login'
      ? `${offered.length ? '<div class="sep">or</div>' : ''}<form method="post" action="/auth/email"><input type="hidden" name="login" value="${escape(loginId)}"><input type="email" name="email" required placeholder="you@company.com" autocomplete="email"><button class="btn${offered.length ? '' : ' primary'}" type="submit">Continue with email</button></form>`
      : '';
  const terms =
    intent === 'login'
      ? '<p class="note">By continuing you accept the <a href="/terms/" target="_blank">terms of service</a> and the <a href="/privacy/" target="_blank">privacy policy</a>.</p>'
      : '';
  return page(
    intent === 'link' ? 'Connect an account' : 'Sign in',
    `<h1>${intent === 'link' ? 'Connect your account' : 'Sign in to Kovan'}</h1><p>${intent === 'link' ? 'Link another way to sign in.' : 'New here? Signing in creates your account.'}</p>${buttons || (intent === 'link' ? '<p class="note">This server has no other way to sign in set up.</p>' : '')}${email}${terms}`,
  );
}

/** The review account's sign-in: a password instead of an emailed link. */
export const reviewPasswordPage = (loginId: string, email: string) =>
  page(
    'Sign in',
    `<h1>Sign in to Kovan</h1><p>${escape(email)}</p><form method="post" action="/auth/review"><input type="hidden" name="login" value="${escape(loginId)}"><input type="password" name="password" required placeholder="Password" autocomplete="current-password" autofocus><button class="btn primary" type="submit">Sign in</button></form>`,
  );

export const messagePage = (title: string, message: string, isError = false) =>
  page(
    title,
    `<h1>${escape(title)}</h1><p class="${isError ? 'error' : ''}">${escape(message)}</p>`,
  );

export const doneHint = 'You can close this tab and return to Kovan.';

/** Only the Kovan app's own links: a sign-in can't be turned into a redirect to anywhere else. */
export const RETURN_TO = /^kovan:\/\/[a-z0-9/_-]*$/i;

/**
 * The end of a sign-in. Started from the phone, the browser goes straight back to the app (and a
 * button does, where a browser won't follow the redirect on its own).
 */
export function signedInPage(title: string, returnTo: string | null): string {
  if (!returnTo || !RETURN_TO.test(returnTo)) return messagePage(title, doneHint);
  const to = escape(returnTo);
  return page(
    title,
    `<h1>${escape(title)}</h1><p>Going back to the Kovan app.</p><a class="btn primary" href="${to}">Open Kovan</a>`,
    `<meta http-equiv="refresh" content="0;url=${to}">`,
  );
}
