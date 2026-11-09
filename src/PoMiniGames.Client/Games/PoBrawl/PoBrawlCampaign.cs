using PoMiniGames.Domain.Primitives;

namespace PoMiniGamesClient.Games.PoBrawl;

/// <summary>One tile of the campaign-trail cartogram: a state (or DC) and its electoral votes.</summary>
/// <param name="Code">USPS postal code, the tile's label.</param>
/// <param name="Name">Full name, for the accessible description.</param>
/// <param name="Votes">Electoral votes under the 2024–2032 apportionment.</param>
/// <param name="Col">Tile column, 0-based, on the <see cref="PoBrawlCampaign.Columns"/>-wide grid.</param>
/// <param name="Row">Tile row, 0-based, on the <see cref="PoBrawlCampaign.Rows"/>-tall grid.</param>
public sealed record PoBrawlCampaignState(string Code, string Name, int Votes, int Col, int Row);

/// <summary>
/// The 1P ladder as a campaign trail: every president beaten flips his home state plus a
/// regional "swing" batch of nearby states, and the electoral count crosses 270 on the last
/// rung and never before.
/// </summary>
/// <remarks>
/// <para>
/// The map is the newsroom square-tile cartogram (11 × 8, one tile per state), so there is no
/// geometry to ship: a tile is a grid cell. Batches are computed once, deterministically, from
/// <see cref="PoBrawlRoster.Fighters"/> in ladder order:
/// </para>
/// <list type="number">
/// <item>Each rung claims its president's home state, unless an earlier rung already took it
/// (three Texans and two Californians share a home).</item>
/// <item>The votes left under 269 after every non-final home state is a swing pool, shared out
/// across the non-final rungs, with a double share for a rung whose home was already taken so
/// it still flips something. Each rung spends its share on the nearest unclaimed tiles within a
/// short radius of the home tile, skipping any later rung's home state.</item>
/// <item>The final rung takes its home state and its neighbours until the count reaches 270.</item>
/// </list>
/// </remarks>
public static class PoBrawlCampaign
{
    /// <summary>Electoral votes needed to win.</summary>
    public const int ToWin = 270;

    /// <summary>Electoral votes in all.</summary>
    public const int TotalVotes = 538;

    /// <summary>Grid width in tiles.</summary>
    public const int Columns = 11;

    /// <summary>Grid height in tiles.</summary>
    public const int Rows = 8;

    // Squared tile distance a swing batch may reach from the home tile.
    private const int SwingRadiusSquared = 5;

    /// <summary>All 51 tiles, top-left to bottom-right.</summary>
    public static readonly IReadOnlyList<PoBrawlCampaignState> States =
    [
        new("AK", "Alaska", 3, 0, 0), new("ME", "Maine", 4, 10, 0),
        new("VT", "Vermont", 3, 9, 1), new("NH", "New Hampshire", 4, 10, 1),
        new("WA", "Washington", 12, 0, 2), new("ID", "Idaho", 4, 1, 2), new("MT", "Montana", 4, 2, 2),
        new("ND", "North Dakota", 3, 3, 2), new("MN", "Minnesota", 10, 4, 2), new("IL", "Illinois", 19, 5, 2),
        new("WI", "Wisconsin", 10, 6, 2), new("MI", "Michigan", 15, 7, 2), new("NY", "New York", 28, 8, 2),
        new("RI", "Rhode Island", 4, 9, 2), new("MA", "Massachusetts", 11, 10, 2),
        new("OR", "Oregon", 8, 0, 3), new("NV", "Nevada", 6, 1, 3), new("WY", "Wyoming", 3, 2, 3),
        new("SD", "South Dakota", 3, 3, 3), new("IA", "Iowa", 6, 4, 3), new("IN", "Indiana", 11, 5, 3),
        new("OH", "Ohio", 17, 6, 3), new("PA", "Pennsylvania", 19, 7, 3), new("NJ", "New Jersey", 14, 8, 3),
        new("CT", "Connecticut", 7, 9, 3),
        new("CA", "California", 54, 0, 4), new("UT", "Utah", 6, 1, 4), new("CO", "Colorado", 10, 2, 4),
        new("NE", "Nebraska", 5, 3, 4), new("MO", "Missouri", 10, 4, 4), new("KY", "Kentucky", 8, 5, 4),
        new("WV", "West Virginia", 4, 6, 4), new("VA", "Virginia", 13, 7, 4), new("MD", "Maryland", 10, 8, 4),
        new("DE", "Delaware", 3, 9, 4),
        new("AZ", "Arizona", 11, 1, 5), new("NM", "New Mexico", 5, 2, 5), new("KS", "Kansas", 6, 3, 5),
        new("AR", "Arkansas", 6, 4, 5), new("TN", "Tennessee", 11, 5, 5), new("NC", "North Carolina", 16, 6, 5),
        new("SC", "South Carolina", 9, 7, 5), new("DC", "District of Columbia", 3, 8, 5),
        new("OK", "Oklahoma", 7, 3, 6), new("LA", "Louisiana", 8, 4, 6), new("MS", "Mississippi", 6, 5, 6),
        new("AL", "Alabama", 9, 6, 6), new("GA", "Georgia", 16, 7, 6),
        new("HI", "Hawaii", 4, 0, 7), new("TX", "Texas", 40, 3, 7), new("FL", "Florida", 30, 8, 7),
    ];

