using System.Text.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using PoMiniGames.Features.Health;
using PoMiniGames.Serialization;
using PoMiniGames.Shared.Diagnostics;

namespace PoMiniGames.Unit.Features.Health;

/// <summary>
/// Locks the <c>/api/diag</c> payload (the data behind the public /diag page): it reports
/// status, latency, version and environment, and never a secret or an address — not even when
/// the configuration holds them and a check fails with one in its exception message.
/// </summary>
/// <remarks>
/// The payload is the Po web standard DiagReportDto (AGENTS.md): Status, Environment, Version, CheckedAt,
/// CheckedMs and Checks[] with Name, Group (api | data | service), Label, Status, Purpose, Detail, LatencyMs, Problem.
/// </remarks>
public sealed class DiagProjectionTests
{
    private const string Secret = "DefaultEndpointsProtocol=https;AccountName=pominiprod;AccountKey=c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0;EndpointSuffix=core.windows.net";

    // The report's shape: overall status, the API row first, a failing check reduced to its exception TYPE, the
    // storage listings, and the configured services reported by presence.
    [Theory]
    [InlineData("status", "Degraded")]
    [InlineData("environment", "Production")]
    [InlineData("checks[0].name", "api")]
    [InlineData("checks[0].group", "api")]
    [InlineData("checks[1].name", "multiplayer")]
    [InlineData("checks[2].name", "Storage")]
    [InlineData("checks[2].group", "data")]
    [InlineData("checks[2].status", "Degraded")]
    [InlineData("checks[2].problem", "InvalidOperationException")]
    [InlineData("checks[3].name", "tables")]
    [InlineData("checks[4].name", "blob-containers")]
    [InlineData("checks[5].name", "key-vault")]
    [InlineData("checks[5].group", "service")]
    [InlineData("checks[6].name", "app-insights")]
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

    [Fact]
    public void Report_UsesOnlyTheStandardGroupsAndStatuses()
    {
        using var doc = JsonDocument.Parse(SerializeReport());
        foreach (var check in doc.RootElement.GetProperty("checks").EnumerateArray())
        {
            check.GetProperty("group").GetString().Should().BeOneOf("api", "data", "service");
            check.GetProperty("status").GetString().Should().BeOneOf("Healthy", "Degraded", "Unhealthy", "Off");
            check.GetProperty("label").GetString().Should().NotBeNullOrWhiteSpace();
            check.GetProperty("purpose").GetString().Should().NotBeNullOrWhiteSpace();
        }
    }

    /// <summary>Services switched off on purpose read "Off": neutral, no problem text, and they never lower the overall status.</summary>
    [Fact]
    public async Task OffRows_AreNeutralAndNeverLowerTheOverallStatus()
    {
        var probe = new DiagEndpoints.StorageProbe(
            new HashSet<string>(DiagEndpoints.TableNames, StringComparer.OrdinalIgnoreCase),
            new HashSet<string>(DiagEndpoints.ContainerNames, StringComparer.OrdinalIgnoreCase));
        DiagCheckDto[] live =
        [
            new("multiplayer", "api", "Multiplayer hubs", "Healthy", "p", "answered a negotiate", 3, null),
            new("key-vault", "service", "Azure Key Vault", DiagLiveProbes.Off, "p", "Not used in this environment.", 0, null),
            new("wikipedia", "service", "Wikipedia", DiagLiveProbes.Off, "p", "Switched off in this environment.", 0, null),
        ];

        var report = await DiagEndpoints.BuildReportAsync(new HealthyHealthCheckService(), new HostingEnvironment(), CancellationToken.None, probe, live, apiMs: 4);

        report.Status.Should().Be("Healthy", "Off rows are switched off on purpose and are not a fault");
        report.Checks.Where(c => c.Status == DiagLiveProbes.Off).Should().HaveCount(2).And.OnlyContain(c => c.Problem == null);
        report.Checks[0].LatencyMs.Should().BeGreaterThanOrEqualTo(4, "the API row is this request, measured");
        report.Checks.Select(c => c.Name).Should().ContainInOrder("api", "multiplayer", "tables", "blob-containers", "key-vault", "wikipedia");
    }

    private static string SerializeReport()
    {
        var env = new HostingEnvironment { EnvironmentName = "Production" };

        var probe = new DiagEndpoints.StorageProbe(
            new HashSet<string>(DiagEndpoints.TableNames, StringComparer.OrdinalIgnoreCase),
            new HashSet<string>(StringComparer.OrdinalIgnoreCase));
        // The live rows as DiagLiveProbes words them (it never echoes the vault or ingestion address it called).
        DiagCheckDto[] live =
        [
            new("multiplayer", "api", "Multiplayer hubs", "Healthy", "SignalR lobbies.", "/connectfive/hub answered a negotiate.", 3, null),
            new("key-vault", "service", "Azure Key Vault", "Healthy", "Holds the production secrets.", "Listed its secrets with this app's identity.", 40, null),
            new("app-insights", "service", "Application Insights", "Degraded", "Telemetry.", "The ingestion service did not confirm this app.", 90, "It answered HTTP 400."),
        ];
        var report = DiagEndpoints.BuildReportAsync(new StubHealthCheckService(), env, CancellationToken.None, probe, live)
            .GetAwaiter().GetResult();
        return JsonSerializer.Serialize(report, DiagJsonContext.Default.DiagReportDto);
    }

    private sealed class HealthyHealthCheckService : HealthCheckService
    {
        public override Task<HealthReport> CheckHealthAsync(
            Func<HealthCheckRegistration, bool>? predicate = null,
            CancellationToken cancellationToken = default) =>
            Task.FromResult(new HealthReport(new Dictionary<string, HealthReportEntry>
            {
                ["Storage"] = new(HealthStatus.Healthy, null, TimeSpan.FromMilliseconds(5), null, null),
            }, TimeSpan.FromMilliseconds(5)));
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
