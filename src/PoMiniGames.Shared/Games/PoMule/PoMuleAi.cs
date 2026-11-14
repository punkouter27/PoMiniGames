namespace PoMiniGames.Shared.Games.PoMule;

public enum GoalKind : byte { Idle, Outfitter, Install, Assay, Survey, Pub, Chase }

/// <summary>
/// Where an AI colonist is heading during development. The renderer steers the avatar there
/// and reports the arrival; the engine then performs (and re-checks) the action.
/// </summary>
/// <param name="Target">
/// A plot for <see cref="GoalKind.Install"/> and <see cref="GoalKind.Survey"/>; a seat for
/// <see cref="GoalKind.Chase"/> (-1 = loiter at a town door); otherwise -1, meaning the
/// nearest town.
/// </param>
/// <param name="Good">What to outfit or install.</param>
public readonly record struct Goal(GoalKind Kind, int Target, Good Good);

/// <summary>
/// The seven computer personalities. Hand-written rules, like every other opponent in
/// PoMiniGames; each method reads the match and answers one question, keeping nothing
/// between calls.
/// </summary>
public static class PoMuleAi
{
    // Terrain appeal by personality: Plains, River, Mountain, Crater. (Mountains add 20 a peak.)
    private static int Appeal(Archetype archetype, Terrain terrain) => (archetype, terrain) switch
    {
        (Archetype.Farmer or Archetype.Hoarder or Archetype.Speculator, Terrain.River) => 100,
        (Archetype.Farmer or Archetype.Hoarder or Archetype.Speculator, Terrain.Plains) => 50,
        (Archetype.Industrialist, Terrain.Mountain) => 60,
        (Archetype.Prospector, Terrain.Crater) => 110,
        (Archetype.Prospector, Terrain.Mountain) => 25,
        (Archetype.Speculator, Terrain.Crater) => 68,
        (Archetype.Agitator or Archetype.Gambler, Terrain.River or Terrain.Plains) => 50,
        _ => 20,
    };

    /// <summary>The plot this colonist points its land-grant cursor at.</summary>
    /// <param name="from">Only plots the highlighter has not passed yet (index at or after this).</param>
    public static int PickLand(MatchState match, int seat, int from = 0)
    {
        var archetype = match.Players[seat].Archetype;
        var best = -1;
        var bestScore = int.MinValue;
        for (var i = Math.Max(0, from); i < match.Owner.Length; i++)
        {
            if (!PoMuleLand.Claimable(match, i)) continue;
            var plot = match.Map.Plots[i];
            var score = Appeal(archetype, plot.Terrain) - TownDistance(i) + match.Rng.Next(8);
            if (archetype == Archetype.Industrialist) score += 20 * plot.Peaks;
            // Everybody can read the Store's board: the dearer Smithore is (the emptier the
            // corral), the better a mountain looks, whoever you are.
            if (plot.Terrain == Terrain.Mountain)
                score += PoMuleProduction.BaseYield(plot, Good.Smithore) * match.Store.Price[(int)Good.Smithore] / PoMuleTuning.OreAppealDivisor;
            if (archetype == Archetype.Prospector && PoMuleDevelopment.CanSeeCrystite(match, seat, i)) score += 30 * plot.Crystite;
            if (score > bestScore) (best, bestScore) = (i, score);
        }
        return best;
    }

    private static int TownDistance(int plot)
    {
        var (column, row) = (plot % PoMuleMap.Columns, plot / PoMuleMap.Columns);
        return PoMuleMap.TownColumns.Min(t => PoMuleMap.ColumnDistance(t, column)) + Math.Abs(row - PoMuleMap.TownRow);
    }

    /// <summary>Crystite a M.U.L.E. would dig here as far as this colonist can tell: craters are a good bet.</summary>
    private static int ExpectedYield(MatchState match, int seat, int plot, Good good)
    {
        var tile = match.Map.Plots[plot];
        if (good == Good.Crystite && !PoMuleDevelopment.CanSeeCrystite(match, seat, plot))
            return tile.Terrain == Terrain.Crater ? 2 : 0;
        return PoMuleProduction.BaseYield(tile, good);
    }

    private static IEnumerable<int> Plots(MatchState match, int seat) =>
        Enumerable.Range(0, match.Owner.Length).Where(i => match.Owner[i] == seat);

