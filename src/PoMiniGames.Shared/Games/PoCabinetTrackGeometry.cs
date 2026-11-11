namespace PoMiniGames.Shared.Games;

/// <summary>
/// Knots, road width and atmosphere for one PoCabinet track. <see cref="PoCabinetTrackGeometry"/>
/// is the ONE place these live: the server sim, the solo in-browser race and the client
/// scene/minimap all derive their centerline from here, so the road a player sees is the
/// road the race is run on.
/// </summary>
public sealed record PoCabinetTrackDefinition(
    string Id,
    double TrackWidth,
    IReadOnlyList<(double X, double Y)> Knots,
    int StepsPerSegment,
    PoCabinetAtmosphereWire Atmosphere)
{
    /// <summary>Laps in a race on this track.</summary>
    public int Laps { get; init; } = PoCabinetCatalog.TotalLaps;

    /// <summary>
    /// Point-to-point tracks: the knot the finish line sits on. 0 = a circuit, whose lap ends
    /// back at knot 0. The knots still close into a loop (every wrap in the physics relies on
    /// it); the part after the finish is a return link nobody drives.
    /// </summary>
    public int FinishKnot { get; init; }

    /// <summary>Knots from here up to <see cref="HiddenToKnot"/> are the return link: simulated
    /// as centerline, never drawn.</summary>
    public int HiddenFromKnot { get; init; }
    public int HiddenToKnot { get; init; }

    /// <summary>Road height per knot (sim units), or null for a flat track. The physics reads its
    /// grade (gravity along the road); the scene lays the road, the ground and the scenery on it.</summary>
    public IReadOnlyList<double>? KnotZ { get; init; }

    /// <summary>Cross slope per knot (tan of the bank, + = right side higher), or null. The
    /// physics gives a turn banked into it more grip.</summary>
    public IReadOnlyList<double>? KnotBank { get; init; }

    /// <summary>The knot the scene starts laying tarmac at. 0 = the whole track is tarmac;
    /// otherwise an open chute (the model's gutter, without its walls) runs up to here.
    /// Render-only.</summary>
    public int RoadFromKnot { get; init; }

    /// <summary>Road width per knot as a share of <see cref="PoCabinetTrackDefinition.TrackWidth"/>
    /// (null = the same all the way round): pinch points and wide braking zones.</summary>
    public IReadOnlyList<double>? KnotWidth { get; init; }

    /// <summary>What lies between the road edge and the barrier where no zone says otherwise.</summary>
    public PoCabinetRunoff DefaultRunoff { get; init; } = PoCabinetRunoff.Grass;

    /// <summary>Run-off that differs from <see cref="DefaultRunoff"/>: gravel traps, tarmac run-off.</summary>
    public IReadOnlyList<PoCabinetRunoffZone>? Runoff { get; init; }

    /// <summary>Knot ranges whose apex kerbs are raised "sausage" kerbs (the chicanes): they
    /// unsettle a car that takes too much of them.</summary>
    public IReadOnlyList<(double FromKnot, double ToKnot)>? Sausages { get; init; }

    /// <summary>Patches of road with their own grip: resurfaced, dusty, bumpy, puddles in the rain.</summary>
    public IReadOnlyList<PoCabinetPatchDef>? Patches { get; init; }

    /// <summary>Split sections: a divider down the road with a lane either side, one of them the
    /// shorter, slower-surfaced joker line.</summary>
    public IReadOnlyList<PoCabinetIslandDef>? Islands { get; init; }

    /// <summary>The scenery, sky and props the scene dresses the track in (default: the id).</summary>
    public string? Theme { get; init; }
}

/// <summary>What lies between the road edge and the barrier. Grass drags and has little grip;
/// gravel beaches a car fast; tarmac run-off costs nothing but the lap (track limits).</summary>
public enum PoCabinetRunoff
{
    Grass = 0,
    Gravel = 1,
    Tarmac = 2,
}

/// <summary>Run-off of <paramref name="Kind"/> on knots [<paramref name="FromKnot"/>,
/// <paramref name="ToKnot"/>) (wrapping past the line when From &gt; To), on one side
/// (-1 left, +1 right) or both (0).</summary>
public sealed record PoCabinetRunoffZone(double FromKnot, double ToKnot, int Side, PoCabinetRunoff Kind);

