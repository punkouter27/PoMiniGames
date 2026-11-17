param(
    [ValidateSet('Debug', 'Release')][string]$Configuration = 'Debug',
    [switch]$NoBuild
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$resultRoot = Join-Path $repoRoot 'artifacts/test-ceilings'
New-Item -ItemType Directory -Path $resultRoot -Force | Out-Null
foreach ($tier in 'Unit', 'Integration', 'E2EAPI', 'E2EUI') {
    $project = Join-Path $repoRoot "tests/PoMiniGames.$tier/PoMiniGames.$tier.csproj"
    $testArgs = @('test', $project, '-c', $Configuration, '--filter', 'FullyQualifiedName~Tier_StaysWithinCeiling',
        '-p:SkipPlaywrightInstall=true', '--logger', "trx;LogFileName=$tier.trx", '--results-directory', $resultRoot)
    if ($NoBuild) { $testArgs += '--no-build' }
    & dotnet @testArgs
    if ($LASTEXITCODE -ne 0) { throw "$tier test-method ceiling failed." }
    [xml]$result = Get-Content -LiteralPath (Join-Path $resultRoot "$tier.trx") -Raw
    if ([int]$result.TestRun.ResultSummary.Counters.total -ne 1) {
        throw "$tier must discover exactly one ceiling guard."
    }
}
Write-Host 'All test-method caps passed: Unit 100, Integration 50, API E2E 25, UI E2E 25.'
