# E2EUI

C# end-to-end **UI** tests — real-browser coverage driven by
[Microsoft.Playwright](https://playwright.dev/dotnet/) against the live host.
Pure HTTP-contract checks (no browser) live in the sibling
[`E2EAPI`](../E2EAPI/) project.

## How it works

`KestrelServerFixture` boots the real host on a dynamic **Kestrel** port (the
default `WebApplicationFactory` TestServer is in-memory and unreachable by a
browser). Tests navigate to `fixture.ServerAddress` with Playwright and assert
the rendered Blazor WASM UI.

- **`HomePageUiTests`** — launches headless Chromium, navigates to `/`, waits for
  network idle, and asserts the WASM client booted (title + `#app` content).
- **`LinkAuditUiTests`** — visits every route in `GameCatalog.All` plus the main
  pages in one session (SPA navigation), and fails on "Page not found", the error
  boundary or error bar, a same-origin asset 404, a layout shift over 0.25 (CLS via
  `PerformanceObserver`), or sideways scroll on a main page at phone width. The phone pass
  runs on a 375×667 touch phone: every start card must fit without scrolling and offer one OK,
  every visible control must be at least 44px (inline text links and `[data-tap-exempt]`
  excepted), and the end card (2-player Tic-Tac-Toe) must fit with one "Back to main menu".

## Prerequisites

1. **Azurite** on `127.0.0.1:10002` — `scripts/dev/setup.ps1` brings it up.
2. **Playwright browsers** (one-time per machine), installed from the build
   output after a first `dotnet build`:

   ```pwsh
   pwsh tests/PoMiniGames.E2EUI/bin/Debug/net10.0/playwright.ps1 install chromium
   ```

## Running

```pwsh
# from repo root: against the trimmed Release publish (what deploys) - the tier of record
pwsh scripts/run-e2eui.ps1
# quick loop against the in-process, untrimmed host
dotnet test tests/PoMiniGames.E2EUI/PoMiniGames.E2EUI.csproj
```

`scripts/run-e2eui.ps1` publishes `src/PoMiniGames.Api` with `-c Release` to a temp folder, sets
`POMINIGAMES_E2EUI_APP_DIR`, and `KestrelServerFixture` then starts `dotnet PoMiniGames.Api.dll` from it (Test
environment, the same hermetic overrides, its own Testcontainers Azurite) instead of the in-process host.

> **Not run in CI** by default (needs browser binaries). Per repo UPDATES,
> the `.github/workflows/deploy.yml` runs only the Unit tier; this tier is run locally
> via `scripts/dev/test-all.ps1` or in an environment that supplies Azurite + browsers.