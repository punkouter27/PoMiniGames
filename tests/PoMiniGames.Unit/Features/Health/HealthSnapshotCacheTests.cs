using FluentAssertions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;
using PoMiniGames.Features.Health;
using PoMiniGames.Infrastructure;
using PoMiniGames.Shared.Diagnostics;

namespace PoMiniGames.Unit.Features.Health;

/// <summary>
/// The one cached health run behind /health and /api/diag: reused for 60 s (same checkedAt), rebuilt after,
/// shared by concurrent callers, and every storage check carries its own timeout.
/// </summary>
public sealed class HealthSnapshotCacheTests
{
    private static HealthSnapshot Snapshot(DateTimeOffset at) => new(
        new HealthReport(new Dictionary<string, HealthReportEntry>(), TimeSpan.Zero),
        new DiagReportDto("Healthy", "Test", "261124", at, 1, []));

    [Fact]
    public async Task ReusesOneRun_ForSixtySeconds_ThenRebuilds()
    {
        var clock = new FakeTimeProvider(DateTimeOffset.UtcNow);
        using var cache = new HealthSnapshotCache(clock);
        var runs = 0;
        Task<HealthSnapshot> Build(CancellationToken _) { runs++; return Task.FromResult(Snapshot(clock.GetUtcNow())); }

        var first = await cache.GetAsync(Build);
        clock.Advance(TimeSpan.FromSeconds(59));
        var second = await cache.GetAsync(Build);
        second.Diag.CheckedAt.Should().Be(first.Diag.CheckedAt, because: "/diag and /health read one run within 60 s");
        runs.Should().Be(1);

        clock.Advance(TimeSpan.FromSeconds(2));
        var third = await cache.GetAsync(Build);
        third.Diag.CheckedAt.Should().BeAfter(first.Diag.CheckedAt);
        runs.Should().Be(2);
        HealthSnapshotCache.Ttl.Should().Be(TimeSpan.FromSeconds(60));
    }

    [Fact]
    public async Task ConcurrentCallers_ShareOneRun()
    {
        using var cache = new HealthSnapshotCache(new FakeTimeProvider(DateTimeOffset.UtcNow));
        var runs = 0;
        var gate = new TaskCompletionSource();
        async Task<HealthSnapshot> Build(CancellationToken _) { Interlocked.Increment(ref runs); await gate.Task; return Snapshot(DateTimeOffset.UtcNow); }

        var callers = Enumerable.Range(0, 5).Select(_ => cache.GetAsync(Build)).ToArray();
        gate.SetResult();
        var all = await Task.WhenAll(callers);
        runs.Should().Be(1);
        all.Select(s => s.Diag.CheckedAt).Distinct().Should().ContainSingle();
    }

    [Fact]
    public async Task AFailedRun_IsNotCached()
    {
        using var cache = new HealthSnapshotCache(new FakeTimeProvider(DateTimeOffset.UtcNow));
        var act = () => cache.GetAsync(_ => throw new InvalidOperationException("boom"));
        await act.Should().ThrowAsync<InvalidOperationException>();
        var ok = await cache.GetAsync(_ => Task.FromResult(Snapshot(DateTimeOffset.UtcNow)));
        ok.Diag.Status.Should().Be("Healthy");
    }

    [Fact]
    public void EveryRegisteredHealthCheck_HasItsOwnTimeout()
    {
        var services = new ServiceCollection();
        services.AddPoMiniGamesStorage(new ConfigurationBuilder().Build());
        var registrations = services.BuildServiceProvider()
            .GetRequiredService<IOptions<HealthCheckServiceOptions>>().Value.Registrations;

        registrations.Should().NotBeEmpty();
        registrations.Should().AllSatisfy(r =>
            r.Timeout.Should().Be(StorageExtensions.HealthCheckTimeout, because: $"{r.Name} must not hold the shared health run"));
        StorageExtensions.HealthCheckTimeout.Should().BeLessThan(HealthSnapshotCache.Ttl);
    }
}
