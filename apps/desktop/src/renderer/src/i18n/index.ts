import { pickLocale, translator, type Locale } from '@kovan/shared';
import { getState, useStore } from '../store';
import { TR } from './tr';

/** The app's language now: the setting, or the system's when it is "system". */
export function appLocale(): Locale {
  const { settings, appInfo } = getState();
  return settings.language === 'system' ? pickLocale(appInfo?.locale) : settings.language;
}

/** The language, as a hook: the app's root keys itself on it, so a change redraws everything. */
export function useLocale(): Locale {
  const language = useStore((s) => s.settings.language);
  const system = useStore((s) => s.appInfo?.locale);
  return language === 'system' ? pickLocale(system) : language;
}

/**
 * Text in the app's language. The English is the key; what the Turkish catalog doesn't have
 * yet stays English. `{name}` is filled from `values`.
 */
export function t(text: string, values?: Record<string, string | number>): string {
  return translator(appLocale() === 'tr' ? TR : null)(text, values);
}
