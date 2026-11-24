using System.Diagnostics;

namespace PoMiniGamesClient.Features.BoardAi;

public sealed class MctsResult
{
    public int Move { get; init; } = -1;
    public int Iterations { get; init; }
    public int[] Moves { get; init; } = [];
    public int[] Visits { get; init; } = [];

    /// <summary>Win rate for the side that was to move at the root, per root move (0..1).</summary>
    public double[] WinRates { get; init; } = [];
}

/// <summary>
/// Monte Carlo tree search with UCT+RAVE (AMAF) selection, optional neural policy/value priors (#15),
/// Chebyshev-2 bounding-box pruning on open grids, subtree reuse, and heuristic-guided playouts (#6).
/// </summary>
public sealed class GridMcts
{
    private const double Exploration = 1.2;
    private const double RaveEquivalence = 48.0;
    private const int PlayoutCap = 48;

    private sealed class Node(int move, int mover, Node? parent, double prior = 0.0)
    {
        public readonly int Move = move;
        public readonly int Mover = mover;
        public Node? Parent = parent;
        public readonly List<Node> Children = [];
        public int[]? Untried;
        public int UntriedCount;
        public int Visits;
        public double Wins;
        public int AmafVisits;
        public double AmafWins;
        public double Prior = prior;
        public bool Terminal;
    }

    private readonly GridGeometry _g;
    private readonly Random _rng;
    private readonly int[] _playBuf;
    private readonly int[] _p1Seen;
    private readonly int[] _p2Seen;
    private int _stamp;
    private Node? _cachedRoot;
    private ulong _cachedHash;

    /// <summary>
    /// Optional non-blocking neural policy/value prior evaluator (#15). When set and non-null,
    /// priors bias PUCT selection at root/expanded nodes; when null, pure UCT+RAVE runs.
    /// </summary>
    public Func<GridPosition, (double[] Priors, double Value)?>? PriorEvaluator { get; set; }

    public GridMcts(GridGeometry geometry, Random rng)
    {
        _g = geometry;
        _rng = rng;
        _playBuf = new int[geometry.Total];
        _p1Seen = new int[geometry.Total];
        _p2Seen = new int[geometry.Total];
    }

    public MctsResult Run(GridPosition pos, int budgetMs, int maxIterations = int.MaxValue)
    {
        var deadline = Stopwatch.GetTimestamp() + budgetMs * Stopwatch.Frequency / 1000;
        var root = AcquireRoot(pos);
        if (root.UntriedCount == 0 && root.Children.Count == 0) return new MctsResult();
        int iterations = 0;
        Grow(pos, root, deadline, maxIterations, 32, ref iterations);
        _cachedRoot = root;
        _cachedHash = pos.Hash;
        return Collect(root, iterations);
    }

    /// <summary>
    /// <see cref="Run"/> in slices of at most <paramref name="sliceMs"/>, awaiting
    /// <paramref name="yieldAsync"/> between them so a single-threaded host keeps painting.
    /// The tree is kept across slices, so the result matches one uninterrupted run.
    /// </summary>
    public async Task<MctsResult> RunAsync(GridPosition pos, int budgetMs, int sliceMs, Func<Task> yieldAsync, CancellationToken ct = default)
    {
        var end = Stopwatch.GetTimestamp() + budgetMs * Stopwatch.Frequency / 1000;
        var slice = Math.Max(1, sliceMs) * Stopwatch.Frequency / 1000;
        var root = AcquireRoot(pos);
        if (root.UntriedCount == 0 && root.Children.Count == 0) return new MctsResult();
        int iterations = 0;
        while (true)
        {
            ct.ThrowIfCancellationRequested();
            Grow(pos, root, Math.Min(end, Stopwatch.GetTimestamp() + slice), int.MaxValue, iterations == 0 ? 32 : 0, ref iterations);
            if (Stopwatch.GetTimestamp() >= end) break;
            await yieldAsync();
        }
        ct.ThrowIfCancellationRequested();
        _cachedRoot = root;
        _cachedHash = pos.Hash;
        return Collect(root, iterations);
    }

