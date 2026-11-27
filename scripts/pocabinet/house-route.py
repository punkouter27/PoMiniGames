"""PoCabinet "House Party": the lap through the scanned house, laid on the scan and checked.

    python scripts/pocabinet/house-route.py                      # the checks that need no scan
    python scripts/pocabinet/house-route.py <house.ply>          # and what the scan has standing in the road
    python scripts/pocabinet/house-route.py <house.ply> --png <dir>   # plan and side pictures of it
    python scripts/pocabinet/house-route.py --cs                 # the C# arrays for PoCabinetTrackGeometry

Plain Python 3.10+ with numpy (and Pillow for --png). <house.ply> is the splat house-scan.py
writes, already in the house frame (house-frame.json): metres, the floor on z = 0, z up, x along
the house from the bedroom (-x) to the living room (+x), y to the left of x.

KNOTS below are the lap in that frame, z the road's height over the floor. The game's frame is
SCALE sim units to the metre with its y flipped (the sim's +y is to the right of +x), so a knot
(x, y, z) becomes (SCALE x, -SCALE y) at height SCALE z. At 800 a 39-unit car is a ~5 cm toy and
the 105-unit road 13 cm wide.

The lap, counter-clockwise on the plan: the start straight along the kitchen floor, out through
the wide opening and along the living room's south wall; up past the television and along the
north wall to a crest by the mantel (1.5 m); back through the kitchen and up the dining room's
east side, a hairpin over the head of the table and down the middle of it, over the buffet and
into the hall; the hall's upper lane climbing to the bedroom door, round the bedroom to the
crest in front of the shelves at six feet (1.83 m); down past the loft bed, out of the door and
down the hall's lower lane, round the end of the kitchen wall and down the aisle beside the
island to the floor.

It checks:
  - bends no tighter than MIN_RADIUS;
  - two passes of the road (the hall's two lanes, both ways through the bedroom door) keep their
    barriers GAP apart: the sim is flat, so corridors that overlap on the plan share one barrier;
  - no grade over MAX_GRADE, and how sharp the sharpest crest is (cars take off over it);
  - nothing solid in the scan stands in the road, from just over the deck to two cars high.
"""

import json
import os
import sys

import numpy as np

SCALE = 800.0          # sim units per metre
STEPS = 16             # PoCabinetTrackDefinition.StepsPerSegment
TRACK_WIDTH = 105.0
RUN_OFF = 26.0         # physics.js RUN_OFF: the barrier stands this far past the road edge
MIN_RADIUS = 150.0
GAP = 30.0
MAX_GRADE = 0.24
SOLID = 0.4            # a gaussian this opaque is furniture, not haze
IN_ROAD = 12           # solid gaussians in one cross-section before it is called blocked

