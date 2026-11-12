using System.Globalization;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Options;
using PoMiniGames.Domain.Abstractions;
using PoMiniGames.Features.Auth;
using PoMiniGames.Infrastructure;
using PoMiniGames.Serialization;

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
            var raw = await diagnosticsProvider.BuildSnapshotAsync(CancellationToken.None);
            var projection = ProjectDiagnostics(raw, configuration, environment);
            var json = JsonSerializer.SerializeToUtf8Bytes(projection, DiagJsonContext.Default.DiagResponse);
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
            var dict = raw as IDictionary<string, object?> ?? new Dictionary<string, object?>();

            string Get(params string[] path)
            {
                object? cur = dict;
                foreach (var key in path)
                {
                    if (cur is not IDictionary<string, object?> nested || !nested.TryGetValue(key, out cur))
                        return string.Empty;
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
            var integrations = new List<DiagIntegration>();

            if (dict.TryGetValue("integrations", out var integObj)
                && integObj is IDictionary<string, object?> configured)
            {
                foreach (var (name, value) in configured)
                {
                    var status = value switch
                    {
                        bool b => b ? "configured" : "not-configured",
                        null => "not-configured",
                        _ => value.ToString() ?? "unknown"
                    };
                    integrations.Add(new DiagIntegration(name, status, null));
                }
            }
            else if (integObj is IEnumerable<object?> items)
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
}
