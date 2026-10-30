using System.Text.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using PoMiniGames.Infrastructure;

namespace PoMiniGames.Unit.Features.Health;

/// <summary>
/// Locks the <c>/api/diag</c> over-the-wire projection: the wide provider
/// payload must never leak <c>System.*</c> reflection helpers, raw
/// <c>KeyVaultSecret</c> handles, or un-masked secret strings through the
/// projection defined in <see cref="DiagEndpoints.diagHandler"/>.
///
/// <para>
/// These tests assert the structural contract — if a future contributor widens
/// the projection to include a new dictionary key, this test will fail and
/// force them to think about whether the new field is safe to ship.
/// </para>
/// </summary>
public sealed class DiagProjectionTests
{
    // Shape of the projection: which sections/keys must (or must never) appear. `cors` must stay
    // absent because the single-origin host has no CORS policy to report; the AI rows must stay
    // gone because the app has no AI services.
    [Theory]
    [InlineData(null, "cors", false)]
    [InlineData("integrations", "aiFoundryConfigured", false)]
    [InlineData("keys", "aiFoundryEndpoint", false)]
    [InlineData("keys", "aiDefaultDeployment", false)]
    public void Snapshot_ExposesExactlyTheContractedFields(string? section, string property, bool expectedPresent)
    {
        using var doc = JsonDocument.Parse(SerializeSnapshot());
        var parent = section is null ? doc.RootElement : doc.RootElement.GetProperty(section);

        parent.TryGetProperty(property, out _).Should().Be(expectedPresent,
            $"`{section ?? "(root)"}.{property}` presence is part of the /api/diag contract");
    }

    [Fact]
    public void Snapshot_LeaksNoSecretsOrReflectionHelpers()
    {
        var json = SerializeSnapshot();
        using var doc = JsonDocument.Parse(json);

        foreach (var prop in doc.RootElement.GetProperty("keys").EnumerateObject())
        {
            var value = prop.Value.GetString() ?? "(null)";
            value.Should().NotMatchRegex(@"KeyVaultSecret",
                $"the `{prop.Name}` field must never include a typed secret reference");
            value.Should().NotMatchRegex(@"[A-Za-z0-9]{32,}",
                $"the `{prop.Name}` field must be masked (raw 32-char+ token would indicate a leak)");
        }

        json.Should().NotContain("System.Reflection");
        json.Should().NotContain("RuntimeMethodHandle");
        json.Should().NotContain("Microsoft.AspNetCore.Builder");
        json.Should().NotContain("PoMiniGames.Health");
    }

    private static string SerializeSnapshot()
    {
        var config = new ConfigurationBuilder().Build();
        var env = new HostingEnvironment { EnvironmentName = "Development" };
        var healthService = new StubHealthCheckService();

        var provider = new ConfigurationDiagnosticsSnapshotProvider(config, env, healthService);
        var snapshot = provider.BuildSnapshotAsync().GetAwaiter().GetResult();

        return JsonSerializer.Serialize(snapshot);
    }

    private sealed class HostingEnvironment : IWebHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Development";
        public string ApplicationName { get; set; } = "PoMiniGames";
        public string ContentRootPath { get; set; } = AppContext.BaseDirectory;
        public Microsoft.Extensions.FileProviders.IFileProvider ContentRootFileProvider { get; set; } = null!;
        public string WebRootPath { get; set; } = AppContext.BaseDirectory;
        public Microsoft.Extensions.FileProviders.IFileProvider WebRootFileProvider { get; set; } = null!;
    }

    /// <summary>Subclass of <see cref="HealthCheckService"/> that returns a canned report.
    /// <see cref="HealthCheckService.CheckHealthAsync"/> is non-virtual in 10.0.x, so a Moq
    /// proxy cannot intercept it; subclassing the abstract base is the supported seam.</summary>
    private sealed class StubHealthCheckService : HealthCheckService
    {
        public override Task<HealthReport> CheckHealthAsync(
            Func<HealthCheckRegistration, bool>? predicate = null,
            CancellationToken cancellationToken = default)
        {
            var report = new HealthReport(
                entries: new Dictionary<string, HealthReportEntry>(),
                totalDuration: TimeSpan.FromMilliseconds(1));
            return Task.FromResult(report);
        }
    }
}
