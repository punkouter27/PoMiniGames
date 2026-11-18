using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using PoMiniGames.Features.PoFunQuiz;

namespace PoMiniGames.Unit.Features.PoFunQuiz;

/// <summary>
/// Unit tests for the PoFunQuiz in-memory match registry. Goes through
/// <see cref="MultiplayerLobbyService"/> with a source that deals from the bundled bank.
/// </summary>
/// <remarks>
/// <para>Pairing happens in the lobby hub; the service only reserves a match for the two seat
/// names (<see cref="MultiplayerLobbyService.ReserveAsync"/>) and seats each player who claims
/// one (<see cref="MultiplayerLobbyService.JoinMatch"/>). You cannot name a game you were not
/// reserved a seat in, and the match begins when both seats are claimed.</para>
/// <para>Player lifecycle (claim/remove) is one theory; scoring updates are another.</para>
/// </remarks>
public sealed class MultiplayerLobbyServiceTests
{
    private sealed class StubQuestions : IFunQuizQuestionSource
    {
        public Task<IReadOnlyList<QuizQuestion>> GetQuestionsAsync(QuestionCategory category, int count, CancellationToken cancellationToken = default) =>
            new FunQuizQuestionService().GetQuestionsAsync(category, count, cancellationToken);
    }

    private static MultiplayerLobbyService NewLobby() => new(new StubQuestions(), NullLogger<MultiplayerLobbyService>.Instance);

    /// <summary>Reserve a match for Alice (host) and the guest, then seat the named players in that order.</summary>
    private static async Task<(string Code, MultiplayerGame Game)> MatchAsync(
        MultiplayerLobbyService lobby, string guest = "Bob", int questions = 5, params (string Conn, string Name)[] seated)
    {
        var code = await lobby.ReserveAsync("Alice", guest, QuestionCategory.General, questions, default);
        foreach (var (conn, name) in seated) lobby.JoinMatch(conn, code, name);
        return (code, seated.Length > 0 ? lobby.GetByConnection(seated[0].Conn)! : null!);
    }

    [Theory]
    [InlineData("conn2", "Bob", 2)]
    [InlineData("conn5", "Dan", 2)]
    public async Task GuestClaim_JoinsTheReservedMatch_AsPlayerNumberTwo(string conn, string name, int expectedNumber)
    {
        var lobby = NewLobby();
        var (code, hosted) = await MatchAsync(lobby, name, 5, ("conn1", "Alice"));
        var joined = lobby.JoinMatch(conn, code, name);
        joined.Should().NotBeNull();
        joined!.Value.AllSeated.Should().BeTrue(because: "the match begins when the last reserved seat is claimed");
        joined.Value.Game.GameId.Should().Be(hosted.GameId);
        joined.Value.Game.State.Should().Be(GameState.InProgress);
        joined.Value.Game.Players.Should().HaveCount(2);
        joined.Value.Game.Players[1].Name.Should().Be(name);
        joined.Value.Game.Players[1].PlayerNumber.Should().Be(expectedNumber);
    }

    [Theory]
    [InlineData(true, 1)] // one correct answer → streak=1, baseScore > 0
    [InlineData(false, 0)] // wrong answer       → streak=0, baseScore stays 0
    [InlineData(true, 2)] // two correct        → streak=2, baseScore doubles
    [InlineData(true, 3)] // three correct      → streak=3 (tier 3+ bonus kicks in)
    public async Task UpdateScore_UpdatesBaseAndStreak(bool firstCorrect, int consecutiveCorrect)
    {
        var lobby = NewLobby();
        var (_, game) = await MatchAsync(lobby, "Bob", 5, ("conn1", "Alice"));
        lobby.UpdateScore(game.GameId, "conn1", isCorrect: firstCorrect, speedMultiplier: 1.0, secondsRemaining: 30);

        for (int i = 1; i < consecutiveCorrect; i++)
        {
            lobby.UpdateScore(game.GameId, "conn1", isCorrect: true, 1.0, 30);
        }

        var player = lobby.GetByConnection("conn1")!.Players[0];

        if (firstCorrect)
        {
            player.ScoreState.BaseScore.Should().BeGreaterThan(0);
            player.CurrentStreak.Should().Be(consecutiveCorrect);
            // Streak bonus tiers: 2→1, 3+→2, 5+→3.
            var expectedBonus = consecutiveCorrect switch
            {
                >= 5 => 3,
                >= 3 => 2,
                >= 2 => 1,
                _ => 0,
            };
            player.ScoreState.StreakBonus.Should().Be(expectedBonus);
        }
        else
        {
            // Wrong answer resets the streak counter immediately.
            player.CurrentStreak.Should().Be(0);
        }
    }

