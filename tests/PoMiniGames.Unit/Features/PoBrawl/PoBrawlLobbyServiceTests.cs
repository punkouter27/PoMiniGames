using FluentAssertions;
using Microsoft.Extensions.Time.Testing;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Features.PoBrawl.Online;

namespace PoMiniGames.Unit.Features.PoBrawl;

/// <summary>
/// State-machine tests for the live 1v1 lobby. Host assignment, cap-2 rejection,
/// ready toggling, host migration, and the TryStart gates that protect the match
/// service from launching on a half-formed roster.
/// </summary>
/// <remarks>
/// Bundled into a handful of <c>[Fact]</c>s / <c>[Theory]</c>s so the Unit tier
/// stays under its 100-method ceiling. Each test covers one observable behaviour.
/// </remarks>
public class PoBrawlLobbyServiceTests
{
    private static PoBrawlFighter AnyFighter => PoBrawlRoster.Bob;

    /// <summary>
    /// Each row runs one scenario: a private method below, named after what it checks.
    /// </summary>
    [Theory]
    [InlineData(nameof(Open_AssignsFirstArrivalAsHost_AndBouncesThirdAtCap))]
    [InlineData(nameof(RejoinSameConnection_RefreshesPlayerRow_PreservesHost))]
    [InlineData(nameof(TryStart_RequiresHostAndAllReady_AndIsIdempotent))]
    [InlineData(nameof(Start_MintsFreshMatchCode_SoTheNextPairFightsAlongside))]
    [InlineData(nameof(EndMatch_ResetsReadyFlags_AndClearsStaleMatch))]
    [InlineData(nameof(SamePrincipal_OnASecondConnection_TakesOverTheSeat_NeverASecondOne))]
    [InlineData(nameof(IdleSeat_GivesWay_OnlyWhenSomeoneNeedsTheRoom))]
    [InlineData(nameof(TryStartWithRoster_HandsBackTheRosterTheGatePassed))]
    public Task Scenario(string name) => Scenarios.RunAsync(this, name);

    // Host assignment and the cap-2 bounce share one arrangement, so they are one
    // fact.
    private static void Open_AssignsFirstArrivalAsHost_AndBouncesThirdAtCap()
    {
        var lobby = new PoBrawlLobbyService();
        lobby.Open("conn-1", "alice", "Alice", isGuest: false, AnyFighter);
        lobby.Open("conn-2", "bob", "Bob", isGuest: true, AnyFighter);
        lobby.State.HostConnectionId.Should().Be("conn-1");
        lobby.State.Players.Should().HaveCount(2);

        var (state, msg) = lobby.Open("conn-3", "eve", "Eve", isGuest: true, AnyFighter);
        state.Players.Should().HaveCount(2);
        msg.Should().Contain("full");
    }

    private static void RejoinSameConnection_RefreshesPlayerRow_PreservesHost()
    {
        var lobby = new PoBrawlLobbyService();
        lobby.Open("conn-1", "alice", "Alice", isGuest: false, AnyFighter);
        lobby.ToggleReady("conn-1");
        var (state, _) = lobby.Open("conn-1", "alice", "Alice2", isGuest: false, AnyFighter);
        state.HostConnectionId.Should().Be("conn-1");
        state.Players.Should().HaveCount(1);
        state.Players[0].DisplayName.Should().Be("Alice2");
    }

    private static void TryStart_RequiresHostAndAllReady_AndIsIdempotent()
    {
        var lobby = new PoBrawlLobbyService();
        lobby.Open("conn-1", "alice", "Alice", isGuest: false, AnyFighter);
        lobby.Open("conn-2", "bob", "Bob", isGuest: true, AnyFighter);
        lobby.ToggleReady("conn-1");
        lobby.TryStart("conn-2").Should().BeFalse("only the host can start");
        lobby.TryStart("conn-1").Should().BeFalse("bob is not ready");
        lobby.ToggleReady("conn-2");
        lobby.TryStart("conn-1").Should().BeTrue();
        lobby.TryStart("conn-1").Should().BeFalse("a second start cannot re-enter the gate");
    }

    /// <summary>
    /// The one shared room: each start mints a fresh match
    /// code and the room frees up, so the next two arrivals fight alongside the first pair.
    /// </summary>
    private static void Start_MintsFreshMatchCode_SoTheNextPairFightsAlongside()
    {
        var lobby = new PoBrawlLobbyService();
        var matches = new PoBrawlMatchRegistry();

        string StartPair(string a, string b)
        {
            lobby.Open(a, a, a, isGuest: false, AnyFighter);
            lobby.Open(b, b, b, isGuest: true, AnyFighter);
            lobby.ToggleReady(a);
            lobby.ToggleReady(b);
            lobby.TryStart(a).Should().BeTrue();
            var code = lobby.CreateMatchCode();
            matches.Start(code, lobby.Players);
            lobby.End();
            // Both lobby connections close as the pair navigates to the fight.
            lobby.Leave(a);
            lobby.Leave(b);
            return code;
        }

        var first = StartPair("conn-1", "conn-2");
        var second = StartPair("conn-3", "conn-4");

        second.Should().NotBe(first);
        matches.Get(first)!.Roster.Select(p => p.ConnectionId).Should().Equal("conn-1", "conn-2");
        matches.Get(second)!.Roster.Select(p => p.ConnectionId).Should().Equal("conn-3", "conn-4");
        // The live fight's code never reaches the room state every lobby visitor is sent.
        lobby.State.GameCode.Should().Be(PoBrawlLobbyService.GlobalCode);
    }

