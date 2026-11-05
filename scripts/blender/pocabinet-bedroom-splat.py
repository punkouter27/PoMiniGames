"""PoCabinet "Bedroom Floor GP": the room as a Gaussian splat, lined up with the room mesh.

Headless Blender (5.x):

    blender -b --factory-startup -P scripts/blender/pocabinet-bedroom-splat.py -- \
        <BedroomScene.glb> <scene.ply (3DGS)> <out.ply> [--budget 400000]

The mesh (pocabinet-bedroom.py) is the collision model: the route is checked against it and the
track's knots are in its room frame. The splat is a separate capture of the same room, in its own
frame and scale. This script

1. registers the splat cloud onto the mesh: a similarity transform (scale, rotation, offset) by
   ICP from the 24 axis-aligned starts, then refined point-to-surface against the mesh's
   triangles (prints the median error; ~0.04 room units, under a centimetre, is a good fit);
2. moves every splat into the room frame: centres, rotations (quaternion), log-scales;
3. crops it like the mesh: the ceiling (above CUT_Z), anything outside the room's footprint,
   and near-invisible splats;
4. keeps the `--budget` most important splats (opacity x size) and writes a plain 3DGS PLY,
   which scripts/pocabinet/ksplat.mjs packs into wwwroot/models/bedroom.ksplat.
"""

import importlib.util
import itertools
import math
import os
import sys

import numpy as np
from mathutils import Matrix, Vector
from mathutils.kdtree import KDTree

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("bedroom", os.path.join(HERE, "pocabinet-bedroom.py"))
bedroom = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bedroom)

FLOOR_SLACK = 0.3     # room units of splat kept under the floor (the carpet's fuzz)
MIN_ALPHA = 0.04      # splats fainter than this are dropped outright


def args():
    a = sys.argv[sys.argv.index("--") + 1:]
    if len(a) < 3:
        raise SystemExit("usage: ... -- <BedroomScene.glb> <scene.ply> <out.ply> [--budget N]")
    budget = int(a[a.index("--budget") + 1]) if "--budget" in a else 400_000
    return a[0], a[1], a[2], budget


def read_ply(path):
    with open(path, "rb") as f:
        head = b""
        while not head.endswith(b"end_header\n"):
            head += f.readline()
        lines = head.split(b"\n")
        n = int([l for l in lines if l.startswith(b"element vertex")][0].split()[-1])
        props = [l.split()[-1].decode() for l in lines if l.startswith(b"property")]
        data = np.fromfile(f, dtype=np.float32, count=n * len(props)).reshape(n, len(props))
    return props, data


def write_ply(path, props, data):
    with open(path, "wb") as f:
        f.write(b"ply\nformat binary_little_endian 1.0\n")
        f.write(f"element vertex {len(data)}\n".encode())
        for p in props:
            f.write(f"property float {p}\n".encode())
        f.write(b"end_header\n")
        f.write(np.ascontiguousarray(data, dtype=np.float32).tobytes())


def umeyama(a_pts, b_pts):
    """Similarity (s, R, t) taking a_pts onto b_pts in the least-squares sense."""
    ma, mb = a_pts.mean(0), b_pts.mean(0)
    a, b = a_pts - ma, b_pts - mb
    u, s, vt = np.linalg.svd(b.T @ a / len(a))
    d = np.diag([1, 1, np.sign(np.linalg.det(u @ vt))])
    r = u @ d @ vt
    sc = (s * np.diag(d)).sum() / (a ** 2).sum(1).mean()
    return sc, r, mb - sc * r @ ma


