using System.Text.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using PoMiniGames.Features.Health;
using PoMiniGames.Serialization;

namespace PoMiniGames.Unit.Features.Health;

/// <summary>
/// Locks the <c>/api/diag</c> payload (the data behind the public /diag page): it reports
/// status, latency, version and environment, and never a secret or an address — not even when
/// the configuration holds them and a check fails with one in its exception message.
/// </summary>
/// <remarks>
/// 2026-11-17: rewritten when /api/diag moved from a masked configuration dump to the fleet
/// /diag report (DiagEndpoints.BuildReportAsync).
/// </remarks>
public sealed class DiagProjectionTests
{
    private const string Secret = "DefaultEndpointsProtocol=https;AccountName=pominiprod;AccountKey=c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0;EndpointSuffix=core.windows.net";
    private const string VaultUri = "https://kv-pominigames-prod.vault.azure.net/";
    private const string AiConnection = "InstrumentationKey=00000000-1111-2222-3333-444444444444;IngestionEndpoint=https://eastus-0.in.applicationinsights.azure.com/";

    // The report's shape: overall status, both sections, the configured services reported by
    // presence, and a failing check reduced to its exception TYPE.
    [Theory]
    [InlineData("status", "Degraded")]
    [InlineData("environment", "Production")]
    [InlineData("stores[0].error", "InvalidOperationException")]
    [InlineData("services[0].status", "Healthy")]
    [InlineData("containers[0].name", "poecosystem-worlds")]
    public void Report_CarriesTheContractedFields(string path, string expected)
    {
        using var doc = JsonDocument.Parse(SerializeReport());
        var node = doc.RootElement;
        foreach (var part in path.Split('.'))
        {
            var bracket = part.IndexOf('[');
            node = bracket < 0
                ? node.GetProperty(part)
                : node.GetProperty(part[..bracket])[int.Parse(part[(bracket + 1)..^1], System.Globalization.CultureInfo.InvariantCulture)];
        }
        node.GetString().Should().Be(expected);
    }

    [Fact]
    public void Report_LeaksNoSecretsAddressesOrExceptionText()
    {
        var json = SerializeReport();

        json.Should().NotContain("AccountKey");
        json.Should().NotContain("pominiprod");
        json.Should().NotContain("core.windows.net");
        json.Should().NotContain("vault.azure.net");
        json.Should().NotContain("InstrumentationKey");
        json.Should().NotContain("applicationinsights.azure.com");
        json.Should().NotContain("00000000-1111");
        json.Should().NotContain("StackTrace");
        json.Should().NotContain(AppContext.BaseDirectory.TrimEnd('\\', '/'));
        json.Should().NotMatchRegex(@"[A-Za-z0-9+/]{32,}", "no raw key-like token may appear");
    }

    private static string SerializeReport()
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["KeyVault:Uri"] = VaultUri,
            ["ApplicationInsights:ConnectionString"] = AiConnection,
            ["PoMiniGames:Storage:TableService:ConnectionString"] = Secret,
        }).Build();
        var env = new HostingEnvironment { EnvironmentName = "Production" };

        var report = DiagEndpoints.BuildReportAsync(new StubHealthCheckService(), config, env, CancellationToken.None)
            .GetAwaiter().GetResult();
        return JsonSerializer.Serialize(report, DiagJsonContext.Default.DiagReport);
    }

    private sealed class HostingEnvironment : IWebHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Production";
        public string ApplicationName { get; set; } = "PoMiniGames";
        public string ContentRootPath { get; set; } = AppContext.BaseDirectory;
        public Microsoft.Extensions.FileProviders.IFileProvider ContentRootFileProvider { get; set; } = null!;
        public string WebRootPath { get; set; } = AppContext.BaseDirectory;
        public Microsoft.Extensions.FileProviders.IFileProvider WebRootFileProvider { get; set; } = null!;
    }

    /// <summary>A canned report with one failing storage check whose exception message holds a secret.
    /// <see cref="HealthCheckService.CheckHealthAsync"/> is non-virtual in 10.0.x, so subclassing the
    /// abstract base is the supported seam.</summary>
    private sealed class StubHealthCheckService : HealthCheckService
    {
        public override Task<HealthReport> CheckHealthAsync(
            Func<HealthCheckRegistration, bool>? predicate = null,
            CancellationToken cancellationToken = default)
        {
            var entries = new Dictionary<string, HealthReportEntry>
            {
                ["Storage"] = new(HealthStatus.Degraded, "Table storage is unavailable.", TimeSpan.FromMilliseconds(12),
                    new InvalidOperationException($"Could not connect using {Secret} from {AppContext.BaseDirectory}"), null),
            };
            return Task.FromResult(new HealthReport(entries, TimeSpan.FromMilliseconds(12)));
        }
    }
}
