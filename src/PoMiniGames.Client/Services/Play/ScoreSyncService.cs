using PoMiniGames.Shared.Games;
using System.Text.Json;
// Alias, not a namespace import: PoMiniGamesClient.Models mirrors several other Domain
// types by name, so importing the namespace wholesale would make them all ambiguous.
using PoMiniGamesClient.Models;

using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Play;

/// <summary>
/// Makes the on-screen "scores will sync later" promise true. When a board submit fails, the score is
/// enqueued durably; on app start and whenever the API is reachable again, the queue is flushed in order.
/// This is the resilience layer the leaderboard North Star depends on.
/// </summary>
public sealed class ScoreSyncService
{
    private readonly ApiService _api;
    private readonly PendingScoreStore _store;
    private bool _flushing;

    public ScoreSyncService(ApiService api, PendingScoreStore store)
    {
        _api = api;
        _store = store;
    }

    /// <summary>Raised whenever the pending count changes, so the installed app's badge can follow it (MainLayout).</summary>
    public event Action? Changed;

    /// <summary>
    /// Raised with the number of scores that just landed, after a flush that synced
    /// at least one. Separate from <see cref="Changed"/> because the two answer
    /// different questions: <see cref="Changed"/> means "the queue is a different
    /// size, redraw the pill", while this means "the player's parked runs just
    /// reached the leaderboard" — a moment, and the only one worth celebrating.
    /// </summary>
    /// <remarks>
    /// The event carries the count rather than having subscribers read
    /// <see cref="PendingCount"/>, which is already back to zero by the time this
    /// fires and so cannot tell anyone how much was saved.
    /// </remarks>
    public event Action<int>? Flushed;

    public int PendingCount => _store.Load().Count;

    public void EnqueueMarbleRace(MarbleRaceHighScoreRequest entry) =>
        Enqueue(PendingScoreKind.MarbleRace, JsonSerializer.Serialize(entry, ApiJsonContext.Default.MarbleRaceHighScoreRequest));

    public void EnqueuePoBrawl(PoBrawlHighScore entry) =>
        Enqueue(PendingScoreKind.PoBrawl, JsonSerializer.Serialize(entry, ApiJsonContext.Default.PoBrawlHighScore));

    public void EnqueuePoVoxelStrike(PoVoxelStrikeRunRequest entry) =>
        Enqueue(PendingScoreKind.PoVoxelStrike, JsonSerializer.Serialize(entry, ApiJsonContext.Default.PoVoxelStrikeRunRequest));

    public void EnqueuePoMule(PoMuleRunRequest entry) =>
        Enqueue(PendingScoreKind.PoMule, JsonSerializer.Serialize(entry, ApiJsonContext.Default.PoMuleRunRequest));

    public void EnqueuePoRacer(PoMiniGames.Shared.Games.PoRacerScoreDto entry) =>
        Enqueue(PendingScoreKind.PoRacer, JsonSerializer.Serialize(entry, ApiJsonContext.Default.PoRacerScoreDto));

    public void EnqueuePoCabinet(PoCabinetHighScoreRequest entry) =>
        Enqueue(PendingScoreKind.PoCabinet, JsonSerializer.Serialize(entry, ApiJsonContext.Default.PoCabinetHighScoreRequest));

    public void EnqueueFunQuiz(FunQuizLeaderboardSubmission entry) =>
        Enqueue(PendingScoreKind.PoFunQuiz, JsonSerializer.Serialize(entry, ApiJsonContext.Default.FunQuizLeaderboardSubmission));

    public void EnqueueMarbleRaceMapRecord(MarbleRaceRecordRequest entry) =>
        Enqueue(PendingScoreKind.MarbleRaceMapRecord, JsonSerializer.Serialize(entry, ApiJsonContext.Default.MarbleRaceRecordRequest));

    public void EnqueuePlayerStats(PendingPlayerStats entry) =>
        Enqueue(PendingScoreKind.PlayerStats, JsonSerializer.Serialize(entry, ApiJsonContext.Default.PendingPlayerStats));

