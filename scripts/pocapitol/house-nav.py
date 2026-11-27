"""PoCapitol "House" map: where a person can walk and what stops a bullet, baked from the scan.

    python scripts/pocapitol/house-nav.py <gaussian_pointcloud.ply> <cameras.json> [--png <dir>] [--out <house-nav.json>]

Plain Python 3.10+ with numpy (and Pillow for --png). The inputs are the capture PoCabinet's
House Party is cut from (scripts/pocabinet/house-scan.py; ~5M gaussians, 1.2 GB, kept out of
the repo) and the capture's own camera poses. Everything is worked out in the house frame of
scripts/pocabinet/house-frame.json: metres, the floor on z = 0, z up, x along the house (bedroom
at -x, living room at +x), y to the left of x. The game draws models/house.ksplat, which is in
that same frame, so the grid lines up with the picture without any fitting.

What it writes (wwwroot/models/pocapitol/house-nav.json, ~40 KB):

  cell, x0, y0, cols, rows   a plan grid (10 cm cells), row 0 at y0, column 0 at x0;
  height                     base64, one byte per cell: how high the solid stuff standing in that
                             cell reaches, in units of 2 cm (0 = bare floor, 255 = nothing to
                             stand on: outside the house, the stairwell). A wall reads ~1.9 m
                             (the scan is only read up to there, so door heads stay open), a
                             table 0.75 m, a sofa 0.8 m.
  walk                       base64 bit per cell: a person (radius 0.22 m) can stand here;
  rooms                      the rooms to clear, in order, each with its rectangles (x0, x1, y0,
                             y1), the centre of its floor and the spots raiders stand at (in the
                             open, far from each other and from the player's start);
  start                      where the player starts (the bedroom), and the point they face;
  entry                      the end of the entry passage, where the second wave comes in.

How: every gaussian is spread over its own footprint (a wall is a few big flat gaussians, so
counting centres leaves holes in it) into 5 cm voxels, weighted by its opacity. A column is as
high as its highest voxel that is solid, and has floor where the voxels round z = 0 are. Where
the person who made the capture walked (the camera poses at carrying height) nothing can be
standing, whatever a floater says; and nowhere further than REACH from that path is part of the
house. What is left is flooded from the path, so a pocket behind a wall is never walkable.

A doorway half a metre wide closes once a body's radius is taken off both sides, so the line the
capture itself was walked along (every pose, joined frame to frame) stays open one cell either
side wherever the floor under it is clear: someone carried a camera through there. The largest
connected piece is the map; the script fails if a room is cut off from it.
"""

import base64
import itertools
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
FRAME = os.path.join(HERE, '..', 'pocabinet', 'house-frame.json')
OUT = os.path.join(ROOT, 'src', 'PoMiniGames.Client', 'wwwroot', 'models', 'pocapitol', 'house-nav.json')

X0, X1, Y0, Y1 = -10.0, 9.0, -7.0, 3.5      # the plan the grid covers (m)
Z0, Z1 = -0.3, 1.9                          # the slab of the scan that is read
VOX = 0.05                                  # voxels the scan is spread into
CELL = 0.10                                 # the grid the game reads
MIN_ALPHA, MAX_SIZE = 0.12, 1.2             # fainter is haze, bigger is a floater
SOLID = 0.55                                # opacity gathered in a voxel before it is solid
STEP = 0.30                                 # m: anything lower is stepped over
RADIUS = 0.22                               # m: the person's
CARRY = (1.15, 1.95)                        # m: a camera this high was carried by someone standing there
PATH_CLEAR = 0.22                           # m round the capture path that is known to be empty
REACH = 2.2                                 # m: the house ends this far from the capture path
HELD = (0.3, 2.3)                           # m: a camera anywhere in this range had a person under it
JOIN = 0.5                                  # m: consecutive frames this close are one walk

