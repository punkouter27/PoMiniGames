using PoMiniGamesClient.Models;

namespace PoMiniGamesClient.Features.TicTacToe;

public class TicTacToeAI
{
    private const int MaxDepth = 3;
    private const int WideBoardDepth = 2;
    private const int MaxSearchNodes = 2_000;
    private const int MaxCandidates = 12;
    private readonly Dictionary<string, int> _transpositionTable = new();
    private int _nodesSearched;

    public (int Row, int Col) GetMove(TicTacToeBoard board, CellValue player, Difficulty difficulty)
    {
        return difficulty switch
        {
            Difficulty.Easy => EasyMove(board, player),
            Difficulty.Medium => MediumMove(board, player),
            Difficulty.Hard => HardMove(board, player),
            _ => MediumMove(board, player)
        };
    }

    /// <summary>
    /// Pick a move whose strength scales with <paramref name="cpuElo"/> — the same
    /// adaptive scheme as ConnectFive's GetAdaptiveMove. The ELO maps to a
    /// (move quality, blunder-rate) rung: low ratings mostly play the win/block
    /// heuristic with frequent random blunders; high ratings run the full minimax
    /// with a small floor of blunders. The floor is deliberate: it keeps the top
    /// rung beatable so a strong player's rating can keep climbing instead of
    /// plateauing against an unbeatable opponent.
    /// </summary>
    public (int Row, int Col) GetAdaptiveMove(TicTacToeBoard board, CellValue player, int cpuElo)
    {
        var (hard, blunder) = StrengthForElo(cpuElo);

        // A "blunder" is a fully random legal move — it may miss its own win or
        // fail to block the player, which is exactly what makes low rungs weak.
        if (blunder > 0 && Random.Shared.NextDouble() < blunder)
        {
            var moves = board.GetAvailableMoves();
            if (moves.Count == 0) return (0, 0);
            return moves[Random.Shared.Next(moves.Count)];
        }

        return hard ? HardMove(board, player) : MediumMove(board, player);
    }

    /// <summary>
    /// Maps a CPU ELO to a strength rung. Seven rungs span roughly 800–2000,
    /// mirroring ConnectFiveAI.StrengthForElo. Unlike ConnectFive the top rung
    /// keeps a 5% blunder rate — near-perfect play would force endless draws
    /// (frozen ELO), so the ceiling stays brutal but beatable.
    /// </summary>
    public static (bool Hard, double Blunder) StrengthForElo(int elo) => elo switch
    {
        < 900 => (false, 0.55),
        < 1050 => (false, 0.35),
        < 1200 => (false, 0.20),
        < 1350 => (true, 0.14),
        < 1500 => (true, 0.10),
        < 1700 => (true, 0.07),
        _ => (true, 0.05),
    };

    private static (int, int) EasyMove(TicTacToeBoard board, CellValue player)
    {
        var opponent = player == CellValue.X ? CellValue.O : CellValue.X;

        // 30% chance to block
        if (Random.Shared.NextDouble() < 0.3)
        {
            var block = FindWinningMove(board, opponent);
            if (block.HasValue) return block.Value;
        }

        var moves = board.GetAvailableMoves();
        return moves[Random.Shared.Next(moves.Count)];
    }

    private static (int, int) MediumMove(TicTacToeBoard board, CellValue player)
    {
        var opponent = player == CellValue.X ? CellValue.O : CellValue.X;

        // 1. Win if possible
        var win = FindWinningMove(board, player);
        if (win.HasValue) return win.Value;

        // 2. Block opponent
        var block = FindWinningMove(board, opponent);
        if (block.HasValue) return block.Value;

        // 3. Center
        var mid = TicTacToeBoard.Size / 2;
        if (board.Get(mid, mid) == CellValue.None) return (mid, mid);

        // 4. Random
        var moves = board.GetAvailableMoves();
        return moves[Random.Shared.Next(moves.Count)];
    }

    private (int, int) HardMove(TicTacToeBoard board, CellValue player)
    {
        var opponent = player == CellValue.X ? CellValue.O : CellValue.X;

        // Instant tactical exits avoid scanning the full 6x6 tree on forced moves.
        var win = FindWinningMove(board, player);
        if (win.HasValue) return win.Value;
        var block = FindWinningMove(board, opponent);
        if (block.HasValue) return block.Value;

        var candidates = GetOrderedCandidates(board);
        if (candidates.Count == 1) return candidates[0];

        _transpositionTable.Clear();
        _nodesSearched = 0;
        var depthLimit = candidates.Count > 8 ? WideBoardDepth : MaxDepth;
        var bestScore = int.MinValue;
        var bestMoves = new List<(int, int)>();

        foreach (var (r, c) in candidates)
        {
            var next = board.Place(r, c, player);
            var score = Minimax(next, depthLimit - 1, int.MinValue, int.MaxValue, false, player, opponent);
            if (score > bestScore)
            {
                bestScore = score;
                bestMoves.Clear();
                bestMoves.Add((r, c));
            }
            else if (score == bestScore)
            {
                bestMoves.Add((r, c));
            }
        }

        return bestMoves[Random.Shared.Next(bestMoves.Count)];
    }

