using FluentAssertions;
using PoMiniGames.Features.PoCoupleQuiz;

namespace PoMiniGames.Unit.Features.PoCoupleQuiz;

/// <summary>
/// Unit tests for the in-memory game session manager — the authoritative
/// state holder for the one live PoCoupleQuiz match (state does NOT survive restarts).
/// </summary>
/// <remarks>
/// <para>The scenarios share one <c>[Theory]</c> to stay inside the test-count cap.
/// Pairing is the lobby's job: the manager reserves a match for the lobby's seat names
/// (<c>Reserve</c>) and seats whoever claims one (<c>JoinMatch</c>).</para>
/// <para>The scoreboard test asserts the King is INCLUDED. See
/// <see cref="Game.CurrentKingPlayerIndex"/> for why excluding the King is wrong.</para>
/// </remarks>
public sealed class GameSessionManagerTests
{
    /// <summary>A match with the given seat names, all claimed in order (host first) as conn1, conn2, …</summary>
    private static GameSessionManager MatchOf(params string[] names) => MatchOf(Game.DefaultRounds, names);

    private static GameSessionManager MatchOf(int rounds, params string[] names)
    {
        var mgr = new GameSessionManager();
        var code = mgr.Reserve(names, rounds, "Classic")!;
        for (var i = 0; i < names.Length; i++)
        {
            mgr.JoinMatch($"conn{i + 1}", code, names[i]);
        }
        return mgr;
    }

    // ─── Match membership ───────────────────────────────────────────────

    /// <summary>
    /// Each row runs one scenario: a private method below, named after what it checks.
    /// </summary>
    [Theory]
    [InlineData(nameof(Reserve_OpensOneMatch_SeatsOnlyReservedNames_AndNormalisesSettings))]
    [InlineData(nameof(RemovePlayer_PrunesTheLiveRoster_AndClosesTheMatchWhenTheLastPlayerLeaves))]
    [InlineData(nameof(GameLifecycle_StartAndAdvanceRound_IncrementsRoundAndRotatesKing))]
    [InlineData(nameof(RoundCompletion_RoutesTheKingToTheSecret_WaitsForGuesses_AndAppliesScores))]
    [InlineData(nameof(Reserve_IsRefusedWhileAMatchIsLive_AndReopensOnceItFinished))]
    [InlineData(nameof(Game_ScoreboardIncludesEveryPlayer))]
    public Task Scenario(string name) => Scenarios.RunAsync(this, name);

    private static void Reserve_OpensOneMatch_SeatsOnlyReservedNames_AndNormalisesSettings()
    {
        var mgr = new GameSessionManager();

        var code = mgr.Reserve(["Alice", "Bob"], 7, "datesandtrips")!;
        code.Should().NotBeNullOrEmpty();
        var session = mgr.Current!;
        session.State.Should().Be(SessionState.Waiting);
        session.MaxRounds.Should().Be(7);
        session.TopicPack.Should().Be("DatesAndTrips");

        // One match at a time: a second reservation is refused while this one is fresh.
        mgr.Reserve(["Carla", "Dan"], 5, "Everything").Should().BeNull();

        // A stale code, a name nobody reserved, and a taken seat are refused.
        mgr.JoinMatch("conn1", "match-nope", "Alice").Should().BeNull();
        mgr.JoinMatch("conn3", code, "Carla").Should().BeNull();

        // The guest can claim first; seat order is still the lobby's (host first, King of round 0).
        var guest = mgr.JoinMatch("conn2", code, "Bob")!.Value;
        guest.AllSeated.Should().BeFalse();
        var host = mgr.JoinMatch("conn1", code, "Alice")!.Value;
        host.AllSeated.Should().BeTrue();
        host.Session.Should().BeSameAs(session);
        session.Players.Select(p => p.Name).Should().Equal("Alice", "Bob");
        mgr.JoinMatch("conn9", code, "Alice").Should().BeNull("the seat is taken");

        // A value off the menu falls back to the defaults rather than failing the start.
        var other = new GameSessionManager();
        other.Reserve(["Alice", "Bob"], 4, "NotARealPack");
        other.Current!.MaxRounds.Should().Be(Game.DefaultRounds);
        other.Current.TopicPack.Should().Be("Everything");
    }

    [Theory]
    [InlineData("conn2", "Alice")] // one seat leaves, the other stays
    [InlineData("conn1", "Bob")]
    public void RemovePlayer_KeepsTheMatchForTheRemainingSeat(string leaverConn, string remaining)
    {
        var mgr = MatchOf("Alice", "Bob");

        mgr.RemovePlayer(leaverConn, out var sessionEmpty);

        sessionEmpty.Should().BeFalse();
        mgr.Current!.Players.Select(p => p.Name).Should().Equal(remaining);
    }

    private static void RemovePlayer_PrunesTheLiveRoster_AndClosesTheMatchWhenTheLastPlayerLeaves()
    {
        var mgr = MatchOf("Alice", "Bob", "Carla");
        var game = mgr.StartGame("Q?", "Hobbies");

        // A leaver must also leave the Game's roster, or AllPlayersAnswered waits forever on
        // a name nobody will submit and the rotating King seat can land on an empty chair.
        mgr.RemovePlayer("conn2", out var empty);
        empty.Should().BeFalse();
        game.Players.Select(p => p.Name).Should().Equal("Alice", "Carla");

        mgr.RemovePlayer("conn1", out _);
        mgr.RemovePlayer("conn3", out var nowEmpty);
        nowEmpty.Should().BeTrue();
        mgr.Current.Should().BeNull();
    }

