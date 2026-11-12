/**
 * The terminal agent in the terminal's language: KOVAN_LANG, else the usual LC_ALL /
 * LC_MESSAGES / LANG ("tr_TR.UTF-8" → Turkish). The English text is the key; what the catalog
 * doesn't have stays English.
 */
const env = process.env;
const wanted = (env['KOVAN_LANG'] || env['LC_ALL'] || env['LC_MESSAGES'] || env['LANG'] || '')
  .toLowerCase()
  .trim();

export const LOCALE: 'en' | 'tr' = wanted.startsWith('tr') ? 'tr' : 'en';

const TR: Readonly<Record<string, string>> = {
  'Kovan needs a model to work with. Choose how:':
    'Kovan’ın çalışmak için bir yapay zekâ modeline ihtiyacı var. Nasıl olacağını seçin:',
  '  1  Paste an OpenRouter key (kept in {file}, readable only by you)':
    '  1  Bir OpenRouter anahtarı yapıştırın ({file} içinde, yalnız sizin okuyabileceğiniz şekilde saklanır)',
  '  2  Sign in to a Kovan account and pay for models through Kovan (opens your browser)':
    '  2  Bir Kovan hesabıyla giriş yapın ve modelleri Kovan üzerinden ödeyin (tarayıcınız açılır)',
  '  3  Use a gateway of your own (an OpenAI-compatible address, a local model say)':
    '  3  Kendi sunucunuzu kullanın (OpenAI uyumlu bir adres, örneğin yerel bir model)',
  '  q  Not now': '  q  Şimdi değil',
  '1, 2, 3 or q › ': '1, 2, 3 ya da q › ',
  "Nothing was set up. Run 'kovan setup' when you're ready.":
    "Hiçbir şey kurulmadı. Hazır olduğunuzda 'kovan setup' çalıştırın.",
  'OpenRouter key (get one at https://openrouter.ai/keys) › ':
    'OpenRouter anahtarı (https://openrouter.ai/keys adresinden alabilirsiniz) › ',
  "That doesn't look like an OpenRouter key: they start with sk-or-. Try again.":
    'Bu bir OpenRouter anahtarına benzemiyor: sk-or- ile başlarlar. Yeniden deneyin.',
  "Key saved in {file}. To change it later, run 'kovan setup'.":
    "Anahtar {file} içine kaydedildi. Sonra değiştirmek için 'kovan setup' çalıştırın.",
  'Address (for example http://localhost:11434/v1) › ':
    'Adres (örneğin http://localhost:11434/v1) › ',
  "That isn't an http:// or https:// address. Try again.":
    'Bu bir http:// ya da https:// adresi değil. Yeniden deneyin.',
  'Model name, as the gateway calls it › ': 'Model adı, sunucunun verdiği adla › ',
  'Key, if it needs one (Enter for none) › ': 'Anahtar, gerekiyorsa (yoksa Enter) › ',
  "Saved in {file}. To change it later, run 'kovan setup'.":
    "{file} içine kaydedildi. Sonra değiştirmek için 'kovan setup' çalıştırın.",
  'Type 1, 2, 3 or q.': '1, 2, 3 ya da q yazın.',
  "No model is set up yet. Run 'kovan setup' to choose one: an OpenRouter key, your Kovan account, or a gateway of your own. (Or set OPENROUTER_API_KEY, or KOVAN_BASE_URL with KOVAN_MODEL.)":
    "Henüz bir model kurulmadı. Seçmek için 'kovan setup' çalıştırın: bir OpenRouter anahtarı, Kovan hesabınız ya da kendi sunucunuz. (Ya da OPENROUTER_API_KEY, veya KOVAN_MODEL ile KOVAN_BASE_URL ayarlayın.)",
  'working… esc to stop': 'çalışıyor… durdurmak için esc',
  'type something · / commands · \\+enter new line':
    'bir şey yazın · / komutlar · \\+enter yeni satır',
  yes: 'evet',
  no: 'hayır',
  'always this command this session': 'bu oturumda bu komuta hep izin ver',
  'plan only': 'yalnız plan',
  'ask first': 'önce sor',
  'edit freely': 'serbestçe düzenle',
  'full access (never asks)': 'tam erişim (hiç sormaz)',
  'mode: ask first · /mode full never asks': 'mod: önce sor · /mode full hiç sormaz',
  'mode: {mode}': 'mod: {mode}',
  'thinks: {effort}': 'düşünme: {effort}',
  "There's no folder at {path}.": '{path} konumunda bir klasör yok.',
  'Updates are off (KOVAN_NO_UPDATE is set).': 'Güncellemeler kapalı (KOVAN_NO_UPDATE ayarlı).',
  'Up to date.': 'Güncel.',
  "there's no model called {id} here; /models lists them":
    'burada {id} adında bir model yok; /models hepsini listeler',
  "that account isn't in the desktop app any more": 'bu hesap artık masaüstü uygulamasında yok',
  'Kovan account (billed through Kovan)': 'Kovan hesabı (ödeme Kovan üzerinden)',
  'OpenRouter (your key)': 'OpenRouter (sizin anahtarınız)',
  'your Claude sign-in on this computer (your plan)':
    'bu bilgisayardaki Claude girişiniz (kendi planınız)',
  'your ChatGPT sign-in on this computer (your plan)':
    'bu bilgisayardaki ChatGPT girişiniz (kendi planınız)',
  'your Claude account': 'Claude hesabınız',
  'your ChatGPT account': 'ChatGPT hesabınız',
  'this computer': 'bu bilgisayar',
  'enter send · \\+enter or alt+enter new line · ↑↓ history':
    'enter gönder · \\+enter ya da alt+enter yeni satır · ↑↓ geçmiş',
  'tab: edit freely → plan only → ask first (full access: /mode full)':
    'tab: serbestçe düzenle → yalnız plan → önce sor (tam erişim: /mode full)',
  'esc stops the running turn': 'esc çalışan turu durdurur',
  'pageup / pagedown scroll · end jump to the bottom · ctrl+l redraw':
    'pageup / pagedown kaydır · end en alta git · ctrl+l yeniden çiz',
  '/resume an earlier chat · /rename <name> names this one':
    '/resume önceki bir sohbet · /rename <ad> bunu adlandırır',
  'kovan -r <name> opens a chat from the shell': 'kovan -r <ad> kabuktan bir sohbeti açar',
  'ctrl+p command palette · / suggests commands and skills':
    'ctrl+p komut paleti · / komut ve becerileri önerir',
  'ctrl+a / ctrl+e line start / end · ctrl+w delete a word':
    'ctrl+a / ctrl+e satır başı / sonu · ctrl+w kelime sil',
  'ctrl+u / ctrl+k delete to start / end of line':
    'ctrl+u / ctrl+k satırın başına / sonuna kadar sil',
  'ctrl+c stops a turn; twice when idle quits · ctrl+d quits':
    'ctrl+c turu durdurur; boştayken iki kez çıkar · ctrl+d çıkar',
  'when it asks: y yes · n no · a always for this command':
    'sorduğunda: y evet · n hayır · a bu komuta hep izin ver',
};

export function t(text: string, values?: Record<string, string | number>): string {
  const out = (LOCALE === 'tr' && TR[text]) || text;
  return values
    ? out.replace(/\{(\w+)\}/g, (all, k: string) => (k in values ? String(values[k]) : all))
    : out;
}
