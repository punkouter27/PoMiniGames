# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The rules for working in this repository live in `AGENTS.md` and apply to every session:

@AGENTS.md

For the project tour and the list of games, see `README.md`. `GAME-CONSISTENCY.md` holds the game
workflow and UI rules; `docs/2026-11-12/VISUAL_ARCHITECTURE_DASHBOARD.html` is the current visual
architecture overview.

## Commands

```powershell
docker compose up -d azurite                                   # storage emulator (ports 10000-10002)
dotnet run --project src/PoMiniGames.Api/PoMiniGames.Api.csproj # API + Blazor WASM client on http://localhost:5080
dotnet build PoMiniGames.slnx                                  # warnings are errors (Directory.Build.props)
dotnet format PoMiniGames.slnx --verify-no-changes             # CI style gate
pwsh scripts/ci/css-lint.ps1                                      # CI CSS gate; run after any scripted CSS edit
npm ci --prefix scripts/ci/js-lint && npm run lint --prefix scripts/ci/js-lint  # CI JS gate (undefined identifiers)
pwsh scripts/ci/test-ceilings.ps1                                 # test-count ceiling guards only

dotnet test tests/PoMiniGames.Unit --filter "FullyQualifiedName~PoMule"   # one test / one area
dotnet test tests/PoMiniGames.E2EUI -p:SkipPlaywrightInstall=true --filter "..."
node --test tests/pomule-world.test.mjs                        # one JS engine test file
node --test "tests/*.test.mjs"                                 # every JS engine test (CI runs them all)
```

- The API host serves the client on one origin, so there is no separate client dev server. Never
  build `PoMiniGames.Client` alone while the host is running, because the fingerprinted wasm assets
  stop matching. Under a running host, build with
  `--artifacts-path artifacts/<name>` (it must stay inside the repo).
- `scripts/dev/test-all.ps1` runs all four tiers. The AGENTS.md rules say not to run it for routine
  changes.
- CI uses the shared `.github/workflows/deploy.yml`: `scripts/ci-checks.ps1` preserves the
  trim/size, format, Bicep, CSS, test-ceiling, and JavaScript checks; `scripts/ci-package.ps1`
  stages the docs suite; `scripts/pre-deploy.ps1` clears stale Kudu files on the Windows App Service.
  Only master deploys. Provision with a manual run of `.github/workflows/deploy.yml` with `infra` = what-if, then apply or `azd up`.

## Tests

- There are four tiers. **Unit** is hermetic. **Integration** uses a Testcontainers Azurite.
  **E2EAPI** runs HTTP contract tests against the compose Azurite. **E2EUI** runs C# Playwright
  against a Kestrel host in the `Test` environment.
- Each tier has a ceiling on its test-method count, enforced by `*CeilingTests.cs` via
  `tests/Shared/TierCeilingGuard.cs`: Unit 85, Integration 34, E2EAPI 18, E2EUI 22. When a tier
  is full, fold facts into the class's `Scenario` theory (`tests/PoMiniGames.Unit/Scenarios.cs`)
  or move a test to another tier rather than raising the cap.
- Every fixture applies `tests/Shared/TestBudgetGuard.cs`, which forces mock or stub AI and
  disables Key Vault. Any new paid-AI boundary needs a key there so tests never spend money.

## Architecture

- **Decisions 2026-11-17 (owner):**
  - `/diag` is the status page (`Features/Health/HealthPage.razor`, `/health` kept as a browser
    alias); it renders `GET /api/diag`, which is always on and anonymous and must never carry
    secrets, addresses or exception messages (`DiagProjectionTests`, `HealthEndpointTests`). The
    server's JSON `/health` and `/health/live` probes are unchanged for the deploy gate.
  - The build date (`v{YYMMDD}`, `Layout/BuildVersion.razor`) is visible bottom-right on every
    page again, above the BottomNav on phones and above the modal layer.
  - Forms that submit (initials, ecosystem rename and alerts) validate with FluentValidation rules
    in `PoMiniGames.Shared/Validation` through `Layout/FluentValidationValidator.cs`: inline errors,
    submit disabled while submitting.
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
