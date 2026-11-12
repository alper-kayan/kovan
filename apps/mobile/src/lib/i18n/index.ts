import { pickLocale, translator, type Locale } from '@kovan/shared';
import { useSyncExternalStore } from 'react';
import { tr } from './tr';

export type { Locale };

/** What the person picked in Account: the phone's own language, or one of Kovan's. */
export type LanguageChoice = 'system' | Locale;

const CATALOGS: Record<Locale, Readonly<Record<string, string>> | null> = { en: null, tr };

/**
 * The phone's language ("tr-TR"); English when the runtime can't say. Development builds stay
 * English unless a language is picked in Account: the Maestro flows read English texts, on
 * simulators set to any language.
 */
export function deviceLocale(): Locale {
  if (typeof __DEV__ !== 'undefined' && __DEV__) return 'en';
  try {
    return pickLocale(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return 'en';
  }
}

let choice: LanguageChoice = 'system';
let current: Locale = deviceLocale();
let translate = translator(CATALOGS[current]);
const listeners = new Set<() => void>();

/**
 * Text for people in the app's language. The English is the key; a text the catalog doesn't
 * have stays English. `{name}` is filled from `values`.
 */
export function t(text: string, values?: Record<string, string | number>): string {
  return translate(text, values);
}

/** The language the app shows now. */
export const locale = (): Locale => current;

/** What the person picked ("system" until they pick one). */
export const languageChoice = (): LanguageChoice => choice;

/** Switches the app's language; every screen that reads it with `useLocale` draws again. */
export function setLanguage(next: LanguageChoice): void {
  const resolved = next === 'system' ? deviceLocale() : next;
  if (next === choice && resolved === current) return;
  choice = next;
  current = resolved;
  translate = translator(CATALOGS[current]);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The app's language, for a component: calling it makes the component draw again when the
 * language changes (screens don't redraw on their own when their navigator does).
 */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, locale, locale);
}

/** What the person picked, for the Account screen's choice. */
export function useLanguageChoice(): LanguageChoice {
  return useSyncExternalStore(subscribe, languageChoice, languageChoice);
}

/** A workspace or organization role as a word ("editor"), in the app's language. */
export function roleName(role: string): string {
  switch (role) {
    case 'viewer':
      return t('viewer');
    case 'commenter':
      return t('commenter');
    case 'editor':
      return t('editor');
    case 'owner':
      return t('owner');
    case 'member':
      return t('member');
    default:
      return role;
  }
}
