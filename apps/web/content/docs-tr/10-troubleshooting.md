# Sorun giderme

İnsanların en sık karşılaştığı sorunlar ve her biri için ne yapmanız gerektiği.

## Pencere başlığında Offline yazıyor

Kovan sunucuya ulaşamadı. Çalışmaya devam edebilirsiniz: ajanlar bilgisayarınızda sürer, şerit olayları sıraya alınır ve uygulama, denemeler arasındaki bekleme süresini artırarak kendiliğinden yeniden bağlanır. Pano ve kimin nerede olduğu gibi paylaşılan özellikler bağlantı gelince geri döner.

## "Workspace not set up on this machine"

Çalışma alanının bu bilgisayarda henüz bir klasörü yok (uygulama "bu makinede kurulu değil" diyor). Var olan kopyanızı seçin ya da depoyu Kovan'ın klonlamasına izin verin. Kovan kopyanızı kabul etmiyorsa, onun `origin` uzak deposu çalışma alanının deposuyla eşleşmiyordur.

## Bir oturuma katılamıyorum

Kovan her seferinde tek bir neden ve bir çözüm söyler:

| Neden                           | Ne yapmalı                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| Rolünüz buna izin vermiyor      | Bir sahipten Düzenleyici rolünü isteyin. İzleyiciler ve Yorumcular oturumu izleyebilir.           |
| Oturum dolu                     | Bir oturumda en çok 20 ajan olur. İzleyin ya da biri ayrılana kadar bekleyin.                     |
| Çalışma alanı burada açık değil | Çalışma alanını bu bilgisayarda kurun.                                                            |
| Kullanılabilir ajan yok         | Bir sağlayıcı anahtarı ekleyin, Kovan üzerinden ödemeyi kurun ya da Claude Code veya Codex kurun. |
| Yanlış dal                      | Oturumun dalına geçmek için düğmeyi kullanın.                                                     |
| Push yapılamıyor                | Aşağıdaki "Eşitleme duraklatıldı" bölümüne bakın.                                                 |

## Eşitleme duraklatıldı

Bant, bunlardan hangisinin olduğunu söyler:

- **Kimlik bilgileri reddedildi.** Git sağlayıcınıza yeniden giriş yapın. Bir terminalde `git push --dry-run` ile kontrol edin.
- **Bir dal kuralı engelledi.** Uzak depo push'u reddetti. Bir depo yöneticisine oturum dalının ya da `refs/kovan/` ref'lerinin kısıtlı olup olmadığını sorun.
- **Uzak depoya ulaşılamıyor.** Ağınızı ya da VPN'inizi kontrol edin.

Sorun çözülünce **Yeniden dene**'yi (Retry) seçin. Eşitleme duraklatılmışken hiçbir şey kaybolmaz; değişiklikleriniz çalışma kopyanızda kalır.

## Bir dosyada "2 versions" yazıyor

Siz ve bir ekip arkadaşınız aynı satırları değiştirdiniz. **Çakışmalar** (Conflicts) sekmesini açın, iki sürümü karşılaştırın ve **Benimkini tut** (Keep mine) ya da **Onlarınkini al** (Take theirs) seçeneğini seçin. Bkz. [Git eşitleme ve çakışmalar](/tr/docs/git-sync-and-conflicts/).

## Dal değiştirdikten sonra oturum duraklatıldı

Bir oturumun worktree'sinde elle dal değiştirmek oturumu duraklatır. Banttaki **Geri dön** (Switch back) düğmesini kullanın ya da bilerek yaptıysanız **Devam et**'i (Resume) seçin.

## Ajanım her şey için onay istiyor

Bu, varsayılan mod olan Önce sor'dur. Modu sohbet kutusundan değiştirin: **Serbestçe düzenle** düzenlemelere izin verir, komutlar için sorar; **Tam erişim** hiçbir şey sormaz. <kbd>Shift Tab</kbd> modlar arasında geçiş yapar.

## Codex sohbette bir şey yapmadan önce sormuyor

Codex sohbet ekranında durup soru soramaz, bu yüzden orada Önce sor salt okunurdur. Adım adım onay için onu terminalde açın.

## Ajan kullanım limiti yüzünden durdu

Şerit, birinin işi devralmasını bekler. Bir ekip arkadaşınız son eşitlenen anlık görüntüyle işi devralabilir ya da limitiniz yenilenince veya sağlayıcı değiştirdikten sonra siz devam edebilirsiniz.

## Kovan üzerinden yapılan istekler reddediliyor

Mesaj nedenini söyler. Olağan nedenler:

- kayıtlı kart yok, aylık limit belirlenmemiş ya da çekimlere henüz izin verilmemiş,
- aylık limit dolmuş: artırın ya da sıfırlayın,
- bir ödeme başarısız olmuş: faturayı [ödeme sayfasında](/account/billing/) yeniden deneyin.

## Bir komutta "Outcome unknown" yazıyor

Bir push, deploy ya da benzeri bir komut yarıda kesildi (sonuç bilinmiyor). Kovan onu kendiliğinden yeniden çalıştırmaz. Kovan'ın dışında ne olduğunu kontrol edin, sonra sonucu kartın üzerine kaydedin.

## E-posta bağlantısı çalışmıyor

Giriş ve doğrulama bağlantılarının süresi kısa sürede dolar ve yalnızca bir kez çalışırlar. Bir e-posta giriş bağlantısını herhangi bir cihazda açabilirsiniz; sayfası, Kovan'ın (ya da girişi başlattığınız sayfanın) beklerken gösterdiği kodu ister. Kod hiçbir zaman e-postada yer almaz. Beş kez yanlış kod girerseniz bağlantı çalışmaz hâle gelir: girişi baştan başlatın. Süresi dolduysa yeni bir bağlantı isteyin.

## Davet edildim ama çalışma alanını göremiyorum

Davet, gönderildiği hesaba katılır: o GitHub kullanıcı adına ya da doğrulandıktan sonra o e-posta adresine. Başka bir adresle mi giriş yaptınız (örneğin Apple'ın gizli adresiyle)? E-postadaki davet bağlantısını açın ve oradan kullandığınız hesapla katılın. Davet bir GitHub kullanıcı adına gönderildiği için e-posta gelmedi mi? Sizi davet eden kişiden davet bağlantısını isteyin.

## Kovan depoyu klonlayamıyor

Kovan, sizin Git erişiminizle klonlar. Klonlama "not found" ya da "access denied" hatasıyla başarısız oluyorsa GitHub hesabınız depoyu henüz açamıyordur: deponun sahibinden sizi oraya eklemesini isteyin, sonra yeniden deneyin.

## Hâlâ çözülmedi

Bir güvenlik sorunu için **kovan@alperkayan.dev** adresine yazın. Diğer her şey için de bize yazın: [İletişim](/contact/) sayfası neleri eklemeniz gerektiğini söyler ve mesajınızı bir insan okur. Önce [değişiklik günlüğüne](/changelog/) bakmak işe yarar; sorun yeni bir sürümde düzelmiş olabilir.
