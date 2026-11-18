using FluentAssertions;
using FluentAssertions.Execution;
using PoMiniGames.Domain.Models;
using PoMiniGames.Features.PoMarbleRace;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Unit.Features.PoMarbleRace;

/// <summary>
/// PoMarbleRace server rules, as one <c>[Theory]</c> of scenarios to keep the Unit tier inside its
/// cap: <see cref="MarbleRaceScore"/> (an out-of-range score is unrepresentable, not merely
/// rejected), <see cref="MarbleRaceRunVerifier"/> (a run total recomputed from its races), and
/// <see cref="PoMarbleRaceLobbyService"/> and <see cref="PoMarbleRaceOnlineService"/> (the shared lobby, and pairing by its internal code for two
/// players at most).
/// </summary>
/// <remarks>
/// The two tables below were data theories of their own; each row is still asserted, named in its
/// failure message, and every failing row is reported together (AssertionScope).
/// </remarks>
public class PoMarbleRaceTests
{
    [Theory]
    [InlineData(nameof(Score_TryCreateChecksTheRange_AndClampBoundsIt))]
    [InlineData(nameof(RunVerifier_RecomputesTheTotal_OrRefusesTheRun))]
    [InlineData(nameof(Lobby_SeatsTwo_AndRefusesAThird))]
    [InlineData(nameof(Lobby_FirstArrivalHosts_AndStartNeedsAReadyGuest))]
    [InlineData(nameof(Race_PairsHostAndGuest_ByTheInternalCode_Only))]
    [InlineData(nameof(Leaving_FreesTheLobbySeat_AndEndsTheRace))]
    public Task Scenario(string name) => Scenarios.RunAsync(this, name);

    // value, accepted, clamped
    private static readonly (int Value, bool Accepted, int Clamped, string Why)[] ScoreRows =
    [
        (0, true, 0, "a scoreless run is legitimate"),
        (1, true, 1, "smallest positive"),
        (42, true, 42, "ordinary"),
        (1_000_000, true, 1_000_000, "the ceiling itself is valid"),
        (-1, false, 0, "negative"),
        (-5, false, 0, "negative"),
        (1_000_001, false, 1_000_000, "just past the ceiling"),
        (int.MaxValue, false, 1_000_000, "the tampered submission that would own the board forever"),
        (int.MinValue, false, 0, "minimum int"),
    ];

    private static void Score_TryCreateChecksTheRange_AndClampBoundsIt()
    {
        using var scope = new AssertionScope();
        foreach (var (value, accepted, clamped, why) in ScoreRows)
        {
            MarbleRaceScore.TryCreate(value, out var score).Should().Be(accepted, $"{value}: {why}");
            score.Value.Should().Be(accepted ? value : 0, $"{value}: a rejected score must not leak a usable value");
            MarbleRaceScore.Clamp(value).Value.Should().Be(clamped, $"{value} clamps to {clamped}");
        }
    }

    // Races are "place:seconds:lead" triples. Expected -1 means the run is refused.
    private static readonly (int MapId, string Races, int Expected, string Why)[] RunRows =
    [
        (2, "1:40:0", 10, "1st, not dominant: 10 x 1"),
        (2, "1:40:2", 14, "dominant win: (10 + 4) x 1"),
        (2, "10:40:0|3:40:0|5:40:0", 25, "1x1 + 8x1.5 + 6x2: the streak multiplier"),
        (2, "10:40:0|10:40:0|10:40:0|10:40:0|10:40:0|10:40:0", 14, "1+2+2+3+3+3: the multiplier caps at 3x"),
        (2, "9:40:0|8:40:0", 7, "2 + round(3 x 1.5 = 4.5) rounds half up, like JS"),
        (2, "11:40:0", -1, "a miss ends a run, so it cannot be inside one"),
        (2, "1:5:0", -1, "faster than any marble can cover the course"),
        (2, "1:181:0", -1, "past the race timeout"),
        (9, "1:40:0", -1, "no such map"),
        (2, "", -1, "no races, no verified run"),
    ];

