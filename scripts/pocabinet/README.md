# PoCabinet race harness

PoCabinet has two tracks, both defined in
`src/PoMiniGames.Shared/Games/PoCabinetTrackGeometry.cs`: **Cabinet Grand Prix** (`grandprix`,
the outdoor circuit, and the one online races run on) and **House Party** (`house`, a toy road
through a scanned house, 1P only; see "The scanned house" below). The physics runs in two copies that must
agree to the last bit: `src/PoMiniGames.Client/wwwroot/js/pocabinet/physics.js` + `track.js` (solo
races in the browser) and `src/PoMiniGames.Api/Features/PoCabinet/` (`PoCabinetPhysics`,
`PoCabinetAiDriver`, `PoCabinetTrack`; the lap verifier and online races). These tools race the
browser copy in node, so a change to the track or the physics can be checked without a browser.

1. Dump the world the page hands race.js (the same JSON, from the shared C#):

   ```powershell
   dotnet run scripts/pocabinet/dump.cs -- artifacts/pocabinet-worlds
   ```

   It writes `grandprix.json` and `house.json`; every command below takes either id.

2. Race the 64-car field on it (the player on the demo autopilot from grid slot 32):

   ```powershell
   node scripts/pocabinet/harness.mjs race grandprix clean      # or messy / wild; add 1 for rain
   node scripts/pocabinet/harness.mjs profile grandprix 12      # where the field slows down, per knot
   node scripts/pocabinet/harness.mjs log grandprix             # wrecks and stalled cars
   node scripts/pocabinet/harness.mjs svg grandprix             # top-down preview, see below
   ```

   A healthy track: no "stuck" events (a car under 5 u/s for 4 s), a handful of wrecks at most
   and no knot where most cars are slow. The race ends when the player finishes, so the field's
   median best lap includes cars that only ran the traffic of lap 1.

   The preview (`artifacts/pocabinet-worlds/grandprix.svg`) draws the run-off, kerbs, patches,
   the divider and the racing line, each knot's `number:height`, the scenery zones as a coloured
   line outside the right-hand barrier (gold stadium, orange Senate Hill, blue court, green
   beach) and the scan: the dashed rectangle is what is drawn of it, the solid one the court's
   lines, the white dots the hoop poles.

After a change to the knots, run the Cabinet unit tests (they lap every official through the
server physics and check the features the circuit ships with):

```powershell
dotnet test tests/PoMiniGames.Unit --filter "FullyQualifiedName~PoCabinet"
```

## Crash debris

Debris is render-only (no piece ever touches the sim), and on the medium and high tiers the
Rapier engine steps it (`wwwroot/js/pocabinet/debris-rapier.js`; the low tier and any device where
Rapier cannot load keep the solver in `debris.js`). The solver file imports nothing from three, so
it also runs in node:

```powershell
node scripts/pocabinet/debris-check.mjs      # once: npm ci --prefix scripts/pocabinet, and the world dump above
```

It builds the real circuit's road and barriers, drops pieces on it and checks eight things: they
settle on the road between the barriers, a bumper dropped on a wheel lies on it, a piece thrown
at a barrier at a car's top speed stays in, a piece dropped on a stopped car does not end up
inside it, a car driven through a pile clears it, a step with the high tier's 160 pieces
stays under 4 ms, the props stand only on run-off clear of the road, the kerbs, the barriers and
each other, and every prop stands still once started until a car moves it. Run it after changing
`debris-rapier.js`, `props.js` or the track's width or run-off.

The props (`wwwroot/js/pocabinet/props.js`: a stack of three tyres at the apex of each bend, a
row of cones along its exit) are the same render-only bodies. Where they stand is a pure function
of the track, so every player sees the same ones; what happens to them is each player's own. A
prop is in neither solver until a car is about to touch it (`debris.js` `rouse()`), and the
engine's road is built from the same points as the road that is drawn (`meshes.js` `ribbon()`),
so a piece lies on the tarmac the player sees.

## Radio voices

The officials' radio lines (`src/PoMiniGames.Shared/Games/PoCabinetDialogue.cs`) are spoken in the
game from clips voiced once, here, by a local text-to-speech model (Kokoro-82M through
`kokoro-js`, on the CPU; its weights, about 90 MB, are fetched from Hugging Face the first time).
Nothing is generated at run time.

```powershell
node scripts/pocabinet/radio-voices.mjs            # voice whatever has no clip yet (needs ffmpeg on PATH)
node scripts/pocabinet/radio-voices.mjs --force    # voice every line again (after changing a voice or the trim)
node scripts/pocabinet/radio-voices.mjs --check    # no model: list lines with no clip, exit 1 if any
```

It writes `wwwroot/audio/pocabinet/radio.json` (official id, line, clip file) and one 16 kHz mono
MP3 a line under `radio/<officialId>/`. A clip's name is a hash of its voice, speed and text, so
a changed line gets a new file and the old one is deleted. Until the script is run again after
an edit, the new line is shown and blipped but not spoken. Each official has one of the model's
stock voices (the `VOICES` table in the script); they imitate nobody.

## The circuit's zones

`PoCabinetTrackDefinition.Zones` names what each stretch of the lap is dressed as; the world
carries them per sample (`zones`) and the scene reads `track.zoneAt(i)`:

| Zone | Knots | What the scene puts there |
|---|---|---|
| `capitol` | 50 to 6 | The start straight and banked turn 1: grandstand, press pen, the dome, the briefing-room wall, the obelisk and its pool, conifers |
| `senate` | 6.5 to 26 | The climb, crest, hairpin, esses and chicane: the temple on the crest, an autumn forest, high hills |
| `court` | 26 to 37 | The run down to and across the scanned basketball court: tarmac run-off with blue limit stripes |
| `maralago` | 37 to 50 | The joker sweeper and the beach road: sand traps, palms, the mansion, golf greens, dunes |

## The scanned house

House Party is a lap through a Gaussian-splat scan of a whole house: bedroom, hall, dining room,
kitchen and living room on one floor, about 17 m by 7 m. `PoCabinetTrackGeometry.House` stands
the scan's origin on the sim's at **800 sim units to the metre**, so a 39-unit car is a ~5 cm toy
and the 105-unit road is 13 cm wide. The road climbs from the floor to 1.83 m (six feet, 1464
units) in front of the bedroom shelves. A race is two laps of about 100 s each, always dry, and
it has no track limits: a lap that long rarely goes by without one off, and the shoulder's drag
is already the price.

What draws it (`wwwroot/js/pocabinet/models.js`, `HOUSE`):

- `wwwroot/models/house.ksplat`: 2,000,000 splats, 48 MB. `house-low.ksplat` is its 250,000
  most important, spread evenly over the house (6 MB): shown first, and all that the low tier,
  the "Lite" setting and a phone draw. There is no mesh.
- Not all of it at once. `platform/3d/splats.js` drops what is outside the view, thins what is
  more than 2 m away to the most important share of each half-metre cube, and keeps to a draw
  budget (800k on high, 550k on medium, 250k on low; the nearest win), set by the tier the scan
  was loaded on. Drawing all 2M ran at 10 fps on a Snapdragon X laptop whatever the resolution.
  The owner chose more house over more frames (2026-11-27): a two-lap race on the medium tier
  (550k) ran at 8 to 38 fps there, mostly 10 to 30, slowest looking down the length of the house.
- The road is a toy track (`buildToyTrack`): moulded plastic with an orange shoulder either
  side (the run-off), a slab under it and a pair of stilts every 25 cm wherever it is more than
  5 cm off the floor. The scene adds no terrain, sky, scenery, grass or rain indoors.

The sim is flat (cars only know how high the road is), so two stretches of road must never share
ground on the plan: the hall carries both lanes side by side, and both squeeze through the
bedroom door beside its open leaf (the road narrows to 0.8 of its width there).

### Rebuilding the house

The capture (`gaussian_pointcloud.ply`, ~5M gaussians, 1.2 GB) is kept out of the repo. Plain
Python 3.10+ with numpy (Pillow too for `--png`); no Blender.

```powershell
# 1. The splat, in the house frame (house-frame.json: metres, floor on z = 0, x along the house).
python scripts/pocabinet/house-scan.py <path>\gaussian_pointcloud.ply <tmp>\house.ply --budget 2000000
python scripts/pocabinet/house-scan.py <path>\gaussian_pointcloud.ply <tmp>\house-low.ply --head 250000
node --max-old-space-size=8192 scripts/pocabinet/ksplat.mjs <tmp>\house.ply src/PoMiniGames.Client/wwwroot/models/house.ksplat
node scripts/pocabinet/ksplat.mjs <tmp>\house-low.ply src/PoMiniGames.Client/wwwroot/models/house-low.ksplat

# 2. The lap: its checks against that splat, and pictures of it (plan.png, profile.png).
python scripts/pocabinet/house-route.py <tmp>\house.ply --png <tmp>

# 3. After moving a knot (KNOTS and WIDTH in house-route.py): print the C# arrays and paste them
#    into HouseDefinition in PoCabinetTrackGeometry.cs, then dump the worlds and race it.
python scripts/pocabinet/house-route.py --cs
dotnet run scripts/pocabinet/dump.cs -- artifacts/pocabinet-worlds
node scripts/pocabinet/harness.mjs race house clean
```

`house-route.py` fails (exit 1) if a bend is tighter than 150 units, two stretches of road come
within 30 units of sharing a barrier, a grade is over 0.24, or the scan has something solid
standing in the road. It checks against gaussians more than 40% opaque only, so look at the lap
in the game too: haze and thin things (a lamp flex, a plant's leaves) do not count as solid.
A healthy lap (2026-11-27, a full-field run of one lap): 61 to 63 of 64 cars finish it, the
median in about 100 s, no car stuck. `house-scan.py --fit` finds the frame of a new capture; the knots are laid in the frame
on file, so a new capture means laying the lap again.

A new scan-only track needs: a `PoCabinetScanWire` with its own `Id`, an entry in `SCANS` in
`models.js`, a definition and a catalog card in `PoCabinetTrackGeometry` / `PoCabinetCatalog`,
and a partition and board id (`StorageService.PoCabinetTrackPartition`,
`UnifiedLeaderboardEndpoints.PoCabinetBoardKey`).

## The scanned court

The lap crosses an outdoor basketball court that is a scan, not a model built in code.
`PoCabinetTrackGeometry.Court` says where it stands: its centre in sim units, 50 sim units to the
metre (a car is a ~78 cm toy), its floor 10 sim units up, and the half extents (metres) of the
rectangle that is drawn: the court and 3.5 m round it. The road is laid 10 sim units over the
floor (the scan's floor is lumpy by about that much), with tarmac run-off either side.

Two files draw it (`wwwroot/js/pocabinet/models.js`):

- `wwwroot/models/court.ksplat`: a Gaussian splat, 400k splats, 9.6 MB (`court-low.ksplat` is
  its first 100k, 2.4 MB, shown first). The scene patches the splat shader to drop everything
  outside the rectangle, fade the edge, and above 0.6 m keep only the two hoops, because the
  trees round the court reach in over it.
- `wwwroot/models/court.glb`: the photogrammetry mesh, clipped to the same rectangle. The low
  graphics tier and the "Lite" scan-detail setting draw it, and it is the fallback when the splat
  cannot load. Its three atlases are KTX2 (Basis ETC1S) and its geometry Meshopt (see below).

Inside the rectangle `terrain.js` steps the scene's own ground down under the scan's floor.

When moving the road on the court, keep clear of the hoops: in the court's frame (metres, x along
the court) the poles stand at x = ±14.5, y = 0, and the boards reach in to x = ±12.9. A bench
stands at x = 0, y = -9.3.

### Rebuilding the scan files

Both come from the same photogrammetry reconstruction (`mesh.glb` and
`gaussian_pointcloud.ply`, kept out of the repo).

```powershell
# court.glb: levels the scan into the court frame (floor on z = 0, x from board A to board B,
# metres), crops it ~25 m round the court, drops the scraps floating in the air, decimates it.
& "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" -b --factory-startup --python-exit-code 1 `
  -P scripts/blender/pocabinet-court.py -- <path>\mesh.glb --preview SCREENSHOTS/<yymmdd>-court.png

# court.ksplat: maps every Gaussian into the same frame, crops it like the mesh and keeps the
# 400k most important, 40% of them reserved for the court floor. Sorted most important first,
# so its first 100k rows are the light version.
& "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" -b --factory-startup --python-exit-code 1 `
  -P scripts/blender/pocabinet-court-splat.py -- <path>\mesh.glb <path>\gaussian_pointcloud.ply <tmp>\court.ply --budget 400000
node scripts/pocabinet/ksplat.mjs <tmp>\court.ply src/PoMiniGames.Client/wwwroot/models/court.ksplat   # once: npm ci --prefix scripts/pocabinet
# court-low.ksplat: the same PLY cut to its first 100,000 vertices, packed the same way.
```

Blender writes `court.glb` with Draco geometry and three JPEG atlases. What ships is that file
repacked (2026-11-20):

```powershell
node scripts/pocabinet/court-pack.mjs <blender's court.glb>     # writes wwwroot/models/court.glb
```

- **Why:** a JPEG atlas is decoded to RGBA on the GPU (32 MB for the three with their mips). As
  KTX2 they stay compressed there: 4 MB on a phone (ETC2), 8 MB on a desktop (BC7). The mesh is
  what the weakest devices draw. The file is 2.27 MB (it was 2.51) and needs no Draco decoder.
- **The price:** ETC1S gives each 4x4 block one hue, so the noisy scan loses some saturation,
  most in the distance (about 3% close up, 10 to 20% in the small mips). `--uastc` keeps the
  colour for a 7 MB file. WebP atlases were also tried: no smaller than the JPEGs at the same
  look.
- **The transcoder** the page runs is `wwwroot/lib/basis/` (`basis_transcoder.js`, `.wasm`, the
  Apache 2.0 `LICENSE`), not three's copy: three's is the stock embind build, which makes
  functions from strings, and the site's Content-Security-Policy has no `'unsafe-eval'`, so every
  texture failed with it. Ours is Basis Universal `v1_60` built with `-s DYNAMIC_EXECUTION=0`:

  ```powershell
  docker run --rm -v "${PWD}/scripts/pocabinet:/work:ro" -v "${PWD}/src/PoMiniGames.Client/wwwroot/lib/basis:/out" emscripten/emsdk:3.1.74-arm64 bash /work/basis-build.sh
  ```

  (drop `-arm64` on an x64 machine). The script fails if the output still holds `new Function`
  or `eval(`. The service worker caches the two files on first use, not at install.

`pocabinet-court.py` also lays and checks a lap of its own on the court floor (`route_plan`) and
prints knots for it. That lap was the retired Center Court track; the circuit's road across the
court is the `// 30-36: across the court` knots in `PoCabinetTrackGeometry`, so ignore the knots
the script prints.

`scene.js` loads the splat through `gaussian-splats-3d` (pinned 0.4.7 in the `index.html` import
map, which works with the three r165 PoCabinet uses). The shader patch in `models.js` matches that
version's text; a different version is drawn unpatched (uncropped), so re-check it on an upgrade.