# The rooms, in the order they are cleared: (id, name, raiders, rectangles (x0, x1, y0, y1)).
# A cell belongs to the first room one of whose rectangles holds it; raiders stand in a room's
# first rectangle. The hall's second rectangle is the entry passage. The bedroom (the room with
# the shelves of toys and the miniatures bench) holds nobody: it is where the player starts
# (owner, 2026-11-27), so it is floor to walk on but not a room to clear.
ROOMS = [
    ('hall', 'Hall', 1, [(-4.75, -1.25, -1.95, -0.45), (-6.3, -3.9, -3.5, -1.75)]),
    ('bedroom', 'Bedroom', 0, [(-9.6, -4.75, -1.75, 2.6)]),
    ('dining', 'Dining room', 3, [(-1.25, 2.9, -1.55, 2.7)]),
    ('kitchen', 'Kitchen', 4, [(-2.6, 2.35, -6.2, -1.55)]),
    ('living', 'Living room', 3, [(2.35, 8.6, -6.2, -0.6)]),
]
START = 'bedroom'                           # the room the player starts in
START_LOOK = (0.0, 1.0)                     # and the way they face there: at the shelves of figures
ENTRY = (-6.3, -4.6, -3.5, -2.3)             # the end of the entry passage: where the second wave comes in
KEEP_OFF = 3.4                              # m: no raider starts nearer the player than this


def open_ply(path):
    with open(path, 'rb') as f:
        head = b''
        while not head.endswith(b'end_header\n'):
            head += f.readline()
    lines = head.split(b'\n')
    n = int(next(ln for ln in lines if ln.startswith(b'element vertex')).split()[-1])
    props = [ln.split()[-1].decode() for ln in lines if ln.startswith(b'property')]
    return props, np.memmap(path, dtype=np.float32, mode='r', offset=len(head), shape=(n, len(props)))


def rotations(q):
    """Unit quaternions (w, x, y, z), one per row, as 3x3 matrices."""
    w, x, y, z = q.T
    return np.stack([
        np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)], 1),
        np.stack([2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)], 1),
        np.stack([2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)], 1),
    ], 1)


def voxels(ply, frame):
    """Opacity gathered per 5 cm voxel, [z, y, x], the scan spread over each gaussian's footprint."""
    props, raw = open_ply(ply)
    ix = {p: i for i, p in enumerate(props)}
    r_house, origin = np.array(frame['R']), np.array(frame['origin'])
    nx, ny, nz = round((X1 - X0) / VOX), round((Y1 - Y0) / VOX), round((Z1 - Z0) / VOX)
    grid = np.zeros(nx * ny * nz, dtype=np.float32)
    rng = np.random.default_rng(7)
    used = 0
    for s in range(0, len(raw), 400_000):
        chunk = np.asarray(raw[s:s + 400_000])
        pos = (chunk[:, [ix['x'], ix['y'], ix['z']]].astype(np.float64) - origin) @ r_house.T
        alpha = 1 / (1 + np.exp(-chunk[:, ix['opacity']].astype(np.float64)))
        size = np.exp(chunk[:, [ix['scale_0'], ix['scale_1'], ix['scale_2']]].astype(np.float64))
        keep = (alpha > MIN_ALPHA) & (size.max(1) < MAX_SIZE)
        keep &= (pos[:, 0] > X0 - 1) & (pos[:, 0] < X1 + 1) & (pos[:, 1] > Y0 - 1) & (pos[:, 1] < Y1 + 1)
        keep &= (pos[:, 2] > Z0 - 1) & (pos[:, 2] < Z1 + 1)
        pos, alpha, size = pos[keep], alpha[keep], size[keep]
        q = chunk[keep][:, [ix['rot_0'], ix['rot_1'], ix['rot_2'], ix['rot_3']]].astype(np.float64)
        q /= np.maximum(np.linalg.norm(q, axis=1, keepdims=True), 1e-12)
        rot = r_house @ rotations(q)                       # each gaussian's axes in the house frame
        # One sample per voxel face the footprint covers (its two widest axes, out to 1.4 sigma).
        widest = np.sort(size, 1)[:, 1:]
        area = (2.8 * widest[:, 0]) * (2.8 * widest[:, 1])
        count = np.clip(np.ceil(area / (VOX * VOX)), 1, 48).astype(np.int64)
        who = np.repeat(np.arange(len(pos)), count)
        local = rng.uniform(-1.4, 1.4, (len(who), 3)) * size[who]
        pts = pos[who] + np.einsum('nij,nj->ni', rot[who], local)
        # A gaussian covering more voxels than it has samples still weighs its whole footprint.
        weight = alpha[who] * np.minimum(1.0, area[who] / (VOX * VOX) / count[who])
        gx = np.floor((pts[:, 0] - X0) / VOX).astype(np.int64)
        gy = np.floor((pts[:, 1] - Y0) / VOX).astype(np.int64)
        gz = np.floor((pts[:, 2] - Z0) / VOX).astype(np.int64)
        ok = (gx >= 0) & (gx < nx) & (gy >= 0) & (gy < ny) & (gz >= 0) & (gz < nz)
        np.add.at(grid, (gz[ok] * ny + gy[ok]) * nx + gx[ok], weight[ok].astype(np.float32))
        used += len(pos)
    print(f'SCAN {len(raw)} gaussians, {used} read into {nx}x{ny}x{nz} voxels')
    return grid.reshape(nz, ny, nx)


