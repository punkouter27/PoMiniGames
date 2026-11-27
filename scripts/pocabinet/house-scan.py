"""PoCabinet "House Party": the scanned house as the Gaussian splat the game streams.

    python scripts/pocabinet/house-scan.py <gaussian_pointcloud.ply (3DGS)> <out.ply> [--budget 2800000] [--head N]
    python scripts/pocabinet/house-scan.py <gaussian_pointcloud.ply> --fit      # a new scan: print its frame

Plain Python 3.10+ with numpy. The capture (a walk through a house: bedroom, hall, dining room,
kitchen, living room; ~5M gaussians, 1.2 GB, kept out of the repo) is in its own frame, y down.
This script

1. maps every gaussian into the house frame of house-frame.json (metres, the floor on z = 0,
   z up, x along the house, y to the left of x): centres, rotations (the scale is 1) and the
   first band of its view-dependent colour (degree-1 spherical harmonics, which turn like a
   direction: reflections on the floorboards, the sheen on the cabinets);
2. crops it to the house and a little outside the walls (what shows through the windows), and
   drops the near-invisible and the huge floaters;
3. keeps the `--budget` most important (opacity x footprint, weighed up near the lap of
   house-route.py: the cars are 5 cm tall, so what stands beside the road is seen from a hand
   away), base colour plus the degree-1 band (9 numbers, clamped to +/-SH_CLAMP so the
   packed file's 8 bits cover them finely), and writes a plain 3DGS PLY;
4. orders the rows so that any leading share of the file is that share of EVERY part of the
   house: within each half-metre cell the gaussians are ranked by importance, and a row's place
   in the file is its rank as a fraction of its cell. The light version is the file's first
   rows; ordered by importance alone it was the bright kitchen and nothing of the dim living
   room. (ksplat.mjs then groups the rows into 5 m blocks, so the packed file's own order means
   nothing: the game ranks the splats again when it loads one, platform/3d/splats.js rankSplats.)

scripts/pocabinet/ksplat.mjs packs that PLY into wwwroot/models/house.ksplat at compression
level 2 with degree-1 colour (`2 1`: 33 bytes a splat, 2.8M splats, ~92 MB, under GitHub's 100 MB
file limit); the light version (house-low.ksplat) is its first 250,000 rows (`--head 250000`).

--fit finds the frame of a new capture: the floor is the plane through the lowest dense level,
the walls the yaw at which the wall-height gaussians bunch up most sharply. The knots of
house-route.py are laid in the frame on file, so a refit means laying the lap again.
"""

import importlib.util
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
FRAME = os.path.join(HERE, 'house-frame.json')

MIN_ALPHA = 0.03      # fainter gaussians are dropped outright
MAX_SIZE = 1.0        # m: anything bigger is a floater
# The house and what is kept round it (m, house frame): out to the trees past the windows,
# down the stairwell, up into the living room's vaulted ceiling.
CROP = ((-10.6, 9.6), (-7.6, 3.6), (-1.5, 3.6))
INSIDE = ((-9.3, 8.4), (-6.0, 2.2))   # the walls: outside them only a thinned share is kept
OUTSIDE_WEIGHT = 0.35
NEAR_ROAD = 0.8       # m: gaussians this close to the lap weigh up to ROAD_WEIGHT times as much
ROAD_WEIGHT = 3.0
CELL = 0.5            # m: the cells the file's order is balanced over
KEEP = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
        'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']
# The degree-1 band per channel, as the capture stores it (15 coefficients a channel, channel by
# channel), and the names the output gives it (3 a channel, which is how a degree-1 file is read).
SH_IN = [[0, 1, 2], [15, 16, 17], [30, 31, 32]]
SH_OUT = [f'f_rest_{i}' for i in range(9)]
SH_CLAMP = 1.0


def open_ply(path):
    """The vertex table as a read-only memory map (the capture is ~1.2 GB) and its property names."""
    with open(path, 'rb') as f:
        head = b''
        while not head.endswith(b'end_header\n'):
            head += f.readline()
    lines = head.split(b'\n')
    n = int([ln for ln in lines if ln.startswith(b'element vertex')][0].split()[-1])
    props = [ln.split()[-1].decode() for ln in lines if ln.startswith(b'property')]
    return props, np.memmap(path, dtype=np.float32, mode='r', offset=len(head), shape=(n, len(props)))


def write_ply(path, props, data):
    with open(path, 'wb') as f:
        f.write(b'ply\nformat binary_little_endian 1.0\n')
        f.write(f'element vertex {len(data)}\n'.encode())
        for p in props:
            f.write(f'property float {p}\n'.encode())
        f.write(b'end_header\n')
        f.write(np.ascontiguousarray(data, dtype=np.float32).tobytes())


