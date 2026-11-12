import type { Catalog } from '@kovan/shared/i18n';

/**
 * Turkish for the text the site's scripts put on screen. The English is the key (see
 * `@kovan/shared` i18n); anything missing here shows in English.
 */
export const TR: Catalog = {
  // Nav and download buttons
  Account: 'Hesap',
  'Download for {platform}': '{platform} için indir',
  'Windows on ARM': 'Windows (ARM)',
  'For this device': 'Bu cihaz için',
  Copy: 'Kopyala',
  Copied: 'Kopyalandı',

  // Home: what the agents in the animated windows do
  Wrote: 'Yazdı',
  Edited: 'Düzenledi',
  Editing: 'Düzenliyor',
  Ran: 'Çalıştırdı',
  Read: 'Okudu',
  Joined: 'Katıldı',
  'task graph · acceptance for each': 'görev grafiği · her görevin kabul ölçütü',
  'Plan: 4 tasks in 2 waves. Tests wait for the limiter.':
    'Plan: 2 dalgada 4 görev. Testler sınırlayıcıyı bekliyor.',
  'Token bucket in middleware, keyed by API token.':
    'Ara katmanda bir token kovası, API anahtarına göre.',
  'Waiting for “Limiter” before writing tests.': 'Testleri yazmak için “Sınırlayıcı”yı bekliyor.',
  '✓ typecheck passed': '✓ typecheck geçti',
  '@Tests cover the 429 path before review.': '@Testler, incelemeden önce 429 yolunu da kapsayın.',
  '✓ {count} tests passed': '✓ {count} test geçti',
  '✓ Reviewed · 4/4 tasks · verified': '✓ İncelendi · 4/4 görev · doğrulandı',
  'Add a token bucket to the public routes.': 'Herkese açık rotalara bir token kovası ekle.',
  'Review the 429 path when it lands.': '429 yolu gelince gözden geçir.',
  'Bob is on limits.ts. Joining his task instead.':
    'Bob limits.ts üzerinde çalışıyor. Onun görevine katılıyorum.',
  'Bob · split: routes for me': 'Bob · bölüşüm: rotalar bende',
  'Handing “wire routes” to Ada, plan attached.':
    '“Rotaları bağla” görevini planıyla birlikte Ada’ya devrediyorum.',
  '✓ Picked up: wire routes': '✓ Üstlenildi: rotaları bağla',
  'Add rate limiting to the public API, with a burst test.':
    'Herkese açık API’ye istek sınırı ekle, ani yük testiyle birlikte.',

  // Home: JevRouter picking a model for each prompt
  'Design the plugin API and its versioning': 'Eklenti API’sini ve sürümlemesini tasarla',
  'design · difficulty 4/5': 'tasarım · zorluk 4/5',
  'Rename userId to accountId in utils.ts': 'utils.ts içinde userId’yi accountId yap',
  'edit · difficulty 1/5': 'düzenleme · zorluk 1/5',
  'Fix the failing auth test': 'Başarısız olan auth testini düzelt',
  'debug · difficulty 3/5': 'hata ayıklama · zorluk 3/5',
  'How do the packages of this repo fit together?':
    'Bu deponun paketleri birbirine nasıl bağlanıyor?',
  'read · whole repo': 'okuma · tüm depo',
  'review this migration': 'bu migration’ı incele',
  'pinned by directive': 'yönergeyle sabitlendi',
  'reading the conversation…': 'konuşmayı okuyor…',
};