/// <summary>A patch of road from knot <paramref name="FromKnot"/> to <paramref name="ToKnot"/>,
/// between two lateral offsets given as shares of the local half width (-1 = the left edge,
/// +1 the right), whose grip is multiplied by <paramref name="DryGrip"/> or, in the rain,
/// <paramref name="WetGrip"/>. <paramref name="Kind"/> is what the scene draws (resurfaced,
/// dusty, bumpy, puddle, paint, dirt).</summary>
public sealed record PoCabinetPatchDef(double FromKnot, double ToKnot, double LatFrom, double LatTo, double DryGrip, double WetGrip, string Kind);

/// <summary>A divider from knot <paramref name="FromKnot"/> to <paramref name="ToKnot"/>
/// between two lateral offsets (sim units). <paramref name="ShortSide"/> (-1 left, +1 right) is
/// the joker lane: the shorter way round, usually on a worse surface (a patch says which).</summary>
public sealed record PoCabinetIslandDef(double FromKnot, double ToKnot, double LatFrom, double LatTo, int ShortSide);

/// <summary>
/// Shared track geometry. World units are the sim's: car radius 14, speeds in units/s
/// (<c>PoCabinetPhysics</c> on the server, <c>js/pocabinet/physics.js</c> in the browser).
/// The scene divides by 10 when it builds meshes.
/// </summary>
public static class PoCabinetTrackGeometry
{
    /// <summary>Knot scale. The hand-tuned knots were authored at a size that made a lap ~45 s at
    /// sim top speed; 0.75 lands laps near 25–30 s, which is what a 3-lap arcade race wants.</summary>
    private const double KnotScale = 0.75;

