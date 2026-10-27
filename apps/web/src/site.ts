import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/manrope';
import './styles/base.css';

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
    const path = new URL(link.href).pathname;
    if (here.startsWith(path)) link.setAttribute('aria-current', 'page');
  }
}

initNav();