def disc(radius, cell):
    r = int(np.ceil(radius / cell))
    yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
    return (xx * xx + yy * yy) * cell * cell <= radius * radius + 1e-9


def dilate(mask, radius, cell):
    """Every cell within `radius` of a set one."""
    k = disc(radius, cell)
    r = k.shape[0] // 2
    padded = np.pad(mask, r)
    out = np.zeros_like(mask)
    for dy in range(k.shape[0]):
        for dx in range(k.shape[1]):
            if k[dy, dx]:
                out |= padded[dy:dy + mask.shape[0], dx:dx + mask.shape[1]]
    return out


def flood(free, seeds):
    """The cells of `free` joined to a seed (4-neighbours)."""
    reached = seeds & free
    while True:
        grown = reached.copy()
        grown[1:] |= reached[:-1]
        grown[:-1] |= reached[1:]
        grown[:, 1:] |= reached[:, :-1]
        grown[:, :-1] |= reached[:, 1:]
        grown &= free
        if (grown == reached).all():
            return reached
        reached = grown


def largest(mask):
    """The biggest 4-connected piece of a mask."""
    left, best = mask.copy(), np.zeros_like(mask)
    while left.any():
        seed = np.zeros_like(mask)
        seed[tuple(np.argwhere(left)[0])] = True
        piece = flood(left, seed)
        if piece.sum() > best.sum():
            best = piece
        left &= ~piece
    return best


def walked_line(frames, shape):
    """The capture's own walk on the 10 cm grid: its frames in order, joined where they are close."""
    rows, cols = shape
    line = np.zeros(shape, dtype=bool)
    for a, b in itertools.pairwise(frames):
        gap = float(np.hypot(*(b[:2] - a[:2])))
        if gap > JOIN:
            continue
        for k in np.linspace(0, 1, max(2, int(gap / (CELL / 2)) + 1)):
            x, y = a[:2] + (b[:2] - a[:2]) * k
            c, r = int((x - X0) / CELL), int((y - Y0) / CELL)
            if 0 <= c < cols and 0 <= r < rows:
                line[r, c] = True
    return line


def pool(a, f, how):
    """A [rows, cols] grid in blocks of f x f."""
    r, c = a.shape[0] // f, a.shape[1] // f
    return how(a[:r * f, :c * f].reshape(r, f, c, f), axis=(1, 3))


def within(shape, rect):
    """The cells whose centres are inside a rectangle (x0, x1, y0, y1)."""
    ys, xs = np.mgrid[0:shape[0], 0:shape[1]]
    cx, cy = X0 + (xs + 0.5) * CELL, Y0 + (ys + 0.5) * CELL
    # Half-open, so two rooms that share an edge leave no line of cells between them.
    return (cx >= rect[0] - 1e-6) & (cx < rect[1] - 1e-6) & (cy >= rect[2] - 1e-6) & (cy < rect[3] - 1e-6)


