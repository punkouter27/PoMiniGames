#!/usr/bin/env pwsh
param([Parameter(Mandatory)][string]$BaseUrl)

$ErrorActionPreference = 'Stop'
$scmBaseUrl = $BaseUrl.TrimEnd('/').Replace('.azurewebsites.net', '.scm.azurewebsites.net')
$token = az account get-access-token --query accessToken -o tsv
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($token)) {
    throw 'Could not get an Azure access token for the Kudu cleanup.'
}

$payload = @{
    command = 'cmd /c if exist C:\local\Temp\zipdeploy rd /s /q C:\local\Temp\zipdeploy'
    dir     = 'C:\local\Temp'
} | ConvertTo-Json -Compress

try {
    $result = Invoke-RestMethod -Uri "$scmBaseUrl/api/command" -Method Post `
        -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json' `
        -Body $payload -TimeoutSec 120 -ErrorAction Stop
}
catch {
    Write-Warning "Could not clear the Kudu zip-deploy temp folder; the deploy may run out of local disk. $($_.Exception.Message)"
    exit 0
}

if ("$($result.ExitCode)" -ne '0') {
    Write-Warning "Clearing the Kudu zip-deploy temp folder exited $($result.ExitCode): $($result.Error)"
}
else {
    Write-Host 'Cleared the Kudu zip-deploy temp folder.'
}
