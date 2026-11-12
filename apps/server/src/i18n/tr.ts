/**
 * The server's Turkish: sign-in pages, emails, push notifications and the errors people see.
 * The English text is the key (see packages/shared/src/i18n.ts); what isn't here stays English.
 */
export const TR: Readonly<Record<string, string>> = {
  // ---------- sign-in pages ----------
  'Sign in': 'Giriş yap',
  'Sign in to Kovan': "Kovan'a giriş yapın",
  'Connect an account': 'Hesap bağla',
  'Connect your account': 'Hesabınızı bağlayın',
  'Link another way to sign in.': 'Giriş için başka bir yol bağlayın.',
  'New here? Signing in creates your account.': 'Yeni misiniz? Giriş yapınca hesabınız oluşur.',
  'This server has no other way to sign in set up.':
    'Bu sunucuda başka bir giriş yolu kurulu değil.',
  'Continue with {name}': '{name} ile devam et',
  'Continue with email': 'E-posta ile devam et',
  or: 'ya da',
  'Email address': 'E-posta adresi',
  'you@company.com': 'siz@sirket.com',
  Password: 'Parola',
  'By continuing you accept the {terms} and the {privacy}.':
    'Devam ederek {terms} ve {privacy} kabul etmiş olursunuz.',
  'terms of service': 'kullanım koşullarını',
  'privacy policy': 'gizlilik politikasını',
  'You can close this tab and return to Kovan.': "Bu sekmeyi kapatıp Kovan'a dönebilirsiniz.",
  'Check your email': 'E-postanıza bakın',
  'We sent a sign-in link to {email}. You can open it on any device, your phone too.':
    '{email} adresine bir giriş bağlantısı gönderdik. Herhangi bir cihazda, telefonunuzda da açabilirsiniz.',
  'Its page asks for this code:': 'Açılan sayfa bu kodu soracak:',
  'Your code: {code}': 'Kodunuz: {code}',
  "Keep this screen open, or note the code. The email doesn't contain it.":
    'Bu ekranı açık tutun ya da kodu not edin. E-postada bu kod yok.',
  'Finish signing in': 'Girişi tamamlayın',
  'Type the code shown where you started signing in: in Kovan, or on the page that sent this email.':
    'Girişi başlattığınız yerde gösterilen kodu yazın: Kovan uygulamasında ya da bu e-postayı gönderen sayfada.',
  Code: 'Kod',
  "Didn't try to sign in? Ignore this email. Without the code, nobody can sign in with it.":
    'Giriş yapmaya çalışmadınız mı? Bu e-postayı yok sayın. Kod olmadan kimse bununla giriş yapamaz.',
  'Confirm your email': 'E-postanızı onaylayın',
  'Confirm {email} for the Kovan account of {name}? Only confirm it if that is your account.':
    '{email} adresi {name} adlı Kovan hesabı için onaylansın mı? Yalnız sizin hesabınızsa onaylayın.',
  'Confirm my email': 'E-postamı onayla',
  'Not your account? Close this page; the address stays unconfirmed.':
    'Hesap sizin değil mi? Bu sayfayı kapatın; adres onaylanmamış kalır.',
  'Going back to the Kovan app.': 'Kovan uygulamasına dönülüyor.',
  'Open Kovan': "Kovan'ı aç",
  'You are signed in': 'Giriş yaptınız',
  'Email verified': 'E-posta onaylandı',
  'Email changed': 'E-posta değişti',
  'Your account email changed since this link was sent.':
    'Bu bağlantı gönderildikten sonra hesabınızın e-postası değişti.',
  'Link expired': 'Bağlantının süresi doldu',
  'Start signing in again from Kovan.': "Kovan'dan yeniden giriş yapmayı başlatın.",
  'This link was already used or has expired.':
    'Bu bağlantı zaten kullanılmış ya da süresi dolmuş.',
  'Sign-in failed': 'Giriş yapılamadı',
  'Missing sign-in details.': 'Giriş bilgileri eksik.',
  'Sign-in cancelled': 'Giriş iptal edildi',
  'Nothing changed. You can try again from Kovan.':
    "Hiçbir şey değişmedi. Kovan'dan yeniden deneyebilirsiniz.",
  'Check the address': 'Adresi kontrol edin',
  'That email address does not look right.': 'Bu e-posta adresi doğru görünmüyor.',
  'Wrong password': 'Parola yanlış',
  'Not available': 'Kullanılamıyor',
  'Not found': 'Bulunamadı',
  'That page does not exist.': 'Böyle bir sayfa yok.',
  'Not available yet': 'Henüz yok',
  "This build hasn't been published yet. Another platform's may be, and the terminal agent works everywhere.":
    'Bu sürüm henüz yayımlanmadı. Başka bir platformunki olabilir; terminal ajanı her yerde çalışır.',
  'Back to downloads': 'İndirmelere dön',
  'Get Kovan': "Kovan'ı edinin",
  'Downloads for macOS, Windows and Linux.': 'macOS, Windows ve Linux için indirmeler.',
  'The code was wrong too many times, so this link no longer works. Start signing in again from Kovan.':
    "Kod çok kez yanlış girildi, bu bağlantı artık çalışmıyor. Kovan'dan yeniden giriş yapmayı başlatın.",

  'Link stopped': 'Bağlantı durduruldu',
  "That code doesn't match. Check the screen where you started signing in. If you didn't, ignore this email.":
    'Kod eşleşmiyor. Girişi başlattığınız ekranı kontrol edin. Siz başlatmadıysanız bu e-postayı yok sayın.',

  // ---------- emails ----------
  "If you didn't expect this, you can ignore it.": 'Bunu beklemiyorduysanız yok sayabilirsiniz.',
  "Open this link on any device. Its page asks for the code shown where you started signing in. Didn't try to sign in? Ignore this email: without that code nobody can use it.":
    'Bu bağlantıyı herhangi bir cihazda açın. Açılan sayfa, girişi başlattığınız yerde gösterilen kodu soracak. Giriş yapmaya çalışmadınız mı? Bu e-postayı yok sayın: o kod olmadan kimse kullanamaz.',
  'Verify your email for Kovan': 'Kovan için e-postanızı onaylayın',
  'Open this link to confirm your address for your Kovan account. Invites and session alerts go here.':
    'Kovan hesabınızın adresini onaylamak için bu bağlantıyı açın. Davetler ve oturum uyarıları buraya gelir.',
  'Verify email': 'E-postayı onayla',
  '{name} added you to {workspace} on Kovan':
    "{name} sizi Kovan'da {workspace} çalışma alanına ekledi",
  '{name} added you to {workspace} as {role}. Open Kovan on your computer or phone: {workspace} is in your workspaces now.':
    "{name} sizi {workspace} çalışma alanına {role} olarak ekledi. Kovan'ı bilgisayarınızda ya da telefonunuzda açın: {workspace} artık çalışma alanlarınız arasında.",
  'How to get started': 'Nasıl başlanır',
  '{name} invited you to {workspace} on Kovan':
    "{name} sizi Kovan'da {workspace} çalışma alanına davet etti",
  '{name} invited you to work on {workspace} in Kovan, as {role}.':
    "{name} sizi Kovan'da {workspace} üzerinde çalışmaya, {role} olarak davet etti.",
  'Kovan is where a team and its AI coding agents work on the same code together; you can follow it from your phone too.':
    'Kovan, bir ekibin ve yapay zekâ kodlama ajanlarının aynı kod üzerinde birlikte çalıştığı yerdir; telefonunuzdan da takip edebilirsiniz.',
  'The page below says what you need and lets you join with the account you sign in with.':
    'Aşağıdaki sayfa neye ihtiyacınız olduğunu söyler ve giriş yaptığınız hesapla katılmanızı sağlar.',
  'The invite works until it is used or {name} takes it back.':
    'Davet, kullanılana ya da {name} geri alana kadar geçerlidir.',
  'See the invite': 'Daveti gör',
  // The role words of packages/shared ROLE_WORDS, as an email says them.
  'a viewer: you can watch sessions and what the agents do':
    'izleyici: oturumları ve ajanların yaptıklarını izleyebilirsiniz',
  'a commenter: you can watch and leave comments': 'yorumcu: izleyebilir ve yorum bırakabilirsiniz',
  'an editor: you can run agents and change the code':
    'düzenleyici: ajan çalıştırabilir ve kodu değiştirebilirsiniz',
  'an owner: you can also manage people and billing':
    'sahip: ayrıca kişileri ve ödemeleri yönetebilirsiniz',

  // ---------- push notifications ----------
  'Your agent asks: {title}': 'Ajanınız soruyor: {title}',
  '{name} asks: {title}': '{name} soruyor: {title}',
  "{name}'s agent asks: {title}": '{name} adlı kişinin ajanı soruyor: {title}',
  'Approve or deny it.': 'Onaylayın ya da reddedin.',
  'Your agent finished': 'Ajanınız bitirdi',
  'Your agent stopped': 'Ajanınız durdu',
  'Your agent hit an error': 'Ajanınız bir hatayla karşılaştı',
  'Your agent stopped after too many steps': 'Ajanınız çok fazla adımdan sonra durdu',
  'Open the session to see what it did.': 'Ne yaptığını görmek için oturumu açın.',
  '{name} handed you their work': '{name} işini size devretti',
  'Open it to take it over.': 'Devralmak için açın.',
  'Your swarm ended with failed tasks': "Swarm'ınız başarısız görevlerle bitti",
  'Your swarm finished': "Swarm'ınız bitti",
  '{name} stopped your swarm': "{name} Swarm'ınızı durdurdu",
  Someone: 'Biri',
  'Your swarm paused itself': "Swarm'ınız kendini duraklattı",
  'Spent {amount}. Its report is in the swarm chat.': '{amount} harcandı. Raporu Swarm sohbetinde.',
  'A Swarm task waits for your approval: {title}': 'Bir Swarm görevi onayınızı bekliyor: {title}',
  'Approve or reject it.': 'Onaylayın ya da reddedin.',
  '{name} asks you': '{name} size soruyor',
  '{name} is stuck': '{name} takıldı',
  '{name} wrote to you': '{name} size yazdı',
  '{name} mentioned you': '{name} sizden bahsetti',
  "{name}'s agent stopped: {reason}": '{name} adlı kişinin ajanı durdu: {reason}',
  'It waits for someone to take over.': 'Birinin devralmasını bekliyor.',

  // ---------- errors ----------
  "Something went wrong on Kovan's server. Try again; if it keeps happening, tell us at kovan@alperkayan.dev and mention {id}.":
    "Kovan'ın sunucusunda bir şeyler ters gitti. Yeniden deneyin; sürerse kovan@alperkayan.dev adresine yazıp {id} kodunu belirtin.",
  "Your role in this workspace doesn't allow this. Ask one of its owners if you need it.":
    'Bu çalışma alanındaki rolünüz buna izin vermiyor. Gerekirse sahiplerinden birine sorun.',
  "That isn't here any more, or you don't have access to it.":
    'Bu artık burada değil ya da erişiminiz yok.',
  "This Kovan server doesn't sell model usage. Use your own model key instead: in the app, Settings → Model keys & spend; in the terminal, kovan setup.":
    'Bu Kovan sunucusu model kullanımı satmıyor. Bunun yerine kendi model anahtarınızı kullanın: uygulamada Ayarlar → Model keys & spend; terminalde kovan setup.',
  'A workspace needs at least one owner': 'Bir çalışma alanının en az bir sahibi olmalı',
  'Add a card for the organization first': 'Önce kuruluş için bir kart ekleyin',
  'Add a payment method first': 'Önce bir ödeme yöntemi ekleyin',
  'Another of your computers took it': 'Bilgisayarlarınızdan bir başkası aldı',
  'Join the session to run an agent in it': 'Bir ajan çalıştırmak için oturuma katılın',
  'Join the session with your agent first': 'Önce ajanınızla oturuma katılın',
  'No card was saved. Try adding it again.': 'Kart kaydedilmedi. Yeniden eklemeyi deneyin.',
  'Only an organization owner can change this': 'Bunu yalnız bir kuruluş sahibi değiştirebilir',
  'Only an owner of the organization can change its billing':
    'Kuruluşun ödemesini yalnız sahiplerinden biri değiştirebilir',
  'Only the author can edit a comment': 'Bir yorumu yalnız yazan düzenleyebilir',
  'Only the organization’s owners can do this': 'Bunu yalnız kuruluşun sahipleri yapabilir',
  'Pause the swarm before changing its settings':
    "Ayarlarını değiştirmeden önce Swarm'ı duraklatın",
  "Payments aren't set up on this Kovan server.": 'Bu Kovan sunucusunda ödemeler kurulu değil.',
  'Someone already answered this': 'Buna zaten biri cevap verdi',
  'Someone already joined with this invite. Ask for a new one.':
    'Bu davetle zaten biri katıldı. Yeni bir davet isteyin.',
  'Someone is already taking over this lane': 'Bu şeridi zaten biri devralıyor',
  'That person is not in this workspace': 'Bu kişi bu çalışma alanında değil',
  "That sign-in isn't valid any more. Start signing in again from Kovan.":
    "Bu giriş artık geçerli değil. Kovan'dan yeniden giriş yapmayı başlatın.",
  "That's you": 'Bu sizsiniz',
  "That's your own lane": 'Bu sizin kendi şeridiniz',
  'The machine running the swarm is offline': "Swarm'ı çalıştıran makine çevrimdışı",
  'The session has ended.': 'Oturum sona erdi.',
  'The swarm changed meanwhile; look again': 'Bu arada Swarm değişti; yeniden bakın',
  'This API key is not allowed to do this.': 'Bu API anahtarının buna izni yok.',
  'This API key is not valid or was revoked.': 'Bu API anahtarı geçersiz ya da iptal edilmiş.',
  'This handoff is closed': 'Bu devir kapandı',
  'This invite link is not valid. Ask for a new one.':
    'Bu davet bağlantısı geçersiz. Yeni bir tane isteyin.',
  'This invite was taken back. Ask for a new one.': 'Bu davet geri alındı. Yeni bir tane isteyin.',
  'This is a Solo workspace: switch it to Team or Adaptive to invite people':
    'Bu bir Solo çalışma alanı: kişi davet etmek için Team ya da Adaptive yapın',
  'This phone is not registered for notifications': 'Bu telefon bildirimler için kayıtlı değil',
  'This request was already answered': 'Bu isteğe zaten cevap verildi',
  'This session already has a swarm': "Bu oturumun zaten bir Swarm'ı var",
  'This session has ended': 'Bu oturum sona erdi',
  'This takeover is no longer waiting': 'Bu devralma artık beklemiyor',
  'This workspace has no repository.': 'Bu çalışma alanının deposu yok.',
  'This workspace no longer exists.': 'Bu çalışma alanı artık yok.',
  "You don't have a lane in this session": 'Bu oturumda şeridiniz yok',
  'Your account has no email address': 'Hesabınızın e-posta adresi yok',
  'Your computer is offline. Open Kovan on your desktop and try again.':
    "Bilgisayarınız çevrimdışı. Masaüstünüzde Kovan'ı açıp yeniden deneyin.",
  'Your email is already verified': 'E-postanız zaten onaylı',
  'Session not found': 'Oturum bulunamadı',
  'Workspace not found': 'Çalışma alanı bulunamadı',
  'Invite not found': 'Davet bulunamadı',
  'Comment not found': 'Yorum bulunamadı',
  'Member not found': 'Üye bulunamadı',
  'Swarm not found': 'Swarm bulunamadı',
  'Step not found': 'Adım bulunamadı',
  'Machine not found': 'Makine bulunamadı',
  'Organization not found': 'Kuruluş bulunamadı',
};
