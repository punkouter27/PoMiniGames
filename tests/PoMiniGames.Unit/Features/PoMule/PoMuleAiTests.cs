using FluentAssertions;
using PoMiniGames.Shared.Games.PoMule;

namespace PoMiniGames.Unit;

/// <summary>
/// The seven computer personalities. Each test puts one in a scripted position and checks the
/// decision that makes it that personality.
/// </summary>
public sealed class PoMuleAiTests
{
    private const int Ai = 1;

    private static MatchState Match(Archetype archetype, Species species = Species.Humanoid)
    {
        var match = MatchState.New(seed: 41, humanSpecies: Species.CrystiteWeaver);
        match.Players[Ai].Archetype = archetype;
        match.Players[Ai].Species = species;
        match.Players[Ai].Cash = 1000;
        PoMuleDevelopment.Begin(match);
        return match;
    }

    private static int Own(MatchState match, int index, Terrain terrain, byte peaks = 0, byte crystite = 0, int seat = Ai)
    {
        match.Map.Plots[index] = new Plot(terrain, peaks, crystite);
        match.Owner[index] = (sbyte)seat;
        return index;
    }

    [Theory]
    [InlineData(Archetype.Farmer, Terrain.River)]
    [InlineData(Archetype.Hoarder, Terrain.River)]
    [InlineData(Archetype.Industrialist, Terrain.Mountain)]
    [InlineData(Archetype.Prospector, Terrain.Crater)]
    [InlineData(Archetype.Speculator, Terrain.River)]
    [InlineData(Archetype.Agitator, null)]
    [InlineData(Archetype.Gambler, null)]
    public void LandPick_GoesForTheTerrainThePersonalityLivesOn(Archetype archetype, Terrain? expected)
    {
        var match = Match(archetype);

        var pick = PoMuleAi.PickLand(match, Ai);

        PoMuleLand.Claimable(match, pick).Should().BeTrue();
        if (expected is { } terrain) match.Map.Plots[pick].Terrain.Should().Be(terrain);
        if (archetype == Archetype.Industrialist) match.Map.Plots[pick].Peaks.Should().Be(3, "the richest ore");
    }

    [Theory]
    [InlineData(Archetype.Industrialist, Terrain.Mountain, Good.Smithore)]
    [InlineData(Archetype.Industrialist, Terrain.River, Good.Food)]       // but nobody mines a river
    [InlineData(Archetype.Farmer, Terrain.River, Good.Food)]
    [InlineData(Archetype.Farmer, Terrain.Plains, Good.Food)]
    [InlineData(Archetype.Prospector, Terrain.Crater, Good.Crystite)]
    [InlineData(Archetype.Hoarder, Terrain.River, Good.Food)]
    [InlineData(Archetype.Gambler, Terrain.River, Good.Food)]             // nobody but the miners skips feeding themselves
    public void Outfit_FollowsThePersonality_ButMinersStillPowerTheirOwnMules(Archetype archetype, Terrain terrain, Good expected)
    {
        var match = Match(archetype);
        var plot = Own(match, 0, terrain, peaks: 3, crystite: 3);

        PoMuleAi.ChooseOutfit(match, Ai, plot).Should().Be(expected);

        // With four M.U.L.E.s already drawing power and none making it, the next one is Energy.
        match.Installed[Own(match, 1, Terrain.Mountain, peaks: 3)] = (sbyte)Good.Smithore;
        match.Installed[Own(match, 2, Terrain.Mountain, peaks: 3)] = (sbyte)Good.Smithore;
        match.Installed[Own(match, 3, Terrain.River)] = (sbyte)Good.Food;
        match.Installed[Own(match, 4, Terrain.River)] = (sbyte)Good.Food;
        PoMuleAi.ChooseOutfit(match, Ai, Own(match, 5, Terrain.Plains)).Should().Be(Good.Energy);
    }

    /// <summary>
    /// Each row runs one scenario: a private method below, named after what it checks.
    /// </summary>
    [Theory]
    [InlineData(nameof(Goals_WalkThroughBuyInstallPub_WhileTheGamblerQuitsEarlyAndTheAgitatorHunts))]
    [InlineData(nameof(AtAuction_TheSpeculatorOutbidsTheFarmer_AndNobodyBidsPastTheirMeans))]
    [InlineData(nameof(SameSeed_GivesTheSameObjectivesPlansAndForecasts))]
    [InlineData(nameof(AColonistShortOnFood_PlansAFarmFirst_AndAFedOneGoesBackToMining))]
    [InlineData(nameof(ATraderHoldsAGoodForecastToBeScarce_AndBuyersWaitForAFallingPrice))]
    [InlineData(nameof(ATraderSellsSurplusIntoAPriceAboveForecast))]
    [InlineData(nameof(WhenAPlannedPlotIsTaken_TheColonistReplans))]
    public Task Scenario(string name) => Scenarios.RunAsync(this, name);

