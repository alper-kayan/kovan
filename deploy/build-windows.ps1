# Builds Kovan's Windows installers (x64, ARM64 and one with both) on the Windows build server,
# as the release workflow would, without signing. Run over SSH from the release Mac after the
# committed source is unpacked to C:\kovan-build\src (deploy/README.md, "Windows builds").
# Output: C:\kovan-build\src\apps\desktop\release
$ErrorActionPreference = 'Stop'
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + $env:APPDATA + '\npm'
$env:KOVAN_BUILD_SERVER_URL = 'https://kovan.alperkayan.dev'
$env:KOVAN_UPDATE_URL = 'https://kovan.alperkayan.dev/updates'
$env:CI = '1'
Set-Location C:\kovan-build\src
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'install failed' }
pnpm build
if ($LASTEXITCODE -ne 0) { throw 'build failed' }
Set-Location apps\desktop
npx electron-builder --config electron-builder.config.cjs --win --publish never
if ($LASTEXITCODE -ne 0) { throw 'package failed' }
$test = Start-Process -FilePath release\win-unpacked\Kovan.exe -ArgumentList '--self-test' `
  -RedirectStandardOutput C:\kovan-build\selftest.txt -Wait -PassThru -NoNewWindow
if ($test.ExitCode -ne 0) { throw 'self-test failed' }
Get-ChildItem release -File | ForEach-Object { '{0}  {1:N1} MB' -f $_.Name, ($_.Length / 1MB) }
