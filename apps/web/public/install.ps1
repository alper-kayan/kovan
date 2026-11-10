# Installs kovan, Kovan's coding agent in the terminal, for the person running it (no admin rights):
#
#   irm https://kovan.alperkayan.dev/install.ps1 | iex
#
# It needs Node.js 22 or newer. The program goes to ~\.kovan\cli\kovan.mjs and a `kovan` command to
# ~\.kovan\bin, which is added to your user PATH. The download is checked before anything is replaced:
# the manifest must be signed with Kovan's release key (the public half is below) and the file must
# match the manifest's SHA-256. After that, kovan keeps itself up to date the same way.
#
# Remove it again: delete ~\.kovan\cli and ~\.kovan\bin, and take ~\.kovan\bin out of your user PATH.
# (Kept to plain ASCII: Windows PowerShell 5.1 misreads anything else in a script without a BOM.)

function Install-Kovan {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  # Windows PowerShell 5.1 may still offer only old TLS versions by default.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $server = if ($env:KOVAN_SERVER) { $env:KOVAN_SERVER.TrimEnd('/') } else { 'https://kovan.alperkayan.dev' }
  $base = "$server/updates/cli"
  $dir = Join-Path $HOME '.kovan\cli'
  $bin = Join-Path $HOME '.kovan\bin'
  $releaseKey = 'MCowBQYDK2VwAyEAjXI3hMTfX9A+702BUaEdYSbndJ4Th70HWW4EPEvS8js='

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "kovan runs on Node.js 22 or newer, and node isn't on this machine. Install it from https://nodejs.org, then run this again."
  }
  $major = [int](& node -p "process.versions.node.split('.')[0]")
  if ($major -lt 22) {
    throw "kovan needs Node.js 22 or newer; this machine has $(& node --version). Update it from https://nodejs.org, then run this again."
  }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("kovan-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    Write-Host "Downloading kovan from $server..."
    foreach ($name in 'latest.json', 'latest.json.sig', 'kovan.mjs') {
      try {
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$name" -OutFile (Join-Path $tmp $name)
      } catch {
        throw "couldn't download $base/$name, so nothing was installed"
      }
    }

    # Node does the checking: the signature over the manifest's exact bytes, then the file's hash.
    $check = @'
const { createHash, createPublicKey, verify } = require("node:crypto");
const { readFileSync } = require("node:fs");
const [manifestFile, sigFile, bundleFile] = process.argv.slice(2);
const text = readFileSync(manifestFile);
const key = createPublicKey({ key: Buffer.from(process.env.RELEASE_KEY, "base64"), format: "der", type: "spki" });
const sig = Buffer.from(readFileSync(sigFile, "utf8").trim(), "base64");
if (!verify(null, text, key, sig)) { console.error("the release is not signed with Kovan's key"); process.exit(1); }
const m = JSON.parse(text);
const sha = createHash("sha256").update(readFileSync(bundleFile)).digest("hex");
if (sha !== m.sha256) { console.error("the download does not match the release's hash"); process.exit(1); }
console.log(m.version);
'@
    Set-Content -Path (Join-Path $tmp 'check.cjs') -Value $check -Encoding ASCII
    $env:RELEASE_KEY = $releaseKey
    $version = & node (Join-Path $tmp 'check.cjs') (Join-Path $tmp 'latest.json') (Join-Path $tmp 'latest.json.sig') (Join-Path $tmp 'kovan.mjs')
    $ok = $LASTEXITCODE -eq 0
    Remove-Item Env:RELEASE_KEY -ErrorAction SilentlyContinue
    if (-not $ok) { throw "the download didn't pass its check, so nothing was installed" }

    New-Item -ItemType Directory -Force -Path $dir, $bin | Out-Null
    $target = Join-Path $dir 'kovan.mjs'
    if (Test-Path $target) { Move-Item -Force $target "$target.old" }
    Move-Item -Force (Join-Path $tmp 'kovan.mjs') $target

    # A small launcher, so the program runs from its own folder and can replace itself when it updates.
    $launcher = "@echo off`r`nnode `"%USERPROFILE%\.kovan\cli\kovan.mjs`" %*`r`n"
    Set-Content -Path (Join-Path $bin 'kovan.cmd') -Value $launcher -Encoding ASCII -NoNewline
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @(if ($userPath) { $userPath -split ';' | Where-Object { $_ } })
  if ($parts -notcontains $bin) {
    [Environment]::SetEnvironmentVariable('Path', (($parts + $bin) -join ';'), 'User')
  }
  if ((($env:Path -split ';') -notcontains $bin)) { $env:Path = "$env:Path;$bin" }

  Write-Host "kovan $version is installed. Run it in a project folder:  kovan"
  Write-Host "(Other terminals that were already open pick it up once they are opened again.)"
}

Install-Kovan
