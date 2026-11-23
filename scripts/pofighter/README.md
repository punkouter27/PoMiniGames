# PoFighter: from a phone video to a fighter

Offline tools that turn a video of one performer into `wwwroot/data/pofighter/<id>.webp` (sprite
sheet) and `<id>.json` (frame rects, anchors, reach). Each built-in fighter has a moves file here
(`p1.moves.json` is Nick, `kim.moves.json` is Kim) and an entry in `ROSTER` in
`wwwroot/js/pofighter/art.js`; work in `artifacts/pofighter/<id>/` instead of `v2/` for a new one. Nothing here runs in CI; every intermediate
stays under `artifacts/pofighter/` (gitignored). The video itself is never committed.

## Filming: the shot list

Open `scripts/pofighter/shot-list.html` on set (prints too). It lists every move to record (the
required ones, the performer's own **signature** move, recommended ones the game picks up
automatically once packed, and some for later), the camera rules (fixed phone, side-on, same spot),
the voice clips and the win quotes.

**Signature move.** Each fighter can have one special of their own, found in their recording. Add
its frames as a `signature` move (with `"attack": true`) and a top-level block
`"signature": {"name": "Thunder Knee", "button": "kick", "kind": "rush", "damage": 18}` to the
moves file; `pack.py` copies the block into `<id>.json`. Kinds: `strike`, `rush`, `rise`,
`projectile` (`js/pofighter/moves.js` `SIGNATURE_KINDS`). In the game every signature is a half
circle forward (← ↙ ↓ ↘ →) + its button; a fighter without one has none. A top-level
`frameData` block (hand-tuned startup / active / recovery in 60 fps frames) passes through too.

## One-time setup (CPU is fine, no GPU needed)

```powershell
python -m venv artifacts/pofighter/.venv
$py = "artifacts/pofighter/.venv/Scripts/python.exe"
& $py -m pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision
& $py -m pip install ultralytics rembg onnxruntime scipy opencv-python
```

The first run downloads the models: BiRefNet (~1 GB, into `~/.u2net`) and YOLO11m-seg (~45 MB).

## Steps

```powershell
cd artifacts/pofighter
$py = ".venv/Scripts/python.exe"
ffmpeg -i <video.mp4> -q:v 2 -start_number 0 v2/frames/f%04d.jpg      # every picture, numbered from 0
# 1. Pick the frame ranges for each move (look at contact sheets), write them into p1.moves.json.
# 2. Cut the performer out of exactly those frames (about a minute per frame on a CPU; resumable):
& $py -I ../../scripts/pofighter/cutout.py v2/frames v2/cut --frames "4-64:4,196-282:2,..."
# 3. Measure the camera's pan and zoom on the background, per move:
& $py -I ../../scripts/pofighter/camera.py v2/frames v2/cut ../../scripts/pofighter/p1.moves.json
# 4. Pack the sheet and open v2/out/review.html to check every move:
& $py -I ../../scripts/pofighter/pack.py v2/cut ../../scripts/pofighter/p1.moves.json v2/out
# 5. Copy v2/out/p1.webp and p1.json into src/PoMiniGames.Client/wwwroot/data/pofighter/,
# 6. Polish the packed data (works without the cut-outs, so it also fixes an old fighter):
& $py -I ../../scripts/pofighter/retouch.py ../../src/PoMiniGames.Client/wwwroot/data/pofighter ../../scripts/pofighter/p1.retouch.json
#    then: node --test "tests/pofighter-*.test.mjs"
```

## Retouch: smooth hand-overs between moves

`retouch.py` (spec: `<id>.retouch.json`) runs on the packed sheet and data:

- `align`: each one-shot or held move's first picture is shifted to overlap the stance best (the
  get-up's, the knockdown's last picture), its last picture the stance (plus a stepping attack's
  `advance`), eased across the move, so nothing jumps when one move hands over to the next.
- `floor`: no picture's feet below the floor.
- per move: `keep` a range of pictures (Nick's cheer stops before he walks at the phone), `fps`,
  `pin` (keep the body's centre over one spot: Kim's fall crawled forward on video).
- `grade`: a colour grade baked into the sheet. Use it only to correct the *light* (measured on
  something neutral in the video, such as a white wall), never to make people match each other:
  skin and clothes keep their real colours. Kim's and Nick's videos are balanced, so neither is graded.

Sizes: `"scaleFrom": "idle"` in a moves file sizes every move from the stance (corrected by the
camera zoom between the clips, which `camera.py` measures on the background) instead of each
move's own pose; `"scaleAdjust"` corrects a clip filmed nearer the phone (Kim's cheer: 0.81, her
head measured 23% bigger). Detail is set by the video: `res` 1.75 already matches what a 1080p
phone gives a 373-unit fighter, so a sharper fighter needs 4K footage, not a bigger sheet.

