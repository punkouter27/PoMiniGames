using Azure.Data.Tables;
using Microsoft.Extensions.Logging;
using PoMiniGames.Domain.Models;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Infrastructure.Services;

/// <summary>
/// PoFighter's CPU-vs-CPU tournament fighter Elo: the same accumulator as PoBrawl's demo board
/// (one row per fighter, RowKey = canonical id, increments applied through
/// TableConcurrency), on its own table so the two rosters can never share a rating.
/// </summary>
public partial class StorageService
{
    public async Task<List<PoFighterFighterRating>> GetPoFighterRatingsAsync()
    {
        if (!IsStorageAvailable())
        {
            return [];
        }

        try
        {
            var ratings = new List<PoFighterFighterRating>();
            await foreach (var e in Table(PoFighterEloTable).QueryAsync<TableEntity>(
                filter: $"PartitionKey eq '{PoFighterEloPartition}'", maxPerPage: 1000))
            {
                ratings.Add(PoFighterRatingFrom(e));
            }

            return ratings
                .OrderByDescending(r => r.Elo)
                .ThenByDescending(r => r.Matches)
                .ThenBy(r => r.FighterId, StringComparer.Ordinal)
                .ToList();
        }
        catch (Exception ex)
        {
            MarkUnavailable(ex);
            return [];
        }
    }

    public async Task<(PoFighterFighterRating Winner, PoFighterFighterRating Loser)?> RecordPoFighterBoutAsync(
        string winnerFighterId, string loserFighterId, bool isDraw)
    {
        var winnerId = PoFighterRoster.Canonicalize(winnerFighterId)
            ?? throw new ArgumentException($"'{winnerFighterId}' is not a rateable PoFighter fighter.", nameof(winnerFighterId));
        var loserId = PoFighterRoster.Canonicalize(loserFighterId)
            ?? throw new ArgumentException($"'{loserFighterId}' is not a rateable PoFighter fighter.", nameof(loserFighterId));
        if (string.Equals(winnerId, loserId, StringComparison.Ordinal))
        {
            throw new ArgumentException("A fighter cannot fight itself.", nameof(loserFighterId));
        }

        if (!IsStorageAvailable())
        {
            return null;
        }

        var table = Table(PoFighterEloTable);
        try
        {
            var before = await Task.WhenAll(
                ReadFighterEloAsync(table, winnerId, PoFighterEloPartition),
                ReadFighterEloAsync(table, loserId, PoFighterEloPartition));
            var delta = _fighterElo.Delta(before[0], before[1], isDraw);
            var stamp = DateTime.UtcNow.ToString("o");
            var winResult = isDraw ? MatchResult.Draw : MatchResult.Win;
            var loseResult = isDraw ? MatchResult.Draw : MatchResult.Loss;

            // Sequential, with a compensating undo, for the same pool-conservation reason as
            // the PoBrawl board (see RecordPoBrawlDemoResultAsync).
            try
            {
                await ApplyFighterDeltaAsync(table, winnerId, delta, winResult, stamp,
                    partition: PoFighterEloPartition, displayName: PoFighterRoster.DisplayName);
                await ApplyFighterDeltaAsync(table, loserId, -delta, loseResult, stamp,
                    partition: PoFighterEloPartition, displayName: PoFighterRoster.DisplayName);
            }
            catch
            {
                try
                {
                    await ApplyFighterDeltaAsync(table, winnerId, -delta, winResult, stamp, undo: true,
                        partition: PoFighterEloPartition, displayName: PoFighterRoster.DisplayName);
                }
                catch (Exception compensationFailure)
                {
                    MarkUnavailable(compensationFailure);
                    _logger.LogError(compensationFailure,
                        "PoFighter Elo: failed to compensate a half-applied bout for {WinnerId}; the rating pool is off by {Delta}.",
                        winnerId, delta);
                    return null;
                }
                throw;
            }

            var rows = await Task.WhenAll(
                table.GetEntityAsync<TableEntity>(PoFighterEloPartition, winnerId),
                table.GetEntityAsync<TableEntity>(PoFighterEloPartition, loserId));
            var after = (PoFighterRatingFrom(rows[0].Value), PoFighterRatingFrom(rows[1].Value));
            await AppendPoFighterBoutAsync(table, winnerId, loserId, isDraw, after.Item1.Elo, after.Item2.Elo, stamp);
            return after;
        }
        catch (Exception ex)
        {
            MarkUnavailable(ex);
            return null;
        }
    }

