import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/manrope';
import './styles/base.css';
import { t } from './lib/i18n';

/** Behaviour every page shares: the nav turning into a pill, and the mobile menu. */
function initNav(): void {
  const nav = document.querySelector<HTMLElement>('[data-nav]');
  if (!nav) return;

  const onScroll = () => nav.classList.toggle('is-scrolled', window.scrollY > 24);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  const toggle = nav.querySelector<HTMLButtonElement>('[data-nav-toggle]');
  const menu = nav.querySelector<HTMLElement>('[data-nav-menu]');
  if (toggle && menu) {
    const setOpen = (open: boolean) => {
      menu.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
    };
    toggle.addEventListener('click', () =>
      setOpen(toggle.getAttribute('aria-expanded') !== 'true'),
    );
    menu.addEventListener('click', () => setOpen(false));
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') setOpen(false);
    });
    window.matchMedia('(min-width: 901px)').addEventListener('change', () => setOpen(false));
  }

  // Mark the section of the site the visitor is in.
  const here = window.location.pathname;
  for (const link of nav.querySelectorAll<HTMLAnchorElement>('.nav-links a')) {
    const url = new URL(link.href);
    // "/#pricing" is a place on the home page, not a section every path starts with.
    if (url.hash || url.pathname === '/') continue;
    if (here.startsWith(url.pathname)) link.setAttribute('aria-current', 'page');
  }

  // Signed in on this tab: the nav says so instead of offering to sign in.
  const account = nav.querySelector<HTMLAnchorElement>('[data-nav-account]');
  try {
    if (account && window.sessionStorage.getItem('kovan.session'))
      account.textContent = t('Account');
  } catch {
    // Storage may be off; the link still goes to the account page.
  }
}

/**
 * Choosing a language with the nav or footer link is remembered. public/lang.js, which sends
 * Turkish devices to the Turkish pages before they are drawn, then leaves that person alone.
 */
function initLanguage(): void {
  const KEY = 'kovan.lang';
  document.addEventListener('click', (event) => {
    const link = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[hreflang]');
    const chosen = link?.getAttribute('hreflang');
    if (!chosen || (chosen !== 'en' && chosen !== 'tr')) return;
    try {
      window.localStorage.setItem(KEY, chosen);
    } catch {
      // Storage may be off; the choice just isn't remembered.
    }
  });
}

initLanguage();
initNav();
