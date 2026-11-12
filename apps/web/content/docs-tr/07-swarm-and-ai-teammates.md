# Swarm ve yapay zekâ ekip arkadaşları

Swarm, birkaç ajanın bir bütçe içinde aynı anda tek bir hedef üzerinde çalışmasını sağlar. Yapay zekâ ekip arkadaşları ise bir çalışma alanına tıpkı bir kişi gibi üye olan ajanlardır.

## Swarm

Bir Swarm bir oturumun içinde yaşar. Oturumun **Swarm** bölümünde şunları belirlersiniz:

- bir iki cümlelik **hedef**,
- katılacak **ajanlar** ve hangisinin **lider** olacağı,
- ABD doları cinsinden bir **bütçe** ya da açıkça sınırsız,
- aynı anda kaç ajanın çalışabileceği ve
- ajanların hangi izin modunda çalışacağı.

Hiçbir ajan başlamadan bunları taslak olarak kaydedebilir, Swarm duraklatılmışken de değiştirebilirsiniz.

### Nasıl işler

1. Lider kodu yalnızca okuyarak inceler ve hedefi görevlere böler.
2. Her görev, bir ajanın sahip olduğu bir plan adımı olur.
3. Çalışan ajanlar paralel ilerler, her biri kendi Git worktree'sinde.
4. Bir ajanın sonucu yalnızca bir kez ve ancak temiz uygulanır ve zorunlu kontrollerden geçerse birleştirilir.
5. Lider sonuçları gözden geçirir ve Swarm sohbetine bir özet yazar.

### Kontroller

Swarm'ı duraklatabilir, durdurabilir ve devam ettirebilirsiniz. Tek bir ajanı durdurabilir, görevini başka bir ajana verebilir ya da bir ajanın şeridine yönlendirme gönderebilirsiniz.

### Bütçe

Her model çağrısının maliyeti sunucuda kaydedilir. Bütçe dolunca sunucu Swarm'ı duraklatır ve ajanlar hemen durur. Yalnızca Swarm'ı başlatan kişi onu devam ettirebilir.

Bir Swarm'ın harcadığı her şeyi, liderin planlama ve gözden geçirme işi de dahil, onu başlatan kişi öder.

### Swarm sohbeti

Ajanlar Swarm sohbetinde birbirlerine yazar; kişiler de tek bir ajana ya da hepsine yazabilir. Çalışan bir ajana giden mesaj hemen yönlendirme olarak ulaşır; boştaki bir ajana giden mesaj onun bir sonraki istemiyle birlikte gider.

### Öğrenme

Bir görevin sonucu kontrollerden geçtiğinde Kovan onu, çalışma alanındaki sonraki ajanlara verilen kısa bir nota dönüştürebilir. Sohbette dile getirdiğiniz tercihler farklı ele alınır: siz kabul edene kadar size özel, doğrulanmamış öneri olarak kalır. İkisini de **Brain** sayfasında (sol çubuktaki beyin simgesi) **Öğrenme** (Learning) altında gözden geçirin; her birini orada kabul edebilir, düzeltebilir ya da unutturabilirsiniz.

## Yapay zekâ ekip arkadaşları

Yapay zekâ ekip arkadaşı, bir çalışma alanının ajan olan bir üyesidir. Bir adı, bir modeli, bir izin modu ve ne iş yaptığını, nasıl çalıştığını anlatan yazılı talimatları vardır.

- **Kişiler** (People) sayfasında **AI** rozetiyle görünür.
- Düzenleyici rolündedir. Plan adımlarına sahip olabilir ve bir oturuma kendi şeridiyle katılabilir.
- Kendi girişi yoktur.
- Onu ekleyen kişinin bilgisayarında, o kişinin sağlayıcısıyla çalışır ve parasını o kişi öder. Şerit bunu açıkça yazar: "Runs on ada's machine · paid by ada" (ada'nın bilgisayarında çalışır · ada öder).

Onu ekleyen kişi ya da çalışma alanının bir sahibi onu emekliye ayırabilir.

## Ajanlar sayfası

**Ajanlar** (Agents) sayfası çalışan her şeyi bir çizge olarak gösterir: depolar, oturumları ve her birindeki ajanlar. Çalışan ajanların çevresi yeşildir; bir Swarm, son mesajlarıyla birlikte kesik çizgili bir kutudur. Açmak için bir oturuma tıklayın.
