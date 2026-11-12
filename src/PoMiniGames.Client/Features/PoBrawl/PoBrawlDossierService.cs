using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Services.Http;

namespace PoMiniGamesClient.Features.PoBrawl;

/// <summary>
/// The fighter dossiers for <see cref="PoBrawlDossierCard"/>: fetched from
/// <c>GET /api/pobrawl/dossier</c> once per app life and kept. Until the fetch lands, or when it
/// fails, <see cref="Peek"/> answers with the static facts, so a card always has something to show.
/// </summary>
public sealed class PoBrawlDossierService(ApiService api)
{
    private static readonly Dictionary<string, PoBrawlDossierDto> Static =
        PoBrawlDossiers.StaticDtos().ToDictionary(d => d.FighterId, StringComparer.OrdinalIgnoreCase);

    // How long a failed fetch is remembered. Offline, every 2P cursor move re-renders a card,
    // and each one would otherwise fire the request again.
    private static readonly TimeSpan RetryAfter = TimeSpan.FromSeconds(60);

    private Dictionary<string, PoBrawlDossierDto>? _loaded;
    private Task<bool>? _load;
    private DateTime _failedAt = DateTime.MinValue;

    /// <summary>The best dossier on hand for <paramref name="fighterId"/>, or null for an unknown id.</summary>
    public PoBrawlDossierDto? Peek(string? fighterId)
    {
        if (string.IsNullOrEmpty(fighterId)) return null;
        if (_loaded is not null && _loaded.TryGetValue(fighterId, out var loaded)) return loaded;
        return Static.GetValueOrDefault(fighterId);
    }

    /// <summary>
    /// Fetches the server list once; concurrent callers share the one request. True when the
    /// server list is in. A failed fetch is remembered for <see cref="RetryAfter"/>; the first
    /// card to ask after that tries again.
    /// </summary>
    public Task<bool> EnsureLoadedAsync()
    {
        if (_loaded is not null) return Task.FromResult(true);
        if (_load is null && DateTime.UtcNow - _failedAt < RetryAfter) return Task.FromResult(false);
        return _load ??= LoadAsync();
    }

    private async Task<bool> LoadAsync()
    {
        var list = await api.GetPoBrawlDossiersAsync();
        if (list is null || list.Count == 0)
        {
            _failedAt = DateTime.UtcNow;
            _load = null;
            return false;
        }

        _loaded = list
            .Where(d => !string.IsNullOrEmpty(d.FighterId))
            .GroupBy(d => d.FighterId, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);
        return true;
    }
}
