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
  "kovan {version}: Kovan's coding agent in the terminal.":
    "kovan {version}: Kovan'ın terminaldeki kodlama ajanı.",
  'Start here': 'Buradan başlayın',
  'chat with the agent in this folder': 'bu klasörde ajanla sohbet edin',
  'give it one task: it does the work and exits': 'ona tek bir görev verin: işi yapar ve çıkar',
  'carry on with the last chat in this folder': 'bu klasördeki son sohbete devam edin',
  'first time: choose the AI model (a key, your Kovan account, or your own server)':
    'ilk kez: yapay zekâ modelini seçin (bir anahtar, Kovan hesabınız ya da kendi sunucunuz)',
  More: 'Daha fazlası',
  'continue a chat by its name or id, in its own folder':
    'bir sohbeti adı ya da kimliğiyle, kendi klasöründe sürdürün',
  'your chats (the same list as in the Kovan desktop app)':
    'sohbetleriniz (Kovan masaüstü uygulamasındakiyle aynı liste)',
  'a summary of one chat (JSON)': 'bir sohbetin özeti (JSON)',
  'sign in to a Kovan account (confirmed in the browser)':
    'bir Kovan hesabına giriş yapın (tarayıcıda onaylanır)',
  'sign out | who you are signed in as': 'çıkış yap | hangi hesapla girdiğiniz',
  'update itself': 'kendini güncelle',
  'which server and model it talks to': 'hangi sunucu ve modelle konuştuğu',
  Options: 'Seçenekler',
  'the AI model (see /models in a chat)': "yapay zekâ modeli (sohbette /models'a bakın)",
  'how much it may do without asking: plan (only reads) · request (asks before every edit and command) · allow (edits freely, asks before commands; the default) · full (never asks)':
    '      sormadan ne kadar yapabileceği: plan (yalnız okur) · request (her düzenleme ve komuttan önce sorar) · allow (özgürce düzenler, komutlardan önce sorar; varsayılan) · full (hiç sormaz)',
  'how hard the model thinks, for models that can: low, medium, high (or none … max)':
    'düşünebilen modeller için ne kadar derin düşüneceği: low, medium, high (ya da none … max)',
  'a file of extra instructions for the agent': 'ajan için ek yönergeler içeren bir dosya',
  "show the model's thinking": 'modelin düşüncesini göster',
  'work in another folder': 'başka bir klasörde çalış',
  "The AI: 'kovan setup' picks it. Your own key comes first (OPENROUTER_API_KEY, or a server of your own with KOVAN_BASE_URL + KOVAN_MODEL); without one, your Kovan account from 'kovan login' (Kovan bills you what the model costs plus 5%). Claude Code and Codex, if installed, run on your own plan: pick them with /models. Chats also show in the Kovan desktop app.":
    "Yapay zekâ: 'kovan setup' seçtirir. Önce kendi anahtarınız gelir (OPENROUTER_API_KEY ya da KOVAN_BASE_URL + KOVAN_MODEL ile kendi sunucunuz); yoksa 'kovan login' ile Kovan hesabınız (Kovan size modelin maliyetini ve %5 fazlasını faturalar). Claude Code ve Codex kuruluysa kendi planınızda çalışır: /models ile seçin. Sohbetler Kovan masaüstü uygulamasında da görünür.",
  'Reads what Claude Code reads: skills in the repository and in ~/.claude (/skill-name), CLAUDE.md / AGENTS.md / KOVAN.md, ~/.claude/CLAUDE.md, .claude/commands/*.md (custom commands). KOVAN_NO_CLAUDE=1 turns all of that off.':
    "Claude Code'un okuduklarını okur: depodaki ve ~/.claude içindeki beceriler (/beceri-adı), CLAUDE.md / AGENTS.md / KOVAN.md, ~/.claude/CLAUDE.md, .claude/commands/*.md (özel komutlar). KOVAN_NO_CLAUDE=1 bunların hepsini kapatır.",
  'In a chat: /help /mode /model /models /clear /cost /context /skills /exit':
    'Sohbette: /help /mode /model /models /clear /cost /context /skills /exit',
  '{flag} needs a value': '{flag} bir değer ister',
  "Unknown mode '{v}'. Choose one of: {list}.":
    "Bilinmeyen kip '{v}'. Şunlardan birini seçin: {list}.",
  "Unknown effort '{v}'. Choose one of: {list}.":
    "Bilinmeyen düzey '{v}'. Şunlardan birini seçin: {list}.",
  "Unknown option '{arg}'. See 'kovan --help'.":
    "Bilinmeyen seçenek '{arg}'. 'kovan --help' komutuna bakın.",
  "'kovan sessions export' needs a chat id: see 'kovan sessions'.":
    "'kovan sessions export' bir sohbet kimliği ister: 'kovan sessions' komutuna bakın.",
  "'{word}' is not a command. Did you mean 'kovan {guess}'? To give the agent a task, write it as a sentence in quotes.":
    "'{word}' bir komut değil. 'kovan {guess}' mu demek istediniz? Ajana görev vermek için onu tırnak içinde bir cümle olarak yazın.",
  "You weren't signed in.": 'Zaten giriş yapmamıştınız.',
  'Signed out.': 'Çıkış yapıldı.',
  "You're not signed in. Sign in with 'kovan login'.":
    "Giriş yapmadınız. 'kovan login' ile giriş yapın.",
  'No chats yet.': 'Henüz sohbet yok.',
  'No chat to continue in this folder; starting a new one.':
    'Bu klasörde devam edilecek sohbet yok; yenisi başlatılıyor.',
  'Cleared: new chat.': 'Temizlendi: yeni sohbet.',
  'Unknown command. See /help and /skills.': "Bilinmeyen komut. /help ve /skills'e bakın.",
  "No model is set up yet. Run 'kovan setup' in a terminal to choose one, or set OPENROUTER_API_KEY.":
    "Henüz bir model kurulmadı. Seçmek için bir terminalde 'kovan setup' çalıştırın ya da OPENROUTER_API_KEY ayarlayın.",
  "'kovan setup' asks questions: run it in a terminal.":
    "'kovan setup' sorular sorar: bir terminalde çalıştırın.",
  'Signed in: {name} ({server})': 'Giriş yapıldı: {name} ({server})',
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
