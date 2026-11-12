# Başlarken

Kovan, sizin ve ekip arkadaşlarınızın her birinin bir yapay zekâ ajanıyla çalıştığı ve herkesin her ajanın işini canlı gördüğü bir kod editörüdür. Bu sayfa sizi kurulumdan bir ekip arkadaşınızla ilk oturumunuza kadar götürür. Kovan erken erişim döneminde ücretsizdir: yalnızca ajanlarınızın kullandığı yapay zekâ için ödersiniz.

## Kurulum

Kovan'ı [indirme sayfasından](/tr/download/) indirin. macOS (Apple silicon), Windows x64 ve ARM64, ayrıca AppImage olarak Linux x64 sürümleri var. Windows'ta ilk açılışta "Windows protected your PC" (Windows bilgisayarınızı korudu) uyarısı çıkabilir: **More info** (Ek bilgi), ardından **Run anyway** (Yine de çalıştır) seçin. Intel işlemcili bir Mac'te [terminal ajanını](/tr/docs/terminal-agent/) kullanın.

## Bir ekibe katılmak

Biri sizi davet mi etti? E-postasında bir link var: açın, sayfa size bunun kimin çalışma alanı olduğunu ve neye ihtiyacınız olduğunu söyler. Kod üzerinde onlarla birlikte çalışabilmeniz için şunlar gerekir:

1. **Bilgisayarınızda Kovan.** Yalnızca takip etmek için Kovan telefon uygulaması yeterli.
2. **Depoya erişim**, GitHub'da (ya da depo nerede duruyorsa orada). Kovan depoyu sizin kendi Git erişiminizle açar; açamıyorsanız sizi davet eden kişiden sizi oraya da eklemesini isteyin.
3. **Modelleri çalıştırmanın bir yolu**, kendi ajanınızı kullanmak istediğinizde: OpenRouter anahtarınız, Claude Code veya Codex hesabınız ya da Kovan üzerinden ödeme. Kovan buna ilk ihtiyaç duyduğunuzda sorar.

## Giriş yapın

Kovan'ı açın ve **Giriş yap ya da hesap oluştur** (Sign in or create an account) seçin. Uygulama tarayıcınızda bir giriş sayfası açar; orada GitHub, Google ya da e-posta linkiyle giriş yapabilirsiniz. E-posta linki her cihazda, telefonunuzda da açılır: sayfası, uygulamanın beklerken gösterdiği kodu ister; böylece linki başkası kullanamaz.

**Hesapsız devam et** (Continue without an account) seçip Kovan'ı kendi anahtarlarınızla tek başınıza da kullanabilirsiniz. Çalışma alanlarını başkalarıyla paylaşmanızı ve telefon uygulamasını kullanmanızı sağlayan şey giriş yapmaktır.

## Kontrol listesi

İlk seferde bir **Başlarken** (Getting started) rehberi kendiliğinden açılır; sonra sol çubuğun altındaki **Başla** (Start) onu yeniden açar. Adımları:

| Adım                            | Ne işe yarar                                                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Bir proje klasörü açın          | Projenizin dosyaları, bir terminal ve değişiklikleriniz; ajanınız burada çalışır.                                           |
| Bir yapay zekâ ajanı hazırlayın | Bir ajanın yanıt verebildiğini kontrol eder; veremiyorsa neyin eksik olduğunu ve nerede düzelteceğinizi söyler.             |
| E-postanızı doğrulayın          | Davetler ve oturum uyarıları bu adrese gelir.                                                                               |
| GitHub'ı bağlayın               | Ekip arkadaşlarınızın sizi GitHub kullanıcı adınızla davet etmesini ve Kovan'ın sizin adınıza pull request açmasını sağlar. |
| Bildirimleri açın               | Pencere arka plandayken bir ajan işini bitirdiğinde ya da onay istediğinde Kovan size haber verir.                          |
| İlk oturumunuzu başlatın        | Oturum, ortak bir iştir.                                                                                                    |
| Bir ekip arkadaşı davet edin    | Çalışma alanınıza bir rolle birini ekleyin.                                                                                 |

