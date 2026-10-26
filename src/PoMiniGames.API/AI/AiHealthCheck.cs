using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;

namespace PoMiniGames.AI;

/// <summary>
/// Reports the state of the AI path to <c>/health</c>.
/// </summary>
/// <remarks>
/// <para>
/// <c>/health</c> covered Storage and Table Storage and nothing else, so every AI failure mode this
/// codebase has actually hit — a deployment name that does not exist, an endpoint that stopped
/// answering, a circuit stuck open — was invisible to a monitor. It surfaced as a game behaving
/// oddly, and was diagnosed from logs after the fact.
/// </para>
/// <para>
/// <b>Deliberately does not call the model.</b> A health check runs on every probe; making it
/// issue a completion would put a paid call on a schedule and, on an account whose measured
/// request quota is around one concurrent call, would itself contend with players. It reports what
/// the process already knows: whether the foundry is configured, and what the recorded outcome of
/// real traffic has been. That is a lagging signal, and honest about it — a deployment with no
/// traffic yet is <see cref="HealthStatus.Healthy"/> with "no calls recorded", not a false alarm.
/// </para>
/// <para>
/// Unconfigured is <see cref="HealthStatus.Healthy"/> outside Production and
/// <see cref="HealthStatus.Unhealthy"/> in it: a dev machine with no Key Vault access is expected
/// to have no foundry, whereas a Production host without one cannot serve four of its games.
/// </para>
/// </remarks>
public sealed class AiFoundryHealthCheck : IHealthCheck
{
    /// <summary>Failure ratio for a game above which the AI path is reported degraded.</summary>
    private const double DegradedFailureRatio = 0.5;

    /// <summary>Calls a game must have made before its failure ratio is meaningful.</summary>
    private const long MinimumCallsForRatio = 5;

    private readonly IOptionsMonitor<AIFoundryOptions> _options;
    private readonly AiUsageAccumulator _usage;
    private readonly IHostEnvironment _environment;

    public AiFoundryHealthCheck(
        IOptionsMonitor<AIFoundryOptions> options,
        AiUsageAccumulator usage,
        IHostEnvironment environment)
    {
        _options = options;
        _usage = usage;
        _environment = environment;
    }

    public Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        var options = _options.CurrentValue;

        if (!options.IsConfigured)
        {
            return Task.FromResult(_environment.IsProduction()
                ? HealthCheckResult.Unhealthy(
                    $"AI Foundry is not configured. Set {AIFoundryOptions.SectionName} " +
                    "(FoundryEndpoint + DefaultDeployment) in Key Vault (kv-poshared2).")
                : HealthCheckResult.Healthy(
                    $"AI Foundry is not configured; games fall back to mocks in {_environment.EnvironmentName}."));
        }

        var snapshot = _usage.Snapshot();
        var data = snapshot.ToDictionary(
            kv => kv.Key,
            kv => (object)new
            {
                kv.Value.Deployment,
                kv.Value.Calls,
                kv.Value.Failures,
                kv.Value.AverageLatencyMs,
                kv.Value.AverageTokens,
            });
        data["endpoint"] = options.Endpoint;
        data["defaultDeployment"] = options.DefaultDeployment;
        data["embeddings"] = string.IsNullOrWhiteSpace(options.EmbeddingDeployment)
            ? "not configured (similarity scoring uses the chat path)"
            : options.EmbeddingDeployment;

        var failing = snapshot
            .Where(kv => kv.Value.Calls + kv.Value.Failures >= MinimumCallsForRatio)
            .Where(kv => (double)kv.Value.Failures / (kv.Value.Calls + kv.Value.Failures) >= DegradedFailureRatio)
            .Select(kv => $"{kv.Key} ({kv.Value.Failures} failed of {kv.Value.Calls + kv.Value.Failures}, deployment {kv.Value.Deployment})")
            .ToList();

        if (failing.Count > 0)
        {
            // Degraded, not Unhealthy: every AI-backed game here has a fallback (mock or cached),
            // so a failing deployment degrades play rather than
            // taking the host down. Reporting it as Unhealthy would take a healthy host out of
            // rotation over a dependency it can survive.
            return Task.FromResult(HealthCheckResult.Degraded(
                "AI calls are failing for: " + string.Join("; ", failing), data: data));
        }

        var totalCalls = snapshot.Values.Sum(c => c.Calls);
        return Task.FromResult(HealthCheckResult.Healthy(
            totalCalls == 0
                ? "AI Foundry is configured; no calls recorded yet this process."
                : $"AI Foundry is configured; {totalCalls} successful call(s) recorded this process.",
            data: data));
    }
}