    /// <summary>What to outfit a M.U.L.E. for, given the plot it is bound for.</summary>
    public static Good ChooseOutfit(MatchState match, int seat, int plot)
    {
        var player = match.Players[seat];
        var worked = Plots(match, seat).Where(i => match.Installed[i] != MatchState.Nobody).ToList();
        int Making(Good g) => worked.Where(i => match.Installed[i] == (sbyte)g).Sum(i => PoMuleProduction.BaseYield(match.Map.Plots[i], g));

        // Nobody runs M.U.L.E.s they cannot power: Energy output must cover this one too,
        // unless there is a couple of months of it in stock.
        var drawing = worked.Count(i => match.Installed[i] != (sbyte)Good.Energy) + 1;
        if (Making(Good.Energy) < drawing && player.Goods[(int)Good.Energy] < drawing * 2) return Good.Energy;

        var miner = player.Archetype is Archetype.Industrialist or Archetype.Prospector;
        if (player.Archetype == Archetype.Industrialist && PoMuleProduction.BaseYield(match.Map.Plots[plot], Good.Smithore) > 0) return Good.Smithore;
        if (player.Archetype == Archetype.Prospector && ExpectedYield(match, seat, plot, Good.Crystite) >= 2) return Good.Crystite;

        // Everyone but the miners feeds themselves before chasing profit.
        var canFarm = PoMuleProduction.BaseYield(match.Map.Plots[plot], Good.Food) >= 2;
        if (!miner && canFarm && Making(Good.Food) < PoMuleTuning.FoodNeed(match.Month + 1)) return Good.Food;
        if (player.Archetype == Archetype.Farmer && canFarm) return Good.Food;
        if (player.Archetype == Archetype.Hoarder)
            return ExpectedYield(match, seat, plot, Good.Food) >= ExpectedYield(match, seat, plot, Good.Energy) ? Good.Food : Good.Energy;

        return Enum.GetValues<Good>().MaxBy(g => ExpectedYield(match, seat, plot, g) * match.Store.Price[(int)g]);
    }

    /// <summary>Where this colonist is heading right now in the development phase.</summary>
    public static Goal NextGoal(MatchState match, int seat)
    {
        var player = match.Players[seat];
        if (!PoMuleDevelopment.CanAct(match, seat)) return new Goal(GoalKind.Idle, -1, default);

        var empty = Plots(match, seat).Where(i => match.Installed[i] == MatchState.Nobody).ToList();
        if (player.HasMule)
        {
            if (empty.Count == 0) return new Goal(GoalKind.Pub, -1, default);
            if (player.Outfit == MatchState.Nobody)
                return new Goal(GoalKind.Outfitter, -1, ChooseOutfit(match, seat, empty[0]));
            var outfit = (Good)player.Outfit;
            return new Goal(GoalKind.Install, empty.MaxBy(i => ExpectedYield(match, seat, i, outfit)), outfit);
        }

        var timeLeft = PoMuleDevelopment.TimeLeft(match, seat);
        var working = player.Archetype != Archetype.Gambler || timeLeft > PoMuleTuning.GamblerWorksUntilTicks;
        if (working && empty.Count > 0 && match.Store.Mules > 0 && timeLeft > PoMuleTuning.LastMuleErrandTicks)
        {
            var good = ChooseOutfit(match, seat, empty[0]);
            if (player.Cash >= match.Store.MulePrice + PoMuleTuning.OutfitCost[(int)good])
                return new Goal(GoalKind.Outfitter, -1, good);
        }

        // One frightened M.U.L.E. a month is the Agitator's fun; after that it goes for a drink.
        if (player.Archetype == Archetype.Agitator && timeLeft > PoMuleTuning.AgitatorHuntsUntilTicks && match.BumpRunaways == 0)
        {
            var prey = match.Players.FirstOrDefault(p => p.Seat != seat && p.HasMule);
            return new Goal(GoalKind.Chase, prey?.Seat ?? -1, default);
        }

        if (player.Archetype == Archetype.Prospector && timeLeft > PoMuleTuning.AgitatorHuntsUntilTicks
            && !match.Has(player, Species.CrystiteWeaver))
        {
            var crater = Enumerable.Range(0, match.Assayed.Length)
                .FirstOrDefault(i => !match.Assayed[i] && match.Map.Plots[i].Terrain == Terrain.Crater, -1);
            if (crater >= 0)
                return player.HoldsAssay ? new Goal(GoalKind.Survey, crater, default) : new Goal(GoalKind.Assay, -1, default);
        }

        return new Goal(GoalKind.Pub, -1, default);
    }

