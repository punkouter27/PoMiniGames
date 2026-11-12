using System.Text.RegularExpressions;
using Azure.Data.Tables;

namespace PoMiniGames.Features.MatchHistory;

/// <summary>
/// Table Storage persistence for head-to-head match results, keyed by owner.
/// Mirrors the per-game repository pattern (e.g. PoFunQuiz LeaderboardRepository):
/// constructor-injects the shared <see cref="TableServiceClient"/> and writes to
/// a single table.
/// </summary>
public sealed class MatchHistoryRepository(TableServiceClient tableServiceClient)
{
    private const string TableName = "MatchHistory";
    private readonly TableClient _table = tableServiceClient.GetTableClient(TableName);
    private bool _ensured;

    private async Task EnsureTableAsync(CancellationToken ct)
    {
        if (_ensured) return;
        await _table.CreateIfNotExistsAsync(cancellationToken: ct);
        _ensured = true;
    }

    /// <summary>
    /// Write one history row. Returns <c>false</c> when the row is a duplicate — the same
    /// owner already recorded this <see cref="MatchRecordRequest.MatchId"/> — and <c>true</c>
    /// when a row was written (or the write degraded silently, in which case there is no row
    /// and nothing else in the call chain can claim this one). Callers that attach side effects
    /// to a match (the PoBrawl Elo increment) gate those on the separate match-global claim in
    /// <see cref="TryClaimEloIncrementAsync"/>, because a history marker here is per-owner and
    /// both corners of the same fight legitimately record their own row.
    /// </summary>
    public async Task<bool> RecordAsync(MatchRecordRequest request, CancellationToken ct = default)
    {
        try
        {
            await EnsureTableAsync(ct);

            var ownerKey = OwnerKey(request.Owner);

            // Idempotency: when the caller supplies a MatchId, claim a dedup marker in a
            // SEPARATE partition first. A retried POST re-claims the same marker → 409 → we
            // return false without writing a second history row. The marker partition is never
            // touched by GetForOwnerAsync (which filters on the owner partition), so markers
            // don't pollute reads. The real record still uses a volatile reverse-chrono RowKey
            // for most-recent-first ordering.
            if (!string.IsNullOrWhiteSpace(request.MatchId))
            {
                var marker = new TableEntity($"dedup:{ownerKey}", IdempotencyKey(request.MatchId!));
                try
                {
                    await _table.AddEntityAsync(marker, ct);
                }
                catch (Azure.RequestFailedException ex) when (ex.Status == 409)
                {
                    return false; // Already recorded for this idempotency key.
                }
            }

            var playedAt = DateTime.UtcNow;
            // Reverse-chronological RowKey so a partition scan yields most-recent first.
            var inverse = (DateTimeOffset.MaxValue.Ticks - playedAt.Ticks).ToString("D19", System.Globalization.CultureInfo.InvariantCulture);
            var entity = new MatchRecordEntity
            {
                PartitionKey = ownerKey,
                RowKey = $"{inverse}-{Guid.NewGuid():N}",
                Game = Clean(request.Game, 40),
                Mode = NormalizeMode(request.Mode),
                OpponentName = Clean(request.OpponentName, 60),
                OpponentType = NormalizeOpponentType(request.OpponentType, request.OpponentName),
                Outcome = NormalizeOutcome(request.Outcome),
                PlayedAt = playedAt
            };

            await _table.AddEntityAsync(entity, ct);
            return true;
        }
        // Graceful degradation: an unreachable Table Storage backend (Azurite down,
        // missing connection string) must NOT 500 the match-history POST. The match
        // itself already finished; the home-page poll will reflect the gap on the
        // next read. Same policy as StorageService.MarkUnavailable on the high-score
        // path. Broadened to Exception so the 2s network timeout's TaskCanceledException
        // is also covered.
        catch (Exception)
        {
            // Silent drop — the caller already validated the payload.
            return false;
        }
    }

