import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { t } from './i18n';
import { useSession } from './session';

/** Said under a button that needs Kovan open on the person's computer while it isn't. */
export const desktopOffline = () =>
  t("Needs Kovan open on your computer, and it isn't right now. Open it there, then try again.");

/**
 * Whether Kovan is open on one of the person's computers. Buttons that hand work to the
 * desktop say so before they're pressed, instead of failing after. Null while it's unknown.
 */
export function useDesktopOnline(): boolean | null {
  const { api, status } = useSession();
  const [online, setOnline] = useState<boolean | null>(null);
  useEffect(() => {
    if (status !== 'signedIn') return;
    let live = true;
    const check = () =>
      void api<{ desktopOnline: boolean }>('GET', '/api/desk/status')
        .then((r) => live && setOnline(r.desktopOnline))
        .catch(() => undefined);
    check();
    const timer = setInterval(check, 20_000);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') check();
    });
    return () => {
      live = false;
      clearInterval(timer);
      sub.remove();
    };
  }, [api, status]);
  return online;
}
