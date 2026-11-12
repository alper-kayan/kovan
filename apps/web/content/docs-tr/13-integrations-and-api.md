# Entegrasyonlar ve API

Başka sistemler Kovan'da iş başlatıp onu takip edebilir: bir görevi bir ajana veren bir iş takip aracı, bir oturum bitince haber veren bir sohbet botu gibi. Bunu sahipler masaüstü uygulamasından kurar.

## Nerede

- **Ayarlar → Organizasyon → Entegrasyonlar** (Settings → Organization → Integrations), organizasyonun sonradan açılanlar dahil tüm çalışma alanları için geçerlidir. Genellikle istediğiniz budur.
- **Ayarlar → Çalışma alanları → Entegrasyonlar** (Settings → Workspaces → Integrations) aynısını yalnızca tek bir çalışma alanı için yapar.

## API anahtarları

Bir anahtar (`kv_live_` ile başlar) yalnızca oluşturulduğunda, bir kez gösterilir: güvenli bir yerde saklayın. Kendi başına bir üye gibi davranır; bu yüzden kişiler ayrılınca da çalışmaya devam eder ve üyeleri, ayarları ya da ödemeyi asla değiştiremez. Yalnızca gerektiği kapsamları seçin:

| Kapsam     | Neler yapabilir                                               |
| ---------- | ------------------------------------------------------------- |
| `read`     | Çalışma alanlarını, oturumları, planları ve olay akışını okur |
| `dispatch` | Oturum başlatır ve ajanlara iş gönderir                       |
| `control`  | Süren işi durdurur, yönlendirir ve başkasına verir            |
| `machine`  | İş alan bir [makine](/tr/docs/machines/) olarak çalışır       |

Anahtarı `Authorization: Bearer kv_live_…` olarak gönderin.

## Webhook'lar

Bir webhook, Kovan'ın olaylarını olurken sizin bir adresinize gönderir. Gizli anahtarı (secret) bir kez gösterilir; her gönderim bir `x-kovan-signature` başlığı taşır: `sha256=` ve ardından gövdenin o gizli anahtarla HMAC-SHA256'sı. Böylece gönderimin Kovan'dan geldiğini doğrulayabilirsiniz. **Deneme gönder** (Send test) örnek bir olay gönderir; gönderim kaydı neyin gönderildiğini ve sunucunuzun ne cevap verdiğini gösterir.

## Olay akışı

Kendi sunucunuz yoksa aynı olayları bir anahtarla okuyun: `GET /api/workspaces/<id>/events?since=<cursor>&wait=25` yeni olaylar için 25 saniyeye kadar bekler ve bir sonraki çağrı için bir imleç (cursor) döndürür. Organizasyon için aynısı `/api/orgs/<id>/events` adresindedir.
