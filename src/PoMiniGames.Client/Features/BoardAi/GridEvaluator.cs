namespace PoMiniGamesClient.Features.BoardAi;

/// <summary>
/// Pattern evaluation over every winning window. A window holding only one side's stones
/// scores by how many it has; a window one stone short of a line is a four-threat whose
/// empty cell counts in full only when it is playable now (gravity: otherwise it needs
/// support, worth less, and a threat sitting exactly one above the stack is worth more
/// because the opponent cannot play beneath it). Several overlapping three-windows make an
/// open three, and two distinct playable four-threats make a double threat.
/// </summary>
public static class GridEvaluator
{
    private const int DoubleThreatBonus = 2500;
    private const int OpenThreeBonus = 40;
    private const int MaxThreats = 16;

    public static int Evaluate(GridPosition pos, int side)
    {
        var g = pos.Geometry;
        int win = g.Win;
        var cells = pos.Cells;
        var windows = g.Windows;
        Span<int> score = stackalloc int[3];
        Span<int> threes = stackalloc int[3];
        Span<int> threatCount = stackalloc int[3];
        Span<int> threats = stackalloc int[2 * MaxThreats];

        for (int w = 0; w < g.WindowCount; w++)
        {
            int baseIdx = w * win, a = 0, b = 0, empty = -1;
            for (int i = 0; i < win; i++)
            {
                var idx = windows[baseIdx + i];
                var v = cells[idx];
                if (v == 1) a++;
                else if (v == 2) b++;
                else empty = idx;
            }
            if ((a == 0) == (b == 0)) continue; // empty or contested window
            int owner = a > 0 ? 1 : 2, k = a + b;
            int weight = k == win - 1 ? 300 : k == win - 2 ? 30 : k == win - 3 ? 4 : 1;
            if (k == win - 1)
            {
                int distance = 0;
                if (g.Gravity) distance = pos.Tops[empty % g.Cols] - empty / g.Cols;
                if (distance == 0)
                {
                    var n = threatCount[owner];
                    var seen = false;
                    for (int t = 0; t < n; t++)
                    {
                        if (threats[(owner - 1) * MaxThreats + t] == empty) { seen = true; break; }
                    }
                    if (!seen && n < MaxThreats)
                    {
                        threats[(owner - 1) * MaxThreats + n] = empty;
                        threatCount[owner] = n + 1;
                    }
                }
                else
                {
                    weight = distance == 1 ? weight * 7 / 10 : weight * 4 / 10;
                }
            }
            else if (k == win - 2)
            {
                threes[owner]++;
            }
            score[owner] += weight;
        }

        for (int p = 1; p <= 2; p++)
        {
            if (threatCount[p] >= 2) score[p] += DoubleThreatBonus * (threatCount[p] - 1);
            if (threes[p] > 1) score[p] += OpenThreeBonus * (threes[p] - 1);
        }
        return score[side] - score[3 - side];
    }
}
