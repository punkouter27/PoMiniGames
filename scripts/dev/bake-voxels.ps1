#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Re-bakes the PoVoxelStrike voxel volumes from the authored GLBs.

.DESCRIPTION
    PoVoxelStrike serves .pvx volumes, not GLBs. The conversion is deterministic: the
    authored drop folder (~87 MB of GLB) always produces the same ~150 KB of .pvx at
    VoxelResolution 64. So the volumes are committed and shipped, and the host only
    indexes them at startup instead of re-voxelising on every boot and every scale-out.

    Run this after changing a GLB in src/PoMiniGames.Api/App_Data/povoxelstrike/drop/ or
    after changing PoVoxelStrike:VoxelResolution, then commit the result under
    App_Data/povoxelstrike/converted/.

    The bake uses the app's own ingestion path — there is no second implementation — so
    the output is byte-identical to what a cold start would have produced.

.EXAMPLE
    pwsh scripts/dev/bake-voxels.ps1
#>
[CmdletBinding()]
param(
    # Keep the host's stdout on screen instead of folding it into the result summary.
    [switch]$Verbose
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$apiDir = Join-Path $repoRoot 'src/PoMiniGames.Api'
$convertedDir = Join-Path $apiDir 'App_Data/povoxelstrike/converted'
$dropDir = Join-Path $apiDir 'App_Data/povoxelstrike/drop'

if (-not (Test-Path $dropDir)) { throw "No drop folder at $dropDir." }

$glbs = Get-ChildItem $dropDir -Filter *.glb -File
if ($glbs.Count -eq 0) { throw "No GLBs in $dropDir — nothing to bake." }

Write-Host ("Baking {0} GLB(s) ({1:N1} MB) ..." -f $glbs.Count, (($glbs | Measure-Object -Sum Length).Sum / 1MB))

# Delete the previous volumes so every asset is rebuilt: a stale .pvx is otherwise reused
# whenever the GLB's content hash happens to match, which would hide a resolution change.
if (Test-Path $convertedDir) {
    Get-ChildItem $convertedDir -Filter *.pvx* -File | Remove-Item -Force
} else {
    New-Item -ItemType Directory -Force -Path $convertedDir | Out-Null
}

Push-Location $apiDir
try {
    # The ingestion service runs once at startup and then the host keeps serving. Start it,
    # wait for the volumes to appear, then stop it — the same code path a cold start takes.
    $env:ASPNETCORE_ENVIRONMENT = 'Development'
    $proc = Start-Process dotnet -ArgumentList @(
        'run', '--project', 'PoMiniGames.Api.csproj', '--no-launch-profile',
        '--urls', 'http://127.0.0.1:5099'
    ) -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $env:TEMP 'povoxel-bake.log') -RedirectStandardError (Join-Path $env:TEMP 'povoxel-bake.err.log')

    try {
        $deadline = (Get-Date).AddMinutes(10)
        do {
            Start-Sleep -Seconds 2
            $done = (Get-ChildItem $convertedDir -Filter *.pvx -File -ErrorAction SilentlyContinue).Count -ge $glbs.Count
            if (-not $done -and $proc.HasExited) { break }
        } while (-not $done -and (Get-Date) -lt $deadline)

        if (-not $done) {
            Write-Host (Get-Content (Join-Path $env:TEMP 'povoxel-bake.err.log') -Raw)
            throw 'The bake did not finish; see the log above.'
        }
    }
    finally {
        if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
    }

    if ($Verbose) { Get-Content (Join-Path $env:TEMP 'povoxel-bake.log') -Raw }
}
finally {
    Pop-Location
}

$volumes = Get-ChildItem $convertedDir -Filter *.pvx -File
$sidecars = Get-ChildItem $convertedDir -Filter *.pvx.json -File
Write-Host ("Baked {0} volume(s) + {1} sidecar(s), {2:N0} KB total." -f `
    $volumes.Count, $sidecars.Count, ((($volumes + $sidecars) | Measure-Object -Sum Length).Sum / 1KB))
Write-Host 'Commit App_Data/povoxelstrike/converted/ when the volumes changed.'
