using System.Collections.Concurrent;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>Closest point on the centerline to a car. Lateral is signed: + is the right-hand side
/// of the direction of travel, i.e. along the normal (-Ty, Tx).</summary>
public readonly record struct PoCabinetTrackProjection(int Index, double Along, double Lateral, double Tx, double Ty);

/// <summary>A point at an arc-length distance along the centerline, with its unit tangent.</summary>
public readonly record struct PoCabinetTrackPoint(double X, double Y, double Tx, double Ty);

/// <summary>A road divider on samples [From, To) between two lateral offsets; ShortSide is the
/// joker lane; FromAlong/ToAlong are its ends along the loop and HalfWidth the road's there.</summary>
public sealed record PoCabinetTrackIsland(int From, int To, double LatFrom, double LatTo, int ShortSide,
    double FromAlong, double ToAlong, double HalfWidth);

/// <summary>
/// Runtime view of one track: the resampled centerline from <see cref="PoCabinetTrackGeometry"/>
/// plus the arc-length tables and curvature the physics and AI need. Built once per track id.
///
/// <para>
/// <b>Mirror contract:</b> <c>wwwroot/js/pocabinet/track.js</c> is a line-for-line port. The
/// browser runs the same projection for solo races and for multiplayer client-side
/// prediction, so any change to the search window, the curvature smoothing or the sampling
/// step here must land there too, or predicted cars drift from the server's.
/// </para>
/// </summary>
public sealed class PoCabinetTrack
{
    /// <summary>Distance step used when scanning ahead for the tightest corner.</summary>
    public const double CurvatureSampleStep = 8;
    /// <summary>Track evolution (<see cref="GripAt"/>): rubber goes down on the racing line over
    /// this much race time; on it the grip rises (more again in the wet, where the line dries
    /// first), and well off it the marbles take a little away. Mirrors track.js.</summary>
    public const double RubberSeconds = 90;
    private const double RubberBand = 24;
    private const double RubberDry = 0.05;
    private const double RubberWet = 0.1;
    private const double MarblesFrom = 50;
    private const double Marbles = 0.04;

    private static readonly ConcurrentDictionary<string, PoCabinetTrack> Cache = new(StringComparer.OrdinalIgnoreCase);

    private readonly double[] _x;
    private readonly double[] _y;
    private readonly double[] _cum;
    private readonly double[] _segLen;
    private readonly double[] _tx;
    private readonly double[] _ty;
    private readonly double[] _curv;
    /// <summary>Road height and cross slope per sample (null on a flat, unbanked track): the
    /// same values the browser gets as the world's CenterZ / CenterBank.</summary>
    private readonly double[]? _z;
    private readonly double[]? _bank;
    private readonly bool _pointToPoint;
    private readonly double _parkAt;
    /// <summary>Track features, the world's own arrays (<see cref="PoCabinetTrackFeatures"/>):
    /// half width, run-off either side, apex kerbs, the racing line, patches, dividers.</summary>
    private readonly double[] _hw;
    private readonly int[] _runoffLeft;
    private readonly int[] _runoffRight;
    private readonly int[] _kerbs;
    private readonly double[] _line;
    private readonly PoCabinetPatchWire[] _patches;
    private readonly PoCabinetTrackIsland[] _islands;
    private readonly int[] _islandOf;
    private readonly double[] _islandLo;
    private readonly double[] _islandHi;
    /// <summary>Samples over which a divider tapers to a point at either end. Mirrors track.js.</summary>
    private const double IslandTaper = 4;