    private static void EndMatch_ResetsReadyFlags_AndClearsStaleMatch()
    {
        var lobby = new PoBrawlLobbyService();
        lobby.Open("conn-1", "alice", "Alice", isGuest: false, AnyFighter);
        lobby.Open("conn-2", "bob", "Bob", isGuest: true, AnyFighter);
        lobby.ToggleReady("conn-1");
        lobby.ToggleReady("conn-2");
        lobby.TryStart("conn-1");
        lobby.End();
        lobby.State.Players.Should().OnlyContain(p => !p.IsReady);
        lobby.IsStarted.Should().BeFalse();
    }

    /// <summary>
    /// One player in two tabs used to fill both seats (seats key on connection) and fight
    /// themselves, holding the only room. The newer connection takes over instead.
    /// </summary>
    private static void SamePrincipal_OnASecondConnection_TakesOverTheSeat_NeverASecondOne()
    {
        var lobby = new PoBrawlLobbyService();
        lobby.Open("tab-1", "Alice-Id", "Alice", isGuest: false, AnyFighter);
        lobby.PickFighter("tab-1", PoBrawlRoster.Fighters[0]);
        var (state, _) = lobby.Open("tab-2", "alice-id", "Alice", isGuest: false, AnyFighter);
        state.Players.Should().ContainSingle("one principal, one seat");
        state.Players[0].ConnectionId.Should().Be("tab-2");
        state.Players[0].Fighter.Should().Be(PoBrawlRoster.Fighters[0], "the pick comes along with the seat");
        state.HostConnectionId.Should().Be("tab-2");
        lobby.Open("conn-bob", "bob", "Bob", isGuest: false, AnyFighter).state.Players.Should().HaveCount(2,
            "the seat the second tab would have taken is still free for someone else");
    }

    /// <summary>
    /// A parked tab cannot hold the room: a seat that has done nothing for IdleSeatMs gives way to a
    /// newcomer — but only when the room is full, and never a ready guest waiting on the host.
    /// </summary>
    private static void IdleSeat_GivesWay_OnlyWhenSomeoneNeedsTheRoom()
    {
        var clock = new FakeTimeProvider(DateTimeOffset.UtcNow);
        var lobby = new PoBrawlLobbyService(clock);
        lobby.Open("conn-1", "alice", "Alice", isGuest: false, AnyFighter);
        lobby.Open("conn-2", "bob", "Bob", isGuest: false, AnyFighter);
        lobby.ToggleReady("conn-2");

        clock.Advance(TimeSpan.FromMilliseconds(PoBrawlLobbyService.IdleSeatMs - 1_000));
        lobby.Open("conn-3", "eve", "Eve", isGuest: false, AnyFighter).message.Should().Contain("full", "nobody has idled long enough yet");

        clock.Advance(TimeSpan.FromSeconds(2));
        var (state, _) = lobby.Open("conn-3", "eve", "Eve", isGuest: false, AnyFighter, out var evicted);
        evicted.Should().Equal(["Alice"], "the unready host sat on the room; the ready guest was only waiting");
        state.Players.Select(p => p.ConnectionId).Should().BeEquivalentTo(["conn-2", "conn-3"]);
        state.HostConnectionId.Should().Be("conn-2");

        // A seat alone in the room is waiting for an opponent, not blocking one: it is never swept.
        var quiet = new PoBrawlLobbyService(clock);
        quiet.Open("conn-1", "alice", "Alice", isGuest: false, AnyFighter);
        clock.Advance(TimeSpan.FromMinutes(10));
        quiet.Open("conn-2", "bob", "Bob", isGuest: false, AnyFighter, out var none).state.Players.Should().HaveCount(2);
        none.Should().BeEmpty();
    }

    /// <summary>
    /// The start gate and the roster the game is built from are one step under the room lock, so a
    /// seat that leaves right after the start cannot leave the match with a short roster.
    /// </summary>
    private static void TryStartWithRoster_HandsBackTheRosterTheGatePassed()
    {
        var lobby = new PoBrawlLobbyService();
        lobby.Open("conn-1", "alice", "Alice", isGuest: false, AnyFighter);
        lobby.Open("conn-2", "bob", "Bob", isGuest: true, AnyFighter);
        lobby.TryStartWithRoster("conn-1").Should().BeNull("nobody is ready");
        lobby.ToggleReady("conn-1");
        lobby.ToggleReady("conn-2");
        var roster = lobby.TryStartWithRoster("conn-1");
        lobby.Leave("conn-2");
        roster.Should().NotBeNull();
        roster!.Select(p => p.ConnectionId).Should().Equal("conn-1", "conn-2");
        new PoBrawlMatchRegistry().Start(lobby.CreateMatchCode(), roster).Player2.ConnectionId.Should().Be("conn-2");
    }
}
