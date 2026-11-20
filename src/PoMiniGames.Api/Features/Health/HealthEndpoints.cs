using System.Text.Json;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using PoMiniGames.Serialization;

namespace PoMiniGames.Features.Health;

/// <summary>
/// Minimal API health endpoints, all under a single <c>/api/health/*</c> prefix.
/// <list type="bullet">
///   <item><c>GET /api/health</c> — structured health report (the legacy contract)</item>
///   <item><c>GET /api/health/ping</c> — zero-dependency <c>pong</c> (no health-check service)</item>
///   <item><c>GET /health</c> — the readiness probe (Po web standard): the same JSON report.</item>
/// </list>
/// </summary>
/// <remarks>
/// Pattern: Adapter over ASP.NET Core's <see cref="HealthCheckService"/>. The
/// application-composition root treats these URLs as a single namespace so
/// <c>curl .../api/health/...</c> is the only shape dev/ops/CI ever have to learn.
/// <c>/health</c> survives only because App Service probes it; new callers use
/// <c>/api/health</c>.
/// </remarks>
public static class HealthEndpoints
{
    public static IEndpointRouteBuilder MapHealthEndpoints(this IEndpointRouteBuilder app)
    {
        async Task<IResult> healthHandler(HealthCheckService healthCheckService)
        {
            var report = await healthCheckService.CheckHealthAsync();
            var response = CreateHealthResponse(report);
            var statusCode = report.Status == HealthStatus.Unhealthy
                ? StatusCodes.Status503ServiceUnavailable
                : StatusCodes.Status200OK;
            var json = JsonSerializer.Serialize(response, ApiJsonContext.Default.HealthCheckResponse);
            return Results.Content(json, "application/json", statusCode: statusCode);
        }

        // Every /api/health/* route lives under the same
        // group so the OpenAPI tag, auth gate (none — probes must stay anonymous),
        // and route prefix are declared once.
        var health = app.MapGroup("/api/health").WithTags("Health");

        health.MapGet("", healthHandler)
        .WithName("HealthCheck")
        .WithSummary("Structured health report for all dependencies");

        health.MapGet("/ping", () => Results.Ok("pong"))
            .WithName("HealthPing")
            .WithSummary("Simple liveness probe (no health-check service)");

        // Root /health: the readiness probe (Po web standard) — the same JSON report as /api/health, for monitors
        // and App Service. The human page is /diag only; this route never serves HTML.
        app.MapGet("/health", healthHandler)
            .WithName("HealthCheckRootAlias")
            .WithTags("Health")
            .WithSummary("Readiness: the dependency health report as JSON")
            .ExcludeFromDescription();

        return app;
    }

    private static HealthCheckResponse CreateHealthResponse(HealthReport report)
    {
        return new HealthCheckResponse(
            report.Status.ToString(),
            report.Entries.Select(e => new HealthCheckEntry(
                e.Key,
                e.Value.Status.ToString(),
                e.Value.Description,
                e.Value.Duration.TotalMilliseconds)).ToArray(),
            report.TotalDuration.TotalMilliseconds,
            DateTimeOffset.UtcNow);
    }
}

internal sealed record HealthCheckResponse(
    string Status,
    IReadOnlyList<HealthCheckEntry> Checks,
    double TotalDuration,
    DateTimeOffset CheckedAtUtc);

internal sealed record HealthCheckEntry(string Name, string Status, string? Description, double Duration);
