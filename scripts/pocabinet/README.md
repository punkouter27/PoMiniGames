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
  cannot load.

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

`pocabinet-court.py` also lays and checks a lap of its own on the court floor (`route_plan`) and
prints knots for it. That lap was the retired Center Court track; the circuit's road across the
court is the `// 30-36: across the court` knots in `PoCabinetTrackGeometry`, so ignore the knots
the script prints.

`scene.js` loads the splat through `gaussian-splats-3d` (pinned 0.4.7 in the `index.html` import
map, which works with the three r165 PoCabinet uses). The shader patch in `models.js` matches that
version's text; a different version is drawn unpatched (uncropped), so re-check it on an upgrade.
