namespace PoMiniGames.Shared.Games.PoMule;

/// <summary>One unit changing hands. A seat of <see cref="PoMuleMarket.Store"/> is the Colony Store.</summary>
public readonly record struct Trade(int Seller, int Buyer, int Price);

/// <summary>
/// The walking-floor market. One good at a time, all sixteen lanes on one price axis that runs
/// from the Store's buying price (the floor) to its selling price (the ceiling).
/// </summary>
public static class PoMuleMarket
{
    /// <summary>The order the goods come to the floor, as in the original: ore first, then what keeps you alive.</summary>
    public static readonly Good[] Order = [Good.Smithore, Good.Crystite, Good.Food, Good.Energy];

    public const sbyte Seller = 1;
    public const sbyte Buyer = -1;

    /// <summary>The seat number that stands for the Colony Store in a <see cref="Trade"/>.</summary>
    public const int Store = -1;

    // Four units a second at ten ticks a second: the meter gains 4 a tick and a trade costs 10.
    private const int MeterPerTick = 4;
    private const int MeterPerTrade = 10;

    /// <summary>What the Store pays for a unit. Also the price Net Worth values goods at.</summary>
    public static int Floor(MatchState match, Good good) => match.Store.Price[(int)good];

    /// <summary>
    /// The top of the floor: what the Store charges for a unit while it has any. Once it is
    /// sold out there is nothing to undercut, and sellers can walk their price far higher.
    /// </summary>
    public static int Ceiling(MatchState match, Good good) => match.Store.Price[(int)good]
        + PoMuleTuning.StoreSpread[(int)good] * (match.Store.Stock[(int)good] > 0 ? 1 : PoMuleTuning.SoldOutSpreads);

    /// <summary>Credits a lane moves per tick: the whole axis takes about four seconds to walk.</summary>
    public static int Step(MatchState match, Good good) => Math.Max(1, (Ceiling(match, good) - Floor(match, good)) / 40);

    /// <summary>Units a seat holds beyond next month's need; negative when short.</summary>
    public static int Surplus(MatchState match, int seat, Good good) =>
        match.Players[seat].Goods[(int)good] - Need(match, seat, good);

    private static int Need(MatchState match, int seat, Good good) => good switch
    {
        Good.Food => PoMuleTuning.FoodNeed(match.Month + 1),
        Good.Energy => Enumerable.Range(0, match.Owner.Length).Count(i =>
            match.Owner[i] == seat && match.Installed[i] != MatchState.Nobody && match.Installed[i] != (sbyte)Good.Energy),
        _ => 0,
    };

    /// <summary>Opens trading in one good and lines everyone up by what they have to spare.</summary>
    public static void Open(MatchState match, Good good)
    {
        match.MarketGood = (sbyte)good;
        match.ClockTicks = PoMuleTuning.MarketSeconds * PoMuleTuning.TicksPerSecond;
        match.TradeMeter = MeterPerTrade - MeterPerTick;
        for (var seat = 0; seat < match.Players.Length; seat++)
            SetRole(match, seat, (sbyte)Math.Sign(Surplus(match, seat, good)));
    }

    /// <summary>Sellers start at the top of their lane, buyers at the bottom.</summary>
    public static void SetRole(MatchState match, int seat, sbyte role)
    {
        var good = (Good)match.MarketGood;
        match.LaneRole[seat] = role;
        match.LanePrice[seat] = role == Seller ? Ceiling(match, good) : Floor(match, good);
    }

