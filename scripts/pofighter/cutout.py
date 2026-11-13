"""Cut the performer out of extracted video frames (PoFighter, offline tool).

Usage: python -I cutout.py <frames_dir> <out_dir> [--model NAME] [--only f0100,f0200]

Writes one RGBA PNG per frame (largest connected person only, so bystanders and
loose shadow blobs are dropped) and boxes.json with each frame's tight bounding box.
Never runs in CI; the source video and these intermediates stay under artifacts/.
"""
import argparse
import json
import pathlib

import numpy as np
from PIL import Image
from rembg import new_session, remove
from scipy import ndimage


def largest_component(alpha: np.ndarray) -> np.ndarray:
    labels, count = ndimage.label(alpha > 96)
    if count == 0:
        return np.zeros_like(alpha, dtype=bool)
    sizes = ndimage.sum(np.ones_like(alpha), labels, range(1, count + 1))
    keep = labels == (int(np.argmax(sizes)) + 1)
    # Keep the soft edge around the kept blob, nothing else.
    return ndimage.binary_dilation(keep, iterations=3)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("frames")
    ap.add_argument("out")
    ap.add_argument("--model", default="u2net_human_seg")
    ap.add_argument("--only", default="")
    args = ap.parse_args()

    src = pathlib.Path(args.frames)
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    only = {s for s in args.only.split(",") if s}
    session = new_session(args.model)
    boxes = {}

    for path in sorted(src.glob("*.jpg")):
        if only and path.stem not in only:
            continue
        rgba = np.array(remove(Image.open(path).convert("RGB"), session=session))
        alpha = rgba[..., 3]
        keep = largest_component(alpha)
        alpha = np.where(keep, alpha, 0).astype(np.uint8)
        rgba[..., 3] = alpha
        ys, xs = np.nonzero(alpha > 96)
        if len(xs) == 0:
            continue
        boxes[path.stem] = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
        Image.fromarray(rgba).save(out / f"{path.stem}.png")

    (out / "boxes.json").write_text(json.dumps(boxes))
    print(f"{len(boxes)} frames -> {out}")


if __name__ == "__main__":
    main()
