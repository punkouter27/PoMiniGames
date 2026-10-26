using System.Collections.Concurrent;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;
using Polly.Registry;
using PoMiniGames.Shared.Models;

namespace PoMiniGames.AI;

/// <summary>
/// Builds and caches the composed <see cref="IChatClient"/> a game talks to: the shared foundry
/// client wrapped in the telemetry and resilience decorators.
/// </summary>
/// <remarks>
/// <para>
/// Each AI-consuming slice previously reached for a bare SDK client itself. That left every
/// cross-cutting guarantee opt-in, and every slice opted out: the resilience pipeline had no
/// consumers at all, and no call site recorded token usage. Composing here means a slice gets the
/// whole posture by asking for its client:
/// </para>
/// <code>
/// FallbackChatClient                   // one retry on FallbackDeployment, when set
///   └─ ResilientChatClient             // total-call budget, retry, circuit breaker
///        └─ BudgetedChatClient         // per-identity daily token ceiling
///             └─ InstrumentedChatClient     // token/latency logging, health tracking
///                  └─ foundry ChatClient    // one shared SDK client per deployment
/// </code>
/// <para>
/// The decorators nest in that order on purpose: telemetry inside the pipeline measures one
/// attempt's real service latency, and counts a retried attempt as the failure it was. The spend
/// ceiling sits between them — inside the pipeline so a refusal is not retried and does not count
/// toward the circuit breaker, outside the telemetry so a refused call is not recorded as a
/// provider failure. A caller out of allowance is not a sick deployment.
/// </para>
/// <para>
/// Composition is per <b>deployment</b>, not per game, because one game's tasks can resolve to
/// different deployments (the <c>game.task</c> keys under <c>PoMiniGames:AI:Deployments</c>, such
/// as <c>couplequiz.similarity</c>). The first cut of this took the game's client from DI and
/// reached past it to the bare cache for any other deployment — so the moment a call named a
/// deployment of its own, every guarantee here was bypassed again and the telemetry went silent.
/// One decorated client per deployment, cached, is what keeps that from being possible.
/// </para>
/// </remarks>
public sealed class GameChatClientFactory
{
    private readonly AIFoundryClientFactory _foundry;
    private readonly IOptionsMonitor<AIFoundryOptions> _options;
    private readonly ILoggerFactory _loggerFactory;
    private readonly AiUsageAccumulator _usage;
    private readonly IServiceProvider _services;
    private readonly ResiliencePipelineProvider<string> _pipelines;
    private readonly AiTokenBudget _budget;

    private readonly ConcurrentDictionary<string, IChatClient> _composed =
        new(StringComparer.OrdinalIgnoreCase);

    // Flyweight: one bare SDK client per deployment, shared by every game routed to it.
    // Deployments are immutable per app lifetime, so neither cache ever evicts.
    private readonly ConcurrentDictionary<string, IChatClient> _bare =
        new(StringComparer.OrdinalIgnoreCase);

    public GameChatClientFactory(
        AIFoundryClientFactory foundry,
        IOptionsMonitor<AIFoundryOptions> options,
        ILoggerFactory loggerFactory,
        AiUsageAccumulator usage,
        IServiceProvider services,
        ResiliencePipelineProvider<string> pipelines,
        AiTokenBudget budget)
    {
        _foundry = foundry;
        _options = options;
        _loggerFactory = loggerFactory;
        _usage = usage;
        _services = services;
        _pipelines = pipelines;
        _budget = budget;
    }

    /// <summary>
    /// The deployment name <paramref name="gameKey"/> resolves to. Exposed so a caller can build
    /// capability-correct <see cref="Microsoft.Extensions.AI.ChatOptions"/> for the model that will
    /// actually serve the call — see <see cref="AiDecisionChatOptions.ForStructuredJson"/>.
    /// </summary>
    public string DeploymentFor(string gameKey) => _options.CurrentValue.ResolveDeployment(gameKey);

    /// <summary>Capability overrides from configuration, for the same options-building path.</summary>
    public IReadOnlyDictionary<string, string> CapabilityOverrides => _options.CurrentValue.ModelCapabilityOverrides;

    /// <summary>
    /// The decorated client for <paramref name="gameKey"/>'s configured deployment. Throws when the
    /// foundry is unconfigured — callers with a mock path must check
    /// <see cref="AIFoundryOptions.IsConfigured"/> first rather than catching.
    /// </summary>
    public IChatClient ForGame(string gameKey)
        => ForDeployment(gameKey, _options.CurrentValue.ResolveDeployment(gameKey))
           ?? throw new InvalidOperationException(
               $"AIFoundry is not configured for game '{gameKey}'. Set {AIFoundryOptions.SectionName} " +
               "(FoundryEndpoint + DefaultDeployment) in Key Vault (kv-poshared2) or configuration.");

