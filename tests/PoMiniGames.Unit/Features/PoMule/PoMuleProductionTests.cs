using FluentAssertions;
using PoMiniGames.Shared.Games.PoMule;

namespace PoMiniGames.Unit;

/// <summary>Production, energy shutdowns, spoilage and the monthly colony event.</summary>
public sealed class PoMuleProductionTests
{
    private static MatchState Match(Species species = Species.Humanoid) => MatchState.New(seed: 21, humanSpecies: species);

    /// <summary>Gives <paramref name="seat"/> a plot of the given terrain with a working M.U.L.E. on it.</summary>
    private static int Work(MatchState match, int index, Terrain terrain, Good good, int seat = 0, byte peaks = 0, byte crystite = 0)
    {
        match.Map.Plots[index] = new Plot(terrain, peaks, crystite);
        match.Owner[index] = (sbyte)seat;
        match.Installed[index] = (sbyte)good;
        return index;
    }

    [Theory]
    // The base table.
    [InlineData(ColonyEvent.None, Terrain.River, 0, 0, Good.Food, 4)]
    [InlineData(ColonyEvent.None, Terrain.River, 0, 0, Good.Energy, 2)]
    [InlineData(ColonyEvent.None, Terrain.River, 0, 0, Good.Smithore, 0)]   // a river cannot be mined
    [InlineData(ColonyEvent.None, Terrain.Plains, 0, 1, Good.Food, 2)]
    [InlineData(ColonyEvent.None, Terrain.Plains, 0, 1, Good.Energy, 3)]
    [InlineData(ColonyEvent.None, Terrain.Plains, 0, 1, Good.Crystite, 1)]
    [InlineData(ColonyEvent.None, Terrain.Mountain, 1, 0, Good.Food, 1)]
    [InlineData(ColonyEvent.None, Terrain.Mountain, 1, 0, Good.Smithore, 2)]
    [InlineData(ColonyEvent.None, Terrain.Mountain, 3, 0, Good.Smithore, 4)]
    [InlineData(ColonyEvent.None, Terrain.Crater, 0, 4, Good.Crystite, 4)]
    [InlineData(ColonyEvent.None, Terrain.Crater, 0, 4, Good.Food, 1)]
    // What each weather event does to it.
    [InlineData(ColonyEvent.SolarFlare, Terrain.Plains, 0, 0, Good.Energy, 4)]
    [InlineData(ColonyEvent.AcidRain, Terrain.River, 0, 0, Good.Food, 6)]
    [InlineData(ColonyEvent.AcidRain, Terrain.Plains, 0, 0, Good.Food, 2)]
    [InlineData(ColonyEvent.AcidRain, Terrain.Plains, 0, 0, Good.Energy, 1)]
    [InlineData(ColonyEvent.Planetquake, Terrain.Mountain, 3, 0, Good.Smithore, 2)]
    [InlineData(ColonyEvent.Planetquake, Terrain.Crater, 0, 4, Good.Crystite, 2)]
    public void OnePlot_YieldsItsTerrainBase_AdjustedByTheMonthsEvent(
        ColonyEvent weather, Terrain terrain, byte peaks, byte crystite, Good good, int expected)
    {
        var match = Match();
        Work(match, 0, terrain, good, peaks: peaks, crystite: crystite);
        match.Players[0].Goods[(int)Good.Energy] = 5;

        var report = PoMuleProduction.Run(match, weather, vary: false);

        report.Produced[0][(int)good].Should().Be(expected);
    }

    [Theory]
    [InlineData(Species.Humanoid, 10, 4, 3, 3)]    // two river farms side by side make 5 each, not 4
    [InlineData(Species.Gollumoid, 12, 4, 3, 3)]   // +15% of 10 river Food, rounded
    [InlineData(Species.OreGorger, 10, 5, 3, 3)]   // +15% of 4 Smithore, rounded
    [InlineData(Species.Voltronix, 10, 4, 3, 2)]   // one free Energy covers one M.U.L.E.
    public void AColony_ProducesAcrossItsPlots_WithSpeciesBonuses_AndPaysEnergyToRunThem(
        Species species, int food, int smithore, int energyMade, int energySpent)
    {
        var match = Match(species);
        Work(match, 0, Terrain.River, Good.Food);
        Work(match, 1, Terrain.River, Good.Food);
        Work(match, 2, Terrain.Mountain, Good.Smithore, peaks: 3);
        Work(match, 3, Terrain.Plains, Good.Energy);
        match.Players[0].Goods[(int)Good.Energy] = 3;

        var report = PoMuleProduction.Run(match, ColonyEvent.None, vary: false);

        report.Produced[0].Should().Equal(food, energyMade, smithore, 0);
        // Three M.U.L.E.s that are not making Energy need one Energy each; then this month's 3 arrive.
        match.Players[0].Goods[(int)Good.Energy].Should().Be(
            PoMuleProduction.AfterSpoilage(Good.Energy, 3 - energySpent + energyMade, need: 3));
        report.IdleMules[0].Should().Be(0);

        // With random variance on, every plot stays within one unit of its base and never negative.
        var varied = Match(species);
        Work(varied, 0, Terrain.River, Good.Food);
        varied.Players[0].Goods[(int)Good.Energy] = 3;
        PoMuleProduction.Run(varied, ColonyEvent.None).Produced[0][(int)Good.Food].Should().BeInRange(3, 6);
    }

