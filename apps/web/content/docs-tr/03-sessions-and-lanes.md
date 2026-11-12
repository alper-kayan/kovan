# Bir oturumda birlikte çalışmak

Oturum, tek bir dalda ve tek bir planla yürüyen, içindeki herkesin paylaştığı bir iştir. Oturumun içinde her kişinin bir şeridi vardır: kendi ajanıyla kendi sohbeti.

## Oturumlar panosu

Pano ilk ekrandır. Canlı her oturum bir karttır; kartta iş, durumu, içinde kimlerin olduğu, hangi ajanların çalıştığı ve o anki turun kimin hesabını kullandığı, planın ilerleyişi ve şimdiye kadar dokunulan dosyalar görünür.

Kartların üstündeki uyarı şeridinde yalnızca bir kişinin ilgilenmesi gereken şeyler listelenir: bekleyen bir onay, bir devralma teklifi, bir çakışma. Her biri orada tek tıkla yanıtlanabilir.

Biten oturumlar transcript'iyle (saklandığı süre boyunca), son diff'iyle ve planıyla birlikte **Geçmiş** (History) bölümüne geçer.

## Başlatmak, katılmak, izlemek

Bir oturumu bir işle ve yeni ya da var olan bir dalla başlatın. Ekip arkadaşlarınız sonra:

- **Katıl** (Join): kendi şeridini alır ve oturumda çalışır ya da
- **İzle** (Watch): yalnızca okuyarak takip eder. İzleyenleri herkes görür; gizlice izlemek yoktur.

Siz katılmadan önce Kovan sizi durdurabilecek şeyleri kontrol eder: rolünüz, oturumda yer olup olmadığı, çalışma alanının bu makinede kurulu olup olmadığı, kullanabileceğiniz bir ajanınız olup olmadığı, dal ve push yapıp yapamayacağınız. Bir engel varsa tek ve açık bir neden ile onu düzeltmenin bir yolunu görürsünüz. Bir oturumda en fazla 20 ajan olabilir.

## Şeritler

Şeritler yan yana durur. Yazdığınız istekler kendi şeridinizdeki kendi ajanınıza gider ve herkes her şeridi akarken görür: düşünme, araç çağrıları, düzenlemeler ve yanıtlar.

Mesaj kutusu, siz göndermeden önce ne olacağını söyler: hangi ajan ve model çalışacak, bedelini kim ödeyecek. Niyeti kendiniz seçersiniz:

| Niyet                     | Etkisi                                            |
| ------------------------- | ------------------------------------------------- |
| Şimdi gönder (Prompt now) | Bir tur başlatır.                                 |
| Sıraya al (Queue next)    | O anki tur bitince çalışır.                       |
| Yönlendir (Guide)         | Çalışan kendi turunuza yön ekler.                 |
| Alt ajan (Subagent)       | Kendi worktree'sinde paralel bir alt iş başlatır. |

Taslaklar ve sıradaki istekler her şerit için ayrı tutulur.

## Onaylar

Ajanlar **Önce sor** (Ask first) modunda başlar; bu modda düzenlemeler ve komutlar onay ister. Onay kartı yapılacak işlemi tam olarak gösterir. Oturumdaki herhangi bir düzenleyici yanıtlayabilir ve ilk geçerli yanıt kazanır. Yanıt yalnızca arayüzde değil, işlemi çalıştıran makinede uygulanır ve o tek işlemi bir kez kapsar.

## Plan

Her oturumun tek bir planı vardır. Adımların bir sahibi ve bir durumu vardır; karttaki ilerleme plandan gelir. İşin sahibi ajanlar değil kişilerdir: ajanı olmayan bir yorumcu da bir adımı üstlenip bitirebilir.

Adımları devralmak isteyebilirsiniz. Sahibi olmayan ve kimsenin başlamadığı adımlar hemen size geçer; diğerleri için o anki sahibine sorulur.

## Yorumlar

Yorumlar oturuma, bir şeritteki bir ana, bir dosyadaki satırlara ya da bir diff'in bir parçasına (hunk) eklenir. Bir yorum bir plan adımına, bir kod önerisine ya da çevresindeki kodu bağlam olarak alan, kendi ajanınıza giden bir isteğe dönüşebilir. Bir yorumu çözüldü olarak işaretlemek onu asla silmez; altındaki kod yer değiştirdiğinde yorum güncelliğini yitirmiş olarak işaretlenir. Yorum yapmak hiçbir model kullanmaz.

## Çakışma uyarıları

Bir istek çalışmadan önce Kovan dalınızı, açık dosyalarınızı, isteğinizde adı geçen dosyaları ve plan adımlarınızı diğer canlı oturumlarla karşılaştırır. Aynı dosya üzerindeki iş **örtüşen** (overlapping), ilgili bir iş üzerindeki iş **komşu** (adjacent) sayılır. Uyarı, ekip arkadaşının ve oturumun adını verir ve onlara katılmayı, işi bölmeyi, koordine olmayı ya da yine de göndermeyi önerir.

Bir oturum belirli dosya yollarını da kilitleyebilir. Kilitler tavsiye niteliğindedir: bağlı ajanlara bu dosyaları düzenlememeleri söylenir, ama diskte onları durduran bir şey yoktur.

## Yönlendirmek, devralmak, devretmek

- **Yönlendir** (Steer), çalışan kendi turunuza yön ekler. Tur daha önce biterse yazdığınız metin mesaj kutusuna geri gelir.
- **Devral** (Take over), bir ekip arkadaşınızın turunu güvenli bir noktada bitirir ve plan, kod ve bağlamla birlikte sizin hesabınızda yeni bir tur başlatır. İki kişi aynı anda denerse biri kazanır, öbürü izleyebilir.
- **Devret** (Hand off), şeridinizi anlık görüntüsü (snapshot), bağlamı ve plan adımlarıyla bir ekip arkadaşınıza verir. Kabul edebilir ya da geri çevirebilir.

Bir ajan kullanım sınırına takıldığında şeridi devralınmayı bekler ve en son eşitlenen anlık görüntünün ne kadar eski olduğunu gösterir.

## Ortak notlar

Kovan dosyalara ve commit'lere bağlı kısa notlar tutar: kararlar, tuzaklar, alışkanlıklar. Çalışma alanındaki ajanlar bunları okur ve çalışırken yenilerini yazar. Bir ajanın yazdığı not, bir kişi kabul edene kadar doğrulanmamış kalır; bir notun işaret ettiği kod yer değiştirdiğinde not işaretlenir ve yakınında çalışan bir sonraki ajan onu yeniden yazar. Kişiler her notu okuyabilir, düzenleyebilir ve kaldırabilir.
