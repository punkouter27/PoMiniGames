# Offline KTX2/Basis texture & Poly Haven CC0 HDRI compression pipeline.
# Requires Khronos KTX-Software (`toktx` on PATH). Outputs GPU-compressed .ktx2 files
# ready to upload to Azure Blob Storage (ModelsBaseUrl), cutting egress & VRAM 4x-8x.
param(
    [Parameter(Mandatory = $true)][string]$InputDir,
    [Parameter(Mandatory = $true)][string]$OutputDir,
    [switch]$NormalMap
)

$ErrorActionPreference = 'Stop'
if (-not (Get-Command toktx -ErrorAction SilentlyContinue)) {
    Write-Error "toktx not found on PATH. Install Khronos KTX-Software (https://github.com/KhronosGroup/KTX-Software/releases)."
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

Get-ChildItem -Path $InputDir -File | Where-Object { $_.Extension -in '.png', '.jpg', '.jpeg', '.webp' } | ForEach-Object {
    $out = Join-Path $OutputDir ($_.BaseName + '.ktx2')
    $args = @('--t2', '--genmipmap', '--encode', 'uastc', '--uastc_quality', '2', '--zcmp', '18')
    if ($NormalMap) {
        $args += @('--normal_mode', '--assign_oetf', 'linear')
    } else {
        $args += @('--assign_oetf', 'srgb')
    }
    Write-Host "Compressing $($_.Name) -> $(Split-Path -Leaf $out)"
    & toktx @args $out $_.FullName
    if ($LASTEXITCODE -ne 0) { throw "toktx failed on $($_.Name)" }
}
Write-Host "Done. Upload $OutputDir/*.ktx2 to Blob Storage (ModelsBaseUrl)."
