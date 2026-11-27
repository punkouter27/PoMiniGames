# AGENTS.md — PoMiniGames

Read this before changing anything; CLAUDE.md only points here. Sections 1–3 are the rules every session follows;
"This repo" below them is what is specific to PoMiniGames.

## 1. Standard

> This repo owns every file in it. Nothing here is generated from, synced with, or required to stay identical to
> another repository. Headers like "SAME FILE IN EVERY PO …", "Generated from po-shared … DO NOT EDIT", and scripts
> that copy files into or check other repos are forbidden. Only Azure resources in the `PoShared` resource group
> may be shared.

The Po Web App Standard, this repo's copy:

This repo is one of several independent Po apps. It follows the conventions below, but it owns every file:
nothing is generated from, synced with, or required to stay identical to another repository. Change anything
here freely; only the *conventions* are common, never the code. Azure resources may be shared through the
`PoShared` resource group; code may not.

### Repo skeleton
```
README.md          what the app is, live URL, how to run locally, how it deploys
AGENTS.md          this standard + repo-specific notes (CLAUDE.md just points here)
CLAUDE.md          one line: "Read AGENTS.md."  (plus repo-specific notes only if unavoidable)
<App>.slnx  global.json  Directory.Build.props  Directory.Packages.props  .editorconfig
src/<App>.Api  src/<App>.Client  src/<App>.Shared  [src/<App>.Mobile]
tests/<App>.Unit  tests/<App>.Integration  [tests/<App>.E2E...]
infra/main.bicep  infra/main.bicepparam  [infra/modules/*.bicep]
scripts/           setup / helper scripts (no infra/*.ps1)
docs/              lowercase; everything else that is prose
.github/workflows/deploy.yml   the ONLY workflow
```
No `.cursorrules`, `.copilotignore`, `SPEC.md`, `tasks/`, `DOCS/` at the root (fold useful content into docs/).
`SCREENSHOTS/` is allowed only if README references it.

### Page shell (every page, signed in or out, including the sign-in page)
- Header `.po-header`, height 56px, sticky: app name top-left (`.po-header__title`, links to `/`).
- Top-right `.po-header__actions`: signed-in user's **email** (`.po-header__email`, full email, ellipsis at 16ch on
  phones) — or, signed out, one **Sign in** button `class="po-link-btn filled small"` (same style on every page) —
  then the settings gear ONLY if the app has a settings page (the owner removed settings from some apps — don't
  re-add it). Apps without OAuth show nothing in place of the email (no fake identity chips).
- Version badge `.po-version` fixed bottom-right showing `vYYMMDD`. It must never cover content: `main` gets
  `padding-bottom: calc(var(--po-space-6) + env(safe-area-inset-bottom))`, and when a mobile bottom nav exists the
  badge sits above it (`--po-stamp-lift: <nav height>`).
- Colours only from `wwwroot/css/po-tokens.css` (`--po-*`). All text ≥ 4.5:1 contrast in light AND dark mode
  (status banners: use `--po-text` on `--po-*-soft` backgrounds, never warning-on-peach).
- Login-only data must not be requested for signed-out visitors (no 401s in the console on public pages), and
  actions a signed-out visitor cannot perform are hidden.

### Version
- `Directory.Build.props` stamps ONE assembly metadata key: `BuildVersion` = UTC `yyMMdd`. No `BuildStamp`/`BuildDate`
  aliases. Every reader (header badge component, `/api/diag`, `/health` headers) reads `BuildVersion`.

### Health + /diag contract
- `GET /health/live` (liveness, returns header `X-Commit: <sha>`), `GET /health` (readiness), `GET /api/diag` →
  ```
  DiagReportDto(string Status, string Environment, string Version, DateTimeOffset CheckedAt, double CheckedMs,
                DiagCheckDto[] Checks)
  DiagCheckDto(string Name, string Group /* "api" | "data" | "service" */, string Label, string Status
               /* Healthy|Degraded|Unhealthy */, string Purpose, string Detail, double LatencyMs, string? Problem)
  ```
- UI route `/diag` ONLY (delete other diagnostics pages/routes such as `/system`, `/diagnostics`, `/status`). Page
  `<title>` and `h1`: **System status**. Layout: overall banner in plain words ("Everything is working" /
  "Working, with N things degraded" / "Not working: …"), then three sections in this order: **API**, **Data**,
  **Services**; each row = label, purpose, status pill, latency ms, problem/detail text. Every external dependency
  the app really calls appears as a check. Anonymous, nothing secret in the payload.

