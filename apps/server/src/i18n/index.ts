import { AsyncLocalStorage } from 'node:async_hooks';
import { localeFromHeader, pickLocale, translator, type Locale } from '@kovan/shared';
import { TR } from './tr.js';

const CATALOGS: Record<Locale, Readonly<Record<string, string>> | null> = { en: null, tr: TR };

/** The language of the request being handled: what the app asked for, or the browser's. */
const current = new AsyncLocalStorage<Locale>();

export function runInLocale<T>(locale: Locale, fn: () => T): T {
  return current.run(locale, fn);
}

/** An app says its language with `x-kovan-locale`; a browser with Accept-Language. */
export function requestLocale(headers: Record<string, string | string[] | undefined>): Locale {
  const asked = headers['x-kovan-locale'];
  if (typeof asked === 'string' && asked) return pickLocale(asked);
  const accept = headers['accept-language'];
  return localeFromHeader(typeof accept === 'string' ? accept : undefined);
}

export function currentLocale(): Locale {
  return current.getStore() ?? 'en';
}

/** Text in the language of the request being handled (English outside a request). */
export function t(text: string, values?: Record<string, string | number>): string {
  return translator(CATALOGS[currentLocale()])(text, values);
}

/** Text in a given language: for someone other than who is asking (an invitee, a phone). */
export function tFor(
  locale: Locale | string | null | undefined,
): (text: string, values?: Record<string, string | number>) => string {
  return translator(CATALOGS[pickLocale(locale)]);
}