# (x, y, z) per knot, metres.
KNOTS = [
    # 0-5: the start straight along the kitchen floor, out through the wide opening.
    (1.65, -4.49, 0.02), (2.05, -4.47, 0.02), (2.45, -4.44, 0.02), (2.90, -4.44, 0.02), (3.40, -4.52, 0.02), (3.90, -4.66, 0.02),
    # 6-10: along the living room's south wall, starting to climb.
    (4.45, -4.82, 0.03), (5.10, -4.94, 0.10), (5.80, -4.98, 0.21), (6.45, -4.98, 0.33), (6.95, -4.88, 0.43),
    # 11-15: north past the television.
    (7.22, -4.55, 0.52), (7.26, -4.05, 0.62), (7.26, -3.50, 0.73), (7.26, -2.95, 0.84), (7.20, -2.45, 0.95),
    # 16-21: west along the north wall to the crest by the mantel.
    (6.92, -2.10, 1.04), (6.45, -1.98, 1.13), (5.90, -1.98, 1.23), (5.30, -2.00, 1.33), (4.70, -2.02, 1.42), (4.15, -2.08, 1.48),
    # 22-26: round the chimney corner and back into the kitchen, dropping.
    (3.80, -2.38, 1.48), (3.47, -2.80, 1.43), (3.10, -3.20, 1.36), (2.62, -3.36, 1.29), (2.22, -3.04, 1.22),
    # 27-33: north up the dining room's east side, over the chair backs.
    (2.02, -2.55, 1.17), (1.95, -2.00, 1.14), (1.95, -1.40, 1.13), (1.95, -0.80, 1.13), (1.95, -0.20, 1.13), (1.95, 0.40, 1.13), (1.93, 0.95, 1.12),
    # 34-37: the hairpin over the head of the table.
    (1.79, 1.38, 1.10), (1.41, 1.54, 1.07), (1.03, 1.38, 1.04), (0.87, 0.95, 1.01),
    # 38-44: down the middle of the dining table, right over the buffet and into the hall.
    (0.87, 0.40, 1.00), (0.87, -0.10, 1.00), (0.81, -0.57, 1.01), (0.56, -0.94, 1.03), (0.14, -1.08, 1.05), (-0.35, -1.02, 1.07), (-0.90, -0.90, 1.10),
    # 45-51: the hall's upper lane, climbing to the bedroom door.
    (-1.45, -0.88, 1.14), (-2.00, -0.89, 1.21), (-2.60, -0.90, 1.28), (-3.20, -0.91, 1.35), (-3.80, -0.92, 1.42), (-4.40, -0.92, 1.49), (-4.97, -0.885, 1.55),
    # 52-57: round the bedroom to the crest at six feet, in front of the shelves.
    (-5.36, -0.58, 1.61), (-5.58, -0.14, 1.67), (-5.62, 0.35, 1.73), (-5.62, 0.85, 1.78), (-5.80, 1.22, 1.81), (-6.20, 1.36, 1.83),
    # 58-68: down past the loft bed and back to the door, clear of the open door leaf.
    (-6.62, 1.22, 1.81), (-6.84, 0.85, 1.75), (-6.86, 0.35, 1.67), (-6.86, -0.15, 1.59), (-6.84, -0.56, 1.51), (-6.64, -0.86, 1.43),
    (-6.25, -0.93, 1.36), (-5.90, -0.90, 1.30), (-5.58, -0.87, 1.25), (-5.27, -0.97, 1.19), (-4.96, -1.135, 1.13),
    # 69-74: the hall's lower lane, the long descent.
    (-4.42, -1.27, 1.03), (-3.80, -1.30, 0.93), (-3.20, -1.30, 0.83), (-2.60, -1.30, 0.73), (-2.00, -1.30, 0.63), (-1.55, -1.33, 0.55),
    # 75-81: round the end of the kitchen wall and down the aisle beside the island to the floor.
    (-1.24, -1.55, 0.48), (-1.22, -1.95, 0.40), (-1.42, -2.38, 0.30), (-1.60, -2.85, 0.20), (-1.62, -3.35, 0.10), (-1.62, -3.80, 0.04), (-1.52, -4.20, 0.02),
    # 82-86: onto the start straight; the grid stands back along it.
    (-1.18, -4.46, 0.02), (-0.70, -4.50, 0.02), (-0.10, -4.50, 0.02), (0.50, -4.50, 0.02), (1.10, -4.50, 0.02),
]

# Road width per knot as a share of TRACK_WIDTH (1 where not listed): the pinch through the
# bedroom door, where both lanes share the 50 cm between the wall and the open door leaf, and
# room to pass through the living room.
WIDTH = {
    5: 1.08, 6: 1.15, 7: 1.15, 8: 1.15, 9: 1.15, 10: 1.15, 11: 1.15, 12: 1.15, 13: 1.15, 14: 1.15, 15: 1.15,
    16: 1.15, 17: 1.15, 18: 1.15, 19: 1.15, 20: 1.1, 21: 1.05,
    48: 0.96, 49: 0.9, 50: 0.84, 51: 0.8, 52: 0.85, 53: 0.95, 65: 0.96, 66: 0.9, 67: 0.82, 68: 0.82, 69: 0.88, 70: 0.96,
}


def catmull(p0, p1, p2, p3, t):
    """PoCabinetTrackGeometry.CatmullRom."""
    t2, t3 = t * t, t * t * t
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)


def resample(vals):
    n = len(vals)
    out = []
    for i in range(n):
        p0, p1, p2, p3 = vals[(i - 1) % n], vals[i], vals[(i + 1) % n], vals[(i + 2) % n]
        out.extend(catmull(p0, p1, p2, p3, s / STEPS) for s in range(STEPS))
    return np.array(out)


def centerline():
    """The lap per sample in the house frame (metres): x, y, z and the road's half width."""
    k = np.array(KNOTS, dtype=np.float64)
    half = resample(np.array([WIDTH.get(i, 1.0) for i in range(len(KNOTS))])) * TRACK_WIDTH * 0.5 / SCALE
    return resample(k[:, 0]), resample(k[:, 1]), resample(k[:, 2]), half


def bank_per_knot(curv):
    """Bank into each bend by its curvature (+ = right side higher, the sim's sign): none for a
    kink, little on the floor (the low edge must stay over the floorboards), none on the grid."""
    bank = np.clip(-curv[::STEPS] * 60, -0.22, 0.22)
    bank[np.abs(bank) < 0.05] = 0
    floor = np.array([k[2] for k in KNOTS]) < 0.05
    bank[floor] = np.clip(bank[floor], -0.08, 0.08)
    bank[[83, 84, 85, 86, 0]] = 0
    return bank


