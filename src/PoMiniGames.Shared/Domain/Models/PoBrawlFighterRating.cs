namespace PoMiniGames.Domain.Models;

/// <summary>
/// One PoBrawl fighter's head-to-head Elo rating, accumulated from CPU-vs-CPU demo-mode
/// matches. One row per fighter; higher rating ranks higher.
/// </summary>
/// <remarks>
/// This board rates <em>characters</em>, not players. Demo mode runs both sides at the same
/// CPU difficulty (<c>"medium"</c>, see <c>PoBrawlPage.InitEngine</c>), so the only thing
/// separating the two fighters is their stat block in <c>fighters.js</c> — which makes the
/// board a running measurement of roster balance rather than of anyone's skill. That is
/// also why it is a separate board from the presidents ladder, whose <c>Elo</c> column
/// rates a <em>player</em> against fixed per-rung ratings.
/// </remarks>
public sealed record PoBrawlFighterRating
{
    /// <summary>Canonical lowercase fighter id (see <c>PoBrawlRoster</c>).</summary>
    public string FighterId { get; init; } = string.Empty;

    /// <summary>Server-resolved display name. Never echoed from the submission.</summary>
    public string DisplayName { get; init; } = string.Empty;

    /// <summary>Current head-to-head Elo.</summary>
    public int Elo { get; init; }

    public int Wins { get; init; }
    public int Losses { get; init; }
    public int Draws { get; init; }

    /// <summary>Wins + losses + draws — the sample size behind <see cref="Elo"/>.</summary>
    public int Matches => Wins + Losses + Draws;

    /// <summary>ISO-8601 timestamp of the most recent match that moved this rating.</summary>
    public string LastUpdated { get; init; } = string.Empty;
}
