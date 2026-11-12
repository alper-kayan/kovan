# Güvenlik ve gizlilik

Kovan yerel öncelikli çalışır. Deponuz kendi çalışma kopyalarınızda kalır ve sunucu onun bir kopyasını hiçbir zaman tutmaz; sunucu, ekibin eşgüdüm için ihtiyaç duyduklarını tutar ve buna paylaşılan bir oturumun üzerinde çalıştığı kod da dahildir. Neyin toplandığını, kimin işlediğini ve ne kadar saklandığını eksiksiz anlatan metin [gizlilik politikasıdır](/privacy/).

## Bilgisayarlarınızda kalanlar

- **Deponuz.** Kovan sunucusu onun bir kopyasını hiçbir zaman tutmaz. Ekip arkadaşları arasındaki eşitleme, kendi kimlik bilgilerinizle kendi Git uzak deponuz üzerinden yapılır.
- **Git kimlik bilgileri ve SSH anahtarları.** Kovan zaten ayarlı olan Git'inizi kullanır ve bunları saklamaz.
- **Klasör yolları.** Bir çalışma alanıyla diskinizdeki bir klasör arasındaki bağ yalnızca kendi bilgisayarınızda tutulur. Tek istisna, ajanları gözetimsiz çalıştırmak için kaydettiğiniz bir makinedir (`agentd`): iş gönderilebilsin diye hangi depoları nerede tuttuğunu bildirir.
- **Sağlayıcı anahtarınız.** İşletim sisteminizin anahtar zincirinde saklanır.

## Sunucunun sakladıkları

- hesaplar, organizasyonlar, çalışma alanları, üyeler ve roller,
- oturumlar, planlar, kilitler, yorumlar, notlar ve etkinlik,
- anlık görüntü (snapshot) bilgileri: commit, ref ve zaman; dosya içerikleri asla,
- oturum şeritlerinin transcript parçaları; bunlar bir ajanın okuduğu ya da yazdığı kodu içerir,
- paylaşılan bir oturumun değişiklikleri: ekip arkadaşları ve telefon uygulaması gözden geçirebilsin diye her üyenin temel dala göre diff'i, yeni dosyalar dahil. Canlı diff iş ilerledikçe yenisiyle değişir; oturum bitince yalnızca son diff tutulur,
- Kovan üzerinden ödeme için: kullanım kayıtları ve faturalar.

Diff'ler ve transcript'ler aynı şekilde temizlenir ve şifrelenir (aşağıda).

## Gözetimsiz makinelerin Git trafiği

Ajanları gözetimsiz çalıştırmak için kaydettiğiniz bir makine (`agentd`), fetch ve push işlemlerini sunucu üzerinden yapar; sunucu çalışma alanının GitHub token'ını ekler, böylece makine onu hiç tutmaz. Bu trafik yalnızca aktarılır, saklanmaz.

## Transcript'ler

Bir ajanın oturum şeridinde söyledikleri ve yaptıkları, ekip arkadaşları izleyebilsin diye sunucuya akar. Bir parça saklanmadan önce:

1. gizli bilgiler kalıplara göre silinir,
2. uzun çıktılar kısaltılır ve
3. parça şifrelenir.

Transcript'ler ve biten oturumların son diff'leri varsayılan olarak 90 gün saklanır. Bir organizasyon bu süreyi değiştirebilir; süresi dolanlar düzenli olarak silinir.

Bir ajanın, ekip arkadaşının editöründe yazışını gösteren tuş tuş canlı yazma olayları aktarılır ama kaydedilmez.

## Şifreleme

Transcript parçaları, oturum diff'leri ve GitHub token'ları veritabanına yazılmadan önce sunucu tarafından şifrelenir. Anahtarlar sunucudadır ve yenilenebilir. Bu, uçtan uca şifreleme değil, saklanan verinin şifrelenmesidir.

Giriş oturumları rastgele token'lardır. Sunucu her birinin yalnızca özetini (hash) saklar ve herhangi biri iptal edilebilir. Masaüstü uygulaması kendi token'ını işletim sisteminin şifreli deposunda tutar.

## Modeller ve istemleriniz

Bir ajan çalıştığında isteminiz ve okuduğu kod seçtiğiniz model sağlayıcısına gönderilir: kendi anahtarınızla, Kovan üzerinden ödemeyle ya da bağladığınız CLI ile. Çakışma tespiti ve görev özetleri, isteminizden çıkarılmış kısa bir özeti küçük bir modele de gönderebilir.

## İzinler

Ajanlar Önce sor modunda başlar. Bir onay, tam olarak tek bir eylemi bir kez yetkilendirir ve yalnızca arayüzde değil, eylemi çalıştıran makinede de uygulanır. Roller her istekte sunucuda kontrol edilir; rolü düşürülen bir üyenin bir sonraki eylemi reddedilir.

Dosya kilitleri ve worktree'ler işleri birbirinden ayrı tutar. Bunlar yol gösterir, güvenlik sınırı değildir.

## Hata raporları

Kovan, hataları düzeltmeye yardım etmek için hesabınıza bağlı hata raporları gönderebilir. İstemler ve kod bunlara dahil değildir. Bunu **Ayarlar → Gizlilik** (Settings → Privacy) bölümünden kapatabilirsiniz.

## Giriş

GitHub, Google ya da e-posta bağlantısıyla giriş yapabilirsiniz. Doğrulanmış bir e-posta adresi bu yöntemleri tek bir hesapta birleştirir.

## Güvenlik açığı bildirmek

**kovan@alperkayan.dev** adresine yazın. [Güvenlik sayfası](/security/) neleri eklemeniz gerektiğini ve sonrasında ne olacağını anlatır.
