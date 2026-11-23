using System.Collections.Concurrent;
using FluentAssertions;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging.Abstractions;
using PoMiniGames.Domain.Services;
using PoMiniGames.Features.Shared.TurnMatch;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Unit.Features.Shared;

/// <summary>
/// Connect Five's server-side online Elo maths, the per-move turn clock (auto-move, pause while a seat
/// is away) and the once-per-match scoring hook in <see cref="TurnMatchService{THub}"/>.
/// </summary>
public class TurnMatchClockAndEloTests
{
    private static readonly TimeSpan Clock = TimeSpan.FromMilliseconds(250);

    [Theory]
    [InlineData(1200, 1200, 1.0, 16)]
    [InlineData(1200, 1200, 0.0, -16)]
    [InlineData(1200, 1200, 0.5, 0)]
    [InlineData(1000, 1400, 1.0, 29)] // upset: the underdog gains most
    [InlineData(1400, 1000, 1.0, 3)]
    [InlineData(1000, 1400, 0.5, 13)]
    public void TurnGameElo_IsStandardEloWithK32(int first, int second, double score, int expectedDelta)
    {
        TurnGameElo.StartRating.Should().Be(1200);
        TurnGameElo.K.Should().Be(32);
        TurnGameElo.DeltaForFirst(first, second, score).Should().Be(expectedDelta);
    }

    [Fact]
    public async Task Clock_PlaysARandomLegalColumn_WhenTimeRunsOut_AndRestartsForTheNextSeat()
    {
        var hub = new CapturingHub();
        var svc = Create(hub, pick: _ => 0);
        var pairing = Pair(svc);

        pairing.State.TurnMsLeft.Should().BeInRange(1, (int)Clock.TotalMilliseconds, "a live game carries the time left");

        var state = await hub.NextStateAsync(s => s.MoveCount == 1);
        state.LastMove.Should().Be(new TurnMatchMove(8, 0, TurnMatchSide.First), "index 0 of the legal columns, landing by gravity");
        state.Turn.Should().Be(TurnMatchSide.Second);
        state.TurnMsLeft.Should().BeGreaterThan(0, "the clock restarts for the next seat");

        // The seat that was moved for plays on as normal.
        svc.Place("c2", 0, 4).MoveCount.Should().Be(2);
    }

    [Fact]
    public async Task Clock_SkipsFullColumns()
    {
        var hub = new CapturingHub();
        var svc = Create(hub, pick: _ => 0, clock: TimeSpan.FromMilliseconds(400));
        Pair(svc);
        for (var i = 0; i < ConnectFiveRules.BoardRows; i++) svc.Place(i % 2 == 0 ? "c1" : "c2", 0, 0);

        // Column 0 is full, so the first legal column left is 1.
        var state = await hub.NextStateAsync(s => s.MoveCount == ConnectFiveRules.BoardRows + 1);
        state.LastMove!.Col.Should().Be(1);
    }

    [Fact]
    public async Task Clock_IsPausedWhileASeatIsAway_AndResumesOnRejoin()
    {
        var hub = new CapturingHub();
        var svc = Create(hub, pick: _ => 0);
        var pairing = Pair(svc);
        var token = pairing.Connections[1].Start.SeatToken;

        var dropped = svc.Disconnected("c2")!;
        dropped.TurnMsLeft.Should().BeNull("the clock stands still inside the grace window");
        await Task.Delay(Clock + TimeSpan.FromMilliseconds(300));
        hub.States.Should().BeEmpty("no auto-move while a seat is away");

        var back = svc.Rejoin("c2b", token)!;
        back.State.TurnMsLeft.Should().BeGreaterThan(0);
        var state = await hub.NextStateAsync(s => s.MoveCount == 1);
        state.LastMove!.Side.Should().Be(TurnMatchSide.First);
    }

    [Fact]
    public async Task NoClock_NoDeadline_NoAutoMove()
    {
        var hub = new CapturingHub();
        var svc = new TurnMatchService<ConnectFiveHub>(ConnectFiveRules.Instance, hub, NullLogger<TurnMatchService<ConnectFiveHub>>.Instance);
        var pairing = Pair(svc);
        pairing.State.TurnMsLeft.Should().BeNull();
        await Task.Delay(Clock + TimeSpan.FromMilliseconds(300));
        hub.States.Should().BeEmpty();
    }

