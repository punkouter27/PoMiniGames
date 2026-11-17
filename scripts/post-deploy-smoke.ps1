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

# /api/diag backs the public /diag status page (2026-11-17: always on). It must answer, and it
# must never carry a secret or an address: a hit on any of these means a connection string,
# key, vault/storage URI or exception text leaked into the anonymous payload.
$diag = Get-Response '/api/diag'
$diagCode = if ($diag) { [int]$diag.StatusCode } else { 0 }
Write-Host "/api/diag -> $diagCode (expected 200)"
if ($diagCode -ne 200) { throw "/api/diag returned $diagCode, expected 200." }
foreach ($leak in @('AccountKey', 'SharedAccessSignature', 'InstrumentationKey', 'vault.azure.net', 'core.windows.net', 'DefaultEndpointsProtocol', 'StackTrace')) {
    if ($diag.Content -match [regex]::Escape($leak)) { throw "/api/diag exposes '$leak'." }
}

Write-Host 'Post-deploy smoke tests passed.'
