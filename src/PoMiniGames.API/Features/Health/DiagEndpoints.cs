using System.Globalization;
using System.Security.Claims;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Options;
using PoMiniGames.Domain.Abstractions;
using PoMiniGames.Features.Auth;
using PoMiniGames.Infrastructure;

namespace PoMiniGames.Features.Health;

/// <summary>
/// Wire-format DTO for <c>/api/diag</c>. The snapshot provider may surface a
/// wider, internal-only object graph (reflection helpers, type manifests, etc.);
/// this projection restricts the over-the-wire payload to the fields safe to
/// expose to dev tools and CI. See <see cref="DiagEndpoints.diagHandler"/>.
/// </summary>
internal sealed record DiagResponse(
    DiagIdentity Identity,
    DiagEnvironment Environment,
    IReadOnlyList<DiagIntegration> Integrations);

internal sealed record DiagIdentity(
    string Solution,
    string AppPrefix,
    DiagPorts Ports);

internal sealed record DiagPorts(int Http, int Https);

internal sealed record DiagEnvironment(
    string Name,
    string ApplicationName,
    string ApplicationInsights,
    string KeyVaultUri,
    IReadOnlyDictionary<string, string> TelemetryFlags);

internal sealed record DiagIntegration(
    string Name,
    string Status,
    string? Description);

public static class DiagEndpoints
{
    private const int MaxLogFileBytes = 512 * 1024;       // 512 KB upper bound on a log-tail response.
    private const int MaxTailLines = 500;                  // Cap rows per call to keep the response bounded.
    private const int MaxPayloadBytes = 8 * 1024 * 1024;   // 8 MB upper bound on the /api/diag payload.

