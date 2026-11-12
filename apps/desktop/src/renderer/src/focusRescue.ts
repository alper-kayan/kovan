/**
 * When the control that had focus goes away (an Approve button once answered, a menu item once
 * picked, a page left for another), focus would fall to the page body and a screen reader would
 * go quiet. Instead it lands somewhere sensible in the same part of the window: the chat box in
 * an agent panel, the menu's button, or the page's title.
 */
const PLACES = '.agent-panel, .lane, .modal, .settings-main, .page, .side, .editor-area';

export function installFocusRescue(): () => void {
  const onFocusOut = (e: FocusEvent) => {
    const from = e.target;
    if (!(from instanceof HTMLElement)) return;
    const place = from.closest<HTMLElement>(PLACES);
    const opener = from
      .closest('.menu')
      ?.parentElement?.querySelector<HTMLElement>('[aria-haspopup], [aria-expanded]');
    setTimeout(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      if (from.isConnected) return; // it was just a click elsewhere, not a removal
      const target =
        (opener?.isConnected ? opener : null) ??
        (place?.isConnected
          ? (place.querySelector<HTMLElement>('textarea:not([disabled])') ??
            place.querySelector<HTMLElement>('h1, h2, [role="heading"]'))
          : null) ??
        document.querySelector<HTMLElement>('.page-title, .settings-title');
      if (!target) return;
      if (!target.matches('textarea, input, button, select, a[href], [tabindex]'))
        target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }, 0);
  };
  document.addEventListener('focusout', onFocusOut);
  return () => document.removeEventListener('focusout', onFocusOut);
}