    private static readonly Dictionary<string, PoCabinetTrackDefinition> Definitions =
        new(StringComparer.OrdinalIgnoreCase)
        {
            // A speedway with a road-course twist: banked turns at either end, a rise through
            // turns 1-2 and a run back down the back straight into a bus-stop chicane (raised
            // kerbs, tarmac run-off: cut it and the lap is gone), gravel outside turn 1.
            ["capitol"] = new(
                "capitol",
                TrackWidth: 110,
                Knots: Scale(
                [
                    (0, 0), (380, 0), (760, 0), (1100, 60), (1300, 220), (1340, 420), (1220, 600),
                    (1000, 700), (760, 722), (620, 726), (540, 676), (440, 652), (350, 680), (260, 722),
                    (60, 705), (-160, 600), (-280, 420), (-260, 220), (-140, 60),
                ]),
                StepsPerSegment: 12,
                Atmosphere: new PoCabinetAtmosphereWire
                {
                    // Daytime: a dark dusk makes the race hard to read.
                    SkyHex = "#8fb8e0",
                    FogStart = 260,
                    FogEnd = 1100,
                    FogHex = "#a9c6e0",
                    AmbientIntensity = 0.7,
                    GroundHex = "#3f6a2e",
                    RoadHex = "#44464d",
                    AccentHex = "#c6a35a",
                })
            {
                //          0    1    2    3    4    5    6    7    8    9   10   11   12   13   14   15   16   17   18
                KnotZ = [0, 0, 6, 20, 38, 46, 44, 34, 22, 14, 10, 8, 8, 8, 6, 12, 18, 12, 4],
                KnotBank = [0, 0, 0, -0.1, -0.24, -0.28, -0.24, -0.1, 0, 0, 0, 0, 0, 0, -0.06, -0.2, -0.24, -0.2, -0.06],
                KnotWidth = [1, 1.08, 1.15, 1.12, 1, 1, 1, 1, 1, 1, 0.96, 0.96, 0.96, 1, 1, 1, 1, 1, 1],
                Runoff =
                [
                    new(2.5, 6.5, -1, PoCabinetRunoff.Gravel),
                    new(9, 13.5, 0, PoCabinetRunoff.Tarmac),
                    new(15, 17.5, -1, PoCabinetRunoff.Gravel),
                ],
                Sausages = [(9.2, 13.2)],
                Patches =
                [
                    new(0.3, 2, -1, 1, 1.03, 1.02, "resurfaced"),
                    new(7.3, 7.9, 0.1, 0.7, 1, 0.7, "puddle"),
                    new(15.4, 16.2, -1, 0.1, 0.94, 0.86, "bumpy"),
                    new(4.6, 5.2, -0.9, -0.3, 1, 0.72, "puddle"),
                ],
            },
            ["maralago"] = new(
                "maralago",
                TrackWidth: 120,
                Knots: Scale(
                [
                    (0, 0), (450, 0), (900, -40), (1300, -180), (1500, -400), (1450, -640),
                    (1200, -800), (800, -840), (400, -800), (50, -700), (-220, -540), (-300, -340),
                    (-220, -150), (-50, -20),
                ]),
                StepsPerSegment: 14,
                Atmosphere: new PoCabinetAtmosphereWire
                {
                    SkyHex = "#79a9d3",
                    FogStart = 260,
                    FogEnd = 1100,
                    FogHex = "#79a9d3",
                    AmbientIntensity = 0.7,
                    GroundHex = "#c2c98a",
                    RoadHex = "#6b675e",
                    AccentHex = "#f0e6c8",
                })
            {
                // Over the dunes: a rise off the line and a drop into the far hairpin, sand traps
                // outside the big corners, sand blown across the exits, the road pinched where it
                // threads between the greens.
                //          0    1    2    3    4    5    6    7    8    9   10   11   12   13
                KnotZ = [0, 8, 26, 42, 36, 18, 6, 0, 4, 16, 28, 24, 12, 4],
                KnotBank = [0, 0, 0, 0.06, 0.16, 0.18, 0.1, 0, 0, 0.04, 0.12, 0.16, 0.1, 0.02],
                KnotWidth = [1.08, 1.1, 1.05, 1, 1, 1, 1, 1, 0.95, 0.88, 0.88, 0.92, 1, 1.04],
                Runoff =
                [
                    new(3, 6.6, 1, PoCabinetRunoff.Gravel),
                    new(9.4, 12.4, 1, PoCabinetRunoff.Gravel),
                ],
                Patches =
                [
                    new(6.1, 6.8, 0.2, 1, 0.9, 0.84, "dusty"),
                    new(12.3, 12.9, 0.1, 1, 0.9, 0.84, "dusty"),
                    new(1.4, 1.9, -0.7, -0.1, 1, 0.7, "puddle"),
                    new(7.6, 8.2, -0.2, 0.5, 1, 0.72, "puddle"),
                ],
            },
            ["pressbriefing"] = new(
                "pressbriefing",
                TrackWidth: 105,
                Knots: Scale(
                [
                    (0, 0), (300, 50), (600, 120), (900, 240), (1100, 380), (1180, 540), (1100, 700),
                    (900, 820), (600, 860), (300, 820), (50, 720), (-130, 580), (-180, 400),
                    // The last knot must stay clear of the start: a knot near (50, 100) with the
                    // line at the origin folds the centerline into a 130° hook of radius 8 on a
                    // road 105 wide. A lone car cuts across it; a hundred cars jam in it for
                    // the whole race.
                    (-100, 240), (-90, 80),
                ]),
                StepsPerSegment: 12,
                Atmosphere: new PoCabinetAtmosphereWire
                {
                    // Daytime: a sunlit stone plaza.
                    SkyHex = "#9cc0e4",
                    FogStart = 240,
                    FogEnd = 1000,
                    FogHex = "#b4cbe0",
                    AmbientIntensity = 0.7,
                    GroundHex = "#8a7f78",
                    RoadHex = "#3f3f47",
                    AccentHex = "#c1253b",
                })
            {
                // A plaza: tarmac run-off everywhere, so the edge costs nothing but the lap (track
                // limits). A crest down the long straight, and the twisty last sector split by the
                // media scrum: the inside lane is the joker, shorter but on dusty paving.
                //          0    1    2    3    4    5    6    7    8    9   10   11   12   13   14
                KnotZ = [0, 10, 24, 30, 22, 10, 4, 0, -4, -8, -10, -8, -6, -4, -2],
                KnotWidth = [1, 1, 1, 1, 1, 1, 1, 1.05, 1.15, 1.35, 1.7, 1.7, 1.55, 1.2, 1.05],
                DefaultRunoff = PoCabinetRunoff.Tarmac,
                Islands = [new(9.9, 12.2, -12, 12, 1)],
                Patches =
                [
                    new(9.9, 12.2, 0.15, 1, 0.88, 0.78, "dirt"),
                    new(2.3, 2.8, 0.1, 0.8, 1, 0.7, "puddle"),
                    new(5.4, 5.9, -0.8, -0.1, 1, 0.72, "puddle"),
                    new(0, 0.25, -1, 1, 0.98, 0.84, "paint"),
                ],
            },
            // A road course in autumn hills: up the long start straight to a blind crest, down
            // through a kink into a banked hairpin (bumpy on the brakes, gravel outside), back
            // through the esses and a chicane with raised kerbs, and round the sweeper, split by
            // a divider: the inside lane is the joker, shorter and on dirt.
            ["senate"] = new(
                "senate",
                TrackWidth: 100,
                Knots:
                [
                    (0, 0), (350, 0), (700, 0), (1050, 20), (1300, 70), (1460, 140), (1550, 250),
                    (1530, 370), (1430, 420), (1300, 390), (1120, 420), (950, 480), (800, 500),
                    (650, 560), (500, 540), (400, 545), (330, 600), (240, 600), (170, 545), (0, 520),
                    (-180, 450), (-280, 300), (-260, 140), (-150, 30),
                ],
                StepsPerSegment: 12,
                Atmosphere: new PoCabinetAtmosphereWire
                {
                    SkyHex = "#a9c4de",
                    FogStart = 260,
                    FogEnd = 1150,
                    FogHex = "#c3d0da",
                    AmbientIntensity = 0.7,
                    GroundHex = "#5d6b33",
                    RoadHex = "#45474d",
                    AccentHex = "#b3541e",
                })
            {
                //          0   1   2   3   4   5   6   7   8   9  10  11  12  13  14  15  16  17  18  19  20  21  22  23
                KnotZ = [0, 18, 44, 66, 72, 64, 52, 42, 36, 32, 28, 28, 32, 36, 40, 40, 38, 36, 34, 26, 16, 8, 2, 0],
                KnotBank = [0, 0, 0, 0, -0.04, -0.14, -0.28, -0.32, -0.26, -0.08, 0, 0, 0, 0, 0, 0, 0, 0, 0, -0.06, -0.12, -0.14, -0.1, -0.03],
                KnotWidth = [1, 1, 1, 1, 1, 1.1, 1.2, 1.2, 1.15, 1.05, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.25, 1.7, 1.7, 1.45, 1.1],
                Runoff =
                [
                    new(3.5, 5, -1, PoCabinetRunoff.Gravel),
                    new(5, 9.5, -1, PoCabinetRunoff.Gravel),
                    new(14.5, 18.5, 0, PoCabinetRunoff.Tarmac),
                ],
                Sausages = [(14.6, 18.4)],
                Patches =
                [
                    new(0.4, 2, -1, 1, 1.03, 1.02, "resurfaced"),
                    new(4.6, 5.4, -1, 1, 0.95, 0.88, "bumpy"),
                    new(13.2, 13.9, -0.2, 1, 0.92, 0.86, "dusty"),
                    new(19.9, 21.6, 0.15, 1, 0.88, 0.78, "dirt"),
                    new(2.4, 2.9, 0.2, 0.9, 1, 0.7, "puddle"),
                    new(10.3, 10.8, -0.8, -0.1, 1, 0.72, "puddle"),
                ],
                Islands = [new(19.9, 21.6, -12, 12, 1)],
                Theme = "senate",
            },
            // A toy-car circuit on stilts ~2 ft over the floor of a scanned bedroom
            // (wwwroot/models/bedroom.glb): up the wall past the drum kit, under the closet's wall
            // return, a banked right-hander past the floor cushion, a hill down the side clear of
            // the standing desk, a banked sweep over the office chair's seat and back across the
            // front of the drum pad. The road is grey plastic, twice the other tracks' width (a car
            // is ~4 cm, the road ~30 cm), so no corner is tighter than its half width + 40 or the
            // inside edge folds over.
            //
            // GENERATED, do not hand-edit: scripts/blender/pocabinet-bedroom.py lays the route
            // in the scan's room units, checks it clears the furniture, and prints these at
            // 150 sim units per room unit (a car is ~4 cm long); scene.js ROOM draws the model
            // at 15x to match. KnotZ is the road's height: 393 (~0.61 m) of lift plus the
            // route's own profile, whose hump follows the cushion below.
            ["bedroom"] = new(
                "bedroom",
                TrackWidth: 200,
                Knots:
                [
                    (-585, -15), (-622.5, -142.5), (-585, -252), (-468, -325.5), (-289.5, -348),
                    (-108, -472.5), (22.5, -487.5), (135, -427.5), (195, -285), (198, -147),
                    (225, 90), (225, 300), (180, 480), (60, 577.5), (-108, 562.5),
                    (-210, 465), (-243, 288), (-318, 162), (-495, 75),
                ],
                StepsPerSegment: 10,
                Atmosphere: new PoCabinetAtmosphereWire
                {
                    // Indoors: the room is ~230 scene units across, so the fog only softens
                    // what is past the walls.
                    SkyHex = "#8d877e",
                    FogStart = 500,
                    FogEnd = 1800,
                    FogHex = "#8d877e",
                    AmbientIntensity = 0.75,
                    GroundHex = "#7b7166",
                    RoadHex = "#56585e",
                    AccentHex = "#2f86d6",
                })
            {
                //         0    1    2    3    4    5    6    7    8    9   10   11   12   13   14   15   16   17   18
                KnotZ = [396, 396, 396, 396, 396, 401, 413, 423, 433, 443, 458, 473, 463, 433, 408, 396, 396, 396, 396],
                KnotBank = [-0.06, 0, -0.06, -0.08, 0, 0, -0.06, -0.14, -0.08, 0, 0, 0, -0.08, -0.12, -0.06, 0, 0, 0, -0.06],
                Theme = "bedroom",
            },
            // A toy-car circuit on the floor of a scanned outdoor basketball court
            // (wwwroot/models/court.glb, the splat wwwroot/models/court.ksplat), down low so the
            // court, the hoops and the trees round it fill the view: the start straight along the
            // near sideline, a sweep up past key B and a hairpin round its top, back in and most of
            // the way round the centre circle, out along the far sideline and a hairpin round key A.
            //
            // GENERATED, do not hand-edit: scripts/blender/pocabinet-court.py levels the scan into
            // the court frame (metres, floor at 0, x from board A to board B), lays the lap, checks
            // it against the scan and prints these at 100 sim units per metre; models.js COURT
            // draws the model at 10x to match. KnotZ is the road's 13 cm over the court (clear of
            // the scan floor's lumps); KnotBank is the little bank that height allows.
            ["court"] = new(
                "court",
                TrackWidth: 84,
                Knots:
                [
                    (0, 530), (200, 530), (400, 520), (580, 480), (700, 370), (750, 220),
                    (820, 90), (960, 40), (1090, -40), (1140, -190), (1090, -340), (960, -440),
                    (800, -480), (640, -460), (500, -390), (390, -290), (270.5, -72.5), (263.1, 95.8),
                    (160.6, 229.4), (0, 280), (-160.6, 229.4), (-263.1, 95.8), (-270.5, -72.5), (-180, -214.5),
                    (-90, -310), (-80, -420), (-170, -500), (-320, -530), (-480, -520), (-650, -500),
                    (-800, -430), (-940, -360), (-1070, -260), (-1130, -120), (-1110, 40), (-1010, 160),
                    (-860, 210), (-740, 290), (-660, 420), (-550, 510), (-400, 530), (-200, 530),
                ],
                StepsPerSegment: 8,
                Atmosphere: new PoCabinetAtmosphereWire
                {
                    // Outdoors on a sunny afternoon: the scan is cropped ~25 m round the court, so
                    // the fog takes over past its trees.
                    SkyHex = "#9cc4e6",
                    FogStart = 420,
                    FogEnd = 1500,
                    FogHex = "#b9d1e4",
                    AmbientIntensity = 0.72,
                    GroundHex = "#5d7a3a",
                    RoadHex = "#56585e",
                    AccentHex = "#e8712a",
                })
            {
                KnotZ =
                [
                    13, 13, 13, 13, 13, 13,
                    13, 13, 13, 13, 13, 13,
                    13, 13, 13, 13, 13, 13,
                    13, 13, 13, 13, 13, 13,
                    13, 13, 13, 13, 13, 13,
                    13, 13, 13, 13, 13, 13,
                    13, 13, 13, 13, 13, 13,
                ],
                KnotBank =
                [
                    0.006, 0.031, 0.103, 0.103, 0.103, -0.051, -0.103, 0.062, 0.103, 0.103, 0.103, 0.103,
                    0.103, 0.103, 0.103, 0.103, 0.077, -0.103, -0.103, -0.103, -0.103, -0.103, -0.103, -0.057,
                    0.103, 0.103, 0.103, 0.103, 0.095, 0.097, 0.077, 0.103, 0.103, 0.103, 0.103, 0.103,
                    -0.079, -0.103, 0.102, 0.103, 0.094, 0.017,
                ],
                Theme = "court",
            },
            ["playground"] = new(
                "playground",
                TrackWidth: 74,
                // The marble run of wwwroot/models/playground.glb: point-to-point from the top
                // of the run, down its three banked turns round the play structure, off the end
                // of the gutter at the drop well, down the slide and into the finish tray. One
                // run, no laps. The scene draws the gutter as an open chute, floor without walls.
                //
                // GENERATED, do not hand-edit: the knots are the model's marble path (the same
                // reference race pomarblerace/courses/playground-run.path.js was baked from), recentred
                // between the gutter's rims and resampled every ~0.5 m, in sim units at 500 per
                // model metre; scene.js draws the model at 50x to match. That scale is
                // the one at which the gutter's 26 cm floor is as wide as this track's physics
                // corridor (TrackWidth + run-off, flank to flank), so the chute is the gutter's
                // floor and no wider. It also makes one run ~27,000 units, about three
                // and a half minutes. Knot 0 is the start line, half a metre down the run, so the
                // grid stands on the chute. From RoadFromKnot the gutter is over: the marbles
                // free-fall through the drop well there, so the knots are a constant-grade ramp
                // round onto the slide, then the slide, and the scene builds a road for them. The
                // knots after the finish are the run-out through the tray, then the return link
                // back to the top. KnotZ is the floor height (plus 3 cm over the lumpy slide);
                // KnotBank is the gutter floor's cross slope. The course crosses over itself six
                // times; the physics is 2D, so two cars on different levels of a crossing can
                // still touch.
                Knots:
                [
                    (-2689.1, 103.2), (-2797.2, 329.7), (-2862.2, 570.3), (-2812.2, 812.7), (-2650.5, 1000.1), (-2417.9, 1084.6),
                    (-2173.5, 1044.5), (-1976.4, 894.3), (-1827.8, 692.5), (-1626.2, 548.3), (-1380.7, 534.2), (-1132.8, 523.3),
                    (-923.6, 392.1), (-781.7, 186.1), (-669.8, -38.5), (-565.7, -266.9), (-457.1, -493.2), (-343.9, -716.8),
                    (-162.2, -885.3), (78.6, -930.6), (314, -848.7), (537.4, -734.5), (766.2, -631.5), (991.3, -520.3),
                    (1217.8, -411.9), (1443.9, -302.8), (1670.5, -194.8), (1896.8, -86), (2122.9, 23.1), (2348.8, 132.7),
                    (2574.6, 242.5), (2799.4, 354.1), (3020.2, 473.4), (3212.5, 632.7), (3350.7, 841.2), (3439.5, 1075.2),
                    (3468.7, 1323.7), (3434.1, 1571.5), (3337.4, 1802.2), (3185, 2000.5), (2986.9, 2153.3), (2756.4, 2250.4),
                    (2508.7, 2286.3), (2258.4, 2278.3), (2022.1, 2197.3), (1795.4, 2089.5), (1570, 1978.9), (1344.5, 1868.7),
                    (1118.3, 1759.8), (891.8, 1651.3), (665.8, 1542.1), (439.8, 1432.7), (213.6, 1323.9), (-12.6, 1215),
                    (-238.9, 1106.2), (-465.3, 997.6), (-691.3, 888.2), (-917.9, 780.2), (-1144, 671.1), (-1370.1, 561.9),
                    (-1596.1, 452.8), (-1822.3, 343.8), (-2048.7, 235.2), (-2273, 122.6), (-2474.7, -24.6), (-2626, -224),
                    (-2736.9, -448.5), (-2788.5, -693.2), (-2775.1, -943), (-2698.5, -1181.1), (-2562.9, -1391.3), (-2378, -1559.8),
                    (-2156, -1675), (-1911.7, -1729), (-1661.1, -1725.8), (-1416.3, -1674.8), (-1188.1, -1570.8), (-960.7, -1464.4),
                    (-735.4, -1353.6), (-517.4, -1230.4), (-374.4, -1030.1), (-352.1, -783.3), (-434.8, -547.5), (-542.9, -321),
                    (-651.8, -94.7), (-762.9, 130.3), (-870, 357.4), (-956.4, 592.4), (-967.5, 841.1), (-882.5, 1075.5),
                    (-732.4, 1274.9), (-522.5, 1410.7), (-299, 1524.9), (-73.6, 1635.4), (156.2, 1736), (402.7, 1766.2),
                    (644.4, 1703.1), (857.8, 1572.3), (1018.5, 1382.4), (1129.8, 1157.5), (1244.3, 934.5), (1451.1, 821.1),
                    (1686.5, 899.2), (1898.4, 1033.5), (2103.5, 1178.4), (2318, 1307.4), (2532.8, 1426.2), (2756.1, 1519.5),
                    (2964.2, 1605), (3172.3, 1690.5), (3412.8, 1789.3), (3773.5, 1937.5), (4282.2, 2146.6), (4976, 2431.6),
                    (5650, 2300), (6150, 1500), (6200, 0), (5750, -1750), (4250, -3250), (2000, -3900),
                    (-250, -3800), (-1300, -3100), (-1710.1, -1922.7), (-2058.3, -1202.4), (-2275.9, -752.3), (-2428.2, -437.1),
                    (-2537, -212),
                ],
                StepsPerSegment: 4,
                Atmosphere: new PoCabinetAtmosphereWire
                {
                    // The model is 650 scene units across at this scale: fog further out than
                    // on the circuits, or the far side of the run is lost in it.
                    SkyHex = "#94c6ec",
                    FogStart = 700,
                    FogEnd = 3000,
                    FogHex = "#b3d3ec",
                    AmbientIntensity = 0.72,
                    GroundHex = "#4d7a34",
                    RoadHex = "#4a4c53",
                    AccentHex = "#f2a922",
                })
            {
                Laps = 1,
                FinishKnot = 107,
                HiddenFromKnot = 110,
                // 122, not 126: the last four knots of the return link are a straight, level
                // approach to the line, and the 100-car grid stands 1,700 units
                // back along it. Drawn, it is the chute's launch ramp.
                HiddenToKnot = 122,
                RoadFromKnot = 99,
                KnotZ =
                [
                    2302.8, 2255.1, 2205.4, 2154.7, 2104.8, 2054.8, 2005.8, 1956.6, 1913.6, 1881.8, 1818.1, 1779.9,
                    1747.8, 1722.1, 1710, 1704.2, 1696.2, 1691.1, 1687.6, 1681.2, 1667.2, 1663.6, 1659.2, 1653.9,
                    1648, 1641.1, 1635.4, 1629, 1622.6, 1616.1, 1608.9, 1599.2, 1590.9, 1581.1, 1563.3, 1551.8,
                    1546.5, 1541.6, 1536.7, 1531.8, 1526.9, 1522, 1516.9, 1514, 1506.9, 1499.8, 1495.3, 1490.4,
                    1485.3, 1480.2, 1475.1, 1470, 1464.9, 1459.9, 1454, 1447.6, 1441.2, 1434.7, 1428.3, 1421.9,
                    1415.5, 1408.7, 1401.5, 1393.8, 1379.3, 1356.8, 1347.5, 1341.4, 1336.4, 1331.4, 1326.4, 1321.4,
                    1316.4, 1311.3, 1306.8, 1301.4, 1294.2, 1288.7, 1283.5, 1281.4, 1275.9, 1271.1, 1264.1, 1257.7,
                    1252.7, 1247.4, 1242.1, 1223.6, 1211.8, 1206.2, 1202.7, 1197.2, 1190.6, 1184.9, 1182.9, 1161.3,
                    1155.1, 1150.6, 1147.5, 1139.8, 1129.1, 949, 766.9, 584.8, 402.7, 236.2, 157.3, 117.6,
                    70.7, 36.9, 17, 17, 17, 17, 275.7, 534.4, 793.1, 1051.8, 1310.6, 1569.3,
                    1828, 2086.7, 2345.4, 2345.4, 2345.4, 2345.4, 2345.4,
                ],
                KnotBank =
                [
                    0.033, 0.114, 0.213, 0.33, 0.417, 0.488, 0.473, 0.239, -0.071, -0.196, -0.112, 0.169, 0.469, 0.495,
                    0.256, 0.059, -0.072, -0.263, -0.383, -0.534, -0.566, -0.25, -0.05, 0, 0, 0, 0, 0,
                    0, 0, -0.008, -0.09, -0.267, -0.374, -0.214, -0.041, -0.04, -0.044, -0.048, -0.052, -0.056, -0.06,
                    -0.06, -0.168, -0.284, -0.188, -0.043, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                    0, 0, 0, 0, 0, -0.013, -0.117, -0.33, -0.329, -0.187, -0.15, -0.154, -0.157, -0.16,
                    -0.164, -0.167, -0.171, -0.16, -0.205, -0.285, -0.189, -0.094, -0.283, -0.474, -0.361, -0.391, -0.297, -0.063,
                    0, 0.073, 0.235, 0.24, 0.067, 0.076, 0.298, 0.258, 0.101, 0.247, 0.28, 0.04, -0.032, 0.171,
                    0.284, 0.08, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                    0,
                ],
            },
        };