### Workflow (`.github/workflows/deploy.yml`, the only one)
push to master → format check → build (Release, warnings as errors) → Unit tests → Integration tests (Testcontainers /
Azurite; Docker is available on ubuntu-latest) → publish → deploy → confirm `/health/live` X-Commit = this SHA.
If the repo has a MAUI `src/<App>.Mobile`, a second job in the SAME file (`mobile`, `needs: []`, not blocking deploy)
installs the `maui-android` workload and builds the Android target, so the client is always compiled.

### Tests
- Unit tier: fast, no I/O, runs in CI.
- Integration tier: runs in CI; locally it SKIPS with a clear message when Docker is not running (never a wall of
  `DockerUnavailableException` failures).
- E2E/UI tiers: run locally against a running app; when no app URL / browser is available they SKIP with a clear
  message. They are not part of CI.
- Docs must state real counts, not caps that are out of date.

### Azure naming
App Service `app-<repo lowercase>`; per-app resources named `<type>-<repo lowercase>`; shared things only in `PoShared`.

## 2. Concurrent work

> Several sessions (people and agents) commit to this repo, sometimes at the same time.
> - Before every commit and every push: `git fetch origin && git rebase --autostash origin/master`.
> - Stage only the files you changed (`git add <paths>`); never `git add -A` / `git add .`; check `git diff --cached`.
> - Never revert, reformat or overwrite changes you didn't make; keep the owner's recent decisions (e.g. features
>   removed on purpose stay removed).
> - Don't commit or sync from the IDE while an agent is working in this folder.
> - Pushing `master` deploys production; changes to `.github/workflows/*` need a token with the `workflow` scope.

## 3. Verification

One command sequence verifies the repo (format, build, Unit, Integration, E2E API, then E2E UI on the trimmed Release
publish, ~40 min; E2E API needs `docker compose up -d azurite` first):

```powershell
dotnet format PoMiniGames.slnx --verify-no-changes && dotnet build PoMiniGames.slnx -c Release && dotnet test tests/PoMiniGames.Unit -c Release --no-build && dotnet test tests/PoMiniGames.Integration -c Release --no-build && dotnet test tests/PoMiniGames.E2EAPI -c Release --no-build && pwsh scripts/run-e2eui.ps1
```