    private static void Goals_WalkThroughBuyInstallPub_WhileTheGamblerQuitsEarlyAndTheAgitatorHunts()
    {
        var farmer = Match(Archetype.Farmer);
        var plot = Own(farmer, 0, Terrain.River);
        PoMuleAi.NextGoal(farmer, Ai).Should().Be(new Goal(GoalKind.Outfitter, -1, Good.Food));
        PoMuleDevelopment.BuyMule(farmer, Ai);
        PoMuleAi.NextGoal(farmer, Ai).Should().Be(new Goal(GoalKind.Outfitter, -1, Good.Food), "still bare: back to the counter");
        PoMuleDevelopment.Outfit(farmer, Ai, Good.Food);
        PoMuleAi.NextGoal(farmer, Ai).Should().Be(new Goal(GoalKind.Install, plot, Good.Food));
        PoMuleDevelopment.Install(farmer, Ai, plot);
        PoMuleAi.NextGoal(farmer, Ai).Kind.Should().Be(GoalKind.Pub, "nothing left to develop");

        var late = Match(Archetype.Farmer);
        Own(late, 0, Terrain.River);
        late.ClockTicks = PoMuleTuning.LastMuleErrandTicks;
        PoMuleAi.NextGoal(late, Ai).Kind.Should().Be(GoalKind.Pub, "too late to get a M.U.L.E. home");

        var broke = Match(Archetype.Farmer);
        Own(broke, 0, Terrain.River);
        broke.Players[Ai].Cash = 50;
        PoMuleAi.NextGoal(broke, Ai).Kind.Should().Be(GoalKind.Pub);

        // Hunger took the end off this one's month, and the clock has reached it.
        var hungry = Match(Archetype.Farmer);
        hungry.Players[Ai].TimePercent = 40;
        hungry.ClockTicks = 270;
        PoMuleAi.NextGoal(hungry, Ai).Kind.Should().Be(GoalKind.Idle);

        // The Gambler only works in the opening seconds, then cashes the clock in.
        var gambler = Match(Archetype.Gambler);
        Own(gambler, 0, Terrain.River);
        PoMuleAi.NextGoal(gambler, Ai).Kind.Should().Be(GoalKind.Outfitter);
        gambler.ClockTicks = 250;
        PoMuleAi.NextGoal(gambler, Ai).Kind.Should().Be(GoalKind.Pub);

        // The Agitator, with its own work done, goes after whoever is towing a M.U.L.E.
        var agitator = Match(Archetype.Agitator);
        PoMuleAi.NextGoal(agitator, Ai).Should().Be(new Goal(GoalKind.Chase, -1, Good.Food), "nobody to hit: block a town door");
        PoMuleDevelopment.BuyMule(agitator, 3);
        PoMuleAi.NextGoal(agitator, Ai).Should().Be(new Goal(GoalKind.Chase, 3, Good.Food));
        agitator.BumpRunaways = 1;
        PoMuleAi.NextGoal(agitator, Ai).Kind.Should().Be(GoalKind.Pub, "one frightened M.U.L.E. a month is enough");
        agitator.BumpRunaways = 0;
        agitator.ClockTicks = 100;
        PoMuleAi.NextGoal(agitator, Ai).Kind.Should().Be(GoalKind.Pub, "even an Agitator wants the pub money");

        // The Prospector fetches an assay and spends it on a crater nobody has surveyed.
        var prospector = Match(Archetype.Prospector);
        prospector.Map.Plots[10] = new Plot(Terrain.Crater, 0, 4);
        PoMuleAi.NextGoal(prospector, Ai).Kind.Should().Be(GoalKind.Assay);
        PoMuleDevelopment.VisitAssayOffice(prospector, Ai);
        var survey = PoMuleAi.NextGoal(prospector, Ai);
        survey.Kind.Should().Be(GoalKind.Survey);
        prospector.Map.Plots[survey.Target].Terrain.Should().Be(Terrain.Crater);
    }

