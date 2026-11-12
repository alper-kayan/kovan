# Terminal ajanı

`kovan`, Kovan'ın terminaldeki kodlama ajanıdır: masaüstü uygulamasındakiyle aynı ajan döngüsü, önünde bir komut satırıyla. macOS, Linux ve Windows'ta çalışır; Node.js 22 ya da daha yenisi gerekir.

## Kurulum

macOS ve Linux'ta:

```sh
curl -fsSL https://kovan.alperkayan.dev/install.sh | sh
```

Windows'ta, PowerShell'de:

```powershell
irm https://kovan.alperkayan.dev/install.ps1 | iex
```

İkisi de yalnızca sizin kullanıcınız için, yönetici yetkisi olmadan kurar. Program `~/.kovan/cli/` klasörüne, yanına da bir `kovan` komutu gider: macOS ve Linux'ta `~/.local/bin` klasörüne (bu klasör henüz `PATH`'inizde değilse betik, `~/.zshrc` ya da `~/.bashrc` dosyasına eklenecek satırı yazar), Windows'ta ise kullanıcı `PATH`'inize eklenen `%USERPROFILE%\.kovan\bin` klasörüne.

Bir şey kurulmadan önce betik, sürümün Kovan'ın yayın anahtarıyla imzalandığını ve dosyanın sürümün hash'iyle eşleştiğini kontrol eder. Bu kontrollerden birini geçemeyen bir indirme kurulmaz.

## Kullanım

```sh
kovan                      # bu klasörde ajanla bir sohbet
kovan "fix the failing test"  # tek mesaj: işi yapar ve çıkar
kovan -c                   # bu klasördeki son sohbeti sürdürür
kovan -r "Auth work"       # bir sohbeti adıyla (ya da kimliğiyle) sürdürür, herhangi bir klasörden
kovan sessions             # bu makinede tutulan sohbetler
kovan setup                # modeli seçin: bir OpenRouter anahtarı, Kovan hesabınız ya da kendi gateway'iniz
kovan config               # hangi sunucu ve modelle konuştuğu
```

Bir sohbette komutlar, skill'ler ve özel komutlar için `/`, tuşlar için `/help` yazın. `Tab`, izin modunu `allow`, `plan` ve `request` arasında değiştirir (`full` yalnızca `/mode full` ile açılır); `Esc` çalışan bir turu durdurur.

Sohbetler masaüstü uygulamasının kendi sohbetlerini tuttuğu şekilde tutulur; böylece terminalde başlattığınız bir sohbet, uygulamanın o klasöre ait sohbet listesinde görünür.

## Bir sohbete ad verin ve ona geri dönün

- `/rename <ad>`, içinde bulunduğunuz sohbete ad verir. Ad saklanır ve masaüstü uygulamasının sohbet listesi de onu gösterir. Siz ad verene kadar sohbet ilk mesajıyla anılır.
- `/resume` bu makinedeki bütün sohbetleri listeler: önce bu klasörünkiler, sonra diğerleri, yürütüldükleri klasörle birlikte. Listeyi ada göre süzmek için yazmanız yeterli. Bu klasördeki bir sohbet hemen orada açılır; başka bir klasördeki bir sohbet, onu orada sürdürmek için gereken komutu söyler.
- `kovan -r <ad ya da kimlik>` bir sohbeti her yerden, yürütüldüğü klasörde sürdürür. Yalnızca bir sohbet uyuyorsa adından bir kelime yeterlidir; birkaçı uyuyorsa `kovan` tahmin etmek yerine onları listeler.
- `kovan sessions` hepsini kimlikleri, klasörleri ve tarihleriyle listeler.

