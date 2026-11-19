"""Polish a packed fighter's animation without its cut-outs (PoFighter, offline tool).

Usage: python -I retouch.py <data_dir> <spec.json>

Works on <data_dir>/<fighter>.json and its sprite sheet, so a fighter can be fixed even when
its video and cut-outs are gone. The spec (scripts/pofighter/<id>.retouch.json):

  "fighter": "kim"
  "align": true        line every one-shot and held move up with what it starts from and ends in:
                       its first picture with the stance (getUp: with the knockdown's last picture),
                       its last picture with the stance (shifted by "advance" for a stepping attack).
                       The offset is the horizontal shift with the best silhouette overlap, eased
                       across the move, so the body never jumps when one move hands over to the next.
  "floor": true        no picture's feet below the floor (a filmed jump that lands lower than it
                       took off would sink and then snap up).
  "moves": { "<move>": { "keep": [first, last], "fps": n, "align": false, "pin": true } }
                       keep a range of pictures (inclusive indices), set the frame rate, leave one
                       move unaligned, or pin it: keep the body's centre over its first picture's,
                       so a fall that crawled forward on video drops in place.
  "grade": { "exposure": 1.0, "white": [r, g, b], "saturation": 1.0, "contrast": 1.0 }
                       a colour grade baked into the sheet's opaque pixels, so fighters filmed under
                       different light match each other and the arena.

Run it after every pack.py (it reads the packed data, not the moves file). Re-running it on
already-retouched data is safe: alignment finds no offset left, the grade is not idempotent, so
pack again before re-grading.
"""
import json
import pathlib
import sys

import numpy as np
from PIL import Image

SEARCH = 90          # world units searched each way for the best overlap
STANCE = "idle"


def mask(sheet: Image.Image, f: dict, res: float) -> np.ndarray:
    cell = sheet.crop((f["x"], f["y"], f["x"] + f["w"], f["y"] + f["h"]))
    w, h = max(1, round(f["w"] / res)), max(1, round(f["h"] / res))
    return np.array(cell.getchannel("A").resize((w, h), Image.BILINEAR)) > 128


def place(m: np.ndarray, f: dict, x: float, canvas: tuple[int, int], ground: int) -> np.ndarray:
    """The picture's silhouette on a canvas with its anchor at (x, ground)."""
    out = np.zeros(canvas, bool)
    left, top = round(x - f["ax"]), round(ground - f["ay"])
    h, w = m.shape
    y0, x0 = max(0, top), max(0, left)
    y1, x1 = min(canvas[0], top + h), min(canvas[1], left + w)
    if y1 > y0 and x1 > x0:
        out[y0:y1, x0:x1] = m[y0 - top:y1 - top, x0 - left:x1 - left]
    return out


def best_shift(sheet, res, f, target, target_x) -> int:
    """How far right to move picture f so it overlaps the target picture (at target_x) best."""
    canvas, ground, cx = (900, 1100), 820, 550
    a = place(mask(sheet, f, res), f, cx, canvas, ground)
    b = place(mask(sheet, target, res), target, cx + target_x, canvas, ground)
    if not a.any() or not b.any():
        return 0
    cols_b = b
    best, best_dx = -1.0, 0
    for dx in range(-SEARCH, SEARCH + 1):
        s = np.roll(a, dx, axis=1)
        inter = np.logical_and(s, cols_b).sum()
        union = np.logical_or(s, cols_b).sum()
        iou = inter / union if union else 0
        # Prefer the smaller shift when two are as good, so a still body is not nudged.
        if iou > best + 1e-4 or (abs(iou - best) <= 1e-4 and abs(dx) < abs(best_dx)):
            best, best_dx = iou, dx
    return best_dx


