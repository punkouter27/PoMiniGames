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
/// <see cref="PoMarbleRaceOnlineService"/> (quick-match, private codes for two players at most,
/// and the both-must-ask rematch).
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
    [InlineData(nameof(QuickMatch_PairsTheFirstTwo_FirstHosts))]
    [InlineData(nameof(PrivateCode_SeatsTheFriend_OnTheHostsMap_AndAThirdIsTurnedAway))]
    [InlineData(nameof(PrivateCode_RefusesUnknownCodes_AndYourOwn))]
    [InlineData(nameof(Rematch_StartsOnlyWhenBothAsk_ThenResets))]
    [InlineData(nameof(Leaving_ClosesAnOpenCode))]
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
                return new MarbleRaceRunRace(int.Parse(p[0]), double.Parse(p[1], System.Globalization.CultureInfo.InvariantCulture), double.Parse(p[2], System.Globalization.CultureInfo.InvariantCulture));
            }).ToArray();

            MarbleRaceRunVerifier.Score(mapId, parsed).Should().Be(expected < 0 ? (int?)null : expected, $"map {mapId} [{races}]: {why}");
        }
    }

    private static void QuickMatch_PairsTheFirstTwo_FirstHosts()
    {
        var svc = new PoMarbleRaceOnlineService();
        svc.Enqueue("a", "alice", "Alice", isGuest: false, mapId: 3).Should().BeNull("the first arrival waits");
        var pair = svc.Enqueue("b", "bob", "Bob", isGuest: true, mapId: 1);

        pair.Should().NotBeNull();
        pair!.HostConnectionId.Should().Be("a");
        pair.HostStart.MapId.Should().Be(3, "the host's map is the course");
        pair.GuestStart.YourRole.Should().Be(MarbleRaceRole.Guest);
        svc.PeerOf("b").Should().Be("a");
    }

    private static void PrivateCode_SeatsTheFriend_OnTheHostsMap_AndAThirdIsTurnedAway()
    {
        var svc = new PoMarbleRaceOnlineService();
        var code = svc.CreateRoom("a", "alice", "Alice", isGuest: false, mapId: 4);
        code.Should().MatchRegex("^[A-Z2-9]{4}$");
        svc.Enqueue("q", "quinn", "Quinn", false, 1).Should().BeNull("a private race is not in the quick-match queue");

        var (pair, error) = svc.JoinRoom("b", "bob", "Bob", isGuest: false, code!.ToLowerInvariant());
        error.Should().BeNull("codes are case-insensitive");
        pair!.GuestStart.MapId.Should().Be(4);

        var (third, why) = svc.JoinRoom("c", "cara", "Cara", isGuest: false, code);
        third.Should().BeNull();
        why.Should().Contain($"{PoMarbleRaceOnlineService.MaxPlayers} players");
    }

    private static void PrivateCode_RefusesUnknownCodes_AndYourOwn()
    {
        var svc = new PoMarbleRaceOnlineService();
        var code = svc.CreateRoom("a", "alice", "Alice", false, 2)!;

        svc.JoinRoom("a", "alice", "Alice", false, code).Error.Should().Contain("your own");
        svc.JoinRoom("b", "bob", "Bob", false, "ZZZZ").Error.Should().Be("No race with that code.");
        svc.CreateRoom("a", "alice", "Alice", false, 2).Should().BeNull("one open race per connection");
    }

    private static void Rematch_StartsOnlyWhenBothAsk_ThenResets()
    {
        var svc = new PoMarbleRaceOnlineService();
        svc.Enqueue("a", "alice", "Alice", false, 2);
        svc.Enqueue("b", "bob", "Bob", false, 2);

        svc.RequestRematch("x").Should().BeNull("not in a race");
        var first = svc.RequestRematch("b")!;
        first.State.Should().Be(new MarbleRaceRematch(HostWants: false, GuestWants: true, Agreed: false));
        var second = svc.RequestRematch("a")!;
        second.State.Agreed.Should().BeTrue();
        second.GuestConnectionId.Should().Be("b");

        svc.RequestRematch("a")!.State.Should().Be(new MarbleRaceRematch(true, false, false), "an agreed rematch clears both asks");
    }

    private static void Leaving_ClosesAnOpenCode()
    {
        var svc = new PoMarbleRaceOnlineService();
        var code = svc.CreateRoom("a", "alice", "Alice", false, 2)!;
        svc.Remove("a");
        svc.JoinRoom("b", "bob", "Bob", false, code).Error.Should().Be("No race with that code.");
    }
}