    private static void RunVerifier_RecomputesTheTotal_OrRefusesTheRun()
    {
        using var scope = new AssertionScope();
        foreach (var (mapId, races, expected, why) in RunRows)
        {
            MarbleRaceRunRace[] parsed = races.Length == 0 ? [] : races.Split('|').Select(r =>
            {
                var p = r.Split(':');
                return new MarbleRaceRunRace(int.Parse(p[0], System.Globalization.CultureInfo.InvariantCulture), double.Parse(p[1], System.Globalization.CultureInfo.InvariantCulture), double.Parse(p[2], System.Globalization.CultureInfo.InvariantCulture));
            }).ToArray();

            MarbleRaceRunVerifier.Score(mapId, parsed).Should().Be(expected < 0 ? (int?)null : expected, $"map {mapId} [{races}]: {why}");
        }
    }

    private static void Lobby_SeatsTwo_AndRefusesAThird()
    {
        var lobby = new PoMarbleRaceLobbyService();
        lobby.Open("a", "Alice", false, "alice");
        lobby.Open("b", "Bob", false, "bob");
        var (state, message) = lobby.Open("c", "Cara", false, "cara");

        message.Should().Be("Lobby is full");
        state.Players.Select(p => p.ConnectionId).Should().BeEquivalentTo(["a", "b"]);
        state.MaxPlayers.Should().Be(PoMarbleRaceOnlineService.MaxPlayers);
        lobby.PickMap("a", MarbleRaceDaily.MapId).Should().BeFalse("the Daily Canyon is a solo board");
    }

    private static void Lobby_FirstArrivalHosts_AndStartNeedsAReadyGuest()
    {
        var lobby = new PoMarbleRaceLobbyService();
        lobby.Open("a", "Alice", false, "alice");
        lobby.TryStart("a").Should().BeFalse("a lone host has nobody to race");
        lobby.Open("b", "Bob", false, "bob");
        lobby.HostConnectionId.Should().Be("a", "the first arrival hosts");

        lobby.TryStart("a").Should().BeFalse("the guest has not readied");
        lobby.ToggleReady("b");
        lobby.TryStart("b").Should().BeFalse("only the host starts");
        lobby.PickMap("b", 4).Should().BeTrue();
        lobby.PickMap("a", 3).Should().BeTrue();
        var roster = lobby.TryStartWithRoster("a");
        roster.Should().NotBeNull();
        roster!.First(p => p.ConnectionId == "a").MapId.Should().Be(3, "the host's pick is the course");
    }

    private static void Race_PairsHostAndGuest_ByTheInternalCode_Only()
    {
        var svc = new PoMarbleRaceOnlineService();
        var code = new PoMarbleRaceLobbyService().CreateMatchCode();
        svc.Expect(code, new("alice", "Alice", false), new("bob", "Bob", true), mapId: 3);

        svc.JoinMatch("x", "carol", code).Seated.Should().BeFalse("only the seated players may join");
        svc.JoinMatch("g", "bob", "nope").Seated.Should().BeFalse("an unknown code seats nobody");
        var first = svc.JoinMatch("h", "alice", code);
        first.Seated.Should().BeTrue();
        first.Pairing.Should().BeNull("the race waits for the second seat");
        var pair = svc.JoinMatch("g", "bob", code).Pairing;

        pair.Should().NotBeNull();
        pair!.HostConnectionId.Should().Be("h", "the lobby host is the race host");
        pair.HostStart.MapId.Should().Be(3);
        pair.GuestStart.YourRole.Should().Be(MarbleRaceRole.Guest);
        svc.PeerOf("g").Should().Be("h");
        svc.JoinMatch("z", "alice", code).Seated.Should().BeFalse("the code is spent once both seats are in");
    }

    private static void Leaving_FreesTheLobbySeat_AndEndsTheRace()
    {
        var lobby = new PoMarbleRaceLobbyService();
        lobby.Open("a", "Alice", false, "alice");
        lobby.Open("b", "Bob", false, "bob");
        lobby.Leave("b");
        lobby.Open("c", "Cara", false, "cara").message.Should().Be("Cara joined", "the freed seat is open again");
        lobby.Leave("a");
        lobby.HostConnectionId.Should().Be("c", "hosting passes to the player left");

        var svc = new PoMarbleRaceOnlineService();
        svc.Expect("m", new("alice", "Alice", false), new("bob", "Bob", false), 2);
        svc.JoinMatch("h", "alice", "m");
        svc.JoinMatch("g", "bob", "m");
        svc.Remove("h").Should().Be("g", "the guest is told the host left");
        svc.RoleOf("g").Should().BeNull();
    }
}
