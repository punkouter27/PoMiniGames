using FluentAssertions;
using System.Diagnostics;
using PoMiniGamesClient.Features.BoardAi;
using PoMiniGamesClient.Features.ConnectFive;
using PoMiniGamesClient.Features.TicTacToe;
using PoMiniGamesClient.Models;

namespace PoMiniGames.Unit.Features.BoardAi;

/// <summary>
/// The shared grid engine behind the Connect Five and TicTacToe CPUs: threat-space search,
/// iterative deepening under a budget, opening book, softmax mistakes and a small seeded
/// strength check. Budgets are tiny so the scenarios stay fast.
/// </summary>
public sealed class BoardAiTests
{
    private static readonly AiRung Top = new(25, 14, 0, 100_000, 1, 6, 0, 1.0);
    private static readonly AiRung Weak = new(2, 2, 500, 1_500, 6, 0, 0, 0.3);

    [Theory]
    [InlineData(nameof(ConnectFive_VcfFindsTheForcedWin))]
    [InlineData(nameof(ConnectFive_DefendsAgainstTheOpponentsForcedWin))]
    [InlineData(nameof(IterativeDeepening_RespectsTheBudgetAndDeepensWithMoreTime))]
    [InlineData(nameof(OpeningBook_IsUsedOnAnEmptyBoard))]
    [InlineData(nameof(Softmax_NeverPicksAnIllegalMove))]
    [InlineData(nameof(Mcts_TakesAnImmediateWinInBothGames))]
    [InlineData(nameof(HardBeatsEasy_OverASmallSeededSample))]
    [InlineData(nameof(SlicedSearch_FindsTheForcedWinAndYieldsBetweenSlices))]
    [InlineData(nameof(SlicedMcts_TakesAnImmediateWinAndYields))]
    [InlineData(nameof(SlicedSearch_StopsWhenCancelled))]
    public Task Scenario(string name) => Scenarios.RunAsync(this, name);

    private static ConnectFiveBoard Drop(ConnectFiveBoard board, Player player, params int[] cols)
    {
        foreach (var col in cols) board = board.Place(board.GetTargetRow(col), col, player);
        return board;
    }

    private static void ConnectFive_VcfFindsTheForcedWin()
    {
        // Red holds bottom cols 3-5 with cols 2 and 6 open: one drop makes a four with two live ends.
        var board = Drop(Drop(new ConnectFiveBoard(), Player.Red, 3, 4, 5), Player.Yellow, 3, 4, 5);
        var pos = ConnectFiveAI.ToPosition(board, Player.Red);

        var found = new GridThreatSearch(ConnectFiveAI.Geometry).FindWin(pos, 4, 5_000);
        found.Should().BeGreaterThanOrEqualTo(0);
        (found % ConnectFiveBoard.Cols).Should().BeOneOf(2, 6);

        var (_, col) = new ConnectFiveAI(new Random(1)).GetMove(board, Player.Red, Top);
        col.Should().BeOneOf(2, 6);
    }

    private static void ConnectFive_DefendsAgainstTheOpponentsForcedWin()
    {
        // Red threatens 5 then 1 or 6; only dropping on col 1 or 5 stops every forced win.
        var board = Drop(Drop(new ConnectFiveBoard(), Player.Red, 2, 3, 4), Player.Yellow, 2, 3);
        var pos = ConnectFiveAI.ToPosition(board, Player.Yellow);
        new GridThreatSearch(ConnectFiveAI.Geometry).OpponentHasForcedWin(pos, 4, 5_000).Should().BeTrue();

        for (int seed = 0; seed < 3; seed++)
        {
            var (_, col) = new ConnectFiveAI(new Random(seed)).GetMove(board, Player.Yellow, Top);
            col.Should().BeOneOf(1, 5);
        }
    }

