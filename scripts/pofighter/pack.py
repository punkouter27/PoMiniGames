"""Pack chosen cut-out frames into one sprite sheet plus a review page (PoFighter, offline tool).

Usage: python -I pack.py <cut_dir> <moves.json> <out_dir>

Outputs <fighter>.webp (sheet), <fighter>.json (frame rects and anchors) and review.html.
Every frame's anchor is the point that sits on the fighter's ground position in the game:
x = the body's centre line, y = the ground line. "anchorFrame" names the picture whose torso
fixes a world move's spot (default: the first one played).

  "world" moves keep the body motion that was filmed: one spot on the floor anchors the
          whole move. "advance" moves (a punch that steps in) also carry the fighter forward by the distance
          the body really travelled, once the move ends.
  "track" moves (walks) are re-centred per frame so the game supplies the travel, at the
          "speed" measured from the footage (or stated in the config).
  "rate"  plays a move faster than it was filmed (and scales a walk's speed with it).

When camera.json (from camera.py) sits in the cut folder, each picture is corrected for the
camera's pan and zoom: the fighter keeps one size through a move even if the phone zoomed,
world moves stay pinned to the floor while the phone panned, and travel is measured in the
room, not on the screen. Without it every picture is treated as filmed by a still camera.

A move's size is set so its reference picture ("refFrame", default the first one played)
stands `standHeight` tall, unless it gives an explicit "scale". The ground line is the
bottom of the outline in each picture ("ground": "feet"); a move marked "ground": "hold"
(a jump) keeps the floor of its first picture so the leap keeps its height.

"colorMatch": true evens out the phone's exposure and white balance: every picture's
performer is matched to the first idle picture's colours, smoothed over neighbouring frames.

"res" (default 1) bakes the sheet at that many pixels per world unit so the fighter stays sharp
when the canvas scales the world up. Anchors ("ax", "ay") and reach ("r") stay in world units;
the sheet rect ("x", "y", "w", "h") is in sheet pixels, so readers draw it at w / res.
Frames are resized with premultiplied alpha (no halo from the hidden room colours), and
identical cells (a getUp that replays the knockdown) are stored once.
"""
import hashlib
import json
import pathlib
import sys

import numpy as np
from PIL import Image

IDENTITY = [1, 0, 0, 0, 1, 0]


def torso_x(alpha: np.ndarray, ground: int, stand: float) -> float:
    """Centre of the hip/belly band; arms and legs barely move it."""
    band = alpha[max(0, ground - int(stand * 0.62)): max(1, ground - int(stand * 0.42))] > 96
    xs = np.nonzero(band)[1]
    if not len(xs):
        xs = np.nonzero(alpha > 96)[1]
    return float(xs.mean()) if len(xs) else alpha.shape[1] / 2


def feet(alpha: np.ndarray) -> int:
    """Row of the ground under the fighter in this picture (the bottom of the outline)."""
    ys = np.nonzero((alpha > 24).any(axis=1))[0]
    return int(ys[-1]) + 1 if len(ys) else alpha.shape[0]


def height(alpha: np.ndarray) -> int:
    ys = np.nonzero((alpha > 96).any(axis=1))[0]
    return int(ys[-1] - ys[0] + 1) if len(ys) else 1


def mat(t: list) -> np.ndarray:
    return np.vstack([np.array(t, np.float64).reshape(2, 3), [0, 0, 1]])


def apply(m: np.ndarray, x: float, y: float) -> tuple[float, float]:
    p = m @ np.array([x, y, 1.0])
    return float(p[0]), float(p[1])


def zoom(m: np.ndarray) -> float:
    return float(np.hypot(m[0, 0], m[0, 1]))


def colour(rgba: np.ndarray) -> np.ndarray:
    """Median colour of the performer (opaque pixels only)."""
    px = rgba[rgba[..., 3] > 200][:, :3].astype(np.float32)
    return np.median(px, axis=0) if len(px) else np.array([128, 128, 128], np.float32)


