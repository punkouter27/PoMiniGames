#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Runs the E2E UI tier against the trimmed Release publish: the same bits .github/workflows/deploy.yml deploys.

.DESCRIPTION
  1. dotnet publish src/PoMiniGames.Api -c Release into a temp folder outside the repo (ILLink trims the WASM client).
  2. Builds tests/PoMiniGames.E2EUI (Release) and makes sure Playwright Chromium is installed.
  3. Runs the tier with POMINIGAMES_E2EUI_APP_DIR pointing at the publish folder: KestrelServerFixture then starts
     `dotnet PoMiniGames.Api.dll` from it (Test environment, its own Testcontainers Azurite) instead of the
     in-process host.
  4. Stops any PoMiniGames.Api process it started and deletes the publish folder.
  Needs Docker (Testcontainers Azurite) and network for the first Playwright install.

.EXAMPLE
  pwsh scripts/run-e2eui.ps1
  pwsh scripts/run-e2eui.ps1 -Filter "FullyQualifiedName~LinkAudit"
#>
param(
    [string]$Filter = '',
    [switch]$KeepPublish
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$publish = Join-Path ([IO.Path]::GetTempPath()) "pominigames-e2eui-$([guid]::NewGuid().ToString('N').Substring(0, 8))"

try {
    Write-Host "Publishing the Release build to $publish"
    dotnet publish (Join-Path $root 'src/PoMiniGames.Api/PoMiniGames.Api.csproj') -c Release -o $publish --nologo -v q
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed ($LASTEXITCODE)" }
    if (-not (Get-ChildItem (Join-Path $publish 'wwwroot/_framework') -Filter 'dotnet.native*.wasm' -ErrorAction SilentlyContinue)) {
        throw "The publish has no trimmed WASM runtime under wwwroot/_framework"
    }

    $project = Join-Path $root 'tests/PoMiniGames.E2EUI/PoMiniGames.E2EUI.csproj'
    dotnet build $project -c Release --nologo -v q
    if ($LASTEXITCODE -ne 0) { throw "dotnet build of the E2EUI tier failed ($LASTEXITCODE)" }

    $env:POMINIGAMES_E2EUI_APP_DIR = $publish
    $testArgs = @('test', $project, '-c', 'Release', '--no-build', '--logger', 'console;verbosity=normal')
    if ($Filter) { $testArgs += @('--filter', $Filter) }
    Write-Host "Running the E2E UI tier against $publish"
    dotnet @testArgs
    $code = $LASTEXITCODE
}
finally {
    Remove-Item Env:POMINIGAMES_E2EUI_APP_DIR -ErrorAction SilentlyContinue
    # The fixture stops the app it started; this catches one left behind by a crashed test host.
    try {
        Get-Process dotnet -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine.Contains($publish) } |
            ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
    } catch { }
    if (-not $KeepPublish) { Remove-Item -Recurse -Force $publish -ErrorAction SilentlyContinue }
}
exit $code
