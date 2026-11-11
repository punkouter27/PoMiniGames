"""PoCabinet "Rim to Rim": build the court model and the track from a scanned basketball court.

Headless Blender (5.x):

    blender -b --factory-startup -P scripts/blender/pocabinet-court.py -- <mesh.glb>
        [--preview out.png] [--fixture tests/Shared/Fixtures/pocabinet-court-centerline.json] [--no-export]

Reads the photogrammetry mesh of an outdoor court (one mesh, three 2048x4096 atlases, ~7 MB; the
scan's up is -Y in its own frame, roughly a metre to the unit) and

1. levels it into the court frame: fits the floor plane to the court, finds both backboards
   (the scan between 3.2 and 4.0 m over the floor is nothing but board), puts the floor on z = 0,
   the origin half way between the boards and +x from board A to board B, in metres;
2. crops it to the court and its surroundings, drops the loose scraps the scan left floating in
   the air, decimates, shrinks the atlases and writes a Draco GLB to
   src/PoMiniGames.Client/wwwroot/models/court.glb (models.js COURT draws it at SIM_PER_M / 10);
3. lays the lap (route_plan: lines and arcs from the start line over rim A, a corkscrew down
   round the centre circle under its own flyover, the climb onto rim B half way round, and the
   back leg down and up again to rim A) and checks it against the scan: the
   car's space over every road sample is clear of the scan, nothing stands in the corridor, the
   two levels of the flyover are far enough apart, no corner is tighter than the road is wide and
   no grade is steeper than MAX_GRADE;
4. prints the knots, KnotZ and KnotBank for
   PoCabinetTrackGeometry ("court"), already in sim units: x = SIM_PER_M * x, y = -SIM_PER_M * y
   (the GLB is Y-up, so court y is three's -z and the sim's y is three's z);
5. optionally renders a top-down preview of the court with the road on it, and writes this
   script's centerline samples for the unit test that proves they equal
   PoCabinetTrackGeometry.BuildCenterlineXY (the route checked here is the road the game races).

pocabinet-court-splat.py imports this file for the same court frame.
"""

import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT_GLB = os.path.join(REPO, "src", "PoMiniGames.Client", "wwwroot", "models", "court.glb")

# 100 sim units per metre: a car (radius 14) is a ~28 cm toy, a little longer than the rim is
# wide, and a lap round the court comes out near 9,400 units, about 75 s: three of them is a
# four-minute race.
SIM_PER_M = 100.0
TRACK_WIDTH = 84.0           # sim; PoCabinetTrackGeometry["court"].TrackWidth
RUN_OFF = 26.0                # physics.js RUN_OFF: the barrier stands this far past the road edge
STEPS = 8                     # StepsPerSegment
KNOT_SPACING = 1.25           # metres between knots

# Regulation hoop: the rim's centre is 15 cm + its 22.9 cm radius out from the board's face, and
# 3.05 m up. The road crosses each rim parallel to its board, a little court-side of the rim's
# centre so the barrier clears the board, and its deck sits just over the rim.
RIM_FROM_BOARD = 0.38
ROAD_FROM_BOARD = 0.8         # the corridor (road + run-off, 0.68 m each side) clears the board by 12 cm
RIM_DECK = 3.22               # m: the road over the rims (start line and grid on A, half way on B)
FLOOR_DECK = 0.08             # m: the road where it lies on the court

# Where the scan is: rough positions of the two hoops in the scan's own (flipped) frame, used only
# to find the court before the frame is known.
SEED_A = (6.0, -5.5)
SEED_B = (30.6, 5.5)

CROP_X, CROP_Y, CUT_Z = 25.0, 17.0, 9.0     # metres kept around the court (the trees past it are fog)
SCRAP_FACES = 300             # loose parts smaller than this, clear of the ground, are scan noise
DECIMATE = 0.6
TEXTURE_SHRINK = 2            # 2048x4096 atlases -> 1024x2048

HEADROOM = 0.22               # m of scan-free space a toy car needs over the road
CROSS_CLEAR = 0.6             # m between the two levels where the route crosses itself
MAX_GRADE = 0.2

LOOP_R = 3.8                  # m: the corkscrew round the centre circle
# The corkscrew's road is this much wider than the rest (KnotWidth): at the normal width a 100-car
# field runs wide all the way round it and a third of the laps break track limits.
LOOP_WIDTH = 1.35


