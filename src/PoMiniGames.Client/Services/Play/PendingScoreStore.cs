#pragma warning disable CA1822 // Preserved as scoped service instance API.
using PoMiniGamesClient.Services.Http;

namespace PoMiniGamesClient.Services.Play;

/// <summary>
/// localStorage-backed durable queue of unsynced scores. Pure persistence — no network. Kept separate
/// from <see cref="ScoreSyncService"/> so the "where it lives" concern is isolated from "when it flushes".
/// </summary>
public sealed class PendingScoreStore
{
    private const string StorageKey = "pominigames:pending-scores";

    public List<PendingScore> Load() =>
        LocalStorageService.GetItem(StorageKey, ApiJsonContext.Default.ListPendingScore) ?? [];

    public void Save(List<PendingScore> items) =>
        LocalStorageService.SetItem(StorageKey, items, ApiJsonContext.Default.ListPendingScore);
}

