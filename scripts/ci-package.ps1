#!/usr/bin/env pwsh
param([Parameter(Mandatory)][string]$PublishDir)

$ErrorActionPreference = 'Stop'
$docs = Join-Path (Split-Path $PSScriptRoot -Parent) 'docs'
$target = Join-Path $PublishDir 'wwwroot/docs'
if (-not (Test-Path $PublishDir)) { throw "Publish folder not found: $PublishDir" }
# The dated docs suite is optional (the repo has none since 2026-11-18): no folder, nothing to stage.
if (-not (Test-Path $docs)) {
    Write-Warning "No docs/ folder; the publish carries no documentation suite."
    exit 0
}

New-Item -ItemType Directory -Force $target | Out-Null
Get-ChildItem -LiteralPath $docs -Force | Copy-Item -Destination $target -Recurse -Force

$latest = Get-ChildItem -LiteralPath $docs -Directory |
    Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}$' } |
    Sort-Object -Property Name |
    Select-Object -Last 1
if (-not $latest) {
    Write-Warning 'No dated documentation suite found under docs/; nothing to link to.'
    exit 0
}

$redirect = @"
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=$($latest.Name)/index.html">
<link rel="canonical" href="$($latest.Name)/index.html">
<title>PoMiniGames documentation</title>
</head>
<body style="font:16px system-ui,sans-serif;padding:2rem">
<p>Opening <a href="$($latest.Name)/index.html">the PoMiniGames documentation overview</a>&hellip;</p>
</body>
</html>
"@
[IO.File]::WriteAllText((Join-Path $target 'index.html'), $redirect, [Text.UTF8Encoding]::new($false))
Write-Host "Staged documentation suite $($latest.Name) into $target."