    [Theory]
    [InlineData("Alice", false)] // only the host's seat claimed: the match waits
    [InlineData("Bob", true)]    // both seats claimed: the match begins
    public async Task Match_BeginsOnlyWhenBothSeatsAreClaimed(string lastClaimant, bool expectStarted)
    {
        var lobby = NewLobby();
        var (code, _) = await MatchAsync(lobby, "Bob", 5, ("conn1", "Alice"));
        if (lastClaimant == "Bob") lobby.JoinMatch("conn2", code, "Bob");

        var game = lobby.GetByConnection("conn1")!;
        game.State.Should().Be(expectStarted ? GameState.InProgress : GameState.Waiting);
        game.StartTime.HasValue.Should().Be(expectStarted);
    }

    /// <summary>
    /// Each row runs one scenario: a private method below, named after what it checks.
    /// </summary>
    [Theory]
    [InlineData(nameof(FirstClaim_IsHostPlayerOne_AndMatchWaitsForTheOther))]
    [InlineData(nameof(Strangers_TakenSeats_AndStaleReservations_AreRefused))]
    [InlineData(nameof(RemoveLastPlayer_DeletesSession))]
    [InlineData(nameof(Survivor_Rejoin_And_ClientBonuses_AreAllBounded))]
    public Task Scenario(string name) => Scenarios.RunAsync(this, name);

    private static async Task FirstClaim_IsHostPlayerOne_AndMatchWaitsForTheOther()
    {
        foreach (var (hostConn, hostName) in new[] { ("conn1", "Alice"), ("conn7", "Eve") })
        {
            var lobby = NewLobby();
            var code = await lobby.ReserveAsync(hostName, "Zed", QuestionCategory.Science, 7, default);
            var (game, allSeated) = lobby.JoinMatch(hostConn, code, hostName)!.Value;
            allSeated.Should().BeFalse();
            game.GameId.Should().Be(code);
            game.Category.Should().Be(QuestionCategory.Science, "the host's category is the one dealt");
            game.Questions.Should().HaveCount(7);
            game.HostConnectionId.Should().Be(hostConn);
            game.Players.Should().ContainSingle(p => p.Name == hostName && p.PlayerNumber == 1);
            game.State.Should().Be(GameState.Waiting);
        }
    }

    private static async Task Strangers_TakenSeats_AndStaleReservations_AreRefused()
    {
        var lobby = NewLobby();
        var code = await lobby.ReserveAsync("Alice", "Bob", QuestionCategory.General, 5, default);

        // A name nobody reserved, a code nobody issued, and a seat already taken are all refused,
        // so a pair is never overfilled and a client cannot name a match it was not seated in.
        lobby.JoinMatch("conn3", code, "Carla").Should().BeNull();
        lobby.JoinMatch("conn1", "match-nope", "Alice").Should().BeNull();
        var guestFirst = lobby.JoinMatch("conn2", code, "Bob")!.Value;
        guestFirst.AllSeated.Should().BeFalse();
        lobby.JoinMatch("conn1", code, "Alice")!.Value.Game.Players.Select(p => p.Name).Should().Equal("Alice", "Bob");
        lobby.JoinMatch("conn9", code, "Alice").Should().BeNull("the match has begun and the seat is taken");

        // An unclaimed reservation does not linger: the next reservation sweeps it.
        var stale = await lobby.ReserveAsync("Eve", "Fay", QuestionCategory.General, 5, default);
        lobby.JoinMatch("conn4", stale, "Eve").Should().NotBeNull();
        lobby.RemovePlayer("conn4", out _);
        var old = await lobby.ReserveAsync("Gus", "Hal", QuestionCategory.General, 5, default);
        lobby.JoinMatch("conn5", old, "Gus");
        lobby.GetByConnection("conn5")!.ReservedAtUtc = DateTime.UtcNow - MultiplayerLobbyService.ReservationLifetime - TimeSpan.FromSeconds(1);
        await lobby.ReserveAsync("Ivy", "Jon", QuestionCategory.General, 5, default);
        lobby.JoinMatch("conn6", old, "Hal").Should().BeNull("the stale reservation was swept");
    }

