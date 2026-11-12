import { pickLocale, translator } from '@kovan/shared/i18n';
import { TR } from './tr';

/** The page's language, from `<html lang>`: Turkish pages live under /tr/. */
export const locale = pickLocale(document.documentElement.lang);

/** Text a page script puts on screen, in the page's language (English when there's no entry). */
export const t = translator(locale === 'tr' ? TR : null);
