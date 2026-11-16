# PoFighter: from a phone video to a fighter

Offline tools that turn a video of one performer into `wwwroot/data/pofighter/p1.webp` (sprite
sheet) and `p1.json` (frame rects, anchors, reach). Nothing here runs in CI; every intermediate
stays under `artifacts/pofighter/` (gitignored). The video itself is never committed.

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
#    then: node --test tests/pofighter-sim.test.mjs
```

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