    /// <summary>
    /// The decorated client for an explicit deployment, or null when the foundry is unconfigured.
    /// The caller must have validated <paramref name="deployment"/> against a server-side
    /// allowlist — this method does not.
    /// </summary>
    public IChatClient? ForDeployment(string gameKey, string deployment)
    {
        if (string.IsNullOrWhiteSpace(deployment))
            return null;

        var key = $"{gameKey}|{deployment}";
        if (_composed.TryGetValue(key, out var existing))
            return existing;

        var bare = BareClientFor(deployment);
        if (bare is null)
            return null;

        var logger = _loggerFactory.CreateLogger($"PoMiniGames.AI.{gameKey}");

        // Health trackers are registered per game, and a task key ("couplequiz.similarity") shares its
        // game's tracker: a task is not a separate dependency to be healthy or unhealthy about.
        var healthKey = HealthKeyFor(gameKey);

        var instrumented = new InstrumentedChatClient(
            bare,
            gameKey,
            deployment,
            logger,
            _usage,
            _services.GetRequiredKeyedService<InferenceHealthTracker>(healthKey));

        var budgeted = new BudgetedChatClient(instrumented, _budget, gameKey, logger);

        IChatClient composed = new ResilientChatClient(
            budgeted,
            ResolvePipeline(healthKey));

        // Outermost, so the fallback is tried only after the primary's own retries are spent.
        // Resolved per call: the option can change, and the fallback deployment's own client
        // (which must not wrap itself) is composed lazily through this same method.
        composed = new FallbackChatClient(
            composed,
            () =>
            {
                var fallback = _options.CurrentValue.FallbackDeployment;
                return string.IsNullOrWhiteSpace(fallback)
                       || string.Equals(fallback, deployment, StringComparison.OrdinalIgnoreCase)
                    ? null
                    : ForDeployment(gameKey, fallback);
            },
            gameKey,
            logger);

        return _composed.GetOrAdd(key, composed);
    }

    /// <summary>
    /// The undecorated client for <paramref name="deployment"/> from whichever provider is
    /// configured (Azure, or an OpenAI-compatible backend such as Ollama), or null when none is.
    /// </summary>
    private IChatClient? BareClientFor(string deployment)
    {
        if (_bare.TryGetValue(deployment, out var cached))
            return cached;

        var client = _foundry.GetChatClient(deployment);
        return client is null ? null : _bare.GetOrAdd(deployment, client.AsIChatClient());
    }

    /// <summary>
    /// The game a key belongs to. <c>couplequiz.similarity</c> → <c>couplequiz</c>; anything without a task
    /// suffix is already a game key.
    /// </summary>
    private static string HealthKeyFor(string gameKey)
    {
        var dot = gameKey.IndexOf('.');
        return dot > 0 ? gameKey[..dot] : gameKey;
    }

    /// <summary>
    /// The game's own resilience partition, or the shared pipeline for a game that has none. Each
    /// partitioned game gets its own concurrency permits and its own circuit state — see
    /// <see cref="AzureOpenAIResilience.PartitionedGames"/> for why they are not shared.
    /// </summary>
    private Polly.ResiliencePipeline ResolvePipeline(string gameKey)
        => _pipelines.TryGetPipeline(AzureOpenAIResilience.PipelineNameFor(gameKey), out var partitioned)
            ? partitioned
            : _pipelines.GetPipeline(AzureOpenAIResilience.PipelineName);

    /// <summary>
    /// Executes every buffered model call through the game's <see cref="AzureOpenAIResilience"/>
    /// pipeline: total-call budget, concurrency gates, jittered retry, circuit breaker.
    /// </summary>
    /// <remarks>
    /// A decorator rather than a call in each service, so a new AI-consuming slice inherits the
    /// posture by resolving its chat client and cannot forget to opt in. Before it existed a single
    /// relay call ran 51.6 s against the documented 20 s ceiling, with no circuit state at all.
    /// </remarks>
    private sealed class ResilientChatClient(IChatClient innerClient, Polly.ResiliencePipeline pipeline)
        : DelegatingChatClient(innerClient)
    {
        public override Task<ChatResponse> GetResponseAsync(
            IEnumerable<ChatMessage> messages,
            ChatOptions? options = null,
            CancellationToken cancellationToken = default)
            => pipeline.ExecuteAsync(
                static (state, ct) => new ValueTask<ChatResponse>(
                    state.Inner.GetResponseAsync(state.Messages, state.Options, ct)),
                (Inner: InnerClient, Messages: messages, Options: options),
                cancellationToken).AsTask();
    }
}

/// <summary>DI registration for <see cref="GameChatClientFactory"/>-backed game chat clients.</summary>
public static class GameChatClientRegistration
{
    /// <summary>
    /// Adds the keyed <see cref="IChatClient"/> and per-game
    /// <see cref="InferenceHealthTracker"/> for <paramref name="gameKey"/>.
    /// </summary>
    /// <remarks>
    /// Idempotent. Every registration here is a <c>TryAdd</c> so the slices that call this
    /// cannot double-register a health tracker or fight
    /// over the keyed client. Task-scoped clients (<c>couplequiz.similarity</c>) are NOT registered here:
    /// they share their game's tracker and are resolved from <see cref="GameChatClientFactory"/>
    /// directly, because a task is a call-site concern, not a dependency.
    /// </remarks>
    public static IServiceCollection AddGameChatClient(this IServiceCollection services, string gameKey)
    {
        services.TryAddSingletonFactory();
        services.TryAddKeyedSingleton<InferenceHealthTracker>(gameKey, (_, _) => new InferenceHealthTracker());
        services.TryAddKeyedSingleton<IChatClient>(gameKey, (sp, key) =>
            sp.GetRequiredService<GameChatClientFactory>().ForGame((string)key!));
        return services;
    }

    private static void TryAddSingletonFactory(this IServiceCollection services)
        => Microsoft.Extensions.DependencyInjection.Extensions.ServiceCollectionDescriptorExtensions
            .TryAddSingleton<GameChatClientFactory>(services);
}
