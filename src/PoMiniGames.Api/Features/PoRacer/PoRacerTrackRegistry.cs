using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoRacer;

public static class PoRacerTrackRegistry
{
    private static readonly Dictionary<string, PoRacerTrackData> _tracks = new(StringComparer.OrdinalIgnoreCase);

    // One row per track: road width, spline steps per knot, where on the lap the two boost pads
    // sit, and the surface zones. The knots, names and medal laps are in the shared PoRacerCatalog.
    static PoRacerTrackRegistry()
    {
        // Consolidated circuit: stadium tarmac + desert sand run-off at the east hairpin,
        // with boost pads on the front straight and exiting the hairpin into the S-chicane.
        Register("circuit", trackWidth: 230, stepsPerKnot: 12, pads: (0.08, 0.56),
            Zone("Main Tarmac", SurfaceKind.Asphalt, 600, 420, 2200, grip: 1.0),
            Zone("Dune Run-off East", SurfaceKind.Sand, 1860, 620, 240, grip: 0.65));
    }

    private static void Register(string id, double trackWidth, int stepsPerKnot, (double First, double Second) pads,
        params PoRacerSurfaceZoneDefinition[] zones)
    {
        var centerline = ResampleClosedSpline(Knots(id), stepsPerKnot);
        _tracks[id] = new PoRacerTrackData
        {
            Id = id,
            TrackWidth = trackWidth,
            Centerline = centerline,
            Walls = GenerateWalls(centerline, trackWidth),
            BoostPads = [PadAt(centerline, pads.First), PadAt(centerline, pads.Second)],
            SurfaceZones = zones,
            // The renderer's theme is named after the track.
            EnvironmentTheme = id,
        };
    }

    private static PoRacerSurfaceZoneDefinition Zone(string name, SurfaceKind kind, double x, double y, double radius, double grip) =>
        new() { Name = name, SurfaceType = kind, Center = new Vec2(x, y), Radius = radius, GripMultiplier = grip };

    public static PoRacerTrackData GetTrack(string? trackId) =>
        !string.IsNullOrWhiteSpace(trackId) && _tracks.TryGetValue(trackId, out var track)
            ? track : _tracks[PoRacerCatalog.DefaultTrackId];

    /// <summary>
    /// A boost pad on the centerline at a fraction of the lap, pointing the way the track runs
    /// there. Every track needs pads, because the start card tells drivers to aim for them.
    /// </summary>
    private static PoRacerBoostPadDefinition PadAt(IReadOnlyList<Vec2> line, double lapFraction)
    {
        int i = (int)(lapFraction * line.Count) % line.Count;
        var a = line[i];
        var b = line[(i + 1) % line.Count];
        return new() { Position = a, Radius = 46, DirectionAngle = Math.Atan2(b.Y - a.Y, b.X - a.X) };
    }

    // Knots live in the shared catalog so the client draws its track cards from the same points.
    private static List<Vec2> Knots(string id) => PoRacerCatalog.GetTrack(id).Knots.Select(p => new Vec2(p.X, p.Y)).ToList();

    private static List<Vec2> ResampleClosedSpline(IReadOnlyList<Vec2> knots, int stepsPerSegment)
    {
        var result = new List<Vec2>(knots.Count * stepsPerSegment);
        int n = knots.Count;
        for (int i = 0; i < n; i++)
        {
            var p0 = knots[(i - 1 + n) % n];
            var p1 = knots[i];
            var p2 = knots[(i + 1) % n];
            var p3 = knots[(i + 2) % n];
            for (int s = 0; s < stepsPerSegment; s++)
            {
                double t = s / (double)stepsPerSegment;
                double t2 = t * t, t3 = t2 * t;
                double x = 0.5 * ((2 * p1.X) + (-p0.X + p2.X) * t + (2 * p0.X - 5 * p1.X + 4 * p2.X - p3.X) * t2 + (-p0.X + 3 * p1.X - 3 * p2.X + p3.X) * t3);
                double y = 0.5 * ((2 * p1.Y) + (-p0.Y + p2.Y) * t + (2 * p0.Y - 5 * p1.Y + 4 * p2.Y - p3.Y) * t2 + (-p0.Y + 3 * p1.Y - 3 * p2.Y + p3.Y) * t3);
                result.Add(new Vec2(x, y));
            }
        }
        return result;
    }

    private static List<(Vec2 a, Vec2 b)> GenerateWalls(IReadOnlyList<Vec2> centerline, double trackWidth)
    {
        var walls = new List<(Vec2 a, Vec2 b)>(centerline.Count * 2);
        int n = centerline.Count;
        double hw = trackWidth * 0.5;

        for (int i = 0; i < n; i++)
        {
            var a = centerline[i];
            var b = centerline[(i + 1) % n];
            var norm = ComputeNormal(a, b);

            var leftA = new Vec2(a.X - norm.X * hw, a.Y - norm.Y * hw);
            var leftB = new Vec2(b.X - norm.X * hw, b.Y - norm.Y * hw);
            var rightA = new Vec2(a.X + norm.X * hw, a.Y + norm.Y * hw);
            var rightB = new Vec2(b.X + norm.X * hw, b.Y + norm.Y * hw);

            walls.Add((leftA, leftB));
            walls.Add((rightA, rightB));
        }
        return walls;
    }

    public static Vec2 ComputeNormal(Vec2 a, Vec2 b)
    {
        double dx = b.X - a.X, dy = b.Y - a.Y;
        double len = Math.Sqrt(dx * dx + dy * dy);
        if (len < 1e-9) return new Vec2(0, 1);
        return new Vec2(-dy / len, dx / len);
    }
}
