namespace PoMiniGames.Domain.Primitives;

/// <summary>One PoBrawl fighter: canonical id and the name every surface renders.</summary>
public sealed record PoBrawlFighter(string Id, string Name);

/// <summary>
/// The PoBrawl roster, and the server-side allowlist of the fighters that may appear on the
/// demo-mode Elo board.
/// </summary>
/// <remarks>
/// <para>
/// This is the single C# definition of the roster: the client projects
/// <c>PoBrawlPage.Roster</c> and its display names from <see cref="Fighters"/> rather than
/// restating them, so a rename lands on the ladder, the HUD and the Elo board together.
/// One cross-language copy remains — <c>wwwroot/js/pobrawl/fighters.js</c> <c>CHARACTERS</c>,
/// which the engine simulates — and it is the only list that has to be kept in step by hand.
/// </para>
/// <para>
/// The allowlist is what bounds the board. Rating rows are keyed by fighter id, so an
/// unvalidated id is a free row-multiplier — exactly the hazard
/// <see cref="T:PoMiniGames.Infrastructure.Services.HighScoreDescriptor`1"/> warns about for
/// RowKey fields. Accepting only ids that exist here keeps the partition bounded at
/// <see cref="Count"/> rows forever, no matter what a caller posts. The display name is
/// resolved here rather than taken from the request for the same reason: the board must not
/// render caller-supplied strings.
/// </para>
/// <para>
/// <b><see cref="Bob"/> is deliberately not in <see cref="Fighters"/>.</b> He is the 1-player
/// avatar and a 2-player pick, never a demo-mode combatant (demo draws both fighters from the
/// presidents roster), so admitting him would create a permanently 0-match row on the board.
/// He is exposed separately because the client still has to name and render him.
/// </para>
/// </remarks>
public static class PoBrawlRoster
{
    /// <summary>
    /// The rateable presidents, in ladder order — most recent first, marching back to Hoover.
    /// </summary>
    /// <remarks>
    /// The order is load-bearing for the client, not for this class: the board ranks by
    /// rating, but <c>PoBrawlPage</c> indexes this list as the 1-player ladder, where the rung
    /// index doubles as the CPU difficulty level (index + 1 → 1-16, the range ai.js
    /// LEVELS/MAX_RUNG defines). Reordering it reorders the ladder.
    /// </remarks>
    public static readonly IReadOnlyList<PoBrawlFighter> Fighters =
    [
        new("trump", "Trump"),
        new("biden", "Biden"),
        new("obama", "Obama"),
        new("bush", "Bush"),
        new("clinton", "Clinton"),
        new("bushsr", "Bush Sr."),
        new("reagan", "Reagan"),
        new("carter", "Carter"),
        new("ford", "Ford"),
        new("nixon", "Nixon"),
        new("lbj", "LBJ"),
        new("jfk", "JFK"),
        new("eisenhower", "Eisenhower"),
        new("truman", "Truman"),
        new("fdr", "FDR"),
        new("hoover", "Hoover"),
    ];

    /// <summary>The 1-player avatar and 2-player pick. Never rateable — see the type remarks.</summary>
    public static readonly PoBrawlFighter Bob = new("bob", "BOB");

    // Case-insensitive so a caller's casing can never split one fighter across two rows.
    private static readonly Dictionary<string, string> NamesById =
        Fighters.ToDictionary(f => f.Id, f => f.Name, StringComparer.OrdinalIgnoreCase);

    // Every fighter a player can pick: the presidents plus Bob. Declared after both.
    private static readonly Dictionary<string, PoBrawlFighter> PickableById =
        Fighters.Append(Bob).ToDictionary(f => f.Id, StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// The fighter for <paramref name="fighterId"/> (any casing), Bob included, or <c>null</c>
    /// when it names nobody. The returned record carries the canonical id and display name.
    /// </summary>
    public static PoBrawlFighter? Find(string? fighterId) =>
        fighterId is not null && PickableById.TryGetValue(fighterId, out var fighter) ? fighter : null;

    /// <summary>The display name for any fighter id, Bob included, or <c>null</c> when it names nobody.</summary>
    public static string? NameOf(string? fighterId) => Find(fighterId)?.Name;

    /// <summary>Number of rateable fighters — the hard ceiling on rows in the Elo partition.</summary>
    public static int Count => Fighters.Count;

    /// <summary>True when <paramref name="fighterId"/> is a fighter the Elo board accepts.</summary>
    public static bool IsRateable(string? fighterId) =>
        !string.IsNullOrWhiteSpace(fighterId) && NamesById.ContainsKey(fighterId);

    /// <summary>
    /// The canonical lowercase id for a fighter, or <c>null</c> when the id is not rateable.
    /// Callers persist this, never the raw request value, so casing can never split one
    /// fighter across two rows.
    /// </summary>
    public static string? Canonicalize(string? fighterId) =>
        IsRateable(fighterId) ? fighterId!.ToLowerInvariant() : null;

    /// <summary>
    /// Display name for a rateable fighter id. Falls back to the id itself for a row written
    /// by an older build whose roster has since changed — a stale row should still render.
    /// </summary>
    public static string DisplayName(string fighterId) =>
        NamesById.TryGetValue(fighterId, out var name) ? name : fighterId;
}
