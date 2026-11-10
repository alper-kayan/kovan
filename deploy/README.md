# Deploying Kovan

Two things ship: the **server** (one Docker image: API, WebSocket, website) and the **desktop
installers** (built and signed by `.github/workflows/release.yml`).

## Server

1. Create a managed PostgreSQL 17 database with TLS and point-in-time recovery.
2. `cp deploy/.env.example deploy/.env` and fill it in. `ENCRYPTION_KEYS`, `SMTP_URL` and
   `BACKUP_PASSPHRASE` are required. Keep a copy of `ENCRYPTION_KEYS` and `BACKUP_PASSPHRASE`
   outside the machine: without them stored transcripts and backups can't be read.
3. Point the domain's DNS at the machine, then:

   ```sh
   docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
   ```

   Caddy gets and renews the TLS certificate on its own. The server runs migrations at start,
   as a non-root user on a read-only filesystem. `GET /health` answers `{"ok":true}` when the
   database is reachable.

4. OAuth callback URLs: `https://<domain>/auth/github/callback` and
   `https://<domain>/auth/google/callback`. Stripe webhook: `https://<domain>/webhooks/stripe`
   (events `checkout.session.completed`, `payment_intent.succeeded`,
   `payment_intent.payment_failed`).

### A host with its own proxy

When the machine already runs a reverse proxy on 80/443, use
`deploy/docker-compose.single-host.yml` instead: the server, its own Postgres and the backup
service, with only `127.0.0.1:4807` published. Its `.env` takes `POSTGRES_PASSWORD` in place of
`DATABASE_URL`. Point the host's proxy at it, unbuffered (WebSockets and streamed answers):

```
kovan.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:4807 {
		flush_interval -1
	}
}
```

Without a mail provider, that compose file can send mail itself: start it with `--profile mail`
and set `SMTP_URL=smtp://mail:25` (`deploy/mail`: send-only Postfix with DKIM). It prints the DNS
records it needs at every start (`docker compose … logs mail`): SPF, the DKIM key, DMARC, and the
reverse DNS name to set at the hosting provider. Until those exist, large providers reject its
mail. Keep the folder in `DKIM_DIR`; a new key means a new DNS record.

### Push

The server sends the mobile app's notifications straight to Apple (APNs) and Firebase (FCM v1).
Put the keys in a folder outside the repo, readable by the container's `node` user (uid 1000):

```
install -d -m 500 -o 1000 -g 1000 /srv/kovan/push
install -m 400 -o 1000 -g 1000 AuthKey_XXXXXXXXXX.p8 /srv/kovan/push/apns.p8
install -m 400 -o 1000 -g 1000 firebase-adminsdk.json /srv/kovan/push/fcm.json
```

and in `.env`: `PUSH_DIR=/srv/kovan/push`, `APNS_KEY_FILE=/push/apns.p8`, `APNS_KEY_ID`,
`APNS_TEAM_ID`, `FCM_KEY_FILE=/push/fcm.json` (and `APNS_TOPIC` when the app's bundle id isn't
`dev.alperkayan.kovan`). Without them the server runs without push.

### Backups

The `backup` service writes an encrypted `pg_dump` to `BACKUP_DIR` every night and deletes
files older than `BACKUP_KEEP_DAYS`. Sync that folder to versioned object storage. This is on
top of the database provider's own recovery, not instead of it.

```sh
# one backup now
docker compose -f deploy/docker-compose.yml --env-file deploy/.env run --rm backup once
# restore (replaces what is in DATABASE_URL)
docker compose -f deploy/docker-compose.yml --env-file deploy/.env run --rm backup restore /backups/kovan-<stamp>.dump.enc
```

Test a restore into a scratch database before you rely on it.

### Outside monitor

