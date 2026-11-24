#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Deletes the runtime state a local run leaves inside the source tree.

.DESCRIPTION
    `dotnet run` writes three things next to the code that must never be committed and
    should not sit in a checkout indefinitely:

      src/PoMiniGames.Api/keys/    the Data Protection key ring (XML key material)
      src/PoMiniGames.Api/logs/    Serilog's rolling log files — ~14-90 MB per week
      <repo>/App_Data/             the PoVoxelStrike scaffold recreated when the host is
                                   launched with the repo root as its working directory

    All three are gitignored, so this script is about disk and about not leaving key
    material lying around — not about keeping the index clean.

    It never touches src/PoMiniGames.Api/App_Data/, which is source: the authored GLBs and
    the committed voxel volumes live there.

.EXAMPLE
    pwsh scripts/dev/clean.ps1
#>
[CmdletBinding()]
param(
    [switch]$IncludeArtifacts
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$targets = [System.Collections.Generic.List[string]]@(
    (Join-Path $repoRoot 'src/PoMiniGames.Api/keys'),
    (Join-Path $repoRoot 'src/PoMiniGames.Api/logs'),
    (Join-Path $repoRoot 'App_Data'),
    (Join-Path $repoRoot 'scripts/pofighter/__pycache__')
)
if ($IncludeArtifacts) {
    $targets.Add((Join-Path $repoRoot 'artifacts'))
}

$freed = 0
foreach ($path in $targets) {
    if (-not (Test-Path -LiteralPath $path)) { continue }
    $bytes = (Get-ChildItem -LiteralPath $path -Recurse -File -ErrorAction SilentlyContinue |
        Measure-Object -Sum Length).Sum
    if ($null -eq $bytes) { $bytes = 0 }
    Remove-Item -LiteralPath $path -Recurse -Force
    $freed += $bytes
    Write-Host ("removed {0} ({1:N1} MB)" -f $path.Replace($repoRoot + [IO.Path]::DirectorySeparatorChar, ''), ($bytes / 1MB))
}

if ($freed -eq 0) {
    Write-Host 'Nothing to clean.'
} else {
    Write-Host ("Freed {0:N1} MB." -f ($freed / 1MB))
}