Bir sohbete geri döndüğünüzde onu bıraktığınız gibi bulursunuz: model (ya da Claude Code veya Codex hesabı, o CLI'ın kendi oturumuyla; böylece ona söylenenleri hatırlar), effort düzeyi ve izin modu. Şimdi belirttiğiniz değerler (`-m`, `--effort`, `--mode`) kaydedilenin önüne geçer. Sohbetin en son kullandığı şey artık yoksa (örneğin kaldırdığınız bir hesap) `kovan` bunu söyler ve eldeki modelle devam eder.

## Hangi modeli kullanır

Hiçbir şey ayarlanmamışken `kovan`'ı ilk kez çalıştırdığınızda, modelleri nasıl çalıştırmak istediğinizi sorar: bir OpenRouter anahtarı yapıştırın (`~/.config/kovan/agent.json` dosyasında, yalnızca sizin okuyabileceğiniz şekilde saklanır), Kovan hesabınızla giriş yapıp modeller için Kovan üzerinden ödeyin ya da kendi gateway'inizi kullanın. Siz seçene kadar hiçbir şey açılmaz ve hiçbir şey kaydedilmez. Daha sonra değiştirmek için `kovan setup` çalıştırın.

Kendi anahtarınız ya da gateway'iniz her zaman önce gelir:

- OpenRouter üzerinden herhangi bir model için `OPENROUTER_API_KEY` ya da
- kendi OpenAI uyumlu gateway'iniz için `KOVAN_BASE_URL` ve `KOVAN_MODEL` (gerekiyorsa `KOVAN_API_KEY` de).

Kendinize ait hiçbir şey ayarlanmamışsa `kovan login` ile giriş yapın; sunucu sunuyorsa `kovan`, Kovan hesabınızın [Kovan üzerinden ödeme](/tr/docs/managed-usage-and-billing/) seçeneğini kullanır. `KOVAN_PROVIDER=managed` bir anahtarınız olsa bile hesabı kullanır; `KOVAN_PROVIDER=own` hesabı hiç kullanmaz.

Masaüstü uygulamasında eklediğiniz Claude Code ve Codex hesapları (**Ayarlar → Ajanlar → Hesaplar** (Settings → Agents → Accounts)) da bir sohbet yürütebilir: onları `/models` ile seçin.

## Bir şey yapmadan önce sormak

| Mod       | Kendi başına ne yapar                                                       |
| --------- | --------------------------------------------------------------------------- |
| `plan`    | Yalnız plan: okur; hiçbir şeyi değiştirmez.                                 |
| `request` | Önce sor: her düzenleme ve komuttan önce sorar.                             |
| `allow`   | Serbestçe düzenle: dosyaları düzenler, komutlardan önce sorar (varsayılan). |
| `full`    | Tam erişim: hiçbir şey sormaz.                                              |

Terminal `allow` ile başlar; bu, uygulamanın Önce sor modundan bir adım daha serbesttir: onun çalıştığı terminali siz de izliyorsunuz ve her düzenleme yapıldığı anda gösterilir.

Sorduğunda `y` (evet), `n` (hayır) ya da `a` (her zaman, oturumun geri kalanı için) ile yanıtlayın. Bir komut için `a`, o komutu başka argümanlarla da kapsar (`npm test`, `npm test -- --watch` komutuna da izin verir, `npm publish`'e değil); zincirlenmiş, pipe'lı ya da yönlendirilmiş bir komuta ise yalnızca birebir aynısı için yeniden izin verilir. Bir düzenleme için `a` o aracı kapsar. `--mode <mod>` ile başlatın ya da `Tab` veya `/mode` ile değiştirin.

## Neleri okur

Claude Code için zaten yazdıklarınız burada da, aynı biçimlerde çalışır:

- **Skill'ler**: deponun `.kovan/skills` ve `.claude/skills` klasörlerindeki ve `~/.claude/skills` içindeki `SKILL.md` klasörleri. Birini kullanmak için `/skill-adı` yazın.
- **Notlar**: deponun `KOVAN.md`, `AGENTS.md` ve `CLAUDE.md` dosyaları, ayrıca sizin kendi `~/.kovan/KOVAN.md` ve `~/.claude/CLAUDE.md` dosyalarınız.
- **Özel komutlar**: `.kovan/commands/<ad>.md` ve `.claude/commands/<ad>.md`; `$ARGUMENTS`, addan sonra yazdığınız metindir.

`KOVAN_NO_CLAUDE=1`, Claude Code'a ait hiçbir şeye dokunmaz.

## Güncellemeler

`kovan` on iki saatte bir arka planda yeni bir sürüm arar ve onu yalnızca Kovan'ın yayın anahtarıyla imzalanmışsa kurar. Bir sürüm kurulduğunda durum satırı **Update installed · Restart to update** (Güncelleme kuruldu · Güncellemek için yeniden başlatın) der. Hemen bakmak için `kovan update` çalıştırın; güncellemeleri kapatmak için `KOVAN_NO_UPDATE=1` ayarlayın.

## Kaldırmak

macOS ve Linux'ta:

```sh
rm -rf ~/.kovan/cli ~/.local/bin/kovan
```

Windows'ta `%USERPROFILE%\.kovan\cli` ve `%USERPROFILE%\.kovan\bin` klasörlerini silin ve `%USERPROFILE%\.kovan\bin` yolunu kullanıcı `PATH`'inizden çıkarın (**Ayarlar → Sistem → Hakkında → Gelişmiş sistem ayarları → Ortam Değişkenleri**).

Sohbetleriniz masaüstü uygulamasının veri klasöründe, girişiniz de `~/.kovan/auth.json` dosyasında kalır (onun da gitmesini istiyorsanız önce `kovan logout` ile kaldırın).

## Windows notları

- Claude Code ve Codex, `claude.exe` (yerel derleme) ya da npm'in `claude.cmd` / `codex.cmd` dosyaları olarak bulunur; bir npm komutu hiçbir zaman `cmd.exe` üzerinden değil, betiğiyle birlikte Node ile başlatılır; böylece isteğinizdeki hiçbir şey bir kabuk komutu olarak okunmaz.
- Ajanın çalıştırdığı komutlar PowerShell üzerinden geçer.
- Masaüstü uygulamasında eklediğiniz sağlayıcılar burada da çalışır: anahtarlarının kilidini, masaüstü uygulamasının okuduğu gibi, Windows sizin kullanıcı hesabınız için (DPAPI) açar.
