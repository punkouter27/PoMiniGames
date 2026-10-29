# Capability map

What each module owns, and where PoMule and Radzen land. `SPEC.md` holds the
PoMule requirements; this file only says which module does what.

Status key: **Retained** = unchanged · **Extended** = gains PoMule wiring · **New** = created
for PoMule · **Deferred** = planned after PoMule v1.

## Modules

| Module | Owns today | PoMule v1 change | Status |
|---|---|---|---|
| `src/PoMiniGames.Shared` | DTOs and catalogs shared by client and server; trim-clean | New folder `Games/PoMule/`: the whole deterministic rules engine (map, land, economy, market, events, AI, scoring) | Extended |
| `src/PoMiniGames.Domain` | `GameKey`, high-score models, Elo, `ScoreRules`, name sanitizer | `GameKey.PoMule`, `PoMuleHighScore`, a score-range rule | Extended |
| `src/PoMiniGames.Infrastructure` | Table/Blob storage, `HighScoreDescriptor<T>` leaderboards | One descriptor for the PoMule board | Extended |
| `src/PoMiniGames.API` | Host, auth, 15 SignalR hubs, vertical slices in `Features/<Slice>` | New slice `Features/PoMule/` with high-score endpoints only (no hub) | Extended |
| `src/PoMiniGames.Client` | Blazor WASM shell, 14 game pages, JS engines in `wwwroot/js/<game>/` | `Games/PoMule/` page and components in Radzen; `wwwroot/js/pomule/` canvas renderer; Radzen package, theme and services | Extended |
| `tests/*` | Four capped tiers (100/50/25/25) plus `node --test` files | PoMule tests in every tier; the Unit tier went to 140 for PoMule and was folded back to 100 (`Scenario` theories) | Extended |
| `infra/`, `.github/` | Bicep and deploy workflow | None | Retained |

## Capabilities

| Capability | Module(s) | Used by PoMule v1 | Status |
|---|---|---|---|
| Sign-in gate (Entra / dev guest) | Client, API `Features/Auth` | Yes, unchanged | Retained |
| Game catalog, hub cards, mode chips | Client `Models/GameCatalog.cs`, `Pages/Index.razor` | Yes: one card, chips for 1 Player and Demo | Extended |
| Hub demo reel | Client `Pages/Index.razor`, `Components/KioskControlBar.razor` | Yes: PoMule joins the lap | Extended |
| Shared start card and end-of-game modal | Client `Components/` | Yes, as the outer frame; Radzen inside | Retained |
| Leaderboards | Infrastructure `HighScoreDescriptor<T>`, API `Features/Leaderboard`, Client `Services/Http` | Yes: Net Worth board | Extended |
| Offline score park-and-sync | Client `Services/Play` (`PendingScore`, `ScoreSyncService`, `GameResultService`) | Yes | Extended |
| On-demand JS engine loading, PWA cache list | Client `wwwroot/js/engineLoader.js`, `service-worker.published.js` | Yes | Extended |
| Shared audio and palette buses | Client `wwwroot/js/gameCues.js`, `paletteBus.js`, `spatialAudio.js` | Yes, reuse existing cues | Retained |
| Online play (SignalR hubs, lobbies, invites) | API `Features/*`, Client per-game clients | No | Retained |
| Server score verification | API `Features/PoCabinet`, `PoMule` | Yes: Cabinet sends its input log and `PoCabinetLapVerifier` re-runs the race for the lap time and place (online, the server sim timed it); PoMule sends seed + action log, `PoMuleRunVerifier` replays it through the Shared engine; no log = range check only | Extended |
| AI text (Azure AI Foundry), opt-in only | API `AI/`, quiz slices; free banks and matching by default | No | Retained |
| Cloud saves and gallery | API `Features/PoEcosystem`, Blob storage | No | Retained |
| Radzen component library | Client | Yes: all PoMule non-canvas UI; Brawl HQ's select bar, grid and chart | New |
| Radzen in the hub, settings sheet, leaderboards and the other games' screens | Client | No (in-game HUDs stay custom CSS) | Deferred |

## Shared services (added 2026-10-17)

| Capability | Owner | Notes |
|---|---|---|
| Achievements | Client `Services/Play/AchievementService.cs` | Rules over local stats; shown on the profile |
| Weekly leaderboards | Infrastructure `StorageService.HighScores`, API `Features/Leaderboard/UnifiedLeaderboardEndpoints.cs` | `period=week` reads this ISO week's boards |
| PoFunQuiz question bank | API `Features/PoFunQuiz/Storage/QuizBankRepository.cs` (`PoFunQuizBank` table), `OpenTriviaDbClient.cs`, `BundledQuizQuestions.cs`, `QuizPrebakeService.cs` | Free; grows only; dedup by text hash |
| PoFunQuiz question source | API `Features/PoFunQuiz/FunQuizQuestionService.cs` | Bank by default; opt-in Fresh AI falls back to the bank |
| PoCoupleQuiz answer matching | API `Features/PoCoupleQuiz/AnswerMatcher.cs` | Free and deterministic; the AI judge is opt-in for close calls |
| PoJevArena free brain | API `Features/PoJevArena/Jev/LocalJevClient.cs` | Default `PoMiniGames:Jev:Brain`; paid Jev is opt-in |
| On-device language model | Client `wwwroot/js/localAi.js` | WebLLM over WebGPU, off by default; serves the Jev brain in the browser |
| PoMule score verification | API `Features/PoMule/PoMuleRunVerifier.cs` | Replays seed + action log through the Shared engine |
| Gamepad input | Client `wwwroot/js/gamepadBus.js` | Engines, DOM focus navigation and rumble; loaded on first `gamepadconnected` |
| Ghost runs | Client `wwwroot/js/ghostTrack.js` | Compact best-run paths in localStorage; PoRacer and PoMarbleRace |
| Start and end cards | Client `Components/GameIntro.razor`, `Components/GameOverModal.razor` | Every game opens on a card with one OK button (controls, a How to play tab, the setup) that fits without scrolling, and ends on one with one Back to main menu button |
| Per-game palettes and cues | Client `wwwroot/js/paletteBus.js`, `gameCues.js` | Each game's colors and sound cues; no background music anywhere (event stingers and jingles only, e.g. Brawl's president motifs) |

## Existing games

All thirteen are retained and still evolving; none is pruned or reworked by this effort.

| Group | Games |
|---|---|
| Racers | PoRacer, PoCabinet, PoMarbleRace |
| Action and sims | PoBrawl, PoVoxelStrike, PoJevArena, PoEcosystem, SandPlayground |
| Quiz and AI | PoCoupleQuiz, PoFunQuiz |
| Board | TicTacToe, ConnectFive |

## PoMule: who decides what

| Concern | C# engine (`Shared/Games/PoMule`) | JS renderer (`wwwroot/js/pomule`) | Blazor page (Radzen) |
|---|---|---|---|
| Map generation, terrain, towns | Decides from the seed | Draws tiles | |
| Land grant, conflicts, auctions | Decides | Draws cursors | Bid panel |
| Development: movement, collisions, tether | Validates the events it is told about; owns timer, money, stock, installs | Simulates at 60 fps; reports arrivals, bumps and runaways | Timer and status banners |
| AI opponents | Chooses goals and market moves | Steers avatars toward goals | |
| Production, spoilage, events | Decides | Plays the animation | Announcement bar |
| Trading floor | Ticks prices and trades at 10 Hz | Draws lanes and avatars | |
| Standings, net worth, colony grade | Decides | | Grid, chart, end modal |
