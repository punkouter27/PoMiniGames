namespace PoMiniGames.Domain.Models;

/// <summary>
/// One player's best run up the PoBrawl presidents ladder (1-player mode).
/// One row per player identity; <see cref="PresidentsBeaten"/> is the best-ever count
/// (0 to PoBrawlRoster.Count, 15 today) and never goes down. More presidents beaten ranks higher.
/// </summary>
public sealed record PoBrawlLadderEntry
{
    public string PlayerName { get; init; } = string.Empty;
    public int PresidentsBeaten { get; init; }
    public int Elo { get; init; }
    public string Date { get; init; } = string.Empty;
}

/// <summary>What a ladder submission did to the player's stored row.</summary>
public enum PoBrawlLadderVerdict
{
    /// <summary>The row climbed (by at most one rung past what was stored).</summary>
    Climbed,

    /// <summary>Nothing to climb: the claim was at or below the stored best.</summary>
    Held,

    /// <summary>A climb arrived sooner after the previous one than any real fight allows.</summary>
    TooFast,

    /// <summary>Storage is down; nothing was written.</summary>
    Unavailable,
}
