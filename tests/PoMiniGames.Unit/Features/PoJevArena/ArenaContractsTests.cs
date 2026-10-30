using FluentAssertions;
using Microsoft.Extensions.Time.Testing;
using PoMiniGames.Features.PoJevArena;
using PoMiniGames.Shared.Games.PoJevArena;
using Xunit;

namespace PoMiniGames.Unit.Features.PoJevArena;

/// <summary>The server-held match registry contract that gates result reporting.</summary>
public sealed class ArenaContractsTests
{
    private const string Me = "id:player-1";

    [Theory]
    [InlineData("registry-owner-only")]
    [InlineData("registry-result-one-shot")]
    [InlineData("registry-result-needs-decisions")]
    [InlineData("registry-result-must-be-plausible")]
    [InlineData("registry-sliding-expiry")]
    [InlineData("registry-roster-frozen")]
    public void MatchRegistry_Contracts(string scenario)
    {
        var clock = new FakeTimeProvider(new DateTimeOffset(2026, 9, 25, 23, 58, 0, TimeSpan.Zero));
        var registry = new ArenaMatchRegistry(clock);
        var roster = new ArenaRoster(
            [.. Enumerable.Repeat(PoJevArenaCatalog.Presets[0], 10)],
            [.. Enumerable.Repeat(PoJevArenaCatalog.Presets[1], 10)]);

        switch (scenario)
        {
            case "registry-owner-only":
                {
                    var match = registry.Register(Me, roster, ArenaMode.OnePlayer);
                    registry.Find(match.MatchId, Me).Should().BeSameAs(match);
                    registry.Find(match.MatchId, "id:someone-else").Should().BeNull("another identity must not see or drive my match");
                    registry.Find("no-such-match", Me).Should().BeNull();
                    break;
                }
            case "registry-result-one-shot":
                {
                    var match = registry.Register(Me, roster, ArenaMode.OnePlayer);
                    match.RecordDecisions(ArenaMatchRegistry.MinDecisionsForResult);
                    clock.Advance(TimeSpan.FromSeconds(10));
                    match.TryClaimResult(10, clock.GetUtcNow()).Should().Be(ArenaResultGate.Accepted);
                    match.TryClaimResult(10, clock.GetUtcNow()).Should().Be(ArenaResultGate.AlreadyReported);
                    // A failed stats write hands the claim back, so the retry is not a 409.
                    match.ReleaseResultClaim();
                    match.TryClaimResult(10, clock.GetUtcNow()).Should().Be(ArenaResultGate.Accepted);
                    break;
                }
            case "registry-result-needs-decisions":
                {
                    var match = registry.Register(Me, roster, ArenaMode.OnePlayer);
                    clock.Advance(TimeSpan.FromSeconds(60));
                    match.RecordDecisions(ArenaMatchRegistry.MinDecisionsForResult - 1);
                    match.TryClaimResult(10, clock.GetUtcNow()).Should().Be(ArenaResultGate.TooFewDecisions,
                        "stats cannot be inflated without real brain decisions");
                    match.RecordDecisions(1);
                    match.TryClaimResult(60, clock.GetUtcNow()).Should().Be(ArenaResultGate.TooFewDecisions,
                        "a 60 s claim needs decisions in proportion to its length");
                    match.RecordDecisions(200);
                    match.TryClaimResult(60, clock.GetUtcNow()).Should().Be(ArenaResultGate.Accepted);
                    break;
                }
            case "registry-result-must-be-plausible":
                {
                    var match = registry.Register(Me, roster, ArenaMode.OnePlayer);
                    match.RecordDecisions(1_000);
                    clock.Advance(TimeSpan.FromSeconds(5));
                    match.TryClaimResult(120, clock.GetUtcNow()).Should().Be(ArenaResultGate.Implausible,
                        "a 2-minute match cannot finish 5 s after it was registered");
                    match.TryClaimResult(4, clock.GetUtcNow()).Should().Be(ArenaResultGate.Implausible,
                        "a result needs a minimum match length");
                    break;
                }
            case "registry-sliding-expiry":
                {
                    var match = registry.Register(Me, roster, ArenaMode.OnePlayer);
                    clock.Advance(TimeSpan.FromMinutes(10));
                    registry.Find(match.MatchId, Me).Should().NotBeNull("each lookup slides the expiry");
                    clock.Advance(TimeSpan.FromMinutes(10));
                    registry.Find(match.MatchId, Me).Should().NotBeNull();
                    clock.Advance(ArenaMatchRegistry.IdleExpiry + TimeSpan.FromSeconds(1));
                    registry.Find(match.MatchId, Me).Should().BeNull("an idle match expires");
                    break;
                }
            case "registry-roster-frozen":
                {
                    var a = registry.Register(Me, roster, ArenaMode.Demo);
                    var b = registry.Register(Me, roster, ArenaMode.Demo);
                    a.MatchId.Should().NotBe(b.MatchId);
                    a.Roster.Should().BeSameAs(roster);
                    a.Mode.Should().Be(ArenaMode.Demo);
                    break;
                }
            default:
                throw new ArgumentOutOfRangeException(nameof(scenario), scenario, null);
        }
    }
}