    /// <summary>Attempts to reuse a surviving subtree from the previous turn.</summary>
    private Node AcquireRoot(GridPosition pos)
    {
        if (_cachedRoot is not null && _cachedHash == pos.Hash)
        {
            return _cachedRoot;
        }
        var root = new Node(-1, 3 - pos.ToMove, null);
        Expand(root, pos);
        return root;
    }

    /// <summary>Selection, expansion, playout and RAVE+UCT backpropagation until the deadline.</summary>
    private void Grow(GridPosition pos, Node root, long deadline, int maxIterations, int minIterations, ref int iterations)
    {
        int ran = 0;
        while (iterations < maxIterations && (ran < minIterations || Stopwatch.GetTimestamp() < deadline))
        {
            ran++;
            iterations++;
            int stamp = ++_stamp;
            var node = root;
            int made = 0;
            // Selection.
            while (!node.Terminal && node.UntriedCount == 0 && node.Children.Count > 0)
            {
                node = SelectChild(node);
                RecordSeen(node.Move, node.Mover, stamp);
                pos.Make(node.Move);
                made++;
            }

            double value; // outcome for player 1: 1 win, 0 loss, 0.5 draw, or a soft evaluator value
            if (node.Terminal)
            {
                value = node.Mover == 1 ? 1.0 : 0.0;
            }
            else
            {
                if (node.UntriedCount > 0)
                {
                    var pick = _rng.Next(node.UntriedCount);
                    var move = node.Untried![pick];
                    node.Untried[pick] = node.Untried[--node.UntriedCount];
                    var mover = pos.ToMove;
                    var won = pos.Make(move);
                    RecordSeen(move, mover, stamp);
                    made++;
                    var child = new Node(move, mover, node) { Terminal = won };
                    node.Children.Add(child);
                    node = child;
                    if (!won) Expand(node, pos);
                }
                if (node.Terminal)
                {
                    value = node.Mover == 1 ? 1.0 : 0.0;
                }
                else
                {
                    var neural = PriorEvaluator?.Invoke(pos);
                    if (neural.HasValue)
                    {
                        ApplyPriors(node, neural.Value.Priors);
                        value = 0.5 * neural.Value.Value + 0.5 * Playout(pos, stamp);
                    }
                    else
                    {
                        value = Playout(pos, stamp);
                    }
                }
            }

            // Backpropagation with RAVE/AMAF statistics for sibling moves seen in the same playout.
            for (var n = node; n is not null; n = n.Parent)
            {
                n.Visits++;
                double scoreForMover = n.Mover == 1 ? value : 1.0 - value;
                n.Wins += scoreForMover;
                if (n.Children.Count > 0)
                {
                    int childMover = 3 - n.Mover;
                    double childScore = childMover == 1 ? value : 1.0 - value;
                    var seen = childMover == 1 ? _p1Seen : _p2Seen;
                    for (int i = 0; i < n.Children.Count; i++)
                    {
                        var c = n.Children[i];
                        if (seen[c.Move] == stamp)
                        {
                            c.AmafVisits++;
                            c.AmafWins += childScore;
                        }
                    }
                }
            }
            for (int i = 0; i < made; i++) pos.Undo();
        }
    }

    private void RecordSeen(int move, int mover, int stamp)
    {
        if (move < 0 || move >= _g.Total) return;
        if (mover == 1) _p1Seen[move] = stamp;
        else _p2Seen[move] = stamp;
    }

    private static void ApplyPriors(Node node, double[] priors)
    {
        for (int i = 0; i < node.Children.Count; i++)
        {
            var c = node.Children[i];
            if (c.Move >= 0 && c.Move < priors.Length)
            {
                c.Prior = priors[c.Move];
            }
        }
    }

    private static MctsResult Collect(Node root, int iterations)
    {
        var moves = new int[root.Children.Count];
        var visits = new int[moves.Length];
        var rates = new double[moves.Length];
        int best = 0;
        for (int i = 0; i < moves.Length; i++)
        {
            var c = root.Children[i];
            moves[i] = c.Move;
            visits[i] = c.Visits;
            rates[i] = c.Visits == 0 ? 0.5 : c.Wins / c.Visits;
            if (c.Visits > visits[best] || (c.Visits == visits[best] && rates[i] > rates[best])) best = i;
        }
        return new MctsResult { Move = moves[best], Iterations = iterations, Moves = moves, Visits = visits, WinRates = rates };
    }

