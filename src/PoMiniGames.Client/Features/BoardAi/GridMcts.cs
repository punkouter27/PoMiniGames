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
/// Monte Carlo tree search with UCT selection and heuristic-guided playouts, run under a
/// wall-clock budget. Playouts take an immediate win, else block an immediate loss, else
/// play a centre-biased random move; long playouts are cut off and judged by the pattern
/// evaluator so every rollout returns a result in (0, 1).
/// </summary>
public sealed class GridMcts
{
    private const double Exploration = 1.2;
    private const int PlayoutCap = 48;

    private sealed class Node(int move, int mover, Node? parent)
    {
        public readonly int Move = move;
        public readonly int Mover = mover;
        public readonly Node? Parent = parent;
        public readonly List<Node> Children = [];
        public int[]? Untried;
        public int UntriedCount;
        public int Visits;
        public double Wins;
        public bool Terminal;
    }

    private readonly GridGeometry _g;
    private readonly Random _rng;
    private readonly int[] _playBuf;

    public GridMcts(GridGeometry geometry, Random rng)
    {
        _g = geometry;
        _rng = rng;
        _playBuf = new int[geometry.Total];
    }

    public MctsResult Run(GridPosition pos, int budgetMs, int maxIterations = int.MaxValue)
    {
        var deadline = Stopwatch.GetTimestamp() + budgetMs * Stopwatch.Frequency / 1000;
        var root = new Node(-1, 3 - pos.ToMove, null);
        Expand(root, pos);
        if (root.UntriedCount == 0) return new MctsResult();

        int iterations = 0;
        while (iterations < maxIterations && (iterations < 32 || Stopwatch.GetTimestamp() < deadline))
        {
            iterations++;
            var node = root;
            int made = 0;
            // Selection.
            while (!node.Terminal && node.UntriedCount == 0 && node.Children.Count > 0)
            {
                node = SelectChild(node);
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
                    made++;
                    var child = new Node(move, mover, node) { Terminal = won };
                    node.Children.Add(child);
                    node = child;
                    if (!won) Expand(node, pos);
                }
                value = node.Terminal ? (node.Mover == 1 ? 1.0 : 0.0) : Playout(pos);
            }

            // Backpropagation: 1 for a win of the node's mover, 0.5 for a draw/unknown.
            for (var n = node; n is not null; n = n.Parent)
            {
                n.Visits++;
                n.Wins += n.Mover == 1 ? value : 1.0 - value;
            }
            for (int i = 0; i < made; i++) pos.Undo();
        }

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
        node.Untried = new int[n];
        Array.Copy(_playBuf, node.Untried, n);
        node.UntriedCount = n;
    }

    private static Node SelectChild(Node parent)
    {
        var logN = Math.Log(parent.Visits + 1);
        Node? best = null;
        double bestValue = double.NegativeInfinity;
        foreach (var c in parent.Children)
        {
            var v = c.Wins / (c.Visits + 1e-9) + Exploration * Math.Sqrt(logN / (c.Visits + 1e-9));
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
    private double Playout(GridPosition pos)
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
            pos.Make(chosen);
            made++;
        }
        for (int i = 0; i < made; i++) pos.Undo();
        return outcome;
    }
}
