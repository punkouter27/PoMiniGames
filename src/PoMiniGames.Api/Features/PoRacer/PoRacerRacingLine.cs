namespace PoMiniGames.Features.PoRacer;

/// <summary>
/// A track's racing line, worked out once per track (cached by id): a speed profile along the
/// centerline nodes (curvature limit, then a backward pass for braking and a forward pass for
/// acceleration), an apex-biased lateral lane (the inside of each bend) and where the next bend
/// starts. Bots read it in PoRacerSim.UpdateAi; skill and caution decide how close to it they drive.
/// </summary>
internal sealed class PoRacerRacingLine
{
    /// <summary>The speed the profile treats as "flat out"; profile speeds are shares of it.</summary>
    public const double TopSpeed = 320;
    /// <summary>Lateral acceleration the tyres are assumed to hold (units/s squared); about 140 units/s round the oval's sharpest bend.</summary>
    public const double LateralLimit = 70;
    public const double BrakeLimit = 330;   // deceleration in units/s squared (about the bots' brake)
    public const double AccelLimit = 200;   // and the push out of a bend
    public const double ApexWindow = 10;
    /// <summary>A bend is a stretch where the heading turns more than this over four segments.</summary>
    private const double BendThreshold = 0.18;

    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, PoRacerRacingLine> Cache = new(StringComparer.Ordinal);

    public int Count { get; }
    /// <summary>Segment length from node i to i+1.</summary>
    public double[] SegmentLength { get; }
    /// <summary>Speed the line allows at node i, in units/s.</summary>
    public double[] Speed { get; }
    /// <summary>Raw curvature at node i (radians per unit).</summary>
    public double[] Curvature { get; }
    /// <summary>The lane that cuts node i's bend: -0.6 to 0.6, positive on the side the track normal points to.</summary>
    public double[] Apex { get; }
    /// <summary>Nodes from i to the start of the next bend (0 inside one).</summary>
    public int[] NextBendDistance { get; }
    /// <summary>The sign (+1 or -1) of that next bend, the side its inside is on.</summary>
    public int[] NextBendSign { get; }

    public static PoRacerRacingLine For(PoRacerTrackData track) =>
        Cache.GetOrAdd(track.Id, _ => new PoRacerRacingLine(track.Centerline));

    private PoRacerRacingLine(IReadOnlyList<Vec2> line)
    {
        int n = line.Count;
        Count = n;
        SegmentLength = new double[n];
        var heading = new double[n];
        for (int i = 0; i < n; i++)
        {
            var a = line[i]; var b = line[(i + 1) % n];
            SegmentLength[i] = Math.Max(1e-6, Math.Sqrt((b.X - a.X) * (b.X - a.X) + (b.Y - a.Y) * (b.Y - a.Y)));
            heading[i] = Math.Atan2(b.Y - a.Y, b.X - a.X);
        }
        // turn[i]: heading change entering node i (from segment i-1 to segment i).
        var turn = new double[n];
        for (int i = 0; i < n; i++) turn[i] = PoRacerAiDriver.ShortAngleDiff(heading[i], heading[(i - 1 + n) % n]);

        Curvature = new double[n];
        Speed = new double[n];
        for (int i = 0; i < n; i++)
        {
            double angle = 0, length = 0;
            for (int k = -1; k <= 1; k++)
            {
                angle += Math.Abs(turn[(i + k + n) % n]);
                length += SegmentLength[(i + k + n) % n];
            }
            Curvature[i] = angle / length;
            Speed[i] = Math.Min(TopSpeed, Math.Sqrt(LateralLimit / Math.Max(1e-6, Curvature[i])));
        }
        // Braking: a node can be no faster than a car could still stop for the next one. Two
        // laps round so the wrap at the line settles. Then the forward pass for the push out.
        for (int pass = 0; pass < 2 * n; pass++)
        {
            int i = (n - 1 - pass % n + n) % n;
            int next = (i + 1) % n;
            Speed[i] = Math.Min(Speed[i], Math.Sqrt(Speed[next] * Speed[next] + 2 * BrakeLimit * SegmentLength[i]));
        }
        for (int pass = 0; pass < 2 * n; pass++)
        {
            int i = pass % n;
            int next = (i + 1) % n;
            Speed[next] = Math.Min(Speed[next], Math.Sqrt(Speed[i] * Speed[i] + 2 * AccelLimit * SegmentLength[i]));
        }

        Apex = new double[n];
        for (int i = 0; i < n; i++)
        {
            double sum = 0;
            for (int k = 0; k < ApexWindow; k++) sum += turn[(i + 1 + k) % n];
            Apex[i] = Math.Clamp(sum / 0.7, -1, 1) * 0.6;
        }

        NextBendDistance = new int[n];
        NextBendSign = new int[n];
        var bendHere = new bool[n];
        var bendSign = new int[n];
        for (int i = 0; i < n; i++)
        {
            double sum = 0;
            for (int k = 1; k <= 4; k++) sum += turn[(i + k) % n];
            bendHere[i] = Math.Abs(sum) > BendThreshold;
            bendSign[i] = sum >= 0 ? 1 : -1;
        }
        int nearest = n, sign = 1;
        for (int pass = 0; pass < 2 * n; pass++)
        {
            int i = (n - 1 - pass % n + n) % n;
            if (bendHere[i]) { nearest = 0; sign = bendSign[i]; }
            else nearest = Math.Min(n, nearest + 1);
            // Walking backwards, `nearest` counts the nodes since the bend just passed over.
            NextBendDistance[i] = nearest;
            NextBendSign[i] = sign;
        }
    }
}

/// <summary>
/// The fastest completed lap a human drove on each track, as speed per centerline node. Held in
/// memory only, bounded, and fed by humans alone; the bots read it to learn the braking points.
/// </summary>
public sealed class PoRacerGhostLibrary
{
    private const int Capacity = 32;
    private readonly Dictionary<string, (double Seconds, double[] Speeds)> _best = new(StringComparer.Ordinal);
    private readonly object _gate = new();

    /// <summary>Keep the lap if it beats the track's best. Returns true when it did.</summary>
    public bool Offer(string trackId, double seconds, double[] speeds)
    {
        lock (_gate)
        {
            if (_best.TryGetValue(trackId, out var held) && held.Seconds <= seconds) return false;
            if (!_best.ContainsKey(trackId) && _best.Count >= Capacity) return false;
            _best[trackId] = (seconds, speeds);
            return true;
        }
    }

    public (double Seconds, double[] Speeds)? Get(string trackId)
    {
        lock (_gate) return _best.TryGetValue(trackId, out var held) ? held : null;
    }
}
