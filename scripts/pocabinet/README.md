# PoCabinet race harness

PoCabinet's physics runs in two copies that must agree to the last bit:
`src/PoMiniGames.Client/wwwroot/js/pocabinet/physics.js` + `track.js` (solo races in the browser)
and `src/PoMiniGames.API/Features/PoCabinet/` (`PoCabinetPhysics`, `PoCabinetAiDriver`,
`PoCabinetTrack`; the lap verifier and online races). These tools race the browser copy in
node, so track and physics changes can be checked without a browser, and regenerate the lap
proofs the tests replay.

1. Dump the worlds the page hands race.js (the same JSON, from the shared C#):

   ```powershell
   dotnet run scripts/pocabinet/dump.cs -- artifacts/pocabinet-worlds capitol maralago pressbriefing playground senate bedroom court today
   ```

   `today` is today's daily circuit; `daily:7` dumps the next seven.

2. Race a 64-car field on one (the player on the demo autopilot from grid slot 32):

   ```powershell
   node scripts/pocabinet/harness.mjs race capitol clean      # or messy / wild; add 1 for rain
   node scripts/pocabinet/harness.mjs profile senate 12       # where the field slows down, per knot
   node scripts/pocabinet/harness.mjs log pressbriefing       # wrecks and stalled cars
   node scripts/pocabinet/harness.mjs svg maralago            # top-down preview: run-off, kerbs, patches, dividers, line
   ```

   A healthy track: the field's median lap within a few seconds of its best, a handful of
   wrecks, few "stuck" events (a car under 5 u/s for 4 s) and no knot where most cars are slow.

3. Regenerate the lap proofs after an intended physics, track or field change (it searches the
   "wild" driver's swerve period and the "messy" driver's line until Capitol orders
   messy < clean < wild, which
   `PoCabinetScoreStorageTests` needs):

   ```powershell
   node scripts/pocabinet/gen.mjs tests/Shared/Fixtures/pocabinet-lap-proofs.txt
   dotnet test tests/PoMiniGames.Unit --filter "FullyQualifiedName~PoCabinet"
   ```

   `PoCabinetLapVerifierTests` replays every proof in C# and needs the browser's lap time
   exactly; a mismatch means the two copies have drifted apart.

## Bedroom Floor GP (a track built from a room scan)

`scripts/blender/pocabinet-bedroom.py` builds the bedroom track in headless Blender from the
merged room scan (`BedroomScene.glb`, kept out of the repo). It stands the scan up, cuts the
ceiling, decimates it, shrinks the textures and writes `wwwroot/models/bedroom.glb`
(Draco). It also checks the hand-laid `ROUTE` against the room: every road sample's corridor
must clear the furniture, the road must sit on whatever it crosses, and no two parts of the
lap may overlap. Then it prints the knots, `KnotZ` and `KnotBank` to paste into
`PoCabinetTrackGeometry["bedroom"]`:

```powershell
& "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" -b --factory-startup --python-exit-code 1 `
  -P scripts/blender/pocabinet-bedroom.py -- <path>\BedroomScene.glb --preview SCREENSHOTS/<yymmdd>-bedroom.png
```

After pasting, dump the world and race it here (step 2) before shipping.

- `--nudge`: when the check fails, the script moves knots one at a time in shrinking steps,
  keeping any move that lowers the problem count, and prints a repaired `ROUTE` to paste back.
- `--fixture tests/Shared/Fixtures/pocabinet-bedroom-centerline.json`: writes the script's own
  centerline samples. `PoCabinetTests` compares them with `BuildCenterlineXY("bedroom")`, so the
  road the script cleared of furniture is provably the road the race runs on. Re-run it whenever
  `ROUTE` changes.

## Race health in CI

`tests/pocabinet-race-health.test.mjs` races the 64-car field (clean and messy drivers) on
Capitol, the Bedroom Floor GP and Rim to Rim through `harness.mjs` and fails on a jam, a wreck-fest or a
strung-out field. The bounds sit above today's numbers; the harness is deterministic.

```powershell
dotnet run scripts/pocabinet/dump.cs -- artifacts/pocabinet-worlds capitol bedroom court
node --test tests/pocabinet-race-health.test.mjs
```

### The room as a Gaussian splat

The room is drawn from a separate 3DGS capture (`scene.ply`, 2.4M splats, base colour only). The
mesh above stays the collision model: the route is checked against it. To rebuild
`wwwroot/models/bedroom.ksplat`:

```powershell
# 1. Register the splat onto the mesh (similarity ICP, then point-to-surface; prints the median
#    error, ~0.034 room units = under a centimetre), crop it like the mesh, keep the 400k most
#    important splats, write a plain 3DGS PLY.
& "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" -b --factory-startup --python-exit-code 1 `
  -P scripts/blender/pocabinet-bedroom-splat.py -- <path>\BedroomScene.glb <path>\scene.ply <tmp>\bedroom-room.ply --budget 400000

# 2. Pack it for gaussian-splats-3d (once: npm ci --prefix scripts/pocabinet).
node scripts/pocabinet/ksplat.mjs <tmp>\bedroom-room.ply src/PoMiniGames.Client/wwwroot/models/bedroom.ksplat
```

`scene.js` loads it through `gaussian-splats-3d` (pinned 0.4.7 in the `index.html` import map,
which works with the three r165 PoCabinet uses). The low graphics tier keeps the mesh, which is
also the fallback if the splat fails to load.

## Rim to Rim (a track built from a basketball-court scan)

`scripts/blender/pocabinet-court.py` builds the court track in headless Blender from the
photogrammetry mesh of an outdoor court (`mesh.glb`, kept out of the repo). It levels the scan
into the court frame (fits the floor plane, finds both backboards between 3.2 and 4.0 m up; floor
on z = 0, metres, x from board A to board B), crops it ~25 m round the court, drops the scraps
floating in the air (never the hoops), decimates it and writes `wwwroot/models/court.glb`. The
lap is laid from lines and arcs in `route_plan`: the start line over rim A, a corkscrew down round
the centre circle under its own flyover, the climb onto rim B half way round, then the back leg.
The script checks the car's space over every road sample is clear of the scan, nothing stands in
the corridor (the road crosses each rim parallel to its board), the flyover clears the road under
it by 0.6 m, and no grade passes 20%. It prints the knots, `KnotZ`, `KnotBank` and `KnotWidth`
for `PoCabinetTrackGeometry["court"]` at 100 sim units per metre:

```powershell
& "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" -b --factory-startup --python-exit-code 1 `
  -P scripts/blender/pocabinet-court.py -- <path>\mesh.glb --preview SCREENSHOTS/<yymmdd>-court.png `
  --fixture tests/Shared/Fixtures/pocabinet-court-centerline.json
```

The splat is the same reconstruction as the mesh, so it needs no registration, only the same
frame. `pocabinet-court-splat.py` maps every Gaussian into it, prints how far the solid ones sit
from the mesh (~9 cm, the floor's own noise), crops it like the mesh and keeps the 400k most
important, 40% of them reserved for the court floor (flat discs a volume ranking would trade for
the trees). The file is sorted most important first, so its first 100k rows are the light version:

```powershell
& "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" -b --factory-startup --python-exit-code 1 `
  -P scripts/blender/pocabinet-court-splat.py -- <path>\mesh.glb <path>\gaussian_pointcloud.ply <tmp>\court.ply --budget 400000
node scripts/pocabinet/ksplat.mjs <tmp>\court.ply src/PoMiniGames.Client/wwwroot/models/court.ksplat
# court-low.ksplat: the same PLY cut to its first 100,000 vertices, packed the same way.
```