    private static void IterativeDeepening_RespectsTheBudgetAndDeepensWithMoreTime()
    {
        var board = Drop(Drop(new ConnectFiveBoard(), Player.Red, 4, 3, 4, 2), Player.Yellow, 4, 5, 3, 4);
        var pos = ConnectFiveAI.ToPosition(board, Player.Red);
        var search = new GridSearch(ConnectFiveAI.Geometry, 14);

        var clock = Stopwatch.StartNew();
        var quick = search.Run(pos, 20, 30, wantScores: false);
        clock.Stop();
        clock.ElapsedMilliseconds.Should().BeLessThan(400, "the budget is 20 ms; the rest is scheduling slack");
        quick.Depth.Should().BeGreaterThanOrEqualTo(1);
        pos.Cells.Count(c => c != 0).Should().Be(8, "the search must undo every move");

        var slow = new GridSearch(ConnectFiveAI.Geometry, 14).Run(pos, 250, 30, wantScores: false);
        slow.Depth.Should().BeGreaterThanOrEqualTo(quick.Depth);
        slow.Moves.Should().Contain(slow.Move);
        new TranspositionTable(10).Capacity.Should().Be(1024);
    }

    private static void OpeningBook_IsUsedOnAnEmptyBoard()
    {
        var medium = new AiRung(5, 4, 0, 1_000, 1, 0, 3, 1.0);
        var (row, col) = new ConnectFiveAI(new Random(3)).GetMove(new ConnectFiveBoard(), Player.Red, medium);
        (row, col).Should().Be((ConnectFiveBoard.Rows - 1, ConnectFiveBoard.Cols / 2));

        var seen = new HashSet<(int, int)>();
        for (int seed = 0; seed < 12; seed++)
        {
            seen.Add(new TicTacToeAI(new Random(seed)).GetMove(new TicTacToeBoard(), CellValue.X, medium));
        }
        seen.All(m => (m.Item1 == 2 || m.Item1 == 3) && (m.Item2 == 2 || m.Item2 == 3)).Should().BeTrue();
        seen.Count.Should().BeGreaterThan(1, "equal book moves are varied");
    }

    private static void Softmax_NeverPicksAnIllegalMove()
    {
        var rng = new Random(7);
        var moves = new[] { 10, 20, 30, 40 };
        for (int i = 0; i < 300; i++)
        {
            var scores = new[] { rng.Next(-5000, 5000), rng.Next(-5000, 5000), 100_000, -100_000 };
            GridSoftmax.Pick(moves, scores, 3, 300, 2000, rng).Should().BeOneOf(moves);
        }
        GridSoftmax.Pick(moves, [1, 9, 3, 2], 4, 0, 2000, rng).Should().Be(20, "temperature 0 plays the best move");

        // Weak CPUs on live boards: every reply must be a legal drop / empty cell.
        var cf = new ConnectFiveAI(new Random(11));
        var board = new ConnectFiveBoard();
        var player = Player.Red;
        for (int ply = 0; ply < 40 && !board.IsFull(); ply++)
        {
            var (r, c) = cf.GetMove(board, player, Weak);
            board.IsColumnFull(c).Should().BeFalse();
            r.Should().Be(board.GetTargetRow(c));
            board = board.Place(r, c, player);
            if (board.CheckWin(player).Won) break;
            player = player.Other;
        }

        var ttt = new TicTacToeAI(new Random(12));
        var grid = new TicTacToeBoard();
        var mark = CellValue.X;
        for (int ply = 0; ply < 30 && !grid.IsFull(); ply++)
        {
            var (r, c) = ttt.GetMove(grid, mark, Weak);
            grid.Get(r, c).Should().Be(CellValue.None);
            grid = grid.Place(r, c, mark);
            if (grid.CheckWin(mark).Won) break;
            mark = mark == CellValue.X ? CellValue.O : CellValue.X;
        }
    }

