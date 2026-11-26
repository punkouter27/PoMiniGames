using Microsoft.Extensions.Diagnostics.HealthChecks;
using PoMiniGames.Domain.Abstractions;

namespace PoMiniGames.Infrastructure.HealthChecks;

/// <summary>
/// Health check that verifies the storage backend is accessible
/// by performing a lightweight leaderboard read.
/// </summary>
public sealed class StorageHealthCheck : IHealthCheck
{
    private readonly IStorageService _storage;

    public StorageHealthCheck(IStorageService storage)
    {
        _storage = storage;
    }

    public async Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context,
        CancellationToken cancellationToken = default)
    {
        // Probe the storage backend directly with a short timeout. Going through
        // GetLeaderboardAsync would silently return an empty list when storage is down
        // (the graceful-degradation path), which would mask the failure from /api/health.
        // IsStorageHealthy performs a bounded CreateIfNotExists so we know whether the
        // backend actually responded within the budget. Degraded (not Unhealthy) when the
        // probe fails: the rest of the app keeps working, leaderboards just render empty.
        try
        {
            if (_storage.IsStorageHealthy())
            {
                return HealthCheckResult.Healthy("Storage is accessible.");
            }

            return HealthCheckResult.Degraded("Table storage is unavailable; scores and leaderboards are skipped but the app continues to serve every other request.");
        }
        catch (Exception ex)
        {
            return HealthCheckResult.Degraded("Table storage probe threw unexpectedly; scores and leaderboards are skipped but the app continues to serve every other request.", ex);
        }
    }
}
