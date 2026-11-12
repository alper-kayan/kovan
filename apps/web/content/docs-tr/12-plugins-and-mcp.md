# Eklentiler ve MCP sunucuları

İkisi de ajanlara çalışmak için daha fazla araç verir. Masaüstü uygulamasında **Ayarlar → Ajanlar → Beceriler, araçlar ve eklentiler** (Settings → Agents → Skills, tools and plugins) altında bulunurlar.

## MCP sunucuları

Bir MCP sunucusu ajanlara araç verir: GitHub, bir veritabanı, bir tarayıcı, şirketinizin kendi sistemleri. Bir sunucuyu komutuyla (bilgisayarınızda çalışır) ya da adresiyle (başka bir yerde çalışır) ekleyin. Token gibi değerler listede değil, sisteminizin anahtar zincirinde tutulur.

- **Dene** (Test), kaydetmeden önce sunucunun araçlarını gösterir.
- "Önce sor" ve "Serbestçe düzenle" modlarında her çağrı önce sorar; sorduğunda **Hep izin ver**'i (Always allow) seçerseniz sormaz.
- Bir depo kendi sunucularını `.mcp.json` ya da `.kovan/mcp.json` içinde getirebilir. Bunlar ancak siz izin verince başlar ve dosya değiştiğinde yeniden sorar.
- Tarayıcı üzerinden giriş yaptıran sunucular (OAuth) bunu aynı listeden yapar.

Burada eklediğiniz sunucular, Kovan içinde çalışırken Claude Code'a da ulaşır; Kovan'ın kendi ekip araçlarının yanında. "Bu bilgisayarın Claude Code'u" ile (Ayarlar → Ajanlar → Hesaplar / Settings → Agents → Accounts) kendi Claude Code ayarlarınız ve sunucularınız da gelir.

## Eklentiler

Eklenti, bir Git deposundan gelen beceri, komut ve MCP sunucusu paketidir: adresiyle kurarsınız. Hiçbir şey kurulmadan önce önizleme içinde ne olduğunu, Kovan'ın kullanmayacağı parçalar dahil, gösterir.

Eklentiler kendi depolarından güncellenir; bir eklentiyi kaldırınca parçaları da onunla gider. Bir çalışma alanı sahibi ekibe eklenti önerebilir; herkes öneriyi aynı yerde görür.

Yalnızca güvendiğiniz eklentileri ve sunucuları ekleyin: araçları ajanınızın izinleriyle çalışır.

## Beceriler

Beceri, bir ajanın belli bir iş türü için izlediği talimatlardır. Birini doğrudan çağırmak için mesajın başına `/` yazın; ajanlar da uygun düştüğünde becerileri kendiliğinden kullanır.
