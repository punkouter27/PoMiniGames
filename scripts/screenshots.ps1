#!/usr/bin/env pwsh
<#
.SYNOPSIS
  One command for the AGENTS.md UI-preview rule: before/after captures of the key screens, written to
  SCREENSHOTS/{YYMMDD}-{feature}.html plus one annotated side-by-side SCREENSHOTS/{YYMMDD}-{feature}.png.

.DESCRIPTION
  Each side is either a git ref (built as a Release publish in a temporary worktree and run locally) or a folder
  of PNGs named <screen>-<width>.png (-BeforeDir / -AfterDir). "After" defaults to the working tree.
  Captures run on THIS machine only, never against the live site: each publish is started in the Test
  environment on 127.0.0.1 against an Azurite container this script starts and removes. Screens are taken at
  1366x768 and 390x844 (scripts/screenshots/capture.mjs), then scripts/screenshots/compose.mjs writes the page,
  small PNG thumbnails in SCREENSHOTS/{YYMMDD}-{feature}/ and the side-by-side PNG.
  Needs Docker (Azurite), Node and the .NET SDK; installs Playwright for scripts/screenshots on first run.

.EXAMPLE
  pwsh scripts/screenshots.ps1 -Feature home-chips                       # HEAD~1 vs the working tree
  pwsh scripts/screenshots.ps1 -Feature diag -Before 73b633d2 -Routes /diag
  pwsh scripts/screenshots.ps1 -Feature v4 -BeforeDir C:\shots\before -Notes 'Radzen theme first', 'Voxel fits 375x667'
#>
param(
    [Parameter(Mandatory)] [string]$Feature,
    [string]$Before = 'HEAD~1',
    [string]$BeforeDir = '',
    [string]$After = '',
    [string]$AfterDir = '',
    [string[]]$Routes = @('/', '/diag', '/tictactoe/1player', '/povoxelstrike/1player'),
    [string[]]$Notes = @(),
    [string]$Title = ''
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tool = Join-Path $PSScriptRoot 'screenshots'
$name = '{0}-{1}' -f (Get-Date).ToUniversalTime().ToString('yyMMdd'), ($Feature.ToLowerInvariant() -replace '[^a-z0-9]+', '-').Trim('-')
$shots = Join-Path $root 'SCREENSHOTS'
$work = Join-Path ([IO.Path]::GetTempPath()) "pominigames-shots-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$azurite = "pominigames-shots-$([guid]::NewGuid().ToString('N').Substring(0, 6))"
New-Item -ItemType Directory -Force $work, $shots | Out-Null

if (-not (Test-Path (Join-Path $tool 'node_modules/playwright'))) {
    npm ci --prefix $tool --no-audit --no-fund | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'npm ci for scripts/screenshots failed' }
    npx --prefix $tool playwright install chromium | Out-Null
}

$started = @()
function Start-Azurite {
    if ($script:azuriteConn) { return $script:azuriteConn }
    docker run -d --name $azurite -p 127.0.0.1::10000 -p 127.0.0.1::10001 -p 127.0.0.1::10002 `
        mcr.microsoft.com/azure-storage/azurite:latest azurite --blobHost 0.0.0.0 --queueHost 0.0.0.0 --tableHost 0.0.0.0 --skipApiVersionCheck --loose | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'could not start Azurite (is Docker running?)' }
    $port = { param($p) ((docker port $azurite $p) | Select-Object -First 1).Split(':')[-1] }
    $key = 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw=='
    $script:azuriteConn = "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=$key;" +
        "BlobEndpoint=http://127.0.0.1:$(& $port 10000)/devstoreaccount1;QueueEndpoint=http://127.0.0.1:$(& $port 10001)/devstoreaccount1;" +
        "TableEndpoint=http://127.0.0.1:$(& $port 10002)/devstoreaccount1;"
    return $script:azuriteConn
}

function Get-FreePort {
    $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0); $l.Start()
    try { $l.LocalEndpoint.Port } finally { $l.Stop() }
}

# Publishes a ref (or the working tree when $ref is empty), runs it locally and captures every route into $dir.
function Invoke-Capture([string]$ref, [string]$dir) {
    $src = $root
    if ($ref) {
        $src = Join-Path $work "src-$($ref -replace '[^A-Za-z0-9]', '_')"
        git -C $root worktree add --quiet --detach $src $ref | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "git worktree add $ref failed" }
    }
    $pub = Join-Path $work "pub-$([guid]::NewGuid().ToString('N').Substring(0, 6))"
    dotnet publish (Join-Path $src 'src/PoMiniGames.Api/PoMiniGames.Api.csproj') -c Release -o $pub --nologo -v q
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish of '$(if ($ref) { $ref } else { 'working tree' })' failed" }

    $conn = Start-Azurite
    $port = Get-FreePort
    # Test environment, its own Azurite, no Key Vault, no live third-party calls (the E2E fixtures' overrides),
    # passed as command-line configuration; the host's log goes to a file in the work folder.
    $hostArgs = @(
        'PoMiniGames.Api.dll', '--environment', 'Test', '--urls', "http://127.0.0.1:$port", '--KeyVault:Uri=',
        '--PoMiniGames:PoBrawl:Dossier:FetchWikipedia=false', '--PoMiniGames:PoRacer:Weather=clear',
        "`"--PoMiniGames:Storage:TableService:ConnectionString=$conn`"", "`"--PoMiniGames:Storage:BlobService:ConnectionString=$conn`"",
        '--PoMiniGames:Storage:TableService:TableName=pominigamesshots')
    $app = Start-Process dotnet -ArgumentList $hostArgs -WorkingDirectory $pub -PassThru -NoNewWindow `
        -RedirectStandardOutput (Join-Path $pub 'host.log') -RedirectStandardError (Join-Path $pub 'host.err.log')
    $script:started += $app
    try {
        $deadline = (Get-Date).AddSeconds(120)
        while ((Get-Date) -lt $deadline) {
            try { if ((Invoke-WebRequest "http://127.0.0.1:$port/health/live" -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200) { break } } catch { Start-Sleep -Milliseconds 500 }
        }
        node (Join-Path $tool 'capture.mjs') "http://127.0.0.1:$port/" $dir @Routes
        if ($LASTEXITCODE -ne 0) { throw 'capture failed' }
    }
    finally {
        if (-not $app.HasExited) { $app.Kill($true) }
        if ($ref) { git -C $root worktree remove --force $src | Out-Null }
    }
}

try {
    if (-not $BeforeDir) { $BeforeDir = Join-Path $work 'before'; Invoke-Capture $Before $BeforeDir }
    if (-not $AfterDir) { $AfterDir = Join-Path $work 'after'; Invoke-Capture $After $AfterDir }
    node (Join-Path $tool 'compose.mjs') $BeforeDir $AfterDir $shots $name $(if ($Title) { $Title } else { $Feature }) @Notes
    if ($LASTEXITCODE -ne 0) { throw 'compose failed' }
    Write-Host "SCREENSHOTS/$name.html and SCREENSHOTS/$name.png"
}
finally {
    foreach ($p in $started) { if (-not $p.HasExited) { $p.Kill($true) } }
    docker rm -f $azurite 2>$null | Out-Null
    git -C $root worktree prune
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