def register(meshes, centres, rng):
    """Similarity transform from splat space to the mesh's room frame."""
    verts = np.concatenate([np.array([v.co[:] for v in o.data.vertices]) for o in meshes])
    verts = verts[verts[:, 2] < bedroom.CUT_Z]
    verts = verts[rng.choice(len(verts), min(60000, len(verts)), replace=False)]
    kd = KDTree(len(verts))
    for i, p in enumerate(verts):
        kd.insert(p, i)
    kd.balance()

    def nearest(x):
        hits = [kd.find(p) for p in x]
        return np.array([h[1] for h in hits]), np.array([h[2] for h in hits])

    def icp(sc, r, t, x, iters):
        for _ in range(iters):
            idx, dist = nearest(sc * x @ r.T + t)
            k = dist < np.percentile(dist, 75)
            sc, r, t = umeyama(x[k], verts[idx[k]])
        return sc, r, t, float(np.median(nearest(sc * x @ r.T + t)[1]))

    starts = []
    for perm in itertools.permutations(range(3)):
        for signs in itertools.product([1, -1], repeat=3):
            r = np.zeros((3, 3))
            for row, (col, sg) in enumerate(zip(perm, signs)):
                r[row, col] = sg
            if np.linalg.det(r) > 0:
                starts.append(r)
    spread = lambda p: ((p - p.mean(0)) ** 2).sum(1).mean()
    s0 = math.sqrt(spread(verts) / spread(centres))
    few = centres[:6000]
    best = min((icp(s0, r, verts.mean(0) - s0 * r @ few.mean(0), few, 12) for r in starts), key=lambda b: b[3])
    sc, r, t, _ = icp(*best[:3], centres, 40)

    # Point-to-surface refinement against the triangles.
    bvh = bedroom.bvh_of(meshes)
    for _ in range(25):
        y = sc * centres @ r.T + t
        found = [bvh.find_nearest(Vector(p)) for p in y]
        tgt = np.array([f[0][:] for f in found])
        dist = np.array([f[3] for f in found])
        k = dist < np.percentile(dist, 75)
        sc, r, t = umeyama(centres[k], tgt[k])
    print(f"REGISTERED scale {sc:.5f}, median error {np.median(dist):.4f} room units, p75 {np.percentile(dist, 75):.4f}")
    return sc, r, t


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
    rng = np.random.default_rng(1)
    meshes = bedroom.load_room(glb)
    props, d = read_ply(ply)
    ix = {p: i for i, p in enumerate(props)}
    pos = d[:, [ix["x"], ix["y"], ix["z"]]].astype(np.float64)
    opacity = d[:, ix["opacity"]]
    scales = d[:, [ix["scale_0"], ix["scale_1"], ix["scale_2"]]]
    print(f"SPLATS {len(d)} in, properties {props}")

    solid = (opacity > 0) & (np.exp(scales).max(1) < np.percentile(np.exp(scales).max(1), 80))
    sample = pos[solid]
    sc, r, t = register(meshes, sample[rng.choice(len(sample), min(25000, len(sample)), replace=False)], rng)

    pos = sc * pos @ r.T + t
    d[:, ix["x"]], d[:, ix["y"]], d[:, ix["z"]] = pos.T
    d[:, [ix["scale_0"], ix["scale_1"], ix["scale_2"]]] = scales + math.log(sc)
    q_r = np.array(Matrix(r.tolist()).to_quaternion()[:])
    q = d[:, [ix["rot_0"], ix["rot_1"], ix["rot_2"], ix["rot_3"]]].astype(np.float64)
    q /= np.linalg.norm(q, axis=1, keepdims=True)
    d[:, [ix["rot_0"], ix["rot_1"], ix["rot_2"], ix["rot_3"]]] = quat_mul(q_r, q)

    # Crop to the room the mesh covers, below the cut, and drop the near-invisible.
    verts = np.concatenate([np.array([v.co[:] for v in o.data.vertices]) for o in meshes])
    lo, hi = verts.min(0), verts.max(0)
    alpha = 1 / (1 + np.exp(-opacity))
    keep = ((pos[:, 0] > lo[0]) & (pos[:, 0] < hi[0]) & (pos[:, 1] > lo[1]) & (pos[:, 1] < hi[1])
            & (pos[:, 2] > -FLOOR_SLACK) & (pos[:, 2] < bedroom.CUT_Z) & (alpha > MIN_ALPHA))
    d = d[keep]
    alpha = alpha[keep]
    size = np.exp(d[:, [ix["scale_0"], ix["scale_1"], ix["scale_2"]]]).prod(1) ** (1 / 3)
    importance = alpha * size
    if len(d) > budget:
        d = d[np.argsort(-importance)[:budget]]
    write_ply(out, props, d)
    print(f"WROTE {out}: {len(d)} splats (of {keep.sum()} in the room), {os.path.getsize(out) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
