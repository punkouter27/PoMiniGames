# PoMiniGames

Instant-play mini-games platform: a .NET 10 Minimal API host that also serves its
Blazor WebAssembly client from a single origin (port 5080), with SignalR for real-time
multiplayer and Azure Table Storage for persistence. There are no AI services; the two
quizzes draw from JSON question banks.

## Overview

Fourteen small games on one website. The browser runs each game in full, including its
computer opponents; the server signs players in, referees online play, checks and stores
scores.

- **One origin.** The API host serves the Blazor client it is then called by, so there is no
  cross-site setup in production.
- **Each game is a Razor page plus a JavaScript engine** (`wwwroot/js/<game>/`), loaded on
  demand and wired together with JS interop callbacks.
- **Online play runs over 15 SignalR hubs.** Match, lobby and race state is held in server
  memory and is lost on restart.
- **PoBrawl's online 1v1 uses rollback netcode.** Both browsers and the server run the same
  integer, 60 Hz fight sim, written twice to give bit-identical results
  (`Shared/Games/PoBrawlRollbackSim.cs` and `wwwroot/js/pobrawl/rollbackSim.js`). Your own
  keys apply at once, two frames ahead; the opponent is predicted and the fight is
  re-simulated when their real input arrives. The match hub relays frame-stamped inputs
  (`matchInput`, echoed to everyone with the frame the server applied them on) and answers
  `Ping` for clock sync. Snapshots (`matchState`, the full sim state plus a checksum) go out
  at 10 Hz. The server decides which frame each input lands on and is the only source of the
  result. Corrections are presented, not hidden: a rollback that moves a fighter plays a
  2–3 frame chromatic smear, an unconfirmed swing trails a faint ghost, and a signal meter
  beside the corner pill shows the round trip and rollbacks per second.
- **Haptics are one platform layer.** `wwwroot/js/impactBus.js` gates every controller rumble
  and phone vibration in the app: the Haptics setting (`pomini_haptics`, on by default), reduced
  haptics under reduced motion, and rate and duty caps so nothing holds a motor on. PoBrawl
  routes rumble to the local human only (`js/pobrawl/haptics.js`): a rising pulse while a strike
  charges, a tick on a perfect guard, thumps scaled by the hit, a long KO thud.
- **Sound is one mix.** `wwwroot/js/audioBus.js` owns the single AudioContext: master volume
  (`pomini_volume`), an Effects level (`pomini_sfx_volume`, default 100) and a Music level
  (`pomini_music_volume`, default 0, so music is opt-in). Every sound is synthesized
  (`dsp.js` + `gameCues.js`), with no audio files. `musicLayers.js` adds adaptive layers that build
  with PoRacer's laps and PoBrawl's round clock. Shared camera-shake presets live in
  `feelPresets.js` (`window.PoFeel`), and particle bursts in `gpuFx.js`
  (`PoFx.burst(x, y, 'win' | 'ko' | 'highscore')`).
- **No database.** Scores, ratings, saves and AI spend ledgers live in Azure Table Storage;
  PoEcosystem world files live in Blob Storage. A player is whoever the sign-in token says
  they are; there is no Player table.
- **Computer opponents are hand-written rules, not trained models.** Difficulty is a table of
  numbers in source.
- **No AI services.** PoFunQuiz and PoCoupleQuiz pick random questions from JSON banks
  (`Features/PoFunQuiz/Data/questions.json`, `Features/PoCoupleQuiz/Data/questions.json`)
  loaded into memory once at startup; PoCoupleQuiz matches answers with free fuzzy matching
  (`AnswerMatcher`). PoJevArena's battle calls come from a free local rules brain. Ecosystem,
  Brawl and Cabinet commentary is scripted.
- **Around the games.** The hub is the game cards plus *Watch all demos* (the Today card,
  streak, Continue strip, pins and filters were cut on 2026-10-19), and it launches games
  without rebooting the app. Leaderboards have all-time and weekly boards. The profile shows
  achievements. PoRacer and PoMarbleRace race your best-run ghost. Gamepads work in every game
  and on the hub. The game-over sheet can share a result card. Settings is a side drawer.
- **Works offline.** A score that cannot reach the server is parked in the browser and sent
  automatically later.

### Documentation