A small process on another machine (ours runs on the Pi) checks `/health` and the site every
minute. After three failures in a row it tells the operator's iPhone, again every hour while the
server stays down, and once more when it is back. It sends straight to Apple with the APNs key,
so the warning doesn't need the server it is about. Which phones: while the server is up the
monitor fetches the push tokens of `OPS_EMAIL`'s account from `GET /api/ops/push-targets`
(`Authorization: Bearer <OPS_TOKEN>`) every half hour and keeps them in its state file.

On the server, in `.env`: `OPS_TOKEN` (32+ random characters, `openssl rand -hex 32`) and
`OPS_EMAIL` (the operator's Kovan account). On the monitor's machine (Node 20+, user systemd with
lingering on), as a user other than the one agentd runs as, since agents shouldn't be able to
read the APNs key:

```sh
pnpm --filter @kovan/server build:monitor     # apps/server/dist/monitor.mjs, one file
# copy it, the APNs .p8 and deploy/monitor/kovan-monitor.service over, then on that machine:
#   ~/kovan-monitor/monitor.env (chmod 600):
#     KOVAN_URL=https://kovan.alperkayan.dev
#     OPS_TOKEN=…   APNS_KEY_FILE=apns.p8   APNS_KEY_ID=…   APNS_TEAM_ID=…
#     STATE_FILE=state.json
cd ~/kovan-monitor && set -a && . ./monitor.env && set +a && node monitor.mjs --test   # one test notification
systemctl --user daemon-reload && systemctl --user enable --now kovan-monitor
journalctl --user -u kovan-monitor -f
```

Optional: `INTERVAL_SECONDS` (60), `FAIL_AFTER` (3), `TZ` for the times in the messages.

While the server is up the monitor also looks, every 5 minutes, at the HTTPS certificate (under
14 days left) and at the host's own report: a disk 85% full or more, under 10% free memory, one
of Kovan's containers stopped, unhealthy or restarting 3 times within an hour, no backup newer
than 26 hours, or a report older than 20 minutes. A new problem is told once ("Kovan needs a
look"), again a day later if it stays, and when it is gone ("Kovan is fine again"). The report
comes from `deploy/ops-status.py`, run by cron on the host as root into `/srv/kovan/ops`
(`OPS_DIR` in `.env`, mounted read-only; the server serves it at `GET /api/ops/status`):

```sh
mkdir -p /srv/kovan/ops && echo 'OPS_DIR=/srv/kovan/ops' >> /srv/kovan/.env
echo '*/5 * * * * root /usr/bin/python3 /srv/kovan/src/deploy/ops-status.py' > /etc/cron.d/kovan-ops
```

It also reads what failed on the server (`GET /api/ops/errors?since=`): the server's own 500s,
written to the `error_reports` table as source `server` (route pattern and message, at most 60
a minute, the rest only counted), and the desktop apps' reports. Grouped by kind (ids and
numbers taken out), a kind not seen in 30 days is told once ("New error on Kovan"), and 30 or
more in one look as a burst, at most once an hour. The first look only learns what is usual.

The same machine keeps a copy of the backups (`deploy/monitor/pull-backups.sh`, daily at 03:30
UTC by `kovan-backups.timer`, 30 days). It pulls with its own key, which root's
`authorized_keys` on the server lets read the backups folder and nothing else; the server has no
way into the monitor's machine. With `BACKUPS_DIR` in `monitor.env` the monitor also says when
the newest copy there is more than 30 hours old.

```sh
# on the monitor's machine
ssh-keygen -t ed25519 -N '' -C 'kovan backups' -f ~/.ssh/kovan-backups
# on the server, the public half, read-only into the backups folder:
echo 'command="/usr/bin/rrsync -ro /srv/kovan/backups/",restrict ssh-ed25519 AAAA… kovan backups' >> ~/.ssh/authorized_keys
# back on the monitor's machine
cp deploy/monitor/pull-backups.sh ~/kovan-monitor/ && cp deploy/monitor/kovan-backups.* ~/.config/systemd/user/
~/kovan-monitor/pull-backups.sh && systemctl --user enable --now kovan-backups.timer
echo "BACKUPS_DIR=$HOME/kovan-backups" >> ~/kovan-monitor/monitor.env && systemctl --user restart kovan-monitor
```

Once a week the host also restores the newest backup into a throwaway Postgres (no network,
data in memory) and checks it: tables, migrations and people against the live database
(`deploy/restore-drill.sh`, a few seconds). The passphrase stays in the backup container, which
decrypts the file into a pipe. The result is in the host's report: the monitor says when a
drill failed or none ran for 8 days, and when its own copy of the drilled file isn't the same
bytes as the server's.

```sh
echo '0 4 * * 0 root /srv/kovan/src/deploy/restore-drill.sh' > /etc/cron.d/kovan-restore-drill
```

A backup can only be read with `BACKUP_PASSPHRASE`, and what is in it (transcripts, tokens) only
with `ENCRYPTION_KEYS`. Keep both in a password manager as well: they are only in
`/srv/kovan/.env`, so losing the server loses the means to read the copies.

### Rotating the encryption key

Add a new pair with a higher id to `ENCRYPTION_KEYS` (`1:<old>,2:<new>`) and restart. New data
is written with the highest id; old data stays readable as long as its key is listed.

## Desktop releases

Push a tag `v<version>` matching `apps/desktop/package.json`. The workflow builds each platform
on its own OS, signs it, checks the signed bytes (Gatekeeper, Authenticode, the app's own
`--self-test`), and uploads everything to a **draft** GitHub release. Publish the draft to make
it the version people download and update to; `DOWNLOAD_BASE_URL` on the server should be
`https://github.com/<org>/<repo>/releases/latest/download`.

Repository variables: `KOVAN_SERVER_URL` (the production server, built into the app),
`KOVAN_UPDATE_PUBLIC_KEY`, and for Windows `KOVAN_AZURE_ENDPOINT`, `KOVAN_AZURE_ACCOUNT`,
`KOVAN_AZURE_PROFILE`.

Secrets:

| Platform | Secrets                                                                                                                                        |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS    | `MAC_CSC_LINK` (Developer ID Application .p12, base64), `MAC_CSC_KEY_PASSWORD`, `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` |
| Windows  | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` (Azure Trusted Signing)                                                            |
| Linux    | `KOVAN_UPDATE_PRIVATE_KEY`                                                                                                                     |

The workflow refuses to publish a platform whose signing material is missing.

### The update key

An AppImage carries no OS signature, so Linux builds check updates against an Ed25519 key:

```sh
node apps/desktop/scripts/update-key.mjs generate
```

Put the private half in the `KOVAN_UPDATE_PRIVATE_KEY` secret and the public half in the
`KOVAN_UPDATE_PUBLIC_KEY` variable. If the private key is ever lost or leaked, ship a release
with a new public key; Linux users on older builds then need one manual download.

### Building locally

```sh
pnpm build
pnpm --filter @kovan/desktop package:dir   # unpacked app in apps/desktop/release
apps/desktop/release/mac-arm64/Kovan.app/Contents/MacOS/Kovan --self-test
```

Without signing material macOS gets an ad-hoc signature: it runs on the machine that built it,
but it can't be distributed and can't update itself.

A signed, notarized macOS build on the release Mac (the Developer ID identity in the login
keychain, the App Store Connect API key file). `KOVAN_BUILD_SERVER_URL` must be set for
`pnpm build`, which is when it is built into the app; set only for electron-builder, the app
talks to `localhost:4807`:

```sh
export KOVAN_BUILD_SERVER_URL=https://kovan.alperkayan.dev KOVAN_UPDATE_URL=https://kovan.alperkayan.dev/updates
pnpm --filter @kovan/desktop... build
cd apps/desktop
CSC_NAME="Alper Kayan (N6U73MYJ6M)" APPLE_API_KEY=<AuthKey_….p8> APPLE_API_KEY_ID=… APPLE_API_ISSUER=… \
  npx electron-builder --config electron-builder.config.cjs --mac --publish never
```

### Windows builds

Without the GitHub workflow, Windows installers are built on our Windows Server 2022 machine
(`$WIN_HOST`; Node 26, Git, pnpm; OpenSSH with the release Mac's key only, no passwords).
They are unsigned: Windows shows "Windows protected your PC" on first run ("More info → Run
anyway"); the app and its updates work the same. `apps/desktop/build/icon.ico` is checked in
because electron-builder's own icon converter crashes there.

```sh
git archive --format=tar.gz -o /tmp/kovan-src.tar.gz HEAD
scp /tmp/kovan-src.tar.gz deploy/build-windows.ps1 Administrator@$WIN_HOST:C:/kovan-build/
ssh Administrator@$WIN_HOST 'Remove-Item -Recurse -Force C:\kovan-build\src -ErrorAction SilentlyContinue; mkdir C:\kovan-build\src | Out-Null; tar -xzf C:\kovan-build\kovan-src.tar.gz -C C:\kovan-build\src'
# held open (a background process dies with the SSH session)
ssh Administrator@$WIN_HOST 'powershell -NoProfile -ExecutionPolicy Bypass -File C:\kovan-build\build-windows.ps1'
```

Then copy `Kovan-win*.exe`, their `.blockmap`s and `latest.yml` (last) to `/srv/kovan/releases`
and `chmod 644` them: scp from Windows keeps them readable by their owner only, and the server
answers 500 for a file it can't read.

### Linux builds

The AppImage is built on the release Mac in Docker (x86_64, emulated; about 15 minutes) from
the committed source: `deploy/build-linux.sh [out-dir]`. It signs `latest-linux.yml` with the
update key in `secrets/desktop-update/keys.env` (made once with `update-key.mjs generate`, kept
out of git, backed up somewhere safe), checks the signature, and runs the app's self-test. Copy
the AppImage, then `latest-linux.yml` and its `.sig`, to `/srv/kovan/releases` (`chmod 644`).
For the release workflow the same pair goes in the `KOVAN_UPDATE_PRIVATE_KEY` secret and the
`KOVAN_UPDATE_PUBLIC_KEY` variable.

### Releases served by the server

While the repository is private its GitHub releases can't be downloaded by anyone else, so the
server hands the files out itself: `RELEASES_DIR` (`/releases` in the container, the host's
`RELEASES_HOST_DIR`, default `./releases` next to the compose file) serves `/updates/<file>`
and `/download/<platform>`. A platform with no installer in the folder shows "Not available
yet". Copy a release in with the update feed **last**, so an app never reads a feed whose files
aren't there yet:

```sh
cd apps/desktop/release
rsync -a Kovan-mac-arm64.dmg Kovan-mac-arm64.zip Kovan-mac-arm64.zip.blockmap root@<host>:/srv/kovan/releases/
rsync -a latest-mac.yml root@<host>:/srv/kovan/releases/
```

### The terminal agent (kovan CLI)

`kovan` ships as one file, `kovan.mjs`, served from `/srv/kovan/releases/cli/` (so at `/updates/cli/`).
People install it with `curl -fsSL https://kovan.alperkayan.dev/install.sh | sh`, or on Windows
`irm https://kovan.alperkayan.dev/install.ps1 | iex` (the scripts are `apps/web/public/install.sh`
and `install.ps1`, part of the website); installed copies look for `cli/latest.json`
every twelve hours and only take one signed with the update key. To publish a version, raise
`version` in `packages/cli/package.json` and `VERSION` in `packages/cli/src/run.ts`, then:

```sh
set -a; . ./secrets/desktop-update/keys.env; set +a   # embeds the public key, signs latest.json
pnpm --filter @kovan/cli... build && pnpm --filter @kovan/cli bundle
mkdir -p /tmp/cli && cp packages/cli/dist-bundle/kovan.mjs /tmp/cli/
rsync -a --chmod=D755,F644 /tmp/cli/ root@<host>:/srv/kovan/releases/cli/
cp packages/cli/dist-bundle/latest.json packages/cli/dist-bundle/latest.json.sig /tmp/cli/
rsync -a --chmod=D755,F644 /tmp/cli/ root@<host>:/srv/kovan/releases/cli/   # the manifest last
```

The public key is also written into `install.sh` and `install.ps1`; if the update key is ever
replaced, change it there too.

## Mobile app

`apps/mobile` (Expo) is built on this Mac: Xcode for iOS, Gradle for Android. EAS and Expo's
cloud services aren't used. `ios/` and `android/` aren't in git; `pnpm --filter @kovan/mobile
native` builds the packages the app uses (`@kovan/shared`, `@kovan/jevrouter`; the release
bundle reads their `dist/`) and makes the native projects from `app.json` and the config
plugins in `apps/mobile/plugins` (`expo prebuild --clean`). Never change `ios/` or `android/`
by hand: the next prebuild throws it away. Expo's iOS modules are built from source
(`plugins/withModulesFromSource.js`): its precompiled ones don't load with Xcode 27's Swift. `patches/expo-modules-jsi@57.1.2.patch`
fixes Expo's script that builds `ExpoModulesJSI`: Swift 6.4 spells the C++ extensions it has to
strip from the module interface differently, and an archive failed with "cannot find type
'__ObjC::expo'". Drop the patch when an Expo update fixes the script. Run it
after pulling, after a native dependency or `app.json` changes, and before every store build.

The app talks to `https://kovan.alperkayan.dev` unless someone changes the server on the
sign-in screen.

### Versions

`app.json` holds them: `version` is what people see, `ios.buildNumber` and
`android.versionCode` must be new for every upload. Before a store build:

```sh
pnpm --filter @kovan/mobile bump                    # next build of the same version
pnpm --filter @kovan/mobile bump -- --version 0.2.0 # a new version (iOS build starts at 1)
pnpm --filter @kovan/mobile native
```

Commit `app.json` with the build so the next one doesn't reuse its number.

### Once

1. Accounts: the Apple Developer Program membership (team `N6U73MYJ6M`, already in `app.json`
   as `ios.appleTeamId`) and a Google Play Console developer account. Xcode → Settings →
   Accounts: add the Apple ID that is on the team.
2. App Store Connect → Apps → New App: iOS, bundle ID `dev.alperkayan.kovan`, name "Kovan".
3. Play Console → Create app: "Kovan", app, free. The package name comes with the first upload.
4. Android upload key, kept out of git (`secrets/` is ignored) and backed up somewhere safe:

   ```sh
   keytool -genkeypair -keystore secrets/kovan-upload.jks -alias upload -keyalg RSA \
     -keysize 2048 -validity 10000
   ```

   and in `~/.gradle/gradle.properties` (not the project's):

   ```properties
   KOVAN_UPLOAD_STORE_FILE=<repo>/secrets/kovan-upload.jks
   KOVAN_UPLOAD_STORE_PASSWORD=…
   KOVAN_UPLOAD_KEY_ALIAS=upload
   KOVAN_UPLOAD_KEY_PASSWORD=…
   ```

   `plugins/withReleaseSigning.js` signs release builds with it; without these properties a
   release build falls back to the debug key, which Play refuses. Let Google manage the app
   signing key (Play App Signing); if the upload key is lost, Play can reset it.

5. Push keys are the ones the server already has (`/srv/kovan/push`): the APNs `.p8` key works
   for TestFlight and App Store builds too (they use Apple's production service; the app reads
   which one from its provisioning profile and tells the server). FCM needs nothing more.
6. Store listing assets: the iOS icon is in the build. Play needs `apps/mobile/store/play-icon.png`
   (512 px, made by `node apps/mobile/scripts/icons.mjs`), a 1024×500 feature graphic and
   phone screenshots.

### TestFlight and the App Store (iOS)

1. `open apps/mobile/ios/Kovan.xcworkspace` (the workspace, not the `.xcodeproj`).
2. Scheme Kovan, destination "Any iOS Device (arm64)", then Product → Archive. Signing is
   automatic for team `N6U73MYJ6M`; the first archive creates the distribution certificate and
   profile.
3. The Organizer opens: Distribute App → App Store Connect → Upload. Leave "Manage version and
   build number" off: the numbers come from `app.json`.
4. After Apple's processing (10-30 minutes) the build is under TestFlight. Internal testers (up
   to 100 people on the team) can install it at once; external testers need a short beta review
   first. The export compliance question is answered in `app.json`
   (`ITSAppUsesNonExemptEncryption: false`: only standard HTTPS).
5. For the App Store: pick the build on the version's page in App Store Connect and submit it
   for review.

### Play (Android)

```sh
cd apps/mobile/android
JAVA_HOME=~/Library/Java/JavaVirtualMachines/jbr-21.0.11/Contents/Home ./gradlew bundleRelease
```

The bundle is `app/build/outputs/bundle/release/app-release.aab`. Play Console → Testing →
Internal testing → Create new release → upload it, add testers (an email list), and roll it
out; production releases go the same way under Production.

### Over-the-air updates

The app's JavaScript and assets can change without a store build (`expo-updates`). The Kovan
server hands updates out (`/api/mobile/updates/manifest`, Expo's update protocol 1); Expo's own
update service isn't used. Every update is signed on this Mac with
`secrets/mobile-updates/private-key.pem`, and the app only runs updates whose signature matches
the certificate built into it (`apps/mobile/certs/certificate.pem`, valid until 2036). The
server never sees the key: someone who breaks into it can stop updates, not send phones code.
**Back the key up** (a password manager): without it no installed build can be updated, only
replaced by a new store build with a new certificate.

An update reaches the builds with the same runtime version, which is the app's `version`.
Anything native (a new Expo or React Native module, a permission, a config plugin, an
`app.json` field outside JavaScript) needs a new `version` and a store build; only JavaScript,
styles and images go over the air. Apple allows this as long as the app does what it was
reviewed for.

```sh
cd apps/mobile
node scripts/updates.mjs publish --message "Fix the session list"   # both platforms
node scripts/updates.mjs publish --platform ios                        # one
node scripts/updates.mjs status                                        # what phones get
node scripts/updates.mjs rollback                                      # the update before
node scripts/updates.mjs rollback --embedded                           # the build's own code
```

`publish` builds the shared packages, runs `expo export`, signs one manifest per platform and
copies it with its files (and brotli / gzip copies) over ssh to
`root@31.57.156.109:/srv/kovan/mobile-updates` (`KOVAN_UPDATES_TARGET` changes it; a plain
folder works too). Phones check when the app starts and when it comes back after 30 minutes,
download in the background and offer "A new version of Kovan is ready · Restart" on the home
screen; it also starts by itself on the next launch, or when the app comes back after 10
minutes away. Going back to an older update publishes it again as a new one (a phone runs the
newest update it holds); the files aren't copied again.

On the server the folder is mounted read-only: `UPDATES_DIR=/srv/kovan/mobile-updates` in
`/srv/kovan/.env` (the default, `./mobile-updates` next to the compose file, is replaced on
every deploy).

Trying it before a release: start the local server with
`MOBILE_UPDATES_DIR=<folder>`, run `pnpm --filter @kovan/mobile native`, point the generated
project at it (`plutil -replace EXUpdatesURL -string
http://localhost:4807/api/mobile/updates/manifest apps/mobile/ios/Kovan/Supporting/Expo.plist`),
build the Release configuration for the simulator, then run `e2e/updates/1-built-in.yaml`,
`KOVAN_UPDATES_TARGET=<folder> KOVAN_UPDATES_SERVER=http://localhost:4807 node
scripts/updates.mjs publish --platform ios`, `2-updated.yaml`, `rollback --embedded` and
`3-rolled-back.yaml`. Debug builds never load updates. Run `native` again afterwards: the next
prebuild puts the production address back.

### Store questionnaires

- **Account deletion.** In the app (Account → Delete account…), on the desktop (Settings →
  Account) and on the website at `https://kovan.alperkayan.dev/account/#delete` (the link Play
  asks for). It shows what goes and what stays first and takes typing "delete". Workspaces only
  that person was in go with everything in them; shared ones stay, and the longest-standing
  person with the highest role becomes owner when they were the last owner. A failed payment
  that is still owed must be settled first; usage not charged yet is dropped, and the Stripe
  customer and saved card are deleted.
- **Sign in with Apple** (App Store guideline 4.8: an app that offers GitHub or Google sign-in
  must offer it too). iPhone only: the app gets Apple's identity token and the server checks it
  against Apple's public keys (`POST /auth/apple`); a verified email that matches an account
  links to it. When the account is deleted the server revokes the sign-in at Apple, as Apple
  requires. That needs a key with "Sign in with Apple" on: the APNs key has it (checked
  2026-10-25), so `APNS_KEY_*` / `APNS_TEAM_ID` are used unless `APPLE_SIGNIN_KEY_FILE`,
  `APPLE_SIGNIN_KEY_ID` and `APPLE_TEAM_ID` are set. The capability is on the App ID and in
  `app.json` (`ios.usesAppleSignIn`).
- **Privacy (App Store "App Privacy", Play "Data safety").** Collected and linked to the person:
  name and email (account), a push token per phone, and what they write (prompts, comments,
  steering). Agent transcripts are encrypted on the server. Nothing is used for tracking or
  ads, nothing is sold. Data goes over HTTPS. Privacy policy URL (both stores ask):
  `https://kovan.alperkayan.dev/privacy/`; terms: `/terms/`; support URL: `/contact/`.
- **Sign-in for reviewers.** Reviewers can't read our mail, so one account signs in with a
  password: `REVIEW_ACCOUNT_EMAIL` and `REVIEW_ACCOUNT_PASSWORD` (12+ characters) in
  `/srv/kovan/.env`. Typing that address on the sign-in page asks for the password instead of
  sending a link; a wrong password ends that sign-in. Everyone else keeps email links. The
  values for App Store Connect are in `secrets/app-review.txt` on the release Mac; the store
  text and the review notes are in `apps/mobile/store/app-store.md`.
- **Permissions.** Notifications only. The template's storage and overlay permissions are removed
  (`android.blockedPermissions`); the iOS privacy manifest lists the system APIs the app's
  libraries use (`ios.privacyManifests`).

### The reviewers' demo machine

Work started on the phone runs on the person's desktop; reviewers have none. When a swarm is
launched from the phone and none of the person's desktops is online, the server starts it on a
machine of the workspace instead (`DeskService.launchOnMachine`). The review account's
workspace, "Kovan Demo", has such a machine on the production server: agentd in its own
container (`deploy/agentd.Dockerfile`, `deploy/docker-compose.demo.yml`) with a sample
repository (`deploy/demo/sample-shop`, a cart with tests; its remote only names it, nothing is
fetched or pushed), Kovan's own agent on OpenRouter (the seed puts the team on GPT-5.6 Luna), one
slot, no push. When a swarm is done the machine ends its session with the final diff
(`KOVAN_END_WHEN_DONE`): finished sessions go to History, and their files stop counting as
someone's live work (left open, they held the next sessions' edits to the same files). The workspace's monthly
agent limit ($5) and each swarm's budget cap what it spends.

```sh
# on the server, once: the machine key (Settings → Workspaces → Integrations of "Kovan Demo",
# scope machine) and an OpenRouter key, chmod 600
mkdir -p /srv/kovan/demo && cat > /srv/kovan/demo/.env <<'ENV'
KOVAN_API_KEY=kv_live_…
OPENROUTER_API_KEY=sk-or-…
ENV
chmod 600 /srv/kovan/demo/.env
cd /srv/kovan/src
docker compose -p kovan-demo -f deploy/docker-compose.demo.yml --env-file /srv/kovan/demo/.env up -d --build
docker logs -f kovan-demo-agentd-1
```

The container runs as `node`, read-only except its two volumes (the checkout and agentd's
state), with no capabilities, 1 GB of memory and one CPU. Deleting the `kovan-demo` volumes
starts the sample shop over.

## agentd: machines that run agents unattended

`agentd` (`packages/agentd`) runs Kovan's agents on a computer nobody sits at (a Raspberry Pi,
a spare laptop, a server). It registers as a machine of one workspace, reports every 30
seconds and runs the swarms sent to it (`"machine": "auto"` or its id when starting a session
or launching a swarm) in worktrees of the checkouts it holds. Machines are listed under
Settings → Workspaces → Integrations; a machine that stops reporting for 90 seconds counts as
offline and its running swarms are paused with the reason.

