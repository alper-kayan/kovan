import { useEffect, useId, useRef, useState } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Makes the `.modal` it sits in a real dialog: announced as one (named by its title), focus
 * moves in and can't Tab out behind the scrim, Esc closes it (unless a menu inside is open),
 * and focus goes back to whatever opened it.
 */
export function DialogKeys({ onClose }: { onClose: () => void }) {
  const marker = useRef<HTMLSpanElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const titleId = useId();
  // Taken while rendering, before a field inside grabs focus with autoFocus.
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  useEffect(() => {
    const dialog = marker.current?.closest<HTMLElement>('.modal');
    if (!dialog) return;
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const title = dialog.querySelector<HTMLElement>('.modal-title');
    if (title && !dialog.hasAttribute('aria-label')) {
      title.id ||= titleId;
      dialog.setAttribute('aria-labelledby', title.id);
    }
    if (!dialog.hasAttribute('tabindex')) dialog.tabIndex = -1;
    const focusables = () =>
      [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.getClientRects().length > 0,
      );
    if (!dialog.contains(document.activeElement)) (focusables()[0] ?? dialog).focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // A menu open inside (an @ list, say) closes first, by its own key handling.
        if (dialog.querySelector('.menu')) return;
        e.preventDefault();
        e.stopPropagation();
        close.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const list = focusables();
      if (list.length === 0) return;
      const first = list[0]!;
      const last = list[list.length - 1]!;
      const at = document.activeElement;
      if (!dialog.contains(at)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && at === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && at === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (opener?.isConnected) opener.focus();
    };
  }, [titleId, opener]);

  return <span ref={marker} hidden />;
}
