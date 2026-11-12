namespace PoMiniGames.Shared.Games;

/// <summary>
/// The per-sample track features of a <see cref="PoCabinetStaticWorld"/>: road width, run-off,
/// apex kerbs, the racing line, grip patches and road dividers. Computed once, here, and shipped
/// with the world, so the server's physics (PoCabinetTrack), the browser's (track.js) and the
/// scene all read the same arrays instead of each deriving their own. Nothing in here has to be
/// bit-exact across runtimes: only its output is simulated, and both sides get the same output.
/// </summary>
public static class PoCabinetTrackFeatures
{
    /// <summary>Smoothed curvature (rad per sim unit) above which a sample is a corner and gets an
    /// apex kerb: a radius of ~220 units, about two road widths.</summary>
    public const double KerbCurvature = 0.0045;
    /// <summary>Keep the start line, gantry and grid clean: spline kinks there are not corners.</summary>
    private const double StartClearAhead = 70;
    private const double StartClearBehind = 140;
    private const int KerbDilate = 3;
    private const int KerbMinRun = 5;
    /// <summary>The racing line stays inside this share of the half width (inside the kerbs).</summary>
    private const double LineReach = 0.72;

    public static void Fill(PoCabinetStaticWorld world, PoCabinetTrackDefinition def, double[] xy)
    {
        var centerline = new PoCabinetCenterline(xy);
        int n = centerline.Count;
        int steps = def.StepsPerSegment;
        var cum = centerline.Cum;
        double length = centerline.Length;
        var curv = centerline.Curvature(magnitudeOnly: false);

        int hiddenFrom = def.HiddenFromKnot * steps, hiddenTo = def.HiddenToKnot * steps;
        bool Drawn(int i) => !(i >= hiddenFrom && i < hiddenTo);
        int Sample(double knot) => (((int)Math.Round(knot * steps)) % n + n) % n;

        // Width.
        var widthMul = PoCabinetTrackGeometry.BuildCenterlineValues(def.KnotWidth, steps, 3);
        var hw = new double[n];
        for (int i = 0; i < n; i++) hw[i] = Math.Round(def.TrackWidth * 0.5 * (widthMul.Length == n ? widthMul[i] : 1), 1);

        // Run-off.
        var left = new int[n];
        var right = new int[n];
        Array.Fill(left, (int)def.DefaultRunoff);
        Array.Fill(right, (int)def.DefaultRunoff);
        foreach (var z in def.Runoff ?? [])
        {
            foreach (int i in Range(Sample(z.FromKnot), Sample(z.ToKnot), n))
            {
                if (z.Side <= 0) left[i] = (int)z.Kind;
                if (z.Side >= 0) right[i] = (int)z.Kind;
            }
        }

        // Apex kerbs: the tightest corners, grown a few samples either way, clear of the start,
        // no slivers. Then the raised ones.
        var kerbRaw = new int[n];
        for (int i = 0; i < n; i++)
        {
            if (Math.Abs(curv[i]) > KerbCurvature) kerbRaw[i] = curv[i] > 0 ? 1 : -1;
        }
        var kerbs = new int[n];
        for (int i = 0; i < n; i++)
        {
            if (kerbRaw[i] == 0) continue;
            for (int k = -KerbDilate; k <= KerbDilate; k++)
            {
                int j = ((i + k) % n + n) % n;
                if (kerbs[j] == 0) kerbs[j] = kerbRaw[i];
            }
        }
        for (int i = 0; i < n; i++)
        {
            double d = cum[i];
            if (d < StartClearAhead || d > length - StartClearBehind || !Drawn(i)) kerbs[i] = 0;
        }
        for (int i = 0; i < n;)
        {
            if (kerbs[i] == 0) { i++; continue; }
            int j = i;
            while (j < n && kerbs[j] == kerbs[i]) j++;
            if (j - i < KerbMinRun && !(i == 0 || j == n)) Array.Fill(kerbs, 0, i, j - i);
            i = j;
        }
        foreach (var (from, to) in def.Sausages ?? [])
        {
            foreach (int i in Range(Sample(from), Sample(to), n)) kerbs[i] *= 2;
        }

        // The racing line: out wide before a corner, onto the apex, out wide again after it. Each
        // sample weighs the turn around it against the turns coming and gone, then three passes
        // of smoothing take out the kinks.
        // Mean curvature of the samples between `near` and `far` units from sample i, ahead of it
        // (dir +1) or behind it (dir -1).
        double Mean(int i, int dir, double near, double far)
        {
            double sum = 0;
            int count = 0;
            for (int k = 1; k < n; k++)
            {
                int j = ((i + dir * k) % n + n) % n;
                double d = dir > 0 ? cum[j] - cum[i] : cum[i] - cum[j];
                if (d < 0) d += length;
                if (d > far) break;
                if (d >= near) { sum += curv[j]; count++; }
            }
            return count > 0 ? sum / count : 0;
        }
        var line = new double[n];
        for (int i = 0; i < n; i++)
        {
            double here = (Mean(i, 1, 0, 40) + Mean(i, -1, 0, 40) + curv[i]) / 3;
            double around = (Mean(i, 1, 80, 220) + Mean(i, -1, 80, 220)) * 0.5;
            double pull = Math.Clamp((1.6 * here - 1.0 * around) / 0.006, -1, 1);
            line[i] = pull * hw[i] * LineReach;
        }
        for (int pass = 0; pass < 3; pass++)
        {
            var next = new double[n];
            for (int i = 0; i < n; i++) next[i] = (line[(i - 1 + n) % n] + line[i] * 2 + line[(i + 1) % n]) / 4;
            line = next;
        }
        for (int i = 0; i < n; i++) line[i] = Math.Round(line[i], 1);

        world.HalfWidths = hw;
        world.RunoffLeft = left;
        world.RunoffRight = right;
        world.Kerbs = kerbs;
        world.RacingLine = line;
        world.Patches = (def.Patches ?? []).Select(p =>
        {
            int from = Sample(p.FromKnot), to = Sample(p.ToKnot);
            double w = hw[(from + Math.Max(0, (to - from) / 2)) % n];
            return new PoCabinetPatchWire
            {
                From = from,
                To = to,
                LatFrom = Math.Round(p.LatFrom * w, 1),
                LatTo = Math.Round(p.LatTo * w, 1),
                DryGrip = p.DryGrip,
                WetGrip = p.WetGrip,
                Kind = p.Kind,
            };
        }).ToList();
        world.Islands = (def.Islands ?? []).Select(s => new PoCabinetIslandWire
        {
            From = Sample(s.FromKnot),
            To = Sample(s.ToKnot),
            LatFrom = s.LatFrom,
            LatTo = s.LatTo,
            ShortSide = s.ShortSide,
        }).ToList();
        world.Theme = def.Theme ?? def.Id;
    }

    /// <summary>Samples [from, to) round the loop (wrapping past the line when from &gt; to).</summary>
    private static IEnumerable<int> Range(int from, int to, int n)
    {
        for (int i = from; i != to; i = (i + 1) % n) yield return i;
    }
}