    private PoCabinetTrack(PoCabinetTrackDefinition def)
    {
        Id = def.Id;
        HalfWidth = def.TrackWidth * 0.5;
        var world = PoCabinetTrackGeometry.BuildStaticWorld(def);
        var line = new PoCabinetCenterline(world.CenterXY);
        Count = line.Count;
        (_x, _y, _segLen, _cum, _tx, _ty) = (line.X, line.Y, line.SegLen, line.Cum, line.Tx, line.Ty);
        Length = line.Length;
        _z = world.CenterZ.Count == Count ? [.. world.CenterZ] : null;
        _bank = world.CenterBank.Count == Count ? [.. world.CenterBank] : null;

        // Point-to-point (the Playground run): the lap ends at the finish knot instead of back
        // at the line, and a finished car rolls on into the run-out and parks half way down
        // it instead of taking a cool-down lap, because past the run-out there is only the
        // return link. Mirrored in track.js.
        Laps = def.Laps;
        _pointToPoint = def.FinishKnot > 0;
        LapLength = _pointToPoint ? _cum[def.FinishKnot * def.StepsPerSegment] : Length;
        _parkAt = _pointToPoint
            ? (_cum[def.FinishKnot * def.StepsPerSegment] + _cum[def.HiddenFromKnot * def.StepsPerSegment]) / 2
            : 0;

        // How sharp each corner is, whichever way it turns: what the AI brakes for.
        _curv = line.Curvature(magnitudeOnly: true);

        _hw = world.HalfWidths.Count == Count ? [.. world.HalfWidths] : Enumerable.Repeat(HalfWidth, Count).ToArray();
        _runoffLeft = world.RunoffLeft.Count == Count ? [.. world.RunoffLeft] : new int[Count];
        _runoffRight = world.RunoffRight.Count == Count ? [.. world.RunoffRight] : new int[Count];
        _kerbs = world.Kerbs.Count == Count ? [.. world.Kerbs] : new int[Count];
        _line = world.RacingLine.Count == Count ? [.. world.RacingLine] : new double[Count];
        _patches = [.. world.Patches];
        _islands = world.Islands.Select(s => new PoCabinetTrackIsland(
            s.From, s.To, s.LatFrom, s.LatTo, s.ShortSide == 0 ? 1 : s.ShortSide,
            _cum[s.From], _cum[s.To], _hw[(s.From + ((s.To - s.From) >> 1)) % Count])).ToArray();
        // Which divider stands on each sample (-1: none) and how wide it is there: it tapers to a
        // point over its first and last IslandTaper samples, so a car meeting its nose glances off.
        _islandOf = Enumerable.Repeat(-1, Count).ToArray();
        _islandLo = new double[Count];
        _islandHi = new double[Count];
        for (int k = 0; k < _islands.Length; k++)
        {
            var s = _islands[k];
            int n = (s.To - s.From + Count) % Count;
            double mid = (s.LatFrom + s.LatTo) * 0.5, half = (s.LatTo - s.LatFrom) * 0.5;
            for (int j = 0; j < n; j++)
            {
                int i = (s.From + j) % Count;
                double t = Math.Min(1, Math.Min((j + 1) / IslandTaper, (n - j) / IslandTaper));
                _islandOf[i] = k;
                _islandLo[i] = mid - half * t;
                _islandHi[i] = mid + half * t;
            }
        }
    }

    /// <summary>Index into <see cref="Islands"/> of the divider on sample <paramref name="i"/>, or -1.</summary>
    public int IslandIndexAt(int i) => _islandOf[i];

    /// <summary>The divider's lateral extent at sample <paramref name="i"/> (tapered at its ends).</summary>
    public double IslandLo(int i) => _islandLo[i];

    public double IslandHi(int i) => _islandHi[i];

    /// <summary>How much rubber is down <paramref name="elapsed"/> seconds into a race, 0..1. Mirrors track.js <c>rubberAt</c>.</summary>
    public static double RubberAt(double elapsed) => Math.Min(1, Math.Max(0, elapsed / RubberSeconds));

    /// <summary>Road half width at sample <paramref name="i"/>. Mirrors track.js <c>hwAt</c>.</summary>
    public double HalfWidthAt(int i) => _hw[i];

    /// <summary>Smoothed unsigned curvature at sample <paramref name="i"/> (what the AI brakes for). Mirrors track.js <c>curv</c>.</summary>
    public double CurvatureAt(int i) => _curv[i];

    /// <summary>The racing line's lateral offset at sample <paramref name="i"/> (what the AI steers along). Mirrors track.js <c>line</c>.</summary>
    public double LineAt(int i) => _line[i];

    /// <summary>Run-off kind at sample <paramref name="i"/> on <paramref name="side"/> (+1 right): 0 grass, 1 gravel, 2 tarmac.</summary>
    public int RunoffAt(int i, int side) => side > 0 ? _runoffRight[i] : _runoffLeft[i];

    /// <summary>Apex kerb at sample <paramref name="i"/>: 0, ±1 flat, ±2 raised (sign = side).</summary>
    public int KerbAt(int i) => _kerbs[i];

    /// <summary>The road dividers, in the world's order.</summary>
    public IReadOnlyList<PoCabinetTrackIsland> Islands => _islands;

    /// <summary>
    /// What the road itself does to grip at sample <paramref name="i"/>, <paramref name="lateral"/>
    /// from the centerline: its patches, in order, then the rubber on the racing line (and the
    /// marbles off it). Mirrors track.js <c>gripAt</c>, operation for operation.
    /// </summary>
    public double GripAt(int i, double lateral, bool wet, double rubber)
    {
        double g = 1;
        foreach (var p in _patches)
        {
            if (i >= p.From && i < p.To && lateral >= p.LatFrom && lateral <= p.LatTo) g *= wet ? p.WetGrip : p.DryGrip;
        }
        if (rubber > 0 && Math.Abs(lateral) <= _hw[i])
        {
            double off = Math.Abs(lateral - _line[i]);
            if (off < RubberBand) g *= 1 + (wet ? RubberWet : RubberDry) * rubber;
            else if (off > MarblesFrom && !wet) g *= 1 - Marbles * rubber;
        }
        return g;
    }

    /// <summary>Rise per unit of road along segment <paramref name=i/> (+ = uphill in the
    /// direction of travel); 0 on a flat track. Mirrors track.js <c>grade</c>.</summary>
    public double Grade(int i)
    {
        if (_z is null) return 0;
        double len = _segLen[i];
        return len > 1e-9 ? (_z[(i + 1) % Count] - _z[i]) / len : 0;
    }

