# PoCabinet race harness

PoCabinet has one circuit, **Cabinet Grand Prix** (`grandprix`), defined in
`src/PoMiniGames.Shared/Games/PoCabinetTrackGeometry.cs`. Its physics runs in two copies that must
agree to the last bit: `src/PoMiniGames.Client/wwwroot/js/pocabinet/physics.js` + `track.js` (solo
races in the browser) and `src/PoMiniGames.Api/Features/PoCabinet/` (`PoCabinetPhysics`,
`PoCabinetAiDriver`, `PoCabinetTrack`; the lap verifier and online races). These tools race the
browser copy in node, so a change to the track or the physics can be checked without a browser.

1. Dump the world the page hands race.js (the same JSON, from the shared C#):

   ```powershell
   dotnet run scripts/pocabinet/dump.cs -- artifacts/pocabinet-worlds
   ```

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