    private static void Mcts_TakesAnImmediateWinInBothGames()
    {
        var mcts = Top with { UseMcts = true, BudgetMs = 20 };

        var board = Drop(Drop(new ConnectFiveBoard(), Player.Red, 0, 1, 2, 3), Player.Yellow, 0, 1, 2);
        var cf = new ConnectFiveAI(new Random(2)) { UseMcts = true };
        cf.GetMove(board, Player.Red, mcts).Col.Should().Be(4);

        var grid = new TicTacToeBoard();
        foreach (var (r, c) in new[] { (2, 1), (2, 2), (2, 3) }) grid = grid.Place(r, c, CellValue.X);
        grid = grid.Place(5, 5, CellValue.O).Place(5, 4, CellValue.O).Place(0, 0, CellValue.O);
        var move = new TicTacToeAI(new Random(2)).GetMove(grid, CellValue.X, mcts);
        move.Should().BeOneOf((2, 0), (2, 4));
    }

    private static void HardBeatsEasy_OverASmallSeededSample()
    {
        var hard = new AiRung(15, 14, 0, 100_000, 1, 6, 0, 1.0);
        var easy = new AiRung(2, 2, 450, 1_500, 6, 0, 0, 0.2);
        int hardWins = 0, easyWins = 0;

        for (int game = 0; game < 4; game++)
        {
            var ai = new ConnectFiveAI(new Random(100 + game));
            var hardIsRed = game % 2 == 0;
            var board = new ConnectFiveBoard();
            var player = Player.Red;
            while (!board.IsFull())
            {
                var hardTurn = (player == Player.Red) == hardIsRed;
                var (r, c) = ai.GetMove(board, player, hardTurn ? hard : easy);
                board = board.Place(r, c, player);
                if (board.CheckWin(player).Won)
                {
                    if (hardTurn) hardWins++;
                    else easyWins++;
                    break;
                }
                player = player.Other;
            }
        }

        hardWins.Should().BeGreaterThanOrEqualTo(3);
        easyWins.Should().BeLessThan(hardWins);
    }

    private static async Task SlicedSearch_FindsTheForcedWinAndYieldsBetweenSlices()
    {
        // The same forced win as the VCF scenario, through the sliced path with the VCF off so
        // the negamax itself has to find it over several slices.
        var board = Drop(Drop(new ConnectFiveBoard(), Player.Red, 3, 4, 5), Player.Yellow, 3, 4, 5);
        var rung = new AiRung(60, 14, 0, 100_000, 1, 0, 0, 0);
        var yields = 0;
        var (_, col) = await new ConnectFiveAI(new Random(1)).GetMoveAsync(board, Player.Red, rung,
            () => { yields++; return Task.CompletedTask; });
        col.Should().BeOneOf(2, 6);
        yields.Should().BeGreaterThan(0, "a 60 ms think in 8 ms slices hands the thread back between them");
    }

    private static async Task SlicedMcts_TakesAnImmediateWinAndYields()
    {
        var board = Drop(Drop(new ConnectFiveBoard(), Player.Red, 2, 3, 4, 5), Player.Yellow, 2, 3, 4);
        var rung = new AiRung(40, 14, 0, 100_000, 1, 0, 0, 0, UseMcts: true);
        var yields = 0;
        var (_, col) = await new ConnectFiveAI(new Random(2)).GetMoveAsync(board, Player.Red, rung,
            () => { yields++; return Task.CompletedTask; });
        col.Should().BeOneOf(1, 6);
        yields.Should().BeGreaterThan(0);
    }

    private static async Task SlicedSearch_StopsWhenCancelled()
    {
        var board = Drop(Drop(new ConnectFiveBoard(), Player.Red, 4), Player.Yellow, 3);
        var rung = new AiRung(5_000, 30, 0, 100_000, 1, 0, 0, 0);
        using var cts = new CancellationTokenSource();
        var watch = Stopwatch.StartNew();
        var think = new ConnectFiveAI(new Random(3)).GetMoveAsync(board, Player.Red, rung, async () =>
        {
            if (watch.ElapsedMilliseconds > 30) await cts.CancelAsync();
        }, cts.Token);
        await think.Invoking(t => t).Should().ThrowAsync<OperationCanceledException>();
        watch.ElapsedMilliseconds.Should().BeLessThan(2_000, "the cancel lands at the next slice, not at the 5 s budget");
    }
}