    private void Enqueue(PendingScoreKind kind, string payloadJson)
    {
        var items = _store.Load();
        if (items.Any(i => i.Kind == kind && string.Equals(i.PayloadJson, payloadJson, StringComparison.Ordinal)))
        {
            return;
        }

        items.Add(new PendingScore
        {
            Kind = kind,
            PayloadJson = payloadJson,
            EnqueuedAt = DateTime.UtcNow.ToString("O"),
        });
        _store.Save(items);
        Changed?.Invoke();
    }

    /// <summary>
    /// Attempts to resubmit every queued score in FIFO order. Synced entries are dropped, and so are ones
    /// the server rejects outright — a payload the server refuses can only be refused again, so keeping it
    /// would replay the same rejection on every flush forever. Only entries that could still succeed stay
    /// queued (attempt count bumped). Re-entrant calls are ignored so a startup flush and a reconnect flush
    /// can't double-submit. Returns the number of scores synced.
    /// </summary>
    public async Task<int> FlushAsync()
    {
        if (_flushing) return 0;

        var items = _store.Load();
        if (items.Count == 0) return 0;

        // Don't hammer the network per-item when the backend is plainly down.
        _flushing = true;
        var synced = 0;
        var countChanged = false;
        try
        {
            if (!await _api.IsAvailableAsync()) return 0;
            var remaining = new List<PendingScore>(items.Count);
            foreach (var item in items)
            {
                Disposition disposition;
                try
                {
                    disposition = await SubmitAsync(item);
                }
                catch
                {
                    disposition = Disposition.Retry;
                }

                switch (disposition)
                {
                    case Disposition.Synced:
                        synced++;
                        break;
                    case Disposition.Drop:
                        break;
                    default:
                        item.Attempts++;
                        remaining.Add(item);
                        break;
                }
            }

            // A game can enqueue another score while an HTTP submit is awaiting a response.
            var processedIds = items.Select(i => i.Id).ToHashSet(StringComparer.Ordinal);
            var current = _store.Load();
            remaining.AddRange(current.Where(i => !processedIds.Contains(i.Id)));
            _store.Save(remaining);
            // Dropped (rejected) entries shrink the queue too, without a single sync.
            countChanged = remaining.Count != current.Count;
        }
        finally
        {
            _flushing = false;
        }

        if (synced > 0 || countChanged) Changed?.Invoke();
        if (synced > 0) Flushed?.Invoke(synced);
        return synced;
    }

    /// <summary>What to do with a queued entry after attempting it.</summary>
    private enum Disposition { Synced, Retry, Drop }

    private async Task<Disposition> SubmitAsync(PendingScore item) => item.Kind switch
    {
        PendingScoreKind.PoRacer => await SubmitPoRacerAsync(item.PayloadJson),
        PendingScoreKind.MarbleRace => await SubmitMarbleRaceAsync(item.PayloadJson),
        PendingScoreKind.PoBrawl => await SubmitPoBrawlAsync(item.PayloadJson),
        PendingScoreKind.PlayerStats => await SubmitPlayerStatsAsync(item.PayloadJson),
        PendingScoreKind.PoVoxelStrike => await SubmitPoVoxelStrikeAsync(item.PayloadJson),
        PendingScoreKind.PoCabinet => await SubmitPoCabinetAsync(item.PayloadJson),
        PendingScoreKind.PoMule => await SubmitPoMuleAsync(item.PayloadJson),
        PendingScoreKind.PoFunQuiz => await SubmitFunQuizAsync(item.PayloadJson),
        PendingScoreKind.MarbleRaceMapRecord => await SubmitMarbleRaceMapRecordAsync(item.PayloadJson),
        _ => Disposition.Drop, // unknown kind: drop rather than wedge the queue forever
    };

    private async Task<Disposition> SubmitMarbleRaceMapRecordAsync(string payloadJson)
    {
        MarbleRaceRecordRequest? entry;
        try { entry = JsonSerializer.Deserialize(payloadJson, ApiJsonContext.Default.MarbleRaceRecordRequest); }
        catch (JsonException) { return Disposition.Drop; } // malformed: unreplayable
        if (entry is null) return Disposition.Drop;
        var result = await _api.SubmitMarbleRaceMapRecordAsync(entry);
        return result.IsSaved ? Disposition.Synced
            : result.ShouldRetry ? Disposition.Retry
            : Disposition.Drop;
    }

