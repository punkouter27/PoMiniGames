# PoCapitol delivery checklist

- [x] Establish failing focused scenario tests before implementing rules.
- [x] Implement rules and pass movement/combat/pause/outcome/restart tests.
- [x] Add procedural 3D scene, on-demand engine and input lifecycle.
- [x] Register domain/client identity and catalog entry.
- [x] Add shared-shell player interface with Radzen controls and local-only results.
- [x] Update capability map, specification, README and PRD status.
- [x] Complete browser workflows and repair issues found.
- [x] Save before/after HTML and annotated comparison PNG.
- [x] Rebuild host without warnings, rerun focused checks and verify restarted health.

## Initial implementation verification evidence

| Requirement | Evidence |
|---|---|
| Recognized identity without a public board | 17 passing targeted .NET `ScoreRulesTests.CheckAgainstSession_JudgesScoreAgainstElapsedTime` cases, including `pocapitol` |
| Ordered journey, collision, combat and terminal rules | 13 passing `node --test tests/pocapitol-world.test.mjs` tests, including lifecycle, controller routing and explicit UI failure feedback |
| Host/client compatibility | API host build using `--artifacts-path artifacts/pocapitol`: zero warnings and zero errors; touched .NET formatting check clean |
| Stylesheet integrity | `pwsh scripts/css-lint.ps1`: all 65 stylesheets clean |
| Full player journey | Real headless Edge: hub entry, start, pause/resume, all four milestones, completion, result persisted exactly once, replay, loss, return and re-entry |
| Input and mobile presentation | Actual touch events advance from the grounds to milestone two; 390-pixel layout has no horizontal overflow; keyboard movement exercised throughout |
| Historical and visual boundaries | Intro and result include explicit fiction notices; captured facade/dome, Rotunda-inspired hall and House-inspired destination; no real breach route modeled |
| Preserved shared behavior | Existing Voxel Strike card remains visible; leaving removes the PoCapitol canvas and scoped Radzen theme; re-entry creates exactly one canvas |
| Browser reliability | Final acceptance run completed without console errors or unhandled browser exceptions |
| Scoped security review | No vulnerabilities found in the new game and its registration/input changes |
| Running app | Restarted at `http://localhost:5080`; `/health/live` OK and `/health` Healthy with local Azurite |
| Before/after evidence | Local `SCREENSHOTS/261109-pocapitol.html` and annotated `SCREENSHOTS/261109-pocapitol.png`, plus exterior/interior/result/mobile/touch captures |

Review and simplification kept rules separate from presentation, reused the existing
loader, shell, Radzen theme, input and results services, and shared column positions
between collision and rendering. Physical controller hardware was not available;
controller implementation and navigation routing were checked without claiming a
hardware playtest.

Only related tests are required. No push or production deployment is part of this task.

## Crowd/demo expansion

- [x] Establish six failing population, autonomy, leader and NPC damage checks.
- [x] Implement exactly 99 solo NPCs or 100 demo NPCs with independent navigation/combat.
- [x] Add police attacks against both human and NPC raiders, incapacitation and demo failure/reset.
- [x] Add deterministic ordered-progress/remaining-route leader selection, including sub-cell ties.
- [x] Add instanced winter clothing, U.S./campaign flags, helmets, visors and labeled police shields.
- [x] Improve public-reference facade/dome, Rotunda floor/pilasters/dome and House rostrum/seating.
- [x] Share seat collision/render data; batch repeated architecture; avoid camera-obscuring nearby flags.
- [x] Wire shared mode switch/demo reel, automatic start/replay, spectator counts and solo-only stats.
- [x] Update capability map, spec, README, PRD and plan; preserve existing game documentation.
- [x] Verify exact requirements with focused tests, host build, formatting/CSS and real browser journeys.
- [x] Save new before/after HTML and annotated PNG; restart app and verify both health endpoints.

### Expansion verification evidence

