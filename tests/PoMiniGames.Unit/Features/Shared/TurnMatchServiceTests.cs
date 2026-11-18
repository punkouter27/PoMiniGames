using FluentAssertions;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging.Abstractions;
using PoMiniGames.Features.Shared.TurnMatch;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Unit.Features.Shared;

/// <summary>
/// The turn-match state machine behind online ConnectFive and TicTacToe: the shared lobby
/// (host, ready, start gate), pairing by the reserved match code, turn and placement
/// enforcement through the shared grid rules, win and forfeit detection, and token-based rejoin. One theory per rule
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
    public void Lobby_PairsTwoByCode_EnforcesTurns_DetectsWin_RejoinsByToken_AndForfeitsOnLeave(string game)
    {
        if (game == "connectfive") Run(Create<ConnectFiveHub>(ConnectFiveRules.Instance), gravity: true);
        else Run(Create<TicTacToeHub>(TicTacToeRules.Instance), gravity: false);
    }

    private static void Run<THub>(TurnMatchService<THub> svc, bool gravity) where THub : Hub
    {
        var rules = svc.Rules;

        // ── Lobby: first arrival hosts, the guest readies, only the host starts, cap of two. ──
        var lobby = new TurnLobbyRoom<THub>();
        lobby.Open("c1", "Alice", isGuest: false);
        lobby.HostConnectionId.Should().Be("c1");
        lobby.TryStartWithRoster("c1").Should().BeNull("a lone host cannot start");
        lobby.Open("c2", "Bob", isGuest: true);
        lobby.Open("c3", "Cy", isGuest: false).state.Players.Should().HaveCount(2, "the lobby is capped at two seats");
        lobby.TryStartWithRoster("c1").Should().BeNull("the guest is not ready");
        lobby.ToggleReady("c2").isReady.Should().BeTrue();
        lobby.TryStartWithRoster("c2").Should().BeNull("only the host starts");
        var roster = lobby.TryStartWithRoster("c1");
        roster.Should().NotBeNull();
        roster!.Select(p => p.ConnectionId).Should().BeEquivalentTo(["c1", "c2"]);
        lobby.End();

        // ── Pairing by the reserved code: the first claimant waits, the second completes it. ──
        svc.Invoking(s => s.Join("nope", "cx", "x", "X", false, asHost: false)).Should().Throw<InvalidOperationException>();
        var code = svc.Reserve();
        // The guest (c2) arrives before the host: the host still moves first.
        svc.Join(code, "c2", "bob", "Bob", isGuest: true, asHost: false).Should().BeNull();
        svc.PendingCount.Should().Be(1);
        var pairing = svc.Join(code, "c1", "alice", "Alice", isGuest: false, asHost: true);
        pairing.Should().NotBeNull();
        svc.PendingCount.Should().Be(0);
        pairing!.Connections.Select(c => c.ConnectionId).Should().BeEquivalentTo(["c1", "c2"]);
        pairing.State.Turn.Should().Be(TurnMatchSide.First);
        pairing.Connections.Single(c => c.ConnectionId == "c1").Start.YourSide.Should().Be(TurnMatchSide.First, "the host plays first");
        svc.Invoking(s => s.Join(code, "c9", "z", "Z", false, false)).Should().Throw<InvalidOperationException>("a spent code is refused");

        var first = pairing.Connections.Single(c => c.Start.YourSide == TurnMatchSide.First);
        var second = pairing.Connections.Single(c => c.Start.YourSide == TurnMatchSide.Second);
        first.Start.SeatToken.Should().NotBe(second.Start.SeatToken);

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

        // ── A fresh match (the finished one is over): rejoin by token, then forfeit on leave. ──
        // Two claimants on different codes never pair with each other.
        svc.Join(svc.Reserve(), "d1", "dee", "Dee", false, asHost: true).Should().BeNull();
        svc.Join(svc.Reserve(), "d2", "eli", "Eli", false, asHost: false).Should().BeNull();
        var code2 = svc.Reserve();
        svc.Join(code2, "e1", "eve", "Eve", false, asHost: true).Should().BeNull();
        var match2 = svc.Join(code2, "e2", "fay", "Fay", false, asHost: false)!;
        var guestSeat = match2.Connections.Single(c => c.ConnectionId == "e2").Start;
        svc.Disconnected("e2")!.SeatOf(TurnMatchSide.Second).Connected.Should().BeFalse();
        var rejoined = svc.Rejoin("e2-new", guestSeat.SeatToken);
        rejoined.Should().NotBeNull();
        rejoined!.Start.YourSide.Should().Be(TurnMatchSide.Second);
        rejoined.State.Second.Connected.Should().BeTrue();
        svc.Rejoin("c9", "not-a-token").Should().BeNull();

        var forfeited = svc.Leave("e2-new");
        forfeited.Should().NotBeNull();
        forfeited!.Status.Should().Be(TurnMatchStatus.FirstWon);
        forfeited.EndReason.Should().Be(TurnMatchEndReason.Forfeit);
        // The leaver's token is gone; the survivor can leave too.
        svc.Rejoin("e2-again", guestSeat.SeatToken).Should().BeNull();
        svc.Leave("e1").Should().NotBeNull();
    }
}