def spots(walk, clear, rect, count, away=None):
    """`count` cells of a rectangle to stand in: in the open, as far from each other as it allows,
    and none within KEEP_OFF of the point `away` (the player's way in)."""
    inside = walk & within(walk.shape, rect)
    if away is not None:
        ys, xs = np.mgrid[0:walk.shape[0], 0:walk.shape[1]]
        far_enough = np.hypot(X0 + (xs + 0.5) * CELL - away[0], Y0 + (ys + 0.5) * CELL - away[1]) >= KEEP_OFF
        if (inside & far_enough).any():
            inside &= far_enough
    pick = []
    cand = np.argwhere(inside & (clear >= min(0.45, np.percentile(clear[inside], 60))))
    if not len(cand):
        cand = np.argwhere(inside)
    pts = np.stack([X0 + (cand[:, 1] + 0.5) * CELL, Y0 + (cand[:, 0] + 0.5) * CELL], 1)
    far = np.full(len(pts), 1e9)
    at = int(np.argmax(clear[cand[:, 0], cand[:, 1]]))
    for _ in range(count):
        pick.append([round(float(pts[at, 0]), 2), round(float(pts[at, 1]), 2)])
        far = np.minimum(far, np.hypot(*(pts - pts[at]).T))
        at = int(np.argmax(far))
    centre = pts.mean(0)
    return pick, [round(float(centre[0]), 2), round(float(centre[1]), 2)], int(inside.sum())


