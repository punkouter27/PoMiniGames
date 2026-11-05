# PoMarbleRace node tools

Headless runs of the real Marble Race engine (`src/PoMiniGames.Client/wwwroot/js/pomarblerace/`).
Only the renderer, the audio graph and the window-only effects are swapped for stubs
(`loader.mjs`, `stubs/`, `env.mjs`); maps, physics, marbles and every per-step rule are the
shipped code. Not part of the app build.

```powershell
npm ci --prefix scripts/pomarblerace
node scripts/pomarblerace/harness.mjs race all 1       # full 101-marble race per map, JSON per line
node scripts/pomarblerace/harness.mjs tunnel all       # fire every marble at the speed cap into floor and walls
node scripts/pomarblerace/tune-stall.mjs all 1,2       # sweep tuning.js STALL_* and print a table
node --test tests/pomarblerace-map-health.test.mjs     # the CI gate (deploy.yml)
```

- A race is repeatable: `Math.random` and the course seed are pinned per seed argument.
- Playground Run's visual model is Draco-compressed (a browser Worker decodes it); the harness
  loads an empty model in its place. Its physics comes from `playground_colliders.glb` and the
  baked lanes, so nothing physical changes.
- `tune-stall.mjs` runs each candidate in its own process with `PMR_TUNE` (a JSON object of
  tuning.js constants), which `loader.mjs` writes into tuning.js as it loads. It never edits
  tuning.js itself.
- The browser equivalent is the E2EUI `MarbleRaceMapCertificationTests`.
