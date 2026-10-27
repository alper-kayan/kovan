# Kovan: Özellikler

Kovan, yazılım ekiplerinin ve AI kodlama ajanlarının aynı canlı oturumda birlikte çalıştığı, çok oyunculu bir masaüstü IDE'dir. Her kişi kendi makinesinde, kendi ajanıyla (Kovan'ın kendi ajanı, Claude Code ya da Codex) çalışır; ekip aynı session'da her şeyi canlı görür, birbirinin işini devralabilir, plan ve hafızayı paylaşır.

- **Masaüstü uygulaması:** Electron + React + Monaco (macOS; Windows ve Linux paketleri hazırlandı ama henüz üretilmedi)
- **Mobil uygulama:** iOS ve Android (Expo); ajanları izler, onaylar ve yönlendirir, push bildirimi alır. Ajan çalıştırmaz
- **Sunucu ("Brain"):** Fastify + WebSocket + PostgreSQL; üretimde `https://kovan.alperkayan.dev`
- **Modeller:** OpenRouter üzerinden 180+ model (araç destekli ~390), JevRouter ile otomatik model seçimi, özel OpenAI uyumlu sağlayıcılar
- **Web sitesi:** sistemi anlatan animasyonlu tanıtım sayfası, dokümanlar, model kataloğu, indirme, hesap ve fatura sayfaları

---

## İçindekiler

