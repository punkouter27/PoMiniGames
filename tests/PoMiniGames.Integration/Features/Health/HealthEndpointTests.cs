using System.Net;
using System.Text.Json.Nodes;
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;

namespace PoMiniGames.Integration;

/// <summary>Integration tests for health and diagnostic API endpoints.</summary>
public sealed class HealthEndpointTests : IClassFixture<TestWebApplicationFactory>
{
    private readonly TestWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public HealthEndpointTests(TestWebApplicationFactory factory)
    {
        _factory = factory;
        _client = factory.CreateClient();
    }

    /// <summary>
    /// Every probe route the platform exposes: reachable, and carrying the JSON shape its
    /// caller reads. Consolidated from four single-route facts (ping / root health /
    /// liveness / mockables) into one parameterised method — they differed only in the route
    /// and which keys they asserted, and the Integration tier is at its 50-method ceiling
    /// (100/50/25/25 rule), so the slots were needed elsewhere.
    /// </summary>
    [DockerTheory]
    // Bare reachability — the client's apiService.isAvailable() only reads the status code.
    [InlineData("/api/health/ping", null, null, false)]
    // Root health carries both the overall status and the per-check breakdown.
    [InlineData("/health", "status", "checks", false)]
    // The JSON health report the deploy smoke step reads.
    [InlineData("/api/health", "status", "checks", false)]
    public async Task DiagnosticRoutes_ReturnOk_WithExpectedJsonShape(
        string route, string? statusKey, string? checksKey, bool expectJsonArray)
    {
        var response = await _client.GetAsync(route);
        response.StatusCode.Should().Be(HttpStatusCode.OK);

        var body = await response.Content.ReadAsStringAsync();
        body.Should().NotBeNullOrWhiteSpace();

        if (expectJsonArray)
        {
            var trimmed = body.TrimStart();
            trimmed.Should().StartWith("[");
            trimmed.Should().EndWith("]");
            return;
        }

        if (statusKey is null && checksKey is null)
            return;

        var json = JsonNode.Parse(body);
        json.Should().NotBeNull();

        if (statusKey is not null)
            json![statusKey]!.GetValue<string>().Should().NotBeNullOrWhiteSpace();

        if (checksKey is not null)
            json![checksKey].Should().NotBeNull();
    }

    /// <summary>
    /// GET /api/diag backs the public /diag page (Po web standard DiagReportDto): it answers
    /// anonymously with the report the page renders, and carries no secret or address — the
    /// test host's own Azurite connection string (account key and all) must not appear.
    /// </summary>
    [DockerFact]
    public async Task DiagEndpoint_ReturnsOk()
    {
        using var anonymous = _factory.CreateClient();
        anonymous.DefaultRequestHeaders.Remove("X-Player-Id");
        anonymous.DefaultRequestHeaders.Remove("X-Player-Initials");
        // Bare /diag is the Blazor page route; the JSON lives at /api/diag.
        var response = await anonymous.GetAsync("/api/diag");
        response.StatusCode.Should().Be(HttpStatusCode.OK);

        var body = await response.Content.ReadAsStringAsync();
        var json = JsonNode.Parse(body)!;

        json["status"]!.GetValue<string>().Should().BeOneOf("Healthy", "Degraded", "Unhealthy");
        json["environment"]!.GetValue<string>().Should().Be("Test");
        json["version"]!.GetValue<string>().Should().MatchRegex(@"^\d{6}$|^dev$");
        var checks = json["checks"]!.AsArray();
        checks[0]!["name"]!.GetValue<string>().Should().Be("api", "the API row comes first");
        checks.Should().Contain(c => c!["group"]!.GetValue<string>() == "data", "the storage checks are in Data");
        checks.Should().Contain(c => c!["name"]!.GetValue<string>() == "tables", "the app's tables are listed");
        checks.Should().Contain(c => c!["name"]!.GetValue<string>() == "blob-containers");
        checks.Should().Contain(c => c!["name"]!.GetValue<string>() == "multiplayer"
            && c!["detail"]!.GetValue<string>().Contains("/connectfive/hub", StringComparison.Ordinal));
        // The test host switches Key Vault, App Insights and Wikipedia off on purpose: each is a
        // neutral "Off" row with no problem text, never Degraded (Po standard).
        foreach (var off in new[] { "key-vault", "app-insights", "wikipedia" })
        {
            var row = checks.Single(c => c!["name"]!.GetValue<string>() == off)!;
            row["status"]!.GetValue<string>().Should().Be("Off", because: $"{off} is switched off in the test host");
            row["problem"].Should().BeNull();
        }
        checks.Should().NotContain(c => c!["name"]!.GetValue<string>() == "datamuse", "Couple Quiz no longer calls any trivia API");
        checks.Should().Contain(c => c!["name"]!.GetValue<string>() == "push", "the push-invite keys are checked in storage");

        foreach (var leak in new[] { "AccountKey", "devstoreaccount1", "DefaultEndpointsProtocol", "127.0.0.1",
                     "localhost", "vault.azure.net", "core.windows.net", "InstrumentationKey", "StackTrace", "Exception:" })
        {
            body.Should().NotContain(leak, because: "the anonymous diag report must never expose secrets or addresses");
        }
        body.Should().NotContain(AppContext.BaseDirectory.TrimEnd('\\', '/'), because: "no file paths");
    }

    /// <summary>
    /// FeatureFlags:EnableDiagnostics no longer gates /api/diag (it only gates the Development
    /// log tail): the /diag page must work in production too.
    /// </summary>
    [DockerFact]
    public async Task DiagEndpoint_StaysOn_WhenDiagnosticsFlagIsOff()
    {
        using var diagDisabledFactory = _factory.WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, cfg) =>
            {
                cfg.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["FeatureFlags:EnableDiagnostics"] = "false",
                });
            });
        });

        using var client = diagDisabledFactory.CreateClient();
        var response = await client.GetAsync("/api/diag");

        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

}