def route_plan(half):
    """The route as turtle moves from the start line, in court metres (x from board A to board B,
    y to the left of that, z up). `half` is half the distance between the boards. Each move is
    ("line", length, z_at_end), ("arc", radius, degrees (+ = left), z_at_end), ("line_to_x", x,
    z_at_end) or ("line_to_start", z); a z of None holds the height. A trailing string marks the
    knot the move ends on."""
    xa, xb = -(half - ROAD_FROM_BOARD), half - ROAD_FROM_BOARD
    start = (xa, 0.0, -90.0)          # over rim A, heading -y
    moves = [
        # Off the top of rim A and down: a left-hander onto the run in along y = -LOOP_R.
        ("line", 1.0, RIM_DECK - 0.04),
        ("arc", 2.8, 90, 2.35),
        ("line", (xa + 2.8) * -1 - LOOP_R, 1.55, "flyover"),       # to where the loop comes back under
        # The corkscrew: once round the centre circle, down to the floor, under the run in.
        ("line", LOOP_R, 1.32, "loop"),
        ("arc", LOOP_R, 270, 0.2),
        ("line", LOOP_R, FLOOR_DECK, "underpass"),
        # Out along the far side and the long climb, spiralling up onto rim B.
        ("line", 6.2 - LOOP_R - 1.8, FLOOR_DECK),
        ("arc", 1.8, 90, 0.45),
        ("line", (xb - 3.0) - (-LOOP_R + 1.8), 2.4),
        ("arc", 3.0, 90, RIM_DECK - 0.06),
        ("line", 6.2 - 3.0, RIM_DECK, "mid"),
        # Half way: over rim B, on past it and round to the left, dropping off the deck.
        ("line", 1.2, RIM_DECK - 0.02),
        ("arc", 2.6, 90, 2.7),
        ("line", 2.6, 2.4),
        # The back leg: out wide of the loop, down along the far side and the climb back up.
        ("arc", 3.0, -60, 2.0),
        ("arc", 3.0, 60, 1.6),
        ("line_to_x", 0.0, 1.35),
        ("line_to_x", xa + 2.0, 2.75),
        # Round onto rim A's line and down the start deck the grid stands on, to the line.
        ("arc", 2.0, 90, RIM_DECK - 0.04),
        ("line_to_start", RIM_DECK),
    ]
    return start, moves


def build_route(half):
    """Knots [(x, y, z)] in court metres and the indices of the marked knots."""
    (x, y, hd), moves = route_plan(half)
    knots = [(x, y, RIM_DECK)]
    marks = {}
    z = RIM_DECK

    def push(nx, ny, nz):
        knots.append((nx, ny, nz))

    for mv in moves:
        kind = mv[0]
        z0 = z
        if kind == "line":
            length, z = mv[1], (mv[2] if mv[2] is not None else z)
            n = max(1, round(length / KNOT_SPACING))
            dx, dy = math.cos(math.radians(hd)), math.sin(math.radians(hd))
            for k in range(1, n + 1):
                t = k / n
                push(x + dx * length * t, y + dy * length * t, z0 + (z - z0) * t)
            x, y = x + dx * length, y + dy * length
        elif kind == "arc":
            r, deg, z = mv[1], mv[2], (mv[3] if mv[3] is not None else z)
            side = 1 if deg > 0 else -1
            cx = x + r * math.cos(math.radians(hd + 90 * side))
            cy = y + r * math.sin(math.radians(hd + 90 * side))
            a0 = math.atan2(y - cy, x - cx)
            # A knot at least every 30 degrees, or the spline cuts a tight bend's corner.
            n = max(math.ceil(abs(deg) / 30), round(abs(math.radians(deg)) * r / KNOT_SPACING))
            for k in range(1, n + 1):
                t = k / n
                a = a0 + math.radians(deg) * t
                push(cx + r * math.cos(a), cy + r * math.sin(a), z0 + (z - z0) * t)
            x, y = knots[-1][0], knots[-1][1]
            hd += deg
        elif kind == "line_to_x":
            # Straight on (heading along ±x) until x reaches the target.
            length = abs(mv[1] - x)
            z = mv[2]
            n = max(1, round(length / KNOT_SPACING))
            dx, dy = math.cos(math.radians(hd)), math.sin(math.radians(hd))
            for k in range(1, n + 1):
                t = k / n
                push(x + dx * length * t, y + dy * length * t, z0 + (z - z0) * t)
            x, y = x + dx * length, y + dy * length
        elif kind == "line_to_start":
            # Straight down the start deck to the knot before knot 0 (the loop closes there).
            sx, sy, _ = knots[0]
            length = math.hypot(sx - x, sy - y)
            n = max(1, round(length / KNOT_SPACING))
            for k in range(1, n):
                t = k / n
                push(x + (sx - x) * t, y + (sy - y) * t, mv[1])
        if isinstance(mv[-1], str):
            marks[mv[-1]] = len(knots) - 1
    # Round off the height profile's corners (where one grade meets the next), twice; the
    # rims stay exactly at deck height.
    pinned = {0, marks["mid"]}
    for _ in range(2):
        zs = [k[2] for k in knots]
        n = len(zs)
        knots = [(x, y, z if i in pinned else (zs[i - 1] + 2 * z + zs[(i + 1) % n]) / 4)
                 for i, (x, y, z) in enumerate(knots)]
    return knots, marks


