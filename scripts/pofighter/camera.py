"""Measure how the hand-held camera moved during each move (PoFighter, offline tool).

Usage: python -I camera.py <frames_dir> <cut_dir> <moves.json>

A phone that follows the performer pans, tilts and zooms. Measured on the background only
(the cut-out performer is masked away), each picture of a move gets a similarity transform
[a, b, tx, c, d, ty] that maps its pixels onto the move's first picture. pack.py uses it to
keep the fighter one size through a move, to pin "world" moves to one spot on the floor, and
to recover the travel a following camera hides. Writes <cut_dir>/camera.json.

It also measures each move's first picture against the idle stance's first picture and stores the
zoom between them under "__global__" (move pixels -> idle pixels), so pack.py's "scaleFrom": "idle"
can size every move from the stance instead of from its own pose.
"""
import json
import pathlib
import sys

import cv2
import numpy as np

IDENTITY = np.array([[1, 0, 0], [0, 1, 0]], np.float64)


def background(frames: pathlib.Path, cut: pathlib.Path, i: int, small: float):
    img = cv2.imread(str(frames / f"f{i:04d}.jpg"), cv2.IMREAD_GRAYSCALE)
    cut_png = cv2.imread(str(cut / f"f{i:04d}.png"), cv2.IMREAD_UNCHANGED)
    mask = np.full(img.shape, 255, np.uint8)
    if cut_png is not None:
        person = cv2.dilate((cut_png[..., 3] > 0).astype(np.uint8), np.ones((41, 41), np.uint8))
        mask[person > 0] = 0
    size = (int(img.shape[1] * small), int(img.shape[0] * small))
    return cv2.resize(img, size), cv2.resize(mask, size, interpolation=cv2.INTER_NEAREST)


def step_transform(orb, matcher, a, b, small: float) -> np.ndarray:
    """Similarity mapping picture b onto picture a (full-resolution pixels)."""
    ka, da = orb.detectAndCompute(*a)
    kb, db = orb.detectAndCompute(*b)
    if da is None or db is None:
        return IDENTITY.copy()
    matches = sorted(matcher.match(db, da), key=lambda m: m.distance)[:600]
    if len(matches) < 12:
        return IDENTITY.copy()
    pb = np.float32([kb[m.queryIdx].pt for m in matches]) / small
    pa = np.float32([ka[m.trainIdx].pt for m in matches]) / small
    m, _ = cv2.estimateAffinePartial2D(pb, pa, method=cv2.RANSAC, ransacReprojThreshold=4)
    return IDENTITY.copy() if m is None else m


def compose(outer: np.ndarray, inner: np.ndarray) -> np.ndarray:
    """outer ∘ inner for 2x3 affine matrices."""
    o = np.vstack([outer, [0, 0, 1]])
    n = np.vstack([inner, [0, 0, 1]])
    return (o @ n)[:2]


def main() -> None:
    frames, cut, cfg_path = (pathlib.Path(a) for a in sys.argv[1:4])
    cfg = json.loads(cfg_path.read_text())
    orb = cv2.ORB_create(3000)
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
    small = 0.5
    out = {"__global__": {}}
    first = lambda mv: sorted(mv["frames"] if "frames" in mv else range(mv["from"], mv["to"] + 1, mv["step"]))[0]
    stance = background(frames, cut, first(cfg["moves"]["idle"]), small)
    for name, mv in cfg["moves"].items():
        ids = sorted(mv["frames"] if "frames" in mv else range(mv["from"], mv["to"] + 1, mv["step"]))
        chain = {ids[0]: IDENTITY.copy()}
        prev = background(frames, cut, ids[0], small)
        for a, b in zip(ids, ids[1:]):
            cur = background(frames, cut, b, small)
            chain[b] = compose(chain[a], step_transform(orb, matcher, prev, cur, small))
            prev = cur
        out[name] = {f"f{i:04d}": [round(v, 5) for v in chain[i].ravel()] for i in ids}
        to_stance = step_transform(orb, matcher, stance, background(frames, cut, ids[0], small), small)
        out["__global__"][name] = round(float(np.hypot(*to_stance[0, :2])), 5)
        zooms = [float(np.hypot(*chain[i][0, :2])) for i in ids]
        print(f"{name}: zoom {min(zooms):.3f}-{max(zooms):.3f}, pan x {chain[ids[-1]][0, 2]:+.0f}px, "
              f"vs stance x{out['__global__'][name]:.3f}")
    (cut / "camera.json").write_text(json.dumps(out))


if __name__ == "__main__":
    main()
