using System.Diagnostics;

namespace PoMiniGamesClient.Features.BoardAi;

public sealed class SearchResult
{
    public int Move { get; init; } = -1;
    public int Score { get; init; }
    public int Depth { get; init; }
    public long Nodes { get; init; }

    /// <summary>Root moves with their scores from the last completed iteration (exact only when scores were requested).</summary>
    public int[] Moves { get; init; } = [];
    public int[] Scores { get; init; } = [];
}

/// <summary>
/// Iterative-deepening alpha-beta negamax under a wall-clock budget. The result always comes
/// from the last fully completed iteration. Uses a Zobrist transposition table with bound
/// flags, and orders moves TT move, killers per ply, history heuristic, then centre distance.
/// </summary>
public sealed class GridSearch
{
    public const int Mate = 100_000;
    private const int MaxPly = 64;
    private const int MateBand = 1_000;

    private readonly GridGeometry _g;
    private readonly TranspositionTable _tt;
    private readonly int[][] _moveBuf;
    private readonly int[][] _keyBuf;
    private readonly int[] _killers = new int[MaxPly * 2];
    private readonly int[] _history;
    private GridPosition _pos = null!;
    private long _deadline;
    private long _nodes;
    private bool _aborted;
    private bool _abortable;

    public GridSearch(GridGeometry geometry, int ttSizeLog2 = 16)
    {
        _g = geometry;
        _tt = new TranspositionTable(ttSizeLog2);
        _moveBuf = new int[MaxPly][];
        _keyBuf = new int[MaxPly][];
        for (int i = 0; i < MaxPly; i++)
        {
            _moveBuf[i] = new int[geometry.Total];
            _keyBuf[i] = new int[geometry.Total];
        }
        _history = new int[2 * geometry.Total];
    }

    public TranspositionTable Table => _tt;

    /// <param name="rootFilter">If non-empty, only these root cells are considered.</param>
    /// <param name="wantScores">Search every root move with a full window so all scores are exact (needed for softmax sampling).</param>
    public SearchResult Run(GridPosition pos, int budgetMs, int maxDepth, bool wantScores, int[]? rootFilter = null)
    {
        _pos = pos;
        _tt.NewSearch();
        Array.Fill(_killers, -1);
        for (int i = 0; i < _history.Length; i++) _history[i] >>= 2;
        _nodes = 0;
        _aborted = false;
        _abortable = false;
        _deadline = Stopwatch.GetTimestamp() + budgetMs * Stopwatch.Frequency / 1000;

        var buf = new int[_g.Total];
        var n = pos.GenMoves(buf);
        var roots = new List<int>(n);
        for (int i = 0; i < n; i++)
        {
            if (rootFilter is null || rootFilter.Length == 0 || Array.IndexOf(rootFilter, buf[i]) >= 0) roots.Add(buf[i]);
        }
        if (roots.Count == 0) return new SearchResult();
        if (roots.Count == 1) return new SearchResult { Move = roots[0], Moves = [roots[0]], Scores = [0] };

        var moves = roots.ToArray();
        var scores = new int[moves.Length];
        int bestMove = moves[0], bestScore = 0, doneDepth = 0;
        var start = Stopwatch.GetTimestamp();

        for (int depth = 1; depth <= Math.Min(maxDepth, MaxPly - 2); depth++)
        {
            _abortable = depth > 1;
            var iter = new int[moves.Length];
            int alpha = -Mate - 1;
            int iterBest = int.MinValue, iterBestIdx = 0;
            for (int i = 0; i < moves.Length; i++)
            {
                int score;
                if (pos.Make(moves[i])) score = Mate - 1;
                else
                {
                    score = -Search(depth - 1, -Mate - 1, wantScores ? Mate + 1 : -alpha, 1);
                }
                pos.Undo();
                if (_aborted) break;
                iter[i] = score;
                if (score > iterBest)
                {
                    iterBest = score;
                    iterBestIdx = i;
                }
                if (!wantScores && score > alpha) alpha = score;
            }
            if (_aborted) break;

            // Order the next iteration: best move first, the rest by score.
            bestMove = moves[iterBestIdx];
            bestScore = iterBest;
            doneDepth = depth;
            var order = Enumerable.Range(0, moves.Length).OrderByDescending(i => i == iterBestIdx ? int.MaxValue : iter[i]).ToArray();
            moves = order.Select(i => moves[i]).ToArray();
            scores = order.Select(i => iter[i]).ToArray();

            if (Math.Abs(bestScore) >= Mate - MateBand) break;
            var elapsed = Stopwatch.GetTimestamp() - start;
            if (elapsed * 3 > _deadline - start) break; // the next iteration cannot finish in time
        }

        return new SearchResult { Move = bestMove, Score = bestScore, Depth = doneDepth, Nodes = _nodes, Moves = moves, Scores = scores };
    }