    /// <summary>
    /// One tenth of a second on the floor.
    /// </summary>
    /// <param name="inputs">Per seat: +1 walks up (price rises), -1 walks down, 0 stands still.</param>
    /// <returns>The trade made this tick, if any.</returns>
    public static IReadOnlyList<Trade> Tick(MatchState match, IReadOnlyList<int> inputs)
    {
        if (match.MarketGood == MatchState.Nobody) return [];
        var good = (Good)match.MarketGood;
        var g = (int)good;
        var (floor, ceiling, step) = (Floor(match, good), Ceiling(match, good), Step(match, good));

        for (var seat = 0; seat < match.Players.Length; seat++)
            if (match.LaneRole[seat] != 0)
                match.LanePrice[seat] = Math.Clamp(match.LanePrice[seat] + Math.Sign(inputs[seat]) * step, floor, ceiling);
        match.ClockTicks--;

        match.TradeMeter += MeterPerTick;
        if (match.TradeMeter < MeterPerTrade) return [];

        // Lowest ask among sellers with something to spare; highest bid among buyers who can
        // pay it. Only the surplus is on the floor: what a colonist needs for next month
        // stays home, so standing in a lane can never starve them.
        var seller = Best(match, Seller, p => Surplus(match, p.Seat, good) > 0, lowest: true);
        var buyer = Best(match, Buyer, p => p.Cash >= match.LanePrice[p.Seat], lowest: false);

        Trade? trade = null;
        if (seller >= 0 && buyer >= 0 && match.LanePrice[buyer] >= match.LanePrice[seller])
            trade = new Trade(seller, buyer, match.LanePrice[seller]);
        else if (buyer >= 0 && match.LanePrice[buyer] >= ceiling && match.Store.Stock[g] > 0)
            trade = new Trade(Store, buyer, ceiling);
        else if (seller >= 0 && match.LanePrice[seller] <= floor)
            trade = new Trade(seller, Store, floor);

        if (trade is not { } t)
        {
            // Hold the meter one tick short so the first contact trades at once.
            match.TradeMeter = MeterPerTrade - MeterPerTick;
            return [];
        }

        match.TradeMeter -= MeterPerTrade;
        if (t.Seller == Store) match.Store.Stock[g]--;
        else { match.Players[t.Seller].Goods[g]--; match.Players[t.Seller].Cash += t.Price; }
        if (t.Buyer == Store) match.Store.Stock[g]++;
        else { match.Players[t.Buyer].Goods[g]++; match.Players[t.Buyer].Cash -= t.Price; }
        return [t];
    }

    private static int Best(MatchState match, sbyte role, Func<PlayerState, bool> able, bool lowest)
    {
        var best = -1;
        foreach (var player in match.Players)
        {
            if (match.LaneRole[player.Seat] != role || !able(player)) continue;
            var (here, there) = (match.LanePrice[player.Seat], best < 0 ? 0 : match.LanePrice[best]);
            // Level prices: the colonist furthest behind trades first.
            if (best < 0 || (lowest ? here < there : here > there)
                || (here == there && PoMuleScoring.Trailing(match, [best, player.Seat]) == player.Seat))
                best = player.Seat;
        }
        return best;
    }

    /// <summary>Closes the good on the floor and moves its Store price for next month.</summary>
    public static void Close(MatchState match)
    {
        if (match.MarketGood == MatchState.Nobody) return;
        var good = (Good)match.MarketGood;
        // Food and Energy follow what the colony holds. Smithore and Crystite are priced at
        // month end, from the M.U.L.E. corral and the Federation (see EndOfMonth).
        if (good is Good.Food or Good.Energy)
        {
            var supply = match.Store.Stock[(int)good] + match.Players.Sum(p => p.Goods[(int)good]);
            var need = Enumerable.Range(0, match.Players.Length).Sum(seat => Need(match, seat, good));
            match.Store.Price[(int)good] = NextPrice(good, match.Store.Price[(int)good], supply, need);
        }
        match.MarketGood = MatchState.Nobody;
        Array.Clear(match.LaneRole);
    }

    /// <summary>Up 15% when the colony holds less than it needs, down 10% at twice its need.</summary>
    public static int NextPrice(Good good, int price, int supply, int need)
    {
        var next = supply < need ? (price * 115 + 99) / 100
            : supply >= need * 2 ? price * 90 / 100
            : price;
        return Math.Clamp(next, PoMuleTuning.PriceMin[(int)good], PoMuleTuning.PriceMax[(int)good]);
    }

    /// <summary>
    /// Smithore is worth what the corral lacks: dear when M.U.L.E.s are scarce, cheap when the
    /// Store has plenty. Half the opening herd in the corral gives the opening price.
    /// </summary>
    public static int SmithorePrice(int mulesInCorral) => Math.Clamp(
        PoMuleTuning.SmithorePriceTimesMules / Math.Max(1, mulesInCorral),
        PoMuleTuning.PriceMin[(int)Good.Smithore], PoMuleTuning.PriceMax[(int)Good.Smithore]);

    /// <summary>
    /// After the last market of the month: the Store turns Smithore into M.U.L.E.s, prices
    /// them off Smithore, and the Federation posts a new Crystite price.
    /// </summary>
    public static void EndOfMonth(MatchState match)
    {
        var store = match.Store;
        var built = store.Stock[(int)Good.Smithore] / PoMuleTuning.SmithorePerMule;
        store.Mules += built;
        store.Stock[(int)Good.Smithore] -= built * PoMuleTuning.SmithorePerMule;
        store.Price[(int)Good.Smithore] = SmithorePrice(store.Mules);
        store.MulePrice = store.Price[(int)Good.Smithore] * 2;
        store.Price[(int)Good.Crystite] = PoMuleTuning.PriceMin[(int)Good.Crystite]
            + match.Rng.Next(PoMuleTuning.PriceMax[(int)Good.Crystite] - PoMuleTuning.PriceMin[(int)Good.Crystite] + 1);
    }
}