    /// <summary>Cross slope at sample <paramref name=i/> (+ = right side higher); 0 when unbanked. Mirrors track.js <c>bankOf</c>.</summary>
    public double Bank(int i) => _bank is null ? 0 : _bank[i];

    /// <summary>Unit tangent of segment <paramref name=i/>.</summary>
    public double TangentX(int i) => _tx[i];

    public double TangentY(int i) => _ty[i];

    public static PoCabinetTrack Get(string? trackId)
    {
        var def = PoCabinetTrackGeometry.Get(trackId);
        return Cache.GetOrAdd(def.Id, _ => new PoCabinetTrack(def));
    }

    public string Id { get; }
    public double HalfWidth { get; }
    public double Length { get; }
    public int Count { get; }

    /// <summary>Race distance of one lap: <see cref="Length"/> on a circuit, the distance from
    /// the line to the finish on a point-to-point track.</summary>
    public double LapLength { get; }

    /// <summary>Laps in a race here.</summary>
    public int Laps { get; }

    /// <summary>Share of its top speed a finished car at race distance <paramref name="distance"/>
    /// holds: 0.6 on a circuit; on a point-to-point track 0.6 into the run-out, then 0 (park).</summary>
    public double CoolDownAt(double distance) => Parked(distance) ? 0 : 0.6;

    /// <summary>
    /// True once a car has rolled to the parking point of a point-to-point track's run-out
    /// (never on a circuit). A parked car is out of the race for good: it no longer collides
    /// and the AI no longer sees it, or the first two dozen finishers of a 100-car field would
    /// fill the run-out and everyone behind would queue back over the finish line.
    /// </summary>
    public bool Parked(double distance) => _pointToPoint && distance >= _parkAt;

    /// <summary>
    /// Project a point onto the centerline. With a valid <paramref name="hint"/> (the segment
    /// found last tick) only a short window around it is searched; a miss that lands far off
    /// the road falls back to the full scan, so a car can never lock onto the wrong straight.
    /// </summary>
    public PoCabinetTrackProjection Project(double x, double y, int hint)
    {
        int best = -1;
        double bestD2 = double.MaxValue, bestT = 0;
        if (hint >= 0 && hint < Count)
        {
            for (int k = -6; k <= 10; k++)
            {
                int i = ((hint + k) % Count + Count) % Count;
                Consider(i, x, y, ref best, ref bestD2, ref bestT);
            }
            double limit = HalfWidth * 3;
            if (bestD2 > limit * limit) best = -1;
        }
        if (best < 0)
        {
            bestD2 = double.MaxValue;
            for (int i = 0; i < Count; i++) Consider(i, x, y, ref best, ref bestD2, ref bestT);
        }

        double px = _x[best] + _tx[best] * bestT * _segLen[best];
        double py = _y[best] + _ty[best] * bestT * _segLen[best];
        double lateral = (x - px) * -_ty[best] + (y - py) * _tx[best];
        return new PoCabinetTrackProjection(best, _cum[best] + bestT * _segLen[best], lateral, _tx[best], _ty[best]);
    }

    private void Consider(int i, double x, double y, ref int best, ref double bestD2, ref double bestT)
    {
        double len = _segLen[i];
        double t = len > 1e-9 ? ((x - _x[i]) * _tx[i] + (y - _y[i]) * _ty[i]) / len : 0;
        t = Math.Clamp(t, 0, 1);
        double px = _x[i] + _tx[i] * t * len;
        double py = _y[i] + _ty[i] * t * len;
        double d2 = (x - px) * (x - px) + (y - py) * (y - py);
        if (d2 < bestD2)
        {
            bestD2 = d2;
            best = i;
            bestT = t;
        }
    }

    /// <summary>Point at <paramref name="distance"/> along the loop (wraps both ways).</summary>
    public PoCabinetTrackPoint PointAt(double distance)
    {
        int i = IndexAt(distance);
        double d = Wrap(distance) - _cum[i];
        return new PoCabinetTrackPoint(_x[i] + _tx[i] * d, _y[i] + _ty[i] * d, _tx[i], _ty[i]);
    }

    /// <summary>Tightest smoothed curvature (radians per unit) between two distances ahead.</summary>
    public double MaxCurvature(double fromDistance, double toDistance)
    {
        double max = 0;
        for (double d = fromDistance; d <= toDistance; d += CurvatureSampleStep)
        {
            double c = _curv[IndexAt(d)];
            if (c > max) max = c;
        }
        return max;
    }

    /// <summary>Segment index containing <paramref name="distance"/> (binary search on the arc-length table).</summary>
    public int IndexAt(double distance)
    {
        double d = Wrap(distance);
        int lo = 0, hi = Count - 1;
        while (lo < hi)
        {
            int mid = (lo + hi + 1) >> 1;
            if (_cum[mid] <= d) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    private double Wrap(double distance)
    {
        double d = distance % Length;
        return d < 0 ? d + Length : d;
    }
}
