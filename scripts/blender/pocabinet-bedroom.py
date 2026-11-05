"""PoCabinet "Bedroom Floor GP": build the room model and the track from a scanned bedroom.

Headless Blender (5.x):

    blender -b --factory-startup -P scripts/blender/pocabinet-bedroom.py -- <BedroomScene.glb>
        [--preview out.png] [--nudge] [--fixture tests/Shared/Fixtures/pocabinet-bedroom-centerline.json]

Reads the merged room scan (10 meshes, unlit, 8K atlases, ~30 MB; up is the scan's -Y) and

1. stands it up (floor on z = 0), cuts the ceiling and the loose wall flaps off above
   CUT_Z, decimates it and shrinks the atlases, and writes a Draco GLB to
   src/PoMiniGames.Client/wwwroot/models/bedroom.glb (scene.js ROOM draws it at SIM_PER_UNIT / 10);
2. checks ROUTE against the room: every road sample's corridor (road + run-off, out to the
   barrier) is raycast against the scan and must clear the furniture, the road must sit on or
   above whatever it crosses (the cushion), and no two parts of the lap may share a corridor;
3. prints the knots, KnotZ and KnotBank for PoCabinetTrackGeometry ("bedroom"), already in sim
   units: x = SIM_PER_UNIT * x, y = -SIM_PER_UNIT * y (the GLB is Y-up, so room y is three's -z
   and the sim's y is three's z);
4. optionally renders a top-down preview of the room with the road laid on it;
5. --nudge: when the check fails, moves knots one at a time in shrinking steps, keeping any move
   that lowers the problem count, and prints the repaired ROUTE to paste back here;
6. --fixture: writes this script's own centerline samples (sim units) for the unit test that
   proves they equal PoCabinetTrackGeometry.BuildCenterlineXY: the route checked here is the
   road the game races.

The route itself is hand-laid here, in room units (about 4.3 to the metre), and is the one
place it lives: change ROUTE, re-run, paste the printed block into PoCabinetTrackGeometry.
"""

import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT_GLB = os.path.join(REPO, "src", "PoMiniGames.Client", "wwwroot", "models", "bedroom.glb")

# 150 sim units per room unit: a car (radius 14) is ~4 cm long, a Micro Machine on the carpet,
# and the lap comes out near Capitol's, long enough for a 100-car field.
SIM_PER_UNIT = 150.0
TRACK_WIDTH = 200.0           # sim; PoCabinetTrackGeometry["bedroom"].TrackWidth
RUN_OFF = 26.0                # physics.js RUN_OFF: the barrier stands this far past the road edge
STEPS = 10                    # StepsPerSegment
CUT_Z = 7.8                   # room units (~1.8 m): the ceiling and the flaps hanging from it go
# The whole lap rides this far above the ROUTE heights: ~2 ft (0.61 m at ~4.3 room units to the
# metre), a toy track on tall stilts over the furniture, the cushion's hump kept as a hill.
LIFT = 393.0                  # sim
DECIMATE = 0.5
TEXTURE_SHRINK = 4            # 8K atlases → 2K

# The lap, clockwise seen from above (room +y up): up the left wall past the drum kit, right
# below the closet's wall return (x -2.75..-2.45, y 3.35..4.75), then up off the carpet on
# stilts, left past the wall's end and right again along the top, a banked right-hander that
# carries the climb onto the floor cushion, along the cushion's top, a long drop off its end
# back to the carpet, an S round the office chair and back along the front of the drum kit.
# The climb and the drop are spread over ~5 knots each (no grade past ~27%): squeezed into two,
# the PoCabinet harness had the 100-car field strung out by 15 s a lap and piling up.
# (x, y) room units; z sim units (road height: 3 just
# clears the carpet's pile, 89 is the cushion's top); bank = tan of the cross slope, + = the
# sim's right side higher (the mirror makes these clockwise turns left-handers in the sim, so a
# turn banked into them is negative).
ROUTE = [
    (-3.90, 0.10, 3, -0.06),
    (-4.15, 0.95, 3, 0),
    (-3.90, 1.68, 3, -0.06),
    (-3.12, 2.17, 3, -0.08),
    (-1.93, 2.32, 3, 0),
    (-0.72, 3.15, 8, 0),
    (0.15, 3.25, 20, -0.06),
    (0.90, 2.85, 30, -0.14),
    (1.30, 1.90, 40, -0.08),
    (1.32, 0.98, 50, 0),
    (1.50, -0.60, 65, 0),
    (1.50, -2.00, 80, 0),
    (1.20, -3.20, 70, -0.08),
    (0.40, -3.85, 40, -0.12),
    (-0.72, -3.75, 15, -0.06),
    (-1.40, -3.10, 3, 0),
    (-1.62, -1.92, 3, 0),
    (-2.12, -1.08, 3, 0),
    (-3.30, -0.50, 3, -0.06),
]


