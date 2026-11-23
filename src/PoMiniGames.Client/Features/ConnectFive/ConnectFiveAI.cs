using PoMiniGamesClient.Features.BoardAi;
using PoMiniGamesClient.Models;

namespace PoMiniGamesClient.Features.ConnectFive;

/// <summary>
/// Connect Five CPU. All the strength lives in the shared <see cref="GridAiEngine"/>
/// (iterative-deepening negamax with a Zobrist transposition table, threat-space search for
/// forced wins and forced defence, pattern evaluation with gravity-aware threats, an opening
/// book and softmax "human" mistakes). This class only maps difficulty / Elo to a rung and
/// converts the board.
/// </summary>
public class ConnectFiveAI
{
    public static readonly GridGeometry Geometry =
        new(ConnectFiveBoard.Rows, ConnectFiveBoard.Cols, ConnectFiveBoard.WinLength, gravity: true, seed: 0xC0FFEE5);

    private readonly GridAiEngine _engine;

    public ConnectFiveAI(Random? rng = null)
    {
        _engine = new GridAiEngine(Geometry, rng, ConnectFiveOpeningBook.Lookup, ttSizeLog2: 16);
    }

    /// <summary>
    /// Forces Monte Carlo tree search on every rung. Off by default: the rungs choose their own
    /// engine. In a 150 ms self-play check MCTS beat negamax 19-3 (2 draws) on this gravity
    /// board, so the 90 ms and top rungs and Hard use it; at 40 ms negamax was level (14-10),
    /// so the lower rungs keep negamax, whose exact scores also suit softmax mistakes.
    /// </summary>
    public bool UseMcts { get; set; }

    public (int Row, int Col) GetMove(ConnectFiveBoard board, Player player, Difficulty difficulty) =>
        GetMove(board, player, RungForDifficulty(difficulty));

    /// <summary>
    /// Pick a move whose strength scales with <paramref name="cpuElo"/>. The Elo maps to a
    /// rung (think time, depth, mistake temperature): a low rating plays shallow and samples
    /// among its better-looking moves, so it makes plausible mistakes; as the rating climbs
    /// it thinks longer, never misses a win or a block, and the top rung plays the best move.
    /// </summary>
    public (int Row, int Col) GetAdaptiveMove(ConnectFiveBoard board, Player player, int cpuElo) =>
        GetMove(board, player, StrengthForElo(cpuElo));

    /// <summary>
    /// <see cref="GetAdaptiveMove"/> without freezing the page: the search runs in short slices
    /// and <paramref name="yieldAsync"/> (a short Task.Delay in the page) lets the browser paint
    /// between them, so drop animations and the 3D board keep moving while the CPU thinks.
    /// </summary>
    public Task<(int Row, int Col)> GetAdaptiveMoveAsync(ConnectFiveBoard board, Player player, int cpuElo,
        Func<Task> yieldAsync, CancellationToken ct = default) =>
        GetMoveAsync(board, player, StrengthForElo(cpuElo), yieldAsync, ct);

    /// <summary>The demo's fixed-difficulty move, sliced like <see cref="GetAdaptiveMoveAsync"/>.</summary>
    public Task<(int Row, int Col)> GetMoveAsync(ConnectFiveBoard board, Player player, Difficulty difficulty,
        Func<Task> yieldAsync, CancellationToken ct = default) =>
        GetMoveAsync(board, player, RungForDifficulty(difficulty), yieldAsync, ct);

    /// <summary>Longest stretch the search holds the thread before it yields (ms).</summary>
    public const int SliceMs = 8;

    public async Task<(int Row, int Col)> GetMoveAsync(ConnectFiveBoard board, Player player, AiRung rung,
        Func<Task> yieldAsync, CancellationToken ct = default)
    {
        if (UseMcts) rung = rung with { UseMcts = true };
        var pos = ToPosition(board, player);
        var cell = await _engine.ChooseAsync(pos, rung, SliceMs, yieldAsync, ct);
        if (cell < 0) return (0, 0);
        return (cell / ConnectFiveBoard.Cols, cell % ConnectFiveBoard.Cols);
    }

