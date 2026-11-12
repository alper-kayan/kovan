# Yapay zekâ modelleri ve JevRouter

Kovan'ın kendi ajanı OpenRouter üzerinden yüzlerce modeli kullanabilir ([güncel liste](/models/)). Modeli kendiniz seçebilir ya da her görev için seçimi JevRouter'a bırakabilirsiniz.

## Katalog

[Modeller sayfası](/models/) her modeli bağlam boyutu ve milyon token başına fiyatıyla listeler. Aynı katalog uygulamada da var; orada hangi modellerin araç kullanabildiği, görsel okuyabildiği ve akıl yürütebildiği de görünür.

## Model seçmek

Mesaj kutusunda tek bir model düğmesi var. Tıklayınca fiyatları ve bağlam boyutlarıyla aranabilir bir liste açılır. Akıl yürütebilen modellerde efor seviyeleri de görünür.

Mesaj kutusu, bir sonraki turda tam olarak hangi modelin çalışacağını ve parasını kimin ödeyeceğini her zaman gösterir.

## Kendi anahtarınız ya da Kovan üzerinden ödeme

Modellerin parasını iki şekilde ödeyebilirsiniz:

- **Kendi OpenRouter anahtarınız.** Kovan onu işletim sisteminizin anahtar zincirinde saklar. OpenRouter'a doğrudan ödersiniz, Kovan üstüne bir şey eklemez.
- **Kovan üzerinden ödeme.** Modeli sizin yerinize Kovan'ın sunucusu çağırır ve size sağlayıcının maliyetinin × 1.05'ini faturalar. Bkz. [Yapay zekâ için ödeme](/tr/docs/managed-usage-and-billing/).

OpenAI uyumlu herhangi bir uç noktayı da **Ayarlar → Model anahtarları ve harcama** (Settings → Model keys & spend) bölümünden özel sağlayıcı olarak ekleyebilirsiniz.

## JevRouter

JevRouter her iş için tek bir model kullanmak yerine her göreve bir model seçer. Açmak için model listesinden **JevRouter**'ı seçin.

### Nasıl karar verir

- **Konuşmanın tamamını okur.** Karar yalnız son mesajınıza değil, o ana kadarki konuşmaya, açık plan adımına ve son araç sonuçlarına dayanır.
- **Kademelerle çalışır.** Modeller ekonomik, dengeli ve en güçlü (frontier) olarak gruplanır. Küçük sorular ve düzenlemeler ucuz modellere, birden çok dosyaya dokunan değişiklikler ve zor hata ayıklama güçlü modellere gider. Bağlam sığmıyorsa daha uzun bağlamlı bir modele geçer.
- **Önbelleği sıcak tutar.** Model yalnızca görev değişince değişir. Aynı görev içinde model sabit kalır, böylece istem önbelleği (prompt caching) çalışmaya devam eder.
- **Gerekince bir üst kademeye çıkar.** Üst üste başarısız düzenlemeler, araç hataları ya da geçmeyen testler görevi bir üst kademeye taşır.

### Yön vermek

İstemin herhangi bir yerine bir yönerge yazın. Yönerge, model metni görmeden önce silinir.

| Yönerge                                                | Etkisi                             |
| ------------------------------------------------------ | ---------------------------------- |
| `[jev: only use Opus]`                                 | Bir modeli adıyla sabitler.        |
| `[jev: economy]`, `[jev: balanced]`, `[jev: frontier]` | O kademeyi kullanır.               |
| `[jev: max balanced]`                                  | O kademenin üstüne hiç çıkmaz.     |
| `[jev: auto]`                                          | Otomatik yönlendirmeye geri döner. |

### Maliyeti

Yönlendirme kararlarını küçük bir model verir ve bu çağrılar da çalışmanın maliyetine dahildir. Her turun maliyeti, sağlayıcı bildirdiğinde turun altında görünür.

> Ana sayfadaki animasyonlar yönlendirmenin ve Arena'nın nasıl çalıştığını gösterir. Oradaki sayılar karşılaştırma testi sonucu değildir. JevRouter'ın ne kadar tasarruf ettireceği sizin işinize bağlıdır.

## Harcama

**Ayarlar → Model anahtarları ve harcama** her çalışma alanının ne harcadığını gösterir. Bir oturumun yan panelinde de tur başına kullanım görünür.
