# Ajanlar: Kovan'ınki, Claude Code ve Codex

Burada ajan, işi yapan programdır: bir yapay zekâ modeliyle konuşur, ona araçlar sunar (dosya okumak, düzenlemek, komut çalıştırmak) ve modelin yaptıklarını uygular. Kovan'ın kendi ajanı vardır; ayrıca zaten kullandığınız komut satırı ajanlarını, Claude Code ve Codex'i de çalıştırabilir.

## Kovan'ın kendi ajanı

Kovan'ın yerleşik ajanı deponuzda şu araçlarla çalışır:

| Araç                            | Ne yapar                                                              |
| ------------------------------- | --------------------------------------------------------------------- |
| `read_file`, `list_dir`, `grep` | Çalışma alanını okur ve içinde arama yapar.                           |
| `write_file`, `edit_file`       | Bir dosya oluşturur ya da bir dosyadaki belirli bir metni değiştirir. |
| `run_shell`                     | Çalışma alanında bir komut çalıştırır.                                |

Her araç çalışma alanının içinde kalır. Her sohbet çalışma alanıyla, onun Git durumuyla ve ekibin `KOVAN.md` dosyasıyla başlar. Düşünme, araç çağrıları ve yanıtlar oldukları anda akar; düzenlemeler model onları daha yazarken editörde görünür.

Durdurmak için <kbd>Esc</kbd> tuşuna basın. Komutun bütün süreç grubu sonlandırılır ve sırada bekleyen araçlar başlamaz.

## İzin modları

| Mod                             | Davranış                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------- |
| Yalnız plan (Plan only)         | Yalnızca okuma araçları. Ajan inceler ve bir plan yazar; hiçbir şey düzenlenmez. |
| Önce sor (Ask first)            | Her düzenleme ve her komut önce sorar. Uygulamada varsayılan budur.              |
| Serbestçe düzenle (Edit freely) | Düzenlemeler doğrudan yapılır; komutlar önce sorar.                              |
| Tam erişim (Full access)        | Her şey sormadan çalışır.                                                        |

Bir onay, belirli tek bir işlemi bir kez kapsar. Bir oturumda bir ajanın Tam erişime alınması herkese gösterilir.

## Claude Code ve Codex

Kovan makinenizdeki ajan CLI'larını arar ve onları sürümleri ve yollarıyla birlikte **Ayarlar → Ajanlar** (Settings → Agents) bölümünde listeler. Kullanılamayan bir CLI gizlenmez; nedeniyle birlikte soluk gösterilir.

Herkes kendi CLI'ını kendi girişiyle bağlar; böylece aynı oturumdaki farklı kişiler farklı sağlayıcılar kullanabilir. Kovan genel yapılandırmanızı değiştirmez: ayarlarını başlattığı her çalıştırmaya ayrıca verir.

Kovan, Claude Code ve Codex'i yalnızca **Ayarlar → Ajanlar → Hesaplar** (Accounts) bölümünde kendinizin eklediği hesaplarla çalıştırır. CLI'ın bilgisayarınızda zaten sahip olduğu girişi kullanmaz. Eklediğiniz her hesap Kovan'ın içindeki bir terminalde bir kez giriş yapar ve kendi girişini saklar; böylece bir iş hesabıyla bir kişisel hesabı yan yana ekleyebilirsiniz. Bir hesap ekleyene kadar Claude Code ve Codex bir sohbet yürütemez; ajan menüsü sizi Hesaplar'a yönlendirir.

Bir CLI'ı çalıştırmanın iki yolu vardır:

- **Sohbet ekranında.** Claude Code ve Codex'in çıktısı Kovan'ın kendi ajanıyla aynı satırlarla gösterilir ve sonraki turlar aynı sohbeti sürdürür.
- **Bir terminalde.** CLI'ın kendi arayüzü gerçek bir terminalde, hiçbir şey süzülmeden çalışır.

Bilinmesi gereken birkaç fark var:

- Claude Code'un izin istekleri Kovan onay kartları olarak gelir.
- Codex sohbet ekranında durup soru soramaz; bu yüzden orada Önce sor modu salt okunurdur. Codex'le adım adım onay için terminali kullanın.
- İki CLI da bir turun ortasında yönlendirilemez. Bir yönlendirme mesajı bir sonraki istekle birlikte iletilir.

## Koordinasyon araçları

Kovan'ın başlattığı ajanlar, bir ekibin parçası olarak çalışmak için küçük bir MCP araç seti alır:

| Araç               | Amacı                                                                         |
| ------------------ | ----------------------------------------------------------------------------- |
| `get_team_context` | Çalışma alanında kimler var, neyin üzerinde çalışıyorlar, kilitler ve notlar. |
| `propose_split`    | Bir işin nasıl bölüneceğini önerir.                                           |
| `claim_plan_step`  | Planın sahipsiz bir adımını üstlenir.                                         |
| `assign_work`      | Bir kişi için panoya iş koyar.                                                |
| `message_agent`    | Bir ekip arkadaşının ajanına ya da bir YZ ekip arkadaşına mesaj gönderir.     |
| `record_memory`    | Bir sonraki ajan için kod hakkında bir not kaydeder.                          |

Her aracın açıklaması, ajana onu ne zaman kullanmaması gerektiğini de söyler.

## Bir depoyu bağlamak

**Ayarlar → Ajanlar** bir depoyu CLI'larınıza tek tıkla bağlayabilir. Kovan, CLI'ların okuduğu hook ve MCP yapılandırmasını yazar ve bu dosyaları `.git/info/exclude` ile Git'in dışında tutar; böylece hiçbir şey commit edilmez ve ekibin izlenen dosyalarına dokunulmaz.

## Ajansız

Katılmak için bir ajana ihtiyacınız yok. Oturumları izleyebilir, yorum yapabilir, iş üstlenip bitirebilirsiniz.
