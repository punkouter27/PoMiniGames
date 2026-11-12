using FluentAssertions;
using PoMiniGames.Shared.Games.PoMule;

namespace PoMiniGames.Unit;

/// <summary>
/// The development phase: what the engine allows when the renderer reports that an avatar
/// reached a building or a plot, bumped someone, or ran out of clock.
/// </summary>
public sealed class PoMuleDevelopmentTests
{
    private static MatchState Started(Species species = Species.Humanoid, int month = 1, int? food = null)
    {
        var match = MatchState.New(seed: 11, humanSpecies: species);
        match.Month = month;
        if (food is { } f) match.Players[0].Goods[(int)Good.Food] = f;
        PoMuleDevelopment.Begin(match);
        return match;
    }

    private static int OwnPlot(MatchState match, int seat = 0, int column = 5, int row = 1)
    {
        var plot = PoMuleMap.Index(column, row);
        match.Owner[plot] = (sbyte)seat;
        return plot;
    }

    [Theory]
    [InlineData(Species.Humanoid, 4, 1, 100, 1)]       // needs 3, has 4
    [InlineData(Species.Humanoid, 2, 5, 50, 0)]        // needs 4, has half
    [InlineData(Species.Humanoid, 1, 9, 40, 0)]        // needs 5, has a fifth: floor is 40%
    [InlineData(Species.Humanoid, 0, 1, 40, 0)]        // starving: still the shortest month
    [InlineData(Species.ZephyrFlapper, 4, 1, 100, 1)]  // +10% speed, same clock as anyone
    [InlineData(Species.ZephyrFlapper, 2, 5, 50, 0)]
    public void TheMonthsFoodIsEatenByItsEnd_AndTheHungryGetAShortMonth(
        Species species, int food, int month, int timePercent, int foodLeft)
    {
        var match = Started(species, month, food);

        match.Players[0].TimePercent.Should().Be(timePercent);
        PoMuleDevelopment.TimeLeft(match, 0).Should().Be(PoMuleTuning.DevelopmentSeconds * PoMuleTuning.TicksPerSecond * timePercent / 100);
        PoMuleDevelopment.Speed(match, 0).Should().Be(species == Species.ZephyrFlapper ? 110 : 100, "hunger costs time, not pace");
        match.Players[0].Goods[(int)Good.Food].Should().Be(food, "the ration is eaten over the month, not at its start");
        match.ClockTicks.Should().Be(PoMuleTuning.DevelopmentSeconds * PoMuleTuning.TicksPerSecond);

        PoMuleDevelopment.End(match);
        match.Players[0].Goods[(int)Good.Food].Should().Be(foodLeft);
    }

    /// <summary>
    /// Each row runs one scenario: a private method below, named after what it checks.
    /// </summary>
    [Theory]
    [InlineData(nameof(BuyOutfitInstall_MovesCashStockAndTheMule_AndInstallingOnAWorkedPlotSwaps))]
    [InlineData(nameof(AMuleBolts_OnADashBump_OnSomeoneElsesLand_AndWhenTheClockRunsOut))]
    [InlineData(nameof(Crystite_IsHiddenUntilAssayed_ExceptFromTheCrystiteWeaver))]
    public Task Scenario(string name) => Scenarios.RunAsync(this, name);

    private static void BuyOutfitInstall_MovesCashStockAndTheMule_AndInstallingOnAWorkedPlotSwaps()
    {
        var match = Started();
        var you = match.Players[0];
        var plot = OwnPlot(match);

        PoMuleDevelopment.BuyMule(match, 0).Should().Be(Outcome.Ok);
        PoMuleDevelopment.Outfit(match, 0, Good.Food).Should().Be(Outcome.Ok);
        PoMuleDevelopment.Outfit(match, 0, Good.Food).Should().Be(Outcome.Ok, "already outfitted for Food");
        you.Cash.Should().Be(1200 - 100 - 25, "and not charged twice for it");
        match.Store.Mules.Should().Be(27);
        (you.HasMule, you.Outfit).Should().Be((true, (sbyte)Good.Food));

        PoMuleDevelopment.Install(match, 0, plot).Should().Be(Outcome.Ok);
        match.Installed[plot].Should().Be((sbyte)Good.Food);
        you.HasMule.Should().BeFalse();

        PoMuleDevelopment.BuyMule(match, 0);
        PoMuleDevelopment.Outfit(match, 0, Good.Energy);
        PoMuleDevelopment.Install(match, 0, plot).Should().Be(Outcome.Ok);
        match.Installed[plot].Should().Be((sbyte)Good.Energy);
        (you.HasMule, you.Outfit).Should().Be((true, (sbyte)Good.Food), "the old M.U.L.E. comes back out on the tether");
    }