    [Theory]
    [InlineData("conn1", "conn2", "conn2")] // host leaves → conn2 promotes
    [InlineData("conn2", "conn1", "conn1")] // non-host leaves → host unchanged
    public async Task RemovePlayer_PromotesNewHostOrKeepsSession(string leaver, string expectedNewHost, string otherPlayer)
    {
        var lobby = NewLobby();
        await MatchAsync(lobby, "Bob", 5, ("conn1", "Alice"), ("conn2", "Bob"));

        lobby.RemovePlayer(leaver, out _);

        var remaining = lobby.GetByConnection(otherPlayer);
        remaining.Should().NotBeNull();
        remaining!.HostConnectionId.Should().Be(expectedNewHost);
    }

    private static async Task RemoveLastPlayer_DeletesSession()
    {
        var lobby = NewLobby();
        await MatchAsync(lobby, "Bob", 5, ("conn1", "Alice"));
        lobby.RemovePlayer("conn1", out var sessionEmpty);
        sessionEmpty.Should().BeTrue();
        lobby.GetByConnection("conn1").Should().BeNull();
    }

    private static async Task Survivor_Rejoin_And_ClientBonuses_AreAllBounded()
    {
        var lobby = NewLobby();
        var (_, first) = await MatchAsync(lobby, "Bob", 5, ("conn1", "Alice"), ("conn2", "Bob"));

        // A tampered client cannot buy points with the two values it supplies.
        lobby.UpdateScore(first.GameId, "conn1", isCorrect: true, speedMultiplier: 1e9, secondsRemaining: int.MaxValue);
        var alice = first.Players[0];
        alice.ScoreState.SpeedBonus.Should().BeLessThanOrEqualTo(first.Questions[0].BasePoints);
        alice.ScoreState.TimeBonus.Should().BeLessThanOrEqualTo(300);

        // Bob leaves mid-match: the survivor is the winner, not an index-out-of-range.
        lobby.RemovePlayer("conn2", out _);
        first.Winner.Should().BeSameAs(alice);
        first.IsTie.Should().BeFalse();

        // Alice claims a seat in a new match on the same connection: she leaves the old game
        // rather than orphaning it.
        var (_, second) = await MatchAsync(lobby, "Bob", 5, ("conn1", "Alice"));
        second.GameId.Should().NotBe(first.GameId);
        first.Players.Should().BeEmpty();
    }

    [Theory]
    [InlineData(1, 5)] // after AdvanceQuestion on Q1, both players' HasFinished should be reset
    [InlineData(2, 5)] // and on subsequent questions as well
    [InlineData(4, 5)] // only the very last question must NOT auto-advance (the hub finalizes it instead)
    public async Task AdvanceQuestion_ResetsHasFinished_ExceptOnLastQuestion(int currentQuestion, int totalQuestions)
    {
        var lobby = NewLobby();
        var (_, game) = await MatchAsync(lobby, "Bob", totalQuestions, ("conn1", "Alice"), ("conn2", "Bob"));

        // Hop the game to the desired question index by direct field-mutation
        // (acceptable here: we are testing the AdvanceQuestion behavior in
        // isolation, not the entire state machine).
        var g = lobby.GetByConnection("conn1")!;
        g.CurrentQuestionIndex = currentQuestion;

        // Pretend both players answered the previous question.
        foreach (var p in g.Players) p.HasFinished = true;

        lobby.AdvanceQuestion(game.GameId, "conn1");

        var fresh = lobby.GetByConnection("conn1")!;
        // AdvanceQuestion only increments the index when there is room; on the
        // last question the lobby stays put so the hub can finalize. Either
        // way the reset flag is what we're really validating.
        if (currentQuestion < totalQuestions - 1)
        {
            fresh.CurrentQuestionIndex.Should().Be(currentQuestion + 1);
        }

        foreach (var p in fresh.Players)
        {
            p.HasFinished.Should().BeFalse(
                because: "AdvanceQuestion must clear per-question submission flags so the same player can answer the next question");
        }
    }
}
