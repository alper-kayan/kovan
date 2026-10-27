#!/bin/sh
# Builds Kovan's Linux AppImage (x86_64) on the release Mac, in Docker, from the committed
# source, the way the release workflow would: the update feed is signed with the update key
# (secrets/desktop-update/keys.env, see deploy/README.md "The update key") and checked, and the
# AppImage runs its own self-test. Output: the folder given (default /tmp/kovan-linux/release).
#   deploy/build-linux.sh [out-dir]
set -eu
cd "$(git rev-parse --show-toplevel)"
OUT=${1:-/tmp/kovan-linux}
KEYS=secrets/desktop-update/keys.env
[ -f "$KEYS" ] || { echo "No update key: node apps/desktop/scripts/update-key.mjs generate > $KEYS"; exit 1; }
set -a
. "./$KEYS"
set +a
rm -rf "$OUT"
mkdir -p "$OUT/release"
git archive --format=tar -o "$OUT/src.tar" HEAD
# The source is copied into the container: building on a folder shared with macOS is slow.
docker run --rm --platform linux/amd64 \
  -e KOVAN_UPDATE_PRIVATE_KEY -e KOVAN_UPDATE_PUBLIC_KEY -e CI=1 \
  -e NODE_OPTIONS=--max-old-space-size=6144 \
  -e KOVAN_BUILD_SERVER_URL=https://kovan.alperkayan.dev \
  -e KOVAN_UPDATE_URL=https://kovan.alperkayan.dev/updates \
  -v "$OUT:/out" node:26-bookworm bash -euc '
    apt-get update -qq
    apt-get install -y -qq python3 make g++ xvfb xauth libgtk-3-0 libnss3 libasound2 libgbm1 \
      libxss1 libxtst6 libsecret-1-0 >/dev/null
    npm install -g pnpm@11.18.0 >/dev/null
    mkdir /build && tar -xf /out/src.tar -C /build && cd /build
    pnpm install --frozen-lockfile
    # One package at a time: emulated x86_64 Node needs the memory for the desktop build.
    pnpm turbo run build --concurrency=1
    cd apps/desktop
    # executableName: in the config since 0.1.0 was cut; given here for that commit.
    npx electron-builder --config electron-builder.config.cjs --linux --publish never \
      -c.linux.executableName=kovan
    node scripts/update-key.mjs sign release/latest-linux.yml
    node scripts/update-key.mjs verify release/latest-linux.yml
    chmod +x release/Kovan-linux-x86_64.AppImage
    # The app inside the AppImage (release/linux-unpacked): emulated x86_64 on an ARM Mac cannot
    # start the AppImage itself (its ELF header carries the AppImage mark, "Exec format error").
    xvfb-run -a release/linux-unpacked/kovan --no-sandbox --self-test
    cp release/Kovan-linux-x86_64.AppImage release/latest-linux.yml release/latest-linux.yml.sig /out/release/
    cp release/*.blockmap /out/release/ 2>/dev/null || true
  '
rm -f "$OUT/src.tar"
ls -la "$OUT/release"
