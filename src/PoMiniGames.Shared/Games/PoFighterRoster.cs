namespace PoMiniGames.Shared.Games;

/// <summary>One rateable PoFighter combatant: canonical lowercase id and display name.</summary>
public sealed record PoFighterEntry(string Id, string Name);

/// <summary>
/// The fighters the PoFighter Elo board accepts. Ids are canonical lowercase; the server
/// resolves display names from here, never from a submission, so the rating partition stays
/// bounded at <see cref="Count"/> rows.
/// </summary>
public static class PoFighterRoster
{
    public static readonly IReadOnlyList<PoFighterEntry> Fighters =
    [
        new("p1", "Nick"),
        new("kim", "Kim"),
    ];

    private static readonly Dictionary<string, string> NamesById =
        Fighters.ToDictionary(f => f.Id, f => f.Name, StringComparer.OrdinalIgnoreCase);

    public static int Count => Fighters.Count;

    public static bool IsRateable(string? fighterId) =>
        !string.IsNullOrWhiteSpace(fighterId) && NamesById.ContainsKey(fighterId);

    /// <summary>The canonical lowercase id, or null when the id is not on the roster.</summary>
    public static string? Canonicalize(string? fighterId) =>
        IsRateable(fighterId) ? fighterId!.ToLowerInvariant() : null;

    /// <summary>Display name for a roster id; falls back to the id for a dropped one.</summary>
    public static string DisplayName(string fighterId) =>
        NamesById.TryGetValue(fighterId, out var name) ? name : fighterId;
}