    /// <summary>Definition for <paramref name="trackId"/> (a daily id builds that day's circuit),
    /// or the default track when unknown.</summary>
    public static PoCabinetTrackDefinition Get(string? trackId) =>
        PoCabinetDailyTrack.TryParse(trackId, out var day) ? PoCabinetDailyTrack.Get(day)
        : !string.IsNullOrWhiteSpace(trackId) && Definitions.TryGetValue(trackId.Trim(), out var def)
            ? def
            : Definitions[PoCabinetCatalog.DefaultTrackId];

    /// <summary>
    /// Closed Catmull-Rom resample of the knots, as a flat <c>[x0, y0, x1, y1, …]</c> array.
    /// Deterministic: both ends of the wire call this and get bit-identical doubles.
    /// </summary>
    public static double[] BuildCenterlineXY(PoCabinetTrackDefinition def)
    {
        var knots = def.Knots;
        int n = knots.Count;
        int steps = def.StepsPerSegment;
        var xy = new double[n * steps * 2];
        int k = 0;
        for (int i = 0; i < n; i++)
        {
            var p0 = knots[(i - 1 + n) % n];
            var p1 = knots[i];
            var p2 = knots[(i + 1) % n];
            var p3 = knots[(i + 2) % n];
            for (int s = 0; s < steps; s++)
            {
                double t = s / (double)steps;
                xy[k++] = CatmullRom(p0.X, p1.X, p2.X, p3.X, t);
                xy[k++] = CatmullRom(p0.Y, p1.Y, p2.Y, p3.Y, t);
            }
        }
        return xy;
    }