| Requirement | Evidence |
|---|---|
| Exact populations and independent progress | 20 passing focused Node tests; both Story and Standard demos finish; all NPCs remain walkable throughout |
| Combat, failure and camera leadership | Police can incapacitate NPCs; solo human-only outcome preserved; all-dead demo fails; eligible leader changes, ignores incapacitated actors and uses stable ties |
| Lifecycle and inputs | Engine preview/pause/dispose checks pass; human movement/fire ignored in demo; focus changes do not stop unattended playback; demo loops |
| Host/client and styling | Final API/client build: zero warnings/errors; touched Razor/catalog formatting clean; all 65 stylesheets pass CSS gate |
| Real browser demo | Headless Edge: starts automatically, completes, replays, follows three different subject IDs; stats unchanged; no touch/fire controls displayed |
| Real browser solo | Full grounds-to-chamber human journey; win saved once; repeated notifications do not duplicate results; solo/demo switches work repeatedly without reload |
| Real browser touch | 390 x 844 demo fits viewport; switching to solo and holding a real touch direction advances to the second objective; pause works |
| Rendering budget | 112 simulation actors (100 raiders + 12 police); crowd uses 23 instanced batches; repeated scenery batching reduces observed initial scene calls from 509 to 129 |
| Visual evidence | `SCREENSHOTS/261109-pocapitol-crowd.html` and annotated `.png`, plus current exterior, Rotunda, chamber, solo, mobile and touch captures |
| Cleanup and reliability | One canvas after repeated switches; none after leaving; no console errors or unhandled browser exceptions in acceptance run |
| Restart | Updated app responds at `http://localhost:5080`; `/health/live` OK and `/health` Healthy with Azurite |

Expected red tests preceded implementation. Iteration found and corrected Razor nesting,
host-output file locks, stale shared-mode selection and camera-blocking banners.
The final checks above are green; no unrelated full suite or production deployment ran.
The initial security-review result above belongs to the initial implementation, not a
new claim that the expanded code received an additional security audit.

## Realism, sound, steering, graphics and armed demo

- [x] Vendor Yuka 0.7.8 and steer the crowd with seek + separation over the flow fields.
- [x] Replace pulse combat with police lines, pressure, morale and non-lethal tools.
- [x] Add temperaments, medics, the clock and curfew, three roles and four outcomes.
- [x] Re-lay the route: stands, racks, Crypt, Statuary Hall, corridor, barricaded doors.
- [x] Add distant crowd, dress, phones, breath, litter, time-of-day light, closing shot.
- [x] Add synthesized layered sound on the shared audio bus.
- [x] Add the frame-time graphics governor and the Auto/Low/High choice.
- [x] Add the armed demo variant with on-screen "did not happen" labeling.
- [x] Scale to 128 protestors, 64 police and 64 sheltering staff and members; start on the grass.
- [x] Rewrite the focused tests (27) and update README, SPEC, capability map and PRD.

## UI/UX Optimization pass (2026-11-10)

- [x] Guard critical routes with localized `ErrorBoundary` and in-panel scenario retry controls.
- [x] Replace dense intro `<details>` blocks with structured `RadzenTabs` (Briefing, Field Controls, Historical Record).
- [x] Implement dynamic `RadzenProgressBar` components for Stamina and Police Line integrity with color-grading thresholds.
- [x] Consolidate fragmented options into a slide-out drawer (Mode, Graphics tier, Role switching).
- [x] Add interactive lower-left debug button & diagnostic telemetry panel (FPS, Draw Calls, Crowd Roster, Memory/GC).
- [x] Pin subtle non-intrusive `v261110` build version stamp to the bottom-right viewport corner.
- [x] Eliminate Cumulative Layout Shift (CLS) by pre-allocating HUD grid dimensions.
- [x] Refactor mobile touch controls with iOS safe-area margins (`env(safe-area-inset-bottom)`) and zero viewport overflow.
- [x] Validate end-to-end CRUD across player names, local result recording, and graphics preferences.
- [x] Deliver before/after HTML mockup (`SCREENSHOTS/261110-ui-optimize.html`) and annotated PNG (`SCREENSHOTS/261110-ui-optimize.png`).
- [x] Verify host/client builds with zero warnings, pass all 65 css-lint checks, and confirm restarted health on port 5080.