def quat_of(m):
    """A rotation matrix as a quaternion (w, x, y, z)."""
    w = np.sqrt(max(0.0, 1 + m[0, 0] + m[1, 1] + m[2, 2])) / 2
    if w > 1e-6:
        return np.array([w, (m[2, 1] - m[1, 2]) / (4 * w), (m[0, 2] - m[2, 0]) / (4 * w), (m[1, 0] - m[0, 1]) / (4 * w)])
    i = int(np.argmax(np.diag(m)))
    j, k = (i + 1) % 3, (i + 2) % 3
    s = np.sqrt(max(1e-12, 1 + m[i, i] - m[j, j] - m[k, k])) * 2
    q = np.zeros(4)
    q[0] = (m[k, j] - m[j, k]) / s
    q[1 + i] = s / 4
    q[1 + j] = (m[j, i] + m[i, j]) / s
    q[1 + k] = (m[k, i] + m[i, k]) / s
    return q


def quat_mul(a, b):
    """Hamilton product, (w, x, y, z), `a` one quaternion and `b` a row each."""
    w1, x1, y1, z1 = a
    w2, x2, y2, z2 = b.T
    return np.stack([
        w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
        w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
        w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
        w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
    ], 1)


def fit(xyz, alpha):
    """The house frame of a capture whose +y is roughly down: (R, origin) with p_house = R (p - origin)."""
    solid = alpha > 0.5
    hist, edges = np.histogram(xyz[solid, 1], bins=400, range=(-3, 4))
    peak = edges[np.argmax(hist * (edges[:-1] > np.percentile(xyz[solid, 1], 60)))]
    normal, d = np.array([0.0, 1.0, 0.0]), peak + 0.01
    for it in range(8):
        near = solid & (np.abs(xyz @ normal - d) < (0.12 if it < 2 else 0.04))
        pts = xyz[near]
        centre = pts.mean(0)
        vt = np.linalg.svd(pts[::max(1, len(pts) // 200000)] - centre, full_matrices=False)[2]
        normal = vt[2] * np.sign(vt[2][1])
        d = float(centre @ normal)
    up = -normal
    ex = np.array([1.0, 0, 0]) - up * up[0]
    ex /= np.linalg.norm(ex)
    r0 = np.stack([ex, np.cross(up, ex), up])
    origin = normal * d
    p = (xyz - origin) @ r0.T
    walls = p[solid & (p[:, 2] > 1.0) & (p[:, 2] < 2.0) & (np.abs(p[:, 0]) < 11) & (np.abs(p[:, 1]) < 9)][::7, :2]
    best = (-1.0, 0.0)
    for deg in np.arange(-45, 45, 0.25):
        c, s = np.cos(np.radians(deg)), np.sin(np.radians(deg))
        hx = np.histogram(walls[:, 0] * c + walls[:, 1] * s, bins=600, range=(-15, 15))[0].astype(np.float64)
        hy = np.histogram(-walls[:, 0] * s + walls[:, 1] * c, bins=600, range=(-15, 15))[0].astype(np.float64)
        score = float((hx ** 2).sum() + (hy ** 2).sum())
        if score > best[0]:
            best = (score, deg)
    c, s = np.cos(np.radians(best[1])), np.sin(np.radians(best[1]))
    r = np.array([[c, s, 0], [-s, c, 0], [0, 0, 1]]) @ r0
    p = (xyz - origin) @ r.T
    room = solid & (p[:, 2] > 0.1) & (p[:, 2] < 2.3)
    if np.ptp(np.percentile(p[room, 1], [1, 99])) > np.ptp(np.percentile(p[room, 0], [1, 99])):
        r = np.array([[0, 1, 0], [-1, 0, 0], [0, 0, 1]]) @ r     # the long axis along x
    return r, origin


def main():
    a = sys.argv[1:]
    if not a:
        raise SystemExit('usage: house-scan.py <gaussian_pointcloud.ply> <out.ply> [--budget N] | <gaussian_pointcloud.ply> --fit')
    props, raw = open_ply(a[0])
    ix = {p: i for i, p in enumerate(props)}
    print(f'SPLATS {len(raw)} in, {len(props)} properties')
    d = np.empty((len(raw), len(KEEP) + 9), dtype=np.float32)
    for k, p in enumerate(KEEP):
        d[:, k] = raw[:, ix[p]]
    for c, coeffs in enumerate(SH_IN):
        for j, i in enumerate(coeffs):
            d[:, len(KEEP) + c * 3 + j] = raw[:, ix[f'f_rest_{i}']]
    del raw
    kx = {p: i for i, p in enumerate(KEEP)}
    xyz = d[:, :3].astype(np.float64)
    alpha = 1 / (1 + np.exp(-d[:, kx['opacity']].astype(np.float64)))

    if '--fit' in a:
        r, origin = fit(xyz, alpha)
        print(json.dumps({'R': r.tolist(), 'origin': origin.tolist()}, indent=1))
        return
    if len(a) < 2:
        raise SystemExit('an output .ply is required')
    out = a[1]
    budget = int(a[a.index('--budget') + 1]) if '--budget' in a else 2_800_000
    frame = json.load(open(FRAME))
    r, origin = np.array(frame['R']), np.array(frame['origin'])

    pos = (xyz - origin) @ r.T
    d[:, :3] = pos.astype(np.float32)
    q = d[:, [kx['rot_0'], kx['rot_1'], kx['rot_2'], kx['rot_3']]].astype(np.float64)
    q /= np.maximum(np.linalg.norm(q, axis=1, keepdims=True), 1e-12)
    d[:, [kx['rot_0'], kx['rot_1'], kx['rot_2'], kx['rot_3']]] = quat_mul(quat_of(r), q).astype(np.float32)
    # Degree-1 SH: colour += C1 (-s0 y + s1 z - s2 x) for a view direction (x, y, z), so the band is
    # the vector w = (-s2, -s0, s1) dotted with the direction; it turns with the scan: w' = R w.
    base = len(KEEP)
    for c in range(3):
        s0, s1, s2 = (d[:, base + c * 3 + j].astype(np.float64) for j in range(3))
        w = np.stack([-s2, -s0, s1], 1) @ r.T
        d[:, base + c * 3] = np.clip(-w[:, 1], -SH_CLAMP, SH_CLAMP)
        d[:, base + c * 3 + 1] = np.clip(w[:, 2], -SH_CLAMP, SH_CLAMP)
        d[:, base + c * 3 + 2] = np.clip(-w[:, 0], -SH_CLAMP, SH_CLAMP)

    size = np.exp(d[:, [kx['scale_0'], kx['scale_1'], kx['scale_2']]].astype(np.float64))
    keep = (alpha > MIN_ALPHA) & (size.max(1) < MAX_SIZE)
    for axis, (lo, hi) in enumerate(CROP):
        keep &= (pos[:, axis] > lo) & (pos[:, axis] < hi)
    d, pos, alpha, size = d[keep], pos[keep], alpha[keep], size[keep]
    print(f'CROP {len(d)} gaussians in and round the house')

    footprint = np.sqrt(np.sort(size, 1)[:, 1:].prod(1))       # the two widest axes
    importance = alpha * footprint
    inside = (pos[:, 0] > INSIDE[0][0]) & (pos[:, 0] < INSIDE[0][1]) & (pos[:, 1] > INSIDE[1][0]) & (pos[:, 1] < INSIDE[1][1])
    importance[~inside] *= OUTSIDE_WEIGHT

    spec = importlib.util.spec_from_file_location('route', os.path.join(HERE, 'house-route.py'))
    route = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(route)
    hx, hy, hz, _ = route.centerline()
    line = np.stack([hx, hy, hz], 1)[::4]
    near = np.full(len(pos), 1e9)
    for s in range(0, len(pos), 400_000):
        chunk = pos[s:s + 400_000]
        best = np.full(len(chunk), 1e9)
        for p in line:
            best = np.minimum(best, ((chunk - p) ** 2).sum(1))
        near[s:s + 400_000] = np.sqrt(best)
    importance *= 1 + (ROAD_WEIGHT - 1) * np.exp(-0.5 * (near / NEAR_ROAD) ** 2)
    print(f'ROAD {(near < NEAR_ROAD).sum()} gaussians within {NEAR_ROAD} m of the lap')

    order = np.argsort(-importance)[:budget]
    by_road, in_walls = int((near[order] < NEAR_ROAD).sum()), int(inside[order].sum())

    # Step 4: each row's place is its importance rank within its cell, as a fraction of the cell.
    cell = np.floor(pos[order] / CELL).astype(np.int64)
    cell_id = (cell[:, 0] + 64) * 65536 * 256 + (cell[:, 1] + 64) * 65536 + (cell[:, 2] + 64)
    grouped = np.lexsort((-importance[order], cell_id))            # by cell, most important first
    ids = cell_id[grouped]
    starts = np.flatnonzero(np.r_[True, ids[1:] != ids[:-1]])
    sizes = np.diff(np.r_[starts, len(ids)])
    rank = np.arange(len(ids)) - np.repeat(starts, sizes)
    place = (rank + 0.5) / np.repeat(sizes, sizes)
    order = order[grouped[np.lexsort((-importance[order][grouped], place))]]
    print(f'ORDER {len(starts)} cells of {CELL} m, {int(np.median(sizes))} gaussians in the median one')

    head = int(a[a.index('--head') + 1]) if '--head' in a else len(order)
    d = d[order[:head]]
    write_ply(out, KEEP + SH_OUT, d)
    print(f'WROTE {out}: {len(d)} of {len(order)} gaussians ({by_road} of them by the road, {in_walls} inside the walls), '
          f'{os.path.getsize(out) / 1e6:.1f} MB')


if __name__ == '__main__':
    main()
