#!/usr/bin/env pwsh
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Set-Location (Split-Path $PSScriptRoot -Parent)

function Invoke-Check([string]$Name, [scriptblock]$Command) {
    Write-Host "::group::$Name"
    & $Command
    $code = $LASTEXITCODE
    Write-Host '::endgroup::'
    if ($code -ne 0) { throw "$Name failed (exit $code)." }
}

Invoke-Check 'Formatting' { dotnet format PoMiniGames.slnx --verify-no-changes --no-restore --verbosity minimal }
Invoke-Check 'Bicep compile' { az bicep build --file infra/main.bicep --stdout > $null }
Invoke-Check 'CSS lint' { ./scripts/css-lint.ps1 }
Invoke-Check 'Test ceilings' { ./scripts/test-ceilings.ps1 -Configuration Release -NoBuild }
# Every JS engine test (tests/*.test.mjs) in one run. Node runs the files in parallel, so the
# wall time is the slowest file's (PoCapitol's world sim, about four minutes), not the sum. Two of
# them need inputs built first: the PoCabinet worlds and the PoMarbleRace harness's packages.
Invoke-Check 'PoCabinet race health setup' {
    dotnet run scripts/pocabinet/dump.cs -- artifacts/pocabinet-worlds capitol bedroom court
}
Invoke-Check 'PoMarbleRace dependencies' { npm ci --prefix scripts/pomarblerace --no-audit --no-fund }
# The file list is expanded here rather than passed as a glob: Node only reads globs from 21 on.
Invoke-Check 'JS engine tests' { node --test @(Get-ChildItem tests -Filter *.test.mjs | ForEach-Object FullName) }

$trimOut = Join-Path ([IO.Path]::GetTempPath()) "pominigames-trim-$([guid]::NewGuid().ToString('N'))"
try {
    Invoke-Check 'WASM trim audit' {
        dotnet publish src/PoMiniGames.Client/PoMiniGames.Client.csproj -c Release --no-build `
            -p:PublishTrimmed=true -p:TrimMode=partial -o $trimOut --no-restore
    }

    $framework = Join-Path $trimOut 'wwwroot/_framework'
    if (-not (Test-Path $framework)) { throw "Trimmed framework output not found: $framework" }
    $bytes = (Get-ChildItem $framework -File -Recurse | Measure-Object -Property Length -Sum).Sum
    $sizeMb = [Math]::Ceiling($bytes / 1MB)
    Write-Host "Trimmed _framework size: $sizeMb MB (budget 35 MB)"
    if ($sizeMb -gt 35) { throw "WASM _framework $sizeMb MB exceeds budget 35 MB." }
}
finally {
    if (Test-Path $trimOut) { Remove-Item -LiteralPath $trimOut -Recurse -Force }
}

Write-Host 'ci-checks: all passed.'
