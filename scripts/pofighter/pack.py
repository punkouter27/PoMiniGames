"""Pack chosen cut-out frames into one sprite sheet plus a review page (PoFighter, offline tool).

Usage: python -I pack.py <cut_dir> <moves.json> <out_dir>

Outputs <fighter>.webp (sheet), <fighter>.json (frame rects and anchors) and review.html.
Every frame's anchor is the point that sits on the fighter's ground position in the game:
x = the body's centre line, y = the ground line. "world" moves keep the body motion that
was filmed (one anchor for the whole move); "track" moves (walks) are re-centred per frame
so the game supplies the travel, at the "speed" measured from the footage. "rate" plays a
move faster than it was filmed (and scales a walk's speed with it).
"""
import json
import pathlib
import sys

import numpy as np
from PIL import Image


def torso_x(alpha: np.ndarray, ground: int, stand: int) -> float:
    """Centre of the hip/belly band; arms and legs barely move it."""
    band = alpha[ground - int(stand * 0.62): ground - int(stand * 0.42)] > 96
    xs = np.nonzero(band)[1]
    return float(xs.mean()) if len(xs) else alpha.shape[1] / 2


def main() -> None:
    cut, cfg_path, out = (pathlib.Path(a) for a in sys.argv[1:4])
    cfg = json.loads(cfg_path.read_text())
    out.mkdir(parents=True, exist_ok=True)
    scale, ground, stand = cfg["scale"], cfg["groundY"], cfg["standHeight"]

    cells, meta = [], {}
    for name, mv in cfg["moves"].items():
        ids = list(range(mv["from"], mv["to"] + 1, mv["step"]))
        imgs = [Image.open(cut / f"f{i:04d}.png") for i in ids]
        alphas = [np.array(im)[..., 3] for im in imgs]
        xs = [torso_x(a, ground, stand) for a in alphas]
        # Walks travel at the speed the performer really moved, so the feet do not slide.
        rate = mv.get("rate", 1)
        seconds = (ids[-1] - ids[0]) / cfg["sourceFps"]
        travel = (xs[-1] - xs[0]) * scale / seconds * rate if mv["anchor"] == "track" else None
        if mv["anchor"] == "world":
            xs = [xs[0]] * len(xs)
        else:  # light smoothing so the walk does not jitter
            xs = list(np.convolve(np.pad(xs, 1, mode="edge"), [0.25, 0.5, 0.25], mode="valid"))
        frames = []
        for i, im, a, ax in zip(ids, imgs, alphas, xs):
            ys, cols = np.nonzero(a > 24)
            x0, y0, x1, y1 = cols.min(), ys.min(), cols.max() + 1, ys.max() + 1
            crop = im.crop((x0, y0, x1, y1))
            size = (max(1, round(crop.width * scale)), max(1, round(crop.height * scale)))
            crop = crop.resize(size, Image.LANCZOS)
            # r = how far the outline reaches in front of the anchor; attacks hit with it.
            frames.append({"src": i, "ax": round((ax - x0) * scale, 1), "ay": round((ground - y0) * scale, 1),
                           "r": round((x1 - ax) * scale, 1)})
            cells.append((crop, frames[-1]))
        meta[name] = {"loop": mv["loop"], "fps": cfg["sourceFps"] / mv["step"] * rate, "frames": frames}
        if travel is not None:
            meta[name]["speed"] = round(travel, 1)
        if mv.get("attack"):
            # A picture can hit once the limb is past 60% of its full extension.
            reach = [f["r"] for f in frames]
            meta[name]["hitMin"] = round(reach[0] + 0.6 * (max(reach) - reach[0]), 1)

    # Shelf packing, tallest first.
    width, pad = 2048, 2
    x = y = shelf = 0
    for crop, f in sorted(cells, key=lambda c: -c[0].height):
        if x + crop.width + pad > width:
            x, y, shelf = 0, y + shelf + pad, 0
        f.update(x=x, y=y, w=crop.width, h=crop.height)
        x += crop.width + pad
        shelf = max(shelf, crop.height)
    sheet = Image.new("RGBA", (width, y + shelf), (0, 0, 0, 0))
    for crop, f in cells:
        sheet.paste(crop, (f["x"], f["y"]))

    fighter = cfg["fighter"]
    sheet.save(out / f"{fighter}.webp", quality=88, method=6)
    data = {"fighter": fighter, "sheet": f"{fighter}.webp", "standHeight": round(stand * scale), "moves": meta}
    (out / f"{fighter}.json").write_text(json.dumps(data, separators=(",", ":")))

    template = (pathlib.Path(__file__).parent / "review.template.html").read_text(encoding="utf-8")
    (out / "review.html").write_text(template.replace("/*DATA*/null", json.dumps(data)), encoding="utf-8")
    kb = (out / f"{fighter}.webp").stat().st_size // 1024
    print(f"{len(cells)} frames, sheet {sheet.width}x{sheet.height}, {kb} KB -> {out}")


if __name__ == "__main__":
    main()
