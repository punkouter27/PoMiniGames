"""PoCabinet "Rim to Rim": the court as a Gaussian splat, in the same court frame as court.glb.

Headless Blender (5.x):

    blender -b --factory-startup -P scripts/blender/pocabinet-court-splat.py -- \
        <mesh.glb> <gaussian_pointcloud.ply (3DGS)> <out.ply> [--budget 400000]

The splat and the mesh come out of the same reconstruction, so unlike the bedroom (two captures,
registered by ICP) there is nothing to fit: the splat is in the mesh's native frame (y down), and
this script

1. maps every splat into the court frame pocabinet-court.py builds from the mesh (the scan's
   up onto +z, the floor levelled onto z = 0, x from board A to board B, metres): centres,
   rotations (quaternion) and log-scales, and prints the median distance from the splat's solid
   centres to the mesh as a check (a few centimetres is a good fit);
2. crops it like the mesh (the court and ~25 m round it, nothing over CUT_Z, nothing deep under
   the floor), and drops the near-invisible and the huge floaters;
3. keeps the `--budget` most important splats (opacity x footprint, FLOOR_SHARE of them kept for
   the court floor, which would otherwise lose out to the trees), base colour only, and writes a
   plain 3DGS PLY, which scripts/pocabinet/ksplat.mjs packs into wwwroot/models/court.ksplat
   (400k) and court-low.ksplat (100k).
"""

import importlib.util
import math
import os
import sys

import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("court", os.path.join(HERE, "pocabinet-court.py"))
court = importlib.util.module_from_spec(spec)
spec.loader.exec_module(court)

FLOOR_SLACK = 0.25    # m of splat kept under the floor (the court's texture lives a little below it)
MIN_ALPHA = 0.04      # splats fainter than this are dropped outright
MAX_SIZE = 2.0        # m: anything bigger is a floater from the sky, not the court
# The court floor is flat discs (two wide axes, one thin) that a size-by-volume ranking throws
# away for the trees; it gets this share of the budget to itself, ranked by footprint.
FLOOR_SHARE = 0.4
FLOOR_BOX = (16.0, 10.0, 0.3)   # |x|, |y| and height (m) of the court floor and its apron
KEEP = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
        "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]

# The splat's native frame to the mesh's once imported and flipped (pocabinet-court.load_scan):
# glTF y-up becomes Blender z-up, (x, y, z) -> (x, -z, y), then the half turn about x that puts
# the scan's up on +z, (x, y, z) -> (x, -y, -z): together (x, y, z) -> (x, z, -y).
NATIVE_TO_SCAN = np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]], dtype=np.float64)


def args():
    a = sys.argv[sys.argv.index("--") + 1:]
    if len(a) < 3:
        raise SystemExit("usage: ... -- <mesh.glb> <gaussian_pointcloud.ply> <out.ply> [--budget N]")
    budget = int(a[a.index("--budget") + 1]) if "--budget" in a else 400_000
    return a[0], a[1], a[2], budget


def open_ply(path):
    """The vertex table as a read-only memory map (the capture is ~1.2 GB) and its property names."""
    with open(path, "rb") as f:
        head = b""
        while not head.endswith(b"end_header\n"):
            head += f.readline()
    lines = head.split(b"\n")
    n = int([l for l in lines if l.startswith(b"element vertex")][0].split()[-1])
    props = [l.split()[-1].decode() for l in lines if l.startswith(b"property")]
    data = np.memmap(path, dtype=np.float32, mode="r", offset=len(head), shape=(n, len(props)))
    return props, data


def write_ply(path, props, data):
    with open(path, "wb") as f:
        f.write(b"ply\nformat binary_little_endian 1.0\n")
        f.write(f"element vertex {len(data)}\n".encode())
        for p in props:
            f.write(f"property float {p}\n".encode())
        f.write(b"end_header\n")
        f.write(np.ascontiguousarray(data, dtype=np.float32).tobytes())


def quat_mul(a, b):
    """Hamilton product, (w, x, y, z), row-wise."""
    w1, x1, y1, z1 = a
    w2, x2, y2, z2 = b.T
    return np.stack([
        w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
        w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
        w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
        w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
    ], 1)