def args():
    a = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if not a:
        raise SystemExit("usage: blender -b -P pocabinet-bedroom.py -- <BedroomScene.glb> [--preview out.png] [--nudge] [--fixture out.json]")
    preview = a[a.index("--preview") + 1] if "--preview" in a else None
    fixture = a[a.index("--fixture") + 1] if "--fixture" in a else None
    return a[0], preview, "--nudge" in a, fixture


def nudge(bvh):
    """Greedy repair: shift one knot at a time (8 directions, shrinking steps) while the
    problem count falls. Heights and banks stay; only x/y move. Returns the new route."""
    route = [list(p) for p in ROUTE]
    score = lambda r: len(check_route(bvh, [tuple(p) for p in r], quiet=True)[1])
    best = score(route)
    dirs = [(math.cos(i * math.pi / 4), math.sin(i * math.pi / 4)) for i in range(8)]
    for step in (0.12, 0.08, 0.05, 0.03):
        improved = True
        while improved and best:
            improved = False
            for k in range(len(route)):
                for dx, dy in dirs:
                    trial = [p[:] for p in route]
                    trial[k][0] += dx * step
                    trial[k][1] += dy * step
                    sc = score(trial)
                    if sc < best:
                        best, route, improved = sc, trial, True
                        break
        print(f"NUDGE step {step}: {best} problems left")
        if not best:
            break
    print("NUDGE paste this over ROUTE:")
    for p in route:
        print("    (%.2f, %.2f, %g, %g)," % tuple(p))
    return [tuple(p) for p in route], best


def write_fixture(path):
    """The centerline exactly as this script samples it, in sim units, for the parity test."""
    import json
    xs, ys = resample([p[0] for p in ROUTE]), resample([p[1] for p in ROUTE])
    xy = []
    for x, y in zip(xs, ys):
        xy += [round(x * SIM_PER_UNIT, 4), round(-y * SIM_PER_UNIT, 4)]
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump({"trackId": "bedroom", "stepsPerSegment": STEPS, "centerXY": xy}, f)
        f.write("\n")
    print(f"FIXTURE {path}: {len(xy) // 2} samples")


def catmull(p0, p1, p2, p3, t):
    """PoCabinetTrackGeometry.CatmullRom, so the samples here are the ones the game builds."""
    t2, t3 = t * t, t * t * t
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)


def resample(values):
    n = len(values)
    return [catmull(values[(i - 1) % n], values[i], values[(i + 1) % n], values[(i + 2) % n], s / STEPS)
            for i in range(n) for s in range(STEPS)]


def load_room(glb):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=glb)
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    stand_up = Matrix.Rotation(math.radians(-90), 4, "X")
    for o in meshes:
        o.matrix_world = stand_up @ o.matrix_world
        o.parent = None
    for o in [o for o in bpy.data.objects if o.type != "MESH"]:
        bpy.data.objects.remove(o)
    for o in meshes:
        o.data.transform(o.matrix_world)
        o.matrix_world = Matrix.Identity(4)
    return meshes


def bvh_of(meshes):
    verts, polys = [], []
    for o in meshes:
        base = len(verts)
        verts += [v.co.copy() for v in o.data.vertices]
        polys += [[base + i for i in p.vertices] for p in o.data.polygons]
    return BVHTree.FromPolygons(verts, polys)


def height(bvh, x, y, top=CUT_Z - 0.1):
    hit = bvh.ray_cast(Vector((x, y, top)), Vector((0, 0, -1)), 50)
    return hit[0].z if hit[0] is not None else None


