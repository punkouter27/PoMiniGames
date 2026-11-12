using FluentAssertions;
using PoMiniGames.Shared.Games.PoMule;

namespace PoMiniGames.Unit;

/// <summary>
/// The walking-floor market: eight lanes on one price axis, sellers walking down from the
/// Store's selling price and buyers walking up from its buying price.
/// </summary>
public sealed class PoMuleMarketTests
{
    private static readonly int[] Still = new int[PoMuleTuning.Seats];

    /// <summary>A Food market where nobody starts with any, so each test sets up exactly who trades.</summary>
    private static MatchState FoodMarket(Action<MatchState>? arrange = null)
    {
        var match = MatchState.New(seed: 31, humanSpecies: Species.Humanoid);
        foreach (var p in match.Players) p.Goods[(int)Good.Food] = PoMuleTuning.FoodNeed(2);
        arrange?.Invoke(match);
        PoMuleMarket.Open(match, Good.Food);
        return match;
    }

    private static int Food(MatchState match, int seat) => match.Players[seat].Goods[(int)Good.Food];

    /// <summary>
    /// Each row runs one scenario: a private method below, named after what it checks.
    /// </summary>
    [Theory]
    [InlineData(nameof(Open_PutsThoseWithSpareAtTheTopAsSellers_ThoseShortAtTheBottomAsBuyers))]
    [InlineData(nameof(WhenBidMeetsAsk_UnitsTradeAtThatPrice_FourASecond_UntilSomeoneRunsOutOrWalksAway))]
    [InlineData(nameof(TheStore_SellsAtTheCeilingWhileItHasStock_BuysAtTheFloor_AndColonistsTradeWithEachOtherFirst))]
    [InlineData(nameof(AtMonthEnd_TheStoreBuildsMulesFromSmithore_RepricesThem_AndCrystiteFindsANewPrice))]
    public Task Scenario(string name) => Scenarios.RunAsync(this, name);

    private static void Open_PutsThoseWithSpareAtTheTopAsSellers_ThoseShortAtTheBottomAsBuyers()
    {
        var match = FoodMarket(m =>
        {
            m.Players[1].Goods[(int)Good.Food] = 9;  // 6 spare
            m.Players[2].Goods[(int)Good.Food] = 1;  // 2 short
        });
        var (floor, ceiling) = (PoMuleMarket.Floor(match, Good.Food), PoMuleMarket.Ceiling(match, Good.Food));

        (floor, ceiling).Should().Be((30, 65), "the Store sells 35 above what it pays");
        (match.LaneRole[1], match.LanePrice[1]).Should().Be((PoMuleMarket.Seller, ceiling));
        (match.LaneRole[2], match.LanePrice[2]).Should().Be((PoMuleMarket.Buyer, floor));
        match.LaneRole[0].Should().Be(0, "exactly enough: nothing to sell, nothing to buy");
        match.ClockTicks.Should().Be(PoMuleTuning.MarketSeconds * PoMuleTuning.TicksPerSecond);

        // Walking: down lowers a price, up raises it, and nobody leaves the price axis.
        var inputs = new int[PoMuleTuning.Seats];
        inputs[1] = -1;
        inputs[2] = +1;
        PoMuleMarket.Tick(match, inputs);
        (match.LanePrice[1], match.LanePrice[2]).Should().Be((ceiling - 1, floor + 1));
        inputs[1] = +1;
        inputs[2] = -1;
        for (var i = 0; i < 5; i++) PoMuleMarket.Tick(match, inputs);
        (match.LanePrice[1], match.LanePrice[2]).Should().Be((ceiling, floor));

        PoMuleMarket.SetRole(match, 0, PoMuleMarket.Seller);
        (match.LaneRole[0], match.LanePrice[0]).Should().Be((PoMuleMarket.Seller, ceiling));
    }

    private static void WhenBidMeetsAsk_UnitsTradeAtThatPrice_FourASecond_UntilSomeoneRunsOutOrWalksAway()
    {
        var match = FoodMarket(m =>
        {
            m.Players[1].Goods[(int)Good.Food] = 9;
            m.Players[2].Goods[(int)Good.Food] = 0;
            m.Players[2].Cash = 200;
        });
        var sellerCash = match.Players[1].Cash;

        match.LanePrice[1] = 46;
        match.LanePrice[2] = 45;
        PoMuleMarket.Tick(match, Still).Should().BeEmpty("the bid is still below the ask");

        match.LanePrice[2] = 46;
        var trades = Enumerable.Range(0, 10).SelectMany(_ => PoMuleMarket.Tick(match, Still)).ToList();

        trades.Should().HaveCount(4, "one unit every quarter second");
        trades.Should().OnlyContain(t => t == new Trade(1, 2, 46));
        (Food(match, 1), Food(match, 2)).Should().Be((5, 4));
        (match.Players[1].Cash, match.Players[2].Cash).Should().Be((sellerCash + 4 * 46, 200 - 4 * 46));

        // 16 credits left: the buyer cannot pay 46, so trading stops with cash still positive.
        Enumerable.Range(0, 20).SelectMany(_ => PoMuleMarket.Tick(match, Still)).Should().BeEmpty();
        match.Players[2].Cash.Should().Be(16);

        // Topped up, the buyer trades again until the seller walks back up the lane.
        match.Players[2].Cash = 1000;
        PoMuleMarket.Tick(match, Still).Should().ContainSingle();
        var inputs = new int[PoMuleTuning.Seats];
        inputs[1] = +1;
        Enumerable.Range(0, 20).SelectMany(_ => PoMuleMarket.Tick(match, inputs)).Should().BeEmpty();

        // Back together, the seller sells what it can spare and no more: the crates it needs
        // for next month are not on the floor, however long a buyer stands there.
        match.LanePrice[1] = 46;
        var rest = Enumerable.Range(0, 40).SelectMany(_ => PoMuleMarket.Tick(match, Still)).ToList();
        rest.Should().HaveCount(1);
        Food(match, 1).Should().Be(PoMuleTuning.FoodNeed(2));
        // Not to the Store either.
        match.LanePrice[1] = PoMuleMarket.Floor(match, Good.Food);
        Enumerable.Range(0, 20).SelectMany(_ => PoMuleMarket.Tick(match, Still)).Should().BeEmpty();
    }