def main():
    glb, ply, out, budget = args()
    meshes = court.load_scan(glb)
    m, _ = court.court_frame(court.verts_of(meshes))
    rot = m[:3, :3] @ NATIVE_TO_SCAN
    t = m[:3, 3]

    props, raw = open_ply(ply)
    ix = {p: i for i, p in enumerate(props)}
    print(f"SPLATS {len(raw)} in, {len(props)} properties")
    d = np.empty((len(raw), len(KEEP)), dtype=np.float32)
    for k, p in enumerate(KEEP):
        d[:, k] = raw[:, ix[p]]
    del raw
    kx = {p: i for i, p in enumerate(KEEP)}

    pos = d[:, [kx["x"], kx["y"], kx["z"]]].astype(np.float64) @ rot.T + t
    d[:, kx["x"]], d[:, kx["y"]], d[:, kx["z"]] = pos.T.astype(np.float32)
    q_r = np.array(Matrix(rot.tolist()).to_quaternion()[:])
    q = d[:, [kx["rot_0"], kx["rot_1"], kx["rot_2"], kx["rot_3"]]].astype(np.float64)
    q /= np.maximum(np.linalg.norm(q, axis=1, keepdims=True), 1e-12)
    d[:, [kx["rot_0"], kx["rot_1"], kx["rot_2"], kx["rot_3"]]] = quat_mul(q_r, q).astype(np.float32)

    # The check: the solid splats sit on the mesh.
    for o in meshes:
        o.data.transform(Matrix(m.tolist()))
    bvh = court.bvh_of(meshes)
    alpha = 1 / (1 + np.exp(-d[:, kx["opacity"]].astype(np.float64)))
    size = np.exp(d[:, [kx["scale_0"], kx["scale_1"], kx["scale_2"]]].astype(np.float64))
    near = (np.abs(pos[:, 0]) < 13) & (np.abs(pos[:, 1]) < 7) & (pos[:, 2] < 4) & (alpha > 0.5) & (size.max(1) < 0.05)
    sample = pos[near][np.random.default_rng(1).choice(near.sum(), min(4000, near.sum()), replace=False)]
    dist = np.array([bvh.find_nearest(Vector(p))[3] for p in sample])
    print(f"FIT median {np.median(dist):.3f} m, p75 {np.percentile(dist, 75):.3f} m from the mesh ({len(sample)} solid splats on the court)")

    keep = ((np.abs(pos[:, 0]) < court.CROP_X) & (np.abs(pos[:, 1]) < court.CROP_Y)
            & (pos[:, 2] > -FLOOR_SLACK) & (pos[:, 2] < court.CUT_Z)
            & (alpha > MIN_ALPHA) & (size.max(1) < MAX_SIZE))
    d, alpha, size = d[keep], alpha[keep], size[keep]
    big = np.sort(size, 1)[:, 1:]                  # the two widest axes: the footprint
    importance = alpha * np.sqrt(big.prod(1))
    pk = d[:, [kx["x"], kx["y"], kx["z"]]]
    floor = (np.abs(pk[:, 0]) < FLOOR_BOX[0]) & (np.abs(pk[:, 1]) < FLOOR_BOX[1]) & (pk[:, 2] < FLOOR_BOX[2])
    if len(d) > budget:
        fi, oi = np.nonzero(floor)[0], np.nonzero(~floor)[0]
        nf = min(len(fi), int(budget * FLOOR_SHARE))
        fi = fi[np.argsort(-importance[fi])[:nf]]
        oi = oi[np.argsort(-importance[oi])[:budget - nf]]
        pick = np.concatenate([fi, oi])
        # Most important first, so the first N rows are the best N-splat version (court-low).
        d = d[pick[np.argsort(-importance[pick])]]
        print(f"FLOOR {nf} splats on the court floor of {floor.sum()}")
    write_ply(out, KEEP, d)
    print(f"WROTE {out}: {len(d)} splats (of {keep.sum()} round the court), {os.path.getsize(out) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
