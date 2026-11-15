"""Find the moves in a filmed session (PoFighter, offline tool).

Usage: python -I scan.py <rgba_dir> [--from N --to N]

Reads the cut-out RGBA PNGs written by cutout.py and prints one line per frame with the
measurements that tell the moves apart, so the ranges in <fighter>.moves.json can be
picked by reading the table instead of watching the video:

    idx  h     w     bottom  cx    area   shape
    h       height of the outline            (crouch shrinks it, a jump raises it)
    w       width of the outline             (a punch or kick stretches it)
    bottom  lowest painted row               (leaves the ground line on a jump)
    cx      centre column                    (drifts during a walk)
    shape   w / h                            (limb extension without standing up)

Nothing here is needed at runtime; it only helps choose frame ranges.
"""
import argparse
import pathlib

import numpy as np
from PIL import Image


def measure(alpha: np.ndarray) -> tuple[int, int, int, float, int]:
    ys, xs = np.nonzero(alpha > 96)
    if len(xs) == 0:
        return 0, 0, 0, 0.0, 0
    return (int(ys.max() - ys.min() + 1), int(xs.max() - xs.min() + 1),
            int(ys.max()), float((xs.min() + xs.max()) / 2), int(len(xs)))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("rgba")
    ap.add_argument("--from", dest="lo", type=int, default=0)
    ap.add_argument("--to", dest="hi", type=int, default=10**9)
    args = ap.parse_args()

    src = pathlib.Path(args.rgba)
    print("idx   h    w   bottom    cx    area  shape")
    for path in sorted(src.glob("f*.png")):
        idx = int(path.stem[1:])
        if not args.lo <= idx <= args.hi:
            continue
        alpha = np.array(Image.open(path))[..., 3]
        h, w, bottom, cx, area = measure(alpha)
        shape = w / h if h else 0.0
        print(f"{idx:5d} {h:4d} {w:4d} {bottom:6d} {cx:6.1f} {area:6d} {shape:5.2f}")


if __name__ == "__main__":
    main()