1. [Editör ve çalışma alanı](#1-editör-ve-çalışma-alanı)
2. [Hesaplar, ekipler ve workspace'ler](#2-hesaplar-ekipler-ve-workspaceler)
3. [Kovan'ın kendi ajanı](#3-kovanın-kendi-ajanı)
4. [Modeller ve JevRouter](#4-modeller-ve-jevrouter)
5. [Harici ajanlar: Claude Code ve Codex](#5-harici-ajanlar-claude-code-ve-codex)
6. [Ajan + model sıralaması, Auto ve limit geçişi](#6-ajan--model-sıralaması-auto-ve-limit-geçişi)
7. [Session'lar ve Mission Control](#7-sessionlar-ve-mission-control)
8. [Plan, yorumlar ve Brain hafızası](#8-plan-yorumlar-ve-brain-hafızası)
9. [Kod ekranında canlı ajanlar](#9-kod-ekranında-canlı-ajanlar)
10. [Çakışma önleme, steer, takeover, handoff](#10-çakışma-önleme-steer-takeover-handoff)
11. [Git: worktree, canlı senkron, subagent, PR](#11-git-worktree-canlı-senkron-subagent-pr)
12. [Swarm ve AI ekip üyeleri](#12-swarm-ve-ai-ekip-üyeleri)
13. [Görev grafiği ve doğrulanmış tamamlama (Agent System 2.0)](#13-görev-grafiği-ve-doğrulanmış-tamamlama-agent-system-20)
14. [Mobil uygulama](#14-mobil-uygulama)
15. [GitHub issue'ları](#15-github-issueları)
16. [Faturalama ve managed usage](#16-faturalama-ve-managed-usage)
17. [Güvenlik ve gizlilik](#17-güvenlik-ve-gizlilik)
18. [Web sitesi, dağıtım ve güncelleme](#18-web-sitesi-dağıtım-ve-güncelleme)
19. [Kısayollar](#19-kısayollar)
20. [Durum ve bilinen sınırlar](#20-durum-ve-bilinen-sınırlar)

---

## 1. Editör ve çalışma alanı

**Repo açma**

- İletişim kutusundan, son açılanlardan ya da komut satırından (`kovan <klasör>`) açılır.
- Repo içindeki bir alt klasör açılırsa workspace kökü repo'nun kökü olur.

**Dosya gezgini**

- Canlı güncellenir (tek bir native watcher).
- Git işaretlerini gösterir (M/U/A/D); değişiklik içeren klasörde ● çıkar.
- Senkron açıkken dosyayı değiştiren ekip arkadaşının avatarı görünür.

**Monaco editör**

- Sekmeler, ⌘S ile kaydetme, dil desteği, arama/değiştirme.
- Kaydedilmemiş değişiklik işaretlenir.
- Dosya diskte değişirse editör kendini yeniler; kaydedilmemiş düzenlemeler korunur.

**Terminal**

- Birden fazla sekme; gerçek PTY (xterm.js + node-pty) ile byte byte geçiş.
- Claude Code ve Codex'in kendi arayüzleri burada açılabilir.

**Source Control**

- Status ve yan yana diff (staged / working tree); stage, unstage, discard.
- Commit (⌘Enter), Commit & Push, Push.
- ✨ düğmesi değişikliklerden kısa bir commit mesajı yazar (GPT-5.6 Luna); maliyeti kullanıma yazılır.
- Branch değiştirme ve oluşturma; commit grafiği (Graph).

**Komut paleti ve kısayollar**

- ⌘K komut paleti, ⌘P dosyaya git.
- Kısayolların hepsi tuş kaydediciyle değiştirilebilir.

**Ayarlar**

- Tema (koyu varsayılan, açık, sistem), editör ve terminal fontu, sekme genişliği, word wrap, minimap, kısayollar.
- Ayarlar ekranında arama ve onboarding kontrol listesi bulunur.

**Bildirimler ve tasarım**

- Ajan bitince ya da onay isteyince, pencere arka plandayken sistem bildirimi gelir.
- İşletim sistemi bildirimi reddederse (ör. imzasız geliştirme sürümü) uygulama bunu fark eder ve Dock'ta dikkat ister; onboarding'deki deneme adımı yalnızca bildirim gerçekten gösterildiyse tamamlanır.
- Arayüz DM Sans, Geist Mono ve Lilex fontlarını ve koyu/açık tasarım token'larını kullanır.
- Kenar çubuğunda Getting started (x/6), Sessions, Brain, People, Agents ve renkli ikonlu workspace listesi vardır.

## 2. Hesaplar, ekipler ve workspace'ler

**Giriş**

- GitHub OAuth, Google OAuth ve e-postayla gelen giriş bağlantısı (magic link) desteklenir.
- Masaüstü tarayıcıda giriş sayfasını açar ve oturumu güvenli bir anahtarla teslim alır.
- Aynı doğrulanmış e-postayla gelen sağlayıcılar tek hesapta birleşir.
- Uygulama hesapsız da kullanılabilir.
- Giriş sayfası yalnızca sunucuda anahtarı girilmiş sağlayıcıları gösterir; altında kullanım koşulları ve gizlilik politikası bağlantısı vardır.

**Oturum güvenliği**

- Oturumlar geri alınabilir opak token'larla tutulur; veritabanında yalnızca hash'leri durur.
- Masaüstünde token işletim sisteminin şifreli deposunda saklanır.

**Hesap silme**

- Telefonda (Hesap → Delete account…), masaüstünde (Ayarlar → Account) ve web sitesinde (`/account/#delete`). Önce ne silineceği ve neyin kalacağı gösterilir, "delete" yazınca silinir.
- Kişinin tek başına olduğu workspace'ler içindekilerle (session'lar, transcript'ler, AI ekip arkadaşları) silinir. Başkalarının da olduğu workspace ve org'lar kalır; son sahibi oysa en yüksek rollü ve en eski üye sahip olur.
- Kişinin paylaşılan yerlerde yazdıkları (yorumları, lane'leri), girişleri, telefon kayıtları ve ödeme bilgileri silinir; Stripe'taki müşteri kaydı ve kart da silinir. Henüz faturalanmamış kullanım tahsil edilmez; ödenmemiş başarısız bir ödeme varsa önce o halledilir.
- Kişinin açık olan bütün uygulamaları oturumu kapatır.

**Org ve workspace**

- İlk girişte kişisel bir org açılır.
- Repo "+" ile paylaşılır; origin adresi normalize edilip eşleştirilir.
- Workspace başka bir makinede kurulu değilse yerel klon seçilir (origin kontrol edilir) ya da klonlanır.

**Workspace modu**

- **Solo:** bir kişi ve ajanları. **Team:** insanlar birlikte. **Adaptive** (varsayılan): tek insan varken Solo, başkası katılınca Team.
- Owner Ayarlar → Workspaces'tan seçer; sunucu zorlar (Solo'da davet reddedilir).

**Roller**

- Owner, editor, commenter ve viewer rolleri vardır.
- Rol her istekte veritabanından taze okunur; rol düşürülünce bir sonraki işlem reddedilir.
- Son owner korunur.

**People**

- Üyeler, roller ve çevrimiçi durumu görünür; üye ayrılabilir ya da çıkarılabilir.
- Davet GitHub kullanıcı adıyla ya da e-postayla gönderilir. Hesabı olan kişi anında eklenir; olmayan kişinin daveti girişte kendiliğinden kabul edilir.
- Bekleyen davetler listelenir ve iptal edilebilir.

**Canlı bağlantı**

- Presence: kim çevrimiçi, kim bu workspace'te.
- Rol değişiklikleri anında iletilir.
- Sunucu yokken uygulama "Offline" çalışmaya devam eder ve kendiliğinden yeniden bağlanır.

**Diğer**

- E-posta doğrulama ve GitHub bağlama.
- Hata raporları (prompt ve kod gönderilmez; Privacy ayarından kapatılabilir).

## 3. Kovan'ın kendi ajanı

**Ajan paneli (⌘L)**

- Editörün sağında açılır; prompt kartı, düşünme satırı ve araç satırlarını gösterir (ör. "Edited dosya +4 −0", çıktısı açılır).
- Onay kartları (Approve / Deny) ve Markdown yanıtlar burada görünür. Yanıttaki `dosya:satır` referansları editörde açılır.
- Her turun sonunda model ve maliyet yazar.

**Araçlar**

- `read_file`, `list_dir`, `grep`, `write_file`, `edit_file` ve `run_shell`.
- Ajan workspace dışına çıkamaz.
- Ekip araçları (plan, hafıza, mesaj, issue) da ajana açıktır.

**İzin modları**

- **Plan:** yalnızca okur.
- **Request:** her düzenleme ve komut onay ister.
- **Allow:** düzenleme serbest, komutlar onaylı.
- **Full:** onay sormaz.
- Onay kartı yalnızca o işlemi, bir kez yetkilendirir.

**Kontrolden çıkan modele karşı koruma**

- Kendini tekrar eden (aynı kısa parçayı üst üste yazan) ya da hiç bitmeyen bir yanıt (200 bin karakter) kesilir; model akışı da durdurulur, harcama orada biter.
- Üç adım üst üste yalnızca var olmayan araçları ya da bozuk argümanları çağıran model durdurulur; tek bir hatadan sonra toparlanmasına izin verilir.
- Aynı çağrı beş kez üst üste aynı sonucu verirse tur durdurulur.
- Tur sonunda nedeni yazar ("The model kept repeating itself…"). Swarm, subagent ve AI ekip üyeleri için de geçerli.
- Kesilen yanıtın maliyeti sağlayıcıdan gelmez; akan metinden tahmin edilip fiyat listesiyle "tahmini" olarak kaydedilir, bütçeler onu da sayar.

**Composer**

- Enter gönderir, Shift+Enter yeni satır açar, Esc uygulamanın her yerinden durdurur.
- Markdown ve görsel eklenebilir; görsel için modelin görsel desteği kontrol edilir.
- Model seçici aranabilir; öne çıkanları, fiyatı, context'i ve rozetleri gösterir. Effort seçici ve "kim ödüyor" satırı da composer'dadır.
- Context doluluk halkası son çağrının context penceresinin ne kadar dolu olduğunu gösterir.

**Repo bağlamı**

- Sistem prompt'una workspace, git durumu ve `KOVAN.md`'deki takım kuralları eklenir.

**`KOVAN.md` "Before Build"**

- Bu başlık altındaki komutlar ilk turdan önce bir kez çalışır; komutlar değişirse yeniden çalışır.
- Full mod dışında her komut onay ister.

**Konuşmalar**

- Workspace başına diskte tutulur; geçmiş menüsünden açılıp silinebilir.

**Skill'ler**

- Claude Code'un `SKILL.md` biçimi: bir klasör, ad ve açıklama frontmatter'ı, istenirse ek dosyalar. Aynı skill iki ajanda da çalışır.
- Dört yerden okunur, ad çakışınca üstteki kazanır: deponun `.kovan/skills` ve `.claude/skills` klasörleri, kişinin Kovan skill'leri (`userData/skills`), istenirse kişinin Claude Code skill'leri (`~/.claude/skills`, yalnız okunur). Eklentilerin skill'leri `eklenti:skill` adıyla gelir.
- Modele yalnız ad ve açıklama listesi gider; ajan bir görev uyunca `use_skill` ile gövdeyi yükler. `/ad` ile doğrudan çağrılır (composer'da `/` yazınca liste açılır); transcript'te "Used skill X" görünür.
- Skill bir izin değildir: istediği düzenleme ve komutlar yine modun onayından geçer.
- Ayarlar → Agents → Skills: bulunanlar, nereden geldikleri, aç/kapa, okunamayanlar ve nedeni.
- Sistem prompt'u `KOVAN.md`'nin yanında `AGENTS.md` ve `CLAUDE.md`'yi de okur.

**MCP sunucuları**

- Kovan'ın ajanı MCP sunucularının araçlarını kullanır (resmi SDK; komutla başlayan ve uzak HTTP sunucular). Araç adları `mcp__sunucu__araç`.
- Sunucu bir turda ilk gerektiğinde başlar, sonraki turlarda aynı süreç kullanılır, uygulama kapanınca durur. Çağrı zaman aşımı, uzun çıktının kesilmesi, çöken sunucunun bir kez yeniden başlatılması; çağrı ortasında çökerse tekrarlanmaz.
- İzinler: Request ve Allow modunda her çağrı onay ister ("Use this tool?", sunucu · araç, maskelenmiş argümanlar; "Always allow" o aracı sormadan çalıştırır), Full'da istemez; Plan modunda yalnız sunucunun "sadece okur" dediği araçlar açıktır.
- Gizli değerler (token, parola, sunucunun env ve header değerleri) argümanlarda ve çıktıda maskelenir; transcript'e, takıma ve telefona gerçek değer gitmez.
- Ayarlar → Agents → MCP servers: komut ya da URL ile ekleme, kaydetmeden test, düzenleme, aç/kapa, silme. Env ve header değerleri işletim sisteminin anahtar zincirinde tutulur.
- Uzak sunucularda OAuth: "Sign in" tarayıcıyı açar, token anahtar zincirine yazılır ve süresi dolunca yenilenir; tur sırasında tarayıcı kendiliğinden açılmaz.
- Deponun `.mcp.json` / `.kovan/mcp.json` sunucuları izin verilene kadar başlamaz: turun başında "This repository wants to start the MCP server X" kartı (Allow once / Always allow / Don't allow); içerik değişince yeniden sorulur. Soracak kimsesi olmayan ajanlar (Swarm, subagent, AI ekip üyesi) izin verilmemiş sunucuyu başlatmaz.
- Sohbet ajanı, Swarm ajanları, subagent'lar ve AI ekip üyeleri aynı araçları alır.

**Eklentiler**

- Claude Code'un eklenti biçimi: `.claude-plugin/plugin.json`, `skills/`, `.mcp.json`. Git adresinden (ya da `owner/repo`), bir marketplace listesinden ya da bir klasörden kurulur; kurmadan önce içindekiler gösterilir. Claude Code'un komut, agent ve hook kısımları henüz kullanılmaz; her eklenti hangilerine sahip olduğunu gösterir.
- Güncellemede yeni sürüm indirilir, fark gösterilir ve onay istenir. Kaldırma da Ayarlar'dan.
- Workspace başına açılıp kapanır. Eklentinin MCP sunucuları deponunkiler gibi güven kartından geçer.
- Workspace sahibi bir eklentiyi ekibe önerebilir: üyelere "Install" önerisi çıkar, kendiliğinden kurulmaz.

## 4. Modeller ve JevRouter

**Model kataloğu**

- OpenRouter'dan gelir: context, milyon token başına fiyat, araç/görsel/reasoning yetenekleri, effort seviyeleri.
- 24 saat önbelleklenir.
- Ayarlar → Models: katalog tablosu, arama, filtreler (sağlayıcı, görsel, reasoning), sıralama, ID kopyalama, "Score vs cost per task" grafiği.

**Özel sağlayıcılar**

- OpenAI uyumlu her uç eklenebilir: DeepInfra, Ollama, LM Studio, vLLM, şirket gateway'i.
- Adres model listesiyle doğrulanır; modeller `@sağlayıcı/model` olarak çıkar.
- Anahtar işletim sisteminin anahtar zincirinde tutulur.

**JevRouter (Auto model)**

JevRouter, ajana sıradan bir model gibi görünür ve her çağrıda modeli seçer:

- **Konuşmayı okur:** ucuz bir model (yedeği kural tabanlı sınıflandırıcı) görev türünü, zorluğu ve işin aynı görev olup olmadığını çıkarır.
- **Kademe seçer:** görev × zorluk tablosuna göre ekonomik, dengeli ya da frontier kademeden, context'e sığan bir model seçer.
- **Cache'i korur:** aynı görev içinde ve "evet / devam" gibi mesajlarda model değişmez.
- **Yükseltir:** tekrarlanan başarısız araç çağrılarında bir üst kademeye çıkar.
- **Direktifleri dinler:** `[jev: only use Opus]`, `[jev: tier economy]`, `[jev: no frontier]`, `[jev: auto]`. Direktif metni modele gitmez.
- **Gerekçesini yazar:** her karar sohbette bir satır olarak görünür.

**Eval ve kullanım ölçümü**

- Eval harness: `pnpm --filter @kovan/jevrouter eval` kendi görev setinde skor ve görev başına maliyet ölçer.
- Her model ve yönlendirme çağrısında token, cache ve maliyet ölçülür.
- Tur başına açılabilir bir makbuz vardır. Sağlayıcının kesinleştirdiği maliyet ile katalogdan tahmin edilen maliyet (≈) ayrı gösterilir.

## 5. Harici ajanlar: Claude Code ve Codex

**Tespit**

- Makinedeki CLI'lar bulunur: Claude Code, Codex, OpenCode, Cursor Agent.
- Ayarlar → Agents'ta sürüm, yol ve durum gösterilir (Ready / Out of usage / Terminal only / Not installed).

**Native mod**

- Claude Code ve Codex çıktısı Kovan'ın sohbetinde aynı araç satırları ve makbuzla görünür.
- Sonraki turlar aynı oturumu sürdürür.
- Claude Code'un izin istekleri Kovan'ın onay kartına gelir.

**Terminal modu**

- CLI'nin kendi arayüzü terminalde, Kovan'a MCP ile bağlı olarak açılır.

**MCP koordinasyon araçları**

- Araçlar: `get_team_context`, `propose_split`, `claim_plan_step`, `update_plan_step`, `assign_work`, `message_agent`, `record_memory`, `create_issue`.
- Kişinin global ayarlarına dokunulmaz; her şey Kovan'ın başlattığı oturuma bayraklarla verilir.

**Repo'yu ajanlara bağlama (tek tık)**

- Kendi başlattığın `claude` / `codex` da ekibi görür: hook'lar (takım bağlamı, çakışma uyarısı, kilit kontrolü), `.mcp.json`, `.codex/config.toml` ve talimat dosyaları.
- Bu dosyalar `.git/info/exclude` ile yerel kalır, commit'lenmez.

**Fatura**

- Harici CLI'ların ve özel sağlayıcıların kullanımı kişinin kendi hesabına gider.
- Limit durumu gösterilir: "Limit reached · opens 19:00", "62% of 5-hour limit used".

## 6. Ajan + model sıralaması, Auto ve limit geçişi

**Sıralama (Ayarlar → Agents → "Your order")**

- Hangi ajanın hangi modelle, hangi sırayla kullanılacağını kişi belirler. Örnek:
  1. Claude Code · Opus
  2. Kovan · DeepSeek (DeepInfra)
  3. Codex
  4. Kovan · JevRouter
- Aynı ajan farklı modellerle birden çok kez sıralanabilir.
- Kovan adımları katalogdaki her modeli alır (OpenRouter, JevRouter, özel sağlayıcılar).
- Adım eklenir, yukarı/aşağı taşınır, kaldırılır. Her adımda limit satırı ve atlanma nedeni görünür ("Not installed: skipped").

**Auto (yeni konuşmalarda varsayılan)**

- JevRouter prompt'u okur ve sıradaki ilk hazır adımı, sıralanan modeliyle açar; nedeni sohbete yazar.
- Claude Code "Default" bırakılırsa model işin zorluğuna göre seçilir (Haiku / Opus).
- Limitine yaklaşan abonelik zor işlere saklanır.
- Görselli prompt, görseli alabilen ajana gider.
- `[jev: codex]`, `[jev: claude]` ya da `[jev: kovan]` ile ajan adıyla seçilebilir.

**Limit dolunca geçiş**

- Ajanın hesabı iş ortasında dolarsa konuşma sıradaki hazır adımla sürer.
- Devralan ajana ne istendiği, ne yapıldığı, hangi dosyaların değiştiği ve neyin tekrarlanmaması gerektiği aktarılır.
- Abonelikten kullandıkça öde modele geçmeden önce onay kartı çıkar ve kartta hangi sağlayıcının faturalanacağı yazar. Bu soru kapatılabilir.

**Hesap bazında limitler**

- Claude hesabı, OpenAI hesabı, OpenRouter / managed usage ve her özel sağlayıcı ayrı sayılır.
- Biri dolunca yalnızca o hesabın adımları atlanır; açılma saati biliniyorsa gösterilir.

**Ekip oturumunda**

- Önce kişinin kendi sırası denenir.
- Sıra tükenirse lane "Awaiting takeover" olur ve ekip devralabilir.

## 7. Session'lar ve Mission Control

**Session**

- Bir görev ve bir branch'tir (yeni `kovan/…` ya da mevcut branch).
- Join ile kendi lane'inle katılırsın; Watch ile salt okunur izlersin ve izlediğin herkese görünür.
- Bir session'da 20 ajana kadar koltuk vardır.

**Join ön kontrolleri**

- Giriş, rol, boş koltuk, workspace'in bu makinede kurulu olması, uygun ajan, doğru branch ve push yetkisi kontrol edilir.
- Engel varsa tek net sebep ve tek tıklık çözüm gösterilir (branch'e geç, kur, sağlayıcı ekle).

**Mission Control board**

- Canlı session kartları: görev, durum, ajanlar, kimin hesabıyla çalıştığı, dokunulan dosyalar, izleyenler, maliyet, plan ilerlemesi.
- Workspace filtresi ve arama vardır.

**Alerts strip**

- Bütün workspace'lerdeki bekleyen onaylar, takeover teklifleri ve çakışma uyarıları tek şeritte toplanır; tek tıkla yanıtlanır.

**Canlı lane'ler**

- Her ajan kendi makinesinde çalışır; olaylar parçalar halinde sunucuya gider ve herkese yayılır.
- Bağlanınca kayıpsız bir anlık görüntü gelir.
- Çevrimdışıyken olaylar kuyrukta bekler ve ajan çalışmaya devam eder.

**Composer niyetleri**

- Prompt now, Queue next, Steer ve Subagent.
- Sponsor satırı turu kimin ödediğini gösterir ("Runs now → Kovan · model · paid by your OpenRouter key").

**Ekip çapında onay**

- Herhangi bir editor bir onay kartını yanıtlayabilir; ilk cevap kazanır.
- Sonuç, işlemi çalıştıran makinede uygulanır.

**Oda yan paneli**

- People, Plan, Queue, Locks, Comments, Subagents, Swarm, Activity (Turns / Permissions / Takeovers) ve Usage bölümleri.

**History**

- Biten session'lar, transcript (saklama süresi içinde) ve final diff.

## 8. Plan, yorumlar ve Brain hafızası

**Session planı**

- Sıralı adımlardan oluşur; her adımın sahibi ve durumu (todo / doing / done) vardır. İş insanlara aittir.
- Board'daki ilerleme plandan gelir.
- Ajanlar planı araçlarla kullanır (claim, update, split, assign).
- Adım devralma: sahipsiz ve başlanmamış adım anında geçer; sahibi olan adım sahibine sorulur ("Hand it over / Keep it").

**Yorumlar**

- Session'a, lane'deki bir ana, dosya satırına (sağ tık → Comment, ⌥⌘M) ya da diff hunk'ına sabitlenebilir.
- Yanıtlanabilir; resolve yorumu silmez. Kod değişince yorum "outdated" olur.
- Editörde gutter işareti ve Comments paneli vardır.

**Yorumdan iş çıkarma**

- **Plan step:** yorumdan plan adımı açılır; bağlantı iki yönlü görünür.
- **Öneri:** önerilen kod "Apply" ile o satırlara yazılır.
- **Ask my agent:** yorum bağlamıyla ajan başlatılır.

**Brain hafızası**

- Dosya satırlarına ve commit'e sabitli notlardır: decision, gotcha, convention.
- Ajanlar notları okur ve yazar; ajanın yazdığı not bir insan kabul edene kadar "unverified" kalır.
- **Bayatlık:** HEAD değişince notlar kontrol edilir. Kod taşınmış ya da değişmişse not flag'lenir ("moved from line 1 to line 4") ve sonraki ajan notu yeniden yazar; eskisi emekliye ayrılır.
- **Brain sayfası:** Notes / Flagged / Retired / Learning sekmeleri; arama, düzenleme, kabul, "still holds", emekliye ayırma, geri getirme.

## 9. Kod ekranında canlı ajanlar

- **Canlı yazma:** ajan bir dosyayı düzenlerken kod editörde harf harf (saniyede ~90 karakter) akar. İsim etiketli renkli bir imleç ("alice · agent") görünür; değişen satırlar soluk ve üstü çizili, yeni kod renkli bir kutuda sözdizimi renkleriyle yazılır. Dosyaya zaten inmiş bir düzenleme yerinde açılır; değişmeyen baş kısım atlanır.
- **Başka kopyadaki düzenlemeler:** başka bir checkout'ta biten düzenleme "not in your copy yet, it arrives after checks" notuyla bekleyen kutu olarak durur.
- **Doğru yerde izleme:** bir session'ın ajanları yalnızca o session'ın checkout'u açıkken bu editörde görünür; değilse "… is writing this file in X" bandı ve "Watch it there" düğmesi çıkar.
- **Okuma imleci:** ajanın okuduğu satırda da imleç görünür.
- **Sekme işaretleri:** sekmelerde o dosyada çalışan ajanların baş harfleri çıkar, yazarken nabız gibi atar.
- **Takım arkadaşları:** onların ajanları da senin editöründe canlı görünür.

## 10. Çakışma önleme, steer, takeover, handoff

**Overlap uyarısı**

- Prompt göndermeden önce dosyaların, kilitlerin, branch'in ve görevin canlı session'larla çakışıp çakışmadığına bakılır.
- Çakışma varsa kart çıkar: Join / Split / Coordinate / Send anyway.

**Kilitler**

- Belirli dosyalara danışma kilidi konur.
- Ajanlar kilitli dosyayı bağlamlarında görür; Claude Code kilitli dosyayı düzenlemeden önce kişiye sorar.

**Steer**

- Çalışan ajanı bir sonraki adımından önce yönlendirir; başkasının lane'ine de gönderilebilir.
- Claude Code ve Codex tur ortasında yönlendirme alamaz; metin composer'a geri döner.

**Takeover**

- Her turun sonunda bir checkpoint snapshot alınır; kişinin kendi kimliğiyle remote'a, gizli bir ref'e gider.
- Limiti dolan ya da çevrimdışı olan lane'i başkası "Take over" ile devralır: snapshot devralanın checkout'una uygulanır, açık plan adımları ona geçer ve ajanı "Resuming at step X of Y." diye devam eder.

**Handoff**

- Lane'ini bir ekip arkadaşına verirsin; o "Pick it up / Decline" der.

**Outcome unknown**

- Push, deploy, publish ya da migrate gibi dışa etkili bir komut yarıda kesilirse asla otomatik tekrar denenmez.
- Bir insan sonucunu kaydeder: "It went through / failed / didn't run".

## 11. Git: worktree, canlı senkron, subagent, PR

**Worktree'ler**

- Her session kendi worktree'sinde çalışır; ana checkout'a dokunulmaz.
- Elle branch değişirse session duraklar ve "Switch back / Resume" bandı çıkar.

**Canlı senkron (Git sync)**

- Kaydedilen değişiklikler birkaç saniyede bir, kişinin kendi remote'undaki gizli bir ref'e WIP commit olarak gider; ekip arkadaşlarının checkout'una gelir.
- Gelen değişiklik üç yönlü kontrolden geçer: farklı satırlar birleşir.
- Aynı satır çakışırsa iki versiyon da tutulur ("2 versions": Compare / Keep mine / Take theirs); hiçbir şey sessizce ezilmez.

**Senkron sorunları**

- "Sync paused" bandı nedeni söyler (kimlik bilgisi, kural ihlali, erişilemeyen remote) ve Retry sunar.

**Paralel subagent**

- Lane'in anlık görüntüsünden kendi worktree'sinde çalışır.
- Kontrollerden geçer: çakışmasız uygulanma, `git diff --check` ve `KOVAN.md` "Required Checks".
- Geçen iş ana lane'e bir kez entegre olur; geçmeyen iş Review / Check again / Discard ile beklemede kalır.

**Bitiş**

- Commit & Push.
- "Create pull request" (GitHub API; açık PR varsa onu bulur).
- PR merge olunca session tamamlanır.

## 12. Swarm ve AI ekip üyeleri

**AI ekip üyeleri**

- Workspace'in gerçek üyesi olan AI'lardır (ör. "Bob"), People'da "AI" rozetiyle görünür.
- Adı, modeli, izin modu ve talimatı vardır; plan adımı sahibi olur ve session'a kendi lane'iyle katılır.
- Onu ekleyen kişinin makinesinde ve hesabıyla çalışır.
- Lane'inden görev verilir; her görevi kendi worktree'sinde, kontrollerle yapar.

**Swarm**

- Ortak bir hedef, ajanlar, lead, bütçe (USD ya da sınırsız), görev başına bütçe, aynı anda kaç ajan çalışacağı, inceleme ve izin modu belirlenir.
- "Suggest a team": hedefin türü, zorluğu ve parça sayısından (JevRouter kuralları) lead ve işçi önerilir; küçük işte yalnız lead.
- Lead kodu okur ve hedefi bağımlılıkları olan görevlere böler (bkz. bölüm 13). Çalışanlar paralel, kendi worktree'lerinde çalışır.
- Swarm onu başlatanın makinesinde koşar ve onun hesabına yazılır.

**Harcama sınırları (sunucuda uygulanır)**

- Swarm bütçesi dolunca Swarm kendini duraklatır; görev bütçesini aşan görev durdurulur.
- Owner workspace için aylık ajan sınırı koyar; dolunca çalışan Swarm duraklar, yenisi başlamaz.
- Tahmin yalnızca bu workspace'te biten görevlerin gerçek maliyetinden gelir ("No estimate yet" ya da "Estimated ~$X … spent $Y"); rakam uydurulmaz.

**Swarm kontrolleri**

- Duraklat, durdur, devam ettir; kendini duraklatan Swarm'da nedeni ve Resume / bütçeyi artır / Stop seçenekleri.
- Tek bir ajanı durdur ya da işini başka ajana taşı.
- Bütçe dolunca sunucu Swarm'ı duraklatır.

**Swarm sohbeti ("SWARM · LIVE")**

- Ajanlar `message_agent` ile birbirine yazar; insanlar ajanlara ya da herkese yazar.

**Agents tuvali**

- Repository → Session → Agent düğümleri; çalışan ajanlar ve son mesajlar görünür.

**Öğrenme**

- Kontrolden geçmiş sonuçlardan çıkan bilgi ("Learned:") ekipte paylaşılır.
- Kişisel tercihler onay bekleyen öneri olarak kalır: Brain → Learning'de Accept / Correct / Forget.

## 13. Görev grafiği ve doğrulanmış tamamlama (Agent System 2.0)

**Görev grafiği**

- Lead her göreve kimlik, bağımlılık, değişecek dosyalar ve "done means" (kabul kriteri) yazar; döngülü ya da bozuk plan reddedilir, lead yeniden böler.
- Bağımsız görevler paralel, bağımlılar öncülleri birleşince başlar; öncülü başarısız olan görev hiç başlamaz (`blocked`).
- Aynı dosyaya dokunacak paralel görevler kendiliğinden sıraya girer; yalnız test değiştiren görev kod görevlerinin arkasına alınır.

**Görev yaşam döngüsü**

- Durumlar: waiting, waiting_for_approval, running, done, failed, blocked, cancelled. Sunucu her geçişi doğrular.
- Görev başlatma tekrarlanabilir (aynı istek aynı görevi döndürür); beklenmedik hata `failed` olur.
- **Onay kapısı:** lead riskli görevi (ör. migration) işaretler; görev bir editörün Approve / Reject'ini bekler.

**Doğrulama**

- Yalnızca projenin gerçekten sahip olduğu kontroller çalışır: `KOVAN.md` Required Checks; yoksa `package.json` typecheck / lint / test / build, `cargo test`, `go test`.
- "Verified" yalnızca bu kontroller çalışıp geçtiyse yazar; kontrolü olmayan repoda iş "done, not verified" görünür.
- Kontrol düşerse ajan aynı worktree'de hatanın çıktısıyla bir kez daha dener; görev başına 30 dakika sınırı vardır.
- Birleşirken çakışırsa görev güncel kodun üstünde bir kez yeniden başlar.

**Bağımsız inceleme**

- Kontrolleri geçen iş, birleşmeden önce işi yapmayan bir ajan tarafından salt okunur incelenir; kabul kriteri karşılanmadıysa red sayılır ve iş sorunlarla geri gider.

**Yeniden planlama ve devir**

- İş başarısız olur ya da bloklanırsa lead sonuçları görüp kalan iş için bir kez yeni görevler atar.
- Lead varsayımlarını ve açık sorularını yazar; raporda tekrar edilir.
- Görev başka ajana geçince "Handed over to you" notuyla kim çalıştı, ne değişti, hangi kontrol düştü aktarılır.

**Kapanış raporu (Swarm sohbetinde)**

- Kaç görev doğrulandı / başarısız / blocked / durduruldu; görev görev kontroller (✓ ✗ – ⊘), deneme sayısı, inceleyici notu, maliyet; tahmin ile gerçek harcama; hiçbir testte geçmeyen değişen dosyalar; değişikliğin etkilediği yerler.

**Olay günlüğü ve Replay**

- Sunucu sıralı bir olay günlüğü tutar (plan, görev geçişleri, kontroller, maliyetler, Swarm ayarları).
- Session'ın Replay sekmesi günlüğü ve lane olaylarını tek zaman çizelgesinde oynatır; filtreler ve o anki görev durumları.

**Agent Arena**

- Aynı görev, deponun o anki commit'inden, Kovan ajanının en çok 4 yapılandırmasıyla (model, effort), istenirse 5 tekrarla, her koşu ayrı geçici worktree'de çalışır; projenin kontrolleriyle puanlanır, maliyetle karşılaştırılır.

**Değişiklik etki grafiği**

- JS/TS import'ları çözülür: değişen dosyayı doğrudan ya da en çok 3 adım dolaylı içe aktaranlar, aralarındaki testler ve HTTP rotaları bulunur; emin olunamayanlar ayrıca işaretlenir.
- Source Control'de "What does this change touch?"; subagent sonucunda, inceleyicinin isteminde ve Swarm raporunda kullanılır. Kontrol için bir haritadır, güvenlik kanıtı değildir.

**Karar hafızası**

- Karar notları gerekçe, sonuç ve yönettiği modüllerle tutulur.
- Aynı koda ya da aynı modüle yazılmış iki karar "çelişebilir" diye bağlanır; Brain'in Disputed sekmesinde ikisi de görünür, biri emekliye ayrılınca bağ kalkar.

## 14. Mobil uygulama

**Genel**

- iOS ve Android (Expo, React Native); masaüstüyle aynı koyu tasarım, fontlar ve renkler.
- Telefon ajan çalıştırmaz: izler, onaylar, yönlendirir, iş başlatır (işi kişinin kendi masaüstü çalıştırır). Sunucu telefonu "makine" saymaz (çevrimiçi göstermez, devralma ve Swarm kararlarını etkilemez).
- İkon: açık temada bal zeminde mürekkep kovan, koyu temada bal rengi kovan, iOS'ta renkli (tinted) sürüm; Android'de uyarlanabilir ve tek renkli ikon. Mağaza ikonları saydam kanalsız; açılış ekranı koyu zeminde bal rengi kovan.
- Bağlantı: koparsa artan aralıklarla yeniden bağlanır; açık görünüp cevap vermeyen bağlantıyı da kendisi fark eder (ağ değişince, uykudan dönünce) ve uygulama öne gelince hemen kontrol eder. İstekler 30 saniyede vazgeçer ve nedenini söyler.
- Erişilebilirlik: ekran okuyucu etiketleri, VoiceOver'a okunan bildirim balonları, büyük yazı boyutlarında bozulmayan satır ve sekmeler.
- Dağıtım: Xcode ile TestFlight ve App Store, Gradle ile Play (`deploy/README.md` → Mobile app); EAS kullanılmaz.
- Masaüstü kapalıyken telefondan başlatılan Swarm, workspace'in bir makinesinde (agentd) başlar; telefon "Started on <makine>." der. Makinede koşan işte şeritler ve Swarm başlığı makinenin adını yazar, iş bitince makine diff'i Changes'e gönderir. Kişinin kendi ajanına prompt yine masaüstü ister.
- Uzaktan güncelleme: JavaScript, stil ve görseller mağaza derlemesi olmadan güncellenir (`expo-updates`, Kovan sunucusu dağıtır, Expo'nun hizmeti kullanılmaz). Her güncelleme Mac'te özel anahtarla imzalanır, uygulama yalnızca içine gömülü sertifikayla doğrulanan güncellemeyi çalıştırır; sunucu anahtarı görmez. Güncelleme yalnızca aynı sürümdeki (`version`) derlemelere gider. Telefon açılışta ve 30 dakikadan uzun aradan sonra öne gelince bakar, arka planda indirir, ana ekranda "A new version of Kovan is ready · Restart" der; yoksa bir sonraki açılışta ya da 10 dakikalık aradan sonra kendisi geçer. Hesap ekranında sürüm, derleme numarası ve çalışan güncelleme. Yayımlama, önceki güncellemeye ya da derlemenin kendi koduna geri dönme ve durum: `apps/mobile/scripts/updates.mjs`.

**Giriş**

- Masaüstüyle aynı akış: tarayıcıda GitHub, Google ya da e-posta linki; e-posta linki telefonda açılabilir, son sayfa uygulamaya geri döndürür.
- iPhone'da Sign in with Apple: tarayıcı açılmaz, Apple'ın penceresi ve sunucu. Sunucu Apple'ın belirtecini Apple'ın açık anahtarlarıyla, uygulama kimliğiyle ve tek kullanımlık bir nonce'la doğrular; aynı doğrulanmış e-postalı hesap varsa ona bağlanır. Apple adı yalnız ilk girişte verir, hesap o adla açılır. Hesap silinince Apple'daki giriş yetkisi geri alınır.
- Sunucu adresi değiştirilebilir; oturum telefonun güvenli deposunda.

**Mission Control**

- Tek canlı bağlantı; koparsa artan aralıklarla yeniden bağlanır ve kaçırdıklarını yeniden okur.
- Ana ekran: "Needs you" şeridi (ajan onayları, görev onayları, kendini duraklatan Swarm'lar, devralma bekleyen lane'ler, sana devredilen işler, sonucu bilinmeyen eylemler) ve workspace'ler.
- Workspace: Live / History session kartları (masaüstündeki bilgilerle).
- Session: Lanes (kişi seçici, canlı akış, bekleyen onay kartı), Tasks (görev grafiği aşama aşama), Swarm (durum, bütçe, ajanlar, sohbet ve kapanış raporu), Changes, Activity.

**Eylemler (hepsi sunucuda rol kontrollü)**

- Approve / Deny (ilk cevap kazanır), görev Approve / Reject, steer, sonucu bilinmeyen eylemi kaydetme, devri reddetme, Swarm duraklat / durdur, tek ajanı durdur.
- Masaüstü gerektiren işler kişinin kendi masaüstüne iletilir: başkasının lane'ini devralma, devredilen işi alma, kendi lane'ini devretme, Swarm'ı sürdürme. İşi yapabilen ilk masaüstü üstlenir, sonucu telefona bildirir; masaüstü kapalıysa telefon bunu hemen söyler.

**İş başlatma (işi kişinin masaüstü çalıştırır)**

- Yeni session: başlık ve kendi dalı (`kovan/<başlık>`; canlı bir session o dalı kullanıyorsa `-2`, `-3`…), istenirse ilk prompt. Masaüstü dal için ayrı bir worktree açar, kişiyi ajanıyla session'a katar ve prompt'u çalıştırır.
- Kendi lane'ine prompt: ajan boştaysa masaüstünde yeni bir tur başlar, çalışıyorsa bir sonraki adımından önce yönlendirme olarak alır (Claude Code ve Codex tur ortasında yönlendirme alamaz; telefon bunu söyler). Henüz lane'i yoksa "You" sekmesinden yazılan ilk prompt masaüstünü session'a katar.
- AI ekip arkadaşı: telefondan session'a eklenir (kişinin masaüstünde, kişinin anahtarıyla çalışır); lane'indeki kutuya yazılan mesaj ona iş verir, cevabı lane'inde akar.
- Swarm: hedef, "Suggest a team" (JevRouter kuralları), ekip ve lead seçimi, bütçe, aynı anda kaç ajan, review; kaydedilir ve kişinin masaüstünde başlatılır. Biten bir Swarm'dan sonra "New swarm".
- Masaüstü kapalıysa ya da workspace orada kurulu değilse telefon bunu hemen söyler.

**İnceleme ve harcama**

- Changes sekmesi: session'ın PR'ı (numara, durum, dokununca GitHub'da açılır), session'da harcanan ve lane başına dağılımı, değişen dosyalar (eklendi / değişti / silindi / taşındı, +/− satır) ve her dosyanın diff'i.
- Diff canlıdır: session'da çalışan her masaüstü, checkout'unun base dala göre değişikliklerini (yeni dosyalar dahil, kişinin staging alanına dokunmadan) ajan dosya değiştirdikçe, Swarm işi birleştikçe ya da dosya kaydedildikçe sunucuya gönderir. Birden çok makine gönderdiyse kimden geldiği seçilir. Session bitince yalnızca son diff kalır.
- Satıra yorum: diff'teki bir satıra dokunup yorum yazılır; masaüstünde Comments panelinde ve kodun yanında görünür. Yorumlar telefonda ilgili satırın altında, cevaplarıyla; Reply ve Resolve / Reopen.
- Harcama ve limitler (Hesap → Spend and limits): son 30 gün (toplam, günlük grafik, model ve workspace dağılımı), managed usage (harcanan / allowance, faturalanmamış tutar, kart, ödeme sorunu) ve workspace başına bu ayki ajan harcaması ile aylık limit; sahibi limiti telefondan koyar, değiştirir ya da kaldırır.

**Push bildirimleri**

- Doğrudan Apple'a (APNs) ve Firebase'e (FCM); aracı servis yok.
- Olaylar: ajanın onay istiyor, ajanın bitti, iş sana devredildi, Swarm'ın bitti / durduruldu / kendini duraklattı (bütçe, aylık limit), görev onay bekliyor, session'daki bir ajanın limiti doldu.
- Kişi masaüstü penceresinde çalışıyorsa gönderilmez.
- Onay bildirimlerinde Approve / Deny; Android'de uygulama kapalıyken bile cevap gider, iOS'ta uygulama açılıp gönderir. Bildirime dokunmak ilgili session'ı açar.
- Hesap ekranında her bildirim türü telefon başına kapatılabilir; çıkış yapınca telefon kaydı silinir.
- Metinler tek satırdır; kod ve prompt gitmez, gizli bilgiler maskelenir.

## 15. GitHub issue'ları

**Ajanla açma**

- Ajanlar (Kovan, Claude Code, Codex) `create_issue` ile issue taslağı çıkarır; GitHub'a gitmeden önce kart açılır.
- Kartta repo seçilir; başlık, gövde ve etiketler düzenlenir.
- Benzer açık issue varsa "ona yorum ekle" seçeneği çıkar.
- Bir repo için "Don't ask again" işaretlenebilir.

**Sınırlar**

- Yalnızca workspace olarak açılan repolara issue açılır.
- Metindeki anahtar ve parolalar maskelenir.
- Kimlik git'in kendi GitHub bilgisinden ya da `GITHUB_TOKEN`'dan gelir.

**Elle açma**

- Komut paletindeki "Create GitHub Issue…" composer'ı hazırlar.

## 16. Faturalama ve managed usage

**Üç yol**

- Kendi OpenRouter anahtarın.
- Kovan managed usage: sağlayıcının gerçek maliyeti × 1.05.
- Auto: anahtarın varsa onu, yoksa managed usage'ı kullanır.

**Kim öder**

- Run'ı başlatan öder. Subagent'lar, Swarm ajanları, AI ekip üyeleri ve JevRouter'ın yönlendirme çağrıları onları çalıştıran makinenin sahibine yazılır.

**Allowance**

- Bütün workspace'ler arasında paylaşılan bir harcama sınırıdır; açıkça "Unlimited" da seçilebilir.
- Onay metni kabul edilmeden ve kart kaydedilmeden hiçbir managed istek gitmez.
- Sınır her model çağrısından önce kontrol edilir.

**Stripe**

- Kart Stripe Checkout'ta kaydedilir; kart bilgisi Kovan'a gelmez.
- Tahsilat günde bir kez yapılır; minimumun altındaki bakiye bir sonraki güne devreder.
- Ödeme başarısız olursa istekler durur; "Retry payment" ile açılır.

**Billing & usage sayfası**

- Durum, allowance, kart, faturalar ve makbuzlar.
- Son 30 günün kullanımı run, model ve workspace bazında.

## 17. Güvenlik ve gizlilik

**Masaüstü**

- Context isolation, sandbox ve kanal izin listesi açık.
- Her IPC argümanı zod ile doğrulanır; CSP uygulanır.

**Gizli bilgi ve şifreleme**

- Secret redaction: transcript, diff, yorum, hafıza, Swarm sohbeti, öğrenim ve issue metinlerindeki anahtarlar yazılmadan önce temizlenir.
- Uygulama tarafı şifreleme (AES-256-GCM, anahtar rotasyonu): GitHub token'ları, transcript'ler ve final diff'ler.
- MCP sunucularının env / header değerleri ve OAuth token'ları masaüstünde işletim sisteminin anahtar zincirinde tutulur; ajanın MCP çağrılarında gizli değerler maskelenir.
- Bir depo ya da eklenti, kişi izin vermeden komut başlatamaz: MCP sunucuları güven kartından geçer, içerik değişince yeniden sorulur.

**Gizlilik**

- Sunucu yerel klasör yollarını hiç öğrenmez; workspace ile klasör eşleşmesi yalnızca masaüstünde tutulur.
- Kod kişinin makinesinde ve kendi remote'unda kalır; Brain yalnızca sha, ref ve zaman tutar.
- Transcript saklama süresi org ayarıdır (1–3650 gün, varsayılan 90); süre kısalınca temizlik hemen çalışır.

**Sunucu**

- Rate limit (kişi başına, girişte IP başına, WebSocket flood koruması).
- Denetim günlüğü (org sahibine açık, 400 gün).
- İş başlatan uçlar (Swarm başlatma, session açma, telefondan masaüstüne iş) `Idempotency-Key` başlığını kabul eder: aynı anahtarla tekrar gelen istek yeni iş başlatmaz, ilkinin cevabını döndürür (`Idempotent-Replayed: true`). Yalnız başarılı cevap saklanır; ret (403, 409 "meşgul") ya da hata hiçbir iş başlatmadığı için anahtarı serbest bırakır, tekrar deneme yeniden çalışır. Anahtar başka bir istek için kullanılırsa 422, ilk istek sürerken 409. Kayıtlar 24 saat tutulur.
- Workspace API anahtarları (Ayarlar → Workspaces → API keys, yalnız owner): `kv_live_…` biçiminde, oluşturulunca bir kez gösterilir, sunucuda yalnız hash'i durur. Kapsamlar: `read` (okuma), `dispatch` (session açma, Swarm kurma ve başlatma), `control` (durdurma, yönlendirme, yeniden atama). Anahtar kendi "service" üyesi olarak çalışır (kişi listesinde görünmez), kişi ayrılsa ya da hesabını silse de çalışmaya devam eder; üye, rol, ayar, faturalama ve başka anahtar işlerini hiçbir kapsamla yapamaz. Son kullanım zamanı tutulur, iptal anında geçerlidir (401); oluşturma ve iptal denetim günlüğüne yazılır.
- Depo kimliği: `GET /api/workspaces?repo=<remote>` remote'un her biçimiyle (https, ssh, `git@…`) workspace'i bulur; aynı depo için ikinci workspace açılmaz, var olan döner. Session bir issue için başlatılabilir (`issue: { number }`, GitHub workspace'inde issue adresi kendiliğinden); session panelinde "Issue #N" görünür ve masaüstünden açılan PR'ın gövdesine `Closes owner/repo#N` eklenir.
- Olaylar ve webhook'lar: session başladı / bitti / turu hatayla bitti, onay istendi, Swarm durumu değişti, PR açıldı / birleşti. Her olay dal, PR, issue ve session bilgisiyle gelir. Owner webhook ekler (Ayarlar → Workspaces → Integrations): istekler `X-Kovan-Signature` (HMAC-SHA256) ile imzalı, yanıt vermeyen adrese 3 saate kadar artan aralıkla tekrar denenir, her teslimat ve denemesi görünür, "Send test" ile denenir. Webhook adresleri herkese açık https olmalı; özel ağ ve yerel adresler (bağlantı anında da) reddedilir, istisna yalnız sunucu ayarı `KOVAN_WEBHOOK_ALLOW`'daki tam `host:port`'lar; yönlendirme izlenmez. Webhook'suz kullanım için `GET /api/workspaces/:id/events?since=<imleç>&wait=<sn>`: olay gelene kadar bekler, iki hafta saklanır.
- Makineler (`agentd` için): `machine` kapsamlı anahtarla kaydolan bilgisayarlar ajanlarını, sürümlerini, tuttukları depoları ve checkout yollarını bildirir, 30 sn'de bir haber verir (90 sn sessizlik = çevrimdışı). Session ya da Swarm `machine: "<id>"` veya `"auto"` ile bir makineye gönderilebilir; `auto` depoyu tutan, çevrimiçi ve boş slotu olan en az dolu makineyi seçer. Session panelinde makine ve checkout yolu görünür; Integrations'ta makineler listelenir ve kaldırılır. Masaüstünde Swarm kurulumunun "Run on" seçimi işi bu bilgisayarda, `Auto` ile ya da seçilen makinede başlatır: çevrimdışı, depoyu tutmayan ya da dolu makineler gerekçesiyle seçilemez; makinenin işi hangi ajanla yaptığı (Claude Code aboneliği ya da Kovan ajanı) yazılır; makinedeki bir session'ın Swarm'ı orada sürdürülür. Makinenin slotunu yalnızca henüz Swarm'ı olmayan ya da Swarm'ı taslak / çalışır durumdaki session'lar tutar; biten, duran ya da duraklayan Swarm slotu boşaltır. Makinede Claude Code ile çalışan bir ajan da çalışırken gelen mesajları hemen alır (Claude Code'un akış girdisi): mesaj çalışan turuna girer; tur bitince gelen mesaj sonraki turuna kalır. Lane'i "Claude Code · haiku-5-5" gibi görünür.
- Swarm sohbeti: session'ın "Swarm" sekmesi (ya da sağ paneldeki sohbetin "Open chat"i) tam sayfa açılır. Ajanlar birbirine adıyla yazar, kişiler `@all` ya da `@<ajan>` ile yönlendirir; her mesajın yanında kime gittiği, ajanınsa hangi makinede ya da kimin bilgisayarında çalıştığı ve durumu görünür: Queued (ajan henüz almadı), Delivered (ajanın bağlamında), Read (ajan o zamandan beri yazdı). Swarm duraklarken yazılan mesajlar kaybolmaz, sürdürüldüğünde ilgili ajana verilir. Sohbette arama vardır.
- Makinede çalışan bir session'ın dosyaları (lane'lerdeki ve mesajlardaki dosya bağlantıları) kişinin kopyasında değil, session'ın uzaktaki dalından salt okunur bir sekmede açılır: dal arka planda çekilir, kişinin dalına ve dosyalarına dokunulmaz; sekmede dal, commit ve makine yazar, "Refresh" yeniden çeker. Makinenin henüz push etmediği dosya için bunu söyler.
- Swarm'ın lideri ekipte uygun kimse yoksa `add_teammate` ile workspace'e yeni bir AI ekip arkadaşı ekleyebilir (agent factory üzerinden, kişinin eklediğiyle aynı kurallar): İngilizce bir kişi adı (model ya da araç adı kabul edilmez), rolü ve gerekçesiyle; liderin modelini alır, Swarm'a işçi olarak katılır, People'da "liderin eklediği" olarak görünür, Activity'ye ve denetim kaydına düşer. Bir Swarm en fazla iki ekip arkadaşı ekler. Klasör yolları yalnız kayıtlı makinelerden gelir, masaüstü göndermez.
- Organizasyon kapsamı: API anahtarı, webhook, olay akışı (`/api/orgs/:id/events`) ve makineler bütün organizasyona da bağlanabilir (Ayarlar → Organization → Integrations): organizasyonun bütün workspace'lerini, sonradan açılanları da kapsar; organizasyon makinesi deposunu tuttuğu her workspace'in işini alır. Çoklu workspace ile çalışan dış sistem tek anahtar ve tek webhook'la yetinir.
- `agentd` (`packages/agentd`, `kovan-agentd`): başında kimse olmayan bir bilgisayarda (Raspberry Pi, sunucu, eski laptop) Kovan'ın ajanlarını çalıştıran başsız süreç. Ortam değişkenleriyle ayarlanır (sunucu, `machine` anahtarı, OpenRouter anahtarı, sunduğu checkout'lar, slot sayısı), makine olarak kaydolur, 30 sn'de bir haber verir, canlı bağlantıdan yeni işi hemen görür; kendisine gönderilen Swarm'ı masaüstünün kullandığı runner'la (`packages/runner`) çalıştırır: depoyu bulur, session dalında worktree açar, yolunu bildirir, ajanlarının lane'lerini canlı yayınlar. İşi varsayılan olarak makinedeki Claude Code yapar, kişinin kendi aboneliğiyle (Kovan'a maliyeti $0); ekip üyesinin modeli JevRouter ise her görevin Claude modelini (haiku / sonnet / opus) Jev seçer: makinede OpenRouter anahtarı varsa sınıflandırıcı modeliyle (görev başına ~$0,00005, anahtar yalnızca bu karar için), yoksa ücretsiz kurallarıyla; Swarm araçları Claude Code'a yerel bir MCP köprüsüyle verilir, izin soruları politikaya gider, ajanın kişiye soracağı sorular aynı abonelikle kısa bir Haiku çağrısıyla cevaplanır ve lane'de görünür; Claude Code yoksa Kovan'ın kendi ajanı (OpenRouter) kullanılır. Komut politikası reddet-varsayılan: testler, linter'lar, tip kontrolü, derleme ve okuma (`ls`, `grep`, salt okunur `git`) serbest; push, yayınlama, silme, kurulum ve zincirlenmiş / yönlendirilmiş her komut reddedilir. Yapamadığı işi (depo yok, dal yok) sebebiyle duraklatır; kapanırken çalışanı "agentd was stopped" diye duraklatır; 90 sn haber vermeyen makinenin Swarm'ı sunucu tarafından duraklatılır. İsteğe bağlı `KOVAN_PUSH=1` biten Swarm'ın dalını push eder. systemd ve launchd birimlerini kendisi üretir (`kovan-agentd unit systemd|launchd`); kurulum `deploy/README.md`'de.
- Güvenlik başlıkları ve sıkı CSP; `/.well-known/security.txt` ve `SECURITY.md`.
- Push anahtarları (Apple `.p8`, Firebase hizmet hesabı) depoya girmez; sunucuda yalnızca uygulamanın okuyabildiği bir klasörde, salt okunur bağlanır. Telefon kayıtları giriş oturumuna bağlıdır: oturum iptal edilince bildirim gitmez.

## 18. Web sitesi, dağıtım ve güncelleme

**Web sitesi (`apps/web`)**

- Kendi kimliği var (mürekkep laciverti, bal rengi, altıgenler, Bricolage Grotesque / Manrope / JetBrains Mono): sistemi baştan sona anlatan animasyonlu tanıtım sayfası, canlı kovan çizimi.
- Gömülü etkileşimli demo (`/demo`) masaüstünün tasarımını korur.
- Dokümanlar (10 sayfa), canlı model kataloğu, changelog, indirme, hesap ve fatura sayfaları, güvenlik sayfası.
- Gizlilik politikası (`/privacy/`), kullanım koşulları (`/terms/`) ve iletişim (`/contact/`); masaüstünde Ayarlar → Privacy, mobilde Account ekranından açılır. İletişim ve güvenlik adresi `kovan@alperkayan.dev`.

**Sunucu dağıtımı**

- Docker imajı root olmayan kullanıcıyla ve salt okunur dosya sistemiyle çalışır.
- Caddy ile otomatik TLS ya da hostun kendi reverse proxy'si.
- Şifreli gecelik veritabanı yedeği ve geri yükleme.
- Push anahtarları için ayrı, salt okunur bir klasör.
- Ayrıntılar `deploy/README.md`'de.

**Üretim**

- Adres: `https://kovan.alperkayan.dev`.
- Giriş e-postaları `kovan@alperkayan.dev` adresinden, aynı makinedeki kendi posta sunucusundan gider.

**Masaüstü paketleme**

- electron-builder ile macOS, Windows (x64 + ARM64) ve Linux AppImage yapılandırması ve release iş akışı hazır.
- Paketlenmiş uygulama `Kovan --self-test` ile doğrulanır.

**Otomatik güncelleme**

- Arka planda indirir, doğrular, çıkışta kurar ve yeniden başlatır.
- Linux için imza anahtarı vardır.
- Ayarlar → General → Updates.

## 19. Kısayollar

| Kısayol      | İşlev                      |
| ------------ | -------------------------- |
| ⌘K           | Komut paleti               |
| ⌘P           | Dosyaya git                |
| ⌘L           | Ajan panelini aç/kapat     |
| ⌘B           | Kenar çubuğunu daralt      |
| ⌘1 / ⌘2 / ⌘3 | Sessions / People / Agents |
| ⌘S           | Kaydet                     |
| ⌘Enter       | Commit                     |
| ⌥⌘M          | Satıra yorum ekle          |
| ⌘,           | Ayarlar                    |
| Esc          | Ajanı durdur (her yerden)  |

Kısayolların hepsi Ayarlar → Keyboard'dan değiştirilebilir.

## 20. Durum ve bilinen sınırlar

**Çalışan ve uygulamada uçtan uca denenenler**

- Faz 0–11, 13–17 ve 19 bitti; Faz 12 ve 18 kullanıcıdaki hesap ve sertifikaları bekliyor.
- Faz 16 (mobil uygulama) iOS ve Android'de uçtan uca denendi; gerçek iPhone'da canlı sunucuyla bildirimden onay denendi.
- Faz 17 (skill'ler, MCP ve eklentiler) uygulamada sahte MCP sunucularıyla, küçük bir modelle ve GPT-5.6 Luna ile uçtan uca denendi.
- Faz 19 (dış sistemler: API anahtarları, idempotency, webhook'lar ve olay akışı, makineler, `agentd`) yerel sunucuda gerçek HTTP, gerçek webhook alıcısı ve ayrı süreçte çalışan `agentd` ile denendi; masaüstü kapalıyken API'den gönderilen Swarm'lar kod yazıp commit ve push etti.

**Bekleyen ya da denenmemiş olanlar**

- **İmza ve dağıtım:** imzalı macOS / Windows paketleri ve otomatik güncellemenin kurulum adımı, Apple Developer ID ve Windows imza sertifikası gerektiriyor. Windows ve Linux paketleri henüz üretilmedi.
- **Gerçek servislerle denenmeyenler:** Stripe ve GitHub (PR açma, issue açma) yalnızca sahte sunucularla; ajan limiti sahte bir Claude Code ile; DeepInfra yerel bir sahte uçla denendi.
- **Üretimde kapalı olanlar:** GitHub/Google girişi (OAuth anahtarları girilmedi), managed usage ve Stripe.
- **Ajan sınırları:**
  - Subagent'lar, Swarm ve AI ekip üyeleri yalnızca Kovan'ın kendi ajanıyla çalışıyor; ajan sıralamasını kullanmıyor.
  - Claude hesabı tek limit sayılıyor: yalnızca Opus'un haftalık limiti dolsa bile Sonnet adımı da atlanıyor.
  - Codex sohbet içinde adım adım onay soramıyor (Request modu orada salt okunur).
  - Cursor Agent ve OpenCode yalnızca terminalde kullanılabiliyor.
- **Eksik arayüzler ve özellikler:**
  - Ayrı org oluşturma ve workspace ayarları (API'leri var).
  - Bitmiş session worktree'lerini silme.
  - Issue bağlantısının PR gövdesine kendiliğinden eklenmesi.
  - Yorumdan tek tıkla issue açma.
- **Mobil uygulamada kalanlar:** telefondan PR açma, allowance değiştirme, ilk TestFlight / Play yüklemesi (hesaplar kullanıcıda).
- **Bulutta çalışan ajan yok:** ajanlar, Swarm ve AI ekip üyeleri birinin masaüstünde çalışır; masaüstü kapalıyken telefondan istenen iş yapılamaz.
- **Swarm ajanlarının komutları** şimdilik hep reddediliyor (onay kartı yok); kontrolleri Kovan kendisi çalıştırdığı için doğrulama etkilenmiyor.
- **Arka plandaki ajanlar ve MCP:** Swarm ajanları, subagent'lar ve AI ekip üyeleri onay soramadığı için bir MCP aracını yalnız "Always allow" seçilmişse kullanabiliyor; izin verilmemiş depo ya da eklenti sunucularını hiç başlatmıyor.
- **Eklentilerin Claude Code'a özgü kısımları** (komutlar, agent'lar, hook'lar, output style'lar, LSP sunucuları) okunmuyor; eklenti ekranı bunları "not used" diye listeliyor.
- **Agent System 2.0 açık maddeleri:** açık sorularda durup cevap bekleme, geçici ajan oluşturma, ajan bazında bütçe, fiyatlardan ön tahmin, kabul kriterinin komutla çalıştırılması, etki grafiğinde takma adlar ve diğer diller, Arena'da Claude Code / Codex, hesapsız Swarm.

## Dayanıklılık ve koordinasyon (Faz 20)

- **Kaçırılan olaylar:** gerçek zamanlı bağlantı koptuğunda workspace değişiklikleri sıra numarasıyla tekrar gönderilir; çok eskiyse ya da sunucu yeniden başladıysa uygulama o workspace'i baştan okur.
- **Fence:** bir Swarm her başlatıldığında artan bir numara alır; eski bir çalışmanın (geri gelen bir makinenin) yazımları reddedilir, o çalışma durur ve işini commit etmez.
- **Codex ve Claude Code'a canlı mesaj:** masaüstündeki Codex lane'leri `codex app-server` ile, Claude Code lane'leri stdin ile çalışır; çalışan tura gelen mesaj aynı turda okunur ve lane'de "delivered" olur.
- **Yazım öncesi denetim:** Kovan ajanı ve Claude Code bir dosyaya yazmadan önce, başka bir canlı session'da kilitli / değişen / planlanan dosyalar, import grafiğinde komşu değişiklikler ve aynı adlı yeni dosyalar için bir kez uyarılır; tekrar yazarsa yazım yapılır.
- **Git Kovan üzerinden:** workspace sahibi bir erişim token'ı girerse makineler GitHub anahtarı olmadan Kovan sunucusu üzerinden fetch/push yapar (`KOVAN_GIT_RELAY=1`); varsayılan dala push edilmez.
- **Arka plan ajanları:** masaüstü bu bilgisayarda kendi agentd'sini başlatabilir; ona gönderilen işler uygulama kapansa da sürer.

## Ajan yapısı (Faz 21)

- **Bağlam sıkıştırma:** Kovan'ın ajanı modelin penceresine yaklaşınca konuşmanın eski kısmını aynı modelle özetler, son kısmı olduğu gibi tutar; sağlayıcı "çok uzun" derse bir kez özetleyip yeniden dener.
- **Tur içinde ekip durumu:** uzun bir turda ekip notu (kilitler, plan, Brain notları) adımlar arasında yeniden okunur; Claude Code'a araç çağrılarından sonra, değiştiyse gider.
- **Klasör kuralları:** alt klasörlerdeki `KOVAN.md` / `AGENTS.md` / `CLAUDE.md`, ajan o klasöre dokununca okunur; oraya ilk yazım kurallar görülene kadar bir kez bekletilir.
- **İlerleme yokluğu:** aynı çağrı aynı sonucu dosyalar değişmeden verirse ajan uyarılır, üçüncüsünde tur duraklatılır.
- **İş devretme:** Kovan'ın ajanı session'da `delegate_task` ile alt ajanlara iş verir; bitince sonuçlarla kendiliğinden devam eder.
- **Ödeme satırı:** her turun altında kimin hesabından ödendiği yazar.

## Swarm iletişimi (Faz 22)

- **Boştaki ajan uyanır:** turu olmayan bir Swarm ajanına gelen mesaj onu kısa bir cevap turuna uyandırır (kişinin mesajı her zaman, başka ajanın mesajı ajan başına en çok 3 kez). Lider iş sürerken uyanır, cevap verir, gerekirse plana yeni görev ekler. Sırada görevi olan işçi uyandırılmaz: mesaj görevinin prompt'una girer. Ajanların herkese duyuruları kimseyi uyandırmaz ve çalışan turu bölmez.
- **Gerçek teslim ve okundu:** "Delivered" mesaj modelin bağlamına girince, "Read" model ondan sonra cevap verince yazılır; tur önce biterse mesaj geri kuyruğa döner.
- **Mesaj yapısı:** tür (not, soru, cevap, engel), cevap verilen mesaj, tekrar gönderimi ayıklayan anahtar. Ajanların `read_messages` aracı ve `message_agent`'ta `reply_to`, `kind`, `wait` (cevap bekleyen soru) ve "lead" adresi var.
- **Ajandan insana:** ajan session'daki bir kişiye yazabilir ve cevap bekleyebilir; kişiye push bildirimi gider. Liderin `needs_answer` dediği görev kişi cevap verene kadar bekler, cevap göreve geçer.
- **Needs attention:** Swarm sayfasının üstünde cevapsız sorular ve engeller (Reply), onay bekleyen görevler (Approve / Reject), başarısız ve engellenmiş görevler.
- **Swarm ajanlarına koordinasyon:** yazım öncesi denetim (başka session'da değişen ya da kilitli dosyalar), ekip notu (Swarm'ın görevleri, kişilerin kilitleri, diğer session'ların işi) Kovan'ın ajanına, Claude Code'a (hook'larla) ve Codex'e gider. Yeni mesaj gelince yazım, model mesajı görene dek bekletilir.
- **Uygulama kapanınca:** masaüstünden başlatılan Swarm uygulama kapanırken duraklar; uygulama çöker ya da bağlantısı 90 sn'den uzun koparsa sunucu duraklatır.
- **Olay akışı:** Swarm mesajları `swarm.message` olayıyla olay akışında ve webhook'larda.
- **Codex:** `agentd` Swarm ajanlarını Codex ile de çalıştırabilir (`KOVAN_AGENT=codex`).
