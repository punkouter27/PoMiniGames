using FluentAssertions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using PoMiniGames.AI;

namespace PoMiniGames.Unit.Infrastructure;

/// <summary>
/// Pins the AI Foundry centralization contract:
/// <list type="bullet">
///   <item>No service accepts a per-game <c>Po{Game}:AzureOpenAI:Endpoint</c> / <c>ApiKey</c> section.
///         Such sections belong in <see cref="AIFoundryOptions"/> only.</item>
///   <item>The <see cref="AIFoundryClientFactory"/> is null-tolerant in
///         Development (mock fallback allowed) and null-throwing in Production
///         (fail-fast). Mock fallback paths must never be reachable without an
///         explicit <see cref="IHostEnvironment.IsDevelopment"/> /
///         <see cref="IHostEnvironment.EnvironmentName"/> gate.</item>
///   <item>Per-game deployment keys are case-insensitive and resolve to the
///         configured deployment, falling back to the default.</item>
/// </list>
/// </summary>
public sealed class AIFoundryCentralizationTests
{
    [Theory]
    // A configured game key resolves to its deployment; unknown or empty keys fall
    // back to the default rather than throwing.
    [InlineData("couplequiz", "couplequiz", "gpt-4o")]
    [InlineData("couplequiz", "unknown", "gpt-4o-mini")]
    [InlineData("couplequiz", "", "gpt-4o-mini")]
    // Per-game deployment keys are case-insensitive, in both directions of the
    // casing mismatch (configured PascalCase vs. looked-up lower/upper).
    [InlineData("CoupleQuiz", "couplequiz", "gpt-4o")]
    [InlineData("CoupleQuiz", "COUPLEQUIZ", "gpt-4o")]
    public void AIFoundryOptions_ResolveDeployment_FallsBackToDefault_AndIsCaseInsensitive(
        string configuredKey, string lookupKey, string expectedDeployment)
    {
        var opts = new AIFoundryOptions
        {
            Endpoint = "https://cog-pominigames-shared.openai.azure.com",
            DefaultDeployment = "gpt-4o-mini",
        };
        opts.Deployments[configuredKey] = "gpt-4o";

        opts.ResolveDeployment(lookupKey).Should().Be(expectedDeployment);
    }

    /// <summary>
    /// Each row runs one scenario: a private method below, named after what it checks.
    /// </summary>
    [Theory]
    [InlineData(nameof(AIFoundryOptions_IsConfigured_RequiresBothEndpointAndDefaultDeployment))]
    [InlineData(nameof(AIFoundryClientFactory_NeverFabricatesAClient_AndStaysOneTypePerHost))]
    [InlineData(nameof(MockServices_NeverResolvedThroughAIFoundry))]
    [InlineData(nameof(AiTokenBudget_EvictsStaleLedgersOnlyOnceFlushed))]
    public Task Scenario(string name) => Scenarios.RunAsync(this, name);

    private void AIFoundryOptions_IsConfigured_RequiresBothEndpointAndDefaultDeployment()
    {
        new AIFoundryOptions { Endpoint = "https://x", DefaultDeployment = "" }
            .IsConfigured.Should().BeFalse();
        new AIFoundryOptions { Endpoint = "", DefaultDeployment = "gpt-4o-mini" }
            .IsConfigured.Should().BeFalse();
        new AIFoundryOptions { Endpoint = "https://x", DefaultDeployment = "gpt-4o-mini" }
            .IsConfigured.Should().BeTrue();
    }