    /// <summary>
    /// Each row runs one scenario: a private method below, named after what it checks.
    /// </summary>
    [Theory]
    [InlineData(nameof(ShortOfEnergy_TheLeastValuableMulesGoIdle_AndThreeShortColonistsMakeACrisisMonth))]
    [InlineData(nameof(Events_HitOneFoodPlot_StealCrystite_BurnTheStore_AndComeUpAboutThreeMonthsInFour))]
    public Task Scenario(string name) => Scenarios.RunAsync(this, name);

    private static void ShortOfEnergy_TheLeastValuableMulesGoIdle_AndThreeShortColonistsMakeACrisisMonth()
    {
        var match = Match();
        var food = Work(match, 0, Terrain.River, Good.Food);                    // 4 × 30 = 120
        // The two mines are neighbours, so each digs one more than its mountain alone would give.
        var smithore = Work(match, 1, Terrain.Mountain, Good.Smithore, peaks: 3); // 5 × 50 = 250
        var weak = Work(match, 2, Terrain.Mountain, Good.Smithore, peaks: 1);     // 3 × 50 = 150
        match.Players[0].Goods[(int)Good.Energy] = 1;

        var report = PoMuleProduction.Run(match, ColonyEvent.None, vary: false);

        report.IdleMules[0].Should().Be(2);
        report.Produced[0].Should().Equal(0, 0, 5, 0);
        report.IdlePlots.Should().BeEquivalentTo([food, weak]);
        report.IdlePlots.Should().NotContain(smithore);
        match.Players[0].Goods[(int)Good.Energy].Should().Be(0);
        match.Players[0].WentShort.Should().BeTrue();
        match.CrisisMonths.Should().Be(0, "one colonist short is not a colony crisis");

        match.Players[1].WentShort = true;   // e.g. started the month hungry
        match.Players[2].WentShort = true;
        match.Players[0].Goods[(int)Good.Energy] = 0;
        PoMuleProduction.Run(match, ColonyEvent.None, vary: false);
        match.CrisisMonths.Should().Be(1);
    }

    [Theory]
    [InlineData(Good.Food, 10, 4, 7)]      // half of the 6 above need rots
    [InlineData(Good.Food, 3, 4, 3)]       // nothing above need, nothing rots
    [InlineData(Good.Food, 5, 4, 5)]       // half of one unit rounds down to none
    [InlineData(Good.Energy, 9, 1, 7)]     // a quarter of the 8 above need leaks
    [InlineData(Good.Smithore, 60, 0, 50)] // warehouse holds 50
    [InlineData(Good.Crystite, 55, 0, 50)]
    [InlineData(Good.Crystite, 12, 0, 12)]
    public void Spoilage_TakesHalfTheSpareFood_AQuarterOfTheSpareEnergy_AndCapsOreAt50(Good good, int held, int need, int left) =>
        PoMuleProduction.AfterSpoilage(good, held, need).Should().Be(left);

    private static void Events_HitOneFoodPlot_StealCrystite_BurnTheStore_AndComeUpAboutThreeMonthsInFour()
    {
        var pest = Match();
        Work(pest, 0, Terrain.River, Good.Food);
        Work(pest, 1, Terrain.Plains, Good.Food);
        pest.Players[0].Goods[(int)Good.Energy] = 5;
        var report = PoMuleProduction.Run(pest, ColonyEvent.PestAttack, vary: false);
        report.Produced[0][(int)Good.Food].Should().Be(3, "the pests eat the best Food plot, not the worst");
        report.PestPlot.Should().Be(0);

        var pirates = Match();
        foreach (var p in pirates.Players) p.Goods[(int)Good.Crystite] = 9;
        PoMuleEvents.Aftermath(pirates, ColonyEvent.SpacePirates);
        pirates.Players.Should().OnlyContain(p => p.Goods[(int)Good.Crystite] == 0);

        var fire = Match();
        fire.Store.Stock[(int)Good.Crystite] = 6;
        PoMuleEvents.Aftermath(fire, ColonyEvent.StoreFire);
        fire.Store.Stock.Should().Equal(0, 0, 0, 6);
        fire.Store.Mules.Should().Be(PoMuleTuning.StoreStartMules, "the M.U.L.E. corral is outside");

        // Roll long enough and every event has struck exactly as often as its cap allows.
        var months = Match();
        var rolls = Enumerable.Range(0, 400).Select(_ => PoMuleEvents.Roll(months)).ToList();
        foreach (var e in Enum.GetValues<ColonyEvent>().Where(e => e is not (ColonyEvent.None or ColonyEvent.ShipReturns)))
            rolls.Count(r => r == e).Should().Be(PoMuleTuning.EventCap[(int)e], e.ToString());
        months.Month = PoMuleTuning.Months;
        PoMuleEvents.Roll(months).Should().Be(ColonyEvent.ShipReturns, "the last month has no event: the ship comes back");
        Enum.GetValues<ColonyEvent>().Should().OnlyContain(e => PoMuleEvents.Headline(e).Length > 0);
    }
}
