namespace PoMiniGames.Domain.Models;

/// <summary>
/// A player's best finished PoMule match in Azure Table Storage. Higher Net Worth is better;
/// the descriptor keeps ONE ratcheted row per player.
/// </summary>
/// <remarks>
/// <see cref="UserId"/>/<see cref="IsGuest"/> are the row's identity and are always resolved
/// server-side from the auth cookie, never from the request body (same rule as
/// <see cref="PoVoxelStrikeHighScore"/>). Species and the colony's fate ride along for
/// display; only <see cref="NetWorth"/> ranks.
/// </remarks>
public sealed record PoMuleHighScore
{
    public const int MinNetWorth = 0;

    /// <summary>A sanity ceiling, far above real play (10,000–30,000), that keeps a tampered number off the board.</summary>
    public const int MaxNetWorth = 500_000;

    /// <summary>Display name shown on the board (server-stamped, max 24 chars).</summary>
    public string PlayerName { get; init; } = string.Empty;

    /// <summary>Stable claims id of the submitter; empty for an anonymous caller.</summary>
    public string UserId { get; init; } = string.Empty;

    /// <summary>True when the submitter had no real player identity.</summary>
    public bool IsGuest { get; init; }

    /// <summary>Cash + land + installed M.U.L.E.s + goods at the end of month 12.</summary>
    public int NetWorth { get; init; }

    /// <summary>The species played, by its roster name.</summary>
    public string Species { get; init; } = string.Empty;

    /// <summary>False when the colony collapsed and the win was hollow.</summary>
    public bool ColonySurvived { get; init; }

    /// <summary>When the match ended. Persisted as an ISO-8601 string, matching sibling boards.</summary>
    public DateTimeOffset AchievedAtUtc { get; init; }
}
