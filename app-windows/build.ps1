<#
  Builds Kokuban for Windows: icon, tests, a self-contained publish and (with -Pack) a Velopack release.

    ./build.ps1                 icon, tests, publish to out/publish
    ./build.ps1 -Pack           ...and pack it with Velopack into this PC's app feed
    ./build.ps1 -SkipTests      for a quick local run
#>
param(
  [ValidateSet('x64', 'arm64')] [string]$Arch = 'x64',
  [string]$Configuration = 'Release',
  [switch]$SkipTests,
  [switch]$Pack,
  # Where the release goes: this PC's board serves it to its own app and gives it to paired PCs (src/app-update.ts).
  [string]$Feed = (Join-Path $env:LOCALAPPDATA 'kokuban\app-releases')
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = Split-Path $here
$rid = "win-$Arch"
$out = Join-Path $here 'out'

function Step($text) { Write-Host "== $text" }
# dotnet finds global.json (the test runner) from the current folder: work from this one, wherever it was called from.
Push-Location $here
try {
function Run($exe, [string[]]$argv) {
  & $exe @argv
  if ($LASTEXITCODE -ne 0) { throw "$exe $($argv -join ' ') failed ($LASTEXITCODE)" }
}

Step 'icon'
Run dotnet @('run', '--project', "$here/tools/IconGen", '-c', 'Release', '--', "$root/assets/icon.svg", "$here/Kokuban.App/Assets")

if (-not $SkipTests -and (Test-Path "$here/Kokuban.Core.Tests/Kokuban.Core.Tests.csproj")) {
  Step 'tests'
  Run dotnet @('test', '--project', "$here/Kokuban.Core.Tests", '-c', $Configuration)
}

Step "publish $rid"
$version = ([xml](Get-Content "$here/Kokuban.App/Kokuban.App.csproj")).Project.PropertyGroup.Version | Where-Object { $_ } | Select-Object -First 1
# A folder per version: a copy already running from an earlier publish keeps its files.
$publish = Join-Path $out "$version-$Arch"
Run dotnet @('publish', "$here/Kokuban.App", '-c', $Configuration, '-r', $rid, "-p:Platform=$Arch", '--self-contained', 'true', '-o', $publish)
Write-Host "published $version -> $publish\Kokuban.exe"

if ($Pack) {
  Step 'pack'
  Run dotnet @('tool', 'restore')
  # One Start menu entry, no desktop icon; deltas against the versions already in the feed.
  # The package id is the install folder, %LOCALAPPDATA%\<id>: never 'Kokuban', which is the board's data folder.
  Run dotnet @('vpk', 'pack', '--packId', 'KokubanApp', '--packVersion', $version, '--packDir', $publish,
    '--mainExe', 'Kokuban.exe', '--packTitle', 'Kokuban', '--packAuthors', 'Kokuban', '--icon', "$here/Kokuban.App/Assets/icon.ico",
    '--shortcuts', 'StartMenuRoot', '--outputDir', $Feed, '--runtime', $rid)
  Write-Host "packed $version -> $Feed (KokubanApp-win-Setup.exe installs it; paired PCs get it with kokuban update)"
}
} finally {
  Pop-Location
}