## Bir depo açın

**Klasör aç** (Open folder) seçeneğini kullanın. Bir Git deposunun içindeki bir klasörü açarsanız çalışma alanının kökü deponun kökü olur. ([Terminal ajanı](/tr/docs/terminal-agent/) onu başlattığınız klasörde çalışır: oraya `cd` ile geçip `kovan` çalıştırın.)

Artık çalışan bir editörünüz, bir terminaliniz, bir Git paneliniz ve bir ajan paneliniz (<kbd>⌘L</kbd>; Windows ve Linux'ta <kbd>Ctrl+L</kbd>) var. Komut paleti için <kbd>⌘K</kbd> (<kbd>Ctrl+K</kbd>), bir dosyaya gitmek için <kbd>⌘P</kbd> (<kbd>Ctrl+P</kbd>) tuşlarına basın.

## Ajanınıza bir model verin

Bir ajanın düşünmek için bir yapay zekâ modeline ihtiyacı vardır. Bunlardan herhangi biri olur:

- **Zaten kullandığınız Claude Code veya Codex.** **Ayarlar → Ajanlar → Hesaplar** (Settings → Agents → Accounts) bölümünde **Bu bilgisayarın Claude Code'unu kullan** (Use this computer's Claude Code) seçin (ya da Codex'i): kendi girişiniz ve ayarlarınızla çalışır, fazladan bir şey ödemezsiniz.
- **Kendi anahtarınız.** **Ayarlar → Model anahtarları ve harcama** (Settings → Model keys & spend) bölümüne bir [OpenRouter](https://openrouter.ai) anahtarı yapıştırın (yüzlerce modele ulaşan tek bir hesap; kullandıkça ödersiniz). Anahtar sisteminizin anahtar zincirinde saklanır.
- **Kovan üzerinden.** [Kovan üzerinden ödemeyi](/tr/docs/managed-usage-and-billing/) kurun: kendi anahtarınız gerekmez, modelin maliyetinin %5 fazlasını, belirlediğiniz aylık sınıra kadar ödersiniz.

Biri hazır olana kadar sohbet kutusu, siz bir şey göndermeden önce neyin eksik olduğunu söyler. Bkz. [Ajanlar](/tr/docs/agents-and-harnesses/).

## Çalışma alanını paylaşın

Sol çubuktan **Çalışma alanları** (Workspaces) bölümünü açın ve depoyu ekibinizle paylaşmak için **+** (ya da daha önce açılmış bir klasörün yanındaki **Paylaş** (Share)) seçin; ardından **Kişiler** (People) sayfasından insanları GitHub kullanıcı adı veya e-postayla davet edin. Herkes aynı deponun kendi kopyasında (clone) çalışır; Kovan bunların aynı proje olduğunu deponun remote adresinden (push edildiği yer, örneğin GitHub) anlar.

## Bir oturum başlatın

**Oturumlar** (Sessions) panosunda **Yeni** (New) seçin, işi anlatın ve yeni bir dal ya da var olan bir dalı seçin. Ekip arkadaşlarınız oturumu kendi panolarında görür, katılabilir ya da izleyebilir. Buradan sonrası için [Bir oturumda birlikte çalışmak](/tr/docs/sessions-and-lanes/) sayfasını okuyun.

## Klavye temelleri

| Tuşlar                            | İşlem                                           |
| --------------------------------- | ----------------------------------------------- |
| <kbd>⌘K</kbd> / <kbd>Ctrl K</kbd> | Komut paleti                                    |
| <kbd>Enter</kbd>                  | İsteği gönderir                                 |
| <kbd>Shift Enter</kbd>            | Yeni satır                                      |
| <kbd>Esc</kbd>                    | Açık olanı kapatır ya da çalışan ajanı durdurur |
| <kbd>Shift Tab</kbd>              | İzin modları arasında geçer                     |

Kısayolları **Ayarlar → Klavye** (Settings → Keyboard) bölümünden değiştirebilirsiniz.
