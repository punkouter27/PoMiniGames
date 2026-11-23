using Azure;
using Azure.Data.Tables;
using PoMiniGames.Domain.Services;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.Shared.TurnMatch;

/// <summary>One row of the Connect Five online rating board.</summary>
public sealed record ConnectFiveOnlineRating(string PlayerId, string DisplayName, int Rating, int Games, int Wins, int Losses, int Draws);

/// <summary>
/// Server-authoritative online Elo for Connect Five (K 32, start 1200), kept in the
/// <see cref="TableName"/> table: partition <see cref="Partition"/>, one row per player id
/// (the same sanitized id the lobby seats use). Only <see cref="TurnMatchService{THub}"/> writes it,
/// after it has decided a match; there is no write endpoint. Separate from the 1P adaptive rating.
/// </summary>
public sealed class ConnectFiveOnlineEloStore(TableServiceClient tables, ILogger<ConnectFiveOnlineEloStore> log) : ITurnMatchResultSink
{
    /// <summary>Must match the entry in <c>StorageInitializer.AdditionalTables</c>.</summary>
    public const string TableName = "ConnectFiveOnlineElo";
    public const string Partition = "elo";
    private const int MaxAttempts = 4;

    private Task<TableClient>? _table;

    private Task<TableClient> TableAsync() => _table ??= CreateAsync();

    private async Task<TableClient> CreateAsync()
    {
        try
        {
            var client = tables.GetTableClient(TableName);
            await client.CreateIfNotExistsAsync();
            return client;
        }
        catch
        {
            _table = null; // retry on the next call
            throw;
        }
    }

    public async Task<TurnMatchRatings?> RecordAsync(TurnMatchResult result, CancellationToken cancellationToken = default)
    {
        if (result.FirstId == result.SecondId || result.FirstId == "anon" || result.SecondId == "anon") return null;
        var table = await TableAsync();

        for (var attempt = 0; attempt < MaxAttempts; attempt++)
        {
            var first = await ReadAsync(table, result.FirstId, cancellationToken);
            var second = await ReadAsync(table, result.SecondId, cancellationToken);
            var score = result.Status switch
            {
                TurnMatchStatus.FirstWon => 1.0,
                TurnMatchStatus.SecondWon => 0.0,
                TurnMatchStatus.Draw => 0.5,
                _ => throw new InvalidOperationException("The match is not finished."),
            };
            var delta = TurnGameElo.DeltaForFirst(first.Rating, second.Rating, score);
            Apply(first, result.FirstName, delta, score);
            Apply(second, result.SecondName, -delta, 1 - score);
            try
            {
                // Same partition, so both rows land in one atomic transaction.
                await table.SubmitTransactionAsync(
                    [ToAction(result.FirstId, first), ToAction(result.SecondId, second)], cancellationToken);
                return new TurnMatchRatings(
                    new TurnRatingChange(first.Rating, delta, first.Games),
                    new TurnRatingChange(second.Rating, -delta, second.Games));
            }
            catch (TableTransactionFailedException ex) when (ex.Status is 409 or 412 && attempt < MaxAttempts - 1)
            {
                log.LogDebug("Connect Five Elo write for match {MatchId} raced another match; retrying.", result.MatchId);
            }
        }
        return null;
    }

    /// <summary>Top of the board, highest rating first.</summary>
    public async Task<IReadOnlyList<ConnectFiveOnlineRating>> GetTopAsync(int limit, CancellationToken cancellationToken = default)
    {
        var table = await TableAsync();
        var rows = new List<ConnectFiveOnlineRating>();
        await foreach (var e in table.QueryAsync<TableEntity>(
            filter: $"PartitionKey eq '{Partition}'", cancellationToken: cancellationToken))
        {
            rows.Add(ToRating(e));
        }
        return rows.Where(r => r.Games > 0)
            .OrderByDescending(r => r.Rating).ThenByDescending(r => r.Games).ThenBy(r => r.DisplayName, StringComparer.Ordinal)
            .Take(Math.Max(1, limit)).ToList();
    }

    private sealed class Row
    {
        public int Rating { get; set; } = TurnGameElo.StartRating;
        public int Games { get; set; }
        public int Wins { get; set; }
        public int Losses { get; set; }
        public int Draws { get; set; }
        public string DisplayName { get; set; } = "";
        public ETag ETag { get; set; }
        public bool Exists { get; set; }
    }

    private static async Task<Row> ReadAsync(TableClient table, string id, CancellationToken ct)
    {
        var found = await table.GetEntityIfExistsAsync<TableEntity>(Partition, id, cancellationToken: ct);
        if (!found.HasValue) return new Row();
        var e = found.Value!;
        var r = ToRating(e);
        return new Row
        {
            Rating = r.Rating,
            Games = r.Games,
            Wins = r.Wins,
            Losses = r.Losses,
            Draws = r.Draws,
            DisplayName = r.DisplayName,
            ETag = e.ETag,
            Exists = true,
        };
    }

    private static void Apply(Row row, string name, int delta, double score)
    {
        row.Rating += delta;
        row.Games++;
        if (score >= 1) row.Wins++;
        else if (score <= 0) row.Losses++;
        else row.Draws++;
        row.DisplayName = string.IsNullOrWhiteSpace(name) ? row.DisplayName : name;
    }

    private static TableTransactionAction ToAction(string id, Row row)
    {
        var entity = new TableEntity(Partition, id)
        {
            ["DisplayName"] = row.DisplayName,
            ["Rating"] = row.Rating,
            ["Games"] = row.Games,
            ["Wins"] = row.Wins,
            ["Losses"] = row.Losses,
            ["Draws"] = row.Draws,
            ["UpdatedUtc"] = DateTimeOffset.UtcNow,
        };
        return row.Exists
            ? new TableTransactionAction(TableTransactionActionType.UpdateReplace, entity, row.ETag)
            : new TableTransactionAction(TableTransactionActionType.Add, entity);
    }

    private static ConnectFiveOnlineRating ToRating(TableEntity e) => new(
        e.RowKey,
        e.GetString("DisplayName") ?? "",
        e.GetInt32("Rating") ?? TurnGameElo.StartRating,
        e.GetInt32("Games") ?? 0,
        e.GetInt32("Wins") ?? 0,
        e.GetInt32("Losses") ?? 0,
        e.GetInt32("Draws") ?? 0);
}
