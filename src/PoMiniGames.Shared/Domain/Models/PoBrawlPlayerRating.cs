namespace PoMiniGames.Domain.Models;

/// <summary>
/// One player's live 1v1 PoBrawl Elo rating, accumulated from online head-to-head matches.
/// One row per principal identity; higher rating ranks higher.
/// </summary>
/// <remarks>
/// <para>
/// Deliberately a separate table from <see cref="PoBrawlFighterRating"/>. The fighter
/// board rates <em>characters</em> from unattended CPU-vs-CPU demo matches; this one
/// rates <em>players</em> from real human-vs-human online matches. They cannot share
/// a board because the sample populations are disjoint (15 fighters vs. an unbounded
/// set of player principals) and a single row schema cannot express both without
/// losing the floor / seed / display-name semantics each side needs.
/// </para>
/// <para>
/// Path-dependent — same reasoning as <see cref="PoBrawlFighterRating"/>. The rating
/// is the only record of the history, so writes apply their delta as an increment,
/// not as an absolute computed from the read.
/// </para>
/// </remarks>
public sealed record PoBrawlPlayerRating
{
    /// <summary>Stable auth-cookie principal id (lowercased). Acts as the table RowKey.</summary>
    public string PrincipalId { get; init; } = string.Empty;

    /// <summary>Display name resolved from the claim identity, last seen at write time.</summary>
    public string DisplayName { get; init; } = string.Empty;

    public int Elo { get; init; }
    public int Wins { get; init; }
    public int Losses { get; init; }
    public int Draws { get; init; }

    /// <summary>Wins + losses + draws.</summary>
    public int Matches => Wins + Losses + Draws;

    /// <summary>ISO-8601 timestamp of the most recent match that moved this rating.</summary>
    public string LastUpdated { get; init; } = string.Empty;
}
