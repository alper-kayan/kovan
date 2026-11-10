#!/bin/sh
# Installs kovan, Kovan's coding agent in the terminal, for the person running it (no sudo):
#
#   curl -fsSL https://kovan.alperkayan.dev/install.sh | sh
#
# It needs Node.js 22 or newer. The program goes to ~/.kovan/cli/kovan.mjs and a `kovan` command to
# ~/.local/bin (KOVAN_BIN_DIR changes it). The download is checked before anything is replaced: the
# manifest must be signed with Kovan's release key (the public half is below) and the file must match
# the manifest's SHA-256. After that, kovan keeps itself up to date the same way.
#
# Remove it again with:  rm -rf ~/.kovan/cli ~/.local/bin/kovan
set -eu

SERVER="${KOVAN_SERVER:-https://kovan.alperkayan.dev}"
BASE="${SERVER%/}/updates/cli"
DIR="$HOME/.kovan/cli"
BIN="${KOVAN_BIN_DIR:-$HOME/.local/bin}"
RELEASE_KEY="MCowBQYDK2VwAyEAjXI3hMTfX9A+702BUaEdYSbndJ4Th70HWW4EPEvS8js="

say() { printf '%s\n' "$*"; }
fail() {
  printf 'kovan: %s\n' "$*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is needed to download kovan."
command -v node >/dev/null 2>&1 ||
  fail "kovan runs on Node.js 22 or newer, and node isn't on this machine. Install it from https://nodejs.org, then run this again."
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 22 ] ||
  fail "kovan needs Node.js 22 or newer; this machine has $(node --version). Update it from https://nodejs.org, then run this again."

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading kovan from ${SERVER}..."
curl -fsSL "$BASE/latest.json" -o "$tmp/latest.json" || fail "couldn't reach $BASE/latest.json"
curl -fsSL "$BASE/latest.json.sig" -o "$tmp/latest.json.sig" || fail "the release has no signature, so it was not installed"
curl -fsSL "$BASE/kovan.mjs" -o "$tmp/kovan.mjs" || fail "couldn't download kovan.mjs"

# Node does the checking: the signature over the manifest's exact bytes, then the file's hash.
version=$(
  RELEASE_KEY="$RELEASE_KEY" node -e '
    const { createHash, createPublicKey, verify } = require("node:crypto");
    const { readFileSync } = require("node:fs");
    const [manifestFile, sigFile, bundleFile] = process.argv.slice(1);
    const text = readFileSync(manifestFile);
    const key = createPublicKey({ key: Buffer.from(process.env.RELEASE_KEY, "base64"), format: "der", type: "spki" });
    const sig = Buffer.from(readFileSync(sigFile, "utf8").trim(), "base64");
    if (!verify(null, text, key, sig)) { console.error("the release is not signed with Kovan’s key"); process.exit(1); }
    const m = JSON.parse(text);
    const sha = createHash("sha256").update(readFileSync(bundleFile)).digest("hex");
    if (sha !== m.sha256) { console.error("the download does not match the release’s hash"); process.exit(1); }
    console.log(m.version);
  ' "$tmp/latest.json" "$tmp/latest.json.sig" "$tmp/kovan.mjs"
) || fail "the download didn't pass its check, so nothing was installed"

mkdir -p "$DIR" "$BIN"
chmod 755 "$tmp/kovan.mjs"
[ -f "$DIR/kovan.mjs" ] && mv -f "$DIR/kovan.mjs" "$DIR/kovan.mjs.old"
mv -f "$tmp/kovan.mjs" "$DIR/kovan.mjs"

# A small launcher, so the program runs from its own folder and can replace itself when it updates.
cat >"$BIN/kovan" <<'LAUNCHER'
#!/bin/sh
exec node "$HOME/.kovan/cli/kovan.mjs" "$@"
LAUNCHER
chmod 755 "$BIN/kovan"

say "kovan $version is installed."
case ":$PATH:" in
  *":$BIN:"*) say "Run it in a project folder:  kovan" ;;
  *)
    say "$BIN isn't on your PATH yet. Add this line to your shell's startup file (~/.zshrc or ~/.bashrc):"
    say "  export PATH=\"$BIN:\$PATH\""
    say "Then open a new terminal and run:  kovan"
    ;;
esac
