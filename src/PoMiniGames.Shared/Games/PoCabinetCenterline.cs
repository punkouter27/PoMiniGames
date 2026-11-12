namespace PoMiniGames.Shared.Games;

/// <summary>
/// A resampled centerline's arc-length tables: segment lengths, running distance, unit tangents
/// and the heading change at each sample. Built once per track and shared by the features
/// (<see cref="PoCabinetTrackFeatures"/>), the daily layout check and the server's runtime track,
/// which used to compute their own copies. Mirrors track.js's constructor.
/// </summary>
public sealed class PoCabinetCenterline
{
    public int Count { get; }
    public double[] X { get; }
    public double[] Y { get; }
    public double[] SegLen { get; }
    /// <summary>Distance along the loop to each sample; <c>Cum[Count]</c> is the loop length.</summary>
    public double[] Cum { get; }
    public double[] Tx { get; }
    public double[] Ty { get; }
    public double Length => Cum[Count];

    /// <param name="xy">Flat x,y pairs (<see cref="PoCabinetTrackGeometry.BuildCenterlineXY"/>).</param>
    public PoCabinetCenterline(IReadOnlyList<double> xy)
    {
        Count = xy.Count / 2;
        X = new double[Count];
        Y = new double[Count];
        for (int i = 0; i < Count; i++)
        {
            X[i] = xy[i * 2];
            Y[i] = xy[i * 2 + 1];
        }
        SegLen = new double[Count];
        Cum = new double[Count + 1];
        Tx = new double[Count];
        Ty = new double[Count];
        for (int i = 0; i < Count; i++)
        {
            int j = (i + 1) % Count;
            double dx = X[j] - X[i], dy = Y[j] - Y[i];
            double len = Math.Sqrt(dx * dx + dy * dy);
            SegLen[i] = len;
            Cum[i + 1] = Cum[i] + len;
            Tx[i] = len > 1e-9 ? dx / len : 1;
            Ty[i] = len > 1e-9 ? dy / len : 0;
        }
    }

    /// <summary>
    /// Signed curvature per sample (+ = a right-hander, heading increasing): the heading change
    /// across it over the mean adjacent segment length, smoothed over three samples. The raw
    /// spline samples are noisy enough that the AI would otherwise brake for kinks.
    /// <paramref name="magnitudeOnly"/> takes the magnitude before smoothing (the AI's braking).
    /// </summary>
    public double[] Curvature(bool magnitudeOnly)
    {
        var raw = new double[Count];
        for (int i = 0; i < Count; i++)
        {
            int p = (i - 1 + Count) % Count;
            double d = PoCabinetDetMath.WrapAngle(PoCabinetDetMath.Atan2(Ty[i], Tx[i]) - PoCabinetDetMath.Atan2(Ty[p], Tx[p]));
            raw[i] = (magnitudeOnly ? Math.Abs(d) : d) / Math.Max(1e-6, (SegLen[p] + SegLen[i]) * 0.5);
        }
        var curv = new double[Count];
        for (int i = 0; i < Count; i++) curv[i] = (raw[(i - 1 + Count) % Count] + raw[i] + raw[(i + 1) % Count]) / 3.0;
        return curv;
    }
}