    /// <summary>
    /// A render-only per-knot value (<c>KnotZ</c>, <c>KnotBank</c>) resampled per centerline
    /// sample with the same spline, rounded to <paramref name="digits"/> (it is drawn, not
    /// simulated). Empty when the track has none.
    /// </summary>
    public static double[] BuildCenterlineValues(IReadOnlyList<double>? knots, int steps, int digits)
    {
        if (knots is null) return [];
        int n = knots.Count;
        var values = new double[n * steps];
        for (int i = 0; i < n; i++)
        {
            for (int s = 0; s < steps; s++)
            {
                values[i * steps + s] = Math.Round(
                    CatmullRom(knots[(i - 1 + n) % n], knots[i], knots[(i + 1) % n], knots[(i + 2) % n], s / (double)steps), digits);
            }
        }
        return values;
    }

    private static double CatmullRom(double p0, double p1, double p2, double p3, double t)
    {
        double t2 = t * t, t3 = t2 * t;
        return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
    }

    /// <summary>
    /// The static world payload: what the scene, minimap and in-browser sim mount against,
    /// and what the race hub hands a joining client. Built on demand — it is a few KB and
    /// the client caches nothing it could get wrong.
    /// </summary>
    public static PoCabinetStaticWorld BuildStaticWorld(string? trackId) => BuildStaticWorld(Get(trackId));

