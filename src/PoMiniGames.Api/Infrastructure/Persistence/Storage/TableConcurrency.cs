using Azure;
using Azure.Data.Tables;

namespace PoMiniGames.Infrastructure.Storage;

/// <summary>
/// Optimistic-concurrency helpers for Azure Table Storage read-modify-write flows.
/// Every aggregating write (running totals, best-score-wins) must go through here so a
/// concurrent update cannot silently clobber another via a blind <c>Upsert(Replace)</c>.
/// </summary>
/// <remarks>
/// The loop re-reads the entity, re-applies the mutation, and writes with an
/// <c>If-Match</c> ETag. A 412 (precondition failed) or 409 (lost create race) means a
/// competing writer won; we re-read and retry with bounded backoff. Permanent failures
/// (401/403/404-on-update) propagate.
/// </remarks>
public static class TableConcurrency
{
    private const int MaxAttempts = 8;

    /// <summary>
    /// Read-modify-write with optimistic concurrency. Fetches the entity (or fabricates a
    /// new one via <paramref name="factory"/> on 404), applies <paramref name="mutate"/>,
    /// and persists only when <paramref name="mutate"/> reports a change. Retries on ETag
    /// conflicts.
    /// </summary>
    /// <param name="mutate">Mutates the entity in place; returns <c>true</c> when a write is required.</param>
    public static async Task UpdateWithRetryAsync<T>(
        TableClient table,
        string partitionKey,
        string rowKey,
        Func<T> factory,
        Func<T, bool> mutate,
        CancellationToken cancellationToken = default)
        where T : class, ITableEntity
    {
        for (var attempt = 1; ; attempt++)
        {
            T entity;
            bool exists;
            try
            {
                var response = await table.GetEntityAsync<T>(partitionKey, rowKey, cancellationToken: cancellationToken);
                entity = response.Value;
                exists = true;
            }
            catch (RequestFailedException ex) when (ex.Status == 404)
            {
                entity = factory();
                entity.PartitionKey = partitionKey;
                entity.RowKey = rowKey;
                exists = false;
            }

            if (!mutate(entity))
            {
                return; // No change required — skip the write entirely.
            }

            try
            {
                if (exists)
                {
                    // If-Match on the captured ETag: fails with 412 if another writer changed it.
                    await table.UpdateEntityAsync(entity, entity.ETag, TableUpdateMode.Replace, cancellationToken);
                }
                else
                {
                    // Add (not upsert) so a concurrent create surfaces as 409 and re-reads.
                    await table.AddEntityAsync(entity, cancellationToken);
                }
                return;
            }
            catch (RequestFailedException ex) when ((ex.Status == 412 || ex.Status == 409) && attempt < MaxAttempts)
            {
                await Task.Delay(Backoff(attempt), cancellationToken);
            }
        }
    }

    // Capped exponential backoff: 20ms, 40, 80, 160, 320, 500, 500, ...
    private static TimeSpan Backoff(int attempt) =>
        TimeSpan.FromMilliseconds(Math.Min(500, 20 * (1 << Math.Min(attempt - 1, 5))));
}
