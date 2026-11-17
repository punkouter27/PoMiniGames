using System.Collections.Concurrent;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoBrawl.Online;

/// <summary>
/// Process-local registry of PoBrawl 1v1 matches, one per match code (a fresh code per lobby
/// start — see <see cref="PoBrawlLobbyService.CreateMatchCode"/>), so any number of pairs can
/// fight at once.
/// </summary>
/// <remarks>
/// <para>
/// A finished match lingers for <see cref="FinishedLinger"/> so a player who reconnects after the
/// bell still gets their result, and both corners can still report it (a 503 from the ingest is
/// retried inside this window). The pump sweeps it after that. There is no rematch: the next
/// fight starts from the lobby, on a fresh code.
/// </para>
/// </remarks>
public sealed class PoBrawlMatchRegistry : IDisposable
{
    /// <summary>How long a finished match is kept for late result delivery and the result ingest.</summary>
    public static readonly TimeSpan FinishedLinger = TimeSpan.FromSeconds(90);

    private readonly ConcurrentDictionary<string, PoBrawlMatchService> _byCode = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, string> _connectionToCode = new(StringComparer.Ordinal);

    /// <summary>Start a fresh match on <paramref name="code"/>, replacing any match that code held.</summary>
    public PoBrawlMatchService Start(string code, IReadOnlyList<PoBrawlLobbyPlayer> roster)
    {
        var match = new PoBrawlMatchService(Guid.NewGuid().ToString("N"), code, roster, PoBrawlMatchService.CountdownSeconds);
        _byCode[code] = match;
        Wake();
        return match;
    }

    // Wakes the pump when the first match arrives, so an empty registry costs no CPU. On the F1
    // plan a 4 ms idle loop burned the 60 CPU-minute daily quota and Azure stopped the site.
    private readonly SemaphoreSlim _wake = new(0, 1);

    private void Wake()
    {
        try { _wake.Release(); }
        catch (SemaphoreFullException) { /* already signalled */ }
    }

    public void Dispose() => _wake.Dispose();

    /// <summary>True when no match is running or lingering.</summary>
    public bool IsEmpty => _byCode.IsEmpty;

    /// <summary>Waits until a match is started (returns at once if one already exists).</summary>
    public async Task WaitForMatchAsync(CancellationToken ct)
    {
        while (_byCode.IsEmpty)
        {
            await _wake.WaitAsync(ct);
        }
    }

    public PoBrawlMatchService? Get(string code) =>
        !string.IsNullOrWhiteSpace(code) && _byCode.TryGetValue(code, out var m) ? m : null;

    /// <summary>
    /// The match still held under this id, or null once its FinishedLinger sweep removed it. The result ingest walks this rather than trusting
    /// the client's story about the fight, and the registry is small — live and lingering fights only.
    /// </summary>
    public PoBrawlMatchService? FindByMatchId(string matchId) =>
        string.IsNullOrWhiteSpace(matchId)
            ? null
            : _byCode.Values.FirstOrDefault(m => string.Equals(m.MatchId, matchId, StringComparison.OrdinalIgnoreCase));

    /// <summary>Every match, running or lingering. The pump ticks the running ones.</summary>
    public IReadOnlyCollection<PoBrawlMatchService> All => _byCode.Values.ToArray();

    /// <summary>Drop a match — only if it is still the one on that code.</summary>
    public void Remove(PoBrawlMatchService match) =>
        _byCode.TryRemove(new KeyValuePair<string, PoBrawlMatchService>(match.GameCode, match));

    public void BindConnection(string connectionId, string code) => _connectionToCode[connectionId] = code;

    /// <summary>Forget a connection's binding; returns the code it was bound to.</summary>
    public string? UnbindConnection(string connectionId) =>
        _connectionToCode.TryRemove(connectionId, out var code) ? code : null;

    public PoBrawlMatchService? MatchFor(string connectionId) =>
        _connectionToCode.TryGetValue(connectionId, out var code) ? Get(code) : null;
}