    [Theory]
    [InlineData(Archetype.Hoarder, Good.Food, 30, 9, -1, 0)]    // spare Food at an ordinary price: stays at the top
    [InlineData(Archetype.Hoarder, Good.Food, 130, 9, -1, -1)]  // near the record price: now it sells
    [InlineData(Archetype.Farmer, Good.Food, 30, 9, -1, -1)]    // walks down to a fair price
    [InlineData(Archetype.Farmer, Good.Food, 30, 9, 37, 0)]     // and stops there
    [InlineData(Archetype.Farmer, Good.Food, 30, 0, -1, 1)]     // short of Food: walks up to buy
    [InlineData(Archetype.Speculator, Good.Crystite, 100, 9, -1, 0)]  // holds Crystite at an ordinary price
    [InlineData(Archetype.Speculator, Good.Crystite, 140, 9, -1, -1)] // sells into a spike
    [InlineData(Archetype.Industrialist, Good.Smithore, 50, 9, -1, -1)] // ore goes straight to the Store
    public void OnTheFloor_EachPersonalityWalksToItsOwnPrice(Archetype archetype, Good good, int storePrice, int held, int standingAt, int input)
    {
        var match = Match(archetype);
        match.Store.Price[(int)good] = storePrice;
        match.Players[Ai].Goods[(int)good] = held;
        PoMuleMarket.Open(match, good);
        if (standingAt >= 0) match.LanePrice[Ai] = standingAt;

        PoMuleAi.MarketInput(match, Ai).Should().Be(input);

        // Whoever has traded down to exactly what they need walks off the floor.
        match.Players[Ai].Goods[(int)good] = good == Good.Food ? PoMuleTuning.FoodNeed(match.Month + 1) : 0;
        var leaving = match.LaneRole[Ai] == PoMuleMarket.Seller ? 1 : -1;
        match.LanePrice[Ai] = (PoMuleMarket.Floor(match, good) + PoMuleMarket.Ceiling(match, good)) / 2;
        PoMuleAi.MarketInput(match, Ai).Should().Be(leaving);
    }

    private static void AtAuction_TheSpeculatorOutbidsTheFarmer_AndNobodyBidsPastTheirMeans()
    {
        var match = Match(Archetype.Speculator);
        match.Players[2].Archetype = Archetype.Farmer;
        match.Players[2].Cash = 1000;
        PoMuleLand.OpenAuction(match, PoMuleLand.PickAuctionPlots(match)[0]);

        PoMuleAi.AuctionInput(match, Ai).Should().Be(1, "it walks up to the opening bid");

        // Let the two walk each other up the floor until one stops.
        var inputs = new int[PoMuleTuning.Seats];
        for (var round = 0; round < 200; round++)
        {
            foreach (var seat in new[] { Ai, 2 }) inputs[seat] = PoMuleAi.AuctionInput(match, seat);
            PoMuleLand.AuctionTick(match, inputs);
        }

        match.HighBidder.Should().Be((sbyte)Ai);
        match.HighBid.Should().BeInRange(290, 600, "the Farmer drops out at 30% of its cash; the Speculator would go to 42%");
        PoMuleAi.AuctionInput(match, Ai).Should().Be(0, "it does not bid against itself");

        match.Players[2].Cash = 100;
        PoMuleLand.OpenAuction(match, match.AuctionPlot);
        PoMuleAi.AuctionInput(match, 2).Should().Be(0, "cannot cover the opening bid");
    }

    private static void SameSeed_GivesTheSameObjectivesPlansAndForecasts()
    {
        static string Snapshot()
        {
            var match = Match(Archetype.Speculator);
            Own(match, 0, Terrain.River);
            Own(match, 1, Terrain.Mountain, peaks: 2);
            Own(match, 2, Terrain.Plains);
            var land = PoMuleAi.PickLand(match, Ai);
            var plan = string.Join(";", PoMuleAi.Plan(match, Ai));
            var forecasts = string.Join(";", Enum.GetValues<Good>().Select(g => PoMuleAi.ForecastFor(match, g)));
            PoMuleMarket.Open(match, Good.Food);
            return $"{land}|{PoMuleAi.ChooseObjective(match, Ai)}|{plan}|{forecasts}|{PoMuleAi.MarketInput(match, Ai)}|{match.Rng.State}";
        }

        Snapshot().Should().Be(Snapshot());
    }

    private static void AColonistShortOnFood_PlansAFarmFirst_AndAFedOneGoesBackToMining()
    {
        var hungry = Match(Archetype.Industrialist);
        hungry.Players[Ai].Goods[(int)Good.Food] = 0;
        Own(hungry, 0, Terrain.Mountain, peaks: 3);
        var river = Own(hungry, 1, Terrain.River);

        PoMuleAi.ChooseObjective(hungry, Ai).Should().Be(Objective.SecureFood);
        var plan = PoMuleAi.Plan(hungry, Ai);
        plan[0].Should().Be(new PlanStep(GoalKind.Outfitter, -1, Good.Food));
        plan[1].Should().Be(new PlanStep(GoalKind.Install, river, Good.Food));
        plan.Count.Should().Be(4, "a second M.U.L.E. is planned behind the first");

        var fed = Match(Archetype.Industrialist);
        fed.Players[Ai].Goods[(int)Good.Food] = 10;
        Own(fed, 0, Terrain.Mountain, peaks: 3);
        Own(fed, 1, Terrain.River);
        PoMuleAi.ChooseObjective(fed, Ai).Should().Be(Objective.MineSmithore);
        PoMuleAi.Plan(fed, Ai)[0].Good.Should().Be(Good.Smithore);
    }

