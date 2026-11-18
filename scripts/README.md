# scripts/

Working scripts only — the one-off debug files that used to live here were removed in
the 2026-08-18 cleanup (they referenced files that no longer exist and had no callers).

## Layout

| Folder | What lives there | Who runs it |
|---|---|---|
| `scripts/` (root) | The four workflow hooks. **These paths are fixed**: `.github/workflows/deploy.yml` is shared verbatim across every Po .NET repo and calls them by name. | CI |
| `scripts/ci/` | Checks CI runs, callable by hand | `ci-checks.ps1`, humans |
| `scripts/dev/` | Local setup, test runs, reports, cleanup | humans |
| `scripts/content/` | Author-time asset pipelines that produce committed output | humans, when an asset changes |
| `scripts/blender/`, `pocabinet/`, `pofighter/`, `pomarblerace/` | Per-asset authoring kits with their own READMEs | humans |

## Root — workflow hooks (do not move)

| Script | Purpose | Called from |
|---|---|---|
| `ci-checks.ps1` | Post-build gate: format, Bicep build, CSS lint, test ceilings, JS lint, JS engine tests, WASM trim audit | `deploy.yml` |
| `ci-package.ps1` | Adds the dated docs suite to the publish folder when `docs/` exists (skips with a warning otherwise) | `deploy.yml` |
| `pre-deploy.ps1` | Clears stale Kudu files on the Windows App Service | `deploy.yml` |
| `post-deploy-smoke.ps1` | Probes the live site after the health gate: `/api/health/ping`, `/api/health`, and asserts `/api/diag` answers 200 with no secret or address in it | `deploy.yml` |

## ci/

| Script | Purpose | Notes |
|---|---|---|
| `css-lint.ps1` | Structural check of every stylesheet (unterminated comments, unbalanced braces) plus a ratchet on hard-coded hex colours outside `po-tokens.css` (the baseline can only go down) | Run after any scripted CSS edit |
| `js-lint/` | ESLint with correctness rules only (`no-undef`, duplicate keys, unreachable code) over `wwwroot/js` | `npm ci --prefix scripts/ci/js-lint && npm run lint --prefix scripts/ci/js-lint` |
| `test-ceilings.ps1` | The four test-method budget guards, without Docker or browsers | `-NoBuild` skips the build |
| `ensure-azure-access.ps1` | Idempotent role assignments for the app identity and the OIDC deploy app | Every permission the app or CI needs must be added here — a role granted by hand is lost on the next re-provision |

## dev/

| Script | Purpose | Notes |
|---|---|---|
| `setup.ps1` | One-time dev-machine setup | E2E fixtures call it |
| `test-all.ps1` | All four test tiers (Unit → Integration → E2E-API → E2E-UI); frees port 5080, starts Azurite, installs Playwright | `README.md`, E2E-UI csproj |
| `smoke-local.ps1` | Local smoke of the running app: health, diagnostics, OpenAPI | `.vscode/tasks.json` |
| `bundle-report.ps1` | Trimmed WASM bundle size report (top DLLs + per-CSS breakdown) | On demand |
| `coverage-matrix.ps1` | Cross-tier route-coverage matrix over the four dotnet test tiers | On demand |
| `bake-voxels.ps1` | Re-bakes PoVoxelStrike's `.pvx` volumes from the authored GLBs | Run when a GLB or `VoxelResolution` changes, then commit `App_Data/povoxelstrike/converted/` |
| `clean.ps1` | Deletes the runtime state a local run leaves in the tree: the Data Protection key ring, the log folder, and the root-level PoVoxelStrike scaffold | Never touches `src/PoMiniGames.Api/App_Data/`, which is source |

## content/

| Script | Purpose | Notes |
|---|---|---|
| `import-trivia.ps1` | Tops up the PoFunQuiz bank from Open Trivia DB, applying the `QuizQuality` rules; appends only questions the bank lacks. Authoring-time only — the app never calls a trivia service | `-WhatIf` reports without writing |
| `pocapitol-figure.mjs` | Writes `wwwroot/models/pocapitol/figure.glb` from `js/pocapitol/rig.js` | Checked by `tests/pocapitol-figure.test.mjs` |
| `pocapitol-campus.mjs` | Writes `wwwroot/data/pocapitol/campus-osm.json` (OpenStreetMap footprints, ODbL) | Calls the Overpass API |

## Asset pipelines

Each folder builds a file the client ships or a check CI runs. They are run by hand when
the asset changes, except where CI is named.

| Path | Builds | Notes |
|---|---|---|
| `pocabinet/` | PoCabinet worlds and splat files (`dump.cs`, `gen.mjs`, `ksplat.mjs`) and the race-health harness | CI runs `dump.cs` and `tests/pocabinet-race-health.test.mjs`. See its README |
| `blender/` | The bedroom and court scenes and their gaussian splats (`wwwroot/models/*.glb`, `*.ksplat`) | Blender scripts, fed to `pocabinet/ksplat.mjs` |
| `pomarblerace/` | The headless harness behind `tests/pomarblerace-map-health.test.mjs` | CI runs `npm ci` here, then the test. See its README |
| `pofighter/` | PoFighter's sprite sheet: `cutout.py` cuts the performer out of video frames (YOLO person mask + BiRefNet), `camera.py` measures the camera's pan and zoom, `pack.py` packs the moves listed in `p1.moves.json`. See its README | Python venv (ultralytics, rembg); intermediates stay under `artifacts/` |

Development is Windows/`pwsh`.

`ci/test-ceilings.ps1 [-NoBuild]` runs only the four method-budget guards, skips browser
installation, and fails if any guard is absent or over budget.
