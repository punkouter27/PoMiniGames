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
- **Lobby recovery is visible.** Shared lobbies automatically rejoin after SignalR reconnects
  when the game supports it, report a failed rejoin, and offer a manual retry after reconnect
  attempts are exhausted.
- **PoBrawl's 1P ladder and 2P local are best of three.** First to two rounds (60 seconds
  each; a bell too close to call is nobody's round), with round pips under the clock. The Cup,
  online and the training room stay one round. A hard enough beating in a short space is a
  **knockdown**: the fighter cannot be hit on the canvas and picks a get-up (plain, a roll,
  rising into the guard, or a wake-up strike). Taps punch left-right-left (jab, cross); a coil
  is the right hand. Body damage costs each region something different: head = stunned longer
  and down sooner, torso = slower energy regen, arms = weaker strikes and a guard that leaks,
  legs = slower on the feet and off the canvas. The rules are pure modules
  (`js/pobrawl/energy.js`, `knockdown.js`, `rounds.js`, `combat.js`; the per-fighter state
  machine is `fighterTick.js`), tested headless by `tests/pobrawl-core.test.mjs`, which CI runs.
  The fastest-KO board takes a round-one knockout only. Online has the knockdown and both hands
  too, in the rollback sim's own integer terms (daze, down / rising / rolling, jab and cross), so
  the packed state is 38 ints (16 a corner), not 26.
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
  (`AnswerMatcher`). Ecosystem, Brawl and Cabinet commentary is scripted.
- **Around the games.** The hub is the game cards plus *Watch all demos* (the Today card,
  streak, Continue strip, pins and filters were cut on 2026-10-19), and it launches games
  without rebooting the app. Leaderboards have all-time and weekly boards. The profile shows
  achievements. PoRacer and PoMarbleRace race your best-run ghost. Gamepads work in every game
  and on the hub. The game-over sheet can share a result card. Settings is a side drawer.
  Each demo in the reel gets a 60-second slot, including games whose match ends early.
  Reel controls fit narrow phones, and Ecosystem skips its interactive onboarding in the
  reel. Mule reserves room for the controls and uses readable player cards in portrait.
  Voxel Strike's automatic graphics budget responds to sustained frame times rather than
  assuming a fast GPU from CPU core count; explicit graphics choices remain authoritative.
  Its collision narrowphase searches terrain within each chunk's actual footprint and
  rejects disjoint convex bounds before expensive contact tests, preserving the existing
  contact solver, masses, debris limits, and 60 Hz timestep.
  Box collision tests discard duplicate opposite edge directions and compute exact
  projection intervals directly; sparse collision bookkeeping avoids clearing a dense
  matrix for hundreds of mostly static bodies.
  Chunk remeshing caches voxel samples across all six face sweeps without changing
  geometry, damage tinting, or collision accuracy.
  The `/health` status page includes the build date for support and diagnostics.
- **Works offline.** A score that cannot reach the server is parked in the browser and sent
  automatically later.

### Shared game UI

- `GameShell` owns the title, Settings entry point, diagnostics and result dialog.
  Keep game artwork and HUDs game-specific, but do not override the shared dialogs'
  theme, typography or geometry.
- `GameIntro` owns modal focus containment, readiness, controls, setup and the one OK
  action. Essential choices stay visible; longer explanations and customization belong
  in disclosures. Its body can scroll on unusually small screens while the action stays
  visible. Escape cancels the intro rather than silently starting play.
  Choose 1P, 2P, Online or Demo on the main menu; intro modals do not repeat mode selection.
- During gameplay, **Tab toggles stats**, and **Esc closes them**. Shift+Tab, forms and
  dialogs retain normal focus navigation. The visible Stats control supports touch.
  Ecosystem retains its observation dashboard and does not open a second generic panel. Marble's physics/render metrics join the shared
  stats panel instead of using a separate F3 overlay.
- Results keep headline facts compact, with full standings/telemetry behind details.
  Replay/rematch actions belong in the shared footer rather than the summary.
  Demos and multi-race runs retain their existing progression.
- Pause dialogs share focus handling and presentation; online menus explicitly say
  when the match keeps running. Global preferences remain in Settings.
