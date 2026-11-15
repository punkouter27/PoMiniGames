"""Cut the performer out of extracted video frames (PoFighter, offline tool).

Usage: python -I cutout.py <frames_dir> <out_dir> --frames 4-60:4,196-280:2 [--model birefnet-general]

Two models per picture:
  1. YOLO person segmentation finds which pixels belong to *a person* (and which person: the
     biggest one), so furniture standing behind the legs is never kept.
  2. BiRefNet, run on a crop around that person, draws the sharp outline (hair, fingers, feet).
The kept alpha is BiRefNet's, limited to a slightly grown YOLO mask, then the largest blob.

Writes f####.png (RGBA, full frame size) and boxes.json (tight box per frame) into out_dir;
frames already cut are skipped, so a long run can be stopped and resumed.
Needs ultralytics, rembg, onnxruntime, scipy (see scripts/pofighter/README.md). Never runs in CI.
"""
import argparse
import json
import pathlib
import time

import numpy as np
from PIL import Image
from rembg import new_session, remove
from scipy import ndimage
from ultralytics import YOLO


def parse_frames(spec: str) -> list[int]:
    ids: set[int] = set()
    for part in spec.split(","):
        rng, _, step = part.partition(":")
        a, _, b = rng.partition("-")
        ids.update(range(int(a), int(b or a) + 1, int(step or 1)))
    return sorted(ids)


def person_mask(model: YOLO, img: Image.Image) -> np.ndarray | None:
    r = model(img, classes=[0], retina_masks=True, verbose=False, imgsz=1280)[0]
    if r.masks is None or not len(r.masks):
        return None
    masks = r.masks.data.numpy() > 0.5
    return masks[int(masks.sum(axis=(1, 2)).argmax())]


def largest_component(mask: np.ndarray) -> np.ndarray:
    labels, count = ndimage.label(mask)
    if count == 0:
        return mask
    sizes = ndimage.sum(mask, labels, range(1, count + 1))
    return labels == (int(np.argmax(sizes)) + 1)


def trim_dark(rgb: np.ndarray, alpha: np.ndarray, gate: np.ndarray) -> np.ndarray:
    """Drop near-black pixels outside YOLO's tight outline: the edge of a dark object behind
    the performer survives the grown mask, but the performer's own clothes and hair sit inside."""
    dark = rgb.max(axis=2) < 80
    alpha = np.where(dark & ~gate, 0, alpha).astype(np.uint8)
    return np.where(ndimage.binary_dilation(largest_component(alpha > 96), iterations=3), alpha, 0).astype(np.uint8)


def clean(src: pathlib.Path, out: pathlib.Path, yolo: YOLO, ids: list[int]) -> None:
    """Re-check frames already cut (fast: YOLO only, no BiRefNet)."""
    for i in ids:
        png = out / f"f{i:04d}.png"
        if not png.exists():
            continue
        rgba = np.array(Image.open(png))
        gate = person_mask(yolo, Image.open(src / f"f{i:04d}.jpg").convert("RGB"))
        if gate is None:
            continue
        before = int((rgba[..., 3] > 96).sum())
        rgba[..., 3] = trim_dark(rgba[..., :3], rgba[..., 3], gate)
        Image.fromarray(rgba).save(png)
        print(f"f{i:04d}: cleaned {before - int((rgba[..., 3] > 96).sum())} px", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("frames")
    ap.add_argument("out")
    ap.add_argument("--frames", dest="spec", required=True)
    ap.add_argument("--model", default="birefnet-general")
    ap.add_argument("--yolo", default="yolo11m-seg.pt")
    ap.add_argument("--clean", action="store_true", help="only re-check frames already cut")
    args = ap.parse_args()

    src, out = pathlib.Path(args.frames), pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    if args.clean:
        clean(src, out, YOLO(args.yolo), parse_frames(args.spec))
        return
    boxes_path = out / "boxes.json"
    boxes = json.loads(boxes_path.read_text()) if boxes_path.exists() else {}
    yolo, session = YOLO(args.yolo), new_session(args.model)
    ids = [i for i in parse_frames(args.spec) if not (out / f"f{i:04d}.png").exists()]
    print(f"{len(ids)} frames to cut")

    for n, i in enumerate(ids, 1):
        t0 = time.time()
        img = Image.open(src / f"f{i:04d}.jpg").convert("RGB")
        gate = person_mask(yolo, img)
        if gate is None:
            print(f"f{i:04d}: no person, skipped")
            continue
        ys, xs = np.nonzero(gate)
        # Crop around the person so BiRefNet sees them large; pad for limbs YOLO clipped.
        pad = int(0.12 * (ys.max() - ys.min()))
        x0, y0 = max(0, xs.min() - pad), max(0, ys.min() - pad)
        x1, y1 = min(img.width, xs.max() + pad), min(img.height, ys.max() + pad)
        cut = np.array(remove(img.crop((x0, y0, x1, y1)), session=session))
        alpha = np.zeros((img.height, img.width), np.uint8)
        alpha[y0:y1, x0:x1] = cut[..., 3]
        # YOLO's outline is coarse: grow it so fingers and toes survive, then soften the cut.
        grown = ndimage.binary_dilation(gate, iterations=max(6, pad // 6))
        soft = ndimage.gaussian_filter(grown.astype(np.float32), 3)
        alpha = (alpha * np.clip(soft * 1.5, 0, 1)).astype(np.uint8)
        alpha = trim_dark(np.array(img), alpha, gate)
        ys, xs = np.nonzero(alpha > 96)
        rgba = np.dstack([np.array(img), alpha])
        Image.fromarray(rgba).save(out / f"f{i:04d}.png")
        boxes[f"f{i:04d}"] = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
        boxes_path.write_text(json.dumps(boxes))
        print(f"f{i:04d} {n}/{len(ids)} {time.time() - t0:.1f}s", flush=True)


if __name__ == "__main__":
    main()
