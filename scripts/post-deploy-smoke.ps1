#!/usr/bin/env pwsh
param([Parameter(Mandatory)][string]$BaseUrl)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$BaseUrl = $BaseUrl.TrimEnd('/')

function Get-Response([string]$Path) {
    try {
        Invoke-WebRequest -Uri "$BaseUrl$Path" -TimeoutSec 30 -SkipHttpErrorCheck `
            -MaximumRedirection 0 -ErrorAction Stop
    }
    catch { $null }
}

foreach ($path in '/api/health/ping', '/api/health') {
    $response = $null
    for ($attempt = 1; $attempt -le 11; $attempt++) {
        $response = Get-Response $path
        if ($response -and [int]$response.StatusCode -eq 200) { break }
        if ($attempt -lt 11) { Start-Sleep -Seconds 5 }
    }
    $code = if ($response) { [int]$response.StatusCode } else { 0 }
    Write-Host "$path -> $code"
    if ($code -ne 200) { throw "$path returned $code, expected 200." }
}

# Diagnostics is an anonymous support surface and is OFF in production, so the live site
# must refuse it. Asserting the closed state is the point: a 200 here means the flag was
# turned back on by accident or the route was mapped outside the guard.
$diag = Get-Response '/api/diag'
$diagCode = if ($diag) { [int]$diag.StatusCode } else { 0 }
Write-Host "/api/diag -> $diagCode (expected 404)"
if ($diagCode -eq 200) { throw '/api/diag answered 200 on a production deployment; diagnostics should be disabled.' }

Write-Host 'Post-deploy smoke tests passed.'