    // The bout log shares the ratings table on its own partition. RowKey = inverted ticks, so a
    // partition scan returns the newest bout first.
    private const string PoFighterBoutPartition = "pofighterbout";

    /// <summary>
    /// Logs a rated bout for the dossier. The rating is already stored, so a failed log is only
    /// a gap in the history: it is reported and swallowed, never failing the bout.
    /// </summary>
    private async Task AppendPoFighterBoutAsync(
        TableClient table, string winnerId, string loserId, bool isDraw, int winnerElo, int loserElo, string stamp)
    {
        try
        {
            var rowKey = $"{DateTime.MaxValue.Ticks - DateTime.UtcNow.Ticks:D19}-{Guid.NewGuid():N}"[..28];
            await table.AddEntityAsync(new TableEntity(PoFighterBoutPartition, rowKey)
            {
                ["WinnerId"] = winnerId,
                ["LoserId"] = loserId,
                ["IsDraw"] = isDraw,
                ["WinnerElo"] = winnerElo,
                ["LoserElo"] = loserElo,
                ["At"] = stamp,
            });
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "PoFighter: the bout {WinnerId} vs {LoserId} was rated but not logged.", winnerId, loserId);
        }
    }

    public async Task<List<PoFighterBout>> GetPoFighterBoutsAsync(string fighterId, int take)
    {
        var id = PoFighterRoster.Canonicalize(fighterId);
        if (id is null || take <= 0 || !IsStorageAvailable())
        {
            return [];
        }

        try
        {
            var bouts = new List<PoFighterBout>(take);
            var filter = TableClient.CreateQueryFilter(
                $"PartitionKey eq {PoFighterBoutPartition} and (WinnerId eq {id} or LoserId eq {id})");
            await foreach (var e in Table(PoFighterEloTable).QueryAsync<TableEntity>(filter, maxPerPage: Math.Min(take, 100)))
            {
                bouts.Add(new PoFighterBout
                {
                    WinnerId = e.GetString("WinnerId") ?? "",
                    LoserId = e.GetString("LoserId") ?? "",
                    IsDraw = e.GetBoolean("IsDraw") ?? false,
                    WinnerElo = e.GetInt32("WinnerElo") ?? _fighterElo.SeedElo,
                    LoserElo = e.GetInt32("LoserElo") ?? _fighterElo.SeedElo,
                    At = e.GetString("At") ?? "",
                });
                if (bouts.Count >= take)
                {
                    break;
                }
            }

            return bouts;
        }
        catch (Exception ex)
        {
            MarkUnavailable(ex);
            return [];
        }
    }

    private PoFighterFighterRating PoFighterRatingFrom(TableEntity e)
    {
        var id = e.GetString("FighterId") ?? e.RowKey;
        return new PoFighterFighterRating
        {
            FighterId = id,
            DisplayName = PoFighterRoster.IsRateable(id)
                ? PoFighterRoster.DisplayName(id)
                : e.GetString("DisplayName") ?? id,
            Elo = e.GetInt32("Elo") ?? _fighterElo.SeedElo,
            Wins = e.GetInt32("Wins") ?? 0,
            Losses = e.GetInt32("Losses") ?? 0,
            Draws = e.GetInt32("Draws") ?? 0,
            LastUpdated = e.GetString("LastUpdated") ?? "",
        };
    }
}