| Document | What it covers |
|---|---|
| [Architecture & game loop](DOCS/20261003/architecture_overview.md) | How agents look, decide and act; scoring rules; tuning settings |
| [Agent & rig inventory](DOCS/20261003/model_summary.md) | Every computer-controlled character, its source file and physics setup |
| [Creature dashboard](DOCS/20261003/creatures_dashboard.html) | Abilities grid with an Executive / Technical toggle |
| [Level & arena setup](DOCS/20261003/scene_layout.html) | To-scale arena drawings, spawn points, hazards, collision layers |
| [Performance comparison](DOCS/20261003/creature_benchmarks.html) | Skill by difficulty, smoothness, update rates and running cost |
| [Training charts guide](DOCS/20261003/training_metrics_guide.md) | The four training charts in plain English, and what stands in for them here |
| [Architecture map](https://claude.ai/artifact/HGHLwMdGyveqtknNC1o5ar) | Component diagrams, request flows and the data model (private link; share it from the page to give others access) |

## Games (`src/PoMiniGames.Client/Games/`)

| Game | One-liner |
|---|---|
| TicTacToe | 4-in-a-row on 6×6 vs AI, hot-seat, or online quick-match (SignalR) |
| ConnectFive | Five-in-a-row vs AI, hot-seat, or online quick-match (SignalR) |
| PoBrawl | Physics brawler with a presidents ladder, an 8-fighter CPU tournament, the **Brawl Cup**, as its Demo mode (`/pobrawl/demo`; the old `/pobrawl/tournament` redirects there; random draw, Elo after every bout; golden-hour → dusk → night arena, an Elo-upset crowd, an animated bracket and a belt ceremony; a TV-style director camera with a picture-in-picture iso cam in the Cup; 1P/2P/online keep a plain side view); 1P, 2P and training pause on Esc / P, on the touch ⏸ button and automatically when the window loses focus (Resume, Restart fight, Quit), and the result leads with Fight again / Rematch in place; a showtime layer of charge auras and president motifs over a crowd that stomps and chants, plus — with the settings sheet's **Brawl show** set to Full (`pobrawl_show`; Simple is the default) — convention balloon drops, LED ribbon boards, a stadium wave, an instant replay, a glass result screen, the belt ceremony and the director camera (those four Full-only modules are loaded on demand, so Simple never parses them); live 3D fighter select (a mirror pick gives Player 2 an alternate suit); an election-night campaign map for the ladder + fighter Elo demo board; **Brawl HQ** (`/pobrawl/hq`) puts the ladder, campaign map, local record, the ladder / fastest-KO / fighter-Elo boards and Cup titles on one page |
| PoCoupleQuiz | Two-player realtime couples quiz (SignalR); curated JSON question bank, free answer matching |
| PoFunQuiz | Multiplayer trivia lobby from a JSON question bank |
| PoMarbleRace | Physics marble race on baked GLB tracks; online 2-player via host-streamed physics |
| PoRacer | Canvas racer with WebGL effects, solo races, and a multiplayer lobby |
| PoCabinet | 3D circuit racer: solo career across four tracks, plus Senate Hill and a seeded daily circuit (a new layout every UTC day, the same for everyone, with its own board), AI officials, and a server-simulated online lobby; tracks have hills and banking, pinch points and wide braking zones, a bus-stop chicane with raised kerbs, gravel traps and tarmac run-off, grip patches (resurfaced, dusty, bumpy, puddles in the rain), a racing line that rubbers in over the race (and dries first in the rain), split sections with a shorter joker lane, braking boards and corner numbers; track limits are enforced (all four wheels off and the lap does not count, here and on the server); a 100-car field where every driver has its own personality (bruisers, late brakers, wild cards…) and runs off the road now and then; damage is real: hits dent the body where they land, knock bumpers, wings and mirrors loose and off, break lamps and glass, and cost the car power, grip and alignment until it is wrecked and out; hills and banking are real physics (cars run faster downhill, slower uphill, banked turns hold them in, hard braking mid-corner washes wide); the demo is covered like a TV race: a director cuts to the closest battles, with a timing tower, callouts (lead changes, passes, fastest laps, wrecks, the flag), a caption for the car on screen and a rear-cam / onboard picture-in-picture; graphics on medium/high add ambient occlusion, wet-road and puddle reflections with raindrop ripples, a heat mirage, exhaust haze, per-object motion blur, 32k lit GPU smoke and fire that cars part, rigid-body crash debris (bumpers, wheels, shards), cars that get dirty, wet and scarred, and a felt slipstream (a heat shimmer between the cars and a tow arc on the gauge); sound adds an adaptive synthesized score (settings: **Music**), reverb zones (grandstand, gantry, open country) and gravel/sand/wet tyre sounds |
| PoVoxelStrike | Third-person survival shooter with fully destructible voxel structures |
| PoJevArena | Design creatures, draft 10 v 10, and watch the arena brain (free local rules, or TypeSafe's Jev when picked in Settings) make every tactical call; post-match Black Box scrubber |
| PoMule | Eight-player M.U.L.E.: claim land, work M.U.L.E.s and trade on a walking-floor market for twelve months vs seven AI personalities; all-AI demo |
| PoEcosystem | Watch-only island simulation: species, tribes and chronicle cards for landmark events; cloud save slots and a shared gallery |
| SandPlayground | GPU sand-and-water sandbox |

## Quick start

```powershell
# prerequisites: .NET SDK 10.0.100 or a later feature band (global.json), Docker
docker compose up -d azurite                                  # local table storage
dotnet run --project src/PoMiniGames.API/PoMiniGames.API.csproj
# → http://localhost:5080  (API + client, one origin)

pwsh scripts/test-all.ps1                                     # full test suite
```

## Layout

```
src/
├── PoMiniGames.API/            Host + vertical feature slices (Features/<Slice>)
├── PoMiniGames.Client/         Blazor WASM client (assembly: PoMiniGamesClient)
├── PoMiniGames.Infrastructure/ Table Storage, HighScoreDescriptor<T> leaderboards (all-time + weekly, ?period=week)
├── PoMiniGames.Domain/         Domain primitives (EloCalculator, GameKey, ...)
└── PoMiniGames.Shared/         DTOs shared between client and server
tests/
├── PoMiniGames.Unit/           ≤100 tests (hermetic)
├── PoMiniGames.Integration/    ≤50 tests (Testcontainers Azurite)
├── PoMiniGames.E2EAPI/         ≤25 tests (HTTP contract)
├── PoMiniGames.E2EUI/          ≤25 tests (Playwright)
└── Shared/                     TestBudgetGuard (no test ever spends AI tokens)
infra/                          Bicep (azd); deployed by .github/workflows/deploy.yml
scripts/                        Working scripts only — see scripts/README.md
```

## Notes

- Auth: Microsoft Entra sign-in in the browser (MSAL), sent to the API as a bearer token.
  Guest login exists only in Development/Test and only from loopback. The whole app sits
  behind the sign-in gate; leaderboard reads are anonymous at the API, and all game-data
  writes require auth + antiforgery.
- UI is native Blazor + plain CSS for thirteen of the games. PoMule was the first screen built
  on Radzen (Material Dark), and Brawl HQ (`/pobrawl/hq`) is the second; the hub, settings,
  leaderboards and the other games move to Radzen next. Until then each of those pages loads
  the Radzen stylesheet itself and removes it on the way out (`wwwroot/js/radzenTheme.js`,
  sharing PoMule's element id). In-game HUDs stay custom CSS.
- **Each game is a Razor page plus a JavaScript engine, except PoMule**, whose rules are C# in
  `PoMiniGames.Shared/Games/PoMule` (unit-tested, seeded, deterministic) with JavaScript only
  drawing and moving the avatars. The server replays a submitted match from its seed and
  action log (`PoMuleRunVerifier`). See `SPEC.md` and `CAPABILITY-MAP.md`.
- **Two three.js versions.** PoEcosystem renders with three r186 `WebGPURenderer` and node
  materials (TSL), imported as `three-eco/webgpu` / `three-eco/tsl` / `three-eco/addons/`; it
  falls back to three's WebGL2 backend by itself, and `?ecoBackend=webgl2` forces that. Every
  other three.js game stays on r165 (`three`, `three/addons/`). Both are pinned, with SRI, in the
  import map in `wwwroot/index.html`. See section 3.9 of the
  [architecture overview](DOCS/20261003/architecture_overview.md).
- Offline-friendly PWA: finished scores park locally and sync on reconnect/sign-in.
- Deploy: `azd up` (App Service F1, resource group `PoMiniGames`).

PoRacer ranks **best completed laps**, separately from final race times. Its legacy JSON
field and Azure Table column `totalTimeSeconds` / `TotalTimeSeconds` retain their names
for stored-score compatibility; existing rows are preserved without inferred conversion.
Solo races have 99 AI rivals and spectator demos have 100 AI cars; online rooms remain
capped at 8 cars. The minimap is removed. Add `?perf=1` to a PoRacer URL and inspect
`window.PoRacer.getPerformanceProfile()` for frame rates and render-stage timings.
Track bitmaps respect the canvas pixel budget, including backing-store ratios below 1,
without rebuilding on every frame.
Join/rejoin snapshot numbers use Blazor's direct byte-array interop transfer rather than
JSON-formatting 1,400 floating-point values on the browser's WASM main thread.
Streaming snapshots retain the existing SignalR wire format but are decoded in native
JavaScript; only the four visible standings rows return to Blazor. All cars still feed
interpolation, rendering, and audio, and the HUD's field size comes from the complete roster.
Run `node --test tests\poracer-snapshot.test.mjs` for focused native snapshot coverage.
Run `pwsh scripts/test-ceilings.ps1` to check all four test-method budgets without Docker.
Run `node --test tests/pomule-world.test.mjs tests/pomule-physics.test.mjs` for PoMule's renderer maths.
CI validates Bicep and deploys application code; use `azd up` for resource provisioning.

## Configuration and endpoint changes (2026-10-17)

| Key | Meaning |
|---|---|
| (AI keys removed) | `PoFunQuiz:QuestionSource/AllowFreshAi/OpenTriviaDb`, `PoCoupleQuiz:Features:*AI*`, `PoMiniGames:AI:*`, `PoMiniGames:Jev:Brain` and `PoMiniGames:Diag:AiUsageAdmins` no longer exist; the quizzes read their JSON banks and Jev uses the local brain only |
| `PoMiniGames:PoBrawl:Dossier:FetchWikipedia`, `CacheHours` | Fighter dossiers: enrich the static facts from the free Wikimedia REST API (default `true`), cached 24 h; off or failing, static facts are served. Tests pin it to `false` |

| Endpoint | Change |
|---|---|
| `GET /api/diag/ai` | Removed with all AI services |
| `GET /api/logs/tail` | Development only: not mapped in any other environment (2026-10-29) |
| `GET /api/health/ai` | Removed (moved to `/api/diag/ai`) |
| `/api/joker/*` | Removed with the Joker game |
| `GET /api/ecosystem/culture/{seed}` and the ecosystem chronicle, thought, treaty and lore routes | Removed; PoEcosystem calls no AI |
| `GET /api/pocabinet/banter`, `POST /api/pocabinet/debrief` | Removed; Cabinet's radio lines are scripted in the browser |
| `POST /api/pobrawl/presser`, `POST /api/pobrawl/intro` | Removed; Brawl's press lines are scripted |
| `GET /api/leaderboards` and `/api/leaderboards/{game}` | New `period=week` query for this ISO week's boards |
| `GET /api/pobrawl/dossier` | New, anonymous: every Brawl fighter's dossier (number, term, party, fighting style, Wikipedia summary, portrait, article link) in one call |
| `/pobrawl/hq` (client route) | New (2026-10-18): Brawl HQ, one page over the existing reads (`GET /api/pobrawl/progress`, `/api/leaderboards/pobrawl`, `pobrawlko`, `pobrawldemo`) and this browser's ladder and Cup titles. No new endpoint |
| Start and end cards (client UI) | 2026-10-29: every start card (`GameIntro`) has one button, **OK**, and fits without scrolling on a laptop and a phone: header, controls (longer rules behind a How to play tab), the game's setup (beside the controls on a wide card), footer. Every end card (`GameOverModal`) has one button, **Back to main menu**: Share, Full leaderboard, Play again and each game's own next steps (Fight again, Rematch, Race again, Next stage, Watch replay, Save the KO clip, Save collapse clip, Replay this arena, Copy link, Review the match, Brawl HQ) are gone, with `shareCard.js` and both clip recorders |
| `GET /api/pocabinet/lobby` | Removed (2026-10-19, same day it came): the start card no longer shows who is online |
| `/pocabinet` (client UI) | 2026-10-19: the start card is how to play plus, in 1P, the track list (your best lap and campaign stage per track); paint and settings live in one drawer opened from the pause card and the lobby; the race fills the screen under the app bar (lap readout on the view); pause shows the race so far and adds Restart; results add the per-lap sector table, "Same track again" and "Next stage". |
| `GET /api/pocabinet/scores` | Removed (2026-10-19): nothing read it, the app has no Cabinet board. `POST` stays; the stored place is now the worse of the claim and the server replay's (solo) or the server sim's (online) |
| `/pocabinet` settings (`pocabinet.settings.v1`) | 2026-10-19: Blazor owns the store (`PoCabinetUiSettings`); weather is Clear or Rain (the Live D.C. weather and its open-meteo call are gone, a stored `auto` reads as clear); steering assist defaults to Light |
| `/pocabinet` (client UI, review fixes) | 2026-10-19 (later): a wreck is a **DNF**, classified behind every running car here, in the lap verifier and online (no stage credit, a DNF results card, the debrief names it); results use the modal's own buttons (Race again or Back to lobby, Next stage, Back to all games, Share) with Watch replay beside the telemetry; the result card image and its "Card or clip" menu are gone (the clip stays in the replay); the drawer also opens from the start card; paint is four colours (the patterns never reached the car; a stored `livery|color` keeps its colour); the racing-line overlay is gone (`racingLine` in the settings store is ignored); weather changed mid-race applies to the next race, online races are always dry; the demo cannot be paused, writes no personal records and runs to the flag when its autopilot wrecks; every race after the first is audible again; a hidden tab pauses a solo race and mutes the game; the race view measures the app bar (no page scroll on phones) and hides it on a phone held sideways |
| `POST /api/pobrawl/ladder` | 2026-10-19: rows keyed by the caller's account (not the display name; older name-keyed rows are no longer ranked), one rung beyond the stored row per post (a bigger claim is credited one rung), climbs at least 7 s apart (`429 ladder_too_fast`), client Elo clamped to 100..3000, `503` when storage is down. The 201 body is the stored row |
| `POST /api/pobrawl/highscores` (fastest KO) and `GET /api/leaderboards/pobrawlko` | 2026-10-19: KO floor raised from 0.5 s to 1.5 s (the sim's fastest real KO is about 1.7 s); one row per player, faster-only; the board ranks each player's best over every row |
| `POST /api/pobrawl/elo` (Cup bout Elo) | 2026-10-19: own `pobrawl-elo` rate-limit policy (20/min); per identity one bout every 3 s and 40 a UTC day (`429 demo_too_fast` / `demo_daily_cap`); both ids must be roster fighters and differ |
| `POST /api/pobrawl/matches` (online result) | 2026-10-19: answers `503` + `Retry-After: 5` when the Elo write fails (the claim is released; retry within 90 s); an abandoned match records nothing; the self-match check runs before any write |
| `/pobrawl/lobby-hub`, `/pobrawl/match-hub` (SignalR) | 2026-10-19: one seat per user (a second tab takes over the seat), a seat idle 2 minutes gives way to a newcomer, `gameStarted` and the match code go to the two seated players only; the match waits for both corners before the countdown; `RequestRematch` / `VoteRematch` removed; inputs capped per corner |
| `GET /api/pobrawl/dossier` | 2026-10-19: answers within 4 s (static facts when Wikipedia is slow, enriched in the background; one 4 s Wikimedia attempt) |
| `/pocabinet/lobby-hub`, `/pocabinet/race-hub` (SignalR) | 2026-10-19: every race gets its own 8-hex code (`RaceStarting(code, trackId)`, lobby `Code`), so a results screen never picks up the next race; new lobby method `Kick(seatId)` (host, between races) and events `Kicked(reason)`, `LobbyNotice(text)`; a rematch seat not ready 90 s after the lobby reopens is freed. Race hub: `JoinRace` returns null (not an error) when the race is over, new `LeaveRace()` (forfeit: the car coasts, later joins spectate), new event `RaceAborted(code)` when three ticks in a row fail; a car with no input for 0.5 s coasts; a race every human left is called |
| `POST /api/pocabinet/scores` | 2026-10-19: `GameCode` at most 32 letters, digits, `-` or `_`; input log length checked before decoding; the play-session preflight runs before a replay; at most two replays at once (`503` + `Retry-After: 5` after a 2 s wait); an online lap is spent only after the score is stored, so a retried `503` still verifies |
| `/pobrawl/match-hub` (SignalR) | Rollback protocol: `SubmitInput` takes `{ frame, held, press, sequence }`; new `matchInput` event (each accepted input with the frame the server used) and `Ping` method (clock sync); `matchState` now carries `frame`, `sim` (26 packed ints) and `checksum` in place of the per-tick swing fields |

PoBrawl's fighter dossiers quote summaries and portraits from [Wikipedia](https://en.wikipedia.org/)
(text CC BY-SA 4.0); each card links its article with a "From Wikipedia" attribution.