    [Fact]
    public async Task Finish_ScoresTheMatchOnce_ByPrincipalId_AndBroadcastsTheRatings()
    {
        var hub = new CapturingHub();
        var sink = new FakeSink();
        var svc = Create(hub, sink: sink, clock: TimeSpan.FromMinutes(5));
        var pairing = Pair(svc);

        // First wins along the bottom row; second stacks column 8 in between.
        for (var i = 0; i < 4; i++)
        {
            svc.Place("c1", 0, i);
            svc.Place("c2", 0, 8);
        }
        var final = svc.Place("c1", 0, 4);
        final.Status.Should().Be(TurnMatchStatus.FirstWon);
        final.TurnMsLeft.Should().BeNull();

        var scored = await hub.NextStateAsync(s => s.Ratings is not null);
        scored.Ratings!.First.Delta.Should().Be(16);
        scored.Ratings.Second.Delta.Should().Be(-16);
        var result = sink.Results.Should().ContainSingle().Subject;
        result.MatchId.Should().Be(pairing.MatchId);
        result.FirstId.Should().Be("alice");
        result.SecondId.Should().Be("bob");
        result.Status.Should().Be(TurnMatchStatus.FirstWon);

        // A later leave on the finished match must not score it again.
        svc.Leave("c2");
        await Task.Delay(100);
        sink.Results.Should().ContainSingle();
    }

    [Fact]
    public async Task Leave_InProgress_IsScoredAsAForfeitLoss()
    {
        var hub = new CapturingHub();
        var sink = new FakeSink();
        var svc = Create(hub, sink: sink, clock: TimeSpan.FromMinutes(5));
        Pair(svc);

        var state = svc.Leave("c1")!;
        state.Status.Should().Be(TurnMatchStatus.SecondWon);
        await hub.NextStateAsync(s => s.Ratings is not null);
        sink.Results.Single().Status.Should().Be(TurnMatchStatus.SecondWon);
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    private static TurnMatchService<ConnectFiveHub> Create(
        CapturingHub hub, Func<int, int>? pick = null, ITurnMatchResultSink? sink = null, TimeSpan? clock = null) =>
        new(ConnectFiveRules.Instance, hub, NullLogger<TurnMatchService<ConnectFiveHub>>.Instance,
            clock ?? Clock, sink, pick);

    private static TurnMatchService<ConnectFiveHub>.Pairing Pair(TurnMatchService<ConnectFiveHub> svc)
    {
        var code = svc.Reserve();
        svc.Join(code, "c1", "alice", "Alice", false, asHost: true);
        return svc.Join(code, "c2", "bob", "Bob", false, asHost: false)!;
    }

    private sealed class FakeSink : ITurnMatchResultSink
    {
        private readonly ConcurrentQueue<TurnMatchResult> _queue = new();
        public List<TurnMatchResult> Results => [.. _queue];

        public Task<TurnMatchRatings?> RecordAsync(TurnMatchResult result, CancellationToken cancellationToken = default)
        {
            _queue.Enqueue(result);
            var delta = TurnGameElo.DeltaForFirst(1200, 1200, result.Status == TurnMatchStatus.FirstWon ? 1 : 0);
            return Task.FromResult<TurnMatchRatings?>(new TurnMatchRatings(
                new TurnRatingChange(1200 + delta, delta, 1), new TurnRatingChange(1200 - delta, -delta, 1)));
        }
    }

    /// <summary>A hub context that records every <c>state</c> broadcast.</summary>
    private sealed class CapturingHub : IHubContext<ConnectFiveHub>
    {
        private readonly Proxy _proxy = new();

        public IReadOnlyList<TurnMatchState> States => _proxy.States;
        public IHubClients Clients => _proxy;
        public IGroupManager Groups => _proxy;

        public async Task<TurnMatchState> NextStateAsync(Func<TurnMatchState, bool> predicate)
        {
            var until = DateTime.UtcNow.AddSeconds(5);
            while (DateTime.UtcNow < until)
            {
                var hit = _proxy.States.FirstOrDefault(predicate);
                if (hit is not null) return hit;
                await Task.Delay(20);
            }
            throw new TimeoutException("The expected state broadcast never arrived.");
        }

        private sealed class Proxy : IHubClients, IClientProxy, IGroupManager
        {
            private readonly ConcurrentQueue<TurnMatchState> _states = new();
            public IReadOnlyList<TurnMatchState> States => [.. _states];
            public IClientProxy All => this;
            public IClientProxy AllExcept(IReadOnlyList<string> excludedConnectionIds) => this;
            public IClientProxy Client(string connectionId) => this;
            public IClientProxy Clients(IReadOnlyList<string> connectionIds) => this;
            public IClientProxy Group(string groupName) => this;
            public IClientProxy GroupExcept(string groupName, IReadOnlyList<string> excludedConnectionIds) => this;
            public IClientProxy Groups(IReadOnlyList<string> groupNames) => this;
            public IClientProxy User(string userId) => this;
            public IClientProxy Users(IReadOnlyList<string> userIds) => this;

            public Task SendCoreAsync(string method, object?[] args, CancellationToken cancellationToken = default)
            {
                if (method == "state" && args.Length == 1 && args[0] is TurnMatchState s) _states.Enqueue(s);
                return Task.CompletedTask;
            }

            public Task AddToGroupAsync(string connectionId, string groupName, CancellationToken cancellationToken = default) => Task.CompletedTask;
            public Task RemoveFromGroupAsync(string connectionId, string groupName, CancellationToken cancellationToken = default) => Task.CompletedTask;
        }
    }
}
