# PoMarbleRace play-test punch list (2026-11-05)

Driven end to end with Playwright (Chromium, SwiftShader software GL) against the local host on
http://localhost:5080. The script covered every map solo (intro → track card → start → tutorial →
race → forced miss → result sheet → Race again), the Race settings drawer, F3, demo, and online
by private code (create → join → race → result → Rematch handshake → next race → a third player
turned away). Map health ran headless in node (`tests/pomarblerace-map-health.test.mjs`).

## Results

| Flow | Result |
|---|---|
| Solo, maps 1–5: intro, track pick, start, race, result sheet, Race again | Pass |
| First-race tutorial shown once and dismissed | Pass |
| F3 performance overlay | Pass |
| Race settings drawer (gear) mid-race | Pass with rendering stubbed; see P3 below |
| Demo race | Pass |
| Online private code: create, join, both race, Rematch, next race | Pass |
| Online: third player joining a full race is refused (2 players max) | Pass |
| Map health, 5 courses × (field comes home, no tunnelling at the speed cap) | 10/10 pass, 408 s locally |
| Unit tier (marble scenarios), test ceilings, build (0 warnings), `dotnet format`, CSS lint | Pass |

## Open items, by severity

| # | Severity | Item | Repro | Notes |
|---|---|---|---|---|
| 1 | P2 | Grand Spiral loses marbles over the sides of the open Catch lane and LowerA | `node scripts/pomarblerace/harness.mjs race 3 1` → 76 finished / 17 lost / 8 stalled | Was 46 / 32 / 23 at HEAD. Course geometry, not holes: the floor exists under every fall. CI bounds are set at today's figures (22 lost, 12 stalled). |
| 2 | P2 | Spiral Works loses marbles at the Merge → Penalty drop and LowerA's mouth | `harness.mjs race 2 1` → 95 / 6 / 0 | Was 85 / 5 / 11. A landing apron was tried and made no difference. |
| 3 | P2 | E2EUI `MarbleRaceMapCertificationTests` (zero-loss) still fails on maps 2 and 3 | `dotnet test tests/PoMiniGames.E2EUI --filter MarbleRaceMapCertification` | Also fails on the untouched HEAD (verified on a detached worktree). Closes when 1 and 2 are fixed. |
| 4 | P3 | At very low frame rates (0.3 fps under SwiftShader) the settings gear does not open the drawer mid-race | Open a race in headless Chromium with software GL, click the gear | Opens normally with rendering stubbed, so it is main-thread starvation, not the page. Watch for it on weak devices. |
| 5 | P3 | M mutes without saving the setting; only the drawer saves it | Press M, reload | Small follow-up. |
| 6 | P3 | The tutorial ring points at the marble's projected screen position even when a wall hides it | First race on an authored course | Cosmetic. |
| 7 | P3 | Reverb zones are placed by `track.length`, which can differ slightly from the baked arclength | Playground Run covered spans | Zones may start or end a little early or late. |
| 8 | Info | A forced finish submits an impossible record time and the server answers 400 | Test-only (forced `_resolve`) | Correct behaviour: the server refuses implausible times. |
| 9 | Info | Reflections (SSR) on Neon Canyon (measured on Neon Chute before the merge) / rain cost about 40% more triangles and ~63 draw calls | F3 on Neon Canyon, Full effects | Heavy tier + Full only; Lite turns it off. Not measured on a real GPU yet. |

## Update: spiral containment (later on 2026-11-05)

Items 1 and 2 are fixed: Spiral Works and Grand Spiral now lose 0 marbles (drop bridges, landing hoppers, aprons behind landing lanes, Lower A unlidded). New open item: Spiral Works parks 6 marbles still in its Catch pan (s≈1951) until the timeout.

## Verification follow-up (2026-11-08)

| Previous item | Current status | Evidence |
|---|---|---|
| 1. Grand Spiral losses and stalls | Fixed | The all-map health suite passes, including Grand Spiral's completion and tunnel checks. |
| 2. Spiral Works stalls | Fixed | The all-map health suite passes, including Spiral Works' completion and tunnel checks. Its elevated recovery nudge is scoped to this course so it does not regress Grand Spiral. |
| 3. Zero-loss E2EUI certification | Race behavior fixed; UI certification blocked | Seed 1 now completes 101/101 with no losses or stalls on both authored spirals. The targeted E2EUI run stops during fixture setup with `DockerUnavailableException`; no UI assertions run. |
| 5. M mute preference not saved | Fixed | Pressing M sets the persisted `prefs.muted` value, which remained set after a page reload. |

The current map-health run passes all 8 checks. The remaining P3 observations are the settings drawer under severe main-thread starvation, the tutorial ring's projected position when a wall occludes the marble, and small possible reverb-zone alignment offsets. Forced-finish rejection is expected server validation; the SSR/rain rendering cost remains a performance note rather than a functional defect.