What its agents may run without asking: checks (`pnpm test`, `npx vitest`, `pytest`,
`go test`, `cargo test`, linters, type checks, builds) and reading (`ls`, `grep`, read-only
`git`). Pushing, publishing, deleting, installing and anything chained or piped are refused.
Tests run the repository's own code, so this is a guard against accidents, not a sandbox: run
agentd as its own user, with no push credentials and no sudo.

### Install (Linux, systemd)

Needs Node 22 or newer, git, and pnpm.

```sh
sudo useradd --create-home --shell /usr/sbin/nologin kovan
sudo -u kovan git clone https://github.com/alper-kayan/kovan.git /home/kovan/kovan
cd /home/kovan/kovan
sudo -u kovan pnpm install --frozen-lockfile
sudo -u kovan pnpm --filter @kovan/agentd... build
# the checkouts it offers, as the kovan user
sudo -u kovan git clone <repository> /home/kovan/work/<name>
```

In Kovan, as the organization's owner: Settings → Organization → Integrations → New key, scope
`machine` (such a machine serves every workspace whose repository it holds). A key from
Settings → Workspaces → Integrations limits it to one workspace. Then `/etc/kovan-agentd.env` (`chmod 600`, owned by root):

```sh
KOVAN_SERVER_URL=https://kovan.alperkayan.dev
KOVAN_API_KEY=kv_live_…
OPENROUTER_API_KEY=sk-or-…
KOVAN_WORKSPACE_ROOT=/home/kovan/work
KOVAN_MACHINE_NAME=pi
KOVAN_SLOTS=1
# KOVAN_PUSH=1 pushes the session branch when a swarm finishes (needs push access)
# KOVAN_END_WHEN_DONE=1 ends the session with its final diff when its swarm is done
```

```sh
sudo -u kovan node packages/agentd/dist/index.js unit systemd | sudo tee /etc/systemd/system/kovan-agentd.service
sudo systemctl daemon-reload && sudo systemctl enable --now kovan-agentd
journalctl -u kovan-agentd -f
```

`systemctl stop` pauses what runs there ("pi: agentd was stopped"); resume it from the session
or with `POST /api/swarms/:id/launch` once the machine is back.

### Install (macOS, launchd)

With the variables above exported in the shell:

```sh
node packages/agentd/dist/index.js unit launchd > ~/Library/LaunchAgents/dev.alperkayan.kovan.agentd.plist
launchctl load ~/Library/LaunchAgents/dev.alperkayan.kovan.agentd.plist
```

The plist holds the key: keep it readable only by you (`chmod 600`).
