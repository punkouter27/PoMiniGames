using Microsoft.Extensions.Diagnostics.HealthChecks;
using PoMiniGames.Shared.Diagnostics;

namespace PoMiniGames.Features.Health;

/// <summary>One health run: the registered checks' report and the /diag report built from the same run.</summary>
public sealed record HealthSnapshot(HealthReport Health, DiagReportDto Diag);

/// <summary>
/// The one cached health report behind <c>/health</c>, <c>/api/health</c> and <c>/api/diag</c>. A run is reused for
/// <see cref="Ttl"/>, so a busy /diag page or a probe that polls every few seconds costs one set of storage and
/// service calls a minute (F1 quota), and both readers see the same <c>checkedAt</c>. Concurrent callers on a stale
/// entry share one run (single flight). The run is not tied to the caller's request, so one aborted request never
/// poisons the cache; each check has its own timeout (StorageExtensions, DiagLiveProbes, ProbeStorageAsync).
/// </summary>
public sealed class HealthSnapshotCache(TimeProvider time) : IDisposable
{
    /// <summary>How long one health run is served before the next request starts a new one.</summary>
    public static readonly TimeSpan Ttl = TimeSpan.FromSeconds(60);

    private readonly SemaphoreSlim _gate = new(1, 1);
    private (DateTimeOffset At, HealthSnapshot Snapshot)? _last;

    /// <summary>The cached snapshot while it is younger than <see cref="Ttl"/>, else a fresh one from <paramref name="build"/>.</summary>
    public async Task<HealthSnapshot> GetAsync(Func<CancellationToken, Task<HealthSnapshot>> build, CancellationToken ct = default)
    {
        if (Fresh() is { } hit)
            return hit;
        await _gate.WaitAsync(ct);
        try
        {
            if (Fresh() is { } shared)
                return shared;
            var snapshot = await build(CancellationToken.None);
            _last = (time.GetUtcNow(), snapshot);
            return snapshot;
        }
        finally
        {
            _gate.Release();
        }
    }

    public void Dispose() => _gate.Dispose();

    private HealthSnapshot? Fresh() =>
        _last is { } last && time.GetUtcNow() - last.At < Ttl ? last.Snapshot : null;
}