    private static void ATraderHoldsAGoodForecastToBeScarce_AndBuyersWaitForAFallingPrice()
    {
        static MatchState Colony(int othersFood)
        {
            var match = Match(Archetype.Farmer);
            match.Store.Stock[(int)Good.Food] = 0;
            foreach (var p in match.Players.Where(p => p.Seat != Ai)) p.Goods[(int)Good.Food] = othersFood;
            match.Players[Ai].Goods[(int)Good.Food] = 6;
            PoMuleMarket.Open(match, Good.Food);
            return match;
        }

        var scarce = Colony(othersFood: 0);
        PoMuleAi.ForecastFor(scarce, Good.Food).Scarce.Should().BeTrue();
        PoMuleAi.ForecastFor(scarce, Good.Food).Price.Should().BeGreaterThan(scarce.Store.Price[(int)Good.Food]);
        PoMuleAi.MarketInput(scarce, Ai).Should().Be(1, "it keeps the spare Food at the top of its lane instead of selling the colony dry");

        var plenty = Colony(othersFood: 20);
        PoMuleAi.MarketInput(plenty, Ai).Should().Be(-1, "with plenty about the same surplus goes at a fair price");

        // Short in a glutted colony (the price is forecast to fall): it waits at a fair bid, until last call.
        plenty.Players[Ai].Goods[(int)Good.Food] = 0;
        PoMuleMarket.Open(plenty, Good.Food);
        var (floor, ceiling) = (PoMuleMarket.Floor(plenty, Good.Food), PoMuleMarket.Ceiling(plenty, Good.Food));
        plenty.LanePrice[Ai] = floor + (ceiling - floor) / 3;
        PoMuleAi.MarketInput(plenty, Ai).Should().Be(0, "no hurry while the price is falling");
        plenty.ClockTicks = PoMuleTuning.MarketLastCallTicks - 1;
        PoMuleAi.MarketInput(plenty, Ai).Should().Be(1, "at last call it pays what it takes");
    }

    private static void ATraderSellsSurplusIntoAPriceAboveForecast()
    {
        MatchState Hoarder(int storeStock, int othersFood)
        {
            var match = Match(Archetype.Hoarder);
            match.Store.Price[(int)Good.Food] = 100;
            match.Store.Stock[(int)Good.Food] = storeStock;
            foreach (var p in match.Players.Where(p => p.Seat != Ai)) p.Goods[(int)Good.Food] = othersFood;
            match.Players[Ai].Goods[(int)Good.Food] = 9;
            PoMuleMarket.Open(match, Good.Food);
            return match;
        }

        var glut = Hoarder(storeStock: 64, othersFood: 20);
        var forecast = PoMuleAi.ForecastFor(glut, Good.Food);
        forecast.Price.Should().BeLessThan(90, "a glutted colony sees the price falling");
        PoMuleAi.MarketInput(glut, Ai).Should().Be(-1, "even the Hoarder sells into a price that is about to drop");

        var even = Hoarder(storeStock: 0, othersFood: 4);
        PoMuleAi.MarketInput(even, Ai).Should().Be(0, "no drop in sight: it sits on its Food at the top");
    }

    private static void WhenAPlannedPlotIsTaken_TheColonistReplans()
    {
        var match = Match(Archetype.Farmer);
        var river = Own(match, 0, Terrain.River);
        var plains = Own(match, 1, Terrain.Plains);

        var before = PoMuleAi.Plan(match, Ai);
        before[1].Should().Be(new PlanStep(GoalKind.Install, river, Good.Food));

        match.Owner[river] = 3; // someone else's now (a land-grab, a lost auction)
        var after = PoMuleAi.Plan(match, Ai);
        after.Should().NotContain(step => step.Plot == river);
        after[1].Should().Be(new PlanStep(GoalKind.Install, plains, Good.Food));

        // And a purse that no longer stretches to the outfit swaps to a cheaper one.
        match.Players[Ai].Cash = match.Store.MulePrice + PoMuleTuning.OutfitCost[(int)Good.Food];
        PoMuleAi.Plan(match, Ai)[0].Good.Should().Be(Good.Food);
        match.Players[Ai].Cash = match.Store.MulePrice;
        PoMuleAi.Plan(match, Ai)[0].Kind.Should().Be(GoalKind.Pub, "cannot afford any outfit: cash the clock in instead");
    }
}