    public static IEndpointRouteBuilder MapDiagEndpoints(this IEndpointRouteBuilder app)
    {
        var isDevelopment = app.ServiceProvider.GetRequiredService<IWebHostEnvironment>().IsDevelopment();

        async Task<IResult> diagHandler(IConfiguration configuration, IWebHostEnvironment environment, ConfigurationDiagnosticsSnapshotProvider diagnosticsProvider, CancellationToken ct)
        {
            var diagnosticsEnabled = configuration.GetValue("FeatureFlags:EnableDiagnostics", environment.IsDevelopment());
            if (!diagnosticsEnabled)
            {
                return Results.NotFound();
            }

            // Adapter-style endpoint: transport concerns stay here, while diagnostics assembly
            // is delegated to an application-facing provider for Onion-style separation.
            // We project the wide provider payload down to a strict, documented DTO so
            // reflection helpers / type graphs never leak to dev tooling.
            var raw = await diagnosticsProvider.BuildSnapshotAsync();
            var projection = ProjectDiagnostics(raw, configuration, environment);
            var json = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(projection, new System.Text.Json.JsonSerializerOptions
            {
                WriteIndented = false,
                DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull
            });
            if (json.Length > MaxPayloadBytes)
            {
                return Results.Problem(
                    statusCode: StatusCodes.Status503ServiceUnavailable,
                    title: "Diag payload too large",
                    detail: $"Diag snapshot projected to {json.Length} bytes exceeds the {MaxPayloadBytes}-byte safety cap.");
            }
            return Results.File(json, "application/json");
        }

        // Internal projection: take whatever the provider produced and pull out the
        // well-known scalar fields. Unknown / nested type-graph entries are dropped
        // so a future change to the provider cannot widen the response surface.
        static DiagResponse ProjectDiagnostics(object raw, IConfiguration config, IWebHostEnvironment env)
        {
            var dict = raw as IDictionary<string, object?>
                       ?? (raw is string s ? new Dictionary<string, object?>() { ["raw"] = s } : new Dictionary<string, object?>());

            // Bug fix QA #5: the snapshot provider returns nested *anonymous* objects
            // (e.g. `new { solution, appPrefix, ports }`) which are NOT IDictionary
            // instances — so the original lookup-by-string-path returned "" for every
            // nested key, surfacing empty identity/integrations to /api/diag. Use a
            // case-insensitive reflection walker that handles anonymous types as well
            // as dictionaries, so the live snapshot fields actually appear.
            string Get(params string[] path)
            {
                object? cur = dict;
                foreach (var key in path)
                {
                    if (cur is null) return string.Empty;
                    if (cur is IDictionary<string, object?> d)
                    {
                        if (!d.TryGetValue(key, out var v)) return string.Empty;
                        cur = v;
                        continue;
                    }
                    // Anonymous / POCO walk via case-insensitive property lookup.
                    var prop = cur.GetType()
                        .GetProperty(key, System.Reflection.BindingFlags.Public
                            | System.Reflection.BindingFlags.Instance
                            | System.Reflection.BindingFlags.IgnoreCase);
                    if (prop is null) return string.Empty;
                    cur = prop.GetValue(cur);
                }
                return cur?.ToString() ?? string.Empty;
            }

            var ports = new DiagPorts(
                Http: int.TryParse(Get("identity", "ports", "http"), out var hp) ? hp : 5000,
                Https: int.TryParse(Get("identity", "ports", "https"), out var xp) ? xp : 5001);

            var identity = new DiagIdentity(
                Solution: Get("identity", "solution"),
                AppPrefix: Get("identity", "appPrefix"),
                Ports: ports);

            var telemetryFlags = new Dictionary<string, string>
            {
                ["enableDiagnostics"] = config.GetValue("FeatureFlags:EnableDiagnostics", env.IsDevelopment()).ToString(),
                ["autoGuestLogin"] = config.GetValue("Auth:AutoGuestLogin", false).ToString(),
            };
            // If Application Insights is configured, surface a non-secret indicator only.
            var ai = config.GetValue<string>("ApplicationInsights:ConnectionString")
                  ?? config.GetValue<string>("APPLICATIONINSIGHTS_CONNECTION_STRING")
                  ?? string.Empty;
            if (!string.IsNullOrEmpty(ai)) { telemetryFlags["applicationInsightsConfigured"] = "true"; }

            var environment = new DiagEnvironment(
                Name: env.EnvironmentName,
                ApplicationName: env.ApplicationName,
                ApplicationInsights: ai.Length > 0 ? "configured" : string.Empty,
                // This route is anonymous, so outside Development it says only whether a
                // vault is configured, never which one.
                KeyVaultUri: config.GetValue<string>("KeyVault:Uri") is { Length: > 0 } vault
                    ? (env.IsDevelopment() ? vault : "configured")
                    : string.Empty,
                TelemetryFlags: telemetryFlags);

            // Project the integrations section into a flat name/status/description list.
            // The provider returns an anonymous object with named boolean sub-fields
            // (keyVaultConfigured, applicationInsightsConfigured, …) — flatten them here
            // so /api/diag surfaces the live integration state, not [].
            var integrations = new List<DiagIntegration>();

            // 1) Anonymous object with boolean sub-fields (e.g. integrations = new { keyVaultConfigured = true })
            if (dict.TryGetValue("integrations", out var integObj) && integObj is not null
                && integObj is not IDictionary<string, object?>
                && integObj is not string
                && integObj is not IEnumerable<object?>)
            {
                var anonType = integObj.GetType();
                foreach (var prop in anonType.GetProperties(System.Reflection.BindingFlags.Public
                                                           | System.Reflection.BindingFlags.Instance))
                {
                    var value = prop.GetValue(integObj);
                    var status = value switch
                    {
                        bool b => b ? "configured" : "not-configured",
                        null => "not-configured",
                        _ => value.ToString() ?? "unknown"
                    };
                    integrations.Add(new DiagIntegration(prop.Name, status ?? "unknown", null));
                }
            }
            // 2) Already-shaped list of { name, status, description } dictionaries.
            else if (dict.TryGetValue("integrations", out var integList) && integList is IEnumerable<object?> items)
            {
                foreach (var item in items)
                {
                    if (item is IDictionary<string, object?> d
                        && d.TryGetValue("name", out var n)
                        && d.TryGetValue("status", out var st))
                    {
                        integrations.Add(new DiagIntegration(
                            n?.ToString() ?? string.Empty,
                            st?.ToString() ?? string.Empty,
                            d.TryGetValue("description", out var desc) ? desc?.ToString() : null));
                    }
                }
            }

            return new DiagResponse(identity, environment, integrations);
        }

        // /api/diag routes share the /api/diag prefix; /api/logs/tail sits at a
        // sibling path so it gets its own sibling declaration.
        var diag = app.MapGroup("/api/diag").WithTags("Health");

        diag.MapGet("", diagHandler)
        .WithName("GetDiagnostics")
        .WithSummary("Exposes a development-focused diagnostic summary without raw secret values");

        // Signed-in callers only outside Development. Every signed-in caller gets their own budget;
        // the cross-identity aggregates (per-game spend, deployment names) are stripped unless the
        // caller is an operator (see IsAiUsageAdmin).
        var aiUsage = diag.MapGet("/ai", GetAiUsage)
        .WithName("AiUsage")
        .WithSummary("Per-game AI call counts, failures, token totals and latency for this process.")
        .RequireRateLimiting("leaderboard-read")
        .Produces<AiUsageReportDto>(StatusCodes.Status200OK);
        if (!isDevelopment)
            aiUsage.RequireAuthorization();

        // Note: /diag is NOT registered as an API endpoint to avoid conflicting with
        // the Blazor page route at /diag. Use /api/diag for programmatic access.

        // ─── Log tail endpoint for dev diagnostics ───────────────────────
        // Serilog's File sink acquires an exclusive handle
        // on the log file by default. Reading via `File.ReadAllLines` would throw
        // "The process cannot access the file …". We open with FileShare.ReadWrite
        // (and a tight 512 KB byte budget) so the tail endpoint can serve the rolling
        // log without taking a competing lock.
        async Task<IResult> logsTailHandler(IConfiguration config, IWebHostEnvironment environment, int? lines = 50)
        {
            var diagnosticsEnabled = config.GetValue("FeatureFlags:EnableDiagnostics", environment.IsDevelopment());
            if (!diagnosticsEnabled)
                return Results.NotFound();

            try
            {
                var logsDir = Path.Combine(environment.ContentRootPath, "logs");
                if (!Directory.Exists(logsDir))
                    return Results.Ok(new { message = "No logs directory found", entries = Array.Empty<string>() });

                var latestLog = Directory.GetFiles(logsDir, "*.log")
                    .OrderByDescending(f => File.GetLastWriteTime(f))
                    .FirstOrDefault();

                if (latestLog == null)
                    return Results.Ok(new { message = "No log files found", entries = Array.Empty<string>() });

                var lineCount = Math.Clamp(lines ?? 50, 1, MaxTailLines);

                // Use FileStream with FileShare.ReadWrite so we can read while Serilog
                // is also writing to the file. Read from the end to stay within the
                // byte cap on large files.
                string[] entries;
                int totalLines;
                using (var fs = new FileStream(latestLog, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                {
                    if (fs.Length > MaxLogFileBytes)
                    {
                        fs.Seek(-MaxLogFileBytes, SeekOrigin.End);
                        // Skip the first (likely partial) line so we don't return a
                        // truncated row at the top of the tail.
                        var discard = new byte[1];
                        while (fs.Read(discard, 0, 1) == 1 && discard[0] != (byte)'\n') { }
                    }
                    using var sr = new StreamReader(fs);
                    var content = sr.ReadToEnd();
                    entries = content.Split('\n', StringSplitOptions.RemoveEmptyEntries)
                                     .Select(l => l.TrimEnd('\r'))
                                     .TakeLast(lineCount)
                                     .ToArray();
                    totalLines = content.Count(c => c == '\n') + 1;
                }

                return Results.Ok(new
                {
                    file = Path.GetFileName(latestLog),
                    totalLines,
                    shownLines = entries.Length,
                    entries
                });
            }
            catch (FileNotFoundException)
            {
                // Serilog's rolling sink may have moved the file out from under us.
                return Results.Ok(new { message = "Log file rolled during read; retry." });
            }
            catch (IOException ex)
            {
                return Results.Ok(new { error = ex.Message, hint = "File is locked by another process; open with FileShare.ReadWrite." });
            }
            catch (Exception ex)
            {
                return Results.Ok(new { error = ex.Message });
            }
        }

        // Raw log tails are dev-only: unlike /api/diag (masked projection) this streams
        // unmasked log content, so outside Development the route is not mapped at all.
        if (!isDevelopment)
            return app;

        // The log-tail surface gets its own /api/logs group (distinct prefix from
        // /api/diag) so every route is registered via a group rather than a scattered
        // app.MapGet.
        var logs = app.MapGroup("/api/logs").WithTags("Health");
        logs.MapGet("/tail", logsTailHandler)
        .WithName("GetLogsTail")
        .WithSummary("Tail the latest development log file (dev-only)");

        return app;
    }

    /// <summary>
    /// <c>GET /api/diag/ai</c>: the runtime read-model of what the AI path is doing and costing.
    /// Process-local and not authoritative (the figures reset on restart and are per-instance); the
    /// billing truth is the per-call log lines Application Insights ingests. Not gated by
    /// <c>EnableDiagnostics</c>. Every caller sees configuration presence and their own budget;
    /// per-game counters, spend totals and deployment names cover every player, so outside
    /// Development they go only to operators listed in <see cref="AiUsageAdminsKey"/>.
    /// </summary>
    private static IResult GetAiUsage(
        AiUsageAccumulator usage,
        AiTokenBudget budget,
        IOptionsMonitor<AIFoundryOptions> options,
        IWebHostEnvironment environment,
        IConfiguration configuration,
        HttpContext http)
    {
        var opts = options.CurrentValue;
        var isDevelopment = environment.IsDevelopment();
        var showAggregates = isDevelopment || IsAiUsageAdmin(http.User, configuration);

        List<AiGameUsageDto> games = !showAggregates ? [] : usage.Snapshot()
            .OrderBy(kv => kv.Key, StringComparer.OrdinalIgnoreCase)
            .Select(kv => new AiGameUsageDto(
                Game: kv.Key,
                Deployment: kv.Value.Deployment,
                Calls: kv.Value.Calls,
                Failures: kv.Value.Failures,
                TotalTokens: kv.Value.TotalTokens,
                AverageTokens: kv.Value.AverageTokens,
                AverageLatencyMs: kv.Value.AverageLatencyMs,
                InputTokens: kv.Value.InputTokens,
                OutputTokens: kv.Value.OutputTokens,
                TotalCostUsd: kv.Value.TotalCostUsd,
                AverageCostUsd: kv.Value.AverageCostUsd))
            .ToList();

        // The caller's own allowance, so a player hitting the ceiling can be told why without
        // anyone reading a log. Only ever their own — this reports no other identity's spend.
        var identity = AiUsageScope.ResolveIdentity(http);
        var verdict = budget.Check(identity);

        var totalCost = games.Sum(g => g.TotalCostUsd);

        return Results.Ok(new AiUsageReportDto(
            Configured: opts.IsConfigured,
            // The account's address is shown in Development only, even to operators.
            Endpoint: opts.IsConfigured && isDevelopment ? opts.Endpoint : null,
            DefaultDeployment: showAggregates ? opts.DefaultDeployment : null,
            EmbeddingDeployment: showAggregates && !string.IsNullOrWhiteSpace(opts.EmbeddingDeployment) ? opts.EmbeddingDeployment : null,
            Aggregates: showAggregates,
            Games: games,
            TotalCalls: games.Sum(g => g.Calls),
            TotalFailures: games.Sum(g => g.Failures),
            TotalTokens: games.Sum(g => g.TotalTokens),
            TotalCostUsd: totalCost,
            Budget: new AiBudgetDto(
                Unlimited: budget.IsUnlimited,
                Spent: verdict.Spent,
                Limit: verdict.Limit,
                Allowed: verdict.Allowed,
                ResetUtc: verdict.ResetUtc)));
    }

    /// <summary>Config key listing the operators (user object ids) who see the full AI usage report.</summary>
    internal const string AiUsageAdminsKey = "PoMiniGames:Diag:AiUsageAdmins";

    /// <summary>
    /// True when the caller may see cross-identity AI aggregates: a signed-in, non-guest identity
    /// whose object id is listed under <see cref="AiUsageAdminsKey"/>.
    /// </summary>
    /// <remarks>
    /// Object ids only. Sign-in accepts the multi-tenant <c>common</c> authority, so an email or
    /// <c>preferred_username</c> claim is not proof of owning that address, and an app-role claim
    /// can be granted by any tenant's own admin. An oid is assigned by Entra and cannot be chosen.
    /// </remarks>
    internal static bool IsAiUsageAdmin(ClaimsPrincipal user, IConfiguration configuration)
    {
        var identity = RequestIdentity.Resolve(user);
        if (!identity.IsAuthenticated)
            return false;

        var admins = configuration.GetSection(AiUsageAdminsKey).Get<string[]>() ?? [];
        return admins.Any(a => !string.IsNullOrWhiteSpace(a)
            && string.Equals(a.Trim(), identity.UserId, StringComparison.OrdinalIgnoreCase));
    }
}

/// <param name="Configured">False when no foundry endpoint is set; games serve mocks or fail.</param>
/// <param name="DefaultDeployment">Default deployment name; null when <paramref name="Aggregates"/> is false.</param>
/// <param name="Aggregates">True when the cross-identity fields (games, totals, deployment names) are filled in.
/// False for a signed-in non-operator outside Development: they get only their own budget.</param>
/// <param name="Games">Per-game counters for this process. Empty before the first call, and for non-operators.</param>
/// <param name="TotalCostUsd">Running USD total across every game in <see cref="Games"/>, at list prices.</param>
/// <param name="Budget">The calling identity's own daily token allowance.</param>
public sealed record AiUsageReportDto(
    bool Configured,
    string? Endpoint,
    string? DefaultDeployment,
    string? EmbeddingDeployment,
    bool Aggregates,
    IReadOnlyList<AiGameUsageDto> Games,
    long TotalCalls,
    long TotalFailures,
    long TotalTokens,
    double TotalCostUsd,
    AiBudgetDto Budget);

/// <param name="Game">Game key, or <c>embed:&lt;purpose&gt;</c> for an embedding workload.</param>
/// <param name="Failures">Calls that threw — timeouts, circuit-open, service errors.</param>
/// <param name="TotalCostUsd">Running USD total for this game, at <see cref="DeploymentPricing.Catalog"/> list prices.</param>
public sealed record AiGameUsageDto(
    string Game,
    string Deployment,
    long Calls,
    long Failures,
    long TotalTokens,
    long AverageTokens,
    long AverageLatencyMs,
    long InputTokens,
    long OutputTokens,
    double TotalCostUsd,
    double AverageCostUsd);

/// <param name="Unlimited">True when the daily ceiling is switched off.</param>
/// <param name="ResetUtc">Start of the next UTC day, when the allowance returns.</param>
public sealed record AiBudgetDto(
    bool Unlimited,
    long Spent,
    long Limit,
    bool Allowed,
    DateTimeOffset ResetUtc);