## After packing: portrait, roster, voices

- `python -I scripts/pofighter/portrait.py src/PoMiniGames.Client/wwwroot/data/pofighter <id>` writes
  `<id>-portrait.webp`, the 4x4 select grid's tile.
- Add the fighter to `ROSTER` in `wwwroot/js/pofighter/art.js` (the game) **and** to `PoFighterRoster`
  in `src/PoMiniGames.Shared/Games/PoFighterRoster.cs` (the Elo board accepts only listed ids); give
  it a procedural voice in `VOICES` in `wwwroot/js/pofighter/voice.js` (pitch, wave, formant).
- Voice clips: `wwwroot/audio/pofighter/<id>/<mood>-<level>.wav` (moods angry, happy, hurt, insult,
  celebrate; levels 1-5), then `pwsh scripts/pofighter/voices.ps1` trims each new clip's silence, normalises it to -16 LUFS and writes it as mono 24 kHz (ffmpeg; the original goes to `scripts/pofighter/voices-raw/<id>/`, `-Force` reprocesses from there, `-NoProcess` skips it) and rewrites `voices.json` (every fighter × mood × level with its file, `exists` and the fighter's procedural voice profile; a cell with no clip plays the procedural imitation in `js/platform/emotionVoice.js`). `-Game pobrawl` does the same for PoBrawl's presidents (`wwwroot/audio/pobrawl/<id>/`, originals in `scripts/pobrawl/voices-raw/`).

## A quicker draft cut

`cutout.py --model isnet-general-use` cuts a picture in about 9 s instead of about 70 s (BiRefNet), with softer
edges. Kim's sheet was first packed from such a draft (`artifacts/pofighter/kim/cutisnet`); the
BiRefNet cut (`kim/cut`, resumable) replaces it with no code change. Two of Kim's traps: a pink bag
behind the squat (cleared by colour) and a blanket the person model picked instead of her in a few
camera-swing frames (dropped from `getUp` and `ko` with explicit `frames` lists).

## Why two models

- **YOLO person segmentation** knows what a *person* is, so a bin, a chair leg or a speaker
  standing behind the performer's legs is never kept. Its outline is coarse.
- **BiRefNet** draws a sharp outline (hair, fingers, toes) but keeps any object touching the
  performer. It runs on a crop around the performer, so it sees them large.

The kept alpha is BiRefNet's, limited to a slightly grown YOLO mask, then the largest blob.

## The moves file

See the docstring at the top of `pack.py` for every key. In short: `from`/`to`/`step` (or an
explicit `frames` list) choose pictures; `anchor` is `world` (keep the filmed body motion) or
`track` (re-centre, the game supplies the travel); `ground: hold` keeps a jump's floor; `rate`
speeds a move up; `reverse` plays it backwards; `advance` moves the fighter by the distance a
step-in attack travelled; `refFrame`/`anchorFrame` name the standing picture for a reversed move;
`colorMatch` evens out the phone's exposure; `res` bakes the sheet at that many pixels per world
unit (p1 uses 1.75, about the video's own detail) so the fighter stays sharp when the canvas scales
the world up — anchors stay in world units and the engine draws each cell at `w / res`.

`mirror: true` is for a performer filmed facing screen-left (Kim): every cell is flipped and the
travel changes sign, so the game still gets a fighter facing right.

## Picking ranges for smooth joins

Every move starts and (for one-shots) returns to the idle stance with a hard cut, so:

- a walk's range is one whole stride cycle (its last picture is one step before its first);
- a one-shot ends on the picture that looks most like the stance (the jump at its most upright
  landing, the kick once the leg is down);
- a move the performer travels in either keeps that travel (`advance`) or is re-centred
  (`anchor: track` with `speed: 0`, the cheer), so the stance never jumps back on the floor.

## Known trap: the black bag

In the crouch/jump stretch (frames 898–908) the performer squats right in front of a black bag;
YOLO counts it as body, and it is no darker than the trousers in shadow, so neither the models nor
a brightness cut can drop it. `crouch` therefore uses the wind-up of a dive (968–982), and `jump`
starts at 910 with `refFrame` 914 (an upright picture sets its size).
