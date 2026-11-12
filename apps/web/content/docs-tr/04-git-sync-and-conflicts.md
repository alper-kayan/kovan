# Değişiklikleri paylaşmak ve çakışmaları çözmek

Doğrunun kaynağı Git'tir. Kodunuz sizin checkout'larınızda yaşar ve sizin kimlik bilgilerinizle sizin remote'unuz üzerinden taşınır. Kovan sunucusu oturumları koordine eder; kaynak kodu saklamaz.

## Worktree'ler

Katıldığınız her oturum kendi Git worktree'sini alır, her alt ajan da öyle; böylece ana checkout'unuza dokunulmaz. Ana checkout zaten oturumun dalındaysa Kovan onu olduğu gibi kullanır.

Git aynı dalı iki kez checkout edemez. Bu gerektiğinde Kovan onun yerine `kovan/session-<id>` adlı bir oturum dalı kullanır.

Worktree işleri birbirinden ayrı tutar. Bir güvenlik sınırı değildir.

Bir oturum worktree'sinin içinde elle dal değiştirirseniz oturum duraklar ve bir uyarı çubuğu geri dönmeyi ya da devam etmeyi önerir. Ajanlar bekler, eşitleme durur ve ekip bunu etkinlik akışında görür.

## Anlık görüntü eşitlemesi

Bir oturum canlıyken kaydedilen değişiklikler beş saniyede bir bir anlık görüntü (snapshot) commit'inde toplanır ve remote'unuzdaki gölge bir ref'e push edilir:

```
refs/kovan/snapshots/<session>/<person>
```

Push sizin kendi Git kimlik bilgilerinizle yapılır. Sunucu yalnızca commit'i, ref'i ve zamanı kaydeder. Ekip arkadaşlarınızın makineleri anlık görüntüyü çeker (fetch) ve oturum dalının kendi checkout'larına uygular; böylece oturumdaki herkes aynı dosyaları görür.

Sıradan commit'ler de aynı yoldan gider: bir ekip arkadaşınızın dalı ilerlediğinde sizin checkout'unuz da onu izler.

## Bir anlık görüntü uygulanmadan önce

Kovan üç sürümü karşılaştırır: aldığınız son anlık görüntü (ya da ortak temel commit), sizin dosyanız ve onlarınki.

- Dosyayı yalnızca onlar değiştirdiyse: onların sürümünü alırsınız.
- İkiniz farklı satırları değiştirdiyseniz: değişiklikler birleştirilir.
- İkiniz aynı satırları değiştirdiyseniz: **iki sürüm de saklanır**.

Hiçbir şeyin üzerine sessizce yazılmaz. Ajanınızın turu sürerken gelen anlık görüntüler tur bitince uygulanır.

## Çakışmalar

İki sürümü olan bir dosyada **2 sürüm** (2 versions) etiketi görünür ve Gezgin'de (Explorer) bunları listeleyen bir **Çakışmalar** (Conflicts) sekmesi vardır. Her biri için şunları yapabilirsiniz:

- iki sürümü yan yana **Karşılaştır** (Compare),
- **Benimkini koru** (Keep mine) ya da
- **Onlarınkini al** (Take theirs).

Dosyalar yeniden aynı olduğunda etiket iki tarafta da kaybolur. Kaydedilmemiş düzenlemeleriniz varken diske bir değişiklik gelirse, kaydettiğinizde sizin düzenlemeleriniz ikinci sürüm olarak saklanır.

## Eşitlemeyi kapatmak

Her çalışma alanında bir **Git eşitleme** (Git sync) anahtarı vardır. Kapalıyken hiçbir şey kendiliğinden push edilmez ya da uygulanmaz; sıradan Git ile eşitlersiniz.

## Eşitleme duraklatıldı

Dalınız push edilemiyorsa bir **Eşitleme duraklatıldı** (Sync paused) uyarısı bunlardan hangisinin olduğunu açıklar ve **Tekrar dene** (Retry) seçeneği sunar:

- Git kimlik bilgileriniz reddedildi,
- remote'taki bir dal kuralı push'u engelledi ya da
- remote'a ulaşılamadı.

Her durumda ne yapacağınız için [Sorun giderme](/tr/docs/troubleshooting/) sayfasına bakın.

## Alt ajanlar

Bir alt ajan, şeridinizin bir anlık görüntüsünden kendi worktree'sinde başlar; şeridiniz de devam eder. İşi şeridinize bir kez birleştirilir; o da yalnızca temiz uygulanıyorsa ve `git diff --check` ile `KOVAN.md` içindeki **Required Checks**'ten (zorunlu kontroller) geçiyorsa. Çakışırsa ya da bir kontrol başarısız olursa şeridinize dokunulmaz ve alt ajanın işi incelemek, yeniden kontrol etmek ya da atmak için elinizde kalır.

## Bitirmek

Oturum alışılmış yoldan biter. Kaynak Denetimi'nden (Source Control) commit ve push yapın, ardından **Pull request oluştur** (Create pull request) seçin. Pull request birleştirildiğinde oturum tamamlanır ve son diff'iyle birlikte Geçmiş'e geçer.

## Yarıda kalan işlemler

Dışarıda etkisi olan bir komut, örneğin bir push ya da bir deploy, yarıda kesilirse Kovan onu asla kendi kendine yeniden denemez. Ne gönderildiğiyle birlikte **Sonuç bilinmiyor** (Outcome unknown) kaydeder; işlemin gerçekleşip gerçekleşmediğini bir kişi kaydeder.
