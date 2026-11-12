import * as Updates from 'expo-updates';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { locale, t } from './i18n';

/** How often the app asks the server for a new update while it stays open. */
export const CHECK_EVERY_MS = 30 * 60 * 1000;
/** Away this long with an update downloaded, the app switches to it on return. */
export const SWITCH_AFTER_AWAY_MS = 10 * 60 * 1000;

/**
 * What to do when the app comes back to the screen. The app checks for updates by itself when
 * it starts; an app left open for days needs asking again. A downloaded update starts on the
 * next launch, or when the person was away long enough not to be in the middle of something.
 */
export function onReturn(input: {
  now: number;
  lastCheck: number;
  awaySince: number | null;
  pending: boolean;
}): 'switch' | 'check' | 'nothing' {
  if (
    input.pending &&
    input.awaySince !== null &&
    input.now - input.awaySince >= SWITCH_AFTER_AWAY_MS
  )
    return 'switch';
  if (!input.pending && input.now - input.lastCheck >= CHECK_EVERY_MS) return 'check';
  return 'nothing';
}

/** Checks for and downloads updates in the background; a store or dev build without them does nothing. */
export function useUpdateWatcher(): void {
  const { isUpdatePending } = Updates.useUpdates();
  const pending = useRef(isUpdatePending);
  pending.current = isUpdatePending;
  useEffect(() => {
    if (!Updates.isEnabled || __DEV__) return;
    let lastCheck = Date.now();
    let awaySince: number | null = null;
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        awaySince ??= Date.now();
        return;
      }
      const now = Date.now();
      const action = onReturn({ now, lastCheck, awaySince, pending: pending.current });
      awaySince = null;
      if (action === 'switch') void Updates.reloadAsync().catch(() => {});
      if (action === 'check') {
        lastCheck = now;
        void (async () => {
          const check = await Updates.checkForUpdateAsync();
          if (check.isAvailable || check.isRollBackToEmbedded) await Updates.fetchUpdateAsync();
        })().catch(() => {
          // Offline or the server is down: the next return tries again.
        });
      }
    });
    return () => sub.remove();
  }, []);
}

/** What the Account screen shows about the code the app runs. */
export function runningUpdate(): string {
  if (__DEV__ || !Updates.isEnabled) return t('Development');
  if (Updates.isEmbeddedLaunch || !Updates.updateId) return t('Built in');
  const at = Updates.createdAt;
  const day = at
    ? at.toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' })
    : '';
  return `${Updates.updateId.slice(0, 8)}${day ? ` · ${day}` : ''}`;
}
