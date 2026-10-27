import { app, Notification, type BrowserWindow } from 'electron';
import type { NotifyResult } from '../shared/api.js';

/** The part of Electron's Notification this module uses (a fake stands in for it in tests). */
export interface NativeNotification {
  on(event: 'show' | 'click' | 'close', listener: () => void): unknown;
  on(event: 'failed', listener: (event: unknown, error: string) => void): unknown;
  show(): void;
}

export interface NotifierDeps {
  isSupported(): boolean;
  create(options: { title: string; body: string }): NativeNotification;
  /** What to tell the person when the OS refuses, or null. */
  hint: string | null;
  log(message: string): void;
  /** How long to wait for the OS to answer before assuming the notification went out. */
  settleMs?: number;
}

export interface NotifyOptions {
  onClick?: () => void;
  /** Called when the OS won't show it, so the caller can ask for attention another way. */
  onBlocked?: () => void;
}

/** Notifications that may still be clicked. A collected one loses its click and is withdrawn. */
const KEEP = 50;

export function createNotifier(deps: NotifierDeps) {
  const live = new Set<NativeNotification>();
  let warned = false;

  return function notify(
    title: string,
    body: string,
    options: NotifyOptions = {},
  ): Promise<NotifyResult> {
    if (!deps.isSupported())
      return Promise.resolve({
        shown: false,
        error: 'Notifications are not supported here',
        hint: null,
      });
    const notification = deps.create({ title, body });
    live.add(notification);
    while (live.size > KEEP) live.delete(live.values().next().value!);
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result: NotifyResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      notification.on('show', () => settle({ shown: true }));
      notification.on('failed', (_event, error) => {
        live.delete(notification);
        if (!warned) {
          warned = true;
          deps.log(`Notifications are blocked: ${error}${deps.hint ? ` (${deps.hint})` : ''}`);
        }
        options.onBlocked?.();
        settle({ shown: false, error, hint: deps.hint });
      });
      notification.on('click', () => {
        live.delete(notification);
        options.onClick?.();
      });
      notification.on('close', () => live.delete(notification));
      // Not every platform reports 'show'; no error by then means it went out.
      const timer = setTimeout(() => settle({ shown: true }), deps.settleMs ?? 3000);
      notification.show();
    });
  };
}

function blockedHint(): string | null {
  if (process.platform !== 'darwin') return null;
  // `electron .` runs the stock, unsigned Electron.app; macOS only lets signed apps notify.
  if (!app.isPackaged)
    return 'macOS only lets signed apps post notifications, and development runs use the unsigned Electron app. A signed Kovan build can notify.';
  return 'Turn on notifications for Kovan in System Settings → Notifications.';
}

export const notifyNative = createNotifier({
  isSupported: () => Notification.isSupported(),
  create: (options) => new Notification(options),
  hint: blockedHint(),
  log: (message) => console.warn(message),
});

/** The quiet fallback when notifications are off: bounce the Dock icon or flash the taskbar. */
export function askForAttention(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed() || window.isFocused()) return;
  if (process.platform === 'darwin') {
    app.dock?.bounce('informational');
    return;
  }
  window.flashFrame(true);
  window.once('focus', () => window.flashFrame(false));
}