def grade(sheet: Image.Image, g: dict) -> Image.Image:
    px = np.array(sheet).astype(np.float32)
    rgb, a = px[..., :3] / 255, px[..., 3]
    rgb = rgb * g.get("exposure", 1.0) * np.array(g.get("white", [1, 1, 1]), np.float32)
    luma = (rgb * [0.2126, 0.7152, 0.0722]).sum(axis=2, keepdims=True)
    rgb = luma + (rgb - luma) * g.get("saturation", 1.0)
    rgb = 0.5 + (rgb - 0.5) * g.get("contrast", 1.0)
    px[..., :3] = np.where(a[..., None] > 0, np.clip(rgb, 0, 1) * 255, px[..., :3])
    return Image.fromarray(px.round().astype(np.uint8))


def main() -> None:
    data_dir, spec_path = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
    spec = json.loads(spec_path.read_text())
    meta_path = data_dir / f"{spec['fighter']}.json"
    data = json.loads(meta_path.read_text())
    sheet = Image.open(data_dir / data["sheet"]).convert("RGBA")
    res = data.get("res", 1)
    moves = data["moves"]

    for name, ops in spec.get("moves", {}).items():
        mv = moves.get(name)
        if not mv:
            continue
        if "keep" in ops:
            a, b = ops["keep"]
            mv["frames"] = mv["frames"][a:b + 1]
        if "fps" in ops:
            mv["fps"] = ops["fps"]

    for name, ops in spec.get("moves", {}).items():
        mv = moves.get(name)
        if not mv or not ops.get("pin"):
            continue
        def centre(f):
            m = mask(sheet, f, res)
            xs = np.nonzero(m.any(axis=0))[0]
            cols = m.sum(axis=0)
            return float((np.arange(m.shape[1]) * cols).sum() / max(1, cols.sum())) - f["ax"] if len(xs) else 0.0
        c0 = centre(mv["frames"][0])
        for f in mv["frames"][1:]:
            shift = c0 - centre(f)          # move the picture so its centre sits where the first one's did
            f["ax"] = round(f["ax"] - shift, 1)
            f["r"] = round(f["r"] + shift, 1)
        print(f"{name}: pinned in place")

    if spec.get("align"):
        stance = moves[STANCE]["frames"][0]
        for name, mv in moves.items():
            if name == STANCE or mv["loop"] not in ("once", "hold") or not spec.get("moves", {}).get(name, {}).get("align", True):
                continue
            frames = mv["frames"]
            start_target = moves["ko"]["frames"][-1] if name == "getUp" and "ko" in moves else stance
            s0 = best_shift(sheet, res, frames[0], start_target, 0)
            # A held move (crouch, knockdown) never hands back to the stance from its last picture.
            s1 = best_shift(sheet, res, frames[-1], stance, mv.get("advance", 0)) if mv["loop"] == "once" else s0
            n = len(frames)
            for i, f in enumerate(frames):
                u = i / (n - 1) if n > 1 else 0
                shift = s0 * (1 - u) + s1 * u
                f["ax"] = round(f["ax"] - shift, 1)
                f["r"] = round(f["r"] + shift, 1)   # the reach is measured from the anchor too
            if "hitMin" in mv:
                reach = [f["r"] for f in frames]
                mv["hitMin"] = round(reach[0] + 0.6 * (max(reach) - reach[0]), 1)
            print(f"{name}: start shift {s0:+d}, end shift {s1:+d}")

    if spec.get("floor"):
        sunk = 0
        for mv in moves.values():
            for f in mv["frames"]:
                feet = f["h"] / res
                if f["ay"] < feet - 0.5:
                    f["ay"] = round(feet, 1)
                    sunk += 1
        print(f"floor: {sunk} picture(s) lifted onto the floor")

    if "grade" in spec:
        sheet = grade(sheet, spec["grade"])
        sheet.save(data_dir / data["sheet"], quality=90, alpha_quality=100, method=6)
        print("grade:", spec["grade"])

    meta_path.write_text(json.dumps(data, separators=(",", ":")))
    print(f"retouched {meta_path}")


if __name__ == "__main__":
    main()