    private void Expand(Node node, GridPosition pos)
    {
        var n = pos.GenMoves(_playBuf);
        // Prune distant empty cells on large non-gravity boards outside a 2-tile Chebyshev neighbourhood.
        if (!_g.Gravity && _g.Total >= 25 && pos.Count >= 2 && n > 9)
        {
            int kept = 0;
            for (int i = 0; i < n; i++)
            {
                int cell = _playBuf[i];
                if (IsNearOccupied(pos, cell, 2))
                {
                    _playBuf[kept++] = cell;
                }
            }
            if (kept > 0) n = kept;
        }
        node.Untried = new int[n];
        Array.Copy(_playBuf, node.Untried, n);
        node.UntriedCount = n;
    }

    private bool IsNearOccupied(GridPosition pos, int cell, int radius)
    {
        int r = cell / _g.Cols;
        int c = cell % _g.Cols;
        int r0 = Math.Max(0, r - radius), r1 = Math.Min(_g.Rows - 1, r + radius);
        int c0 = Math.Max(0, c - radius), c1 = Math.Min(_g.Cols - 1, c + radius);
        for (int rr = r0; rr <= r1; rr++)
        {
            int rowOff = rr * _g.Cols;
            for (int cc = c0; cc <= c1; cc++)
            {
                if (pos.Cells[rowOff + cc] != 0) return true;
            }
        }
        return false;
    }

    private static Node SelectChild(Node parent)
    {
        var logN = Math.Log(parent.Visits + 1);
        var sqrtParent = Math.Sqrt(parent.Visits + 1);
        Node? best = null;
        double bestValue = double.NegativeInfinity;
        foreach (var c in parent.Children)
        {
            double q = c.Wins / (c.Visits + 1e-9);
            if (c.AmafVisits > 0)
            {
                double amafQ = c.AmafWins / c.AmafVisits;
                double beta = Math.Sqrt(RaveEquivalence / (3.0 * parent.Visits + RaveEquivalence));
                q = (1.0 - beta) * q + beta * amafQ;
            }
            double explore = c.Prior > 0.0
                ? Exploration * c.Prior * sqrtParent / (1.0 + c.Visits)
                : Exploration * Math.Sqrt(logN / (c.Visits + 1e-9));
            var v = q + explore;
            if (v > bestValue)
            {
                bestValue = v;
                best = c;
            }
        }
        return best!;
    }

    /// <summary>
    /// Plays the position out and returns the result for player 1: 1 win, 0 loss, 0.5 draw,
    /// or a logistic of the evaluator when the playout is cut off.
    /// </summary>
    private double Playout(GridPosition pos, int stamp)
    {
        int made = 0;
        double outcome;
        var buf = _playBuf;
        while (true)
        {
            if (pos.IsFull) { outcome = 0.5; break; }
            if (made >= PlayoutCap)
            {
                var ev = GridEvaluator.Evaluate(pos, 1);
                outcome = 1.0 / (1.0 + Math.Exp(-ev / 400.0));
                break;
            }
            int me = pos.ToMove, opp = 3 - me;
            int n = pos.GenMoves(buf);
            int chosen = -1, block = -1;
            for (int i = 0; i < n; i++)
            {
                if (pos.MakesLine(buf[i], me)) { chosen = buf[i]; break; }
                if (block < 0 && pos.MakesLine(buf[i], opp)) block = buf[i];
            }
            if (chosen >= 0)
            {
                RecordSeen(chosen, me, stamp);
                pos.Make(chosen);
                made++;
                outcome = me == 1 ? 1.0 : 0.0;
                break;
            }
            if (block >= 0) chosen = block;
            else
            {
                var a = buf[_rng.Next(n)];
                var b = buf[_rng.Next(n)];
                chosen = _g.CenterRank[a] >= _g.CenterRank[b] ? a : b;
            }
            RecordSeen(chosen, me, stamp);
            pos.Make(chosen);
            made++;
        }
        for (int i = 0; i < made; i++) pos.Undo();
        return outcome;
    }
}
