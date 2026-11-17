#!/usr/bin/env pwsh
<#
.SYNOPSIS
  First-run setup for PoMiniGames on bare hardware.
  Installs required tooling via WinGet, starts the Azurite Table Storage container,
  and validates Azure CLI login for Key Vault access.
.NOTES
  Idempotent — safe to re-run. Skips anything already present.
  Pass `-WhatIf` to print the would-do list without running anything (useful
  for CI dry-runs and PR preview validation).
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

function Write-Step([string]$Message) { Write-Host "`n=== $Message ===" -ForegroundColor Cyan }
function Write-Ok([string]$Message)   { Write-Host "  [OK]   $Message" -ForegroundColor Green }
function Write-Warn([string]$Message) { Write-Host "  [WARN] $Message" -ForegroundColor Yellow }

function Test-Command([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Assert-Installed([string]$Command, [string]$Id) {
    # Post-install assertion: WinGet can return non-zero in some failure modes
    # (UAC prompt, PATH-not-refreshed, App Installer race). If the command is
    # not on PATH after a successful install, surface a hard failure with the
    # exact remediation so the developer is not blocked by a silent skip.
    if (-not (Test-Command $Command)) {
        throw "WinGet install of '$Id' reported success but '$Command' is not on PATH. " +
              "Re-open PowerShell so the new PATH takes effect, or run: winget install --id $Id"
    }
}

function Install-WinGet([string]$Id, [string]$Command) {
    if (Test-Command $Command) {
        Write-Ok "$Command already installed"
        return
    }
    if (-not (Test-Command 'winget')) {
        throw "winget is not installed — required to bootstrap '$Id'. Install App Installer (winget) and re-run setup."
    }
    if ($WhatIf) {
        Write-Host "  [WHATIF] Would run: winget install --id $Id --silent --accept-source-agreements --accept-package-agreements"
        return
    }
    Write-Host "  Installing $Id ..." -ForegroundColor Gray
    winget install --id $Id --silent --accept-source-agreements --accept-package-agreements
    Assert-Installed $Command $Id
    Write-Ok "Installed $Id"
}

# ── 1. Tooling ────────────────────────────────────────────────────────────────
Write-Step 'Installing required tooling (WinGet)'
Install-WinGet -Id 'Microsoft.DotNet.SDK.10' -Command 'dotnet'
Install-WinGet -Id 'Docker.DockerDesktop'    -Command 'docker'
Install-WinGet -Id 'Microsoft.AzureCLI'      -Command 'az'
Install-WinGet -Id 'OpenJS.NodeJS.LTS'       -Command 'node'

# ── 2. Azurite (local Table Storage) ────────────────────────────────────
Write-Step 'Starting Azurite container (local Table Storage)'
if (Test-Command 'docker') {
    if ($WhatIf) {
        Write-Host "  [WHATIF] Would run: docker compose -f $repoRoot/docker-compose.yml up -d"
    }
    else {
        try {
            docker compose -f (Join-Path $repoRoot 'docker-compose.yml') up -d | Out-Null
            Write-Ok 'Azurite container "pominigames" is running'
        } catch {
            Write-Warn "Could not start Azurite via docker compose: $($_.Exception.Message)"
        }
    }
} else {
    Write-Warn 'Docker not available — skipping Azurite startup.'
}

# ── 3. Azure CLI login (Key Vault access) ────────────────────────────
Write-Step 'Validating Azure CLI login (Key Vault access)'
if (Test-Command 'az') {
    if ($WhatIf) {
        Write-Host '  [WHATIF] Would run: az account show'
    }
    else {
        try {
            $account = az account show --output json 2>$null | ConvertFrom-Json
            if ($account) {
                Write-Ok "Signed in to Azure as $($account.user.name) (sub: $($account.name))"
            } else {
                Write-Warn 'Not signed in. Run: az login'
            }
        } catch {
            Write-Warn 'Not signed in. Run: az login'
        }
    }
} else {
    Write-Warn 'Azure CLI not available — skipping login check.'
}

# ── 4. Restore + build ───────────────────────────────────────────────
Write-Step 'Restoring and building the solution'
if ($WhatIf) {
    Write-Host "  [WHATIF] Would run: dotnet restore $repoRoot/PoMiniGames.slnx"
    Write-Host "  [WHATIF] Would run: dotnet build   $repoRoot/PoMiniGames.slnx -c Debug"
}
else {
    dotnet restore (Join-Path $repoRoot 'PoMiniGames.slnx')
    dotnet build   (Join-Path $repoRoot 'PoMiniGames.slnx') -c Debug --no-restore
}

# ── 5. Developer tools: gstack, Understand-Anything, Graphify ─────────
Write-Step 'Installing developer AI tools'

# gstack — Claude Code skill package (23 engineering team roles as AI agents).
# Requires Bun (bun.sh). If Bun is absent the clone still succeeds; run setup
# manually inside ~/.claude/skills/gstack once Bun is installed.
$gstackDir = Join-Path $env:USERPROFILE '.claude\skills\gstack'
if (Test-Path $gstackDir) {
    Write-Ok "gstack already installed at $gstackDir"
} else {
    if ($WhatIf) {
        Write-Host "  [WHATIF] Would clone garrytan/gstack → $gstackDir and run setup"
    } else {
        try {
            git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git $gstackDir
            if (Test-Command 'bun') {
                Push-Location $gstackDir
                try { & .\setup } finally { Pop-Location }
                Write-Ok 'gstack installed (GBrain MCP server registered)'
            } else {
                Write-Warn "gstack cloned but Bun is not on PATH — run '.\setup' inside $gstackDir after installing Bun (bun.sh)"
            }
        } catch {
            Write-Warn "Could not install gstack: $($_.Exception.Message)"
        }
    }
}

# Understand-Anything — Claude Code plugin (codebase → knowledge graph).
# Install via Claude Code marketplace inside an interactive session:
#   /plugin marketplace add Egonex-AI/Understand-Anything
Write-Host '  [INFO]  Understand-Anything is a Claude Code marketplace plugin.' -ForegroundColor Gray
Write-Host '          Install it inside Claude Code with:' -ForegroundColor Gray
Write-Host '            /plugin marketplace add Egonex-AI/Understand-Anything' -ForegroundColor Cyan

# Graphify — Python MCP server that turns code/docs into queryable knowledge graphs.
# Requires Python 3.10+. The MCP server config lives in .vscode/mcp.json.
if (Test-Command 'pip') {
    if ($WhatIf) {
        Write-Host '  [WHATIF] Would run: pip install graphifyy'
    } else {
        try {
            pip install graphifyy --quiet
            graphify install 2>$null
            Write-Ok 'graphify installed (run "python -m graphify.serve graphify-out/graph.json" to start MCP server)'
        } catch {
            Write-Warn "Could not install graphify: $($_.Exception.Message)"
        }
    }
} else {
    Write-Warn 'pip not available — skipping graphify. Install Python 3.10+ and re-run setup.'
}

# ── 6. Playwright browsers (E2E-UI tier) ───────────────────────────────
# The E2E-UI tier drives a real Chromium via Microsoft.Playwright; the pinned
# browser build must be present or those tests fail at launch. The install
# script ships next to the built E2E-UI assembly and is a no-op if already present.
Write-Step 'Installing Playwright browsers (Chromium) for the E2E-UI tier'
$playwrightScript = Join-Path $repoRoot 'tests/PoMiniGames.E2EUI/bin/Debug/net10.0/playwright.ps1'
if (Test-Path $playwrightScript) {
    if ($WhatIf) {
        Write-Host "  [WHATIF] Would run: $playwrightScript install chromium"
    }
    else {
        try {
            & $playwrightScript install chromium
            Write-Ok 'Playwright Chromium ready'
        } catch {
            Write-Warn "Could not install Playwright browsers: $($_.Exception.Message)"
        }
    }
} else {
    Write-Warn "Playwright bootstrap script not found at $playwrightScript (build the E2E-UI project first)."
}

Write-Host "`nSetup complete. Run the app with:" -ForegroundColor Cyan
Write-Host "  dotnet run --project src/PoMiniGames" -ForegroundColor Gray
Write-Host "Then it is available at http://localhost:5080`n" -ForegroundColor Gray