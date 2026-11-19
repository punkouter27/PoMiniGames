# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The rules for working in this repository live in `AGENTS.md` and apply to every session:

@AGENTS.md

For the project tour, the list of games and the game workflow and UI rules (the **Shared game UI**
section), see `README.md`.

## Commands

```powershell
docker compose up -d azurite                                   # storage emulator (ports 10000-10002)
dotnet run --project src/PoMiniGames.Api/PoMiniGames.Api.csproj # API + Blazor WASM client on http://localhost:5080
dotnet build PoMiniGames.slnx                                  # warnings are errors (Directory.Build.props)
dotnet format PoMiniGames.slnx --verify-no-changes             # style gate (run locally)
pwsh scripts/ci/css-lint.ps1                                      # CSS gate; run after any scripted CSS edit
npm ci --prefix scripts/ci/js-lint && npm run lint --prefix scripts/ci/js-lint  # JS gate (undefined identifiers), run locally

dotnet test tests/PoMiniGames.Unit --filter "FullyQualifiedName~PoMule"   # one test / one area
dotnet test tests/PoMiniGames.E2EUI -p:SkipPlaywrightInstall=true --filter "..."
```

- The API host serves the client on one origin, so there is no separate client dev server. Never
  build `PoMiniGames.Client` alone while the host is running, because the fingerprinted wasm assets
  stop matching. Under a running host, build with
  `--artifacts-path artifacts/<name>` (it must stay inside the repo).
- `scripts/dev/test-all.ps1` runs all four tiers. The AGENTS.md rules say not to run it for routine
  changes.
- `.github/workflows/deploy.yml` builds and deploys only (no tests, no infra job, no rollback,
  no PR runs): build, publish, `scripts/ci-package.ps1` stages the docs suite,
  `scripts/pre-deploy.ps1` clears stale Kudu files on the Windows App Service, deploy, then wait
  for `/health/live` to answer with this commit's `X-Commit`. The file is identical in every Po
  repo and each repo owns its copy. Tests and checks run locally: `scripts/ci-checks.ps1` still
  bundles the trim/size, format, Bicep, CSS and JavaScript checks, but CI no longer
  calls it. Provision Azure with `azd up` (or `az deployment ... what-if`) from a local shell.

## Tests

- There are four tiers. **Unit** is hermetic. **Integration** uses a Testcontainers Azurite.
  **E2EAPI** runs HTTP contract tests against the compose Azurite. **E2EUI** runs C# Playwright
  against a Kestrel host in the `Test` environment.
- **Owner decision 2026-11-19:** `tests/` holds only the four project folders
  (`PoMiniGames.Unit`, `.Integration`, `.E2EAPI`, `.E2EUI`). There is no shared test-utilities
  project, no test-count ceiling guard and no root-level JS engine tests; tests that needed those
  helpers were dropped. Don't add files or folders at the `tests/` root.
- Each host fixture (`TestWebApplicationFactory`, `PoMiniGamesE2EFixture`, `KestrelServerFixture`)
  sets its own config overrides inline: no live Wikipedia or external quiz packs, a dry Racer
  track, no Key Vault, and storage on Azurite. A new external boundary needs a key in all three.

## Architecture

- **Decisions 2026-11-17 (owner):**
  - `/diag` is the status page (`Features/Health/HealthPage.razor`, `/health` kept as a browser
    alias); it renders `GET /api/diag`, which is always on and anonymous and must never carry
    secrets, addresses or exception messages (`DiagProjectionTests`, `HealthEndpointTests`). The
    server's JSON `/health` and `/health/live` probes are unchanged for the deploy gate.
  - The build date (`v{YYMMDD}`, `Layout/BuildVersion.razor`) is visible bottom-right on every
    page again, above the BottomNav on phones.
  - Forms that submit (initials, ecosystem rename and alerts) validate with FluentValidation rules
    in `PoMiniGames.Shared/Validation` through `Layout/FluentValidationValidator.cs`: inline errors,
    submit disabled while submitting.
  - **Po web standard (2026-11-18).** The shell is shared with every Po app:
    `wwwroot/css/po-tokens.css` (same file everywhere, never edit one copy) is the first
    stylesheet; `css/app-tokens.css` aliases the app's own variables to its `--po-*` tokens.
    Light/dark follows the device only (no theme setting, no `data-theme`); Inter for text,
    Space Grotesk for titles (self-hosted in `wwwroot/fonts/`; Bungee stays for PoBrawl's HUD).
    `MainLayout`'s header is `.po-header`: app name upper-left, the initials menu and the settings
    gear (`.po-header__settings`, opens the settings sheet; `/settings` is the same sheet as a
    page) upper-right. The phone BottomNav is Games / Boards / Stats. The build stamp is one
    `.po-version` (`v{YYMMDD}`, the UTC date of HEAD, computed by `PoBuildStamp` in
    `Directory.Build.props` for client and server alike). `/diag` draws `po-diag__card` cards
    with `po-badge--ok|warn|bad` in API / Data / Services groups. Pressing Tab with nothing focused
    opens `/po-dev.html` (`js/po-devwindow.js` + `js/po-dev.js`, same files everywhere), which
    reads `/health/live` (`X-Commit`) and `/api/diag`; in a game the Tab stats panel then opens
    from its pill. The first-visit initials prompt waits on `/diag`, `/health` and `/settings`
    and never covers the header.
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
  - PoCapitol's after-action debrief (`wwwroot/js/pocapitol/debrief.js`) is client-only: a
    built-in deterministic writer by default, or, if the player opts in, a model on their own
    machine through Ollama. It has no server side, no key and no paid boundary; keep it that way.
- **Constraints:**
  - PoEcosystem is observation-only: never add controls that change its world.
  - Every in-app `<a>` goes through the Blazor router. Hub links marked `data-hub-nav` are
    launched by `wwwroot/js/platform/app.js` (`PoHubNav.go`): `Blazor.navigateTo` inside a same-document
    view transition that morphs the card into the game's title. No WASM reboot.
