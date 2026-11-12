# Yapay zekâ için ödeme: Kovan üzerinden

Kovan üzerinden ödemeyle, kendinize ait bir sağlayıcı anahtarı olmadan model çalıştırırsınız. Modeli Kovan'ın sunucusu çağırır ve size sağlayıcının aldığı ücretin × 1.05'ini faturalar.

## Maliyeti

Kovan üzerinden ödemede her çağrı için sağlayıcının gerçek token maliyeti alınır ve bir kez 1.05 ile çarpılır. Uygulamada her turun altında görünen tutar, ödeyeceğiniz tutardır.

Bunun yerine kendi sağlayıcı anahtarınızı kullanırsanız sağlayıcıya doğrudan ödersiniz, Kovan üstüne bir şey eklemez.

## Kim öder

Bir çalışmayı başlatan kişi tamamını öder. Buna başlattığı alt ajanlar, bir Swarm'ın ajanları, eklediğiniz bir yapay zekâ ekip arkadaşının işi ve JevRouter'ın yönlendirme çağrıları da dahildir.

Bunun yerine bir organizasyon da ödeyebilir: **ekip ödemesi** açıksa organizasyon, kendi çalışma alanlarında üyelerinin çalışmalarını öder; böylece oradaki kimsenin kendi anahtarına ya da kartına ihtiyacı olmaz. Bu çalışma alanlarının dışında herkes yine kendi ödemesini yapar.

## Kurulum

Kovan üzerinden yapılan istekler ancak şu üçü tamamlandığında başlar:

1. **Kayıtlı bir kart.** Kartı ödeme sağlayıcısının kendi sayfasında girersiniz. Kart bilgileri Kovan'a hiç ulaşmaz.
2. **Aylık limit.** Bir dolar tutarı ya da açıkça sınırsız.
3. **Onayınız.** Onay metnini kabul ederek günlük çekimlere izin verirsiniz.

Bunu uygulamada **Ayarlar → Ödeme ve kullanım** (Settings → Billing & usage) bölümünde ya da bu sitenin [ödeme sayfasında](/account/billing/) yapabilirsiniz.

## Aylık limit

Aylık limit, istekler durmadan önce bir takvim ayında Kovan üzerinden modellere harcayabileceğiniz en yüksek tutardır.

- Tüm çalışma alanlarınız ve aynı anda süren tüm çalışmalar için tek bir tutardır.
- × 1.05 dahildir, vergi hariçtir.
- Her ayın 1'inde (UTC) yeniden başlar. Ay ortasında artırırsanız o ay harcadığınız tutar korunur.
- Her model çağrısından önce kontrol edilir ve hâlâ süren çağrılar da hesaba katılır; böylece yan yana çalışan ajanlar limitin üstüne hep birlikte çıkamaz.
- Limit dolduğunda o ay bir e-posta alırsınız. Ödenmemiş faturalar ve henüz çekilmemiş kullanım silinmez.

## Ekip ödemesi

Bir sahip bunu **Ayarlar → Organizasyon → Ekip ödemesi** (Settings → Organization → Team billing) bölümünden açar ve şunları belirler:

- tüm üyeler için birlikte **organizasyonun aylık limiti**;
- bir sahibin tek bir kişi için değiştirebileceği (ya da o kişiye ayrı limit koymamak için boş bırakabileceği) **üye başına aylık limit**;
- makbuzları ve faturaları için **şirket bilgileri** (ad, adres, vergi numarası, fatura e-postası) ve
- ödeme sağlayıcısının sayfasında kaydedilen, organizasyonun kendi **kartı**.

Üyeler limitlerini ve ne kullandıklarını **Ayarlar → Ödeme ve kullanım** altında görür. Sahip, bu ay her üyenin ve her çalışma alanının ne harcadığını ve bu gidişle ayın nereye varacağını görür. Organizasyondan ayda bir kez, önceki ay için tek fatura olarak çekim yapılır; makbuzu fatura e-postasına (yoksa sahiplere) gider. Organizasyonun ya da bir üyenin limiti dolduğunda, bundan etkilenen kişiler o ay bir e-posta alır.

## Çekimler

Kişisel kullanım kartınızdan günde bir kez çekilir; her çekim bir makbuz gönderir. Ödeme alt sınırının altındaki bir bakiye çekilmez, ertesi güne devreder. Faturalar, hesap silinse bile vergi kayıtları için saklanır.

İptal ettiğiniz bir çalışmada da sağlayıcının yapıldığını onayladığı kullanımın ücreti ödenir.

## Ödeme başarısız olursa

Hesabınızın (ya da organizasyonun) ödemesi gecikmiş sayılır, bunu bildiren bir e-posta gelir ve yeni Kovan istekleri nedenini söyleyen bir mesajla durur. Ödeme sayfasından faturayı yeniden deneyin ya da kartı değiştirin. Fatura ödendiğinde istekler başka bir adım gerekmeden yeniden çalışır.

## Kullanımınızı görmek

Ödeme sayfası şunları gösterir:

- durumunuz, aylık limitiniz ve kayıtlı kartınız,
- henüz çekilmemiş kullanım,
- her biri makbuz bağlantısıyla faturalar ve
- son 30 günde Kovan üzerinden ödenen modeller; çalışmaya, modele ve çalışma alanına göre.

## Kovan üzerinden ödeme sunmayan sunucular

Bir Kovan sunucusu, ancak bunun için yapılandırıldıysa Kovan üzerinden ödeme sunar. Yapılandırılmadığı yerde ödeme sayfası bunu söyler; modelleri yine kendi anahtarınızla çalıştırabilirsiniz.
