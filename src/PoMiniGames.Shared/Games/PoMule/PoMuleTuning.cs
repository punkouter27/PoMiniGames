namespace PoMiniGames.Shared.Games.PoMule;

/// <summary>
/// Every balance number in PoMule, in one place. Values the PRD did not define are the
/// "proposed" ones from SPEC.md §6; the 100-match balance test is what holds them honest.
/// </summary>
public static class PoMuleTuning
{
    /// <summary>Colonists on Irata: the player and fifteen AI, or sixteen AI in a demo.</summary>
    public const int Seats = 16;
    public const int Months = 12;
    public const int TicksPerSecond = 10;

    // Phase lengths, seconds.
    /// <summary>Ticks the land-grant highlighter rests on each free plot (five plots a second).</summary>
    public const int LandStepTicks = 2;
    public const int AuctionSeconds = 20;
    public const int DevelopmentSeconds = 45;
    public const int MarketSeconds = 12;
    public const int ProductionSeconds = 6;
    public const int EventSeconds = 4;
    public const int StandingsSeconds = 6;

    // Starting position. The Store and the corral are stocked for sixteen colonists: twice
    // what eight needed, so the bigger colony starts no hungrier than the smaller one did.
    public const int StartFood = 4;
    public const int StartEnergy = 2;
    public static readonly IReadOnlyList<int> StoreStartStock = [64, 64, 0, 0];
    public static readonly IReadOnlyList<int> StoreStartPrice = [30, 25, 50, 100];
    public const int StoreStartMules = 56;
    public const int MuleStartPrice = 100;

    // Outfitting a M.U.L.E. for Food / Energy / Smithore / Crystite.
    public static readonly IReadOnlyList<int> OutfitCost = [25, 50, 75, 100];

    // Land.
    public const int AuctionOpeningBid = 160;
    public const int AuctionPlotsPerEvenMonth = 2;

    /// <summary>Credits a bidder's lane moves per tick on the land-auction floor.</summary>
    public const int AuctionStep = 10;

    /// <summary>Ticks the plot for sale is shown on the map before the bidding floor opens.</summary>
    public const int AuctionPreviewTicks = 30;

    // AI timing, in clock ticks left: the Gambler works only the first 15 s; the Agitator
    // and the Prospector give up their errands with 15 s to go and head for the pub.
    public const int GamblerWorksUntilTicks = 300;
    public const int AgitatorHuntsUntilTicks = 150;

    /// <summary>
    /// How strongly the Smithore price pulls AI colonists toward mountains at the land grant:
    /// a plot's ore yield × the price ÷ this is added to its appeal (a river scores 100).
    /// </summary>
    public const int OreAppealDivisor = 3;

    /// <summary>No AI colonist buys a M.U.L.E. with less clock than this: it would never get it home.</summary>
    public const int LastMuleErrandTicks = 150;

    // Development.
    public const int PubCap = 250;
    /// <summary>The least share of the month's clock a hungry colonist still gets.</summary>
    public const int MinTimePercent = 40;

    /// <summary>The unit a stroke of personal luck is counted in during months 1–4; double in 5–8, triple in 9–12.</summary>
    public const int LuckCredits = 25;

    /// <summary>The wampus shows itself on a mountain for 3 s in every 10 s of development.</summary>
    public const int WampusCycleTicks = 100;
    public const int WampusVisibleTicks = 30;

    /// <summary>What catching the wampus pays: 100, 200, then 300 credits as the match goes on.</summary>
    public static int WampusBounty(int month) => 100 * (1 + (Math.Clamp(month, 1, Months) - 1) / 4);

    // Production and events.
    public const int WarehouseCap = 50;
    public const int EventChancePercent = 75;

    /// <summary>How often each <see cref="ColonyEvent"/> may strike in one match, indexed by the event.</summary>
    public static readonly IReadOnlyList<int> EventCap = [0, 3, 3, 3, 3, 2, 2, 2, 2, 1];

    /// <summary>No plot makes more than this in a plain month, however well placed.</summary>
    public const int MaxPlotYield = 8;

    /// <summary>This many colonists short of Food or Energy in one month is a colony crisis (three in eight, as before).</summary>
    public const int CrisisShortColonists = 6;

    // Market. Limits on the Store's buying price for Food / Energy / Smithore / Crystite.
    public static readonly IReadOnlyList<int> PriceMin = [15, 15, 25, 50];
    public static readonly IReadOnlyList<int> PriceMax = [150, 150, 250, 150];

    /// <summary>What the Store adds to its buying price when it sells, per good.</summary>
    public static readonly IReadOnlyList<int> StoreSpread = [35, 35, 35, 140];

    /// <summary>
    /// With the Store sold out nothing holds prices down: the floor's top moves up to this
    /// many spreads above the Store's buying price.
    /// </summary>
    // ponytail: a tall fixed axis, not a truly limitless one; scroll the floor if it is ever hit.
    public const int SoldOutSpreads = 4;
    public const int SmithorePerMule = 2;

    /// <summary>Clock ticks left when sellers of Food and Energy give up waiting for a buyer.</summary>
    public const int MarketLastCallTicks = 50;

    /// <summary>Food and Energy an AI colonist will not sell, beyond next month's need.</summary>
    public static readonly IReadOnlyList<int> AiReserve = [2, 3];

    /// <summary>
    /// Smithore price × M.U.L.E.s in the corral: 28 M.U.L.E.s (half the opening herd) price
    /// Smithore at 50, so ore pays while there is still a M.U.L.E. left to mine it with.
    /// </summary>
    public const int SmithorePriceTimesMules = 1400;

    // Scoring.
    public const int LandValue = 500;
    public const int MuleValue = 350;
    public const int FederationTarget = 120_000;
    public const int MaxCrisisMonths = 1;

    /// <summary>Food a colonist must hold to work a full month: 3, then 4, then 5.</summary>
    public static int FoodNeed(int month) => 3 + (Math.Clamp(month, 1, Months) - 1) / 4;
}
