using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using PoMiniGames.Features.Auth;
using PoMiniGames.TestUtilities;

namespace PoMiniGames.E2EAPI;

/// <summary>
/// HTTP contract for the AI diagnostics surface: <c>GET /api/diag/ai</c> and the
/// <c>AiFoundry</c> entry in <c>GET /api/health</c>.
/// </summary>
/// <remarks>
/// <para>
/// Both are new, and both exist because the AI path had no runtime visibility at all:
/// <c>AiUsageAccumulator</c> recorded every call into a dictionary whose <c>Snapshot()</c> had no
/// callers, and <c>/health</c> reported only storage — so a dead deployment or a wrong deployment
/// name was invisible to any monitor and surfaced as a game behaving oddly.
/// </para>
/// <para>
/// Deliberately asserts the <em>shape and reachability</em> rather than any usage figures: nothing
/// here calls a model (<see cref="TestBudgetGuard"/> exists to guarantee that), so the counters are
/// legitimately empty. What matters is that the surface answers, that it reports configuration
/// truthfully, and that it reports the caller's own budget — which is the part a player hitting the
/// ceiling needs in order to be told why.
/// </para>
/// <para>
/// Two methods: the E2E-API tier is capped at 25 by the 100/50/25/25 rule and both hermetic tiers
/// are full.
/// </para>
/// </remarks>
public sealed class AiUsageContractTests
{
    private sealed class UsageFactory : WebApplicationFactory<Program>
    {
        private readonly bool _configured;

        public UsageFactory(bool configured) => _configured = configured;

        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.UseEnvironment("Test");
            // Host setting, not app configuration: auth reads it while services are registered.
            builder.UseSetting("Auth:EnableFakeAuth", "true");
            builder.ConfigureAppConfiguration((_, cfg) =>
            {
                var overrides = new Dictionary<string, string?>(TestBudgetGuard.Overrides)
                {
                    ["Auth:EnableFakeAuth"] = "true",
                };

                if (_configured)
                {
                    // A configured foundry that is never called: no test here reaches a model.
                    overrides["PoMiniGames:AI:FoundryEndpoint"] = "https://stub.invalid";
                    overrides["PoMiniGames:AI:DefaultDeployment"] = "stub-default";
                    overrides["PoMiniGames:AI:Deployments:funquiz"] = "stub-funquiz";
                }

                cfg.AddInMemoryCollection(overrides);
            });
        }
    }

    [Fact]
    public async Task AiUsage_ReportsConfigurationAndTheCallersOwnBudget()
    {
        using var factory = new UsageFactory(configured: true);
        using var client = factory.CreateClient();
        // Outside Development the report is for signed-in callers only.
        client.DefaultRequestHeaders.Add(FakeAuthHandler.UserHeader, "ai-usage-test");

        var response = await client.GetAsync("/api/diag/ai");
        response.StatusCode.Should().Be(HttpStatusCode.OK);

        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var root = doc.RootElement;

        root.GetProperty("configured").GetBoolean().Should().BeTrue();
        root.GetProperty("defaultDeployment").GetString().Should().Be("stub-default");

        // No embedding deployment is set, and the report must say so rather than omit it — that is
        // the signal that PoCoupleQuiz similarity scoring is still on the (more expensive) chat path.
        root.GetProperty("embeddingDeployment").ValueKind.Should().Be(JsonValueKind.Null);

        // Nothing has called a model, so the counters are empty. Asserted rather than skipped: a
        // non-zero count here would mean a test tier is spending tokens.
        root.GetProperty("games").GetArrayLength().Should().Be(0);
        root.GetProperty("totalCalls").GetInt64().Should().Be(0);

        var budget = root.GetProperty("budget");
        budget.GetProperty("allowed").GetBoolean().Should().BeTrue();
        budget.GetProperty("spent").GetInt64().Should().Be(0);
        budget.GetProperty("limit").GetInt64().Should().BeGreaterThan(0,
            because: "a ceiling of zero would mean the daily allowance is switched off");
    }

    [Fact]
    public async Task Health_IncludesAiFoundryCheck_AndToleratesAnUnconfiguredFoundryOutsideProduction()
    {
        using var factory = new UsageFactory(configured: false);
        using var client = factory.CreateClient();

        var response = await client.GetAsync("/api/health");
        var body = await response.Content.ReadAsStringAsync();

        using var doc = JsonDocument.Parse(body);
        var checks = doc.RootElement.GetProperty("checks").EnumerateArray().ToList();

        var ai = checks.SingleOrDefault(c =>
            c.GetProperty("name").GetString() == "AiFoundry");
        ai.ValueKind.Should().NotBe(JsonValueKind.Undefined,
            because: "an AI dependency that no health probe reports is one that fails silently");

        // Outside Production an absent foundry is the expected state (games fall back to mocks),
        // so it must not drag the whole host's status down and take it out of rotation.
        ai.GetProperty("status").GetString().Should().Be("Healthy");
        doc.RootElement.GetProperty("status").GetString().Should().Be("Healthy");
    }
}
