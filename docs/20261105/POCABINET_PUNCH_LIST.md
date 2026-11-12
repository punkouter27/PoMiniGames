# PoCabinet punch list — 2026-11-05

Found while building the Bedroom Floor GP, the room splat and the 11–40 batch (cleanup,
graphics, audio, pre-race UI). Severity: **P1** broken for players or hides breakage,
**P2** visible problem, **P3** polish, **P4** noise. "Fixed" items stay listed so the history
is in one place.

| # | Sev | Area | Problem | Repro | Status |
|---|-----|------|---------|-------|--------|
| 1 | P1 | Tests | `PoCabinetRouteUiTests` sent the X-Fake-* auth headers on every request, so jsdelivr rejected the three.js CORS preflight and the engine never loaded in the test. It passed anyway because the race canvas markup rendered regardless. | Old test + the new crash card: `/pocabinet/demo` showed "The race view stopped". | **Fixed**: headers go to the app origin only (as PoVoxelStrike does); all 4 PoCabinet E2E pass with the engine really loading. |
| 2 | P2 | LinkAudit | `/pomarblerace/1player` start card scrolls on a 390 px phone (616 px of content in 602 px). Pre-existing: fails at `b3b6649b` too. | `dotnet test tests/PoMiniGames.E2EUI --filter LinkAudit` | Open (PoMarbleRace, not touched here). |
| 3 | P2 | Bedroom race | 100-car field wrecks 12–23 cars a race at double width (Capitol: 1). Cars racing 3–4 abreast at speed. | `node scripts/pocabinet/harness.mjs race bedroom messy` | Accepted by the owner (~15 OK); CI bounds it at 30. |
| 4 | P2 | Performance | Splat room runs 27–54 fps vs 46–62 with the mesh (CPU sort of 400k splats each frame). | Demo on the bedroom, desktop GPU. | Mitigated: low tier and the "Lite" setting use the mesh; the 100k light splat shows first. |
| 5 | P2 | Lite retry | "Retry with lite graphics" reloads the page (qualityTiers.js reads `?fx=` only at load), so the player lands back on the start card. | Force a mount failure, press the button. | **Fixed**: the retry switches to low effects and remounts without a page reload or intro-card detour. |
| 6 | P3 | Visual | Splat walls look hazy/soft on bare surfaces; the ceiling is cut at ~1.8 m so the dome shows above. | Bedroom, chase cam near a wall. | Open: drop the largest splats or raise the budget. |
| 7 | P3 | Visual | Rain can fall indoors on the bedroom (weather setting is global). | Settings → Weather: Rain, race the bedroom. | **Fixed**: room tracks resolve to dry in the environment mount, suppressing scene rain, rain audio and the race's rain state. |
| 8 | P3 | Audio | Bedroom audio (seam clicks, room reverb, plastic impacts) not yet tuned by ear; road rumble and squeal still sound like tarmac; vertical Doppler is zero (race.js sends no `vy`). | Race the bedroom with sound. | Open. |
| 9 | P3 | UI | Page-transition captures: the "Cabinet" title doubles and a particle burst covers the header for a frame while the hub morph runs. | Navigate hub → Cabinet and screenshot during the transition. | **Fixed**: suppresses the title swarm during hero navigation, including after asynchronous startup waits. |
| 10 | P3 | UI | Results "Race details" collapse: telemetry chart drawn while collapsed (height-hidden) — verify it renders full width once expanded on a finished race. | Finish a 1P race, open details. | Verify. |
| 11 | P3 | UI | Camera is not a stored setting; the "Next view" button only appears in the in-race drawer. | Pre-race Settings tab. | By design. |
| 12 | P4 | Console | D3D shader compile notes (X3595 gradient-in-loop, X3577 isnan) from three/splat shaders. | Any race on Windows/ANGLE D3D11. | Harmless; ignore. |
| 13 | P4 | Docs | CLAUDE.md and README.md linked to the removed `DOCS/20261003/` folder. | Open the links. | **Fixed**: links now point to the current `DOCS/20261029/` documentation suite. |
| 14 | P2 | Build | NuGet advisory GHSA-g27p-qf6j-c96c (ASP.NET Core ≤ 10.0.13) turned the build red under warnings-as-errors. | `dotnet build` | **Fixed** earlier: bumped to 10.0.14. |
| 15 | P3 | Tooling | Python edits on Windows wrote CRLF and failed the format gate. | Edit a file in text mode. | **Fixed**: `.gitattributes` already pins LF; 3D assets now marked binary; edits write LF. |