def read_ply(path):
    with open(path, 'rb') as f:
        head = b''
        while not head.endswith(b'end_header\n'):
            head += f.readline()
    lines = head.split(b'\n')
    n = int([ln for ln in lines if ln.startswith(b'element vertex')][0].split()[-1])
    props = [ln.split()[-1].decode() for ln in lines if ln.startswith(b'property')]
    return props, np.memmap(path, dtype=np.float32, mode='r', offset=len(head), shape=(n, len(props)))


def main():
    argv = sys.argv[1:]
    ply = next((a for a in argv if a.lower().endswith('.ply')), None)
    png = argv[argv.index('--png') + 1] if '--png' in argv else None

    hx, hy, hz, half = centerline()
    n = len(hx)
    # The sim's frame: units, y flipped.
    x, y, z, hw = hx * SCALE, -hy * SCALE, hz * SCALE, half * SCALE
    dx, dy = np.roll(x, -1) - x, np.roll(y, -1) - y
    seg = np.hypot(dx, dy)
    cum = np.concatenate([[0], np.cumsum(seg)])
    length = cum[-1]
    print(f'ROUTE {len(KNOTS)} knots, {n} samples {seg.min():.0f}..{seg.max():.0f} units apart, lap {length:.0f} units = {length / SCALE:.1f} m')
    problems = []

    heading = np.arctan2(dy, dx)
    turn = (np.roll(heading, -1) - heading + np.pi) % (2 * np.pi) - np.pi
    curv = turn / np.maximum(1e-6, (seg + np.roll(seg, -1)) * 0.5)
    curv = (np.roll(curv, 1) + curv + np.roll(curv, -1)) / 3
    tight = int(np.argmax(np.abs(curv)))
    print(f'BENDS tightest radius {1 / abs(curv[tight]):.0f} units at knot {tight / STEPS:.1f}')
    for i in np.where(np.abs(curv) > 1 / MIN_RADIUS)[0][::STEPS // 2]:
        problems.append(f'bend radius {1 / abs(curv[i]):.0f} < {MIN_RADIUS:.0f} at knot {i / STEPS:.1f}')

    worst = (1e9, 0, 0)
    for i in range(0, n, 2):
        dist = np.hypot(x - x[i], y - y[i])
        along = np.abs(cum[:-1] - cum[i])
        dist[np.minimum(along, length - along) < 700] = 1e9
        j = int(np.argmin(dist))
        spare = dist[j] - (hw[i] + hw[j] + 2 * RUN_OFF + GAP)
        if spare < worst[0]:
            worst = (spare, i, j)
        if spare < 0 and i < j:
            problems.append(f'two passes {dist[j]:.0f} apart, {-spare:.0f} too close, at knots {i / STEPS:.1f} and {j / STEPS:.1f}')
    print(f'PASSES closest two have {worst[0]:.0f} units to spare over a {GAP:.0f}-unit gap, at knots {worst[1] / STEPS:.1f} / {worst[2] / STEPS:.1f}')

    grade = (np.roll(z, -1) - z) / seg
    crest = -(np.roll(grade, -1) - grade) / seg * 420.0 ** 2
    c = int(np.argmax(crest))
    print(f'HEIGHT {hz.min():.2f}..{hz.max():.2f} m ({hz.max() / 0.3048:.1f} ft), grade {grade.min():+.3f}..{grade.max():+.3f}; '
          f'the sharpest crest (knot {c / STEPS:.1f}) falls away at {crest[c]:.0f} u/s^2 at 420 u/s (gravity is 98)')
    for i in np.where(np.abs(grade) > MAX_GRADE)[0][::STEPS]:
        problems.append(f'grade {grade[i]:+.2f} at knot {i / STEPS:.1f}')

    if ply:
        props, raw = read_ply(ply)
        ix = {p: i for i, p in enumerate(props)}
        alpha = 1 / (1 + np.exp(-np.asarray(raw[:, ix['opacity']], dtype=np.float64)))
        p = np.asarray(raw[:, [ix['x'], ix['y'], ix['z']]])[alpha > SOLID]
        cell, x0, y0, z0 = 0.04, -9.6, -7.0, -0.3
        nx, ny, nz = int(18.6 / cell), int(10.6 / cell), int(3.0 / cell)
        gi = ((p - (x0, y0, z0)) / cell).astype(int)
        ok = (gi >= 0).all(1) & (gi[:, 0] < nx) & (gi[:, 1] < ny) & (gi[:, 2] < nz)
        occ = np.zeros((nx, ny, nz), np.uint16)
        np.add.at(occ, tuple(gi[ok].T), 1)
        tx, ty = dx / seg, dy / seg
        hits = np.zeros(n, int)
        column = np.zeros((nz, n), np.float32)
        for i in range(n):
            reach = half[i] + RUN_OFF / SCALE
            for lat in np.linspace(-reach, reach, 7):
                # the road's normal in the house frame (the sim's y is flipped)
                cx, cy = int((hx[i] - ty[i] * lat - x0) / cell), int((hy[i] - tx[i] * lat - y0) / cell)
                column[:, i] += occ[cx, cy, :]
                lo, hi = int((hz[i] + 0.04 - z0) / cell), int((hz[i] + 0.14 - z0) / cell)
                hits[i] += int(occ[cx, cy, lo:hi + 1].sum())
        bad = hits > IN_ROAD
        print(f'SCAN {int((alpha > SOLID).sum())} solid gaussians; {int(bad.sum())} of {n} cross-sections have something in the road')
        i = 0
        while i < n:
            j = i
            while j < n and bad[j]:
                j += 1
            if j > i:
                problems.append(f'the scan stands in the road, knots {i / STEPS:.1f} to {j / STEPS:.1f} ({hits[i:j].max()} gaussians, road at {hz[i:j].mean():.2f} m)')
            i = max(j, i + 1)
        if png:
            pictures(png, p, column, hx, hy, hz, x0, y0, z0, cell)

    print(f'{len(problems)} problems' if problems else 'OK')
    for q in problems:
        print('  -', q)

    if '--cs' in argv:
        rows = [(0, 6), (6, 11), (11, 16), (16, 22), (22, 27), (27, 34), (34, 38), (38, 45), (45, 52), (52, 58), (58, 69), (69, 75), (75, 82), (82, 87)]
        bank = bank_per_knot(curv)

        def table(name, fmt):
            print(f'{name} =\n[')
            for a, b in rows:
                print('    ' + ' '.join(fmt(i) + ',' for i in range(a, b)))
            print('],')
        table('Knots', lambda i: f'({KNOTS[i][0] * SCALE:.0f}, {-KNOTS[i][1] * SCALE:.0f})')
        table('KnotZ', lambda i: f'{KNOTS[i][2] * SCALE:.0f}')
        table('KnotBank', lambda i: f'{bank[i] + 0.0:.2f}'.replace('-0.00', '0').replace('0.00', '0'))
        table('KnotWidth', lambda i: f'{WIDTH.get(i, 1.0):g}')
    return 1 if problems else 0


def pictures(out, p, column, hx, hy, hz, x0, y0, z0, cell):
    """plan.png: the scan from above (everything under 2.05 m) with the lap on it. profile.png:
    the lap unrolled, what the scan has in the road's corridor at each height, and the road."""
    from PIL import Image, ImageDraw
    os.makedirs(out, exist_ok=True)
    px, ax, bx, ay, by = 80, -9.5, 8.5, -6.4, 2.6
    w, h = int((bx - ax) * px), int((by - ay) * px)
    low = p[(p[:, 2] > -0.1) & (p[:, 2] < 2.05)]
    low = low[np.argsort(low[:, 2])]
    u = ((low[:, 0] - ax) * px).astype(int).clip(0, w - 1)
    v = (h - 1 - ((low[:, 1] - ay) * px).astype(int)).clip(0, h - 1)
    shade = np.zeros((h, w), np.uint8)
    shade[v, u] = (60 + low[:, 2] / 2.05 * 195).astype(np.uint8)
    im = Image.fromarray(np.stack([shade // 2, shade, shade // 2], -1))
    dr = ImageDraw.Draw(im)
    pts = [((a - ax) * px, h - (b - ay) * px) for a, b in zip(hx, hy)]
    dr.line(pts + pts[:1], fill=(0, 255, 255), width=2)
    for k, (a, b, c) in enumerate(KNOTS):
        dr.text(((a - ax) * px + 4, h - (b - ay) * px - 10), f'{k}:{c:.1f}', fill=(255, 255, 255))
    im.save(os.path.join(out, 'plan.png'))

    nz, n = column.shape
    img = np.zeros((nz, n, 3), np.uint8)
    img[..., 1] = np.clip(column * 12, 0, 255).astype(np.uint8)
    for i in range(n):
        img[min(nz - 1, max(0, int((hz[i] - z0) / cell))), i] = (255, 60, 255)
        if i % (STEPS * 5) == 0:
            img[0:6, i] = (255, 255, 255)
    Image.fromarray(img[::-1]).resize((n, nz * 4), Image.NEAREST).save(os.path.join(out, 'profile.png'))
    print(f'PICTURES {out}/plan.png, profile.png')


if __name__ == '__main__':
    sys.exit(main())
