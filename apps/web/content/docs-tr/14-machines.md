# Makineler: çalışmayı sürdüren ajanlar

Normalde bir ajan masaüstü uygulamasının içinde çalışır ve uygulamayı kapatınca durur. Bir makine ise başında kimse olmadan iş almaya devam eder: arka planda kendi bilgisayarınız ya da bir sunucu.

## Bilgisayarınız, arka planda

**Ayarlar → Ajanlar → Issue'lar ve arka plan işleri → Arka plan ajanları** (Settings → Agents → Issues and background work → Background agents), bu bilgisayarda organizasyonunuzun bir makinesi olarak çalışan küçük bir program başlatır. Ona gönderilen iş (Kovan'dan, telefondan ya da bir entegrasyondan), uygulamayı kapattıktan sonra da açtığınız klasörlerde, aboneliğinizdeki Claude Code ile sürer.

## Bir sunucu

`kovan-agentd`, bir sunucuda ya da Raspberry Pi gibi küçük bir bilgisayarda aynı şekilde çalışır. İhtiyacı olanlar:

- üzerinde çalışacağı her deponun bir çalışma kopyası,
- `machine` kapsamlı bir [API anahtarı](/tr/docs/integrations-and-api/) (bir organizasyonun anahtarı, deposunu tuttuğu her çalışma alanında işe yarar),
- bir ajan: o makinede giriş yapılmış Claude Code ya da Codex, veya Kovan'ın kendi ajanı için bir OpenRouter anahtarı.

Ortam değişkenleriyle ayarlanır (`KOVAN_SERVER_URL`, `KOVAN_API_KEY`, `KOVAN_REPOS` ve diğerleri; `kovan-agentd --help` hepsini listeler) ve kendisi için bir systemd ya da launchd servisi tanımı yazdırabilir. Depoda bunun için `deploy/` altında bir Dockerfile var.

## Neyi yapar, neyi yapmaz

"Herhangi bir makine" seçilerek gönderilen iş, depoyu tutan bir makineye gider. Ajanlarının çalıştırdığı komutlar kontrollerle ve okumayla sınırlıdır (testler, linter'lar, derlemeler, `git status`, `diff`, `log`); push, yayınlama, silme ve kurulum reddedilir. Makineyi push kimlik bilgileri ve yönetici hakları olmayan ayrı bir kullanıcıyla çalıştırın: çalıştırdığı testler deponun kodudur.

Fetch ve push işlemleri Kovan'ın sunucusu üzerinden geçer; sunucu çalışma alanının GitHub token'ını ekler, böylece makine onu hiç tutmaz.