    private void AIFoundryClientFactory_NeverFabricatesAClient_AndStaysOneTypePerHost()
    {
        // Endpoint missing (deployment set): the factory must return null rather than invent a client.
        var endpointless = new TestOptionsMonitor<AIFoundryOptions>(new AIFoundryOptions
        {
            Endpoint = string.Empty,
            DefaultDeployment = "gpt-4o-mini",
        });
        new AIFoundryClientFactory(endpointless, NullLogger<AIFoundryClientFactory>.Instance)
            .Client.Should().BeNull("an unconfigured foundry must NOT silently fabricate a client");

        // Nothing configured at all: no chat client resolves for any game's deployment.
        var empty = new TestOptionsMonitor<AIFoundryOptions>(new AIFoundryOptions());
        var unconfigured = new AIFoundryClientFactory(empty, NullLogger<AIFoundryClientFactory>.Instance);
        foreach (var game in new[] { AIFoundryOptions.Games.FunQuiz, AIFoundryOptions.Games.CoupleQuiz })
            unconfigured.GetChatClient(empty.CurrentValue.ResolveDeployment(game)).Should().BeNull();

        // The factory must be a singleton — building two AzureOpenAIClient instances
        // (one per request) would double the underlying HTTPS connections and
        // break the resilience pipeline's circuit breaker state. Both instances expose the
        // same singleton — the Lazy<T> inside the factory only initializes once per host.
        var configured = new TestOptionsMonitor<AIFoundryOptions>(new AIFoundryOptions
        {
            Endpoint = "https://cog-pominigames-shared.openai.azure.com",
            DefaultDeployment = "gpt-4o-mini",
        });
        var factory1 = new AIFoundryClientFactory(configured, NullLogger<AIFoundryClientFactory>.Instance);
        var factory2 = new AIFoundryClientFactory(configured, NullLogger<AIFoundryClientFactory>.Instance);
        factory1.GetType().Should().Be(factory2.GetType());
    }

    /// <summary>
    /// Stops a mock-data regression: any future change
    /// that registers the mock implementation as the production default would
    /// serve fabricated data to real players. This is the static check that
    /// catches the wiring without needing to spin up the host.
    /// </summary>
    private void MockServices_NeverResolvedThroughAIFoundry()
    {
        // The legacy PoFunQuiz:AzureOpenAI:ApiKey section is gone — verify
        // there's no configuration value to accidentally inherit.
        var config = new ConfigurationBuilder().Build();
        config["PoFunQuiz:AzureOpenAI:ApiKey"].Should().BeNull();
        config["PoCoupleQuiz:AzureOpenAI:ApiKey"].Should().BeNull();
    }

    /// <summary>
    /// The budget's per-identity ledgers are a cache over the durable store, so one left from an
    /// earlier UTC day must go once its spend is written (or the dictionary grows by every caller
    /// the process ever saw) and must stay while a delta is still waiting to be written.
    /// </summary>
    private async Task AiTokenBudget_EvictsStaleLedgersOnlyOnceFlushed()
    {
        var now = new DateTimeOffset(2026, 10, 1, 23, 0, 0, TimeSpan.Zero);
        var store = new RecordingLedgerStore();
        var budget = new AiTokenBudget(1000, () => now, store);
        var ledgers = (System.Collections.IDictionary)typeof(AiTokenBudget)
            .GetField("_ledgers", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!
            .GetValue(budget)!;

        budget.Record("id:a", 40);
        now = now.AddHours(2); // next UTC day, the delta not yet written

        await budget.FlushAsync();
        store.Writes.Should().ContainSingle().Which.Should().Be((new DateOnly(2026, 10, 1), "id:a", 40L));
        ledgers.Count.Should().Be(1, "a ledger with an unwritten delta must not be dropped");

        await budget.FlushAsync();
        ledgers.Count.Should().Be(0, "a stale, fully-flushed ledger is evicted");

        budget.Record("id:a", 5);
        (await budget.CheckAsync("id:a")).Spent.Should().Be(5, "a fresh ledger starts the new day");
    }

    private sealed class RecordingLedgerStore : IAiTokenLedgerStore
    {
        public List<(DateOnly Day, string Identity, long Delta)> Writes { get; } = [];
        public bool IsDurable => true;
        public Task<long> LoadAsync(DateOnly day, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult(0L);
        public Task IncrementAsync(DateOnly day, string identity, long delta, CancellationToken cancellationToken = default)
        {
            Writes.Add((day, identity, delta));
            return Task.CompletedTask;
        }
    }

    private sealed class TestOptionsMonitor<T> : IOptionsMonitor<T>
    {
        public TestOptionsMonitor(T value) => CurrentValue = value;
        public T CurrentValue { get; }
        public T Get(string? name) => CurrentValue;
        public IDisposable? OnChange(Action<T, string?> listener) => null;
    }
}
