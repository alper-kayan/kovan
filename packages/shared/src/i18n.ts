/**
 * Kovan in more than one language. Text is written in English in the code, and the English is
 * also the key: `t('Sign in')` is "Sign in" in English and the Turkish catalog's entry for it in
 * Turkish. Anything a catalog doesn't have yet stays English, so screens can move over one at a
 * time. `{name}` in a text is filled from the values passed with it.
 */

export const LOCALES = ['en', 'tr'] as const;
export type Locale = (typeof LOCALES)[number];

/** The language a person's setting or system asks for, as one Kovan has ("tr-TR" → "tr"). */
export function pickLocale(...wanted: (string | null | undefined)[]): Locale {
  for (const tag of wanted) {
    const base = tag?.trim().toLowerCase().split(/[-_]/)[0];
    if (base && (LOCALES as readonly string[]).includes(base)) return base as Locale;
  }
  return 'en';
}

/** The first language of an Accept-Language header that Kovan has. */
export function localeFromHeader(header: string | undefined | null): Locale {
  const tags = (header ?? '')
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.find((p) => p.trim().startsWith('q='));
      return { tag: tag ?? '', q: q ? Number(q.trim().slice(2)) || 0 : 1 };
    })
    .sort((a, b) => b.q - a.q)
    .map((x) => x.tag);
  return pickLocale(...tags);
}

export type Catalog = Readonly<Record<string, string>>;

/** Puts `{name}` values into a text. */
export function fill(text: string, values?: Record<string, string | number>): string {
  if (!values) return text;
  return text.replace(/\{(\w+)\}/g, (all, key: string) =>
    key in values ? String(values[key]) : all,
  );
}

/** A `t` for one language: the catalog's text when it has one, the English otherwise. */
export function translator(
  catalog: Catalog | null,
): (text: string, values?: Record<string, string | number>) => string {
  return (text, values) => fill(catalog?.[text] ?? text, values);
}

/** The language names as each language writes its own. */
export const LOCALE_NAMES: Record<Locale, string> = { en: 'English', tr: 'Türkçe' };
