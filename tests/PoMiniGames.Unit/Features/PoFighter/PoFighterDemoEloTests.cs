using FluentAssertions;
using PoMiniGames.Domain.Models;
using PoMiniGames.Domain.Services;
using PoMiniGamesClient.Features.PoFighter;

namespace PoMiniGames.Unit.Features.PoFighter;

/// <summary>
/// The attract-mode demo's ratings: a completed demo match is one bout on the live fighter Elo
/// board, a match left early or reported twice counts nothing, and a fighter never plays itself.
/// </summary>
public sealed class PoFighterDemoEloTests
{
    private static readonly PairwiseEloCalculator Elo = new(new PairwiseEloOptions());

    [Fact]
    public void ACompletedDemoMatch_MovesBothRatings_AndTheWinCardShowsTheChange()
    {
        var demo = new PoFighterDemoElo();
        var bout = demo.Admit(1, "kim", "P1", isDraw: false);
        bout.Should().Be(new PoFighterBoutResultRequest("kim", "p1", false), because: "ids are posted canonically");

        // What the server does with it (the board's own calculator): two unrated fighters at 1000, K 32.
        var delta = Elo.Delta(Elo.SeedElo, Elo.SeedElo, bout!.IsDraw);
        var after = new[]
        {
            new PoFighterFighterRating { FighterId = "kim", Elo = Elo.ApplyDelta(Elo.SeedElo, delta) },
            new PoFighterFighterRating { FighterId = "p1", Elo = Elo.ApplyDelta(Elo.SeedElo, -delta) },
        };
        PoFighterDemoElo.Change(bout, new Dictionary<string, int>(), after).Should().Equal(1016, 16, 984, -16);

        // A draw is half a point each: the higher-rated fighter gives some back, no seed rule.
        var draw = demo.Admit(2, "p1", "kim", isDraw: true)!;
        var before = new Dictionary<string, int> { ["p1"] = 984, ["kim"] = 1016 };
        var d = Elo.Delta(984, 1016, isDraw: true);
        d.Should().BePositive(because: "the lower-rated side of a draw gains");
        PoFighterDemoElo.Change(draw, before, [
            new PoFighterFighterRating { FighterId = "p1", Elo = 984 + d },
            new PoFighterFighterRating { FighterId = "kim", Elo = 1016 - d },
        ]).Should().Equal(984 + d, d, 1016 - d, -d);
        PoFighterDemoElo.Change(draw, before, null).Should().BeNull(because: "a post that failed shows no numbers");
    }

    [Fact]
    public void AMatchCountsOnce_StudioFightersAreUnrated_AndNoFighterPlaysItself()
    {
        var demo = new PoFighterDemoElo();
        // A demo left mid-match never reaches Admit (demo.js reports only its 'match' event), so
        // the first report here is match 3: nothing before it was rated.
        demo.Admit(3, "kim", "p1", false).Should().NotBeNull();
        demo.Admit(3, "kim", "p1", false).Should().BeNull(because: "a re-sent or replayed match counts once");
        demo.Admit(4, "studio-ab12", "p1", false).Should().BeNull(because: "Studio fighters stay unrated");
        demo.Admit(5, "kim", "KIM", false).Should().BeNull(because: "a mirror match is the same character: no pair to rate");
        demo.Admit(6, null, "kim", false).Should().BeNull();
        demo.Admit(4, "p1", "kim", true).Should().NotBeNull(because: "a refused report does not use up its match number");
    }
}