    private async Task<Disposition> SubmitFunQuizAsync(string payloadJson)
    {
        FunQuizLeaderboardSubmission? entry;
        try { entry = JsonSerializer.Deserialize(payloadJson, ApiJsonContext.Default.FunQuizLeaderboardSubmission); }
        catch (JsonException) { return Disposition.Drop; } // malformed: unreplayable
        if (entry is null) return Disposition.Drop;
        var result = await _api.SubmitFunQuizScoreAsync(entry);
        return result.IsSaved ? Disposition.Synced
            : result.ShouldRetry ? Disposition.Retry
            : Disposition.Drop;
    }

    private async Task<Disposition> SubmitPoCabinetAsync(string payloadJson)
    {
        var entry = JsonSerializer.Deserialize(payloadJson, ApiJsonContext.Default.PoCabinetHighScoreRequest);
        if (entry is null) return Disposition.Drop;
        var result = await _api.SubmitPoCabinetHighScoreAsync(entry);
        return result.IsSaved ? Disposition.Synced
            : result.ShouldRetry ? Disposition.Retry
            : Disposition.Drop;
    }

    private async Task<Disposition> SubmitPoBrawlAsync(string payloadJson)
    {
        PoBrawlHighScore? entry;
        try { entry = JsonSerializer.Deserialize(payloadJson, ApiJsonContext.Default.PoBrawlHighScore); }
        catch (JsonException) { return Disposition.Drop; } // malformed: unreplayable
        if (entry is null) return Disposition.Drop;
        var result = await _api.SubmitPoBrawlHighScoreAsync(entry);
        return result.IsSaved ? Disposition.Synced : result.ShouldRetry ? Disposition.Retry : Disposition.Drop;
    }

    private async Task<Disposition> SubmitPoMuleAsync(string payloadJson)
    {
        var request = JsonSerializer.Deserialize(payloadJson, ApiJsonContext.Default.PoMuleRunRequest);
        if (request is null) return Disposition.Drop;
        var result = await _api.SubmitPoMuleRunAsync(request);
        return result.IsSaved ? Disposition.Synced : result.ShouldRetry ? Disposition.Retry : Disposition.Drop;
    }

    private async Task<Disposition> SubmitPoRacerAsync(string payloadJson)
    {
        var entry = JsonSerializer.Deserialize(payloadJson, ApiJsonContext.Default.PoRacerScoreDto);
        if (entry is null) return Disposition.Drop;
        var result = await _api.SubmitPoRacerScoreAsync(entry);
        return result.IsSaved ? Disposition.Synced : result.ShouldRetry ? Disposition.Retry : Disposition.Drop;
    }

    private async Task<Disposition> SubmitPoVoxelStrikeAsync(string payloadJson)
    {
        var request = JsonSerializer.Deserialize(payloadJson, ApiJsonContext.Default.PoVoxelStrikeRunRequest);
        if (request is null) return Disposition.Drop; // malformed: unreplayable

        var result = await _api.SubmitPoVoxelStrikeRunAsync(request);
        if (result.IsSaved) return Disposition.Synced;
        return result.ShouldRetry ? Disposition.Retry : Disposition.Drop;
    }

    private async Task<Disposition> SubmitMarbleRaceAsync(string payloadJson)
    {
        // Entries queued before the submission shape narrowed to a bare score carry extra
        // properties; deserializing ignores them and keeps the score, so old queues still drain.
        var request = JsonSerializer.Deserialize(payloadJson, ApiJsonContext.Default.MarbleRaceHighScoreRequest);
        if (request is null) return Disposition.Drop; // malformed: unreplayable

        var result = await _api.SubmitMarbleRaceHighScoreAsync(request);
        if (result.IsSaved) return Disposition.Synced;
        return result.ShouldRetry ? Disposition.Retry : Disposition.Drop;
    }

    private async Task<Disposition> SubmitPlayerStatsAsync(string payloadJson)
    {
        var pending = JsonSerializer.Deserialize(payloadJson, ApiJsonContext.Default.PendingPlayerStats);
        if (pending is null || string.IsNullOrEmpty(pending.GameKey)) return Disposition.Drop; // malformed
        var (ok, _) = await _api.SavePlayerStatsAsync(pending.GameKey, pending.PlayerName, pending.Stats);
        return ok ? Disposition.Synced : Disposition.Retry;
    }
}
