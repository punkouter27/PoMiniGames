# PoMiniGames

Instant-play mini-games platform: a .NET 10 Minimal API host that also serves its
Blazor WebAssembly client from a single origin (port 5080), with SignalR for real-time
multiplayer and Azure Table Storage for persistence. There are no AI services; the two
quizzes draw from JSON question banks.

- **Live:** https://app-5ln5hfdrvof5u-f1win2.azurewebsites.net (System status: `/diag`)
- **Run locally:** see [Quick start](#quick-start). **Deploys:** every push to `master` runs
  `.github/workflows/deploy.yml` (format, build, Unit + Integration tests, deploy, `/health/live` check).
- **Rules for changing it:** [AGENTS.md](AGENTS.md) (the Po web standard plus this repo's notes).

## Overview

Fourteen small games on one website. The browser runs each game in full, including its
computer opponents; the server referees online play, checks and stores scores. There is no
sign-in: a player is a random browser id plus three initials.

- **One origin.** The API host serves the Blazor client it is then called by, so there is no
  cross-site setup in production.
- **Each game is a Razor page plus a JavaScript engine** (`wwwroot/js/<game>/`), loaded on
  demand and wired together with JS interop callbacks.
- **Online play runs over 13 SignalR hubs.** Match, lobby and race state is held in server
  memory and is lost on restart.
- **Lobby recovery is visible.** Shared lobbies automatically rejoin after SignalR reconnects
  when the game supports it, report a failed rejoin, and offer a manual retry after reconnect
  attempts are exhausted.
- **A browser with no seat is told why (2026-11-20).** The shared `OnlineLobby` shows the
  server's own sentence and the one button that asks for a seat, in place of a "couldn't reach
  the lobby" toast beside a green "connected" pill:
  - *Refused* (a hub throws a `HubException` from `OpenSeat`, or answers `Join` with a roster the
    caller is not on): the reason, and **Try again**. While it waits, the visitor watches the room
    (`LobbyHub.Join` sends a refused caller the current `lobbyState`); when a seat frees the
    button becomes **Take the seat**. Nothing joins by itself: there are no queues.
  - *Removed* (`kicked`: the host, another tab of the same player, idling): the reason, and
    **Rejoin here**.
  - *Old build* (the refusal starts with `LobbyRefusal.ReloadPrefix`): **Reload**, through the
    service worker (`poPwa.applyUpdate`).
  - A lobby that words its own no-seat states opts out with `SeatNotices="false"` (Cabinet).
  - `LobbyPanel` takes four opt-in presentation parameters, used by Brawl: `Heading` (a sentence
    in place of "Players · n/m"), `QuietWhenConnected` (no "connected" pill while the hub is
    healthy), `ShowInvite="false"` and `UnreadyLabel`. A browser with no seat gets no Ready
    button in any lobby. The seat count is also on the card as `data-lobby-seats="n/m"`.
- **PoBrawl's online lobby (`/pobrawl/multi`) asks for one thing: Ready (2026-11-20).**
  - The fighter is picked on the start card, by face (the Setup tab on a phone), from the same
    `PoBrawlFighterGrid` as 2P with a portrait on each tile (the dossier's Wikipedia thumbnail; a
    lettered disc when there is none). The pick is remembered
    (`pominigames:pobrawl-online-fighter`) and sent once the browser holds a seat.
  - The lobby card is one sentence that says what the room is waiting on and what to press, the
    two seats, and **Ready** / **Leave**. The empty seat holds **Invite a friend**. A fighter's
    name opens its dossier; **Change fighter** opens the grid again.
  - Both seats ready counts down from three in each browser and the host's starts the fight;
    **Cancel Ready** calls it off.
  - The same player in a second tab still takes the seat over, and the older tab is now told so
    (`kicked`, with **Rejoin here**), as is a seat lost to idling. `PoBrawlLobbyService.Seat`
    reports every connection it displaced.
  - A full room refuses with "The room is full: two players are already in."
  - The hub refuses a browser whose `PoBrawlRollbackSim.WireVersion` (the `v` query parameter
    of the hub URL) is not the server's, and asks it to reload. Raise `WireVersion` with every
    change to an online rule, an input's bits or the packed state. A tab opened before
    2026-11-20 sends no version, so it is refused and still shows its old "couldn't reach the
    lobby" toast until it reloads.
- **PoBrawl's 1P ladder and 2P local are three-round bouts.** All three rounds (60 seconds
  each) are fought and scored on health at the bell (a bell too close to call is nobody's
  round), with round pips under the clock; whoever is ahead on rounds after the third takes it,
  level is a draw. A **KO ends the whole match** on the spot. The Cup, online and the training
  room stay one round. A hard enough beating in a short space is a **knockdown**: the fighter
  cannot be hit on the canvas and the **referee counts to ten**, one number a second. The blow
  that dropped them decides whether they beat it (`knockdown.js` `riseOdds`: a knockdown blow of
  10 damage or less is always beaten, 40 or more never, linear between, about half overall);
  one who beats it rises on a number from 3 to 8, and what the player holds as they rise still
  picks the get-up (plain, a roll, rising into the guard, or a wake-up strike). Counted out is a
  KO. The training room keeps the free get-up game, and online keeps its own rollback rules. Taps punch left-right-left (jab, cross); a coil
  is the right hand. Body damage costs each region something different: head = stunned longer
  and down sooner, torso = slower energy regen, arms = weaker strikes and a guard that leaks,
  legs = slower on the feet and off the canvas. The rules are pure modules
  (`js/pobrawl/energy.js`, `knockdown.js`, `rounds.js`, `combat.js`; the per-fighter state
  machine is `fighterTick.js`), tested headless by `tests/pobrawl-core.test.mjs`.
  The fastest-KO board takes a round-one knockout only. Online has the knockdown and both hands
  too, in the rollback sim's own integer terms (daze, down / rising / rolling, jab and cross), so
  the packed state grew from 26 ints to 38 (16 a corner), and to 42 with the taunt (see above).
- **PoBrawl has a grab and a taunt (2026-11-19), in every mode.** Locally (1P, 2P, the Cup,
  training) their numbers are `GRAB` and `TAUNT` in `js/pobrawl/constants.js`; online they are
  rules of the rollback sim (the online bullet further down).
  - **Grab:** its own key (**T** for Player 1, **O** for Player 2, a 🤼 button on the touch pad),
    or punch and kick together (the second button inside 0.07 s of the first counts; that is how
    a gamepad grabs). It is short, cannot be charged, goes straight through a held guard and throws the fighter
    (about 1.5 m, into the ropes, a turnbuckle or the crates if they are there); holding away as
    it starts throws them behind you. Any strike beats it: a fighter who is swinging, coiling,
    reeling or on the canvas cannot be grabbed, and grabbing air leaves a 0.45 s recovery. Two
    grabs at once break. A throw is never the knockout. Resolved by `hitResolution.js _tryGrab`.
  - **Taunt:** block tapped twice with the opponent out of strike range plays the fighter's
    entrance gesture: 1.1 s with no guard, steps or swing. Finish it and the energy bar refills,
    the signature meter gains 30% and the crowd roars; a blow that lands during it does 25% more.
    Seven seconds of cooldown. `fighterTick.js _canTaunt / _enterTaunt / _finishTaunt`.
  - **The CPU uses both** (`ai.js`, `tactics.js`): it grabs a player who hides behind the guard
    (weighted by the same turtle read and habit profile as its baits, never on rungs 1-2),
    taunts when it is well ahead and far away, and walks in to kick a player who taunts.
- **PoBrawl's corner talks between rounds (1P ladder).** At a round break one scripted line says
  what the round showed and what to do about it (`js/pobrawl/corner.js`: about ten rules, worst
  problem first). When one of the president's signature phrases did the damage, the line spells
  that phrase out from its own steps ("A jab, a jab, then a wound-up punch. Guard the last
  beat."), so the advice cannot drift from the pattern. It stays up until the bell and the page's
  live region reads it (`OnCornerAdvice`).
- **PoBrawl's recap counts more, and fights earn feats.** The round scorecard
  (`js/pobrawl/rounds.js blankStats`) also counts strikes thrown, perfect guards, grabs, taunts,
  times gassed and health lost by body part. The result's Recap tab adds accuracy, perfect
  guards, knockdowns and throws (rows nobody scored on are left out), and a Damage tab draws
  where each corner was hurt. Eleven **feats** (`js/pobrawl/feats.js`, mirrored by
  `PoBrawlFeats.cs`: a round without losing health, a win from 10 health or less, a knockout off
  a perfect guard's counter, and so on) are decided by the engine at the end of each round and
  reported with the result; the 1P page stores them per player (`pobrawl_feats_{name}`), each is
  an achievement on the profile, and Brawl HQ's Ladder tab lists them with a stamp for every
  president beaten.
- **PoBrawl keeps a poster of the last fight** (`js/pobrawl/keepsake.js`; 1P, 2P and the Cup).
  The poster is a frame from the last quarter second before the knockout (or the bell), both
  fighters still in the fight's own framing, with who beat whom, how and when lettered over it.
  It lives in memory only (nothing is uploaded, a reload forgets it) and is shown, downloaded and
  shared from Brawl HQ's **Last fight** tab, because the end card keeps its one button.
- **Online, the grab and the taunt are rules of the rollback sim (2026-11-20)**, written in both
  copies (`rollbackSim.js`, `PoBrawlRollbackSim.cs`) as two more presses: `Grab = 7` and
  `Taunt = 8` on `PoBrawlMatchAction`, so an input's press field is 4 bits wide, not 3.
  - **Grab (T, or the 🤼 touch button; a gamepad has no button for it online):** takes hold of a
    corner within 1.3 m that is standing (not on the canvas, not swinging this frame, not still in
    a swing's cooldown, or one that is taunting). It ignores the guard, does a flat 9 damage with
    no roll, throws the corner 1.5 m and never knocks out. Grabbing air costs a 36-frame cooldown,
    a landed throw 24. Two grabs on one frame break. There is no back throw: the online ring is a
    line and P1 is always the left corner.
  - **Taunt (guard tapped twice):** only taken with the other corner on its feet and more than
    2.1 m away, at most once every 7 s. It lasts 66 frames with no walking, guard or swing, then
    adds 30 energy (online the bar is the special's meter). A blow or grab that lands during it
    does 125% and ends it.
  - The packed state is 42 ints (18 a corner: `taunt` and `tauntCd` are new), so a browser still
    running the old script cannot read a new server's snapshots until it reloads.
  - Parity is checked by `scripts/dev/brawl-rollback-golden.mjs` (the rules on the JavaScript copy,
    and the checksums of four scripted 4,000-frame fights) and `PoBrawlRollbackSimTests` (the same
    rules and the same fights on the C# copy). Change a rule in both, run the script, paste its
    numbers into the test.
  - `netplay.js` shows a grab's reach at once and what it did a tenth of a second later, when the
    hands close, so a rollback can still correct it.
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
- **Haptics are one platform layer.** `wwwroot/js/platform/impactBus.js` gates every controller rumble
  and phone vibration in the app: the Haptics setting (`pomini_haptics`, on by default), reduced
  haptics under reduced motion, and rate and duty caps so nothing holds a motor on. PoBrawl
  routes rumble to the local human only (`js/pobrawl/haptics.js`): a rising pulse while a strike
  charges, a tick on a perfect guard, thumps scaled by the hit, a long KO thud.
- **Sound is one mix.** `wwwroot/js/platform/audioBus.js` owns the single AudioContext: master volume
  (`pomini_volume`), an Effects level (`pomini_sfx_volume`, default 100) and a Music level
  (`pomini_music_volume`, default 0, so music is opt-in). Every sound is synthesized
  (`dsp.js` + `gameCues.js`), with no audio files. `musicLayers.js` adds adaptive layers that build
  with PoRacer's laps and PoBrawl's round clock. Shared camera-shake presets live in
  `feelPresets.js` (`window.PoFeel`), and particle bursts in `gpuFx.js`
  (`PoFx.burst(x, y, 'win' | 'ko' | 'highscore')`).
- **One game host for 2D and 3D (`wwwroot/js/platform/stage/`, `2d/`, `3d/`).** Every canvas engine
  runs on `createStage({ kind: '2d' | '3d', ... })`. The stage owns the canvas size through the
  shared pixel-ratio policy (`canvasDpr.js`), a loop-safe ResizeObserver, the rAF loop (dt clamp,
  optional fixed step, hitstop time scale), pause on a hidden tab or lost focus, the `PoQuality`
  tier and every teardown. Games keep only what they simulate and draw.
  - **Features are written once.** A feature is one file in `platform/stage/features/` plus one line in
    its `index.js`; `kind: 'any' | '2d' | '3d'` decides which stages get it, and `default: true` turns
    it on everywhere (a game opts out with `exclude: ['id']`). Today: `shake` (default, any; camera
    shake driven by `PoImpact` trauma), `renderBudget` (opt-in, 3D; the adaptive pixel-ratio and
    shadow ladder), `photoMode` (default, 3D, 2026-11-21; N freezes the game and opens a free camera with focus,
    exposure and Save PNG; never in an online or `/multi` route, and it takes a key the game does not bind:
    `userData.photoKey` / `boundKeys`) and `paper` (opt-in, 3D, 2026-11-20; loose paper simulated on the GPU:
    `stage.feature('paper').attach(scene, renderer, { rect, groundHeight, blocked, indoors })`, then
    `feed({ wind, movers })` each frame and `blast(x, z, strength, radius)`; the tier sets how many
    sheets unless the game pins `setLevel`; three.js loads only on `attach`).
  - **2D helpers:** `bindCanvas` and `makeLayer` (HUD and offscreen canvases), `fitWorld` (letterbox and
    integer-pixel scaling), `createParticles2D`, `tween.js` (easing, damp, spring), `createShaderQuad`
    (raw WebGL2 full-screen shaders).
  - **3D helpers:** `createRenderer(THREE, { api: 'webgl' | 'webgpu' | 'auto', tone, shadows, ... })` takes
    `THREE` as an argument, so it works with either build; every engine now passes the r186 one.
    `attachRenderer(stage, renderer, { camera, composer })` sizes the renderer on every resize and
    disposes it with the stage. `disposeObject3D` and `watchContextLoss` handle teardown and context
    loss, and `warmup` compiles shaders before the first frame. `fluidGrid.js` /
    `fluidGridGpu.js` (2026-11-20, from PoCapitol's gas) carry a light density (gas, smoke, dust)
    over the ground on a wind and pressure-solved flow round walls: `createFluidGrid(rect, cols,
    rows, blocked, indoors, { lifeOut, lifeIn, windShare })` on the CPU, `createGpuFluidGrid(...)` the
    same on WebGPU compute (resolves null without WebGPU; `lost()` says when to fall back).
  - **Shared r186 3D modules (2026-11-21, `platform/3d/`):** `postStack.js` (scene pass, TRAA, auto-exposure,
    lens flare, anamorphic streaks, SSGI and SSR as ONE HDR node; SSGI and SSR are *earned*: off at boot, on only after
    the measured p95 frame time shows headroom, shed at once and barred for a growing cooldown when it does not;
    `?postOff=ssgi,ssr,traa,exposure,flare,streak,dynres|all` switches passes off and `?postEarn=all` forces
    both on, for A/B), `postAddons.js` (the r186 addon imports), `shadows.js` (cascaded sun shadows + PCSS soft
    shadows; plain PCF on the WebGL2 fallback), `gpuParticles.js` (compute particles that collide with scene depth
    through `depthGrid.js`; capacity 65,536 / 32,768 / 16,384 on high / medium / low), `gpuCulling.js` (GPU frustum +
    occlusion culling into an indirect draw), `splats.js` (Gaussian-splat backdrops on r186; PoCabinet's court scan),
    `softBody.js` (XPBD soft bodies on the GPU).
  - Tested in `tests/platform-stage.test.mjs`.
- **GFX / physics / audio layer (2026-11-17).**
  All of these are in `wwwroot/js/platform/` and are lazy-imported by engines, except `springUi`, `framePacing`
  and `resultCeremony`, which load globally from `index.html`.
  - **Shared table:** `impactMaterials.js` is one table (metal, wood, stone, glass, rubber, paint, flesh, dirt,
    water) that drives the hit decals and particles (`damageSignature.js`), the debris (`debrisField.js`) and the
    synthesized hit sound (`impactSynth.js`).
  - **Graphics:**
    - `renderBudget.js`: the p95 frame-time quality ladder, never above the `PoQuality` tier.
    - `anticipation.js`: the pre-impact bloom and exposure dip.
    - `instancedPool.js`: fixed-size GPU pools.
    - `lightRig.js`: light presets, plus lightning that fires a `po-lightning` event.
    - `diegeticBoard.js`: an in-world board, always mirrored to an `aria-live` HUD.
    - `volumetricFog.js`: ray-marched fog, with fog cards as the fallback.
  - **Physics:**
    - `platform/physics/` (2026-11-21): one Rapier engine for the 3D games (`rapier.js` the world, contact events and a
      raycast; `cannonCompat.js` the cannon-es API on top of it, which PoMarbleRace and PoBrawl's props run on;
      `workerWorld.js` / `physicsWorker.js` for a worker-hosted world). Contacts reach `impactSynth` by themselves for
      materials that carry an `impactTag`.
    - `contactLoop.js`: a continuous rolling/scraping voice (worklet `worklets/contactVoice.js`) driven by contacts.
    - `feelPresets.fromImpulse/impulseImpact`: one profile for shake, hit-stop, blur, haptics and the crowd
      (a `po-crowd-recoil` event).
    - `ragdollBlend.js`, `debrisField.js` and `softChain.js`.
    - `simInterest.js`: interest management. Anything that is multiplayer or replay state is always simulated at
      full precision.
  - **Audio:**
    - `impactSynth.js` (pitch scales with object size).
    - `acousticProbe.js`: ray-cast early reflections and occlusion from the game's own geometry (PoEcosystem terrain, PoMarbleRace's course through Rapier).
    - `ambisonics.js`: a first-order ambience bed that rotates with the camera.
    - Acoustic zones: `acoustics.setZone/zoneAt`.
    - `tensionMixer.js`: drives six-stem `musicLayers`.
    - Keyboard-only `data-sonify` menu cues in `uiAudio.js` (pan ≤ 0.6, pitch carries the meaning). `uiAudio.js` loads globally
      from `index.html` so the listener binds on the hub; the hub mode chips opt in.
    - `speechBus.speakResultSummary`, which only speaks when the voice announcer is on.
  - **UI:**
    - `springUi.js` (`data-spring`/`data-magnetic`); `uiTargets.js` is the one list of controls that get the press spring
      and press cue (`uiAudio.js`).
    - The hub launch morph keeps the top bar still, adds an edge wipe and plays a sweep cue.
    - `resultCeremony.js`: the five-beat game-over sequence. It can be skipped and is off under reduced motion.
    - `framePacing.js`: the 10-second Settings preview measures p95 and recommends Auto/Low/Medium/High. After a
      tier is kept, a 60-second stutter watch rolls back to the last stable tier.
  - **Wired into:**
    - PoCabinet: render budget, anticipation, light rig, standings board, tunnel/garage zones.
    - Voxel Strike: damage signatures.
    - PoCapitol: fog cards.
    - PoBrawl: impulse coupling, cloth banners, seeded debris, ragdoll smoothing, balloon interest culling.
    - PoMarbleRace: impact synth.
    - PoRacer: tension mixer.
- **No database.** Scores, ratings, saves and AI spend ledgers live in Azure Table Storage;
  PoEcosystem world files live in Blob Storage. A player is the browser's player id and
  initials; there is no Player table.
- **Computer opponents are hand-written rules, not trained models.** Difficulty is a table of
  numbers in source. No LLM and no AI service; all of it is classic game AI (2026-11-18):
  - **Connect Five / Tic-Tac-Toe** share one k-in-a-row engine (`Client/Features/BoardAi/`):
    time-budgeted iterative deepening (Easy 5 ms, Medium 40 ms, Hard 150 ms), a Zobrist
    transposition table, TT/killer/history move ordering, a gravity-aware VCF threat search, an
    opening book, shape-based evaluation, and MCTS (Connect Five Hard and top rungs). Weak rungs
    make plausible mistakes by softmax over the top moves instead of random moves.
  - **Brawl** (`js/pobrawl/`): a cross-session habit profile (`playerProfile.js`, localStorage key
    `pomini_pobrawl_profile`), an n-gram predictor of the player's next action (`predictor.js`),
    utility scoring of tactics under per-archetype behaviour trees (`tactics.js`: aggressor,
    counter-puncher, turtle) and bait-and-punish. `scripts/dev/selfplay-brawl.mjs` runs headless
    CPU-vs-CPU ladders; its proposed rung table is in `rungTuning.json` and is opt-in, not applied.
  - **Racer** (`Api/Features/PoRacer/PoRacerRacingLine.cs`): a per-track braking/acceleration
    speed profile and apex line, one-move defending and committed overtakes, rubber-banding capped
    at ±4% (solo only, off on the final lap), and bots that learn braking points from the fastest
    human lap (in memory only).
  - **Mule** (`Shared/Games/PoMule/PoMuleAi.cs`): goal planning per colonist (secure food/energy,
    mine, corner a good, cash out) and next-month price forecasts for buying and selling, still
    deterministic so the server's replay check matches.
- **No AI services.** PoFunQuiz and PoCoupleQuiz pick random questions from JSON banks
  (`Features/PoFunQuiz/Data/questions.json`, `Features/PoCoupleQuiz/Data/questions.json`)
  loaded into memory once at startup; PoCoupleQuiz matches answers with free fuzzy matching
  (`AnswerMatcher`). Ecosystem, Brawl and Cabinet commentary is scripted. Cabinet's radio lines
  are also spoken: each scripted line was voiced once, on a developer machine, by
  `scripts/pocabinet/radio-voices.mjs` (a local text-to-speech model) and ships as an MP3, so no
  model runs in the browser or on the server. PoEcosystem's creature thoughts and the narrator
  line on its chronicle cards are spoken the same way (`scripts/poecosystem/voices.mjs`,
  `wwwroot/audio/poecosystem/`): the creature being studied says its thought, in a voice of
  its species, from where it stands.
- **Around the games.** The hub is the game cards plus *Watch all demos* (the Today card,
  streak, Continue strip, pins and filters were cut on 2026-10-19, the search box on 2026-11-15), and it
  launches games without rebooting the app. Each card carries one line saying what the game
  is, and its modes are capped at three chips with the rest behind a `+N` popover. On a phone
  the bottom bar is Games / Boards / Stats / More, where More holds Settings, Service status
  and the build date. Leaderboards have all-time and weekly boards, drawn as a podium for the
  top three and rank cards below, with the player's own place pinned when it falls outside the
  ten shown. The profile shows achievements behind a progress bar and the first three rows,
  with the rest on a disclosure. There is no version stamp in the page corner. The pages
  share one `PageHeader`. Gamepads work in every game
  and on the hub. The game-over sheet can share a result card. Settings is a side drawer.
  Each demo in the reel gets a 60-second slot, including games whose match ends early.
  Reel controls fit narrow phones, and Ecosystem skips its interactive onboarding in the
  reel. Mule reserves room for the controls and uses readable player cards in portrait.
  Every demo page gives the bar's height back through `--kiosk-clearance`, so a board's last
  row or a HUD panel never sits under the controls, and the bar keeps its labels at full
  contrast (it thins only its backdrop while the viewer is idle). A reload or a shared
  `?kiosk=N` link re-arms the reel where it left off. Connect Five's demo plays Red one ply
  deeper than Yellow, which is what makes the attract loop end in a win instead of a
  two-row stripe.
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
  The `/diag` "System status" page shows the API, data and services in plain words, plus the
  build version; every page shows the build version (vYYMMDD) bottom-right.
- **Works offline.** A score that cannot reach the server is parked in the browser and sent
  automatically later.

### Shared game UI

- `PageHeader` is the one page header: title, an optional meta line and an action slot,
  used by the hub, leaderboards and My Stats (/diag uses the standard System status layout). New top-level pages use it
  rather than their own head markup.
- The main menu (`Features/Home/Index.razor`) displays every game card in one scrolling grid (two cards per row on
  wide windows, stacked on narrower viewports), with one chip per supported mode.
- `GameShell` owns the title, Settings entry point, diagnostics and result dialog.
  Keep game artwork and HUDs game-specific, but do not override the shared dialogs'
  theme, typography or geometry.
- `GameIntro` owns modal focus containment, readiness, controls, setup and the one OK
  action. A game with several maps passes `Maps` (`IntroMap` id + name) and binds `MapId`: in
  1P and 2P the footer shows a **map dropdown** beside OK (Racer tracks, Marble Race
  courses, Sand Playground worlds). A map is always that dropdown, never cards or buttons. Essential choices stay visible; longer explanations and customization belong
  in disclosures. On a portrait phone a game's setup is a third **Setup** tab beside Controls
  and How to play, so the card fits a 375×667 phone without scrolling; wider cards show setup
  beside the controls. Escape cancels the intro rather than silently starting play.
  Choose 1P, 2P, Online or Demo on the main menu; intro modals do not repeat mode selection.
- During gameplay, **Tab toggles stats**, and **Esc closes them**. Shift+Tab, forms and
  dialogs retain normal focus navigation. The visible Stats control supports touch. The
  panel's **pop out** button opens `debug-window.html`, a separate developer window fed live
  over a `BroadcastChannel` (frame rate graph, viewport, heap, the game's own rows). Tab is not claimed on
  non-game pages, where it stays the keyboard's focus mover (WCAG 2.1.1).
  Ecosystem retains its observation dashboard and does not open a second generic panel. Marble's physics/render metrics join the shared
  stats panel instead of using a separate F3 overlay.
- Results keep headline facts compact, with full standings/telemetry behind details.
  The end card has exactly one action, **Back to main menu** (`GameOverModal` takes no extra
  buttons); another race or match starts from the start card.
  Demos and multi-race runs retain their existing progression.
- Pause dialogs share focus handling and presentation; online menus explicitly say
  when the match keeps running. Global preferences remain in Settings.
- Input regression checks: `node --test tests/game-debug.test.mjs`. `LinkAuditUiTests`
  covers reachable routes, start cards at 375×667 and 1280×720, the end card at 375×667, and a
  44px touch-target floor on every route.

### Documentation

| Document | What it covers |
|---|---|
| [Shared game UI](#shared-game-ui) | Required game workflow, shared UI, controls, accessibility, and verification conventions |
| [SCREENSHOTS/](SCREENSHOTS/) | Before/after pages for UI changes: `{YYMMDD}-{feature}.html` + one side-by-side `.png`, made by `pwsh scripts/screenshots.ps1 -Feature <name>` (local captures, never the live site). First one: [SCREENSHOTS/261124-v4-audit.html](SCREENSHOTS/261124-v4-audit.html) |
| [Architecture map](https://claude.ai/artifact/HGHLwMdGyveqtknNC1o5ar) | Component diagrams, request flows and the data model (private link; share it from the page to give others access) |

## Games (`src/PoMiniGames.Client/Features/`)

| Game | One-liner |
|---|---|
| PoCapitol | Third-person alternate-history crowd simulation. `/pocapitol/1player`: join a crowd of 512 that starts out on the grass (mostly bystanders, a minority pushing), hold a police line, or observe; 64 police in five lines with shields, batons, spray, gas, flash-bangs and a few concussion grenades fall back in stages across grounds, Crypt, Rotunda and Statuary Hall to barricaded House chamber doors, on a 12:50 pm to 6:00 pm clock, while 64 staff and members shelter inside and are evacuated (nothing can harm them). As the solo raider you carry a machine gun, five concussion grenades and two smoke grenades (**Space**/**Click** fire, **G** throw, **H** smoke; on touch, FIRE and two grenade buttons that show what is left; on a gamepad, right trigger, X and Y); about one person in three breaks off into a room once inside, and one in twenty carries a historically sourced, one-to-six-word sign. `/pocapitol/demo` is an armed, entirely fictional variant in which both sides fire and those hit drop out; the first seven seconds are calm, then the police open fire, the crowd scatters and returns fire, protestor rounds can hit other protestors, and the camera alternates a high crane, a close orbit around the crowd and a shot from behind the police line. It loops and saves nothing. Blasts are overpressure: people are thrown into the air and knocked down, never dismembered. Synthesized sound, Yuka crowd steering (vendored, MIT), adaptive graphics with Auto/Low/High (the top rung adds temporal anti-aliasing with motion blur, ray-marched lit gas on a fluid grid, hundreds of small screen-space lights, lens flare and metering, and a second close shadow cascade with contact-hardening edges; hung banners and breaking panes are simulated for the picture only, while loose bike racks slow whoever wades through them and pushes travel through the packed crowd as pressure waves), and a crowd of individual synthesized voices placed around the listener. Adult themes, no injury shown; invented layout, not a documentary or real access plan. |
| TicTacToe | 4-in-a-row on 6×6 vs AI, hot-seat, or online in the shared lobby (SignalR; the host plays first) |
| ConnectFive | Five-in-a-row vs AI, hot-seat, or online in the shared lobby (SignalR; the host plays first). Online has a 30 s move clock (the server plays a random legal column when it runs out; paused while a seat is in its 30 s reconnect grace) and a server-scored online Elo (K 32, start 1200; stored per player id in table `ConnectFiveOnlineElo`; board at `GET /api/leaderboards/connectfive-online`; separate from the 1P adaptive Elo; clients cannot submit it). The rating change shows on the end card. Feel and looks live in `js/connectfive/fx.js` (a DOM observer, so the .NET page owns only the rules): every landing gets a pitched, panned click, a board bump scaled by fall height, a dust/spark puff in the disc's colour and a haptic tap; a win sweeps light along the five discs with confetti in the winner's colour and a crowd + brass sting, the CPU's win is a quieter variant and a draw a neutral chime (all inside the 5 s end-modal delay; reduced motion, low tier and mute are honoured). The start card's Options hold **Board: 2D / 3D** (`pominigames:connectfive:board`): 3D is a three.js/WebGPU board on the shared stage (`js/connectfive/board3d.js`) drawn over the DOM board, which stays the input, keyboard and aria source; it falls back to 2D without WebGPU/WebGL or on the low tier |
| PoBrawl | Physics brawler with a presidents ladder and two CPU exhibitions on the home hub: **DEMO · Tournament** (the 8-slot Brawl Cup at `/pobrawl/demo`; the eight highest-rated presidents enter, seeded by their fighter-board Elo into the order 1v8, 4v5, 2v7, 3v6 (`PoBrawlTournament.SeedOrder`; equal ratings in random order), open slots are BYE on the bottom seeds and their opponent advances unfought, the start card shows the field as a 2x4 of the 8 slots with seed and Elo (`PoBrawlFighterGrid`, BYE tiles for open slots), every bout advances automatically to one champion, a level bell goes to the higher seed, and each bout updates the live fighter Elo board; note the server's per-identity cap of 40 Cup bouts a UTC day (`PoBrawlDemoEloGate`), so a kiosk running the Cup all day stops rating after about 2.6 cups) and **DEMO · FFA** (`/pobrawl/ffa`; eight presidents fight in the ring at once, rear attacks bypass guards, knockout places are shown, and a new round starts after five seconds; this exhibition does not submit 1v1 Elo results); the Cup has an animated bracket (with the cup's controls: the options gear for speed and camera, Tab for the bracket hub) and belt ceremony, golden-hour → dusk → night arena, an Elo-upset crowd, and a TV-style director camera; 1P/2P/online keep a plain side view; the old `/pobrawl/tournament` address redirects to the Cup; 1P, 2P and training pause on Esc / P, on the touch ⏸ button and automatically when the window loses focus (Resume, Restart fight, Quit), and the result leads with Fight again / Rematch in place; a showtime layer of charge auras and president motifs over a crowd that stomps and chants, plus — with the settings sheet's **Brawl show** set to Full (`pobrawl_show`; Simple is the default) — convention balloon drops, a stadium wave, an occasional instant replay, a glass result screen, the belt ceremony and the director camera (those four Full-only modules are loaded on demand, so Simple never parses them); live 3D fighter select (a mirror pick gives Player 2 an alternate suit); an election-night campaign map for the ladder + fighter Elo board; **Brawl HQ** (`/pobrawl/hq`) puts the ladder, campaign map, local record, the ladder / fastest-KO / fighter-Elo boards, Cup titles, the presidents beaten, the feats and the last fight's poster on one page; every fighter speaks 5 emotions (angry, happy, hurt, insult, celebrate) × 5 intensities (`js/pobrawl/fighterVoice.js` on the shared `js/platform/emotionVoice.js`): hurt when hit (by damage), angry landing a big hit, insult on a taunt, happy on a round or points win, celebrate on a KO and the Cup belt; `wwwroot/audio/pobrawl/voices.json` lists every fighter × emotion × level with its WAV path (`<id>/<emotion>-<level>.wav`), an `exists` flag and the fighter's voice profile; drop a WAV in and run `pwsh scripts/pofighter/voices.ps1 -Game pobrawl` to mark it, and every cell without one plays an advanced procedural imitation (glottal pulses, gliding formants, syllables with consonant onsets and a prosody per emotion, deterministic and cached) in that fighter's voice (the FFA has no voice set) |
| PoCoupleQuiz | Two-player realtime couples quiz (SignalR); online goes through one shared lobby (`/couplequiz/lobby-hub`: first in hosts and picks rounds + topic, the guest readies, the host starts); a JSON bank of questions about the couple's own life together, not trivia (about 240, in six topics: Our story, Dates & trips, Home life, Celebrations, Adventures & mishaps, Just us; or Everything), free answer matching |
| PoFunQuiz | Trivia from a JSON question bank (~8,500 questions; most from [The Trivia API](https://the-trivia-api.com), CC BY-NC 4.0, topped up from [Open Trivia DB](https://opentdb.com), CC BY-SA 4.0, by `scripts/content/import-trivia.ps1`). Solo and split-screen 2P pick one of eight categories on the start card (the last pick is remembered); online goes through one shared lobby (`/funquiz/lobby-hub`) where the host picks the category and question count, the guest readies, and the host starts. In split-screen each player can answer on their own controller: face buttons Y / X / B / A are options 1-4 |
| PoMarbleRace | You steer the one red marble through a 101-marble field on one map, **Grand Circuit** (slot 7), whose course is **dealt fresh every race** from the race seed (`composer.js`): a theme (Neon Night, Glacier Run, Foundry, Jungle Dusk, Desert Canyon: sky, light, kerbs and a procedurally grown **Gaussian-splat backdrop**, `backdrop.js` on `platform/3d/splats.js`) and a shuffled run of set-pieces between a fixed start and the fixed double-Gauntlet finale — split lanes, plinko (always dealt), kickers, pendulums, washboard, vortex funnel and plunge, drop tunnel and slide, slow powered turnstiles, **trampolines, see-saws, cross conveyors, pulsing magnets**, **ice and sand** bands and a **water flume** whose wakes and current are a fluid grid (`flume.js` on `platform/3d/fluidGrid.js`, WebGPU compute on the heavy tier); the length never changes, so the server's run check still holds, and a seed always deals the same course (online host and guest share it); glass marbles throw **caustics** on the floor (`caustics.js`); renders on **Three.js r186 `WebGPURenderer` + TSL `RenderPipeline`** (TSL bloom, speed-streak grade, FXAA, iridescent TSL glass marbles, Act-reactive lighting, billowing finish ribbon, and an **8,192-slot TSL GPU particle pool**), runs on **Rapier WASM** physics with Continuous Collision Detection and Earth gravity for 15 cm glass balls (1 unit = 7.5 cm, g = 131 u/s²; air drag ∝ v² and rolling resistance instead of a flat damping; a race runs about 35 s) in the browser (`physics-rapier.js`, automatic `cannon-es` fallback), shows a live high-DPI **2D track minimap** with elevation bar, top-3 leader dots, radial speed/boost arc, Act transition banner, and live rank-delta pills (`minimap.js`), and synthesizes audio via a real-time **AudioWorklet modal glass & rolling-grain synth** (`marble-audio-worklet.js`) + an always-on score in a second worklet (`marble-music-processor`: a pad under the grid, bass, drums once you are in the top ten, a lead on the podium or in the final stretch, changes landing on the bar line) and a Doppler whoosh when a rival passes close (`audio.js`); the presentation layer (`showcase.js`, `hud.js`, `lens.js`, `gantry.js`, `ui-fx.js`): a pre-race flyover of the whole dealt course with its set-pieces tagged, a 3D start gantry whose lamps follow the countdown, a marble-round iris wipe on GO and onto the winner, a standings tower with sliding rows, arrows for rivals closing from behind, a leader cam inset when you are not leading, a TSL lens pass (water drops on the lens after the flume, shockwave ripples on kickers and boost pads, edge colour fringe on boosts, per-pixel motion blur from the velocity buffer on medium/high, light shafts on high; `?mrLens=off` / `?mrLensOff=pip,rays,blur,drops` for A/B), eliminated marbles shattering into glass, gamepad rumble and phone vibration on your own hits, and on the end card a place-through-the-race chart, numbers that count up, tilting podium cards and view transitions in and out; responsive Olympic podium cards replace result tables; CPU rivals each have a personality (steady, cautious, line-hugger, bully, wildcard); your best run is a ghost; sector splits and world record; online is 2 players max through the one shared lobby (no codes: the first in hosts, the guest readies, the host starts), with a running series score (the host's browser streams the physics); keyboard, touch and gamepad steering. Engine modules live in `wwwroot/js/pomarblerace/` (game.js plus one mixin per system; constants in `tuning.js`, the save in `store.js`) |
| PoRacer | Top-down canvas racer the server simulates: four tracks (Grand Prix Circuit, Neon Skyline, Desert Dustway and Crossfire Switchbacks, seven tight turns with a main straight that crosses all four of its legs), solo races against 63 rivals or a time trial, an 8-seat online room and a demo. Each track has its own weather for the UTC day (clear, rain, snow or fog): rain and snow lower every car's grip, and the start card and a HUD chip say so. Rivals drive in character (apex hugger, draft hunter, bruiser, late braker, cautious, slingshot, wildcard); the results list each one's style. Trackside scenery (grandstands, tyre walls, cones, trees, tents, rocks) is Kenney's Racing Pack, CC0 (`wwwroot/img/poracer/`) |
| PoCabinet | 3D circuit racer on one circuit, **Cabinet Grand Prix** (`grandprix`, `PoCabinetTrackGeometry`): the stadium straight and its banked first turn, the climb over Senate Hill to the hairpin and the chicane, a blast across a giant scanned outdoor basketball court, the joker-lane sweeper and the beach road past the sand traps; 2 laps of about 95 s (the court is drawn as a Gaussian splat, `wwwroot/models/court.ksplat`, 9.6 MB, with a 2.4 MB light version `court-low.ksplat`, cropped to the court and 3.5 m round it; `court.glb` is the same scan as a mesh, drawn on the low tier, on the Lite scan-detail setting and when the splat cannot load; built by `scripts/blender/pocabinet-court.py` and `pocabinet-court-splat.py`, see `scripts/pocabinet/README.md`). There is no track picker, no campaign and no daily circuit; AI officials, one best-lap leaderboard (`pocabinet`), and a server-simulated online lobby (8 drivers on a grid of up to 16 cars, the rest AI); the circuit has hills and banking, pinch points and wide braking zones, a chicane with raised kerbs, gravel traps and tarmac run-off, grip patches (resurfaced, dusty, bumpy, puddles in the rain), a racing line that rubbers in over the race (and dries first in the rain), split sections with a shorter joker lane, braking boards and corner numbers; track limits are enforced (all four wheels off and the lap does not count, here and on the server); a 64-car field where every driver has its own personality (bruisers, late brakers, wild cards…) and runs off the road now and then; damage is real: hits dent the body where they land, knock bumpers, wings and mirrors loose and off, break lamps and glass, and cost the car power, grip and alignment until it is wrecked and out; hills and banking are real physics (cars run faster downhill, slower uphill, banked turns hold them in, hard braking mid-corner washes wide); the demo is covered like a TV race: a director cuts to the closest battles, with a timing tower, callouts (lead changes, passes, fastest laps, wrecks, the flag), and a caption for the car on screen; graphics on medium/high add ambient occlusion, wet-road and puddle reflections with raindrop ripples, per-object motion blur, 32k lit GPU smoke and fire that cars part and drag after them (a wake field the cars stir, `wake.js`), rigid-body crash debris (bumpers, wheels, shards; on medium/high the Rapier physics engine steps it, so parts pile up, lean on a wreck and lie on its roof), knock-over props on the run-off (13 stacks of tyres against the barriers at the bends and 25 cones along their exits, `props.js`: a car that runs wide scatters them and never feels it), cars that get dirty, wet and scarred, and a felt slipstream (a tow arc on the gauge; the heat-haze shimmer and road mirage are switched off); sound adds an adaptive synthesized score (settings: **Race music**), the officials' radio lines spoken through a radio filter (settings: **Radio voices**; 78 clips voiced once, offline, in `wwwroot/audio/pocabinet/`), reverb zones (grandstand, gantry, open country) and gravel/sand/wet tyre sounds |
| PoVoxelStrike | Third-person survival shooter with fully destructible voxel structures |
| PoMule | Sixteen-player M.U.L.E.: claim land, work M.U.L.E.s and trade on a walking-floor market for twelve months vs fifteen AI colonists across seven personalities; all-AI demo |
| PoEcosystem | Watch-only island simulation: unified species & tribes, physical village building, seasons/weather/disease, caravans, fast-forward (+1y/+5y), naturalist Photo Mode postcards, opt-in browser persistence, and cloud gallery. Animated creature models, spoken thoughts and narration, a bird flock that gathers at dusk and water that ripples where it is touched |
| SandPlayground | GPU sand-and-water sandbox |
| PoFighter | Preview. A 2D fighter whose characters are cut from phone videos of real people; the roster is **Nick** and **Kim** (`wwwroot/data/pofighter/p1.*`, `kim.*`) in 8 tournament slots, the rest BYE (no player) until filmed; the start cards pick on a select grid (`PoFighterRosterGrid`: compact in the pickers, only real fighters plus a Create tile that opens the Studio; the full 2x4 of 8 slots only for the tournament field) with each fighter's Elo, this browser's Studio fighters after the built-in ones (marked STUDIO), and the picked fighter's dossier (`PoFighterDossier`: Elo counting up with its last change, record, win rate, streak, last ten results and a filled Elo sparkline from `GET /api/pofighter/elo/{id}/bouts`; a Studio fighter is not rated). **1P · Arcade** (`/pofighter/arcade`) is you against the CPU: every other fighter in turn, lowest Elo first, then your own Shadow (a mirror match in the Shadow palette), best of three each; a draw replays the stage, a loss ends the run; Easy / Normal / Hard on the start card; the run goes to local stats. **2P** (`/pofighter/versus`) is two players on one screen (one shared grid with a gold P1 and a blue P2 cursor; the plates above it pick whose turn it is): P1 WASD + F punch / G kick, P2 arrows + K / L, or two pads (one pad plays P2). In every fight (2026-11-18) punch and kick give a standing, crouching (down held: a quick crouch jab or a low sweep that knocks down, only for a fighter with those clips filmed; otherwise down plus a button stands up and attacks) or jumping attack (up, up-forward, up-back; Kim, with no filmed jump, jumps in her crouch pose on a computed arc), each with frame data in `js/pofighter/moves.js` (startup, active and recovery from the clip, overridable per fighter with `frameData` in its json, plus whiff recovery so a missed sweep is punishable); air attacks borrow the filmed punch and kick carried on the jump arc until clips of their own are filmed; a sprite is never squashed or shrunk (2026-11-18 owner rule), so nothing borrows a clip at a smaller size. Specials come from motions read off a direction history: quarter-circle-forward + punch throws a **Po Blast** projectile (two clash), forward-down-down-forward + punch is the **Rising Fist** (invulnerable rising anti-air, knocks down, open on landing) and quarter-circle-back + kick the **Rush Kick**; every fighter can also have a **signature** special of their own, found in their recording (half circle forward + its button; name, button and kind strike / rush / rise / projectile from the fighter's data, none until filmed; shot list: `scripts/pofighter/shot-list.html`); the CPU uses all of them. Holding back guards high, down-back guards low: lows beat a standing guard, jump attacks are overheads that beat a crouching one, crouching ducks a standing punch, and a guarded hit costs only chip damage. A hit in the air, a sweep or a Rising Fist knocks down; the fighter gets up invulnerable. Unblocked hits within 0.9 s chain into a combo ("3 HIT COMBO" under the bar; each extra hit does a little less); a mirror match draws the second corner in an alternate palette (`PALETTES` in `js/pofighter/art.js`); human corners feel hits through their own pad's rumble or the phone's vibration (the Haptics setting gates both). Rules: `js/pofighter/versus.js`, attacks and motions: `moves.js`, modes: `arcade.js`, controls: `input.js`. Each fighter has a home stage (`js/pofighter/stages.js`: Nick the Night Rooftop, Kim the Paper Dojo, Studio fighters one picked from their id among those and the Neon Alley, whose crowd jumps on big hits, or the Gym), and a fight is held on the right-hand corner's stage, so each arcade stage looks different; the VS screen names it. After a match the winner's quote card shows both portraits (the loser greyed and cracked) and types out a line from `data/pofighter/quotes.json` (one list per fighter id plus `default`, `{foe}` is the loser's name). The announcer also calls ROUND n / FINAL ROUND, FIGHT!, FIRST ATTACK, combos of 3+, K.O. / DOUBLE K.O. / TIME OVER, PERFECT and the winner; on screen the clock pops each second under 10, the bar turns red under a quarter, a special's name pops over its fighter, and banners sit above the fighters' heads (rising into the empty band above the bars on tall screens, where the STAGE caption goes too). The arcade and 2P pickers are an arcade select screen: a slanted SELECT YOUR FIGHTER bar, a blinking 1P / 2P flag and a "?" tile that rolls a roulette and picks at random. `/pofighter/1player` is a practice room: walk, crouch, jump, punch and kick against a punching bag that counts hits, plus a cheer (every 10 hits) and a knockdown; keyboard, gamepad or touch; it shares the fight's effects and sound (bag hits throw sparks and light and thud, whooshes, footsteps, the window shafts, reflection, music, a crowd cheer every 10 hits, and the WebGL pass on the high tier) but not its camera shake. One toolbar holds the hit count, the fighter (its portrait opens the roster sheet, a popover), reset / slow and **Create fighter**; the moves are key-cap cards along the bottom that light up as they play and fold into a "?" pill after 5 idle seconds. **Create fighter** opens the Studio, a native `<dialog>` wizard (Source: webcam or clip, Background, Moves with a thumbnail and progress ring per move, Save) that runs MediaPipe in the browser and keeps the fighter in IndexedDB. **DEMO** (`/pofighter/demo`, also in the kiosk reel) is an arcade attract mode: Kim vs Nick, both CPU, best of three with a VS card, angled health bars with portraits, a 99 timer in a hexagon, round diamonds and ROUND / FIGHT! / K.O. banners that slam in over a round wipe, then a rematch with the corners swapped, forever; walking back is the block, any key or tap returns to the menu (rules in `js/pofighter/versus.js`); every completed demo match (in the kiosk reel too, never one left early, each match once) is rated on the live fighter Elo board through `POST /api/pofighter/elo` (`PoFighterDemoElo`; a draw is half a point each, Studio fighters unrated) and the win card shows both fighters' new Elo and change. **Demo · Tournament** (`/pofighter/tournament`) enters eight slots seeded by Elo (unrated and Studio fighters at 1000, the board's seed; Studio bouts unrated); slots with no player show BYE and their opponent advances, every real bout is best of three, and each result posts to the fighter Elo board (`POST /api/pofighter/elo`, read with `GET /api/pofighter/elo`; bracket in `js/pofighter/bracket.js`). Fighters speak 5 moods (angry, happy, hurt, insult, celebrate) × 5 intensities (`js/pofighter/voice.js` on the shared `js/platform/emotionVoice.js`, which PoBrawl uses too): `wwwroot/audio/pofighter/voices.json` lists every fighter's 25 cells with its WAV path (`<id>/<mood>-<level>.wav`), an `exists` flag and the fighter's voice profile, written by `scripts/pofighter/voices.ps1` (which also trims silence, normalises loudness to -16 LUFS and writes mono 24 kHz via ffmpeg, keeping originals in `scripts/pofighter/voices-raw/`); a recorded cell plays its WAV, any other the advanced procedural imitation in that fighter's voice. Fighters are drawn lit by the arena (`FighterPainter` in `js/pofighter/art.js`: a cool rim light, a shadow cast from the body's own silhouette, a 60 ms cross-fade into and out of one-shot moves, an additive hit flash); a landed hit holds the fight still (the sim's hit-stop plus `impactBus.hitstop`), throws sparks along the blow with a profile per punch / kick / block / K.O., sweat drops that bounce on the floor and a dust puff at the skidding feet (`js/pofighter/fx.js`), lights the wall, floor and the facing side of each fighter for a moment, and shakes the camera through the shared `impactBus`; kicks leave after-images, both fighters reflect faintly in the floor, the key light drifts, dust motes hang in the window shafts and the wall sits on a slower camera than the floor; on the `high` quality tier a WebGL pass (`js/pofighter/post.js`) adds bloom, a colour grade, grain and a colour split on a heavy blow; a K.O. flashes white, plays in slow motion and pushes the camera in; a match opens with an iris, rounds dip to dark between them and a single match fades out before its end card. Sound (`js/pofighter/sfx.js`, all procedural on the shared buses): `impactSynth` body thuds plus a slap crack per hit (a dull pap on a block, an echo tail on the K.O. blow), swing whooshes, footsteps, cloth and landing thumps, all panned by the fighter's x; the gym reverb is the acoustics `court` space; a crowd murmur swells on combos and roars on a K.O.; `musicLayers` + `tensionMixer` score the round by health and clock and drop to a heartbeat at a knockout; ROUND / FIGHT! / K.O. land on a low whomp. The health bar flashes the slice just lost white and shakes on a heavy hit; menu tiles and buttons spring on press (`data-spring`) and the roster grid sonifies keyboard moves (`data-sonify`). Every VS screen has a match announcer (`js/pofighter/announcer.js`): a cut-out face (`data/pofighter/announcer.webp` + `.json`, built by `scripts/pofighter/announcer.py`) calls "Nick! Versus... Kim!" through the browser's speech synthesis (muted with the app's sound) and drops its jaw per syllable, synced to the voice's word boundaries; when speech is muted or blocked the jaw runs on its own clock. The VS screen waits up to 2.5 s for the line. Engine tests: `tests/pofighter-*.test.mjs` (`pofighter-humans.test.mjs`: human corners, combos, ducking, palettes, difficulty; `pofighter-moves.test.mjs`: frame data, motions, specials, projectiles, guard levels, knockdowns, first attack and perfect; `pofighter-fx.test.mjs`: impact, whoosh, pan and spark profiles). New fighters are made offline with `scripts/pofighter/` (see `docs/2026-11-12/PoFighter-PRD.md`); a fighter whose video lacks a move (Kim has no jump) shows the stance for it |

**PoBrawl FFA runs on the 1v1 engine.** `/pobrawl/ffa` is `BrawlGame` in mode `ffa`
(`js/pobrawl/ffaMode.js` mixes the free-for-all into `game.js`), so it has everything a 1v1
bout has: the same fighters, materials, post chain, blood, sweat, limb loss, charge strikes,
grabs, daze, personalities, crowd, PA, director camera and KO ragdolls. On top of that:

- Eight fighters spawn on a ring and each picks a **target**, the nearest rival
  weighted toward the hurt ones by its agent style, with grudges against whoever just hit it.
  The CPU fighters are the 1v1 `AiController`, fighting that target.
- A swing lands on whoever its limb touches: the target first, then any standing body in reach.
- **There is no count: a fighter who goes down is out.** A knockdown and an empty health bar both
  eliminate; the body stays where it fell and leaves the physics solver after four seconds.
- Past 60 seconds it is **overtime**: blows land 1.5× harder and the ring closes (the survivors
  are herded into a circle that shrinks to 1.4 m), so a round always ends.
- The camera, spotlight and director frame a pair: Bob (or the most endangered fighter) and
  whoever they are squared up to. Only that pair casts real shadows; the rest keep their contact
  shadows, which keeps the draw calls level with a 1v1 bout.
- The champion holds the ring for five seconds, then the next round spawns.

**1P · FFA** (`/pobrawl/ffa/play`, also **Play as Bob** inside the exhibition) adds
human-controlled Bob alongside seven CPU presidents: eight entrants total. Bob uses the 1v1
controls (keyboard, pad or touch) and fights his nearest rival; P/Esc pauses. If Bob is out, the
camera follows the most endangered survivor. Human matches have their own browser-local
seasons, ratings and agent choices; they never modify the eight-CPU exhibition's saved standings.

**FFA seasons & studio** (Stats / Tab) keeps an unattended, browser-local 20-round season.
Placement points crown each season's champion; pairwise placement Elo, wins, average finishing
place, damage, knockouts and rear hits accumulate independently of the global 1v1 leaderboard.

**Run strategy benchmark** and the **Agent lab** play their rounds in `js/pobrawl/ffaSim.js`,
a seeded, fixed-step free-for-all with no renderer (flat circle bodies, range-and-facing
strikes, the same down-is-out rule). The benchmark runs 48 simulations (16 paired seeds × the
balanced, aggressive and cautious profiles); the agent lab runs the incumbent and a candidate
preset on the same eight seeds and promotes only a strictly better average placement. In the
live ring an agent preset shapes how its president picks targets.

Optional president facts use Wikidata's structured-data API (CC0), not copied article text.
Enable them in the studio to show champion facts between rounds. Public entity IDs are sent to
Wikimedia; no account or gameplay data is sent. Facts are cached locally and linked to their
source; Wikidata HTTP failures impose a cooldown of at least 60 seconds (or the server's longer
`Retry-After`).

## Quick start

```powershell
# prerequisites: .NET SDK 10.0.100 or a later feature band (global.json), Docker
docker compose up -d azurite                                  # local table storage
dotnet run --project src/PoMiniGames.Api/PoMiniGames.Api.csproj
# → http://localhost:5080  (API + client, one origin)

pwsh scripts/dev/test-all.ps1                                     # full test suite
```

## Layout

```
src/
├── PoMiniGames.Api/            Host + vertical feature slices (Features/<Slice>)
├── PoMiniGames.Client/         Blazor WASM client (assembly: PoMiniGamesClient)
├── PoMiniGames.Infrastructure/ Table Storage, HighScoreDescriptor<T> leaderboards (all-time + weekly, ?period=week)
├── PoMiniGames.Domain/         Domain primitives (EloCalculator, GameKey, ...)
└── PoMiniGames.Shared/         DTOs shared between client and server
tests/
├── PoMiniGames.Unit/           442 tests (hermetic; CI)
├── PoMiniGames.Integration/    17 tests (Testcontainers Azurite; CI; skip without Docker)
├── PoMiniGames.E2EAPI/         16 tests (HTTP contract, in-process host; local only)
└── PoMiniGames.E2EUI/          22 tests (Playwright; local only; skip without Docker or Chromium)
infra/                          main.bicep + main.bicepparam + modules/ (az deployment, run locally)
scripts/                        Working scripts only — see scripts/README.md
```

## Notes

- Identity: no sign-in, no OAuth. First-time visitors on the main page are prompted for
  3-letter initials (`A–Z`, persisted in `localStorage`) or can skip to 3 blank spaces
  (`"   "`), paired with a persistent browser `playerId` sent via `X-Player-Id` /
  `X-Player-Initials` headers (and SignalR query params) and resolved by `UsePlayerIdentity()`
  (`Infrastructure/PlayerIdentityExtensions.cs`) on the server.
- Controls are Radzen components: Radzen's theme is linked once, first, in `index.html`, and the
  app's own wrappers in `Features/Shared/Shell/` keep each game's look (`PoButton`, `PoTextBox`
  carry only the plain class `po-rz-plain`; `PoSelect` is a `RadzenDropDown` over (value, text)
  pairs). Switches, checkboxes, select bars, sliders, grids, tabs and charts are Radzen's own.
  The start, pause and end cards are still native `<dialog>`s (open item, AGENTS.md). In-game
  HUDs and in-canvas UI stay custom CSS / JS.
- **Each game is a Razor page plus a JavaScript engine, except PoMule**, whose rules are C# in
  `PoMiniGames.Shared/Games/PoMule` (unit-tested, seeded, deterministic) with JavaScript only
  drawing and moving the avatars. The server replays a submitted match from its seed and
  action log (`PoMuleRunVerifier`).
- **Two three.js versions.** Every 3D engine renders with three r186 `WebGPURenderer` and node materials (TSL): PoEcosystem,
  PoBrawl, PoMarbleRace, and (ported 2026-11-21) PoCabinet, PoVoxelStrike and PoCapitol. The r165 `three` build is
  left only for `platform/postFx.js` and `platform/3d/paperField.js`, which no engine imports any more. PoEcosystem's details: it uses the r186 build, imported as `three-eco/webgpu` / `three-eco/tsl` / `three-eco/addons/`; it
  falls back to three's WebGL2 backend by itself, and `?ecoBackend=webgl2` forces that.
  On WebGPU it also runs a bird flock and the water's ripples as compute passes
  (`render/flock.js`, `render/ripples.js`; the WebGL2 backend keeps the CPU birds and flat
  water), and its high tier adds a second, sharper shadow map and ambient occlusion
  (`render/shadows.js`, `render/postProcess.js`; `?ecoCsm=off`, `?ecoAo=off`). Its creatures
  are animated glTF models (`wwwroot/models/poecosystem/*.glb`, baked to a bone texture by
  `render/creatureModels.js`; a species whose file does not load keeps its box rig, and
  `?ecoCreatures=boxes` forces that).
  PoBrawl uses the same r186 build (`?brawlBackend=webgl2` forces its fallback; its GPU blood,
  crowd and confetti simulations need WebGPU and switch off without it). PoCabinet's post chain
  (`pocabinet/postfx.js`) is a r186 `RenderPipeline` on top of `postStack.js`, with SSR on the wet road in the rain.
  `three` (r165, no engine left on it), `rapier` (`@dimforge/rapier3d-compat` `0.21.0`, the engine behind
  `platform/physics/`; PoMarbleRace's node harness in `scripts/pomarblerace` loads the same version) and the r186 files are pinned with SRI in the import map in `wwwroot/index.html`, while `cannon-es` (`0.20.0`, now only PoEcosystem's fallback)
  and `yuka` (`0.7.8`) resolve to their local copies under `wwwroot/lib/` so browsers, Web
  Workers, and Node tests load the same artifact. `wwwroot/lib/basis/` is Basis Universal's
  KTX2 texture transcoder (`v1_60`, Apache 2.0), built here without string-made functions
  (`scripts/pocabinet/basis-build.sh`) because the CDN build cannot run under the site's CSP;
  PoCabinet's court mesh is the one thing that uses it. PoEcosystem's sim worker also steps its
  ragdolls, logs and rocks with Rapier (`sim/physics/rapierWorld.js`), imported by the same CDN
  URL (`RAPIER_CDN_URL` in `sim/core/config.js`; workers have no import map); if it does not
  arrive within four seconds the island runs on the local `cannon-es` instead. See the
  [visual architecture dashboard](docs/2026-11-12/VISUAL_ARCHITECTURE_DASHBOARD.html).
- Offline-friendly PWA: finished scores park locally and sync on reconnect.
- Deploy: push to `master` (App Service `app-5ln5hfdrvof5u-f1win2` (the repo variable `AZURE_WEBAPP_NAME`), F1, resource group `PoMiniGames`).

PoRacer ranks **best completed laps**, separately from final race times. Its legacy JSON
field and Azure Table column `totalTimeSeconds` / `TotalTimeSeconds` retain their names
for stored-score compatibility; existing rows are preserved without inferred conversion.
Solo races have 63 AI rivals and spectator demos have 64 AI cars (the grid is two staggered
columns that follow the road from the start line); online rooms remain
capped at 8 cars. The minimap is removed. Add `?perf=1` to a PoRacer URL and inspect
`window.PoRacer.getPerformanceProfile()` for frame rates and render-stage timings.
Track bitmaps respect the canvas pixel budget, including backing-store ratios below 1,
without rebuilding on every frame.
Join/rejoin snapshot numbers use Blazor's direct byte-array interop transfer rather than
JSON-formatting 1,400 floating-point values on the browser's WASM main thread.
Streaming snapshots retain the existing SignalR wire format but are decoded in native
JavaScript; only the four visible standings rows return to Blazor. All cars still feed
interpolation, rendering, and audio, and the HUD's field size comes from the complete roster.
PoRacer's weather is one draw per track and UTC day (`PoRacerWeather` in `PoMiniGames.Shared`,
the same hash `js/platform/weather.js` uses for its overlay): 58% clear, 25% rain, 11% snow, 6% fog. The
server races in it (grip 0.90 in rain, 0.80 in snow: less traction, longer braking, understeer
that grows with speed, earlier slides; fog changes nothing but the view) and sends it in
`PoRacerStaticWorld.Weather`, so the overlay draws what the sim ran. Laps set in the wet go on
the same boards as dry ones and are slower; the medal times are dry-track times.
`.github/workflows/deploy.yml` is the only workflow: on a push to `master` (or a manual run) it
checks formatting, builds, runs the Unit and Integration tiers,
publishes the API, prepares the live
site (`scripts/pre-deploy.ps1`), deploys to `vars.AZURE_WEBAPP_NAME` (`app-5ln5hfdrvof5u-f1win2`), and waits until `/health/live`
answers with this commit's `X-Commit`. E2E tiers, Bicep, CSS and JS lint run locally
(`scripts/ci-checks.ps1`). Provision or update Azure resources locally with
`az deployment sub create -l westus2 -f infra/main.bicep -p infra/main.bicepparam`.

**F1 budget (2026-11-22).** The Windows F1 plan allows 331 MB/day of data out and 1 GB of disk; going over
stops the site (`QuotaExceeded`, deploys get a 403). So:
- The deploy has no rollback step and never pulls a zip of the live site from Kudu.
- `scripts/pre-deploy.ps1` deletes old run-from-package zips in `data/SitePackages`, and, when the
  app has `PoMiniGames__Models__BaseUrl`, uploads changed `wwwroot/models` files to the public
  `models` blob container and strips them from the package. The app then redirects `/models/*`
  there (`UsePoMiniGamesModelRedirect`, also added to the CSP `connect-src`). Unset (dev, tests),
  the models are served from wwwroot.
- Release publishes Brotli copies only (`Directory.Build.props`), not gzip as well.
- Pushes that touch only root `*.md` files or `SCREENSHOTS/` do not build or deploy.

## Configuration and endpoint changes (2026-10-17)

| Key | Meaning |
|---|---|
| (AI keys removed) | `PoFunQuiz:QuestionSource/AllowFreshAi/OpenTriviaDb`, `PoCoupleQuiz:Features:*AI*`, `PoMiniGames:AI:*` and `PoMiniGames:Diag:AiUsageAdmins` no longer exist; the quizzes read their JSON banks only |
| `PoMiniGames:PoRacer:Weather` | `daily` (default): each Racer track's weather is drawn from the UTC date. `clear`, `rain`, `snow` or `fog` fixes it for every race; tests pin `clear` (`TestBudgetGuard`). The start card always describes the daily draw |
| `PoMiniGames:PoBrawl:Dossier:FetchWikipedia`, `CacheHours` | Fighter dossiers: enrich the static facts from the free Wikimedia REST API (default `true`), cached 24 h; off or failing, static facts are served. Tests pin it to `false` |

| Endpoint | Change |
|---|---|
| `POST /api/pocapitol/report-card` | 2026-11-20: PoCapitol after-action report card. Body `PoCapitolReportCardRequest` (`outcome`, `role` raider/police/none, `mode` solo/demo, `difficulty`, `clock`, `minutes`, `standing`, `police`, `casualties`, `lowestIntegrity`, `peakPressure`, `milestones`, and up to 240 samples each of `integrity`, `pressure`, `frontZ`), validated by `PoCapitolReportCardRequestValidator`; answers a 1200x630 `image/png` (400 problem details when invalid). Stateless: stores nothing, reads no identity, needs the antiforgery token. Drawn with **SkiaSharp** (plus `SkiaSharp.NativeAssets.Linux.NoDependencies`) and projected with **Silk.NET.Maths** (`Matrix3X2<float>` world-to-card); the Inter TTF is embedded (`Features/PoCapitol/Fonts/`, SIL OFL) because Skia has no system fonts on Linux. |
| `/pocapitol` engine, assets, settings | 2026-11-20: ten add-ons, each loaded only when used. **Rapier** (`debris.js`, medium/high tiers): canisters, flash-bang bodies, bottles and the placards and flags people drop when they go down, thrown by blasts and scuffed by runners; picture only. **Draco glTF + PBR** `wwwroot/models/pocapitol/props.glb` (`scripts/pocapitol/props.mjs`, 57 KB, layered metal-rough textures; decoder from jsdelivr). **GPU particles** (shared: `platform/3d/paperField.js` behind the opt-in `paper` stage feature, `GPUComputationRenderer`): 16,384 loose sheets of paper lifted by gusts and blasts. **WebGPU compute** (shared: `platform/3d/fluidGridGpu.js`, CPU fallback `platform/3d/fluidGrid.js`): on the top rung the gas grid runs as WGSL at 128x240 with 24 pressure passes; CPU grid fallback. **Howler** (`loudhailer.js`, spatial HRTF): nine police orders voiced offline (`scripts/pocapitol/voices.mjs`, Kokoro through **Transformers.js / ONNX Runtime**; `wwwroot/audio/pocapitol/hailer.json` + `hailer/*.mp3`, 148 KB). **Tone.js** (`score.js`): adaptive score on the music bus, driven by the clock and the line pressure. Debrief gains provider `browser`: SmolLM2-360M in the page through **Transformers.js** (about 270 MB once; it writes only an opening line with no digits, the figures come from the built-in writer) (import map `transformers`; CSP connect-src adds `huggingface.co` and `*.hf.co`). The end report gains the **TSL** aftermath map (`aftermath.js`, three r186 `WebGPURenderer`, a TSL compute blur of the new crowd heat grid) and a **Report card (PNG)** button. Settings (`pocapitol` prefs) gain `score` and `hailer` (`on`/`off`, default off) and `debrief: "browser"`. The page drives the engine through the typed `PoCapitolEngine` wrapper. Howler and Tone are UMD builds loaded by `engineLoader.js` `loadLibrary()` with integrity hashes. |
| `/pocapitol` UI/UX pass | 2026-11-21: an always-on HUD strip (clock, milestone pips, stamina/line rings, grenade chips); the Tab panel is debug-only (counts, radar, diagnostics). Incident command restyled as five line cards with rings and order buttons with cooldown sweeps. The inspector card is tethered to the selected unit (`leader.js`). Milestones land as a split-flap toast; the historical record slides in as the clock passes each entry. Restart in the pause dialog is hold-to-confirm (`data-hold`, `ui.js`). Esc during play goes back to the main menu (with the mouse locked the browser keeps Esc, so a pointer-lock release the game did not ask for, with the tab focused, counts as Esc); P pauses. The start card picks the role from four radio cards. Options: Display / Sound / Comfort / Keys / Debrief; keys rebind by pressing them; the radar palette follows the app-wide colour-safe setting; tracer `stealth` retired. End card details: Summary / Charts / Street map tabs (the street map loads only when its tab opens), stat cards with **RadzenSparkline**s from the report series (`spark*` fields on `getReportView`), one **RadzenSplitButton** Export. **WebGPU** (`gpu.js` shared device): density overlay as a raised pressure terrain with contour lines and crush ripples (`densityField.js`, compute splat + async readback, CPU fallback); a stable-fluids menu backdrop (`menuFluid.js`, WebGL2 shader fallback); an end-of-attempt particle dissolve into the heat map (`dissolve.js`, skipped without WebGPU). **AudioWorklet**: `shockWorklet.js` (post-blast low-pass sweep, beating ring, heartbeat by health), `hudWorklet.js` (line creak and density tick, pref `hudSound` on/off, default off like the music and loudhailer), `freezeWorklet.js` (spectral freeze of the scene while a menu is open, `pocapitol:menu` event from `ui.js`). |
| `/pocapitol` friendly fire, blast kills | 2026-11-21: rounds in flight hit whoever they meet first on either side (police rounds can drop officers, crowd rounds protestors); only the shooter is skipped, by reference. A concussion blast at `LAUNCH_FALL` (0.3 of full force) or more lifts a person and kills them outright (`killed`, health 0, a heavy harm record): they go limp in the air (`crowd.js` starts the collapse already slack and rides the arc) and lie where they land in every mode, never helped up by medics. Weaker blast edges knock back and stagger without lifting. |
| `GET /api/diag` | 2026-11-20: the Po web standard `DiagReportDto` (status, environment, version, checkedAt, checkedMs, checks[] with name, group api/data/service, label, status, purpose, detail, latencyMs, problem); always on and anonymous. No secrets, addresses or exception messages. |
| `GET /api/diag/status` | 2026-11-20: removed; `/api/diag` is the one diagnostics route (Po web standard `DiagReportDto`) |
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
| Profile A/B audit (client UI, CI) | 2026-11-18: Voxel Strike (`frameDt`) and PoCabinet (`THREE`) no longer throw every frame; CI runs the unit and JS engine tests again plus a new JS lint (`scripts/ci/js-lint`, ESLint `no-undef` and friends) and a CSS hex-colour ratchet; the end card is back to one button (Cabinet's Race again and Marble Race's Race again / Next track / online Rematch removed, with the Marble rematch hub method `RequestRematch` and its `rematch` event); start cards get a phone **Setup** tab; Settings is a gear upper right on every page and the title shows on phones; a 44px touch floor for every button, tab and summary; safe-area padding on every game area; the Tab panel pops out to a separate window; `/api/diag` also lists each table, blob container and SignalR hub; Brawl FFA ends on the shared end card |
| Start and end cards (client UI) | 2026-10-29: every start card (`GameIntro`) has one button, **OK**, and fits without scrolling on a laptop and a phone: header, controls (longer rules behind a How to play tab), the game's setup (beside the controls on a wide card), footer. Every end card (`GameOverModal`) has one button, **Back to main menu**: Share, Full leaderboard, Play again and each game's own next steps (Fight again, Rematch, Race again, Next stage, Watch replay, Save the KO clip, Save collapse clip, Replay this arena, Copy link, Review the match, Brawl HQ) are gone, with `shareCard.js` and both clip recorders |
| `GET /api/pocabinet/lobby` | Removed (2026-10-19, same day it came): the start card no longer shows who is online |
| `/pocabinet` (client UI) | 2026-10-19: the start card is how to play plus, in 1P, the track list (your best lap and campaign stage per track); paint and settings live in one drawer opened from the pause card and the lobby; the race fills the screen under the app bar (lap readout on the view); pause shows the race so far and adds Restart; results add the per-lap sector table, "Same track again" and "Next stage". |
| `GET /api/pocabinet/scores` | Removed (2026-10-19): nothing read it, the app has no Cabinet board. `POST` stays; the stored place is now the worse of the claim and the server replay's (solo) or the server sim's (online) |
| `/pocabinet` settings (`pocabinet.settings.v1`) | 2026-10-19: Blazor owns the store (`PoCabinetUiSettings`); weather is Clear or Rain (the Live D.C. weather and its open-meteo call are gone, a stored `auto` reads as clear); steering assist defaults to Light; `roomDetail` is `splat` (the scanned tracks' 9.6 MB Gaussian splats, bedroom and court, default) or `mesh` (Lite) |
| `/pocabinet` (client UI, review fixes) | 2026-10-19 (later): a wreck is a **DNF**, classified behind every running car here, in the lap verifier and online (no stage credit, a DNF results card, the debrief names it); results use the modal's own buttons (Race again or Back to lobby, Next stage, Back to all games, Share) with Watch replay beside the telemetry; the result card image and its "Card or clip" menu are gone (the clip stays in the replay); the drawer also opens from the start card; paint is four colours (the patterns never reached the car; a stored `livery|color` keeps its colour); the racing-line overlay is gone (`racingLine` in the settings store is ignored); weather changed mid-race applies to the next race, online races are always dry; the demo cannot be paused, writes no personal records and runs to the flag when its autopilot wrecks; every race after the first is audible again; a hidden tab pauses a solo race and mutes the game; the race view measures the app bar (no page scroll on phones) and hides it on a phone held sideways |
| `POST /api/pobrawl/ladder` | 2026-10-19: rows keyed by the caller's account (not the display name; older name-keyed rows are no longer ranked), one rung beyond the stored row per post (a bigger claim is credited one rung), climbs at least 7 s apart (`429 ladder_too_fast`), client Elo clamped to 100..3000, `503` when storage is down. The 201 body is the stored row |
| `POST /api/pobrawl/highscores` (fastest KO) and `GET /api/leaderboards/pobrawlko` | 2026-10-19: KO floor raised from 0.5 s to 1.5 s (the sim's fastest real KO is about 1.7 s); one row per player, faster-only; the board ranks each player's best over every row |
| `POST /api/pobrawl/elo` (Cup bout Elo) | 2026-11-22: Elo starts at 1000 with K 32 (`PairwiseEloOptions`, section `PoMiniGames:PoBrawlFighterElo`; was K 24), shared with the PoFighter board. 2026-10-19: own `pobrawl-elo` rate-limit policy (20/min); per identity one bout every 3 s and 40 a UTC day (`429 demo_too_fast` / `demo_daily_cap`); both ids must be roster fighters and differ |
| `POST` / `GET /api/pofighter/elo` (tournament fighter Elo) | 2026-11-18: one row per fighter (`p1` Nick, `kim` Kim; ids case-insensitive, stored lowercase) in table `PoFighterRatings`, same start rating, K and zero-sum update as the PoBrawl board. `POST {winnerFighterId, loserFighterId, isDraw}` returns `[winner, loser]` ratings (`fighterId`, `displayName`, `elo`, `wins`, `losses`, `draws`, `matches`, `lastUpdated`); unknown id `400 invalid_fighter`, same fighter twice `400 fighter_self_match`, `503` when storage is down; shares the `pobrawl-elo` rate-limit policy (20/min), no per-identity gate. `GET` is anonymous, ordered by Elo desc, and lists only fighters that have fought. New (2026-11-18): every rated bout is also logged on partition `pofighterbout` of the same table, and `GET /api/pofighter/elo/{fighterId}/bouts` (anonymous) returns that fighter's last 20, newest first (`winnerId`, `loserId`, `isDraw`, `winnerElo`, `loserElo` after the bout, `at`); an id off the roster is `400 invalid_fighter` |
| `POST /api/pobrawl/matches` (online result) | 2026-10-19: answers `503` + `Retry-After: 5` when the Elo write fails (the claim is released; retry within 90 s); an abandoned match records nothing; the self-match check runs before any write |
| `/pobrawl/lobby-hub`, `/pobrawl/match-hub` (SignalR) | 2026-10-19: one seat per user (a second tab takes over the seat), a seat idle 2 minutes gives way to a newcomer, `gameStarted` and the match code go to the two seated players only; the match waits for both corners before the countdown; `RequestRematch` / `VoteRematch` removed; inputs capped per corner. 2026-11-20: the lobby hub URL carries `?v=<PoBrawlRollbackSim.WireVersion>` and `Join` is refused (`reload: …`) when it is missing or not the server's; a full room refuses with "The room is full: two players are already in."; a connection that loses its seat to another tab of the same player or to idling gets `kicked(reason)` |
| `/connectfive/lobby-hub`, `/tictactoe/lobby-hub`, `/connectfive/hub`, `/tictactoe/hub` (SignalR) | 2026-11-18: online play goes through one shared lobby per game (cap 2: first in hosts and moves first, the guest readies, the host starts; no code). `gameStarted` carries an internal match code to the two seated players only, and each calls `JoinMatch(code, name, isGuest, asHost)` on the match hub; `FindMatch`, `CancelSearch`, `RequestRematch`, `TurnMatchQueueStatus` and `TurnMatchSeat.WantsRematch` removed |
| `GET /api/pobrawl/dossier` | 2026-10-19: answers within 4 s (static facts when Wikipedia is slow, enriched in the background; one 4 s Wikimedia attempt) |
| `/funquiz/lobby-hub`, `/funquiz/gamehub`, `/couplequiz/lobby-hub`, `/couplequiz/hubs/game` (SignalR) | 2026-11-18: both quizzes use one shared lobby per game on the shared `LobbyHub`/`LobbyRoom` surface (cap 2, first in hosts, guest readies, host starts; no code, no pre-lobby step). New host-only lobby methods `SetOptions(category, questionCount)` (Fun Quiz) and `SetRounds(rounds)` / `SetTopicPack(pack)` (Couple Quiz); the picks ride on every seat of `lobbyState` (`LobbyState<FunQuizLobbyPlayer>` / `LobbyState<CoupleQuizLobbyPlayer>`). `gameStarted` carries an internal match code to the two seated players only, and each calls `JoinMatch(code, name)` on the game hub (an unclaimed Fun Quiz reservation is swept after 2 min; Couple Quiz keeps one live match). Removed: Fun Quiz `JoinLobby`, `StartGame` and events `GameCreated`, `GameJoined`, `PlayerJoined`, `LobbyError`; Couple Quiz `Join`, `SetReady`, `SetRounds`, `SetTopicPack` on the game hub and events `LobbyJoined`, `LobbyUpdated`, `LobbyError`, `PlayerDisconnected`. If the opponent leaves a Couple Quiz match the survivor gets `GameError` then `GameOver` on the scores so far. |
| `/pocabinet/lobby-hub`, `/pocabinet/race-hub` (SignalR) | 2026-10-19: every race gets its own 8-hex code (`RaceStarting(code, trackId)`, lobby `Code`), so a results screen never picks up the next race; new lobby method `Kick(seatId)` (host, between races) and events `Kicked(reason)`, `LobbyNotice(text)`; a rematch seat not ready 90 s after the lobby reopens is freed. Race hub: `JoinRace` returns null (not an error) when the race is over, new `LeaveRace()` (forfeit: the car coasts, later joins spectate), new event `RaceAborted(code)` when three ticks in a row fail; a car with no input for 0.5 s coasts; a race every human left is called |
| `POST /api/pocabinet/scores` | 2026-10-19: `GameCode` at most 32 letters, digits, `-` or `_`; input log length checked before decoding; the play-session preflight runs before a replay; at most two replays at once (`503` + `Retry-After: 5` after a 2 s wait); an online lap is spent only after the score is stored, so a retried `503` still verifies |
| `GET /api/leaderboards/pocabinet`, `pocabinet-{track}`, `pocabinet-daily` | New (2026-11-13): Cabinet's best-lap boards, one per track (`pocabinet` is Capitol; `pocabinet-daily` is today's circuit, `pocabinet-daily-yyyyMMdd` a day that can still be raced), lowest lap first, shown as m:ss.fff. They are in `GET /api/leaderboards` too, and the race results' Top 3 reads the raced track's once the lap is stored |
| `/pocabinet/lobby-hub` (SignalR), online grid | 2026-11-13: still 8 driver seats, but the grid is up to 16 cars (`PoCabinetCatalog.OnlineGridSize`): `SetBots` takes 0 to 12 (`MaxBots`), the four officials first, then field racers under their solo names and paint (wire `officialId` `field`, no radio lines). The 30 Hz `RaceSnapshot` is about 250 bytes a car: 2 KB at 8 cars, 4 KB at 16 |
| `/pocabinet/lobby-hub` (SignalR) | 2026-11-18: now the shared `LobbyHub`/`LobbyRoom` surface (`Join(displayName, isGuest)`, `ToggleReady`, `StartGame`, `LeaveLobby`, new generic host-only `Kick(connectionId)` with a `kicked(reason)` event, opt-in per room through `CanKick`) plus Cabinet-only `SetTrack`, `SetBots`, `SetColor`. Broadcasts are the shared `lobbyState` (`LobbyState<PoCabinetLobbyPlayer>`: each seat carries paint, the host's track and AI-driver count; `inProgress`; `gameCode` is the running race's code), `lobbyEvent` (the 90 s ready-timeout notice is kind `notice`) and `gameStarted(code)`. Removed: `TryStart`, `Leave`, `LobbyState`/`Kicked`/`LobbyNotice`/`RaceStarting` PascalCase events, `PoCabinetLobbyView`, seat-id hashes, claim-id seat keys (seats are connection ids now). `/pocabinet/race-hub` `JoinRace(code)` unchanged. |
| `/pocabinet` settings (`pocabinet.settings.v1`), HUD | 2026-11-13: `roomDetail` gains `auto`, the new default: the full 9.6 MB scan on a computer, only the light 2.4 MB one on a phone, a slow or data-saving connection or a low-memory device (a stored `splat` or `mesh` is kept). `gpuCompute` (`"auto"`, `"webgpu"`, `"webgl"`) adds opt-in WebGPU WGSL particle compute (`gpucompute.js`) and UI shader backdrop (`uishader.js`) with automatic WebGL2 fallback. The lap strip gains a live delta (this lap against your best lap here, or a quicker lap of this race, from lap 2; drawn by `race.js`) |
| `/pocabinet` graphics, audio, physics engine | 2026-11-13: 2-substep integration, sort-and-sweep swept midpoint CCD, and 5-style mass/inertia exchange mirrored between `physics.js` and `PoCabinetPhysics.cs`; `postfx.js` adds screen-space contact shadows, 1-bounce SSGI, and depth-guarded heat haze on high tier; `cars.js` / `paint.js` / `materials.js` add iridescent dispersive glass, volumetric brake cones, and wrapped subsurface scattering; `fx.js` adds barrier paint transfer, wreck scorch/oil pools, mud drag tracks, and 1200-spark bursts; `debris.js` adds spatial-hash piece-to-piece collisions and acoustic clatter; `audio.js` adds a 10-slot pooled HRTF panner bank, material-matrix modal synthesis, directional intake/exhaust engine bias, raised kerb thuds, and dual stereo canyon early reflections |
| `/pocabinet` (one circuit) | 2026-11-20: Cabinet has one track, **Cabinet Grand Prix** (`grandprix`), built from the best of the old ones: the Capitol / Press Briefing stadium, Senate Hill (crest, banked hairpin, esses, raised-kerb chicane), the scanned basketball court as a section of the lap, the joker-lane sweeper and the Mar-a-Lago beach stretch (`court.glb`, `court.ksplat` 9.6 MB, `court-low.ksplat` 2.4 MB). Removed: Capitol Speedway, Mar-a-Lago Grand Prix, Press Briefing 500, Playground Marble Run, Senate Hill, Bedroom Floor GP and Center Court as separate tracks; the Daily Circuit (`PoCabinetDailyTrack`); the 4-stage campaign (`PoCabinetCareerState`, the results chip; localStorage `pominigames:pocabinet-career-v1` is no longer read); the start card's Track dropdown (the card keeps Scan detail and the Car / Settings tabs); `wwwroot/models/bedroom.glb`, `bedroom.ksplat`, `bedroom-low.ksplat`, the bedroom Blender scripts and `scripts/pocabinet/gen.mjs`. The world gains `zones` (which scenery each stretch of the lap gets) and `scan` (where the court stands) and loses `roadFrom`. `playground.glb` and `playground_colliders.glb` stay: PoMarbleRace's Playground Run uses them. The race length is the definition's (`PoCabinetTrackDefinition.Laps`) |
| `GET /api/leaderboards/pocabinet-{track}`, `pocabinet-daily`, `pocabinet-daily-yyyyMMdd` | Removed (2026-11-20): they answer `404`. `GET /api/leaderboards/pocabinet` is Cabinet's only board (title "Cabinet"), and `GET /api/leaderboards` lists that one. It reads a new partition (`pocabinet_grandprix` in `PoCabinetHighScores`), so no lap from a retired track ranks on the new circuit; the old rows stay in storage and the player-data export and delete now cover every partition of that table |
| `POST /api/pocabinet/scores` | 2026-11-20: `trackId` must be `grandprix` (any casing; it is the default when left out). Any other value, including a retired track or a `daily-…` id from a cached client or a parked score, is `400` and never replayed or stored |
| `/pocabinet/lobby-hub` (SignalR) | 2026-11-20: `SetTrack` removed and `PoCabinetLobbyPlayer` loses `trackId` (each seat still carries paint and the host's AI-driver count); the lobby's picker is the AI-driver count only |
| `/pocabinet` settings (`pocabinet.settings.v1`) | 2026-11-20: new `radioVoice` (default on; a store without the key reads as on): speak the officials' radio lines, or only show them. The switch is **Radio voices** under Sound |
| `wwwroot/audio/pocabinet/` | New (2026-11-20): `radio.json` (official id, line, clip file) and 78 MP3 clips (`radio/<officialId>/<hash>.mp3`, 16 kHz mono, 504 KB in all), one per line of `PoCabinetDialogue`. Fetched a line at a time and cached by the service worker on first use (`.mp3` joins its runtime-cache list). After editing a line run `node scripts/pocabinet/radio-voices.mjs`; until then the line is shown but not spoken |
| `wwwroot/models/court.glb`, `wwwroot/lib/basis/` | 2026-11-20: PoCabinet's court mesh (the low tier and the "Lite" court setting) has KTX2 / Basis ETC1S atlases and Meshopt geometry (`scripts/pocabinet/court-pack.mjs`): 4 to 8 MB of texture memory where the JPEGs took 32, a 2.27 MB file, no Draco decoder; the court is a little paler in the distance. The transcoder is self-hosted in `wwwroot/lib/basis/` (cached by the service worker on first use) |
| Import map (`wwwroot/index.html`) | 2026-11-20: new `rapier` entry, `@dimforge/rapier3d-compat@0.21.0` from jsDelivr with its SRI hash. Bump the version and the hash together |
| `/poracer`, `GET /api/leaderboards/poracer-crossfire` | 2026-11-13: fourth track, Crossfire Switchbacks (`crossfire`), with its own best-lap board (also in `GET /api/leaderboards`). The race join's `Static` gains `weather` (`clear`, `rain`, `snow`, `fog`); bots drive by style (`PoRacerAiStyle`) and go round a car they have caught; the bot "Vanguard" is now "Loose Cannon" (Wildcard) |
| `/pobrawl/match-hub` (SignalR) | Rollback protocol: `SubmitInput` takes `{ frame, held, press, sequence }`; new `matchInput` event (each accepted input with the frame the server used) and `Ping` method (clock sync); `matchState` now carries `frame`, `sim` (42 packed ints since 2026-11-20; 38 from 2026-11-13, 26 before) and `checksum` in place of the per-tick swing fields. `press` also takes `Grab` (7) and `Taunt` (8) since 2026-11-20 |

PoBrawl's fighter dossiers quote summaries and portraits from [Wikipedia](https://en.wikipedia.org/)
(text CC BY-SA 4.0); each card links its article with a "From Wikipedia" attribution.
