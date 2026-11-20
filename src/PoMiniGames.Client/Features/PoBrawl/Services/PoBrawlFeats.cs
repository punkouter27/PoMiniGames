using System.Globalization;

namespace PoMiniGamesClient.Features.PoBrawl;

/// <summary>One Brawl feat: something done in a fight, as opposed to how far up the ladder.</summary>
/// <param name="Id">The id the engine reports (js/pobrawl/feats.js FEATS).</param>
/// <param name="Icon">An emoji for the badge.</param>
/// <param name="Title">The badge's name.</param>
/// <param name="Hint">How to earn it, in one line.</param>
public sealed record PoBrawlFeat(string Id, string Icon, string Title, string Hint);

/// <summary>
/// The Brawl feats and the text form they are stored in. The engine decides when one is earned
/// (js/pobrawl/feats.js, at the end of every round) and reports ids with the match result; the
/// 1P page stores them through <see cref="PoBrawlProgressBook"/>, and the achievements
/// (<c>AchievementService</c>) and Brawl HQ read them from there.
/// </summary>
/// <remarks>
/// The ids are a contract with <c>feats.js</c>: an id added there needs a row here, and an id
/// the engine never sends is a badge nobody can earn.
/// </remarks>
public static class PoBrawlFeats
{
    public static readonly IReadOnlyList<PoBrawlFeat> All =
    [
        new("flawless", "🧼", "Untouched", "Win a Brawl round without losing any health"),
        new("comeback", "❤️‍🩹", "Off the ropes", "Win a Brawl round after dropping to 10 health or less"),
        new("no-kicks", "👊", "Hands only", "Win a Brawl round without throwing a kick"),
        new("wakeup-ko", "🛌", "Rise and shine", "Knock a president out with a strike thrown as you get up"),
        new("counter-ko", "🎯", "Read and reply", "Knock a president out with the counter after a perfect guard"),
        new("quick-ko", "⏱️", "Early night", "Knock a president out inside 15 seconds"),
        new("perfect-3", "🛡️", "Wall of timing", "Land three perfect guards in one Brawl round"),
        new("combo-5", "🥁", "Five piece", "Land a five-hit combo in Brawl"),
        new("crate-crash", "📦", "Special delivery", "Knock a president into the crates or a turnbuckle"),
        new("guard-breaker", "🤼", "Guard breaker", "Grab a president who is hiding behind the guard"),
        new("showboat", "🎩", "Showboat", "Finish a taunt and still win the Brawl round"),
    ];

    private static readonly HashSet<string> Ids = All.Select(f => f.Id).ToHashSet(StringComparer.Ordinal);

    /// <summary>True for an id in <see cref="All"/>.</summary>
    public static bool IsKnown(string? id) => id is not null && Ids.Contains(id);

    /// <summary>
    /// Reads the stored form, <c>"flawless:3,comeback:1"</c>. Unknown ids, bad counts and junk are
    /// dropped, so a hand-edited or stale value can only ever lose a badge, never invent one.
    /// </summary>
    public static Dictionary<string, int> Parse(string? stored)
    {
        var counts = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var pair in (stored ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var parts = pair.Split(':');
            if (parts.Length == 2 && IsKnown(parts[0])
                && int.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out var n) && n > 0)
            {
                counts[parts[0]] = n;
            }
        }
        return counts;
    }

    /// <summary>The stored form of <paramref name="counts"/>, in <see cref="All"/> order.</summary>
    public static string Format(IReadOnlyDictionary<string, int> counts) =>
        string.Join(',', All.Where(f => counts.GetValueOrDefault(f.Id) > 0)
            .Select(f => string.Create(CultureInfo.InvariantCulture, $"{f.Id}:{counts[f.Id]}")));

    /// <summary>
    /// Adds one to each known id in <paramref name="earned"/> (an id repeated in one report counts
    /// once) and returns the ids that were earned for the first time.
    /// </summary>
    public static List<string> Add(Dictionary<string, int> counts, IEnumerable<string>? earned)
    {
        var fresh = new List<string>();
        foreach (var id in (earned ?? []).Where(IsKnown).Distinct(StringComparer.Ordinal))
        {
            var before = counts.GetValueOrDefault(id);
            counts[id] = before + 1;
            if (before == 0) fresh.Add(id);
        }
        return fresh;
    }
}
