#!/usr/bin/env pwsh
# Runs in the deploy job before the package goes up (cwd: the workspace holding ./publish).
# The F1 plan has 1 GB of disk and 165 MB/day of data out, so this keeps both in budget:
#   1. clears the Kudu zip-deploy temp folder (local disk);
#   2. deletes old run-from-package zips in data/SitePackages, keeping the live one (each ~150 MB);
#   3. moves the 3D models (wwwroot/models, ~37 MB) to the public 'models' blob container and out
#      of the package. The app then redirects /models/* there (PoMiniGames__Models__BaseUrl), so a
#      player opening a 3D game downloads them from Storage, not from the F1 data-out quota.
param([Parameter(Mandatory)][string]$BaseUrl)

$ErrorActionPreference = 'Stop'
$scmBaseUrl = $BaseUrl.TrimEnd('/').Replace('.azurewebsites.net', '.scm.azurewebsites.net')
$token = az account get-access-token --query accessToken -o tsv
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($token)) {
    throw 'Could not get an Azure access token for the Kudu cleanup.'
}
$kudu = @{ Authorization = "Bearer $token" }

# ── 1. Kudu zip-deploy temp folder ─────────────────────────────────────────────
$payload = @{
    command = 'cmd /c if exist C:\local\Temp\zipdeploy rd /s /q C:\local\Temp\zipdeploy'
    dir     = 'C:\local\Temp'
} | ConvertTo-Json -Compress
try {
    $result = Invoke-RestMethod -Uri "$scmBaseUrl/api/command" -Method Post -Headers $kudu `
        -ContentType 'application/json' -Body $payload -TimeoutSec 120 -ErrorAction Stop
    if ("$($result.ExitCode)" -ne '0') {
        Write-Warning "Clearing the Kudu zip-deploy temp folder exited $($result.ExitCode): $($result.Error)"
    }
    else { Write-Host 'Cleared the Kudu zip-deploy temp folder.' }
}
catch {
    Write-Warning "Could not clear the Kudu zip-deploy temp folder; the deploy may run out of local disk. $($_.Exception.Message)"
}

# ── 2. Old run-from-package zips ──────────────────────────────────────────────
try {
    $pkgUrl = "$scmBaseUrl/api/vfs/data/SitePackages"
    $live = (Invoke-RestMethod -Uri "$pkgUrl/packagename.txt" -Headers $kudu -TimeoutSec 60).ToString().Trim()
    $old = @(Invoke-RestMethod -Uri "$pkgUrl/" -Headers $kudu -TimeoutSec 60 |
        Where-Object { $_.name -like '*.zip' -and $_.name -ne $live })
    foreach ($zip in $old) {
        Invoke-RestMethod -Uri "$pkgUrl/$($zip.name)" -Method Delete -TimeoutSec 60 `
            -Headers ($kudu + @{ 'If-Match' = '*' }) | Out-Null
        Write-Host "Deleted old package $($zip.name) ($([math]::Round($zip.size / 1MB)) MB)."
    }
    Write-Host "Kept the live package $live; removed $($old.Count) old one(s)."
}
catch {
    Write-Warning "Could not prune data/SitePackages; old packages keep using disk. $($_.Exception.Message)"
}

# ── 3. 3D models to Blob Storage ──────────────────────────────────────────────
$models = Join-Path (Get-Location) 'publish/wwwroot/models'
if (-not (Test-Path $models)) { Write-Host 'No wwwroot/models in the package; nothing to move.'; exit 0 }

$settings = az webapp config appsettings list -g $env:RG -n $env:APP -o json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Could not read the app settings.' }
$modelsBase = ($settings | Where-Object name -eq 'PoMiniGames__Models__BaseUrl').value
$account = ($settings | Where-Object name -eq 'PoMiniGames__Storage__TableService__AccountName').value
if ([string]::IsNullOrWhiteSpace($modelsBase) -or [string]::IsNullOrWhiteSpace($account)) {
    Write-Warning 'PoMiniGames__Models__BaseUrl is not set on the app, so the models ship in the package (apply infra/main.bicep).'
    exit 0
}

$contentTypes = @{ '.glb' = 'model/gltf-binary'; '.gltf' = 'model/gltf+json'; '.ksplat' = 'application/octet-stream' }
$remote = @{}
az storage blob list --account-name $account --auth-mode key -c models --num-results '*' `
    --query '[].{n:name, m:properties.contentSettings.contentMd5}' -o json |
    ConvertFrom-Json | ForEach-Object { $remote[$_.n] = $_.m }
if ($LASTEXITCODE -ne 0) { throw "Could not list the 'models' container in $account." }

$uploaded = 0
$files = Get-ChildItem $models -Recurse -File | Where-Object { $_.Extension -notin '.br', '.gz' }
foreach ($f in $files) {
    $name = [IO.Path]::GetRelativePath($models, $f.FullName).Replace('\', '/')
    $md5 = [Convert]::ToBase64String([Convert]::FromHexString((Get-FileHash $f.FullName -Algorithm MD5).Hash))
    if ($remote[$name] -eq $md5) { continue }
    $type = $contentTypes[$f.Extension.ToLowerInvariant()] ?? 'application/octet-stream'
    az storage blob upload --account-name $account --auth-mode key -c models -n $name -f $f.FullName `
        --overwrite --content-type $type --content-md5 $md5 --content-cache-control 'public, max-age=86400' -o none
    if ($LASTEXITCODE -ne 0) { throw "Uploading model $name failed; the deploy stops so the site never points at a missing model." }
    $uploaded++
}
Remove-Item $models -Recurse -Force
Write-Host "Models: $uploaded uploaded, $($files.Count - $uploaded) unchanged; removed from the package (served from $modelsBase)."
