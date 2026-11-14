namespace PoMiniGames.Shared.Games.PoMule;

/// <summary>Who gets which plot: the simultaneous monthly grant and the even-month auction.</summary>
public static class PoMuleLand
{
    public static bool Claimable(MatchState match, int plot) =>
        match.Owner[plot] == MatchState.Nobody && match.Map.Plots[plot].Terrain != Terrain.Town;

    /// <summary>
    /// Resolves every seat's pick at once.
    /// </summary>
    /// <param name="picks">Plot index per seat, or -1 for "picked nothing".</param>
    /// <returns>The plot each seat received, or -1.</returns>
    public static int[] Grant(MatchState match, IReadOnlyList<int> picks)
    {
        var awarded = new int[picks.Count];
        Array.Fill(awarded, -1);
        var displaced = new List<int>();

        foreach (var group in Enumerable.Range(0, picks.Count).Where(s => picks[s] >= 0).GroupBy(s => picks[s]))
        {
            var claimants = group.ToList();
            if (Claimable(match, group.Key))
            {
                var winner = PoMuleScoring.Trailing(match, claimants);
                claimants.Remove(winner);
                Give(match, winner, group.Key, awarded);
            }
            displaced.AddRange(claimants);
        }

        // Losers settle after every winner, lowest seat first, each on the nearest plot still free.
        foreach (var seat in displaced.Order())
        {
            var plot = NearestFree(match, picks[seat]);
            if (plot >= 0) Give(match, seat, plot, awarded);
        }
        return awarded;
    }

    /// <summary>
    /// The closest claimable plot to <paramref name="from"/>, searching outward ring by ring
    /// and around the seam, or -1 when the planet is full.
    /// </summary>
    public static int NearestFree(MatchState match, int from)
    {
        var (fromColumn, fromRow) = (from % PoMuleMap.Columns, from / PoMuleMap.Columns);
        var best = -1;
        var bestKey = int.MaxValue;
        for (var i = 0; i < match.Owner.Length; i++)
        {
            if (!Claimable(match, i)) continue;
            var dc = PoMuleMap.ColumnDistance(i % PoMuleMap.Columns, fromColumn);
            var dr = Math.Abs(i / PoMuleMap.Columns - fromRow);
            // Ring first, then straight-line neighbours before diagonals; index breaks ties.
            var key = Math.Max(dc, dr) * 100 + dc + dr;
            if (key < bestKey) (best, bestKey) = (i, key);
        }
        return best;
    }

    private static void Give(MatchState match, int seat, int plot, int[] awarded)
    {
        match.Owner[plot] = (sbyte)seat;
        awarded[seat] = plot;
    }

    public static bool IsAuctionMonth(int month) => month % 2 == 0;

    /// <summary>Up to two random free plots for this month's auction block.</summary>
    public static int[] PickAuctionPlots(MatchState match)
    {
        var free = Enumerable.Range(0, match.Owner.Length).Where(i => Claimable(match, i)).ToList();
        match.Rng.Shuffle(free);
        return [.. free.Take(PoMuleTuning.AuctionPlotsPerEvenMonth)];
    }

    /// <summary>Where every bidder starts: one step under the opening bid, which is no bid at all.</summary>
    public const int AuctionFloor = PoMuleTuning.AuctionOpeningBid - PoMuleTuning.AuctionStep;

    /// <summary>
    /// The top of the bidding floor as drawn. It starts at twice the opening bid and, like
    /// the original's, moves up ahead of the bidding, so the lanes always fill the floor
    /// instead of huddling at the bottom of a scale sized for the richest colonist's purse.
    /// </summary>
    public static int AuctionCeiling(MatchState match) =>
        Math.Max(PoMuleTuning.AuctionOpeningBid * 2, (match.LanePrice.Max() * 5 / 4 + 49) / 50 * 50);

    /// <summary>
    /// Puts a plot up for sale on the same walking floor as the goods: everyone is a buyer,
    /// standing at the bottom.
    /// </summary>
    public static void OpenAuction(MatchState match, int plot)
    {
        match.AuctionPlot = plot;
        match.HighBid = 0;
        match.HighBidder = MatchState.Nobody;
        Array.Fill(match.LaneRole, PoMuleMarket.Buyer);
        Array.Fill(match.LanePrice, AuctionFloor);
    }

    /// <summary>
    /// One tenth of a second of bidding. Walking up raises a colonist's bid, never past what
    /// they can pay; whoever stands highest holds the plot, and a tie goes to the one
    /// furthest behind in the standings.
    /// </summary>
    /// <param name="inputs">Per seat: +1 walks up, -1 walks down, 0 stands still.</param>
    /// <returns>True when anybody moved.</returns>
    public static bool AuctionTick(MatchState match, IReadOnlyList<int> inputs)
    {
        if (match.AuctionPlot < 0) return false;
        var moved = false;
        for (var seat = 0; seat < match.Players.Length; seat++)
        {
            var price = Math.Clamp(match.LanePrice[seat] + Math.Sign(inputs[seat]) * PoMuleTuning.AuctionStep,
                AuctionFloor, Math.Max(AuctionFloor, match.Players[seat].Cash));
            moved |= price != match.LanePrice[seat];
            match.LanePrice[seat] = price;
        }

        var top = match.LanePrice.Max();
        var bidding = top >= PoMuleTuning.AuctionOpeningBid;
        match.HighBid = bidding ? top : 0;
        match.HighBidder = !bidding ? MatchState.Nobody
            : (sbyte)PoMuleScoring.Trailing(match, Enumerable.Range(0, match.Players.Length).Where(s => match.LanePrice[s] == top));
        return moved;
    }

    /// <returns>The winning seat, or -1 when nobody bid.</returns>
    public static int CloseAuction(MatchState match)
    {
        var winner = match.HighBidder;
        if (winner != MatchState.Nobody)
        {
            match.Players[winner].Cash -= match.HighBid;
            match.Owner[match.AuctionPlot] = winner;
        }
        match.AuctionPlot = -1;
        Array.Clear(match.LaneRole);
        return winner;
    }
}
