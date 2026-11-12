using FluentAssertions;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging.Abstractions;
using PoMiniGames.Features.Shared.TurnMatch;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Unit.Features.Shared;

/// <summary>
/// The turn-match state machine behind online ConnectFive and TicTacToe: quick-match
/// pairing, turn and placement enforcement through the shared grid rules, win and
/// forfeit detection, rematch seat-swap, and token-based rejoin. One theory per rule
/// set so the Unit tier stays under its 100-method ceiling.
/// </summary>
public class TurnMatchServiceTests
{
    private static TurnMatchService<THub> Create<THub>(GridGameRules rules) where THub : Hub =>
        new(rules, new NullHubContext<THub>(), NullLogger<TurnMatchService<THub>>.Instance);

    /// <summary>A hub context whose every broadcast is a completed no-op.</summary>
    private sealed class NullHubContext<THub> : IHubContext<THub>
        where THub : Hub
    {
        public IHubClients Clients { get; } = NullClients.Instance;
        public IGroupManager Groups { get; } = NullClients.Instance;
    }

    private sealed class NullClients : IHubClients, IClientProxy, IGroupManager
    {
        public static readonly NullClients Instance = new();
        public IClientProxy All => this;
        public IClientProxy AllExcept(IReadOnlyList<string> excludedConnectionIds) => this;
        public IClientProxy Client(string connectionId) => this;
        public IClientProxy Clients(IReadOnlyList<string> connectionIds) => this;
        public IClientProxy Group(string groupName) => this;
        public IClientProxy GroupExcept(string groupName, IReadOnlyList<string> excludedConnectionIds) => this;
        public IClientProxy Groups(IReadOnlyList<string> groupNames) => this;
        public IClientProxy User(string userId) => this;
        public IClientProxy Users(IReadOnlyList<string> userIds) => this;
        public Task SendCoreAsync(string method, object?[] args, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task AddToGroupAsync(string connectionId, string groupName, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task RemoveFromGroupAsync(string connectionId, string groupName, CancellationToken cancellationToken = default) => Task.CompletedTask;
    }

    [Theory]
    [InlineData("connectfive")]
    [InlineData("tictactoe")]
    public void QuickMatch_PairsTwo_EnforcesTurns_DetectsWin_SwapsSeatsOnRematch_AndForfeitsOnLeave(string game)
    {
        if (game == "connectfive") Run(Create<ConnectFiveHub>(ConnectFiveRules.Instance), gravity: true);
        else Run(Create<TicTacToeHub>(TicTacToeRules.Instance), gravity: false);
    }

    private static void Run<THub>(TurnMatchService<THub> svc, bool gravity) where THub : Hub
    {
        var rules = svc.Rules;

        // ── Pairing: first arrival waits, second completes the pair. ──
        svc.Enqueue("c1", "alice", "Alice", isGuest: false).Should().BeNull();
        svc.WaitingCount.Should().Be(1);
        var pairing = svc.Enqueue("c2", "bob", "Bob", isGuest: true);
        pairing.Should().NotBeNull();
        svc.WaitingCount.Should().Be(0);
        pairing!.Connections.Should().HaveCount(2);
        pairing.Connections.Select(c => c.ConnectionId).Should().BeEquivalentTo(["c1", "c2"]);
        pairing.State.Turn.Should().Be(TurnMatchSide.First);

        var first = pairing.Connections.Single(c => c.Start.YourSide == TurnMatchSide.First);
        var second = pairing.Connections.Single(c => c.Start.YourSide == TurnMatchSide.Second);
        first.Start.SeatToken.Should().NotBe(second.Start.SeatToken);

        // Re-queueing a seated connection is a no-op, not a second seat.
        svc.Enqueue(first.ConnectionId, "x", "X", false).Should().BeNull();
        svc.WaitingCount.Should().Be(0);

        // ── Turn enforcement and the rules. ──
        svc.Invoking(s => s.Place(second.ConnectionId, 0, 0)).Should().Throw<InvalidOperationException>()
            .WithMessage("*not your turn*");
        svc.Invoking(s => s.Place(first.ConnectionId, 0, rules.Cols)).Should().Throw<InvalidOperationException>();

        // First wins straight down column 0 (gravity) / along row 0 (free placement),
        // with Second replying in a harmless column/row each time.
        var line = rules.WinLength;
        TurnMatchState state = pairing.State;
        for (int i = 0; i < line; i++)
        {
            state = gravity
                ? svc.Place(first.ConnectionId, 0, 0)
                : svc.Place(first.ConnectionId, 0, i);
            if (i < line - 1)
            {
                state.Status.Should().Be(TurnMatchStatus.InProgress);
                state.Turn.Should().Be(TurnMatchSide.Second);
                state = gravity
                    ? svc.Place(second.ConnectionId, 0, 1)
                    : svc.Place(second.ConnectionId, 1, i);
                state.Turn.Should().Be(TurnMatchSide.First);
            }
        }
        state.Status.Should().Be(TurnMatchStatus.FirstWon);
        state.EndReason.Should().Be(TurnMatchEndReason.Line);
        state.WinCells.Should().HaveCount(line);
        state.MoveCount.Should().Be(2 * line - 1);
        if (gravity)
        {
            // Discs stacked from the bottom row upward.
            state.LastMove!.Row.Should().Be(rules.Rows - line);
        }
        svc.Invoking(s => s.Place(second.ConnectionId, 0, 2)).Should().Throw<InvalidOperationException>()
            .WithMessage("*over*");

        // ── Rematch: both must vote; seats swap; fresh board. ──
        var (afterOne, none) = svc.RequestRematch(first.ConnectionId);
        none.Should().BeNull();
        afterOne.SeatOf(TurnMatchSide.First).WantsRematch.Should().BeTrue();
        var (afterTwo, rematch) = svc.RequestRematch(second.ConnectionId);
        rematch.Should().NotBeNull();
        afterTwo.GameNumber.Should().Be(2);
        afterTwo.MoveCount.Should().Be(0);
        afterTwo.Status.Should().Be(TurnMatchStatus.InProgress);
        afterTwo.Cells.Should().OnlyContain(b => b == GridGameRules.Empty);
        rematch!.Connections.Single(c => c.ConnectionId == first.ConnectionId).Start.YourSide
            .Should().Be(TurnMatchSide.Second, "the player who opened last game answers this one");
        rematch.Connections.Single(c => c.ConnectionId == second.ConnectionId).Start.SeatToken
            .Should().Be(second.Start.SeatToken, "tokens survive a rematch");

        // ── Rejoin: a reconnect presents the token and lands in the same seat. ──
        svc.Disconnected(second.ConnectionId)!.SeatOf(TurnMatchSide.First).Connected.Should().BeFalse();
        var rejoined = svc.Rejoin("c2-new", second.Start.SeatToken);
        rejoined.Should().NotBeNull();
        rejoined!.Start.YourSide.Should().Be(TurnMatchSide.First);
        rejoined.State.First.Connected.Should().BeTrue();
        svc.Rejoin("c9", "not-a-token").Should().BeNull();

        // ── Leave mid-game forfeits to whoever stayed. ──
        var forfeited = svc.Leave("c2-new");
        forfeited.Should().NotBeNull();
        forfeited!.Status.Should().Be(TurnMatchStatus.SecondWon);
        forfeited.EndReason.Should().Be(TurnMatchEndReason.Forfeit);
        // The leaver's token is gone; the survivor can queue again after leaving too.
        svc.Rejoin("c2-again", second.Start.SeatToken).Should().BeNull();
        svc.Leave(first.ConnectionId).Should().NotBeNull();
        svc.Enqueue(first.ConnectionId, "alice", "Alice", false).Should().BeNull("the queue is empty, so Alice waits");
        svc.WaitingCount.Should().Be(1);
    }
}
