using Azure;
using Azure.Data.Tables;

namespace PoMiniGames.Features.MatchHistory;

/// <summary>
/// One recorded outcome of a head-to-head match (local 2-player or online
/// multiplayer) between the owning player and a single named opponent.
/// </summary>
/// <remarks>
/// PartitionKey is the owner's stable identity (lowercased MS-OAuth email when
/// signed in, otherwise the guest display name). RowKey is reverse-chronological
/// so a plain partition scan returns most-recent-first without an in-memory sort.
/// </remarks>
public sealed class MatchRecordEntity : ITableEntity
{
    public string PartitionKey { get; set; } = string.Empty;
    public string RowKey { get; set; } = string.Empty;
    public DateTimeOffset? Timestamp { get; set; }
    public ETag ETag { get; set; }

    /// <summary>Game key, e.g. "pofunquiz", "pocouplequiz".</summary>
    public string Game { get; set; } = string.Empty;
    /// <summary>"local-2p" or "multiplayer".</summary>
    public string Mode { get; set; } = string.Empty;
    public string OpponentName { get; set; } = string.Empty;
    /// <summary>"guest" or "microsoft" — best-effort classification of the opponent.</summary>
    public string OpponentType { get; set; } = "guest";
    /// <summary>"win", "loss", or "draw" from the owner's perspective.</summary>
    public string Outcome { get; set; } = string.Empty;
    public DateTime PlayedAt { get; set; }
}

/// <summary>Inbound payload when a game reports a finished head-to-head result.</summary>
/// <remarks>
/// <paramref name="MatchId"/> is an optional client-generated idempotency key. When
/// supplied it is folded into the RowKey so a retried/duplicate POST collapses onto the
/// same row instead of double-recording the match.
/// </remarks>
public sealed record MatchRecordRequest(
    string Owner,
    string Game,
    string Mode,
    string OpponentName,
    string? OpponentType,
    string Outcome,
    string? OwnerType,
    string? MatchId = null);

/// <summary>Outbound match record returned to the stats page.</summary>
public sealed record MatchRecordDto(
    string Game,
    string Mode,
    string OpponentName,
    string OpponentType,
    string Outcome,
    DateTime PlayedAt);