Every command here was run on 2026-11-22 (Windows, PowerShell or Git Bash, from the repo root). Known red on that
date: the CSS gate (hex literals 697 vs baseline 594, already over on 593c148a) and, on the trimmed Release publish,
`PoMuleUiTests.OnePlayer_PlaysAMonth…` (passes on the in-process host) and `PoEcosystemUiTests.Demo_TheIslandIsAlive`
(the engine never reports ready under SwiftShader within 180 s, on both hosts).
2026-11-24 (v4 fix pass 2, after the owner's one-circuit Racer, dry weather and Cabinet/Mule card changes): five full runs,
the last three in a row green on the trimmed publish (Unit 456, Integration 15, E2E API 16, E2E UI 30/30); run 2 had 3 E2E UI
reds at 100% CPU from parallel agents (a jsDelivr three.tsl.js connection reset, Mule's 10 s walk, Brawl online canvas). Root causes fixed on the way: SignalR
keep-alive 30 s = the clients' 30 s server timeout (a sending-only Marble host dropped mid-race; now 15 s), a required score write
short-circuited by an open storage breaker (Racer 503), the Ecosystem test never pressed the card's OK, LinkAudit waited for
network idle and drove every game through one tab, and Escape could not cancel a start card whose only button is OK.
2026-11-24 (v4 pass 3, idle machine, 4 full runs: run 1 on `ba880109` before the fixes, runs 2-4 on the `e92c1f76` code): Unit 456, Integration 15, E2E API 16 green every run; E2E UI on the trimmed
publish 29/30, 30/30, 29/30, 30/30. Reds: run 1 PoCabinetTwoBrowserRaceTests (a one-shot read during a roster re-render; also the host
PC's audio device failing under headless Chromium: both fixed, every browser now uses `--disable-audio-output`) and run 3
`MarbleRaceMapCertificationTests(mapId: 7)` (marble #86 left the course at s=1441, lat -54: fixed 2026-11-24 in `2bb23179` by raising invisible physics wall collider height to 120 and outer thickness to 3.0 in `track-procedural.js`).
2026-11-24 (post-consolidation & Radzen DialogService pass): `PoMiniGames.Domain` and `PoMiniGames.Infrastructure` consolidated into `PoMiniGames.Shared/Domain` and `PoMiniGames.Api/Infrastructure/Persistence`; CSP hashes all inline `<script>` blocks without `src=`; CSS lint 80/80 clean; JS lint 0 warnings; Unit 460, Integration 15, E2E API 16, E2E UI 30/30 green on trimmed Release publish; `infra/main.bicepparam` and `scripts/ci/ensure-azure-access.ps1` aligned to `app-5ln5hfdrvof5u-f1win2`; all 7 modal `<dialog>` components migrated to Radzen `DialogService`.

| What | Command | Needs / skips |
|---|---|---|
| Format | `dotnet format PoMiniGames.slnx --verify-no-changes` | — |
| Build | `dotnet build PoMiniGames.slnx -c Release` (warnings are errors) | — |
| Unit (463) | `dotnet test tests/PoMiniGames.Unit -c Release --no-build` | nothing; runs in CI |
| Integration (15) | `dotnet test tests/PoMiniGames.Integration -c Release --no-build` | Docker (Testcontainers Azurite); every test skips with one reason without it; runs in CI |
| E2E API (16) | `dotnet test tests/PoMiniGames.E2EAPI -c Release --no-build` | Azurite on 127.0.0.1:10000/10002 (`docker compose up -d azurite`); local only |
| E2E UI (24 methods, 30 cases) | `pwsh scripts/run-e2eui.ps1` (publishes the trimmed Release build to a temp folder and runs the tier against it via `POMINIGAMES_E2EUI_APP_DIR`; `-Filter` narrows it) | Docker + Playwright Chromium (skips with one reason without either); local only, ~40 min, heavy. Plain `dotnet test tests/PoMiniGames.E2EUI` still runs the in-process (untrimmed) host |
| JS lint | `npm ci --prefix scripts/ci/js-lint && npm run lint --prefix scripts/ci/js-lint` | Node |
| CSS lint | `pwsh scripts/ci/css-lint.ps1` | PowerShell 7 |
| Python lint | `uvx ruff check .` (CI runs it only when `ruff.toml` exists; the owner removed it in `1bb7cc8b`, 2026-11-22) | uv |
| Bicep | `az bicep build --file infra/main.bicep` and `az bicep build-params --file infra/main.bicepparam` | Azure CLI |
| UI before/after | `pwsh scripts/screenshots.ps1 -Feature <name> [-Before <ref>\|-BeforeDir <pngs>] [-Routes /,/diag] [-Notes '...']`: Release-publishes each ref in a temp worktree, runs it locally on its own Azurite container, captures 1366×768 + 390×844 with Playwright (`scripts/screenshots/`), writes `SCREENSHOTS/{YYMMDD}-{feature}.html`, small thumbnails in `SCREENSHOTS/{YYMMDD}-{feature}/` and one side-by-side `.png` | Docker, Node, .NET SDK; never the live site |
| Run locally | `docker compose up -d azurite` then `dotnet run --project src/PoMiniGames.Api --launch-profile http` → http://localhost:5080 (status: http://localhost:5080/diag) | Docker for Azurite |
| Deploy | push to `master` → `.github/workflows/deploy.yml` (format, ruff, build, Unit, Integration, publish, deploy to `vars.AZURE_WEBAPP_NAME` = `app-5ln5hfdrvof5u-f1win2`) | — |
| Deploy check | `curl -sI https://app-5ln5hfdrvof5u-f1win2.azurewebsites.net/health/live` shows `X-Commit: <pushed sha>` (the workflow waits for it) | — |
| Live | https://app-5ln5hfdrvof5u-f1win2.azurewebsites.net and https://app-5ln5hfdrvof5u-f1win2.azurewebsites.net/diag | — |
| Pinned tools | .NET SDK 10.0.400 (`global.json`, latestFeature), Python 3.10+ with ruff, Node for the JS lint | — |

## This repo

PoMiniGames: fourteen instant-play mini-games on one website. A .NET 10 minimal API host (SignalR multiplayer hubs,
Azure Table + Blob Storage) serves its own Blazor WebAssembly client; heavy games are JavaScript engines in
`wwwroot/js/<game>/`. No sign-in: a player is a random browser id plus three initials. README.md has the tour, the
games and the **Shared game UI** rules.

- Live: https://app-5ln5hfdrvof5u-f1win2.azurewebsites.net — App Service `app-5ln5hfdrvof5u-f1win2` (F1, Windows,
  .NET 10) in resource group `PoMiniGames`, the one the repo variable `AZURE_WEBAPP_NAME` deploys to (checked 2026-11-22:
  `az webapp list -g PoMiniGames` lists only it, and `app-pominigames.azurewebsites.net` does not resolve). It has a
  system-assigned identity with Storage Table/Blob Data Contributor on `st5ln5hfdrvof5u2`, Cognitive Services User on
  `po-aiservices-shared2` (PoShared) and get/list on `kv-poshared2`. `infra/main.bicepparam` and
  `scripts/ci/ensure-azure-access.ps1` point to `app-5ln5hfdrvof5u-f1win2`.
- Repo variables read by the workflow: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` (GitHub OIDC,
  the `gh-pominigames-deploy` app, Contributor on the resource group), `AZURE_WEBAPP_NAME`, `AZURE_RESOURCE_GROUP`.
  Never move them to secrets or write resource names into the workflow.
- Every permission the app and CI need lives in `scripts/ci/ensure-azure-access.ps1`. A role granted by hand and not
  added there is a bug: the next re-provision loses it.
- Tests pass on any machine: no drive-letter, temp-folder or working-directory assumptions, and no live config value
  hard-coded as an expected result (read it from the same config the app reads).

### Deliberate deviations

| Deviation | Why | Commit sha / date | How to undo |
|---|---|---|---|
| Header shows the player's initials pill where the email would be (opens the initials prompt) | no OAuth by owner rule; the settings sheet is gone and the initials are the one setting left | `080be6b6` 2026-11-22 | — |
| The main menu is paged to fit one screen (1366×768, 375×667): `js/platform/homePager.js` packs whole card rows into pages, a Radzen pager (page buttons, Prev/Next), PageUp/PageDown, arrows on the pager and a swipe turn them; every game ≤ 2 presses; `HomePageUiTests.Home_MenuFitsOneScreen…` pins it | Profile B b_flow (no scrolling) overrides the scrolling hub of `080be6b6`; the cards, tokens and mode grouping are unchanged | v4 fix pass 2, 2026-11-24 (overrides `080be6b6`) | — |
| `src/` also has `PoMiniGames.Domain`, `PoMiniGames.Infrastructure` | score rules, Elo and storage are used by many slices | — | a separate merge refactor |
| Azure names: plan `asp-pominigames-f1`, storage `st5ln5hfdrvof5u2`, App Service `app-5ln5hfdrvof5u-f1win2` (infra/ plans `app-pominigames`, never created) | renaming means recreating and moving data | — | owner-approved recreate |
| Radzen (Profile A): Radzen's theme (light + dark `material*-base.css`) is linked once, FIRST, in `index.html` (v4 audit; replaces the on-demand load of `9e374ccf`; `HomePageUiTests.Shell_LoadsRadzenThemeOnceAndFirst…` pins it). Every action button is `PoButton` and every text box `PoTextBox` (`Features/Shared/Shell/`): a `RadzenButton` / `RadzenTextBox` whose only class is the plain class `po-rz-plain` plus the app's own classes, so no Radzen theme rule matches it and each game's CSS draws it as before (`.po-rz-plain > .rz-button-box { display: contents }` in app.css). A Radzen control is a child component, so its element does not get the page's scoped-CSS attribute: rules whose subject is a converted control go through `::deep` from a scoped ancestor (same specificity). Converted 2026-11-24 (v4 fix pass 2): 244 of 247 buttons and 5 text boxes (raw controls 312 -> 53, of which 14 are the allowed natives below), checked by a before/after pixel diff of 32 routes x 2 sizes. **Allowed natives (file:line):** read-only data tables `PoBrawl/PoBrawlControls.razor:10`, `PoBrawl/PoBrawlFfaPage.razor:151,178`, `PoBrawl/PoBrawlTournamentPage.razor:473`, `PoCabinet/PoCabinetResults.razor:102`, `PoEcosystem/Components/AlmanacPanel.razor:26`, `PoEcosystem/Components/ViewSettingsPanel.razor:40`, `PoMarbleRace/PoMarbleRacePage.razor:425`, `PoRacer/PoRacerResults.razor:21`; the video file input `PoFighter/PoFighterPage.razor:241`; `<video>` (Brawl HQ clip player, PoFighter camera). In-canvas game UI drawn by JS is outside the rule. Converted 2026-11-24 (v4 pass 3): the last 34 form controls. Dropdowns are `PoSelect` (a `RadzenDropDown` over (value, text) pairs: start-card map, lobbies, Ecosystem panels), toggles `RadzenSwitch` or `RadzenCheckBox` (named by `AriaLabel` with the visible text, which toggles it on click: a `RadzenLabel` points at Radzen's inert hidden input and does nothing), radio pill rows `RadzenSelectBar`, ranges `RadzenSlider` (Capitol's keeps its gold through `--rz-slider-*` variables), the nudge pads and rebind keycaps `PoButton` (their `:preventDefault` flags sit on a wrapper element, since a component cannot carry them), the initials box `PoTextBox`. Radzen's script is linked once in `index.html` before Blazor (dropdowns and sliders call it on first render), followed by `js/platform/radzenTopLayer.js`, which lifts a dropdown list opened inside a modal `<dialog>` into the top layer (Radzen moves popups to `<body>`, under the card). Three unused components that held 4 of them were deleted (`PoCabinetPreRace`, `PoRacerTrackSelector`, `PoRacerPaintShop`; their pages dropped them in `5bc1f7f7`/`080be6b6`). Converted 2026-11-24: all 7 modal `<dialog>` components (`GameIntro`, `GameOverModal`, `GameOptionsSheet`, `GamePauseDialog`, `PoCabinetDrawer`, `PoMuleStandings`, and `PoFighterPage` Studio) migrated to Radzen `DialogService` (`OpenAsync` / `OpenSideAsync` via `<RadzenDialog />` in `MainLayout`). | owner-approved full Radzen coverage including dialogs | `9e374ccf` / 2026-11-24 | — |
| /diag: a service switched off on purpose shows a grey **Off** pill, not counted | opt-in services left off are not faults | `9e374ccf` 2026-11-22 | `DiagLiveProbes.cs` |
| Phones: the version stamp sits in a footer after the content, above the BottomNav; desktop keeps it fixed | a fixed stamp covered home cards and /diag rows (overrides the older fixed rule) | `9e374ccf` 2026-11-22 | `git revert 9e374ccf` (stamp part) |
| Ecosystem keeps Tab for its own observation dashboard, not the shared panel | owner design (README "Shared game UI") | — | — |
| E2E UI runs the plain Release publish (Production WASM env, as deployed); the server runs as `Test` with hermetic overrides | same bytes as deploy | `75078287` 2026-11-22 | — |

**Hosting:** App Service F1 (Free, Windows, `asp-pominigames-f1`): 331 MB of data out per day (the quota Azure enforced
on 2026-11-22; over it the site stops with `QuotaExceeded` until 00:00 UTC) and 60 CPU-minutes per day. Never run test
suites against the live site; live checks = at most 6 page loads + /diag + X-Commit.

### Commands

```powershell
docker compose up -d azurite                                   # storage emulator (ports 10000-10002)
dotnet run --project src/PoMiniGames.Api/PoMiniGames.Api.csproj # API + Blazor WASM client on http://localhost:5080
dotnet build PoMiniGames.slnx                                  # warnings are errors (Directory.Build.props)
dotnet format PoMiniGames.slnx --verify-no-changes             # style gate (run locally)
pwsh scripts/ci/css-lint.ps1                                      # CSS gate; run after any scripted CSS edit
npm ci --prefix scripts/ci/js-lint && npm run lint --prefix scripts/ci/js-lint  # JS gate (undefined identifiers), run locally

dotnet test tests/PoMiniGames.Unit --filter "FullyQualifiedName~PoMule"   # one test / one area
dotnet test tests/PoMiniGames.E2EUI -p:SkipPlaywrightInstall=true --filter "..."
uvx ruff check .                                               # Python lint (scripts/blender, scripts/pofighter)
```

- The API host serves the client on one origin, so there is no separate client dev server. Never
  build `PoMiniGames.Client` alone while the host is running, because the fingerprinted wasm assets
  stop matching. Under a running host, build with
  `--artifacts-path artifacts/<name>` (it must stay inside the repo).
- `scripts/dev/test-all.ps1` runs all four tiers. The AGENTS.md rules say not to run it for routine
  changes.
- `.github/workflows/deploy.yml` (the only workflow): format, ruff, build, Unit, Integration, publish,
  `scripts/ci-package.ps1` stages the docs suite, `scripts/pre-deploy.ps1` clears stale Kudu files on the Windows
  App Service, deploy, then wait for `/health/live` to answer with this commit's `X-Commit`. No rollback, no PR runs;
  a red check stops the deploy. `scripts/ci-checks.ps1` bundles the local-only checks (Bicep, CSS, JS lint, JS engine
  tests, WASM trim audit, ruff). Provision Azure locally:
  `az deployment sub create -l westus2 -f infra/main.bicep -p infra/main.bicepparam` (what-if first).

### Tests

- There are four tiers (counts as of 2026-11-22). **Unit** (442) is hermetic and runs in CI. **Integration** (17)
  uses a Testcontainers Azurite and runs in CI; locally every test SKIPS with one reason (`DockerFact`) when Docker is
  not running. **E2EAPI** (16) runs HTTP contract tests in-process against the compose Azurite (local only).
  **E2EUI** (22) runs C# Playwright against a Kestrel host in the `Test` environment (local only; `UiFact` skips when
  Docker or Playwright Chromium is missing).
- **Owner decision 2026-11-19:** `tests/` holds only the four project folders
  (`PoMiniGames.Unit`, `.Integration`, `.E2EAPI`, `.E2EUI`). There is no shared test-utilities
  project, no test-count ceiling guard and no root-level JS engine tests; tests that needed those
  helpers were dropped. Don't add files or folders at the `tests/` root. Docs state real counts, never caps.
- Each host fixture (`TestWebApplicationFactory`, `PoMiniGamesE2EFixture`, `KestrelServerFixture`)
  sets its own config overrides inline: no live Wikipedia or external quiz packs, a dry Racer
  track, no Key Vault, and storage on Azurite. A new external boundary needs a key in all three.

### Architecture

- **Decisions (owner):**
  - `/diag` is the only status page (`Features/Health/DiagPage.razor`, title and h1 "System status"); it renders
    `GET /api/diag` (`DiagEndpoints`, the standard `DiagReportDto`), which is always on and anonymous and must never
    carry secrets, addresses or exception messages (`DiagProjectionTests`, `HealthEndpointTests`). Rows: API (this
    request, measured; the multiplayer hubs, proven by a live SignalR negotiate on this server), Data (the storage
    health checks, tables, blob containers), Services (`Features/Health/DiagLiveProbes.cs`: a Key Vault secret
    listing, the App Insights ingestion profile, the push-invite keys in storage, Wikipedia and the three Couple Quiz
    APIs, each a real call cached 60 s, 10 min for the free third-party APIs). The whole run (health checks with a
    5 s timeout each, storage listings, live probes) is one `HealthSnapshotCache` entry kept 60 s: `/health`,
    `/api/health` and `/api/diag` all read it, so two loads within a minute show the same `checkedAt`
    (`HealthSnapshotCacheTests`). A service switched off on purpose
    (test hosts, no connection string, a feature flag set to false) reads **Off**: a grey pill, no problem text, never
    counted in the banner (`DiagProjectionTests`, `HealthEndpointTests`). A table or container missing from the listing is normal: each is created
    on first use. `/health` (JSON readiness, never HTML) and `/health/live` (`X-Commit`) are the probes.
  - The build version (`v{YYMMDD}`, `Layout/BuildVersion.razor`) is visible bottom-right on every page, above the
    BottomNav on phones (`--po-stamp-lift`); `.gl-content` reserves the strip under every page so it never covers
    content, except desktop game routes (`game-shell.css`), where the game fills the well and its start cards are
    sized to it.
  - Forms that submit (initials, ecosystem rename and alerts, couple quiz answers) validate with FluentValidation
    rules in `PoMiniGames.Shared/Validation` through `Layout/FluentValidationValidator.cs`: inline errors, submit
    disabled while submitting. Each validator is registered by type (`AddScoped<IValidator<X>, XValidator>()` in the
    client's `Program.cs`, the API's in `GameServicesExtensions`) and injected; no `new()`, no assembly scanning.
  - **Page shell (Po web standard).** `wwwroot/css/po-tokens.css` (this repo's copy; change it freely) is the first
    stylesheet; `css/app-tokens.css` aliases the app's own variables (and PoFighter's `--pf-*` colours) to `--po-*`
    tokens. Light/dark follows the device only; Inter for text, Space Grotesk for titles (self-hosted in
    `wwwroot/fonts/`; Bungee stays for PoBrawl's HUD). `MainLayout`'s header is `.po-header`: app name upper-left
    and, upper-right, the player's initials pill (`.po-header__initials`, opens the initials prompt; `080be6b6`
    removed the settings gear, sheet and `/settings`). There is no sign-in, so no email and no Sign in button. The
    phone BottomNav is Games / Boards / Stats. Pressing Tab with nothing focused opens `/po-dev.html`
    (`js/po-devwindow.js` + `js/po-dev.js`), which reads `/health/live` (`X-Commit`) and `/api/diag`; in a game the
    Tab stats panel then opens from its pill. The first-visit initials prompt waits on `/diag` and `/settings` and
    never covers the header.
  - Storage settings are read from DI `IConfiguration` when the clients are built
    (`StorageExtensions`), never at registration: read eagerly they missed the test hosts'
    overrides and every integration fixture silently used the machine's shared Azurite.

- **Projects:** `src/` holds five projects.
  - `PoMiniGames.Api`: the ASP.NET Core host. It contains vertical slices in `Features/<Game>`
    and also serves the client.
  - `PoMiniGames.Client`: Blazor WASM, assembly name `PoMiniGamesClient`.
  - `PoMiniGames.Domain`: `GameKey`, `ScoreRules`, Elo and the high-score models.
  - `PoMiniGames.Infrastructure`: the `StorageService` partials and `HighScoreDescriptor<T>`.
  - `PoMiniGames.Shared`: the DTOs and pure game logic shared by client and server.
  - NuGet versions live only in `Directory.Packages.props` (Central Package Management).
- **Adding a game** touches several files:
  1. Add a `GameKey` value to the WellKnown list in Domain `Primitives/GameKey.cs`. It is a
     string value-object, not an enum.
  2. Add a `ScoreRules` bounds entry and a high-score model.
  3. In `StorageService`, add the table and partition constants and a `HighScoreDescriptor`.
  4. Create `Features/<Game>/*Endpoints.cs` and map it in
     `Api/Infrastructure/EndpointRouteExtensions.cs` on the `gameApi` group (the `/api` prefix).
     Map hubs there too.
  5. Add a case to `Features/Leaderboard/UnifiedLeaderboardEndpoints.cs`.
  6. Register services and options in `Infrastructure/GameServicesExtensions.cs`.
  7. On the client, add `Models/GameKeys`, `Models/GameCatalog.cs`, and a page at
     `Games/<Game>/<Game>Page.razor` with routes `/game` and `/game/{Mode}`.
- **JS engines:** heavy games are JS engines in `Client/wwwroot/js/<game>/`.
  `wwwroot/js/platform/engineLoader.js` (`loadEngine(name)`) loads them on demand, and the page's
  `.razor.cs` drives them over IJSRuntime. Engines run on the shared host
  `platform/stage/stage.js` (`createStage`) with helpers in `platform/2d/` and `platform/3d/`; a new
  cross-game effect goes in `platform/stage/features/` (written once), not inside a game. The PWA service worker precaches them automatically
  through the asset manifest.
  - The CSP has no `'unsafe-eval'`: a library that builds functions from strings (three's Basis /
    KTX2 transcoder does, in r165 and r186) fails in the browser. Check a new WASM library on
    the running app before building on it. KTX2 textures go through our own build of the
    transcoder in `wwwroot/lib/basis/` (`scripts/pocabinet/basis-build.sh`; `models.js` shows
    how to point `KTX2Loader` at it).
- **Results flow:**
  - Every game reports to `Client/Services/Play/GameResultService`.
  - It records local stats (`GameStatsService`) and submits the score through `ApiService`.
  - A score that fails to submit is parked in `PendingScoreStore`/`ScoreSyncService` and
    retried.
  - On the server, `Features/Integrity` (`PlaySessionService`, `ScoreIntegrityGuard`) validates
    scores.
- **JSON:** new client DTOs need a `[JsonSerializable]` entry in
  `Client/Services/Http/ApiJsonContext.cs` (or in the game's own JSON context), because the WASM
  build is trimmed.
- **Storage:** Azure Tables and Blob, using Azurite in dev and test and managed identity in
  prod. `StorageInitializer` creates tables at startup.
- **Identity:** there is no sign-in and no OAuth. Each browser keeps a random player id and the
  player's three initials (`Client/Services/Play/PlayerNameService.cs`, prompted by
  `InitialsPromptModal`) and sends them as `X-Player-Id` / `X-Player-Initials`
  (`PlayerIdentityHandler`); SignalR carries them as the `playerId` / `initials` query parameters.
  `Api/Infrastructure/PlayerIdentityExtensions.cs` (`UsePlayerIdentity`) turns them into claims and
  every slice reads the caller through `Features/Identity/RequestIdentity.cs`. The id is a handle,
  not a credential. Do not add sign-in back without being asked.
  - Writes need the antiforgery token (`AntiforgeryExtensions`); reads are anonymous. There is no
    route-level authorization gate: an endpoint that needs a player id checks for one itself.
- **SignalR:** multiplayer games use hubs mapped in `EndpointRouteExtensions.cs`; their state is
  held in memory, and a hub refuses a seat to a connection with no player id.
- **AI:** none; quizzes draw from JSON banks.
  - PoFunQuiz and PoCoupleQuiz pick random questions from in-memory banks loaded once from
    `Features/*/Data/questions.json` (no table, no network). Couple answers use the free
    `AnswerMatcher`.
  - Ecosystem, Brawl and Cabinet are
    scripted. Do not add AI services back without being asked.
  - Cabinet's radio lines are spoken from clips voiced once, offline
    (`scripts/pocabinet/radio-voices.mjs`, a local text-to-speech model; the MP3s and their
    manifest are in `wwwroot/audio/pocabinet/`). Nothing is generated at run time. After editing
    `PoCabinetDialogue` run the script again (`--check` lists lines with no clip).
  - PoEcosystem's creature thoughts and chronicle narration are spoken the same way
    (`scripts/poecosystem/voices.mjs`; clips and manifest in `wwwroot/audio/poecosystem/`).
    After editing `sim/thoughts/templates.js` or `NARRATION` in `render/chronicle.js` run it
    again. Its creature models are generated too (`scripts/poecosystem/creatures.mjs` writes
    `wwwroot/models/poecosystem/*.glb`; `--check` fails if a file is stale).
  - PoCapitol's after-action debrief (`wwwroot/js/pocapitol/debrief.js`) is client-only: a
    built-in deterministic writer by default, or, if the player opts in, a model on their own
    machine through Ollama, or SmolLM2-360M run inside the page by Transformers.js (owner
    request 2026-11-20; weights from Hugging Face on first use). It has no server side, no key
    and no paid boundary; keep it that way.
  - PoCapitol's police loudhailer orders are voiced offline like Cabinet's radio
    (`scripts/pocapitol/voices.mjs`; clips in `wwwroot/audio/pocapitol/`). After editing `LINES`
    in `js/pocapitol/loudhailer.js` run it again (`--check` lists lines with no clip).
  - PoCapitol's House map (start card, Map dropdown; `wwwroot/js/pocapitol/house/`) draws the house
    scan PoCabinet's House Party ships (`models/house.ksplat`, `house-low.ksplat`): one file for
    both games, in the frame of `scripts/pocabinet/house-frame.json`. Its floor and walls are
    `models/pocapitol/house-nav.json`, baked by `scripts/pocapitol/house-nav.py`; after a new scan
    or a refit of that frame run it again, or the walls stop matching the picture.
- **Constraints:**
  - PoEcosystem is observation-only: never add controls that change its world.
  - Every in-app `<a>` goes through the Blazor router. Hub links marked `data-hub-nav` are
    launched by `wwwroot/js/platform/app.js` (`PoHubNav.go`): `Blazor.navigateTo` inside a same-document
    view transition that morphs the card into the game's title. No WASM reboot.

### Working rules

#### 1. Git & Workflow

- **Stay on `master`:** Commit directly to `master`. Create branches only when specifically asked.
- **Casual Commits:** Write short, natural commit messages using informal American phrasing.
  Auto-commit and push on sync.

#### 2. Running, Testing & Clean Code

- **Run Only Related Tests:** Test only what was touched. Skip tests for minor edits; run the
  whole suite (`scripts/dev/test-all.ps1`) only for a change to the shell or to many games.
- **Zero Warnings:** Fix all build warnings immediately. Treat every warning as a failure.
- **Restart After Changes:** Restart the app after a code change and verify it comes back up.
- **No User Secrets:** Do not use `dotnet user-secrets`. Put local data in `appsettings` or in
  Azure Key Vault (if one exists).

#### 3. Architecture & Setup

- **Keep Docs Updated:** Check `docs/` and `README.md` first to get an overview of the app quickly.
  When a dependency, a configuration key or a major endpoint changes, update them in the same
  change.
- **Fully Automated:** Run all builds, scripts, and setup commands directly. Do not ask the user to
  run terminal commands or click through a web GUI.

#### 4. UI & Output Rules

- **UI Previews:** For visual changes, save before-and-after HTML mockups to
  `SCREENSHOTS/{YYMMDD}-{feature}.html`, and annotate screenshots showing the before and after with
  notes in a single PNG. Give the full path. One command does it: `pwsh scripts/screenshots.ps1 -Feature <name>`
  (see section 3).
- **Proposed Solutions:** When reporting a problem, include a proposed solution for approval.
- **Clarifying Questions:** If modifying more than 100 lines and no pending questions exist, list 3
  key follow-up questions about future direction or logic.
- **Required Footers:**
  - **Short Recap:** If your response is over 100 words, add a recap under 20 words at the very end.
  - **3-Level Summary:** If a code change is over 20 lines, add 3 single-sentence summaries:
    - *Toddler:* Explain the idea simply.
    - *Child:* Explain what the app actually does now.
    - *Adult:* Explain how it was built.
    Include a small diagram to make the changes easier to understand
    ([diagram-design](https://github.com/cathrynlavery/diagram-design)).

#### 5. Shared Components

- **Consolidate When Practical:** Prefer consolidating reusable functionality and UI into shared
  components when it meaningfully reduces duplication without obscuring game-specific behavior.

#### 6. Game Workflow and UI/UX (PoMiniGames Only)

Follow the **Shared game UI** section of [README.md](README.md#shared-game-ui) for all game workflow and UI/UX
changes: Main menu → start card (one OK, plus a map dropdown in 1P/2P for games with several
maps) → game → end card (one "Back to main menu"); Tab opens the stats panel during gameplay only.