    private static void TheStore_SellsAtTheCeilingWhileItHasStock_BuysAtTheFloor_AndColonistsTradeWithEachOtherFirst()
    {
        var match = FoodMarket(m =>
        {
            m.Players[1].Goods[(int)Good.Food] = 9;
            m.Players[2].Goods[(int)Good.Food] = 0;
            m.Store.Stock[(int)Good.Food] = 2;
        });
        var (floor, ceiling) = (PoMuleMarket.Floor(match, Good.Food), PoMuleMarket.Ceiling(match, Good.Food));
        var store = PoMuleMarket.Store;

        // Buyer alone at the ceiling: the Store sells its two units, then has nothing.
        match.LaneRole[1] = 0;
        match.LanePrice[2] = ceiling;
        var bought = Enumerable.Range(0, 30).SelectMany(_ => PoMuleMarket.Tick(match, Still)).ToList();
        bought.Should().Equal(new Trade(store, 2, ceiling), new Trade(store, 2, ceiling));
        match.Store.Stock[(int)Good.Food].Should().Be(0);
        PoMuleMarket.Ceiling(match, Good.Food).Should().Be(floor + 35 * PoMuleTuning.SoldOutSpreads, "sold out: nothing holds prices down");

        // Seller alone at the floor: the Store buys.
        match.LaneRole[2] = 0;
        match.LaneRole[1] = PoMuleMarket.Seller;
        match.LanePrice[1] = floor;
        PoMuleMarket.Tick(match, Still).Should().Equal(new Trade(1, store, floor));
        match.Store.Stock[(int)Good.Food].Should().Be(1);

        // Both on the floor together: the colonist's bid wins over the Store's.
        match.LaneRole[2] = PoMuleMarket.Buyer;
        match.LanePrice[2] = floor;
        var both = Enumerable.Range(0, 5).SelectMany(_ => PoMuleMarket.Tick(match, Still)).ToList();
        both.Should().OnlyContain(t => t.Seller == 1 && t.Buyer == 2);
    }

    [Theory]
    [InlineData(Good.Food, 30, 10, 32, 35)]    // short supply: up 15%, rounded up
    [InlineData(Good.Food, 30, 40, 32, 30)]    // comfortable: no change
    [InlineData(Good.Food, 30, 64, 32, 27)]    // glut (twice the need): down 10%
    [InlineData(Good.Energy, 148, 0, 5, 150)]  // capped
    [InlineData(Good.Food, 16, 99, 5, 15)]     // floored
    [InlineData(Good.Smithore, 50, 0, 8, 58)]
    public void StorePrice_RisesWhenTheColonyIsShort_FallsInAGlut_WithinItsLimits(Good good, int price, int supply, int need, int next) =>
        PoMuleMarket.NextPrice(good, price, supply, need).Should().Be(next);

    private static void AtMonthEnd_TheStoreBuildsMulesFromSmithore_RepricesThem_AndCrystiteFindsANewPrice()
    {
        var match = FoodMarket();
        match.Store.Stock[(int)Good.Smithore] = 5;
        match.Store.Price[(int)Good.Smithore] = 70;

        PoMuleMarket.EndOfMonth(match);

        match.Store.Mules.Should().Be(PoMuleTuning.StoreStartMules + 2);
        match.Store.Stock[(int)Good.Smithore].Should().Be(1);
        // Thirty M.U.L.E.s in the corral: Smithore is at its floor, and a M.U.L.E. costs twice that.
        match.Store.Price[(int)Good.Smithore].Should().Be(25);
        match.Store.MulePrice.Should().Be(50);
        (PoMuleMarket.SmithorePrice(14), PoMuleMarket.SmithorePrice(4), PoMuleMarket.SmithorePrice(0))
            .Should().Be((50, 175, 250), "the scarcer M.U.L.E.s are, the more ore is worth");

        var prices = Enumerable.Range(0, 200).Select(_ => { PoMuleMarket.EndOfMonth(match); return match.Store.Price[(int)Good.Crystite]; }).ToList();
        prices.Should().OnlyContain(p => p >= 50 && p <= 150);
        prices.Distinct().Count().Should().BeGreaterThan(20);

        // Closing a market moves that good's price from what the colony holds.
        foreach (var p in match.Players) p.Goods[(int)Good.Food] = 0;
        match.Store.Stock[(int)Good.Food] = 0;
        PoMuleMarket.Close(match);
        match.Store.Price[(int)Good.Food].Should().Be(35);
        match.MarketGood.Should().Be(MatchState.Nobody);
    }
}