def widths(knots, marks):
    """Road width per knot as a share of TRACK_WIDTH: LOOP_WIDTH round the corkscrew, easing in
    and out over a knot either side."""
    lo, hi = marks["loop"], marks["underpass"]
    out = []
    for i in range(len(knots)):
        if lo <= i <= hi:
            out.append(LOOP_WIDTH)
        elif i in (lo - 1, hi + 1):
            out.append(round((1 + LOOP_WIDTH) / 2, 3))
        else:
            out.append(1.0)
    return out


def args():
    a = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if not a:
        raise SystemExit("usage: blender -b -P pocabinet-court.py -- <mesh.glb> [--preview out.png] [--fixture out.json] [--no-export]")
    preview = a[a.index("--preview") + 1] if "--preview" in a else None
    fixture = a[a.index("--fixture") + 1] if "--fixture" in a else None
    return a[0], preview, fixture, "--no-export" not in a


# ── The scan and the court frame ─────────────────────────────────────────────

def load_scan(glb):
    """The scan's meshes, transforms baked in, turned so its up (-Y, -Z once imported) is +Z."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=glb)
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    flip = Matrix.Rotation(math.pi, 4, "X")
    for o in meshes:
        o.data.transform(flip @ o.matrix_world)
        o.matrix_world = Matrix.Identity(4)
        o.parent = None
    for o in [o for o in bpy.data.objects if o.type != "MESH"]:
        bpy.data.objects.remove(o)
    return meshes


def verts_of(meshes):
    return np.concatenate([np.array([v.co[:] for v in o.data.vertices]) for o in meshes])


def court_frame(v):
    """4x4 (numpy) from the flipped scan frame to the court frame, and half the board-to-board
    distance. Deterministic: the same scan gives the same frame every run."""
    a, b = np.array(SEED_A), np.array(SEED_B)
    ax = (b - a) / np.linalg.norm(b - a)
    nrm = np.array([-ax[1], ax[0]])
    mid = (a + b) / 2
    rel = v[:, :2] - mid
    court = (np.abs(rel @ ax) < 12) & (np.abs(rel @ nrm) < 6)
    p = v[court]
    keep = np.ones(len(p), bool)
    for _ in range(8):
        lhs = np.c_[p[keep, 0], p[keep, 1], np.ones(keep.sum())]
        c, *_ = np.linalg.lstsq(lhs, p[keep, 2], rcond=None)
        r = p[:, 2] - (p[:, 0] * c[0] + p[:, 1] * c[1] + c[2])
        keep = np.abs(r) < max(0.05, 3 * np.median(np.abs(r[keep])))
    # Level: turn the floor's normal onto +z about the floor point under the court's middle.
    n = np.array([-c[0], -c[1], 1.0])
    n /= np.linalg.norm(n)
    level = np.array(Vector(n).rotation_difference(Vector((0, 0, 1))).to_matrix())
    o = np.array([mid[0], mid[1], mid[0] * c[0] + mid[1] * c[1] + c[2]])
    lv = (v - o) @ level.T
    la = (np.r_[a, 0] - o) @ level.T
    lb = (np.r_[b, 0] - o) @ level.T

    def board(seed):
        near = (np.hypot(lv[:, 0] - seed[0], lv[:, 1] - seed[1]) < 3.5) & (lv[:, 2] > 3.2) & (lv[:, 2] < 4.0)
        q = lv[near]
        ref = (lb - la)[:2] / np.linalg.norm((lb - la)[:2])
        side = np.array([-ref[1], ref[0]])
        u, w = q[:, :2] @ ref, q[:, :2] @ side
        face_u = np.median(u)
        mid_w = (np.percentile(w, 5) + np.percentile(w, 95)) / 2
        return face_u * ref + mid_w * side, len(q)

    pa, na = board(la)
    pb, nb = board(lb)
    xdir = (pb - pa) / np.linalg.norm(pb - pa)
    origin = (pa + pb) / 2
    yaw = np.array([[xdir[0], xdir[1], 0], [-xdir[1], xdir[0], 0], [0, 0, 1]])
    rot = yaw @ level
    m = np.eye(4)
    m[:3, :3] = rot
    m[:3, 3] = -yaw @ np.r_[origin, 0] - rot @ o
    half = float(np.linalg.norm(pb - pa) / 2)
    tilt = math.degrees(math.acos(n[2]))
    print(f"FRAME floor tilt {tilt:.2f} deg, floor fit mad {np.median(np.abs(r[keep])):.3f} m; "
          f"boards {2 * half:.2f} m apart ({na} + {nb} board points)")
    return m, half


def to_court(meshes):
    v = verts_of(meshes)
    m, half = court_frame(v)
    for o in meshes:
        o.data.transform(Matrix(m.tolist()))
    return m, half


def bvh_of(meshes):
    verts, polys = [], []
    for o in meshes:
        base = len(verts)
        verts += [v.co.copy() for v in o.data.vertices]
        polys += [[base + i for i in p.vertices] for p in o.data.polygons]
    return BVHTree.FromPolygons(verts, polys)


def clean(meshes, half):
    """Crop to the court and its surroundings, drop floating scraps (never the hoops: a backboard
    is a loose part in the air too), decimate."""
    for o in meshes:
        bm = bmesh.new()
        bm.from_mesh(o.data)
        doomed = [f for f in bm.faces
                  if any(abs(v.co.x) > CROP_X or abs(v.co.y) > CROP_Y or v.co.z > CUT_Z for v in f.verts)]
        bmesh.ops.delete(bm, geom=doomed, context="FACES")
        # Loose parts: flood-fill faces over shared edges.
        bm.faces.ensure_lookup_table()
        seen, scraps = set(), []
        for f in bm.faces:
            if f.index in seen:
                continue
            part, stack = [], [f]
            seen.add(f.index)
            while stack:
                g = stack.pop()
                part.append(g)
                for e in g.edges:
                    for h in e.link_faces:
                        if h.index not in seen:
                            seen.add(h.index)
                            stack.append(h)
            c = part[0].verts[0].co
            hoop = abs(abs(c.x) - half) < 2.5 and abs(c.y) < 2.0
            if not hoop and len(part) < SCRAP_FACES and min(v.co.z for g in part for v in g.verts) > 0.4:
                scraps += part
        bmesh.ops.delete(bm, geom=scraps, context="FACES")
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
        bm.to_mesh(o.data)
        bm.free()
        print(f"CLEAN {o.name}: {len(scraps)} faces of floating scraps dropped")
        dec = o.modifiers.new("decimate", "DECIMATE")
        dec.ratio = DECIMATE
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.modifier_apply(modifier=dec.name)
    return bvh_of(meshes)


# ── The route ────────────────────────────────────────────────────────────────

def catmull(p0, p1, p2, p3, t):
    """PoCabinetTrackGeometry.CatmullRom, so the samples here are the ones the game builds."""
    t2, t3 = t * t, t * t * t
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)


def resample(values):
    n = len(values)
    return [catmull(values[(i - 1) % n], values[i], values[(i + 1) % n], values[(i + 2) % n], s / STEPS)
            for i in range(n) for s in range(STEPS)]


def sim_knots(knots):
    """Knots in sim units, rounded as printed (so the fixture matches the C# to the digit)."""
    r = lambda v: round(v, 1)
    return [(r(x * SIM_PER_M), r(-y * SIM_PER_M), r(z * SIM_PER_M)) for x, y, z in knots]


def banks(sk, share):
    """Cross slope per knot from the sim centerline's curvature: a turn is banked into, harder the
    tighter it is, never so far that the low edge of the run-off goes under the court."""
    n = len(sk)
    raw = []
    for i in range(n):
        a, b, c = sk[i - 1], sk[i], sk[(i + 1) % n]
        h1 = math.atan2(b[1] - a[1], b[0] - a[0])
        h2 = math.atan2(c[1] - b[1], c[0] - b[0])
        turn = (h2 - h1 + math.pi) % (2 * math.pi) - math.pi
        span = (math.hypot(b[0] - a[0], b[1] - a[1]) + math.hypot(c[0] - b[0], c[1] - b[1])) / 2
        k = turn / max(span, 1e-6)          # + = heading angle grows: a right-hander in the sim
        raw.append(-max(-0.24, min(0.24, 90 * k)))
    out = []
    for i in range(n):
        v = (raw[i - 1] + 2 * raw[i] + raw[(i + 1) % n]) / 4
        cap = max(0.0, (sk[i][2] - 6) / (TRACK_WIDTH / 2 * share[i] + RUN_OFF))
        out.append(round(max(-cap, min(cap, v)), 3) + 0.0)   # never "-0"
    return out


def check_route(bvh, knots, marks):
    """Samples (court metres) and the list of problems (empty = the route is good)."""
    sk = sim_knots(knots)
    xs = [x / SIM_PER_M for x in resample([k[0] for k in sk])]
    ys = [-y / SIM_PER_M for y in resample([k[1] for k in sk])]
    zs = [z / SIM_PER_M for z in resample([k[2] for k in sk])]
    n = len(xs)
    share = resample(widths(knots, marks))
    walls = [(TRACK_WIDTH / 2 * w + RUN_OFF) / SIM_PER_M for w in share]
    hidden = (marks.get("hidden", 0) * STEPS, marks.get("deck", 0) * STEPS)
    drawn = lambda i: not (hidden[0] <= i < hidden[1])
    problems = []
    length = [0.0]
    for i in range(n):
        j = (i + 1) % n
        length.append(length[-1] + math.hypot(xs[j] - xs[i], ys[j] - ys[i]))
    for i in range(n):
        if not drawn(i):
            continue
        j = (i + 1) % n
        tx, ty = xs[j] - xs[i - 1], ys[j] - ys[i - 1]
        tl = math.hypot(tx, ty)
        nx, ny = -ty / tl, tx / tl
        tag = f"sample {i} (knot {i / STEPS:.1f})"
        wall = walls[i]
        if zs[i] < 0.03:
            problems.append(f"{tag}: road at {zs[i]:.2f} m is in the court")
        # The car's space over the road and the run-off: nothing of the scan in it.
        for k in range(-4, 5):
            lat = wall * k / 4
            px, py = xs[i] + nx * lat, ys[i] + ny * lat
            hit = bvh.ray_cast(Vector((px, py, zs[i] + HEADROOM)), Vector((0, 0, -1)), HEADROOM)
            if hit[0] is not None and hit[0].z > zs[i] + 0.03:
                problems.append(f"{tag} lat {lat:+.2f}: scan at {hit[0].z:.2f} m over a road at {zs[i]:.2f}")
        # Nothing standing in the corridor (a backboard, a pole): rays out to the barrier.
        for s in (-1, 1):
            for up in (0.06, HEADROOM):
                hit = bvh.ray_cast(Vector((xs[i], ys[i], zs[i] + up)), Vector((nx * s, ny * s, 0)), wall)
                if hit[0] is not None:
                    problems.append(f"{tag}: the scan stands {hit[3]:.2f} m to the {'left' if s > 0 else 'right'}, inside the barrier")
        ds = length[i + 1] - length[i]
        grade = (zs[(i + 1) % n] - zs[i]) / max(ds, 1e-6)
        if abs(grade) > MAX_GRADE:
            problems.append(f"{tag}: grade {grade:+.0%}")
    for i in range(n):
        min_radius = (TRACK_WIDTH / 2 * share[i] + 40) / SIM_PER_M
        a, b = (i - 1) % n, (i + 1) % n
        turn = math.atan2(ys[b] - ys[i], xs[b] - xs[i]) - math.atan2(ys[i] - ys[a], xs[i] - xs[a])
        turn = (turn + math.pi) % (2 * math.pi) - math.pi
        seg = math.hypot(xs[b] - xs[i], ys[b] - ys[i])
        if abs(turn) > 1e-6 and seg / abs(turn) < min_radius:
            problems.append(f"sample {i} (knot {i / STEPS:.1f}): corner radius {seg / abs(turn):.2f} m < {min_radius:.2f}")
    # Two parts of the loop that share a corridor must be a flyover: one well over the other.
    crossings = set()
    pts = np.c_[xs, ys]
    for a in range(n):
        d = np.hypot(pts[:, 0] - xs[a], pts[:, 1] - ys[a])
        for b in np.nonzero(d < walls[a] + np.array(walls))[0]:
            if b <= a or min(b - a, n - (b - a)) <= STEPS * 3:
                continue
            gap = abs(zs[a] - zs[b])
            if gap < CROSS_CLEAR:
                problems.append(f"samples {a} and {b} share a corridor {gap:.2f} m apart in height")
            else:
                crossings.add((a // STEPS, b // STEPS))
    mid = length[marks["mid"] * STEPS]
    print(f"ROUTE {len(knots)} knots, {n} samples, lap {length[-1]:.1f} m = {length[-1] * SIM_PER_M:.0f} sim, "
          f"rim B at {mid * SIM_PER_M:.0f} sim, road {min(zs):.2f}..{max(zs):.2f} m, "
          f"flyover knots {sorted(crossings)[:1]}..{sorted(crossings)[-1:] if crossings else ''}")
    for p in problems[:300]:
        print("PROBLEM", p)
    return (xs, ys, zs), problems


def print_csharp(knots, marks):
    sk = sim_knots(knots)

    def num(v):
        s = f"{v:.1f}".rstrip("0").rstrip(".")
        return "0" if s in ("-0", "") else s

    rows = [sk[i:i + 6] for i in range(0, len(sk), 6)]
    print("CSHARP Knots:")
    for row in rows:
        print("CSHARP     " + ", ".join(f"({num(x)}, {num(y)})" for x, y, _ in row) + ",")
    print("CSHARP KnotZ:")
    for row in rows:
        print("CSHARP     " + ", ".join(num(z) for *_, z in row) + ",")
    print("CSHARP KnotBank:")
    share = widths(knots, marks)
    b = banks(sk, share)
    for i in range(0, len(b), 12):
        print("CSHARP     " + ", ".join(f"{v:g}" for v in b[i:i + 12]) + ",")
    print("CSHARP KnotWidth:")
    for i in range(0, len(share), 12):
        print("CSHARP     " + ", ".join(f"{v:g}" for v in share[i:i + 12]) + ",")
    print(f"CSHARP rim B (half way) is knot {marks['mid']}; StepsPerSegment {STEPS}")


def write_fixture(path, knots):
    """The centerline exactly as this script samples it, in sim units, for the parity test."""
    import json
    sk = sim_knots(knots)
    xs, ys = resample([k[0] for k in sk]), resample([k[1] for k in sk])
    xy = []
    for x, y in zip(xs, ys):
        xy += [round(x, 4), round(y, 4)]
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump({"trackId": "court", "stepsPerSegment": STEPS, "centerXY": xy}, f)
        f.write("\n")
    print(f"FIXTURE {path}: {len(xy) // 2} samples")


def export(meshes):
    for im in bpy.data.images:
        w, h = im.size
        if max(w, h) > 1024:
            im.scale(max(256, w // TEXTURE_SHRINK), max(256, h // TEXTURE_SHRINK))
    for o in bpy.data.objects:
        o.select_set(o in meshes)
    for o in meshes:
        for slot in o.material_slots:
            if slot.material:
                slot.material.use_backface_culling = False
    os.makedirs(os.path.dirname(OUT_GLB), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=OUT_GLB, export_format="GLB", use_selection=True,
        export_image_format="JPEG", export_image_quality=82,
        export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6,
        export_draco_position_quantization=14, export_draco_texcoord_quantization=12,
        export_normals=False, export_materials="EXPORT", export_yup=True)
    print(f"WROTE {OUT_GLB} {os.path.getsize(OUT_GLB) / 1e6:.2f} MB, "
          f"{sum(len(o.data.polygons) for o in meshes)} faces")


def preview(path, sampled, marks):
    """Top-down render of the court with the road (orange, the return link grey) and barriers."""
    xs, ys, zs = sampled
    n = len(xs)
    hw = TRACK_WIDTH / 2 / SIM_PER_M
    wall = hw + RUN_OFF / SIM_PER_M
    hidden = (marks.get("hidden", 0) * STEPS, marks.get("deck", 0) * STEPS)
    for name, color, pick in (("road", (1.0, 0.35, 0.05, 1), lambda i: not (hidden[0] <= i < hidden[1])),
                              ("link", (0.55, 0.55, 0.55, 1), lambda i: hidden[0] <= i < hidden[1])):
        verts, faces = [], []
        for i in range(n):
            j = (i + 1) % n
            tx, ty = xs[j] - xs[i - 1], ys[j] - ys[i - 1]
            tl = math.hypot(tx, ty)
            nx, ny = -ty / tl, tx / tl
            z = zs[i] + 0.02 + 20
            w = hw if name == "road" else hw * 0.5
            verts += [(xs[i] + nx * w, ys[i] + ny * w, z), (xs[i] - nx * w, ys[i] - ny * w, z)]
            if pick(i):
                faces.append((2 * i, 2 * j, 2 * j + 1, 2 * i + 1))
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata(verts, [], faces)
        mat = bpy.data.materials.new(name)
        mat.diffuse_color = color
        mesh.materials.append(mat)
        bpy.context.scene.collection.objects.link(bpy.data.objects.new(name, mesh))
    # Start and finish lines.
    for key, color in (("start", (1, 1, 1, 1)), ("mid", (0.1, 0.1, 0.1, 1))):
        i = 0 if key == "start" else marks["mid"] * STEPS
        j = (i + 1) % n
        tx, ty = xs[j] - xs[i - 1], ys[j] - ys[i - 1]
        tl = math.hypot(tx, ty)
        nx, ny, ux, uy = -ty / tl, tx / tl, tx / tl, ty / tl
        z = zs[i] + 20.05
        v = [(xs[i] + nx * wall + ux * s, ys[i] + ny * wall + uy * s, z) for s in (-0.12, 0.12)]
        v += [(xs[i] - nx * wall + ux * s, ys[i] - ny * wall + uy * s, z) for s in (0.12, -0.12)]
        mesh = bpy.data.meshes.new(key)
        mesh.from_pydata(v, [], [(0, 1, 2, 3)])
        mat = bpy.data.materials.new(key)
        mat.diffuse_color = color
        mesh.materials.append(mat)
        bpy.context.scene.collection.objects.link(bpy.data.objects.new(key, mesh))

    sc = bpy.context.scene
    sc.render.engine = "BLENDER_WORKBENCH"
    sc.display.shading.light = "FLAT"
    sc.display.shading.color_type = "TEXTURE"
    sc.render.resolution_x, sc.render.resolution_y = 1600, 1000
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    sc.collection.objects.link(cam)
    sc.camera = cam
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = 34
    cam.data.clip_end = 200
    cam.location = (0, 0, 60)
    sc.render.filepath = os.path.abspath(path)
    bpy.ops.render.render(write_still=True)
    print(f"PREVIEW {sc.render.filepath}")


def main():
    glb, preview_path, fixture, want_export = args()
    meshes = load_scan(glb)
    _, half = to_court(meshes)
    bvh = clean(meshes, half)
    knots, marks = build_route(half)
    sampled, problems = check_route(bvh, knots, marks)
    print_csharp(knots, marks)
    if fixture:
        write_fixture(fixture, knots)
    if preview_path:
        preview(preview_path, sampled, marks)
    if problems:
        raise SystemExit(f"route check failed ({len(problems)} problems); nothing exported")
    if want_export:
        # The preview added its own meshes: export only the scan's.
        export(meshes)


if __name__ == "__main__":
    main()
