using FluentAssertions;
using PoMiniGames.Shared.Games.PoMule;

namespace PoMiniGames.Unit;

/// <summary>Who starts with what, and how a PoMule match is scored at the end.</summary>
public sealed class PoMuleScoringTests
{
    [Theory]
    [InlineData(Species.Gollumoid, 1000)]
    [InlineData(Species.Voltronix, 1000)]
    [InlineData(Species.OreGorger, 1000)]
    [InlineData(Species.CrystiteWeaver, 800)]
    [InlineData(Species.ZephyrFlapper, 1600)]
    [InlineData(Species.BonzCrusher, 1000)]
    [InlineData(Species.SpheroidDrifter, 1000)]
    [InlineData(Species.Humanoid, 1200)]
    public void NewMatch_SeatsTheHumanOnTheirSpecies_WithThePrdFunds(Species species, int cash)
    {
        var match = MatchState.New(seed: 5, humanSpecies: species);

        match.Players.Should().HaveCount(PoMuleTuning.Seats);
        match.Players[0].Should().Match<PlayerState>(p =>
            p.Archetype == Archetype.Human && p.Species == species && p.Cash == cash);
        // Eight species for sixteen seats: each one exactly twice.
        match.Players.GroupBy(p => p.Species).Should().HaveCount(8).And.OnlyContain(g => g.Count() == 2);
        // Seats 1–15 hold each AI personality twice and one a third time; the seed decides who sits where.
        var personalities = match.Players.Skip(1).GroupBy(p => p.Archetype).ToList();
        personalities.Should().HaveCount(7);
        personalities.Select(g => g.Count()).Order().Should().Equal(2, 2, 2, 2, 2, 2, 3);
        match.Players.Select(p => p.Name).Should().OnlyHaveUniqueItems("a repeated personality is told apart: Hoarder, Hoarder II");
        match.Players.Should().OnlyContain(p =>
            p.Goods[(int)Good.Food] == 4 && p.Goods[(int)Good.Energy] == 2 && p.Cash == PoMuleSpecies.Get(p.Species).StartingCash);
        (match.Month, match.Phase).Should().Be((1, Phase.Land));
        match.Store.Mules.Should().Be(PoMuleTuning.StoreStartMules);

        var demo = MatchState.New(seed: 5, humanSpecies: null);
        demo.Players.Should().NotContain(p => p.Archetype == Archetype.Human);
    }

    [Fact]
    public void NetWorth_IsCashPlusLandPlusMulesPlusGoodsAtStorePrices_AndStandingsRankByIt()
    {
        var match = MatchState.New(seed: 9, humanSpecies: Species.Humanoid);
        var you = match.Players[0];
        you.Cash = 300;
        you.Goods[(int)Good.Food] = 10;      // 10 × 30
        you.Goods[(int)Good.Energy] = 0;
        you.Goods[(int)Good.Smithore] = 2;   //  2 × 50
        match.Owner[0] = 0;                  // 2 plots × 500
        match.Owner[1] = 0;
        match.Installed[1] = (sbyte)Good.Food; // 1 M.U.L.E. × 350

        PoMuleScoring.NetWorth(match, seat: 0).Should().Be(300 + 300 + 100 + 1000 + 350);

        var standings = PoMuleScoring.Standings(match);
        standings.Select(s => s.Rank).Should().Equal(Enumerable.Range(1, PoMuleTuning.Seats));
        standings.Select(s => s.NetWorth).Should().BeInDescendingOrder();
        standings[0].Seat.Should().Be(0);
    }

    [Theory]
    [InlineData(120_000, 0, true)]
    [InlineData(120_000, 1, true)]
    [InlineData(119_999, 0, false)]
    [InlineData(180_000, 2, false)]
    public void Colony_SurvivesOnlyWithEnoughCombinedWealth_AndFewCrisisMonths(int combined, int crisisMonths, bool survives) =>
        PoMuleScoring.ColonySurvives(combined, crisisMonths).Should().Be(survives);
}