def main() -> None:
    cut, cfg_path, out = (pathlib.Path(a) for a in sys.argv[1:4])
    cfg = json.loads(cfg_path.read_text())
    out.mkdir(parents=True, exist_ok=True)
    camera_path = cut / "camera.json"
    camera = json.loads(camera_path.read_text()) if camera_path.exists() else {}
    stand_px, default_ground = cfg["standPx"], cfg.get("ground", "feet")
    fps = cfg["sourceFps"]
    res = float(cfg.get("res", 1))

    reference_colour = None
    if cfg.get("colorMatch"):
        idle = cfg["moves"]["idle"]
        first = idle["frames"][0] if "frames" in idle else idle["from"]
        reference_colour = colour(np.array(Image.open(cut / f"f{first:04d}.png")))

    cells, meta = [], {}
    for name, mv in cfg["moves"].items():
        ids = mv["frames"] if "frames" in mv else list(range(mv["from"], mv["to"] + 1, mv["step"]))
        span = (max(ids) - min(ids)) or 1
        gap = mv.get("step") or (int(np.median(np.diff(sorted(ids)))) if len(ids) > 1 else 1)
        if mv.get("reverse"):
            ids = ids[::-1]   # a forward walk played backwards is a backwards walk
        cam = camera.get(name, {})
        # to_ref: this picture's pixels -> the move's reference picture (camera.json).
        to_ref = [mat(cam.get(f"f{i:04d}", IDENTITY)) for i in ids]
        from_ref = [np.linalg.inv(m) for m in to_ref]
        imgs = [np.array(Image.open(cut / f"f{i:04d}.png")) for i in ids]
        alphas = [im[..., 3] for im in imgs]

        # One size for the whole move: the reference picture stands stand_px tall.
        ref = ids.index(mv["refFrame"]) if "refFrame" in mv else 0
        ref_height_in_ref = height(alphas[ref]) * zoom(to_ref[ref])
        base = mv.get("scale") or stand_px / ref_height_in_ref
        scales = [base * zoom(m) for m in to_ref]

        mode = mv.get("ground", default_ground)
        grounds = [feet(a) for a in alphas]
        stands = [ref_height_in_ref / zoom(m) for m in to_ref]   # standing height, this picture
        xs = [torso_x(a, g, s) for a, g, s in zip(alphas, grounds, stands)]
        # The anchor picture's torso on its floor, as a point in the room (reference coords).
        # Default: the first picture played; a move played backwards names its standing one.
        a0 = ids.index(mv["anchorFrame"]) if "anchorFrame" in mv else 0
        room = apply(to_ref[a0], xs[a0], grounds[a0])
        if mode == "hold":
            grounds = [apply(m, *room)[1] for m in from_ref]
        room_x = [apply(m, x, g)[0] for m, x, g in zip(to_ref, xs, grounds)]
        rate = mv.get("rate", 1)
        seconds = span / fps / rate
        travel = (room_x[-1] - room_x[a0 if mv.get("advance") else 0]) * base

        if mv["anchor"] == "world":
            xs = [apply(m, *room)[0] for m in from_ref]
        else:  # light smoothing so the walk does not jitter
            xs = list(np.convolve(np.pad(xs, 1, mode="edge"), [0.25, 0.5, 0.25], mode="valid"))

        gains = [np.ones(3, np.float32)] * len(ids)
        if reference_colour is not None:
            raw = np.array([np.clip(reference_colour / np.maximum(colour(im), 1), 0.8, 1.25) for im in imgs])
            k = min(5, len(raw))
            pad = np.pad(raw, ((k // 2, k - 1 - k // 2), (0, 0)), mode="edge")
            gains = [pad[j:j + k].mean(axis=0) for j in range(len(raw))]

        frames = []
        for i, im, a, ax, g, sc, gain in zip(ids, imgs, alphas, xs, grounds, scales, gains):
            ys, cols = np.nonzero(a > 24)
            x0, y0, x1, y1 = cols.min(), ys.min(), cols.max() + 1, ys.max() + 1
            px = im[y0:y1, x0:x1].astype(np.float32)
            px[..., :3] = np.clip(px[..., :3] * gain, 0, 255)
            crop = Image.fromarray(px.astype(np.uint8))
            size = (max(1, round(crop.width * sc * res)), max(1, round(crop.height * sc * res)))
            # Premultiplied: the room's colour under transparent pixels must not bleed in.
            crop = crop.convert("RGBa").resize(size, Image.LANCZOS).convert("RGBA")
            # r = how far the outline reaches in front of the anchor; attacks hit with it.
            frames.append({"src": i, "ax": round((ax - x0) * sc, 1), "ay": round((g - y0) * sc, 1),
                           "r": round((x1 - ax) * sc, 1)})
            cells.append((crop, frames[-1]))
        meta[name] = {"loop": mv["loop"], "fps": round(fps / gap * rate, 3), "frames": frames}
        if "speed" in mv:
            meta[name]["speed"] = mv["speed"]
        elif mv["anchor"] == "track":
            meta[name]["speed"] = round(travel / seconds, 1)
        if mv.get("advance"):
            meta[name]["advance"] = round(travel, 1)
        if mv.get("attack"):
            # A picture can hit once the limb is past 60% of its full extension.
            reach = [f["r"] for f in frames]
            meta[name]["hitMin"] = round(reach[0] + 0.6 * (max(reach) - reach[0]), 1)
        print(f"{name}: {len(frames)} frames, size x{base:.3f}, zoom {min(scales) / base:.2f}-"
              f"{max(scales) / base:.2f}, travel {travel:+.0f}px")

    # Identical pictures (a reversed move replaying another) share one cell.
    unique: dict[str, tuple[Image.Image, list[dict]]] = {}
    for crop, f in cells:
        key = hashlib.sha1(crop.tobytes() + repr(crop.size).encode()).hexdigest()
        unique.setdefault(key, (crop, []))[1].append(f)

    # Shelf packing, tallest first; a wide gap so smoothing never samples a neighbour.
    width, pad = 2048 if res <= 1 else 4096, 4
    x = y = shelf = 0
    for crop, fs in sorted(unique.values(), key=lambda c: -c[0].height):
        if x + crop.width + pad > width:
            x, y, shelf = 0, y + shelf + pad, 0
        for f in fs:
            f.update(x=x, y=y, w=crop.width, h=crop.height)
        x += crop.width + pad
        shelf = max(shelf, crop.height)
    sheet = Image.new("RGBA", (width, y + shelf), (0, 0, 0, 0))
    for crop, fs in unique.values():
        sheet.paste(crop, (fs[0]["x"], fs[0]["y"]))

    fighter = cfg["fighter"]
    sheet.save(out / f"{fighter}.webp", quality=90, alpha_quality=100, method=6)
    data = {"fighter": fighter, "sheet": f"{fighter}.webp", "standHeight": stand_px, "res": res, "moves": meta}
    (out / f"{fighter}.json").write_text(json.dumps(data, separators=(",", ":")))

    template = (pathlib.Path(__file__).parent / "review.template.html").read_text(encoding="utf-8")
    (out / "review.html").write_text(template.replace("/*DATA*/null", json.dumps(data)), encoding="utf-8")
    kb = (out / f"{fighter}.webp").stat().st_size // 1024
    print(f"{len(cells)} frames ({len(unique)} unique), sheet {sheet.width}x{sheet.height}, {kb} KB -> {out}")


if __name__ == "__main__":
    main()