    [Theory]
    [InlineData("mule: no cash", Outcome.NoCash)]
    [InlineData("mule: sold out", Outcome.SoldOut)]
    [InlineData("mule: already towing", Outcome.NotAllowed)]
    [InlineData("outfit: nothing in tow", Outcome.NotAllowed)]
    [InlineData("outfit: no cash", Outcome.NoCash)]
    [InlineData("install: not outfitted", Outcome.NotAllowed)]
    [InlineData("mule: in the pub", Outcome.NotAllowed)]
    [InlineData("mule: clock ran out", Outcome.NotAllowed)]
    [InlineData("mule: hungry, time up", Outcome.NotAllowed)]
    public void RefusedActions_ChangeNothing_AndNeverLeaveANegativeBalance(string scenario, Outcome expected)
    {
        var match = scenario == "mule: hungry, time up" ? Started(food: 0) : Started();
        var you = match.Players[0];
        var plot = OwnPlot(match);
        Outcome actual;
        switch (scenario)
        {
            case "mule: no cash": you.Cash = 99; actual = PoMuleDevelopment.BuyMule(match, 0); break;
            case "mule: sold out": match.Store.Mules = 0; actual = PoMuleDevelopment.BuyMule(match, 0); break;
            case "mule: already towing": PoMuleDevelopment.BuyMule(match, 0); actual = PoMuleDevelopment.BuyMule(match, 0); break;
            case "outfit: nothing in tow": actual = PoMuleDevelopment.Outfit(match, 0, Good.Food); break;
            case "outfit: no cash": PoMuleDevelopment.BuyMule(match, 0); you.Cash = 24; actual = PoMuleDevelopment.Outfit(match, 0, Good.Food); break;
            case "install: not outfitted": PoMuleDevelopment.BuyMule(match, 0); actual = PoMuleDevelopment.Install(match, 0, plot); break;
            case "mule: in the pub": PoMuleDevelopment.EnterPub(match, 0); actual = PoMuleDevelopment.BuyMule(match, 0); break;
            case "mule: clock ran out": match.ClockTicks = 0; actual = PoMuleDevelopment.BuyMule(match, 0); break;
            // Starving leaves 40% of the month: 18 s in, the others play on and this one is done.
            default: match.ClockTicks = 270; actual = PoMuleDevelopment.BuyMule(match, 0); break;
        }
        var (cash, mules, towing) = (you.Cash, match.Store.Mules, you.HasMule);

        actual.Should().Be(expected);
        // Asking again changes nothing either.
        if (scenario.StartsWith("mule", StringComparison.Ordinal)) PoMuleDevelopment.BuyMule(match, 0).Should().Be(expected);
        (you.Cash, match.Store.Mules, you.HasMule).Should().Be((cash, mules, towing));
        you.Cash.Should().BeGreaterThanOrEqualTo(0);
        match.Installed[plot].Should().Be(MatchState.Nobody);
    }

