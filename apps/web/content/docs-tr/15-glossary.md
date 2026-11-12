# Sözlük

**Ajan (agent).** Sizin için kod yazan ve değiştiren bir yapay zekâ: dosyaları okur, düzenler ve komut çalıştırır; isterseniz önce sorar. Kovan'ın kendi ajanı vardır, Claude Code ve Codex'i de çalıştırır.

**Yapay zekâ ekip arkadaşı (AI teammate).** Bir adı ve rolü olan, çalışma alanına üye bir ajan; örneğin "Bora, gözden geçirici". Ona bir oturumda iş verirsiniz ya da onu bir Swarm'a koyarsınız. Ona iş veren kişinin bilgisayarında çalışır.

**Onay (approval).** Bir ajanın bir düzenleme ya da komuttan önce "bunu yapabilir miyim?" diye sorması. Kimin cevap verebileceği role ve çalışma alanının ayarlarına bağlıdır.

**Brain.** Çalışma alanının ortak notları: kararlar, dikkat edilecek noktalar ve kurallar. Orada çalışan her ajan bunları okur.

**Kontroller (checks).** Projenin kendi testleri, linter'ları ve derlemeleri. Bir Swarm'da bir görev ancak bunlar geçince tamamlanmış sayılır.

**Şerit (lane).** Bir kişinin (ya da yapay zekâ ekip arkadaşının) oturumdaki yeri: ajanıyla yaptığı konuşma; oturumdaki herkes onu canlı görür.

**Model.** Bir ajanın arkasındaki yapay zekâ; örneğin Claude Sonnet ya da GPT. Kovan'ın kendi ajanı bunlardan yüzlercesini kullanabilir.

**JevRouter.** Kovan'ın model seçicisi: her adımı, o işi doğru yapma ihtimali yüksek en ucuz modele verir.

**MCP sunucusu (MCP server).** Ajanlara GitHub ya da bir veritabanı gibi ek araçlar veren bir eklenti. Bkz. [Eklentiler ve MCP](/tr/docs/plugins-and-mcp/).

**İzin modu (permission mode).** Bir ajanın sormadan neler yapabileceği: Yalnız plan (okur ve plan yapar), Önce sor (her düzenleme ve komuttan önce sorar), Serbestçe düzenle (düzenler, komutlardan önce sorar), Tam erişim (hiçbir şey sormaz).

**Rol (role).** Bir kişinin bir çalışma alanında neler yapabileceği: İzleyici (izler), Yorumcu (ayrıca yorum yazar), Düzenleyici (ajan çalıştırır ve kodu değiştirir), Sahip (ayrıca kişileri ve ayarları yönetir).

**Oturum (session).** Ekibin birlikte üzerinde çalıştığı, kendi Git dalı olan ve içindeki her kişi için bir şeridi bulunan tek bir görev.

**Swarm.** Tek bir hedef üzerinde çalışan birkaç yapay zekâ ekip arkadaşı: bir lider hedefi görevlere böler, diğerleri bunları yan yana yapar ve her görev sayılmadan önce kontrol edilir.

**Çalışma alanı (workspace).** Bir ekiple paylaşılan proje: depo, kişileri, oturumları ve ayarları. Kod herkesin kendi kopyasında kalır.
