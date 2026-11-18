using PoMiniGamesClient.Features.BoardAi;
using PoMiniGamesClient.Models;

namespace PoMiniGamesClient.Features.TicTacToe;

/// <summary>
/// 6x6 four-in-a-row CPU. All the strength lives in the shared <see cref="GridAiEngine"/>;
/// this class maps difficulty / Elo to a rung and converts the board.
///
/// Beatability: the top rung is deliberately not a perfect player. Near-perfect play would
/// force endless draws and freeze the player's rating, so instead of a random "blunder" the
/// top rung keeps a small softmax temperature: it almost always plays the best move but
/// sometimes picks a close second, which is a plausible slip rather than nonsense.
/// </summary>
public class TicTacToeAI
{
    public static readonly GridGeometry Geometry =
        new(TicTacToeBoard.Size, TicTacToeBoard.Size, TicTacToeBoard.WinLength, gravity: false, seed: 0x71C7AC7);

    private readonly GridAiEngine _engine;

    public TicTacToeAI(Random? rng = null)
    {
        _engine = new GridAiEngine(Geometry, rng, TicTacToeOpeningBook.Lookup, ttSizeLog2: 15);
    }

    /// <summary>
    /// Forces Monte Carlo tree search on every rung. Off by default: in a 150 ms self-play
    /// check negamax (iterative deepening, transposition table, threat search) beat MCTS
    /// 27-13 on this board, so the rungs use negamax and MCTS is only an opt-in style.
    /// </summary>
    public bool UseMcts { get; set; }

    public (int Row, int Col) GetMove(TicTacToeBoard board, CellValue player, Difficulty difficulty) =>
        GetMove(board, player, RungForDifficulty(difficulty));

    /// <summary>
    /// Pick a move whose strength scales with <paramref name="cpuElo"/>, the same adaptive
    /// scheme as ConnectFive. Low ratings think for a few milliseconds and sample among their
    /// better-looking moves (plausible mistakes); high ratings think longer and search deeper,
    /// keeping a small temperature so the top rung stays beatable.
    /// </summary>
    public (int Row, int Col) GetAdaptiveMove(TicTacToeBoard board, CellValue player, int cpuElo) =>
        GetMove(board, player, StrengthForElo(cpuElo));

    /// <summary>Plays on an explicit rung (self-play and tests use tiny budgets).</summary>
    public (int Row, int Col) GetMove(TicTacToeBoard board, CellValue player, AiRung rung)
    {
        if (UseMcts) rung = rung with { UseMcts = true };
        var pos = ToPosition(board, player);
        var cell = _engine.Choose(pos, rung);
        if (cell < 0) return (0, 0);
        return (cell / TicTacToeBoard.Size, cell % TicTacToeBoard.Size);
    }

    /// <summary>
    /// Maps a CPU Elo to a strength rung (roughly 800-2000). The top rung keeps a small
    /// temperature on purpose, see the class remarks.
    /// </summary>
    public static AiRung StrengthForElo(int elo) => elo switch
    {
        < 900 => new AiRung(3, 2, 500, 1500, 6, 0, 0, 0.35),
        < 1050 => new AiRung(5, 3, 350, 2500, 5, 0, 0, 0.55),
        < 1200 => new AiRung(10, 4, 250, 4000, 4, 0, 0, 0.75),
        < 1350 => new AiRung(25, 6, 170, 6000, 4, 3, 2, 0.90),
        < 1500 => new AiRung(40, 8, 120, 8000, 3, 4, 3, 0.95),
        < 1700 => new AiRung(90, 10, 80, 10000, 3, 5, 3, 0.98),
        _ => new AiRung(150, 14, 55, 12000, 3, 6, 3, 1.0),
    };

    public static AiRung RungForDifficulty(Difficulty difficulty) => difficulty switch
    {
        Difficulty.Easy => new AiRung(5, 3, 350, 2500, 5, 0, 0, 0.4),
        Difficulty.Hard => new AiRung(150, 14, 55, 12000, 3, 6, 3, 1.0),
        _ => new AiRung(40, 8, 120, 8000, 3, 4, 3, 0.95),
    };

    public static GridPosition ToPosition(TicTacToeBoard board, CellValue player)
    {
        var cells = new byte[TicTacToeBoard.Size * TicTacToeBoard.Size];
        for (int r = 0; r < TicTacToeBoard.Size; r++)
        {
            for (int c = 0; c < TicTacToeBoard.Size; c++)
            {
                cells[r * TicTacToeBoard.Size + c] = (byte)board.Get(r, c);
            }
        }
        return GridPosition.FromCells(Geometry, cells, (int)player);
    }
}

/// <summary>
/// Opening book for the 6x6 board: the four centre squares are equally strong first moves
/// for both sides, so the CPU takes whichever are free for the first few marks and varies
/// between them.
/// </summary>
internal static class TicTacToeOpeningBook
{
    public static int[] Lookup(GridPosition pos)
    {
        var g = pos.Geometry;
        var free = new List<int>(4);
        for (int i = 0; i < g.Total; i++)
        {
            int r = i / g.Cols, c = i % g.Cols;
            if (pos.Cells[i] == 0 && Math.Abs(2 * r - (g.Rows - 1)) <= 1 && Math.Abs(2 * c - (g.Cols - 1)) <= 1) free.Add(i);
        }
        return [.. free];
    }
}
