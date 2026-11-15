# scripts/

Working scripts only — the one-off debug files that used to live here were removed in
the 2026-08-18 cleanup (they referenced files that no longer exist and had no callers).

| Script | Purpose | Called from |
|---|---|---|
| `test-all.ps1` | All four test tiers (Unit → Integration → E2E-API → E2E-UI); frees port 5080, starts Azurite, installs Playwright. CI itself runs only the Unit tier. | README.md, E2E-UI csproj |
| `setup.ps1` | One-time dev-machine setup | E2E-API fixture docs |
| `smoke-local.ps1` | Local smoke of the running app | `.vscode/tasks.json` |
| `bundle-report.ps1` | Trimmed WASM bundle size report (top-DLLs + per-CSS breakdown) | test-all.ps1 snapshot pointer |
| `coverage-matrix.ps1` | Cross-tier route-coverage matrix over the four dotnet test tiers | on demand |
| `css-lint.ps1` | Structural check of every stylesheet (unterminated comments, unbalanced braces) | `deploy.yml`; run it after any scripted CSS edit |
| `test-ceilings.ps1` | The four test-method budget guards, without Docker or browsers | `deploy.yml`, README.md |
| `import-trivia.ps1` | Tops up the PoFunQuiz bank (`Features/PoFunQuiz/Data/questions.json`) from Open Trivia DB: fetches whole categories, applies the `QuizQuality` rules, appends only questions the bank lacks. Authoring-time only; the app never calls a trivia service. `-WhatIf` reports without writing. | on demand |

## Asset pipelines

Each folder below builds a file the client ships or a check CI runs. They are run by hand when
the asset changes, except where CI is named.

| Path | Builds | Notes |
|---|---|---|
| `pocabinet/` | PoCabinet worlds and splat files (`dump.cs`, `gen.mjs`, `ksplat.mjs`) and the race-health harness | CI runs `dump.cs` and `tests/pocabinet-race-health.test.mjs`. See its README |
| `blender/` | The bedroom and court scenes and their gaussian splats (`wwwroot/models/*.glb`, `*.ksplat`) | Blender scripts, fed to `pocabinet/ksplat.mjs` |
| `pomarblerace/` | The headless harness behind `tests/pomarblerace-map-health.test.mjs` | CI runs `npm ci` here, then the test. See its README |
| `pocapitol-figure.mjs` | `wwwroot/models/pocapitol/figure.glb` from `js/pocapitol/rig.js` | Checked by `tests/pocapitol-figure.test.mjs` |
| `pocapitol-campus.mjs` | `wwwroot/data/pocapitol/campus-osm.json` (OpenStreetMap footprints, ODbL) | Calls the Overpass API |
| `pofighter/` | PoFighter's sprite sheet: `cutout.py` cuts the performer out of video frames, `pack.py` packs the moves listed in `p1.moves.json` | Python; intermediates stay under `artifacts/` |

Development is Windows/`pwsh`.

`test-ceilings.ps1 [-NoBuild]` runs only the four method-budget guards, skips browser installation, and fails if any guard is absent or over budget.
