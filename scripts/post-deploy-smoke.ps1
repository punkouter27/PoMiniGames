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

foreach ($path in '/api/health/ping', '/api/health', '/api/diag') {
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

Write-Host 'Post-deploy smoke tests passed.'
