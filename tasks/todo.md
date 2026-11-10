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

## Verification evidence

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