    // ─── Game lifecycle ─────────────────────────────────────────────────

    private static void GameLifecycle_StartAndAdvanceRound_IncrementsRoundAndRotatesKing()
    {
        var empty = new GameSessionManager();
        var act = () => empty.StartGame("Q?", "Hobbies");
        act.Should().Throw<InvalidOperationException>();

        var mgr = MatchOf(7, "Alice", "Bob");

        var game = mgr.StartGame("What is Alice's favorite color?", "Preferences");

        game.MaxRounds.Should().Be(7);
        game.Players.Should().HaveCount(2);
        game.KingPlayer!.Name.Should().Be("Alice", "round 0 puts the first player in the King seat");
        mgr.Current!.State.Should().Be(SessionState.InProgress);

        var next = mgr.AdvanceRound();

        next.CurrentRound.Should().Be(1);
        next.KingPlayer!.Name.Should().Be("Bob", "the King seat moves round the table every round");
    }

    private static void RoundCompletion_RoutesTheKingToTheSecret_WaitsForGuesses_AndAppliesScores()
    {
        var mgr = MatchOf("Alice", "Bob", "Carla"); // Alice is King for round 0
        var game = mgr.StartGame("Q?", "Hobbies");
        var q = game.CurrentQuestion!;

        game.AllPlayersAnswered().Should().BeFalse();

        mgr.RecordAnswer("Bob", "pizza").Should().BeTrue();
        mgr.RecordAnswer("Carla", "sushi").Should().BeTrue();
        game.AllPlayersAnswered().Should().BeFalse("the King has not locked a secret yet");

        mgr.RecordAnswer("Alice", "pizza").Should().BeTrue();
        game.AllPlayersAnswered().Should().BeTrue();

        // The live question is reused in place across rounds. It used to be element 0 of a
        // list that never grew while AllPlayersAnswered indexed that list by round number,
        // so completion silently reported false from round 1 onward.
        mgr.AdvanceRound();
        game.CurrentQuestion.Should().BeSameAs(q);

        q.KingPlayerAnswer.Should().Be("pizza");
        q.PlayerAnswers.Should().ContainKey("Bob").WhoseValue.Should().Be("pizza");
        q.PlayerAnswers.Should().NotContainKey("Alice", "the King's submission is the secret, not a guess");

        // Verify score application updates player stats
        mgr.ApplyRoundScores(new Dictionary<string, int> { ["Bob"] = 10 });
        var bob = game.Players.First(p => p.Name == "Bob");
        bob.Score.Should().Be(10);
        bob.TotalCorrectGuesses.Should().Be(1);
        bob.TotalRoundsPlayed.Should().Be(1);
    }

    // ─── Match orchestration ────────────────────────────────────────────

    private static void Reserve_IsRefusedWhileAMatchIsLive_AndReopensOnceItFinished()
    {
        var mgr = MatchOf("Alice", "Bob");
        mgr.StartGame("Q?", "Hobbies");
        mgr.Reserve(["Carla", "Dan"], 5, "Classic").Should().BeNull("a match is in progress");

        mgr.FinishGame();
        var again = mgr.Reserve(["Carla", "Dan"], 3, "Classic");

        again.Should().NotBeNull();
        mgr.Current!.State.Should().Be(SessionState.Waiting);
        mgr.Current.ActiveGame.Should().BeNull();
        mgr.Current.Players.Should().BeEmpty();
        mgr.Current.MaxRounds.Should().Be(3);
    }

    [Theory]
    [InlineData(7, 7)] // legal value
    [InlineData(3, 3)] // legal value
    [InlineData(4, 5)] // not on the menu: the default
    public void Reserve_UsesAllowedRoundCountsOnly(int rounds, int expected)
    {
        var mgr = MatchOf(rounds, "Alice", "Bob");

        mgr.Current!.MaxRounds.Should().Be(expected);
        mgr.StartGame("Q?", "Hobbies").MaxRounds.Should().Be(expected);
    }

    // ─── Game scoring ───────────────────────────────────────────────────

    private static void Game_ScoreboardIncludesEveryPlayer()
    {
        // Previously the scoreboard EXCLUDED the King. Combined with a King seat pinned to
        // index 0 for the whole match, that meant one player in a two-player couple game
        // was a permanent non-competitor: no score, no match-history row, no profile result.
        var game = new Game();
        game.AddPlayer(new Player { Name = "Alice", Score = 20 });
        game.AddPlayer(new Player { Name = "Bob", Score = 8 });
        game.AddPlayer(new Player { Name = "Carla", Score = 12 });

        game.IsKing("Alice").Should().BeTrue("round 0's King is player 0");

        var board = game.GetScoreboard();
        board.Keys.Should().Equal("Alice", "Carla", "Bob");
        board.Values.Should().Equal(20, 12, 8);
    }

    [Theory]
    [InlineData(0, "Alice")]
    [InlineData(1, "Bob")]
    [InlineData(2, "Carla")]
    [InlineData(3, "Alice")] // wraps
    public void Game_KingRotatesEveryRound(int round, string expectedKing)
    {
        var game = new Game { CurrentRound = round };
        game.AddPlayer(new Player { Name = "Alice" });
        game.AddPlayer(new Player { Name = "Bob" });
        game.AddPlayer(new Player { Name = "Carla" });

        game.KingPlayer!.Name.Should().Be(expectedKing);
    }
}