    private static void AMuleBolts_OnADashBump_OnSomeoneElsesLand_AndWhenTheClockRunsOut()
    {
        MatchState Towing(Species species = Species.Humanoid)
        {
            var m = Started(species);
            PoMuleDevelopment.BuyMule(m, 0);
            PoMuleDevelopment.Outfit(m, 0, Good.Smithore);
            return m;
        }

        var bumped = Towing();
        PoMuleDevelopment.Bump(bumped, victim: 0, dashing: false).Should().BeFalse("a walking-pace nudge is harmless");
        PoMuleDevelopment.Bump(bumped, victim: 0, dashing: true).Should().BeTrue();
        bumped.Players[0].HasMule.Should().BeFalse();
        PoMuleDevelopment.Bump(bumped, victim: 0, dashing: true).Should().BeFalse("nothing left to lose");
        PoMuleDevelopment.BuyMule(bumped, 0);
        PoMuleDevelopment.Bump(bumped, victim: 0, dashing: true).Should().BeFalse("nobody loses two to a bump in one month");
        bumped.BumpRunaways.Should().Be(1);

        var trespass = Towing();
        var theirs = OwnPlot(trespass, seat: 3);
        PoMuleDevelopment.Install(trespass, 0, theirs).Should().Be(Outcome.Runaway);
        trespass.Installed[theirs].Should().Be(MatchState.Nobody);
        trespass.Players[0].HasMule.Should().BeFalse();

        var late = Towing();
        late.ClockTicks = 0;
        PoMuleDevelopment.End(late).Should().Equal(0);
        late.Players[0].HasMule.Should().BeFalse();
        late.Players[0].Cash.Should().Be(1200 - 100 - 75, "no refund");

        // The Stabilizer keeps its M.U.L.E. about half the time.
        var kept = 0;
        var drifter = Towing(Species.SpheroidDrifter);
        for (var i = 0; i < 1000; i++)
        {
            drifter.Players[0].HasMule = true;
            drifter.Players[0].Spooked = false;
            if (!PoMuleDevelopment.Bump(drifter, victim: 0, dashing: true)) kept++;
        }
        kept.Should().BeInRange(420, 580);
    }

    [Theory]
    [InlineData(450, 1, 180)]   // 45 s × (3 + 1)
    [InlineData(450, 12, 250)]  // capped
    [InlineData(100, 12, 150)]
    [InlineData(105, 1, 40)]    // part seconds do not pay
    [InlineData(0, 1, 0)]
    public void Pub_PaysForTheSecondsLeft_AndTakesTheColonistOffTheMap(int ticksLeft, int month, int payout)
    {
        var match = Started(month: month, food: 9); // well fed: the whole clock is theirs
        match.ClockTicks = ticksLeft;
        var cash = match.Players[0].Cash;

        PoMuleDevelopment.PubPayout(match, 0).Should().Be(payout, "the offer shown is the amount paid");
        PoMuleDevelopment.EnterPub(match, 0).Should().Be(payout);

        match.Players[0].Cash.Should().Be(cash + payout);
        match.Players[0].InPub.Should().BeTrue();
        PoMuleDevelopment.EnterPub(match, 0).Should().Be(0, "one visit a month");
        match.Players[0].Cash.Should().Be(cash + payout);
    }

    private static void Crystite_IsHiddenUntilAssayed_ExceptFromTheCrystiteWeaver()
    {
        var match = Started();
        var plot = PoMuleMap.Index(6, 6);

        PoMuleDevelopment.CanSeeCrystite(match, 0, plot).Should().BeFalse();
        PoMuleDevelopment.Survey(match, 0, plot).Should().Be(Outcome.NotAllowed, "visit the Assay Office first");
        PoMuleDevelopment.VisitAssayOffice(match, 0).Should().Be(Outcome.Ok);
        PoMuleDevelopment.Survey(match, 0, plot).Should().Be(Outcome.Ok);
        PoMuleDevelopment.CanSeeCrystite(match, 0, plot).Should().BeTrue();
        PoMuleDevelopment.CanSeeCrystite(match, 5, plot).Should().BeTrue("an assay result is public");
        PoMuleDevelopment.Survey(match, 0, PoMuleMap.Index(7, 6)).Should().Be(Outcome.NotAllowed, "one survey per visit");

        var weaver = Started(Species.CrystiteWeaver);
        PoMuleDevelopment.CanSeeCrystite(weaver, 0, plot).Should().BeTrue();
        PoMuleDevelopment.CanSeeCrystite(weaver, 1, plot).Should().BeFalse();
    }
}