    /// <summary>Which way this colonist walks on the trading floor this tick: +1 up, -1 down, 0 stay.</summary>
    public static int MarketInput(MatchState match, int seat)
    {
        var role = match.LaneRole[seat];
        if (role == 0 || match.MarketGood == MatchState.Nobody) return 0;
        var good = (Good)match.MarketGood;
        var player = match.Players[seat];
        var (floor, ceiling) = (PoMuleMarket.Floor(match, good), PoMuleMarket.Ceiling(match, good));
        var surplus = PoMuleMarket.Surplus(match, seat, good);
        var here = match.LanePrice[seat];

        if (role == PoMuleMarket.Buyer)
        {
            if (surplus >= 0) return -1;
            return here < Math.Min(player.Cash, ceiling) ? 1 : 0;
        }

        var essential = good is Good.Food or Good.Energy;
        // Keep a little Food and Energy back: next month brings a bad harvest or a new M.U.L.E.
        if (surplus <= (essential ? PoMuleTuning.AiReserve[(int)good] : 0)) return 1;
        var price = match.Store.Price[(int)good];
        // Spare Food and Energy rot, so with the bell about to ring everyone but the
        // Hoarder takes the Store's price rather than carry it home.
        if (essential && player.Archetype != Archetype.Hoarder && match.ClockTicks < PoMuleTuning.MarketLastCallTicks)
            return Math.Sign(floor - here);
        var target = (player.Archetype, essential) switch
        {
            // Sits on Food and Energy until the price is close to its record high.
            (Archetype.Hoarder, true) => price * 100 >= PoMuleTuning.PriceMax[(int)good] * 80 ? (floor + ceiling) / 2 : ceiling,
            (Archetype.Farmer, true) => floor + (ceiling - floor) / 5,
            // Holds ore for a spike, then dumps it on the Store.
            (Archetype.Speculator, false) => price * 10 >= PoMuleTuning.StoreStartPrice[(int)good] * 13 ? floor : ceiling,
            // Other colonists ask a third above the Store's price for essentials; ore has no
            // buyer but the Store, so it goes to the floor.
            (_, true) => floor + (ceiling - floor) / 3,
            _ => floor,
        };
        return Math.Sign(target - here);
    }

    /// <summary>The most this colonist will pay for the plot on the block: a share of its cash, more for land it likes.</summary>
    public static int AuctionLimit(MatchState match, int seat)
    {
        var player = match.Players[seat];
        var percent = player.Archetype switch
        {
            Archetype.Speculator => 42,
            Archetype.Gambler => 38,
            Archetype.Agitator => 20,
            _ => 30,
        };
        // Terrain appeal runs 20–100: land this personality lives on is worth up to a fifth more.
        var appeal = match.AuctionPlot < 0 ? 20 : Appeal(player.Archetype, match.Map.Plots[match.AuctionPlot].Terrain);
        return player.Cash * percent / 100 * (100 + appeal / 5) / 100;
    }

    /// <summary>
    /// Percent chance per tick that this colonist takes its next step up the land-auction
    /// floor: brisk with plenty of room under its limit, hesitant close to it, so the bidders
    /// string out instead of climbing in a row.
    /// </summary>
    public static int AuctionEagerness(MatchState match, int seat)
    {
        var limit = AuctionLimit(match, seat);
        var span = Math.Max(1, limit - PoMuleLand.AuctionFloor);
        return Math.Clamp(10 + 30 * (limit - match.LanePrice[seat]) / span, 10, 40);
    }

    /// <summary>Which way this colonist walks on the land-auction floor: +1 to raise its bid, 0 to stand.</summary>
    public static int AuctionInput(MatchState match, int seat)
    {
        if (match.AuctionPlot < 0 || match.HighBidder == seat) return 0;
        return match.LanePrice[seat] + PoMuleTuning.AuctionStep <= AuctionLimit(match, seat) ? 1 : 0;
    }
}
