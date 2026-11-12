import { translator, type Locale } from '@kovan/shared';

/**
 * The main process's words (the reasons an agent can't start, shown before sending) in the
 * app's language. index.ts sets the language from the settings.
 */
let locale: Locale = 'en';
export function setMainLocale(next: Locale): void {
  locale = next;
}

const TR: Readonly<Record<string, string>> = {
  "{name} isn't set up in Kovan yet. In Settings → Agents, use this computer's {name} sign-in, or add a separate account.":
    "{name} henüz Kovan'da kurulu değil. Ayarlar → Ajanlar'da bu bilgisayardaki {name} girişini kullanın ya da ayrı bir hesap ekleyin.",
  '{name} is out of usage for now.': '{name} şimdilik kullanım limitine ulaştı.',
  "{name}'s account in Kovan needs signing in again.":
    "{name} hesabının Kovan'da yeniden giriş yapması gerekiyor.",
  "{name} isn't installed on this computer.": '{name} bu bilgisayarda kurulu değil.',
  'The provider "{name}" isn\'t set up any more.': '"{name}" sağlayıcısı artık kurulu değil.',
  "Kovan's agent needs a model to call. {why}":
    "Kovan'ın ajanının çağıracağı bir model gerekiyor. {why}",
  "Kovan's agent needs a model to call: add your OpenRouter key, or a provider of your own.":
    "Kovan'ın ajanının çağıracağı bir model gerekiyor: OpenRouter anahtarınızı ya da kendi sağlayıcınızı ekleyin.",
  'Auto has nothing to pick from: your order is empty.':
    "Auto'nun seçebileceği bir şey yok: sıranız boş.",
  'Nothing in your order can start yet. {why}': 'Sıranızdaki hiçbir şey henüz başlayamıyor. {why}',
};

export function mt(text: string, values?: Record<string, string | number>): string {
  return translator(locale === 'tr' ? TR : null)(text, values);
}
