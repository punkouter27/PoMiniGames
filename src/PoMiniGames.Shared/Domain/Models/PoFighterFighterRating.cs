namespace PoMiniGames.Domain.Models;

/// <summary>
/// One PoFighter fighter's head-to-head Elo rating, accumulated from CPU-vs-CPU tournament
/// bouts. One row per fighter; higher rating ranks higher. Rates characters, not players.
/// </summary>
public sealed record PoFighterFighterRating
{
    /// <summary>Canonical lowercase fighter id (see <c>PoFighterRoster</c>).</summary>
    public string FighterId { get; init; } = string.Empty;

    /// <summary>Server-resolved display name. Never echoed from the submission.</summary>
    public string DisplayName { get; init; } = string.Empty;

    /// <summary>Current head-to-head Elo.</summary>
    public int Elo { get; init; }

    public int Wins { get; init; }
    public int Losses { get; init; }
    public int Draws { get; init; }

    /// <summary>Wins + losses + draws, the sample size behind <see cref="Elo"/>.</summary>
    public int Matches => Wins + Losses + Draws;

    /// <summary>ISO-8601 timestamp of the most recent bout that moved this rating.</summary>
    public string LastUpdated { get; init; } = string.Empty;
}