    private int Minimax(TicTacToeBoard board, int depth, int alpha, int beta, bool isMaximizing, CellValue player, CellValue opponent)
    {
        if (board.CheckWin(player).Won) return 1000 + depth;
        if (board.CheckWin(opponent).Won) return -(1000 + depth);
        if (board.IsFull() || depth == 0 || ++_nodesSearched >= MaxSearchNodes) return Heuristic(board, player, opponent);

        var key = BoardKey(board, isMaximizing);
        if (_transpositionTable.TryGetValue(key, out var cached)) return cached;

        var candidates = GetOrderedCandidates(board);
        int best;
        if (isMaximizing)
        {
            best = int.MinValue;
            foreach (var (r, c) in candidates)
            {
                var next = board.Place(r, c, player);
                var score = Minimax(next, depth - 1, alpha, beta, false, player, opponent);
                best = Math.Max(best, score);
                alpha = Math.Max(alpha, best);
                if (beta <= alpha) break;
            }
        }
        else
        {
            best = int.MaxValue;
            foreach (var (r, c) in candidates)
            {
                var next = board.Place(r, c, opponent);
                var score = Minimax(next, depth - 1, alpha, beta, true, player, opponent);
                best = Math.Min(best, score);
                beta = Math.Min(beta, best);
                if (beta <= alpha) break;
            }
        }

        _transpositionTable[key] = best;
        return best;
    }

    /// <summary>
    /// Orders empty cells near existing marks first (or board center when sparse)
    /// so alpha-beta prunes aggressively without blowing the frame budget on 6x6.
    /// </summary>
    private static List<(int Row, int Col)> GetOrderedCandidates(TicTacToeBoard board)
    {
        var near = new List<(int Row, int Col)>();
        var far = new List<(int Row, int Col)>();
        var hasMarks = false;

        for (int r = 0; r < TicTacToeBoard.Size; r++)
        {
            for (int c = 0; c < TicTacToeBoard.Size; c++)
            {
                if (board.Get(r, c) != CellValue.None)
                {
                    hasMarks = true;
                    continue;
                }
                if (HasNeighborMark(board, r, c))
                    near.Add((r, c));
                else
                    far.Add((r, c));
            }
        }

        var result = hasMarks && near.Count > 0 ? near : far;
        // Center-first ordering maximizes early cutoffs.
        result.Sort(static (a, b) =>
        {
            var da = Math.Abs(a.Row * 2 - (TicTacToeBoard.Size - 1)) + Math.Abs(a.Col * 2 - (TicTacToeBoard.Size - 1));
            var db = Math.Abs(b.Row * 2 - (TicTacToeBoard.Size - 1)) + Math.Abs(b.Col * 2 - (TicTacToeBoard.Size - 1));
            return da.CompareTo(db);
        });
        if (result.Count > MaxCandidates) result.RemoveRange(MaxCandidates, result.Count - MaxCandidates);
        return result;
    }

    private static bool HasNeighborMark(TicTacToeBoard board, int row, int col)
    {
        var r0 = Math.Max(0, row - 1);
        var r1 = Math.Min(TicTacToeBoard.Size - 1, row + 1);
        var c0 = Math.Max(0, col - 1);
        var c1 = Math.Min(TicTacToeBoard.Size - 1, col + 1);
        for (int r = r0; r <= r1; r++)
        {
            for (int c = c0; c <= c1; c++)
            {
                if (board.Get(r, c) != CellValue.None) return true;
            }
        }
        return false;
    }

    private static int Heuristic(TicTacToeBoard board, CellValue player, CellValue opponent)
    {
        int score = 0;
        var directions = new[] { (0, 1), (1, 0), (1, 1), (1, -1) };

        for (int r = 0; r < TicTacToeBoard.Size; r++)
        {
            for (int c = 0; c < TicTacToeBoard.Size; c++)
            {
                foreach (var (dr, dc) in directions)
                {
                    int mine = 0, theirs = 0;
                    bool valid = true;
                    for (int i = 0; i < TicTacToeBoard.WinLength; i++)
                    {
                        var nr = r + dr * i;
                        var nc = c + dc * i;
                        if (nr < 0 || nr >= TicTacToeBoard.Size || nc < 0 || nc >= TicTacToeBoard.Size)
                        {
                            valid = false;
                            break;
                        }
                        var cell = board.Get(nr, nc);
                        if (cell == player) mine++;
                        else if (cell == opponent) theirs++;
                    }
                    if (!valid) continue;
                    if (theirs == 0 && mine > 0) score += mine * mine;
                    if (mine == 0 && theirs > 0) score -= theirs * theirs;
                }
            }
        }
        return score;
    }

    private static string BoardKey(TicTacToeBoard board, bool isMax)
    {
        return string.Create(1 + TicTacToeBoard.Size * TicTacToeBoard.Size, (board, isMax), static (span, state) =>
        {
            span[0] = state.isMax ? '1' : '0';
            var idx = 1;
            for (int r = 0; r < TicTacToeBoard.Size; r++)
            {
                for (int c = 0; c < TicTacToeBoard.Size; c++)
                {
                    span[idx++] = (char)('0' + (int)state.board.Get(r, c));
                }
            }
        });
    }

    private static (int, int)? FindWinningMove(TicTacToeBoard board, CellValue player)
    {
        foreach (var (r, c) in board.GetAvailableMoves())
        {
            var next = board.Place(r, c, player);
            if (next.CheckWin(player).Won) return (r, c);
        }
        return null;
    }
}
