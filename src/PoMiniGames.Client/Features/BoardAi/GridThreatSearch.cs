namespace PoMiniGamesClient.Features.BoardAi;

/// <summary>
/// Threat-space search (VCF: victory by continuous fours). The attacker may only play moves
/// that create an immediate winning cell the defender must answer; the defender's reply is
/// therefore forced. With gravity a threat cell only counts when it is playable right now
/// (the move generator only offers playable cells), so a four with an unsupported gap is
/// not a live threat until the stack reaches it. Two distinct live threats win outright.
/// Bounded by depth (attacker moves) and a node budget.
/// </summary>
public sealed class GridThreatSearch
{
    private const int MaxDepth = 24;
    private readonly int[][] _attack;
    private readonly int[][] _reply;
    private long _nodes;
    private long _maxNodes;

    public GridThreatSearch(GridGeometry geometry)
    {
        _attack = new int[MaxDepth + 2][];
        _reply = new int[MaxDepth + 2][];
        for (int i = 0; i < _attack.Length; i++)
        {
            _attack[i] = new int[geometry.Total];
            _reply[i] = new int[geometry.Total];
        }
    }

    public long NodesUsed => _nodes;

    /// <summary>
    /// The side to move in <paramref name="pos"/> attacks. Returns the first move of a forced
    /// win, or -1 when none is found inside the depth/node bounds.
    /// </summary>
    public int FindWin(GridPosition pos, int maxDepth, long maxNodes)
    {
        _nodes = 0;
        _maxNodes = maxNodes;
        return Vcf(pos, Math.Min(maxDepth, MaxDepth), 0);
    }

    /// <summary>True when the side NOT to move has a forced win if it were handed the move.</summary>
    public bool OpponentHasForcedWin(GridPosition pos, int maxDepth, long maxNodes)
    {
        pos.Pass();
        var found = FindWin(pos, maxDepth, maxNodes);
        pos.Pass();
        return found >= 0;
    }

    private int Vcf(GridPosition pos, int depth, int ply)
    {
        if (++_nodes > _maxNodes) return -1;
        int me = pos.ToMove, opp = 3 - me;
        var buf = _attack[ply];
        int n = pos.GenMoves(buf);
        for (int i = 0; i < n; i++)
        {
            if (pos.MakesLine(buf[i], me)) return buf[i];
        }
        if (depth == 0) return -1;

        int forced = -1, pending = 0;
        for (int i = 0; i < n; i++)
        {
            if (!pos.MakesLine(buf[i], opp)) continue;
            pending++;
            forced = buf[i];
        }
        if (pending >= 2) return -1;

        var reply = _reply[ply];
        for (int i = 0; i < n; i++)
        {
            var m = buf[i];
            if (pending == 1 && m != forced) continue;
            pos.Make(m);
            int n2 = pos.GenMoves(reply);
            int wins = 0, winCell = -1;
            bool defenderWins = false;
            for (int j = 0; j < n2; j++)
            {
                if (pos.MakesLine(reply[j], me)) { wins++; winCell = reply[j]; }
                if (pos.MakesLine(reply[j], opp)) defenderWins = true;
            }
            var ok = false;
            if (!defenderWins && wins >= 1)
            {
                if (wins >= 2) ok = true;
                else
                {
                    pos.Make(winCell);
                    ok = Vcf(pos, depth - 1, ply + 1) >= 0;
                    pos.Undo();
                }
            }
            pos.Undo();
            if (ok) return m;
            if (_nodes > _maxNodes) return -1;
        }
        return -1;
    }
}