    /// <summary>Each president's political home state, by fighter id.</summary>
    public static readonly IReadOnlyDictionary<string, string> HomeStates = new Dictionary<string, string>
    {
        ["trump"] = "FL",
        ["biden"] = "DE",
        ["obama"] = "IL",
        ["bush"] = "TX",
        ["clinton"] = "AR",
        ["bushsr"] = "TX",
        ["reagan"] = "CA",
        ["carter"] = "GA",
        ["ford"] = "MI",
        ["nixon"] = "CA",
        ["lbj"] = "TX",
        ["jfk"] = "MA",
        ["eisenhower"] = "KS",
        ["truman"] = "MO",
        ["fdr"] = "NY",
        ["hoover"] = "IA",
    };

    private static readonly Dictionary<string, PoBrawlCampaignState> ByCode = States.ToDictionary(s => s.Code);

    /// <summary>The tiles each rung flips when it is beaten, home state first, in ladder order.</summary>
    public static readonly IReadOnlyList<IReadOnlyList<string>> Batches = BuildBatches();

    // Votes after N rungs beaten, N = 0..Count.
    private static readonly int[] Cumulative = BuildCumulative();

    /// <summary>The tile for a postal code.</summary>
    public static PoBrawlCampaignState State(string code) => ByCode[code];

    /// <summary>The home state of the president on rung <paramref name="rung"/> (0-based).</summary>
    public static PoBrawlCampaignState HomeOf(int rung) =>
        ByCode[HomeStates[PoBrawlRoster.Fighters[Math.Clamp(rung, 0, PoBrawlRoster.Fighters.Count - 1)].Id]];

    /// <summary>Electoral votes held after <paramref name="beaten"/> rungs.</summary>
    public static int VotesAfter(int beaten) => Cumulative[Math.Clamp(beaten, 0, Cumulative.Length - 1)];

    /// <summary>The rung (0-based) whose win flips <paramref name="code"/>.</summary>
    public static int RungOf(string code)
    {
        for (var r = 0; r < Batches.Count; r++)
        {
            if (Batches[r].Contains(code)) return r;
        }
        return -1;
    }

    private static int VotesOf(IEnumerable<string> codes) => codes.Sum(c => ByCode[c].Votes);

    private static int Distance2(PoBrawlCampaignState a, PoBrawlCampaignState b) =>
        ((a.Col - b.Col) * (a.Col - b.Col)) + ((a.Row - b.Row) * (a.Row - b.Row));

    private static List<IReadOnlyList<string>> BuildBatches()
    {
        var homes = PoBrawlRoster.Fighters.Select(f => HomeStates[f.Id]).ToArray();
        var n = homes.Length;
        var last = n - 1;
        var claimed = new HashSet<string>();

        // Swing pool: what fits under 269 once every non-final rung's home state is in.
        var nonFinalHomes = homes.Take(last).Distinct().Where(h => h != homes[last]);
        var pool = (ToWin - 1) - VotesOf(nonFinalHomes);

        // A rung whose home is already won gets a double share, so it still flips something.
        var seen = new HashSet<string>();
        var weights = homes.Select(h => seen.Add(h) ? 1 : 2).ToArray();
        var weightLeft = weights.Take(last).Sum();

        var batches = new List<IReadOnlyList<string>>(n);
        var votes = 0;
        for (var r = 0; r < n; r++)
        {
            var home = ByCode[homes[r]];
            var batch = new List<string>();
            if (claimed.Add(home.Code)) batch.Add(home.Code);

            var reserved = homes.Skip(r + 1).ToHashSet();
            var candidates = States
                .Where(s => !claimed.Contains(s.Code) && !reserved.Contains(s.Code))
                .OrderBy(s => Distance2(s, home)).ThenBy(s => s.Votes).ThenBy(s => s.Code, StringComparer.Ordinal)
                .ToList();

            if (r < last)
            {
                var allowance = pool * weights[r] / weightLeft;
                foreach (var s in candidates.TakeWhile(s => Distance2(s, home) <= SwingRadiusSquared))
                {
                    if (s.Votes > allowance) continue;
                    batch.Add(s.Code);
                    claimed.Add(s.Code);
                    allowance -= s.Votes;
                    pool -= s.Votes;
                }
                if (batch.Count == 0 && candidates.FirstOrDefault(s => s.Votes <= pool) is { } fallback)
                {
                    batch.Add(fallback.Code);
                    claimed.Add(fallback.Code);
                    pool -= fallback.Votes;
                }
                weightLeft -= weights[r];
            }
            else
            {
                // The last rung: its neighbours, and on outward until the count is at 270.
                foreach (var s in candidates)
                {
                    if (votes + VotesOf(batch) >= ToWin && Distance2(s, home) > 2) break;
                    batch.Add(s.Code);
                    claimed.Add(s.Code);
                }
            }
            votes += VotesOf(batch);
            batches.Add(batch);
        }
        return batches;
    }

    private static int[] BuildCumulative()
    {
        var totals = new int[Batches.Count + 1];
        for (var r = 0; r < Batches.Count; r++) totals[r + 1] = totals[r] + VotesOf(Batches[r]);
        return totals;
    }
}
