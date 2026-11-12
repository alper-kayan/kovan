# Çalışma alanları ve kim ne yapabilir

Çalışma alanı, bir depo ile onun üzerinde çalışan kişilerden oluşur. Roller her çalışma alanı için ayrı belirlenir ve sunucu bunları her işlemde kontrol eder.

## Organizasyonlar ve çalışma alanları

Hesabınız ilk girişinizde kişisel bir organizasyon alır. Bir organizasyonda istediğiniz kadar çalışma alanı olabilir; her çalışma alanı, remote adresiyle tanınan tek bir depoya bağlıdır (örneğin `github.com/owner/repo`).

Çalışma alanları özeldir. Varsayılan olarak hiçbir şey herkese açık değildir ve bir çalışma alanının var olduğunu yalnızca üyeleri görebilir.

## Makinenizdeki çalışma alanları

Kovan bir depoyu kişiler arasında kopyalamaz. Herkes kendi clone'unda çalışır. Bir çalışma alanı ile diskinizdeki bir klasör arasındaki bağ yalnızca sizin makinenizde tutulur; sunucu klasör yollarınızı hiçbir zaman öğrenmez.

Bu bilgisayarda klasörü olmayan bir çalışma alanını açarsanız Kovan **Çalışma alanı bu makinede kurulu değil** (Workspace not set up on this machine) mesajını gösterir. Onu var olan clone'unuza yönlendirin (Kovan remote adresinin eşleştiğini kontrol eder) ya da depoyu sizin için clone'lamasına izin verin.

## Roller

| Rol         | Neler yapabilir                                                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| İzleyici    | Oturumları, transcript'leri, diff'leri, planları, notları ve geçmişi görür.                                                                                                                              |
| Yorumcu     | İzleyicinin yapabildiği her şeyi, ayrıca yorum yapar, öneride bulunur ve iş üstlenir: bir plan adımını sahiplenir, kabul eder, geri verir, bitti olarak işaretler. Ajan gerekmez.                        |
| Düzenleyici | Yorumcunun yapabildiği her şeyi, ayrıca ajanla yapılan bütün işleri: oturum başlatır ve katılır, istek yazar, yönlendirir, işi devralır, alt ajan çalıştırır, onayları yanıtlar, planı yönetir, iş atar. |
| Sahip       | Düzenleyicinin yapabildiği her şeyi, ayrıca üyelikleri, rolleri, çalışma alanı ayarlarını ve silmeyi yönetir.                                                                                            |

Rol kişiye değil, çalışma alanına aittir. Bir organizasyonun sahibi, o organizasyonun çalışma alanlarından birinde izleyici olabilir.

Rol değişiklikleri sunucuda hemen geçerli olur. Uygulama açıkken birinin rolü düşürülürse yaptığı bir sonraki işlem reddedilir. Bir çalışma alanında her zaman en az bir sahip kalır.

## Kişileri davet etmek

**Kişiler** (People) sayfasında **Davet et** (Invite) seçin, bir GitHub kullanıcı adı ya da e-posta adresi girin ve bir rol seçin. Zaten Kovan hesabı olan biri hemen eklenir ve bunu bildiren bir e-posta alır.

Yoksa davet bekler. Kişi o GitHub hesabıyla ya da o e-posta adresiyle ilk kez giriş yaptığında ya da davet linkini açtığında kabul edilir: link, kişiyi hangi hesapla giriş yaparsa onunla katar; yani Apple'ın gizli e-posta adresi ya da ikinci bir e-posta da olur. E-posta davetinde link vardır. GitHub kullanıcı adına e-posta gitmez: Kovan size linki verir, siz kendiniz gönderirsiniz (**Linki kopyala** (Copy link)). Linke sahip olan herkes onunla bir kez katılabilir; bu yüzden linki yalnızca davet ettiğiniz kişiye gönderin.

Sahipler aynı sayfadan rolleri değiştirebilir ve üyeleri çıkarabilir. Üyeler bir çalışma alanından kendileri ayrılabilir.

## Ekip kuralları: KOVAN.md

Deponun kökündeki bir `KOVAN.md` dosyası, ekibin ajanlar için kurallarını tutar. Kovan'ın kendi ajanı onu her sohbette okur. Dosyada ayrıca şunlar tanımlanabilir:

- bir ajan inşaya başlamadan önce çalışan **Before Build** komutları ve
- bir alt ajanın işinin bir şeride birleştirilmeden önce geçmesi gereken **Required Checks** (zorunlu kontroller).

## Çalışma alanı ayarları

Her çalışma alanının bir görünen adı, renkli bir simgesi, varsayılan bir temel dalı ve bir **Otomatik Git eşitleme** (Automatic Git sync) anahtarı vardır. Bkz. [Git eşitleme ve çakışmalar](/tr/docs/git-sync-and-conflicts/).