def main():
    a = sys.argv[1:]
    if len(a) < 2:
        raise SystemExit('usage: house-nav.py <gaussian_pointcloud.ply> <cameras.json> [--png <dir>] [--out <file>]')
    png = a[a.index('--png') + 1] if '--png' in a else None
    out = a[a.index('--out') + 1] if '--out' in a else OUT
    with open(FRAME) as fh:
        frame = json.load(fh)
    r_house, origin = np.array(frame['R']), np.array(frame['origin'])

    cache = os.path.join(png, 'voxels.npy') if png else None
    if cache and os.path.exists(cache):
        vox = np.load(cache)
    else:
        vox = voxels(a[0], frame)
        if cache:
            os.makedirs(png, exist_ok=True)
            np.save(cache, vox)
    nz, ny, nx = vox.shape
    zs = Z0 + (np.arange(nz) + 0.5) * VOX
    solid = vox > SOLID

    # How high each 5 cm column reaches: its highest solid voxel over the step height.
    body = solid & (zs[:, None, None] > 0.12)
    top = np.where(body, zs[:, None, None] + VOX / 2, 0).max(0)
    floor = (vox[(zs > -0.12) & (zs < 0.12)].sum(0) > SOLID) | (top > 0)

    with open(a[1]) as fh:
        poses = json.load(fh)
    cams = (np.array([c['position'] for c in poses]) - origin) @ r_house.T
    carried = cams[(cams[:, 2] > CARRY[0]) & (cams[:, 2] < CARRY[1])]
    # One position per frame of the capture (each frame is several views from one place), in order.
    number = np.array([int(c['img_name'].split('_')[0]) for c in poses])
    _, first = np.unique(number, return_index=True)
    frames = cams[first]
    frames = frames[(frames[:, 2] > HELD[0]) & (frames[:, 2] < HELD[1])]
    path = np.zeros((ny, nx), dtype=bool)
    px = np.floor((carried[:, 0] - X0) / VOX).astype(int)
    py = np.floor((carried[:, 1] - Y0) / VOX).astype(int)
    ok = (px >= 0) & (px < nx) & (py >= 0) & (py < ny)
    path[py[ok], px[ok]] = True
    print(f'PATH {len(carried)} of {len(cams)} poses at carrying height, {int(path.sum())} cells')
    walked = dilate(path, PATH_CLEAR, VOX)
    house = dilate(path, REACH, VOX)
    top[walked] = 0                                   # nothing stands where someone walked
    floor |= walked

    # To the game's 10 cm cells: a cell is as high as the highest thing in it.
    f = round(CELL / VOX)
    height = pool(top, f, np.max)
    has_floor = pool(floor, f, np.mean) >= 0.5
    in_house = pool(house, f, np.max)
    seeds = pool(walked, f, np.max)
    rows, cols = height.shape
    blocked = (height > STEP) | ~has_floor | ~in_house
    free = ~dilate(blocked, RADIUS, CELL)
    # Only the rooms are played in: the stairwell and whatever shows through a gap in a wall are not.
    owner = np.full((rows, cols), -1)
    for i, room in reversed(list(enumerate(ROOMS))):
        for rect in room[3]:
            owner[within((rows, cols), rect)] = i
    corridor = dilate(walked_line(frames, (rows, cols)), CELL, CELL) & (height <= STEP) & has_floor
    walk = largest(flood((free | corridor) & (owner >= 0), seeds | corridor))
    print(f'WALK {int(walk.sum())} cells ({walk.sum() * CELL * CELL:.1f} m2): {int((walk & free).sum())} in the open, '
          f'{int((walk & ~free).sum())} kept open along the capture\'s walk')

    # Distance from each walkable cell to the nearest thing in the way (m), by growing the blocked set.
    clear = np.zeros((rows, cols))
    grown = ~walk
    for step in range(1, 16):
        nxt = dilate(grown, CELL, CELL)
        clear[walk & ~nxt] = step * CELL
        grown = nxt

    # The player starts in the open middle of the start room; the second wave's way in is the
    # end of the entry passage.
    (start,), _, _ = spots(walk, clear, next(r for r in ROOMS if r[0] == START)[3][0], 1)
    (entry,), _, _ = spots(walk, clear, ENTRY, 1)
    rooms = []
    for i, room in enumerate(ROOMS):
        cells = int((walk & (owner == i)).sum())
        if not cells:
            raise SystemExit(f'{room[1]} is cut off from the rest of the house: no walkable floor in it')
        if not room[2]:
            print(f'ROOM {room[1]}: {cells * CELL * CELL:.1f} m2 walkable, nobody in it')
            continue
        stand, _, _ = spots(walk, clear, room[3][0], room[2], away=start)
        _, centre, _ = spots(walk, clear, room[3][0], 1)
        rooms.append({'id': room[0], 'name': room[1], 'rects': [list(r) for r in room[3]], 'centre': centre, 'spots': stand})
        print(f'ROOM {room[1]}: {cells * CELL * CELL:.1f} m2 walkable, raiders at {stand}')
    print(f'START {start} in the {START}, ENTRY {entry}')
    data = {
        'note': 'Written by scripts/pocapitol/house-nav.py from the house scan. House frame: metres, floor z = 0, x along the house.',
        'cell': CELL, 'x0': X0, 'y0': Y0, 'cols': cols, 'rows': rows, 'step': STEP, 'unit': 0.02,
        'height': base64.b64encode(np.where(has_floor & in_house, np.minimum(254, np.round(height / 0.02)), 255).astype(np.uint8).tobytes()).decode(),
        'walk': base64.b64encode(np.packbits(walk.ravel(), bitorder='little').tobytes()).decode(),
        'rooms': rooms,
        'start': {'x': start[0], 'y': start[1], 'lookX': start[0] + START_LOOK[0], 'lookY': start[1] + START_LOOK[1]},
        'entry': {'x': entry[0], 'y': entry[1]},
    }
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, 'w', newline='\n') as fh:
        json.dump(data, fh, separators=(',', ':'))
        fh.write('\n')
    print(f'WROTE {out}: {cols}x{rows} cells, {os.path.getsize(out) / 1024:.1f} KB')

    if png:
        from PIL import Image
        img = np.zeros((rows, cols, 3))
        img[..., 0] = img[..., 1] = img[..., 2] = np.clip(height / 1.9, 0, 1) * 0.8
        img[~has_floor | ~in_house] = [0.25, 0.0, 0.1]
        img[walk] = [0.1, 0.45, 0.2]
        img[walk] += np.clip(clear[walk] / 1.2, 0, 1)[:, None] * [0.0, 0.4, 0.1]
        img[walk & ~free] = [0.1, 0.35, 0.6]
        img[pool(path, f, np.max) & walk] = [0.9, 0.9, 0.2]
        for room in rooms:
            for sx, sy in room['spots']:
                img[int((sy - Y0) / CELL), int((sx - X0) / CELL)] = [1, 0.1, 0.1]
        img[int((start[1] - Y0) / CELL), int((start[0] - X0) / CELL)] = [0.2, 0.6, 1]
        img[int((entry[1] - Y0) / CELL), int((entry[0] - X0) / CELL)] = [1, 0.4, 1]
        Image.fromarray((np.clip(np.flipud(img), 0, 1) * 255).astype(np.uint8)).resize((cols * 6, rows * 6), Image.NEAREST).save(os.path.join(png, 'nav.png'))
        print('PNG', os.path.join(png, 'nav.png'))


if __name__ == '__main__':
    main()
