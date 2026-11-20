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

    /// <summary>The lap's scenery zones, in order: each runs from its knot to the next one's
    /// (the last wraps to the first). Render-only.</summary>
    public IReadOnlyList<PoCabinetZoneDef>? Zones { get; init; }

    /// <summary>A scan the lap drives through, and where it stands. Render-only.</summary>
    public PoCabinetScanWire? Scan { get; init; }
}

/// <summary>A scenery zone starting at knot <paramref name="FromKnot"/>, dressed as
/// <paramref name="Theme"/> (capitol, senate, court, maralago).</summary>
public sealed record PoCabinetZoneDef(double FromKnot, string Theme);

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
    /// <summary>The one circuit's id (also <see cref="PoCabinetCatalog.DefaultTrackId"/>).</summary>
    public const string TrackId = "grandprix";

    /// <summary>
    /// Where the scanned basketball court stands (wwwroot/models/court.glb, court.ksplat): its
    /// centre in sim units, drawn at 50 sim units to the metre (a car is a ~78 cm toy; the hoops
    /// stand four car lengths up), its floor 10 sim units up, cropped to the court and 3.5 m
    /// round it. The lap's court knots below are laid against the scan in this frame: the entry
    /// passes the corner of the court clear of the east hoop's pole, the exit 3 m to the side
    /// of the west one.
    /// </summary>
    private static readonly PoCabinetScanWire Court = new()
    {
        X = -1300,
        Y = 1850,
        Scale = 50,
        FloorZ = 10,
        HalfLength = 18.5,
        HalfWidth = 10.5,
    };

    /// <summary>
    /// Cabinet Grand Prix, the one circuit, clockwise: the stadium straight and its banked
    /// first turn (gravel outside); the climb over Senate Hill to a blind crest, down through a
    /// kink into the banked hairpin (bumpy on the brakes), back through the esses and a chicane
    /// with raised kerbs; across a giant scanned basketball court, round its east hoop and out
    /// past the west one (tarmac run-off: the court costs nothing but the lap); the sweeper
    /// split by a divider, the inside lane the joker, shorter and on dirt; and the beach road
    /// over the dunes, sand traps outside every bend, back to the line.
    /// </summary>
    private static readonly PoCabinetTrackDefinition Definition = new(
        TrackId,
        TrackWidth: 105,
        Knots:
        [
            // 0-2: the stadium straight.
            (0, 0), (330, 0), (640, 0),
            // 3-6: turn 1, banked.
            (930, 50), (1170, 190), (1310, 430), (1340, 700),
            // 7-12: the climb, the crest on the kink, the hairpin.
            (1320, 990), (1270, 1240), (1200, 1400), (1090, 1490), (970, 1470), (920, 1370),
            // 13-18: the esses, and left onto the infield road.
            (950, 1240), (920, 1060), (860, 890), (840, 740), (760, 570), (650, 490),
            // 19-24: the chicane.
            (500, 470), (400, 475), (330, 530), (240, 530), (170, 475), (0, 450),
            // 25-29: down to the court.
            (-200, 480), (-360, 620), (-440, 840), (-480, 1080), (-510, 1290),
            // 30-36: across the court.
            (-570, 1500), (-760, 1720), (-1050, 1880), (-1400, 1960), (-1800, 1990), (-2100, 2000), (-2320, 2000),
            // 37-40: the joker sweeper.
            (-2530, 1962), (-2721, 1881), (-2800, 1690), (-2721, 1499),
            // 41-49: the beach road.
            (-2600, 1300), (-2440, 1130), (-2240, 1000), (-2050, 900), (-1920, 740), (-1860, 540),
            (-1760, 340), (-1590, 170), (-1360, 60),
            // 50-52: onto the straight; the grid stands back along it.
            (-1100, 10), (-800, 0), (-400, 0),
        ],
        StepsPerSegment: 12,
        Atmosphere: new PoCabinetAtmosphereWire
        {
            // Daytime, and fog far enough out that the court's hoops show from the hill.
            SkyHex = "#8fb8e0",
            FogStart = 320,
            FogEnd = 1500,
            FogHex = "#a9c6e0",
            AmbientIntensity = 0.7,
            GroundHex = "#4f7a33",
            RoadHex = "#44464d",
            AccentHex = "#d4af37",
        })
    {
        Laps = 2,
        // Level from knot 27 and unbanked from knot 28, both to knot 37: the spline through the court (29 to 36)
        // reads a knot either side, and the road has to sit flat on the scan.
        KnotZ =
        [
            0, 0, 4,
            14, 28, 40, 48,
            62, 72, 64, 52, 42, 36,
            32, 28, 28, 32, 34, 36,
            40, 40, 38, 36, 34, 30,
            26, 22, 20, 20, 20,
            20, 20, 20, 20, 20, 20, 20,
            20, 26, 32, 38,
            42, 44, 40, 34, 28, 22, 16, 10, 5,
            2, 0, 0,
        ],
        KnotBank =
        [
            0, 0, 0,
            -0.1, -0.22, -0.24, -0.1,
            0, -0.04, -0.14, -0.28, -0.32, -0.26,
            -0.08, 0, 0, 0, 0.06, 0.04,
            0, 0, 0, 0, 0, 0,
            0, 0.04, 0.04, 0, 0,
            0, 0, 0, 0, 0, 0, 0,
            0, -0.12, -0.14, -0.1,
            -0.03, -0.1, -0.04, 0.06, 0.12, 0.06, -0.08, -0.12, -0.06,
            0, 0, 0,
        ],
        KnotWidth =
        [
            1, 1.08, 1.12,
            1.1, 1, 1, 1,
            1, 1, 1.1, 1.2, 1.2, 1.15,
            1.05, 1, 1, 1, 1, 1,
            1, 1, 1, 1, 1, 1,
            1, 1, 1, 1, 1,
            1, 1, 1, 1, 1, 1.05, 1.15,
            1.45, 1.7, 1.7, 1.4,
            1.1, 1, 0.95, 0.9, 0.9, 0.9, 0.95, 1, 1.04,
            1.08, 1.08, 1.04,
        ],
        Runoff =
        [
            new(2.5, 6.5, -1, PoCabinetRunoff.Gravel),
            new(7.2, 12.5, -1, PoCabinetRunoff.Gravel),
            new(18.5, 24, 0, PoCabinetRunoff.Tarmac),
            new(27, 37, 0, PoCabinetRunoff.Tarmac),
            new(37, 41.5, -1, PoCabinetRunoff.Gravel),
            new(41.5, 43.6, -1, PoCabinetRunoff.Gravel),
            new(44, 46.4, 1, PoCabinetRunoff.Gravel),
            new(46.6, 50, -1, PoCabinetRunoff.Gravel),
        ],
        Sausages = [(19.2, 23.6)],
        Patches =
        [
            new(0.3, 2, -1, 1, 1.03, 1.02, "resurfaced"),
            new(4.6, 5.2, -0.9, -0.3, 1, 0.72, "puddle"),
            new(8.6, 9.5, -1, 1, 0.95, 0.88, "bumpy"),
            new(14.3, 14.8, -0.8, -0.1, 1, 0.72, "puddle"),
            new(17.4, 18.1, -0.2, 1, 0.92, 0.86, "dusty"),
            new(33, 33.5, -0.5, 0.5, 1, 0.74, "puddle"),
            new(37.4, 39.8, 0.15, 1, 0.88, 0.78, "dirt"),
            new(40.6, 41.3, -1, -0.1, 0.9, 0.84, "dusty"),
            new(46.2, 46.9, 0.1, 1, 0.9, 0.84, "dusty"),
            new(49.2, 49.7, -0.7, -0.1, 1, 0.7, "puddle"),
        ],
        Islands = [new(37.4, 39.8, -12, 12, 1)],
        Theme = TrackId,
        Zones =
        [
            new(0, "capitol"),
            new(6.5, "senate"),
            new(26, "court"),
            new(37, "maralago"),
            new(50, "capitol"),
        ],
        Scan = Court,
    };

    /// <summary>The circuit's definition. There is one track; <paramref name="trackId"/> is kept
    /// for callers that still carry an id, and any value gets the same circuit.</summary>
    public static PoCabinetTrackDefinition Get(string? trackId = null) => Definition;

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
            FinishIndex = def.FinishKnot * def.StepsPerSegment,
            HiddenFrom = def.HiddenFromKnot * def.StepsPerSegment,
            HiddenTo = def.HiddenToKnot * def.StepsPerSegment,
        };
        PoCabinetTrackFeatures.Fill(world, def, xy);
        return world;
    }
}