def clean(meshes):
    bvh = bvh_of(meshes)
    probes = [height(bvh, x, y) for x, y in [(-2, 0), (-1, 2), (0, -1), (-3, 2), (-1.5, -1)]]
    floor = sorted(p for p in probes if p is not None)[len(probes) // 2]
    for o in meshes:
        o.data.transform(Matrix.Translation((0, 0, -floor)))
        bm = bmesh.new()
        bm.from_mesh(o.data)
        doomed = [f for f in bm.faces if min(v.co.z for v in f.verts) > CUT_Z]
        bmesh.ops.delete(bm, geom=doomed, context="FACES")
        bm.to_mesh(o.data)
        bm.free()
        dec = o.modifiers.new("decimate", "DECIMATE")
        dec.ratio = DECIMATE
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.modifier_apply(modifier=dec.name)
        # Seen from outside (a camera behind a wall), the walls should vanish: dollhouse.
        for slot in o.material_slots:
            if slot.material:
                slot.material.use_backface_culling = True
    print(f"FLOOR {floor:.4f} (moved to z = 0)")
    return bvh_of(meshes)


def check_route(bvh, route=None, quiet=False):
    """Samples and the list of problems (empty = the route is good)."""
    route = route or ROUTE
    xs, ys = resample([p[0] for p in route]), resample([p[1] for p in route])
    zs, banks = resample([p[2] + LIFT for p in route]), resample([p[3] for p in route])
    n = len(xs)
    wall = (TRACK_WIDTH / 2 + RUN_OFF) / SIM_PER_UNIT
    problems = []
    length = 0.0
    for i in range(n):
        j = (i + 1) % n
        length += math.hypot(xs[j] - xs[i], ys[j] - ys[i])
        tx, ty = xs[j] - xs[i - 1], ys[j] - ys[i - 1]
        tl = math.hypot(tx, ty)
        nx, ny = -ty / tl, tx / tl
        if zs[i] < 1.0:
            problems.append(f"sample {i}: road at {zs[i]:.1f} dips into the carpet")
        for k in range(-4, 5):
            lat = wall * k / 4
            h = height(bvh, xs[i] + nx * lat, ys[i] + ny * lat)
            if h is None:
                if zs[i] < 50:   # up on the stilts a hole in the floor scan is nobody's problem
                    problems.append(f"sample {i} lat {lat:+.2f}: a hole in the scan")
            elif h * SIM_PER_UNIT > zs[i] + 12:
                problems.append(f"sample {i} (knot {i / STEPS:.1f}) lat {lat:+.2f}: {h * SIM_PER_UNIT:.0f} sim of room above a road at {zs[i]:.0f}")
    # Tighter than this and the road's inside edge folds over itself: the field jams there.
    min_radius = TRACK_WIDTH / 2 + 40
    for i in range(n):
        a, b = (i - 1) % n, (i + 1) % n
        turn = math.atan2(ys[b] - ys[i], xs[b] - xs[i]) - math.atan2(ys[i] - ys[a], xs[i] - xs[a])
        turn = (turn + math.pi) % (2 * math.pi) - math.pi
        seg = math.hypot(xs[b] - xs[i], ys[b] - ys[i]) * SIM_PER_UNIT
        if abs(turn) > 1e-6 and seg / abs(turn) < min_radius:
            problems.append(f"sample {i} (knot {i / STEPS:.1f}): corner radius {seg / abs(turn):.0f} < {min_radius:.0f}")
    closest = min((math.hypot(xs[a] - xs[b], ys[a] - ys[b]), a, b)
                  for a in range(n) for b in range(a + 1, n)
                  if min(b - a, n - (b - a)) > STEPS * 2.5)
    if closest[0] < 2 * wall:
        problems.append(f"samples {closest[1]} and {closest[2]} share a corridor ({closest[0]:.2f} < {2 * wall:.2f})")
    if not quiet:
        print(f"LAP {length * SIM_PER_UNIT:.0f} sim, {n} samples, road {min(zs):.1f}..{max(zs):.1f}, nearest other part of the lap {closest[0] * SIM_PER_UNIT:.0f} sim")
        for p in problems[:400]:
            print("PROBLEM", p)
    return (xs, ys, zs, banks), problems


def print_csharp():
    def num(v):
        s = f"{v:.1f}".rstrip("0").rstrip(".")
        return "0" if s in ("-0", "") else s
    knots = ", ".join(f"({num(x * SIM_PER_UNIT)}, {num(-y * SIM_PER_UNIT)})" for x, y, _, _ in ROUTE)
    print("CSHARP Knots: [" + knots + "]")
    print("CSHARP KnotZ = [" + ", ".join(num(z + LIFT) for _, _, z, _ in ROUTE) + "]")
    print("CSHARP KnotBank = [" + ", ".join(f"{b:g}" for *_, b in ROUTE) + "]")


def export(meshes):
    for im in bpy.data.images:
        w, h = im.size
        if w > 512:
            im.scale(max(512, w // TEXTURE_SHRINK), max(512, h // TEXTURE_SHRINK))
    for o in bpy.data.objects:
        o.select_set(o in meshes)
    os.makedirs(os.path.dirname(OUT_GLB), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=OUT_GLB, export_format="GLB", use_selection=True,
        export_image_format="JPEG", export_image_quality=82,
        export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6,
        export_draco_position_quantization=14, export_draco_texcoord_quantization=12,
        export_normals=False, export_materials="EXPORT", export_yup=True)
    print(f"WROTE {OUT_GLB} {os.path.getsize(OUT_GLB) / 1e6:.2f} MB, "
          f"{sum(len(o.data.polygons) for o in meshes)} faces")


def preview(path, sampled):
    """Top-down render of the cleaned room with the road (orange) and barriers (white) on it."""
    xs, ys, zs, _ = sampled
    n = len(xs)
    hw = TRACK_WIDTH / 2 / SIM_PER_UNIT
    wall = hw + RUN_OFF / SIM_PER_UNIT
    verts, faces, rails = [], [], []
    for i in range(n):
        j = (i + 1) % n
        tx, ty = xs[j] - xs[i - 1], ys[j] - ys[i - 1]
        tl = math.hypot(tx, ty)
        nx, ny = -ty / tl, tx / tl
        z = zs[i] / SIM_PER_UNIT + 0.02
        verts += [(xs[i] + nx * hw, ys[i] + ny * hw, z), (xs[i] - nx * hw, ys[i] - ny * hw, z)]
        rails += [(xs[i] + nx * s * wall, ys[i] + ny * s * wall, z) for s in (1, -1)]
        faces.append((2 * i, 2 * j, 2 * j + 1, 2 * i + 1))
    road = bpy.data.meshes.new("road")
    road.from_pydata(verts, [], faces)
    road_obj = bpy.data.objects.new("road", road)
    mat = bpy.data.materials.new("toy")
    mat.diffuse_color = (1.0, 0.35, 0.05, 1)
    road.materials.append(mat)
    bpy.context.scene.collection.objects.link(road_obj)
    rail_mesh = bpy.data.meshes.new("rails")
    rf = []
    for i in range(n):
        j = (i + 1) % n
        for s in (0, 1):
            a, b = 2 * i + s, 2 * j + s
            rf.append((a, b, b + 2 * n, a + 2 * n))
    rail_mesh.from_pydata(rails + [(x, y, z + 0.12) for x, y, z in rails], [], rf)
    rmat = bpy.data.materials.new("rail")
    rmat.diffuse_color = (1, 1, 1, 1)
    rail_mesh.materials.append(rmat)
    bpy.context.scene.collection.objects.link(bpy.data.objects.new("rails", rail_mesh))

    sc = bpy.context.scene
    sc.render.engine = "BLENDER_WORKBENCH"
    sc.display.shading.light = "FLAT"
    sc.display.shading.color_type = "TEXTURE"
    sc.render.resolution_x, sc.render.resolution_y = 900, 1300
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    sc.collection.objects.link(cam)
    sc.camera = cam
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = 18.2
    cam.location = (0.2, -0.35, 30)
    sc.render.filepath = os.path.abspath(path)
    bpy.ops.render.render(write_still=True)
    print(f"PREVIEW {sc.render.filepath}")


def main():
    glb, preview_path, want_nudge, fixture = args()
    meshes = load_room(glb)
    bvh = clean(meshes)
    sampled, problems = check_route(bvh)
    if problems and want_nudge:
        nudge(bvh)
        raise SystemExit("route repaired above: paste it over ROUTE and run again")
    print_csharp()
    if fixture:
        write_fixture(fixture)
    if problems:
        raise SystemExit("route check failed; nothing exported (try --nudge)")
    export(meshes)
    if preview_path:
        preview(preview_path, sampled)


if __name__ == "__main__":
    main()