    public static PoCabinetStaticWorld BuildStaticWorld(PoCabinetTrackDefinition def)
    {
        var xy = BuildCenterlineXY(def);
        double minX = double.MaxValue, minY = double.MaxValue, maxX = double.MinValue, maxY = double.MinValue;
        for (int i = 0; i < xy.Length; i += 2)
        {
            minX = Math.Min(minX, xy[i]);
            maxX = Math.Max(maxX, xy[i]);
            minY = Math.Min(minY, xy[i + 1]);
            maxY = Math.Max(maxY, xy[i + 1]);
        }
        var world = new PoCabinetStaticWorld
        {
            TrackId = def.Id,
            TrackName = PoCabinetCatalog.GetTrack(def.Id).Name,
            Atmosphere = def.Atmosphere,
            CenterXY = xy,
            TrackWidth = def.TrackWidth,
            MinX = minX,
            MinY = minY,
            MaxX = maxX,
            MaxY = maxY,
            TotalLaps = def.Laps,
            CenterZ = BuildCenterlineValues(def.KnotZ, def.StepsPerSegment, 1),
            CenterBank = BuildCenterlineValues(def.KnotBank, def.StepsPerSegment, 3),
            RoadFrom = def.RoadFromKnot * def.StepsPerSegment,
            FinishIndex = def.FinishKnot * def.StepsPerSegment,
            HiddenFrom = def.HiddenFromKnot * def.StepsPerSegment,
            HiddenTo = def.HiddenToKnot * def.StepsPerSegment,
        };
        PoCabinetTrackFeatures.Fill(world, def, xy);
        return world;
    }

    private static (double X, double Y)[] Scale((double X, double Y)[] knots) =>
        knots.Select(k => (k.X * KnotScale, k.Y * KnotScale)).ToArray();
}
