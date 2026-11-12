using FluentAssertions;
using PoMiniGames.Shared.Games.PoMule;

namespace PoMiniGames.Unit;

/// <summary>
/// The PoMule planet: a 24×8 grid whose columns wrap and whose rows do not, generated from a
/// seed so a saved match and a replay see the same land.
/// </summary>
public sealed class PoMuleMapTests
{
    [Theory]
    [InlineData(0, 23, 1)]
    [InlineData(23, 0, 1)]
    [InlineData(2, 14, 12)]
    [InlineData(5, 5, 0)]
    [InlineData(1, 20, 5)]
    public void ColumnDistance_GoesTheShortWayRound(int a, int b, int expected) =>
        PoMuleMap.ColumnDistance(a, b).Should().Be(expected);

    [Theory]
    [InlineData(24, 0)]
    [InlineData(-1, 23)]
    [InlineData(47, 23)]
    [InlineData(7, 7)]
    public void Wrap_BringsAnyColumnBackOntoThePlanet(int column, int expected) =>
        PoMuleMap.Wrap(column).Should().Be(expected);

    /// <summary>
    /// Each row runs one scenario: a private method below, named after what it checks.
    /// </summary>
    [Theory]
    [InlineData(nameof(Generate_BuildsAPlanetWithTheSpecifiedMix_ForEverySeed))]
    [InlineData(nameof(SameSeed_GivesTheSamePlanet_AndTheRngResumesFromItsSavedState))]
    public Task Scenario(string name) => Scenarios.RunAsync(this, name);

    private static void Generate_BuildsAPlanetWithTheSpecifiedMix_ForEverySeed()
    {
        for (ulong seed = 1; seed <= 50; seed++)
        {
            var map = PoMuleMap.Generate(new PoMuleRng(seed));

            map.Plots.Should().HaveCount(PoMuleMap.Columns * PoMuleMap.Rows);
            foreach (var column in PoMuleMap.TownColumns)
                map[column, PoMuleMap.TownRow].Terrain.Should().Be(Terrain.Town);
            map.Plots.Count(p => p.Terrain == Terrain.Town).Should().Be(4);

            map.Plots.Count(p => p.Terrain == Terrain.River).Should().BeInRange(16, 24, $"seed {seed}");
            map.Plots.Count(p => p.Terrain == Terrain.Mountain).Should().BeInRange(34, 46, $"seed {seed}");
            map.Plots.Count(p => p.Terrain == Terrain.Crater).Should().BeInRange(4, 6, $"seed {seed}");

            map.Plots.Where(p => p.Terrain == Terrain.Mountain).Should().OnlyContain(p => p.Peaks >= 1 && p.Peaks <= 3);
            map.Plots.Where(p => p.Terrain != Terrain.Mountain).Should().OnlyContain(p => p.Peaks == 0);
            map.Plots.Where(p => p.Terrain == Terrain.Crater).Should().OnlyContain(p => p.Crystite >= 1 && p.Crystite <= 3);
            map.Plots.Where(p => p.Terrain is Terrain.River or Terrain.Town).Should().OnlyContain(p => p.Crystite == 0);
            map.Plots.Where(p => p.Terrain is Terrain.Plains or Terrain.Mountain).Should().OnlyContain(p => p.Crystite <= 1);
        }
    }

    private static void SameSeed_GivesTheSamePlanet_AndTheRngResumesFromItsSavedState()
    {
        PoMuleMap.Generate(new PoMuleRng(42)).Plots
            .Should().Equal(PoMuleMap.Generate(new PoMuleRng(42)).Plots);
        PoMuleMap.Generate(new PoMuleRng(42)).Plots
            .Should().NotEqual(PoMuleMap.Generate(new PoMuleRng(43)).Plots);

        var rng = new PoMuleRng(7);
        for (var i = 0; i < 10; i++) rng.Next(100).Should().BeInRange(0, 99);
        var resumed = new PoMuleRng(1) { State = rng.State };
        resumed.Next().Should().Be(rng.Next(), "a saved match must continue the same sequence");
    }
}