    private int Search(int depth, int alpha, int beta, int ply)
    {
        if ((++_nodes & 255) == 0 && _abortable && Stopwatch.GetTimestamp() > _deadline) _aborted = true;
        if (_aborted) return 0;
        var pos = _pos;
        if (pos.IsFull) return 0;

        int me = pos.ToMove, opp = 3 - me;
        var buf = _moveBuf[ply];
        int n = pos.GenMoves(buf);

        // Win now.
        for (int i = 0; i < n; i++)
        {
            if (pos.MakesLine(buf[i], me)) return Mate - ply;
        }
        if (depth <= 0 || ply >= MaxPly - 2) return GridEvaluator.Evaluate(pos, me);

        // Forced defence: one opposing win must be blocked, two cannot be.
        int forcedBlock = -1, threats = 0;
        for (int i = 0; i < n; i++)
        {
            if (!pos.MakesLine(buf[i], opp)) continue;
            threats++;
            forcedBlock = buf[i];
        }
        if (threats >= 2) return -(Mate - ply - 1);
        if (threats == 1)
        {
            buf[0] = forcedBlock;
            n = 1;
        }

        int alpha0 = alpha;
        var hash = pos.Hash;
        int ttMove = -1;
        if (_tt.Probe(hash, out var ttDepth, out var ttScore, out var ttBound, out var tm))
        {
            ttMove = tm;
            if (ttDepth >= depth)
            {
                var s = FromTt(ttScore, ply);
                if (ttBound == BoundKind.Exact) return s;
                if (ttBound == BoundKind.Lower && s >= beta) return s;
                if (ttBound == BoundKind.Upper && s <= alpha) return s;
            }
        }

        // Ordering keys: TT move, killers, history, centre rank.
        var keys = _keyBuf[ply];
        var hist = me == 1 ? 0 : _g.Total;
        for (int i = 0; i < n; i++)
        {
            var m = buf[i];
            int key = Math.Min(_history[hist + m], 60_000) * 10 + _g.CenterRank[m];
            if (m == ttMove) key = 2_000_000_000;
            else if (m == _killers[ply * 2]) key = 1_000_000_000;
            else if (m == _killers[ply * 2 + 1]) key = 900_000_000;
            keys[i] = key;
        }

        int best = -Mate - 1, bestMove = -1;
        for (int i = 0; i < n; i++)
        {
            int pick = i;
            for (int j = i + 1; j < n; j++)
            {
                if (keys[j] > keys[pick]) pick = j;
            }
            if (pick != i)
            {
                (buf[i], buf[pick]) = (buf[pick], buf[i]);
                (keys[i], keys[pick]) = (keys[pick], keys[i]);
            }
            var m = buf[i];
            pos.Make(m);
            var score = -Search(depth - 1, -beta, -alpha, ply + 1);
            pos.Undo();
            if (_aborted) return 0;
            if (score > best)
            {
                best = score;
                bestMove = m;
                if (score > alpha) alpha = score;
            }
            if (alpha >= beta)
            {
                if (_killers[ply * 2] != m)
                {
                    _killers[ply * 2 + 1] = _killers[ply * 2];
                    _killers[ply * 2] = m;
                }
                _history[hist + m] += depth * depth;
                break;
            }
        }

        var bound = best <= alpha0 ? BoundKind.Upper : best >= beta ? BoundKind.Lower : BoundKind.Exact;
        _tt.Store(hash, depth, ToTt(best, ply), bound, bestMove);
        return best;
    }

    private static int ToTt(int score, int ply) =>
        score >= Mate - MateBand ? score + ply : score <= -Mate + MateBand ? score - ply : score;

    private static int FromTt(int score, int ply) =>
        score >= Mate - MateBand ? score - ply : score <= -Mate + MateBand ? score + ply : score;
}