    /// <summary>
    /// Claim the right to apply a match's Elo increment, once per MATCH id — not per owner.
    /// Both corners of a PoBrawl 1v1 POST the same finished match; without this match-global
    /// marker the zero-sum rating pair-write ran twice (each corner's POST applied it). The
    /// history dedup above cannot arbitrate — its marker is keyed by owner, and neither of
    /// its outcomes is visible to callers. First POST in wins; every other caller skips the
    /// increment. A storage failure is its own answer, not "already claimed": folded into
    /// false, a match whose claim could not even be written lost its Elo silently.
    /// </summary>
    public async Task<EloClaim> TryClaimEloIncrementAsync(string matchId, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(matchId)) return EloClaim.AlreadyClaimed;
        try
        {
            await EnsureTableAsync(ct);
            await _table.AddEntityAsync(new TableEntity(EloClaimPartition, IdempotencyKey(matchId)), ct);
            return EloClaim.Claimed;
        }
        catch (Azure.RequestFailedException ex) when (ex.Status == 409)
        {
            return EloClaim.AlreadyClaimed; // The other corner (or a retry) already applied this match's Elo.
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            // Storage down: no claim was taken, and the Elo write would fail the same way.
            return EloClaim.Unavailable;
        }
    }

    /// <summary>
    /// Give a claim back after the Elo write it guarded failed, so the next POST of the match (a
    /// retry, or the other corner) can claim it and apply the swing. Best effort: if this delete
    /// fails too, the match keeps its marker and its Elo is lost — the same outcome as before,
    /// now only on a double failure.
    /// </summary>
    public async Task ReleaseEloIncrementAsync(string matchId, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(matchId)) return;
        try
        {
            await _table.DeleteEntityAsync(EloClaimPartition, IdempotencyKey(matchId), cancellationToken: ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            // Nothing more to do; see the summary.
        }
    }

    private const string EloClaimPartition = "dedup:matchelo";

    // Stable Table-safe RowKey for a dedup marker derived from the client idempotency key.
    private static string IdempotencyKey(string matchId)
    {
        var hash = System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes(matchId.Trim()));
        return Convert.ToHexStringLower(hash)[..32];
    }

    public async Task<IReadOnlyList<MatchRecordDto>> GetForOwnerAsync(string owner, int limit, CancellationToken ct = default)
    {
        limit = Math.Clamp(limit, 1, 1000);

        try
        {
            await EnsureTableAsync(ct);

            var key = OwnerKey(owner);
            var results = new List<MatchRecordDto>();
            await foreach (var e in _table.QueryAsync<MatchRecordEntity>(
                filter: $"PartitionKey eq '{key.Replace("'", "''")}'",
                maxPerPage: 100,
                cancellationToken: ct))
            {
                results.Add(new MatchRecordDto(e.Game, e.Mode, e.OpponentName, e.OpponentType, e.Outcome, e.PlayedAt));
                if (results.Count >= limit) break;
            }
            return results;
        }
        // Graceful degradation: an unreachable Table Storage backend (Azurite down,
        // missing connection string) must NOT 500 the home-page match-history poll.
        // Returning an empty list lets the client render "no matches yet" rather
        // than crash the page. Broadened to Exception so the 2s network timeout's
        // TaskCanceledException is also covered — same pattern as the leaderboards.
        catch (Exception)
        {
            return Array.Empty<MatchRecordDto>();
        }
    }

    // ─── Normalisation helpers ────────────────────────────────────────────

    /// <summary>
    /// Owner identity → a Table-safe PartitionKey. Lowercased so an email and its
    /// differently-cased twin land in the same partition; control and reserved
    /// characters (/ \ # ?) stripped.
    /// </summary>
    internal static string OwnerKey(string owner)
    {
        var s = (owner ?? string.Empty).Trim().ToLowerInvariant();
        s = Regex.Replace(s, @"[\x00-\x1F/\\#?]", "_");
        if (string.IsNullOrEmpty(s)) s = "anonymous";
        return s.Length <= 200 ? s : s[..200];
    }

    private static string NormalizeMode(string mode) =>
        string.Equals(mode, "local-2p", StringComparison.OrdinalIgnoreCase) ? "local-2p" : "multiplayer";

    private static string NormalizeOutcome(string outcome) => (outcome ?? "").Trim().ToLowerInvariant() switch
    {
        "win" => "win",
        "loss" => "loss",
        _ => "draw"
    };

    private static string NormalizeOpponentType(string? type, string name)
    {
        var t = (type ?? "").Trim().ToLowerInvariant();
        if (t is "microsoft" or "guest") return t;
        // Heuristic fallback: an opponent name shaped like an email is an MS-OAuth identity.
        return (name ?? "").Contains('@') ? "microsoft" : "guest";
    }

    private static string Clean(string s, int max)
    {
        s = Regex.Replace(s ?? string.Empty, "<.*?>", string.Empty).Trim();
        return s.Length <= max ? s : s[..max];
    }
}

/// <summary>The outcome of <see cref="MatchHistoryRepository.TryClaimEloIncrementAsync"/>.</summary>
public enum EloClaim
{
    /// <summary>This caller applies the match's Elo.</summary>
    Claimed,

    /// <summary>Someone already did (or is doing) it.</summary>
    AlreadyClaimed,

    /// <summary>Storage could not be reached: nothing was claimed, and the caller should ask for a retry.</summary>
    Unavailable,
}