    /// <summary>Plays on an explicit rung (self-play and tests use tiny budgets).</summary>
    public (int Row, int Col) GetMove(ConnectFiveBoard board, Player player, AiRung rung)
    {
        if (UseMcts) rung = rung with { UseMcts = true };
        var pos = ToPosition(board, player);
        var cell = _engine.Choose(pos, rung);
        if (cell < 0) return (0, 0);
        return (cell / ConnectFiveBoard.Cols, cell % ConnectFiveBoard.Cols);
    }

    /// <summary>
    /// Maps a CPU Elo to a strength rung. Seven rungs span roughly 800-2000. The budgets
    /// climb from a few milliseconds to 150 ms (the Hard rung); the temperature falls to 0 at
    /// the top, where the CPU always plays its best move. The top two rungs use MCTS.
    /// </summary>
    public static AiRung StrengthForElo(int elo) => elo switch
    {
        < 900 => new AiRung(3, 2, 450, 1500, 6, 0, 0, 0.35),
        < 1050 => new AiRung(5, 3, 300, 2500, 5, 0, 0, 0.55),
        < 1200 => new AiRung(10, 4, 200, 4000, 4, 0, 0, 0.75),
        < 1350 => new AiRung(20, 5, 120, 8000, 4, 3, 2, 0.90),
        < 1500 => new AiRung(40, 7, 60, 20000, 3, 5, 3, 0.97),
        < 1700 => new AiRung(90, 10, 60, 50000, 2, 7, 4, 1.0, UseMcts: true),
        _ => new AiRung(150, 14, 0, 100000, 1, 9, 4, 1.0, UseMcts: true),
    };

    public static AiRung RungForDifficulty(Difficulty difficulty) => difficulty switch
    {
        Difficulty.Easy => new AiRung(5, 3, 300, 2500, 5, 0, 0, 0.4),
        Difficulty.Hard => new AiRung(150, 14, 0, 100000, 1, 8, 4, 1.0, UseMcts: true),
        _ => new AiRung(40, 7, 50, 20000, 3, 5, 3, 0.97),
    };

    public static GridPosition ToPosition(ConnectFiveBoard board, Player player)
    {
        var cells = new byte[ConnectFiveBoard.Rows * ConnectFiveBoard.Cols];
        for (int r = 0; r < ConnectFiveBoard.Rows; r++)
        {
            for (int c = 0; c < ConnectFiveBoard.Cols; c++)
            {
                cells[r * ConnectFiveBoard.Cols + c] = (byte)board.Get(r, c);
            }
        }
        return GridPosition.FromCells(Geometry, cells, (int)player.Color);
    }
}

/// <summary>
/// A small static book of strong early drops for the 9-wide board, keyed by the exact
/// position (column sequences simulated at startup) and matched through left-right mirroring.
/// Equal options are listed together so the CPU varies its openings.
/// </summary>
internal static class ConnectFiveOpeningBook
{
    private static readonly Lazy<Dictionary<ulong, int[]>> Table = new(Build);

    public static int[] Lookup(GridPosition pos)
    {
        var table = Table.Value;
        if (table.TryGetValue(pos.Hash, out var direct)) return direct;
        if (table.TryGetValue(pos.MirrorHash(), out var mirrored))
        {
            var g = pos.Geometry;
            var result = new int[mirrored.Length];
            for (int i = 0; i < mirrored.Length; i++) result[i] = g.MirrorCell[mirrored[i]];
            return result;
        }
        return [];
    }

    private static Dictionary<ulong, int[]> Build()
    {
        var table = new Dictionary<ulong, int[]>();
        Add(table, [], 4);
        Add(table, [4], 4, 3, 5);
        Add(table, [3], 4);
        Add(table, [2], 4);
        Add(table, [4, 4], 3, 5);
        Add(table, [4, 3], 4, 5);
        Add(table, [3, 4], 4, 2);
        Add(table, [4, 4, 3], 4, 2);
        Add(table, [4, 3, 4], 3, 5);
        return table;
    }

    private static void Add(Dictionary<ulong, int[]> table, int[] columns, params int[] replies)
    {
        var pos = new GridPosition(ConnectFiveAI.Geometry);
        foreach (var col in columns) pos.Make(pos.Tops[col] * ConnectFiveAI.Geometry.Cols + col);
        var cells = new int[replies.Length];
        for (int i = 0; i < replies.Length; i++) cells[i] = pos.Tops[replies[i]] * ConnectFiveAI.Geometry.Cols + replies[i];
        table[pos.Hash] = cells;
    }
}
