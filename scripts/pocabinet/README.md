# PoCabinet race harness

PoCabinet's physics runs in two copies that must agree to the last bit:
`src/PoMiniGames.Client/wwwroot/js/pocabinet/physics.js` + `track.js` (solo races in the browser)
and `src/PoMiniGames.API/Features/PoCabinet/` (`PoCabinetPhysics`, `PoCabinetAiDriver`,
`PoCabinetTrack`; the lap verifier and online races). These tools race the browser copy in
node, so track and physics changes can be checked without a browser, and regenerate the lap
proofs the tests replay.

1. Dump the worlds the page hands race.js (the same JSON, from the shared C#):

   ```powershell
   dotnet run scripts/pocabinet/dump.cs -- artifacts/pocabinet-worlds capitol maralago pressbriefing playground senate bedroom today
   ```

   `today` is today's daily circuit; `daily:7` dumps the next seven.

2. Race a 100-car field on one (the player on the demo autopilot from grid slot 50):

   ```powershell
   node scripts/pocabinet/harness.mjs race capitol clean      # or messy / wild; add 1 for rain
   node scripts/pocabinet/harness.mjs profile senate 12       # where the field slows down, per knot
   node scripts/pocabinet/harness.mjs log pressbriefing       # wrecks and stalled cars
   node scripts/pocabinet/harness.mjs svg maralago            # top-down preview: run-off, kerbs, patches, dividers, line
   ```

   A healthy track: the field's median lap within a few seconds of its best, a handful of
   wrecks, few "stuck" events (a car under 5 u/s for 4 s) and no knot where most cars are slow.

3. Regenerate the lap proofs after an intended physics or track change (it searches the
   "messy" driver's line until Capitol orders messy < clean < wild, which
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
& "C:\Program Files\Blender Foundation\Blender 5.2lender.exe" -b --factory-startup --python-exit-code 1 `
  -P scripts/blender/pocabinet-bedroom.py -- <path>\BedroomScene.glb --preview SCREENSHOTS/<yymmdd>-bedroom.png
```

After pasting, dump the world and race it here (step 2) before shipping.