- Input regression checks: `node --test tests/game-debug.test.mjs`. The existing
  `LinkAuditUiTests` covers reachable routes and intro layout.

### Documentation

| Document | What it covers |
|---|---|
| [Game consistency rules](GAME-CONSISTENCY.md) | Required game workflow, shared UI, controls, accessibility, and verification conventions |
| [Documentation overview](DOCS/20261112/index.html) | Index of the current documentation suite |
| [Visual architecture dashboard](DOCS/20261112/VISUAL_ARCHITECTURE_DASHBOARD.html) | Visual map of the app's architecture and major flows |
| [User journeys](DOCS/20261112/USER_WORKFLOW.html) | Player-facing workflows through the app |
| [Auth and security report](DOCS/20261112/AUTH_SECURITY_REPORT.html) | Authentication and access-control overview |
| [AI and external services report](DOCS/20261112/AI_SERVICES_REPORT.html) | Current AI and external-service boundaries |
| [Interactive tabbed shell](DOCS/20261112/artifact.html) | All five reports in one standalone tabbed frame |
| [Architecture map](https://claude.ai/artifact/HGHLwMdGyveqtknNC1o5ar) | Component diagrams, request flows and the data model (private link; share it from the page to give others access) |

## Games (`src/PoMiniGames.Client/Games/`)

| Game | One-liner |
|---|---|
| PoCapitol | Third-person alternate-history crowd simulation. `/pocapitol/1player`: join a crowd of 512 that starts out on the grass (mostly bystanders, a minority pushing), hold a police line, or observe; 64 police in five lines with shields, batons, spray, gas, flash-bangs and a few concussion grenades fall back in stages across grounds, Crypt, Rotunda and Statuary Hall to barricaded House chamber doors, on a 12:50 pm to 6:00 pm clock, while 64 staff and members shelter inside and are evacuated (nothing can harm them). As the solo raider you carry a machine gun, five concussion grenades and two smoke grenades (**Space**/**Click** fire, **G** throw, **H** smoke; on touch, FIRE and two grenade buttons that show what is left; on a gamepad, right trigger, X and Y); about one person in three breaks off into a room once inside, and one in twenty carries a historically sourced, one-to-six-word sign. `/pocapitol/demo` is an armed, entirely fictional variant in which both sides fire and those hit drop out; the first seven seconds are calm, then the police open fire, the crowd scatters and returns fire, protestor rounds can hit other protestors, and the camera alternates a high crane, a close orbit around the crowd and a shot from behind the police line. It loops and saves nothing. Blasts are overpressure: people are thrown into the air and knocked down, never dismembered. Synthesized sound, Yuka crowd steering (vendored, MIT), adaptive graphics with Auto/Low/High. Adult themes, no injury shown; invented layout, not a documentary or real access plan. [Product requirements](DOCS/20261109/PoCapitol-PRD.md). |
| TicTacToe | 4-in-a-row on 6×6 vs AI, hot-seat, or online quick-match (SignalR) |
| ConnectFive | Five-in-a-row vs AI, hot-seat, or online quick-match (SignalR) |
| PoBrawl | Physics brawler with a presidents ladder and two CPU exhibitions on the home hub: **DEMO · Tournament** (the 16-slot Brawl Cup at `/pobrawl/demo`; all presidents enter, every bout advances automatically to one champion, and each bout updates fighter Elo) and **DEMO · FFA** (`/pobrawl/ffa`; all 16 presidents fight in the ring at once, rear attacks bypass guards, knockout places are shown, and a new round starts after five seconds; this exhibition does not submit 1v1 Elo results); the Cup has an animated bracket and belt ceremony, golden-hour → dusk → night arena, an Elo-upset crowd, and a TV-style director camera with picture-in-picture iso cam; 1P/2P/online keep a plain side view; the old `/pobrawl/tournament` address redirects to the Cup; 1P, 2P and training pause on Esc / P, on the touch ⏸ button and automatically when the window loses focus (Resume, Restart fight, Quit), and the result leads with Fight again / Rematch in place; a showtime layer of charge auras and president motifs over a crowd that stomps and chants, plus — with the settings sheet's **Brawl show** set to Full (`pobrawl_show`; Simple is the default) — convention balloon drops, LED ribbon boards, a stadium wave, an instant replay, a glass result screen, the belt ceremony and the director camera (those four Full-only modules are loaded on demand, so Simple never parses them); live 3D fighter select (a mirror pick gives Player 2 an alternate suit); an election-night campaign map for the ladder + fighter Elo board; **Brawl HQ** (`/pobrawl/hq`) puts the ladder, campaign map, local record, the ladder / fastest-KO / fighter-Elo boards and Cup titles on one page |
| PoCoupleQuiz | Two-player realtime couples quiz (SignalR); curated JSON question bank, free answer matching |
| PoFunQuiz | Multiplayer trivia lobby from a JSON question bank (~7,800 questions; most from [The Trivia API](https://the-trivia-api.com), CC BY-NC 4.0) |
| PoMarbleRace | You steer the one red marble through a 101-marble field on four courses (Neon Canyon, Spiral Works, Grand Spiral, Playground Run); CPU rivals each have a personality (steady, cautious, line-hugger, bully, wildcard); your best run is a ghost; sector splits and per-track records; online is 2 players max, by quick match or a private 4-letter race code, with a both-must-agree **Rematch** and a running series score (the host's browser streams the physics); a **Race settings** drawer (ghost, sound, spoken announcer, F3 performance overlay, Full/Lite effects); keyboard, touch and gamepad steering; sound is fully synthesized (energy- and material-driven impacts, a skid hiss, per-map reverb, crowd stings). Engine modules live in `wwwroot/js/pomarblerace/` (game.js plus one mixin per system; constants in `tuning.js`, the save in `store.js`) |
| PoRacer | Top-down canvas racer the server simulates: four tracks (Grand Prix Circuit, Neon Skyline, Desert Dustway and Crossfire Switchbacks, seven tight turns with a main straight that crosses all four of its legs), solo races against 99 rivals or a time trial, an 8-seat online room and a demo. Each track has its own weather for the UTC day (clear, rain, snow or fog): rain and snow lower every car's grip, and the start card and a HUD chip say so. Rivals drive in character (apex hugger, draft hunter, bruiser, late braker, cautious, slingshot, wildcard); the results list each one's style. Trackside scenery (grandstands, tyre walls, cones, trees, tents, rocks) is Kenney's Racing Pack, CC0 (`wwwroot/img/poracer/`) |
| PoCabinet | 3D circuit racer: solo career across four tracks, plus Senate Hill, Bedroom Floor GP (a toy-car track laid in a scanned bedroom: `wwwroot/models/bedroom.glb`, built by `scripts/blender/pocabinet-bedroom.py` in headless Blender, on stilts ~2 ft up, threading round the desks and drum kit, the room drawn as a Gaussian splat (`wwwroot/models/bedroom.ksplat`, registered onto the mesh by `scripts/blender/pocabinet-bedroom-splat.py`; the mesh is the collision model and the low-tier fallback)), Center Court (a toy-car circuit on the floor of a scanned outdoor basketball court, round the centre circle and both keys, the court drawn as a Gaussian splat; `wwwroot/models/court.glb` and `court.ksplat`, built by `scripts/blender/pocabinet-court.py` and `pocabinet-court-splat.py`) and a seeded daily circuit (a new layout every UTC day, the same for everyone, with its own board), AI officials, a best-lap leaderboard per track, and a server-simulated online lobby (8 drivers on a grid of up to 16 cars, the rest AI); tracks have hills and banking, pinch points and wide braking zones, a bus-stop chicane with raised kerbs, gravel traps and tarmac run-off, grip patches (resurfaced, dusty, bumpy, puddles in the rain), a racing line that rubbers in over the race (and dries first in the rain), split sections with a shorter joker lane, braking boards and corner numbers; track limits are enforced (all four wheels off and the lap does not count, here and on the server); a 64-car field where every driver has its own personality (bruisers, late brakers, wild cards…) and runs off the road now and then; damage is real: hits dent the body where they land, knock bumpers, wings and mirrors loose and off, break lamps and glass, and cost the car power, grip and alignment until it is wrecked and out; hills and banking are real physics (cars run faster downhill, slower uphill, banked turns hold them in, hard braking mid-corner washes wide); the demo is covered like a TV race: a director cuts to the closest battles, with a timing tower, callouts (lead changes, passes, fastest laps, wrecks, the flag), a caption for the car on screen and a rear-cam / onboard picture-in-picture; graphics on medium/high add ambient occlusion, wet-road and puddle reflections with raindrop ripples, per-object motion blur, 32k lit GPU smoke and fire that cars part, rigid-body crash debris (bumpers, wheels, shards), cars that get dirty, wet and scarred, and a felt slipstream (a tow arc on the gauge; the heat-haze shimmer and road mirage are switched off); sound adds an adaptive synthesized score (settings: **Music**), reverb zones (grandstand, gantry, open country) and gravel/sand/wet tyre sounds |
| PoVoxelStrike | Third-person survival shooter with fully destructible voxel structures |
| PoMule | Eight-player M.U.L.E.: claim land, work M.U.L.E.s and trade on a walking-floor market for twelve months vs seven AI personalities; all-AI demo |
| PoEcosystem | Watch-only island simulation: unified species & tribes, physical village building, seasons/weather/disease, caravans, fast-forward (+1y/+5y), naturalist Photo Mode postcards, opt-in browser persistence, and cloud gallery |
| SandPlayground | GPU sand-and-water sandbox |
| PoFighter | Preview. A 2D fighter whose character is cut from a phone video of a real person. `/pofighter/1player` is a practice room: walk, crouch, jump, punch, high punch and kick against a punching bag that counts hits; keyboard, gamepad or touch. Nothing is scored or sent. New fighters are made offline with `scripts/pofighter/` (see `DOCS/20261112/PoFighter-PRD.md`) |

In PoBrawl FFA, knockouts use the same jointed physics ragdolls as 1v1: fighters
fall from their current pose with the final hit's momentum instead of snapping
sideways. Bodies stay on the mat through the rest of
the round and its five-second result hold. The next round returns all 16 fighters
to their standing starting positions.
Its cinematic camera cuts to the lowest-health survivor, alternates three fight
angles, holds briefly on their knockout, and returns to a wide shot after the
champion close-up. Reduced-motion mode keeps the steady arena overview.

**1P · FFA** (`/pobrawl/ffa/play`, also **Play as Bob** inside the exhibition)
adds human-controlled Bob to all 16 CPU presidents: 17 entrants, no replaced CPU.
A stable over-the-shoulder camera follows Bob rather than cutting to endangered
CPUs. WASD moves relative to that view; F punches, G kicks, R guards, and P/Esc
pauses. Nearby opponents are aimed at automatically; attacks require a press.
The existing controller and touch input paths work too. Losing focus pauses human
play; Resume is explicit. If Bob is knocked out, he stays down until next round.
Human matches have their own browser-local seasons, ratings and agent choices;
they never modify the 16-CPU exhibition's saved standings.

The final KO has a bounded, transform-only half-speed replay before champion
results. It includes the fall, never replays score or impact events, then restores
the final poses. The five-second results hold starts after playback. Reduced
motion skips the replay. Leaving or restarting clears the replay buffer.

**FFA seasons & studio** (top-right button) adds an unattended, browser-local
20-round season. Placement points crown each season's champion; pairwise
placement Elo, wins, average finishing place, damage, knockouts and rear hits
accumulate independently of the global 1v1 leaderboard. Eight recent season
titles and the latest completed benchmark are retained. An interrupted round is
restarted from the same seed on reload; only finished rounds are scored.

The strategy selector applies balanced, aggressive or cautious behavior next
round. **Run strategy benchmark** executes 48 repeatable fixed-step simulations:
16 paired seeds rotate the test president through all three profiles against 15
balanced rivals. The saved report compares placement gains, wins, damage and KOs
without changing live-season ratings. This is scripted strategy testing, not
training or paid AI. Lifetime damage bars and accessible tables need no new
charting dependency.
After 55 simulated seconds, overtime increases damage and disables guards so
cautious fighters cannot stall an unattended season indefinitely.

FFA now uses the existing Three.js quality and studio-rendering mechanisms:
physical fighter materials, arena reflections, shadows and an adaptive
resolution/effects budget. The broadcast overlay labels its featured fighter,
health, last attacker, recent knockouts and the final duel.

Automatic highlights use `captureStream` and `MediaRecorder` when supported;
unsupported browsers show a status instead of blocking the game. Silent clips
capture knockout/final-duel/champion moments, are bounded to four downloadable
session clips, and are released when leaving the page. Download before leaving;
they are not uploaded or stored with seasons.

Optional president facts use Wikidata's structured-data API (CC0), not copied
article text. Enable them in the studio to show champion facts between rounds.
Public entity IDs are sent to Wikimedia; no account or gameplay data is sent.
Facts are cached locally, linked to their source, and network/offline failures
are displayed without interrupting the match. No API key is needed.
Strategy, highlight capture and fact-card preferences are remembered locally.
Wikidata HTTP failures impose a cooldown of at least 60 seconds (or the
server's longer `Retry-After`) rather than retrying every round.

**Agent lab** gives every president a distinct scripted default style and offers
pressure, counter and opportunist candidates. **Evaluate and promote if better**
runs the incumbent and candidate on the same eight fixed seeds against the same
frozen CPU roster/presets/global strategy (16 simulations, CPU-only even from human
mode). Only strictly improved average placement replaces the saved incumbent;
ties and regressions are rejected. The last report and presets survive reload;
promotions apply next round. This is repeatable rule tuning, not neural-network
training, learned models, external AI or paid inference.

### FFA graphics, physics and audio

FFA uses continuous swept-circle contacts for its 16 or 17 standing body capsules and
ring boundary, with the roster's mass ratios, friction and momentum-aware
knockback. Knockouts use the shared jointed ragdoll solver. Settled parts sleep;
each whole corpse retires from physics within four seconds while keeping its
final visual pose. At most 16 corpses/176 dynamic parts are tracked. Survivors
step over corpses instead of clipping through or getting stuck behind a pile.
The same fixed-step physics runs in benchmarks; older benchmark reports are
invalidated when this physics revision changes.

Quality-adaptive WebGL effects add bounded instanced sweat/dust bursts and
shock rings, anti-aliasing, bloom, screen-space contact shading, subtle hit
dispersion and color grading. Skin uses a scattering approximation; clothing
gets procedural micro-detail, sweat and battle wear. Mat marks and bruising
last until the next round. Light shafts and haze approximate volumetric arena
lighting; these are not ray-traced RTX or multi-bounce global illumination.

Web Audio impacts now follow collision energy and flesh/cloth/shoe/rope
materials. HRTF sources follow the cinematic camera's listener, with bounded
nearest-fighter friction voices and approximate arena reverb/occlusion.
Studio clicks, toggle cues, drawer slides, standings highlights and press
feedback respect shared mute/volume and reduced-motion preferences. The
top-right sound toggle controls the same app-wide mute setting.

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
  import map in   `wwwroot/index.html`, and `cannon-es` (`0.20.0`) is vendored locally in `wwwroot/lib/cannon-es/` for zero-CDN worker physics. See the
  [visual architecture dashboard](DOCS/20261029/VISUAL_ARCHITECTURE_DASHBOARD.html).
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
PoRacer's weather is one draw per track and UTC day (`PoRacerWeather` in `PoMiniGames.Shared`,
the same hash `js/weather.js` uses for its overlay): 58% clear, 25% rain, 11% snow, 6% fog. The
server races in it (grip 0.90 in rain, 0.80 in snow: less traction, longer braking, understeer
that grows with speed, earlier slides; fog changes nothing but the view) and sends it in
`PoRacerStaticWorld.Weather`, so the overlay draws what the sim ran. Laps set in the wet go on
the same boards as dry ones and are slower; the medal times are dry-track times.
Run `pwsh scripts/test-ceilings.ps1` to check all four test-method budgets without Docker.
Run `node --test tests/pomule-world.test.mjs tests/pomule-physics.test.mjs` for PoMule's renderer maths.

Run `npm ci --prefix scripts/pomarblerace` then `node --test tests/pomarblerace-map-health.test.mjs` for Marble Race map health (a full headless 101-marble race on every course, also run by CI; see `scripts/pomarblerace/README.md`).
CI validates Bicep and deploys application code; use `azd up` for resource provisioning.

## Configuration and endpoint changes (2026-10-17)

| Key | Meaning |
|---|---|
| (AI keys removed) | `PoFunQuiz:QuestionSource/AllowFreshAi/OpenTriviaDb`, `PoCoupleQuiz:Features:*AI*`, `PoMiniGames:AI:*` and `PoMiniGames:Diag:AiUsageAdmins` no longer exist; the quizzes read their JSON banks only |
| `PoMiniGames:PoRacer:Weather` | `daily` (default): each Racer track's weather is drawn from the UTC date. `clear`, `rain`, `snow` or `fog` fixes it for every race; tests pin `clear` (`TestBudgetGuard`). The start card always describes the daily draw |
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
| `/pocabinet` settings (`pocabinet.settings.v1`) | 2026-10-19: Blazor owns the store (`PoCabinetUiSettings`); weather is Clear or Rain (the Live D.C. weather and its open-meteo call are gone, a stored `auto` reads as clear); steering assist defaults to Light; `roomDetail` is `splat` (the scanned tracks' 9.6 MB Gaussian splats, bedroom and court, default) or `mesh` (Lite) |
| `/pocabinet` (client UI, review fixes) | 2026-10-19 (later): a wreck is a **DNF**, classified behind every running car here, in the lap verifier and online (no stage credit, a DNF results card, the debrief names it); results use the modal's own buttons (Race again or Back to lobby, Next stage, Back to all games, Share) with Watch replay beside the telemetry; the result card image and its "Card or clip" menu are gone (the clip stays in the replay); the drawer also opens from the start card; paint is four colours (the patterns never reached the car; a stored `livery|color` keeps its colour); the racing-line overlay is gone (`racingLine` in the settings store is ignored); weather changed mid-race applies to the next race, online races are always dry; the demo cannot be paused, writes no personal records and runs to the flag when its autopilot wrecks; every race after the first is audible again; a hidden tab pauses a solo race and mutes the game; the race view measures the app bar (no page scroll on phones) and hides it on a phone held sideways |
| `POST /api/pobrawl/ladder` | 2026-10-19: rows keyed by the caller's account (not the display name; older name-keyed rows are no longer ranked), one rung beyond the stored row per post (a bigger claim is credited one rung), climbs at least 7 s apart (`429 ladder_too_fast`), client Elo clamped to 100..3000, `503` when storage is down. The 201 body is the stored row |
| `POST /api/pobrawl/highscores` (fastest KO) and `GET /api/leaderboards/pobrawlko` | 2026-10-19: KO floor raised from 0.5 s to 1.5 s (the sim's fastest real KO is about 1.7 s); one row per player, faster-only; the board ranks each player's best over every row |
| `POST /api/pobrawl/elo` (Cup bout Elo) | 2026-10-19: own `pobrawl-elo` rate-limit policy (20/min); per identity one bout every 3 s and 40 a UTC day (`429 demo_too_fast` / `demo_daily_cap`); both ids must be roster fighters and differ |
| `POST /api/pobrawl/matches` (online result) | 2026-10-19: answers `503` + `Retry-After: 5` when the Elo write fails (the claim is released; retry within 90 s); an abandoned match records nothing; the self-match check runs before any write |
| `/pobrawl/lobby-hub`, `/pobrawl/match-hub` (SignalR) | 2026-10-19: one seat per user (a second tab takes over the seat), a seat idle 2 minutes gives way to a newcomer, `gameStarted` and the match code go to the two seated players only; the match waits for both corners before the countdown; `RequestRematch` / `VoteRematch` removed; inputs capped per corner |
| `GET /api/pobrawl/dossier` | 2026-10-19: answers within 4 s (static facts when Wikipedia is slow, enriched in the background; one 4 s Wikimedia attempt) |
| `/pocabinet/lobby-hub`, `/pocabinet/race-hub` (SignalR) | 2026-10-19: every race gets its own 8-hex code (`RaceStarting(code, trackId)`, lobby `Code`), so a results screen never picks up the next race; new lobby method `Kick(seatId)` (host, between races) and events `Kicked(reason)`, `LobbyNotice(text)`; a rematch seat not ready 90 s after the lobby reopens is freed. Race hub: `JoinRace` returns null (not an error) when the race is over, new `LeaveRace()` (forfeit: the car coasts, later joins spectate), new event `RaceAborted(code)` when three ticks in a row fail; a car with no input for 0.5 s coasts; a race every human left is called |
| `POST /api/pocabinet/scores` | 2026-10-19: `GameCode` at most 32 letters, digits, `-` or `_`; input log length checked before decoding; the play-session preflight runs before a replay; at most two replays at once (`503` + `Retry-After: 5` after a 2 s wait); an online lap is spent only after the score is stored, so a retried `503` still verifies |
| `GET /api/leaderboards/pocabinet`, `pocabinet-{track}`, `pocabinet-daily` | New (2026-11-13): Cabinet's best-lap boards, one per track (`pocabinet` is Capitol; `pocabinet-daily` is today's circuit, `pocabinet-daily-yyyyMMdd` a day that can still be raced), lowest lap first, shown as m:ss.fff. They are in `GET /api/leaderboards` too, and the race results' Top 3 reads the raced track's once the lap is stored |
| `/pocabinet/lobby-hub` (SignalR), online grid | 2026-11-13: still 8 driver seats, but the grid is up to 16 cars (`PoCabinetCatalog.OnlineGridSize`): `SetBots` takes 0 to 12 (`MaxBots`), the four officials first, then field racers under their solo names and paint (wire `officialId` `field`, no radio lines). The 30 Hz `RaceSnapshot` is about 250 bytes a car: 2 KB at 8 cars, 4 KB at 16 |
| `/pocabinet` settings (`pocabinet.settings.v1`), HUD | 2026-11-13: `roomDetail` gains `auto`, the new default: the full 9.6 MB scan on a computer, only the light 2.4 MB one on a phone, a slow or data-saving connection or a low-memory device (a stored `splat` or `mesh` is kept). `gpuCompute` (`"auto"`, `"webgpu"`, `"webgl"`) adds opt-in WebGPU WGSL particle compute (`gpucompute.js`) and UI shader backdrop (`uishader.js`) with automatic WebGL2 fallback. The lap strip gains a live delta (this lap against your best lap here, or a quicker lap of this race, from lap 2; drawn by `race.js`) |
| `/pocabinet` graphics, audio, physics engine | 2026-11-13: 2-substep integration, sort-and-sweep swept midpoint CCD, and 5-style mass/inertia exchange mirrored between `physics.js` and `PoCabinetPhysics.cs`; `postfx.js` adds screen-space contact shadows, 1-bounce SSGI, and depth-guarded heat haze on high tier; `cars.js` / `paint.js` / `materials.js` add iridescent dispersive glass, volumetric brake cones, and wrapped subsurface scattering; `fx.js` adds barrier paint transfer, wreck scorch/oil pools, mud drag tracks, and 1200-spark bursts; `debris.js` adds spatial-hash piece-to-piece collisions and acoustic clatter; `audio.js` adds a 10-slot pooled HRTF panner bank, material-matrix modal synthesis, directional intake/exhaust engine bias, raised kerb thuds, and dual stereo canyon early reflections |
| `/poracer`, `GET /api/leaderboards/poracer-crossfire` | 2026-11-13: fourth track, Crossfire Switchbacks (`crossfire`), with its own best-lap board (also in `GET /api/leaderboards`). The race join's `Static` gains `weather` (`clear`, `rain`, `snow`, `fog`); bots drive by style (`PoRacerAiStyle`) and go round a car they have caught; the bot "Vanguard" is now "Loose Cannon" (Wildcard) |
| `/pobrawl/match-hub` (SignalR) | Rollback protocol: `SubmitInput` takes `{ frame, held, press, sequence }`; new `matchInput` event (each accepted input with the frame the server used) and `Ping` method (clock sync); `matchState` now carries `frame`, `sim` (38 packed ints, was 26 before 2026-11-13) and `checksum` in place of the per-tick swing fields |

PoBrawl's fighter dossiers quote summaries and portraits from [Wikipedia](https://en.wikipedia.org/)
(text CC BY-SA 4.0); each card links its article with a "From Wikipedia" attribution.
