namespace PoMiniGamesClient.Features.BoardAi;

/// <summary>
/// One strength rung: how long the CPU thinks, how deep it may look and how human it is.
/// </summary>
/// <param name="BudgetMs">Wall-clock budget for the main search.</param>
/// <param name="MaxDepth">Iterative-deepening ceiling (plies).</param>
/// <param name="Temperature">Softmax temperature over the top root moves; 0 always plays the best move.</param>
/// <param name="ScoreClamp">Scores are clamped to +/- this before sampling; a small clamp lets a weak CPU "not quite see" a win.</param>
/// <param name="TopK">Only the best K root moves are candidates when sampling.</param>
/// <param name="VcfDepth">Threat-space search depth for forced wins and forced defence (0 = off).</param>
/// <param name="BookPlies">Use the opening book while fewer than this many discs/marks are down.</param>
/// <param name="TacticChance">Chance the CPU notices an immediate win or a single immediate loss to block.</param>
/// <param name="UseMcts">Pick with Monte Carlo tree search instead of negamax.</param>
public readonly record struct AiRung(
    int BudgetMs,
    int MaxDepth,
    double Temperature,
    int ScoreClamp,
    int TopK,
    int VcfDepth,
    int BookPlies,
    double TacticChance,
    bool UseMcts = false);

/// <summary>
/// Shared CPU brain for the k-in-a-row grid games. Order of play: opening book, immediate
/// tactics, threat-space search (forced win, then forced defence), then iterative-deepening
/// negamax or MCTS. Weak rungs sample the root moves with a softmax so they make plausible
/// mistakes instead of random ones.
/// </summary>
public sealed class GridAiEngine
{
    private readonly GridGeometry _g;
    private readonly Random _rng;
    private readonly GridSearch _search;
    private readonly GridThreatSearch _threats;
    private readonly GridMcts _mcts;
    private readonly Func<GridPosition, int[]>? _book;

    public GridAiEngine(GridGeometry geometry, Random? rng = null, Func<GridPosition, int[]>? book = null, int ttSizeLog2 = 16)
    {
        _g = geometry;
        _rng = rng ?? Random.Shared;
        _book = book;
        _search = new GridSearch(geometry, ttSizeLog2);
        _threats = new GridThreatSearch(geometry);
        _mcts = new GridMcts(geometry, _rng);
    }

    public GridSearch Search => _search;
    public GridThreatSearch Threats => _threats;

    /// <summary>Returns the chosen cell index, or -1 when no move exists.</summary>
    public int Choose(GridPosition pos, AiRung rung)
    {
        var buf = new int[_g.Total];
        var n = pos.GenMoves(buf);
        if (n == 0) return -1;
        if (n == 1) return buf[0];

        if (_book is not null && rung.BookPlies > pos.Count)
        {
            var options = _book(pos);
            if (options.Length > 0) return options[_rng.Next(options.Length)];
        }

        int me = pos.ToMove, opp = 3 - me;
        int[]? filter = null;
        if (_rng.NextDouble() < rung.TacticChance)
        {
            int block = -1, threats = 0;
            for (int i = 0; i < n; i++)
            {
                if (pos.MakesLine(buf[i], me)) return buf[i];
                if (pos.MakesLine(buf[i], opp)) { threats++; block = buf[i]; }
            }
            if (threats == 1) return block;

            if (rung.VcfDepth > 0)
            {
                long nodes = 1500L * rung.VcfDepth;
                var win = _threats.FindWin(pos, rung.VcfDepth, nodes);
                if (win >= 0) return win;
                if (_threats.OpponentHasForcedWin(pos, rung.VcfDepth, nodes))
                {
                    filter = SafeMoves(pos, buf, n, rung.VcfDepth, nodes / 2);
                }
            }
        }

        return rung.UseMcts ? ChooseMcts(pos, rung, filter) : ChooseNegamax(pos, rung, filter);
    }

    private int[]? SafeMoves(GridPosition pos, int[] moves, int n, int depth, long nodes)
    {
        var safe = new List<int>(n);
        for (int i = 0; i < n; i++)
        {
            if (pos.Make(moves[i]))
            {
                pos.Undo();
                return [moves[i]];
            }
            if (_threats.FindWin(pos, depth, nodes) < 0) safe.Add(moves[i]);
            pos.Undo();
        }
        return safe.Count > 0 ? [.. safe] : null;
    }

    private int ChooseNegamax(GridPosition pos, AiRung rung, int[]? filter)
    {
        var wantScores = rung.Temperature > 0 && rung.TopK > 1;
        var result = _search.Run(pos, rung.BudgetMs, rung.MaxDepth, wantScores, filter);
        if (result.Move < 0) return -1;
        if (!wantScores || result.Moves.Length < 2) return result.Move;
        return SoftmaxPick(result.Moves, result.Scores, rung);
    }

    private int ChooseMcts(GridPosition pos, AiRung rung, int[]? filter)
    {
        var result = _mcts.Run(pos, rung.BudgetMs);
        if (result.Move < 0) return -1;
        var moves = new List<int>();
        var scores = new List<int>();
        for (int i = 0; i < result.Moves.Length; i++)
        {
            if (filter is { Length: > 0 } && Array.IndexOf(filter, result.Moves[i]) < 0) continue;
            moves.Add(result.Moves[i]);
            // Visits break ties so an unvisited move can never look as good as a searched one.
            scores.Add((int)((result.WinRates[i] - 0.5) * 4000) + Math.Min(result.Visits[i], 50));
        }
        if (moves.Count == 0) return result.Move;
        if (rung.Temperature <= 0 || rung.TopK < 2) return moves[IndexOfMax(scores)];
        return SoftmaxPick([.. moves], [.. scores], rung);
    }

    private int SoftmaxPick(int[] moves, int[] scores, AiRung rung) =>
        GridSoftmax.Pick(moves, scores, rung.TopK, rung.Temperature, rung.ScoreClamp, _rng);

    private static int IndexOfMax(List<int> values)
    {
        int best = 0;
        for (int i = 1; i < values.Count; i++)
        {
            if (values[i] > values[best]) best = i;
        }
        return best;
    }
}

/// <summary>
/// Human-like move sampling: softmax over the top-k scored root moves. A high temperature
/// makes near-ties and plausible second choices common; a clamp keeps a weak CPU from seeing
/// a forced win as infinitely better than everything else.
/// </summary>
public static class GridSoftmax
{
    public static int Pick(int[] moves, int[] scores, int topK, double temperature, int clamp, Random rng)
    {
        if (moves.Length == 0) return -1;
        var order = Enumerable.Range(0, moves.Length).OrderByDescending(i => scores[i]).ToArray();
        var k = Math.Clamp(topK, 1, moves.Length);
        if (temperature <= 0 || k == 1) return moves[order[0]];

        var top = Math.Clamp(scores[order[0]], -clamp, clamp);
        var weights = new double[k];
        double sum = 0;
        for (int i = 0; i < k; i++)
        {
            var s = Math.Clamp(scores[order[i]], -clamp, clamp);
            weights[i] = Math.Exp((s - top) / temperature);
            sum += weights[i];
        }
        var roll = rng.NextDouble() * sum;
        for (int i = 0; i < k; i++)
        {
            roll -= weights[i];
            if (roll <= 0) return moves[order[i]];
        }
        return moves[order[0]];
    }
}
