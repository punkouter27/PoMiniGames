using System.Diagnostics;
using System.Reflection;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using PoMiniGames.Serialization;
using PoMiniGames.Shared.Diagnostics;

namespace PoMiniGames.Features.Health;

/// <summary>
/// <c>GET /api/diag</c>: the data behind the friendly /diag page (HealthPage.razor).
/// </summary>
/// <remarks>
/// 2026-11-17: rebuilt to the fleet /diag standard. It used to be a developer configuration
/// dump (ports, application name, the Key Vault URI in Development) behind
/// FeatureFlags:EnableDiagnostics, so the page had nothing to show in production. It is now
/// always on and anonymous, and safe to be: it is the registered health checks' status and
/// latency, a configured/not-configured note per external service, the build date and the
/// environment name — never a connection string, key, URI, path, id or exception message
/// (an exception TYPE name at most). HealthEndpointTests pins that.
/// </remarks>
public static class DiagEndpoints
{
    private const int MaxLogFileBytes = 512 * 1024;       // 512 KB upper bound on a log-tail response.
    private const int MaxTailLines = 500;                  // Cap rows per call to keep the response bounded.

    /// <summary>What each registered health check is for, in plain English. Unknown checks get a generic line.</summary>
    private static readonly Dictionary<string, (string Name, string Purpose)> StoreNames = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Storage"] = ("Scores and leaderboards", "Azure Table Storage: high scores, ladders, ratings and player stats."),
        ["AzureTableStorage"] = ("Table storage connection", "A direct round trip to Azure Table Storage, the store every board reads."),
    };

    /// <summary>
    /// Build stamp of the running server, YYMMDD: the UTC date of the commit it was built from,
    /// stamped as <c>AssemblyMetadata("BuildVersion")</c> by PoBuildStamp in Directory.Build.props,
    /// the same value the client shows as <c>.po-version</c>.
    /// </summary>
    internal static string BuildVersion { get; } =
        typeof(DiagEndpoints).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
            .FirstOrDefault(a => a.Key == "BuildVersion")?.Value ?? "unknown";

    public static IEndpointRouteBuilder MapDiagEndpoints(this IEndpointRouteBuilder app)
    {
        var isDevelopment = app.ServiceProvider.GetRequiredService<IWebHostEnvironment>().IsDevelopment();

        async Task<IResult> diagHandler(HealthCheckService health, IConfiguration configuration, IWebHostEnvironment environment, CancellationToken ct)
        {
            var report = await BuildReportAsync(health, configuration, environment, ct);
            return Results.Json(report, DiagJsonContext.Default.DiagReport);
        }

        var diag = app.MapGroup("/api/diag").WithTags("Health");

        diag.MapGet("", diagHandler)
        .WithName("GetDiagnostics")
        .WithSummary("Plain status of the API, its stores and its services, for the /diag page (no secrets)")
        .Produces<DiagReport>(StatusCodes.Status200OK);

        // The same report at /api/diag/status: the first JSON endpoint the Tab developer
        // window (wwwroot/po-dev.html, Po standard) tries. Without it the 404 there, a JSON
        // problem response, was taken as the diagnostics source and showed no checks.
        diag.MapGet("/status", diagHandler)
        .WithName("GetDiagnosticsStatus")
        .WithSummary("Same report as /api/diag, at the path the developer window reads first")
        .Produces<DiagReport>(StatusCodes.Status200OK);

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

    /// <summary>Assembles the /api/diag report from the health checks and configuration presence.</summary>
    internal static async Task<DiagReport> BuildReportAsync(
        HealthCheckService health, IConfiguration configuration, IWebHostEnvironment environment, CancellationToken ct)
    {
        var started = Stopwatch.GetTimestamp();
        var report = await health.CheckHealthAsync(ct);

        var stores = report.Entries.Select(e =>
        {
            var (name, purpose) = StoreNames.TryGetValue(e.Key, out var known)
                ? known
                : (e.Key, "A dependency this app checks on every health probe.");
            return new DiagCheck(
                name,
                e.Value.Status.ToString(),
                purpose,
                Math.Round(e.Value.Duration.TotalMilliseconds, 1),
                // Type name only: an exception MESSAGE can carry a host name or a key.
                e.Value.Exception?.GetType().Name);
        }).ToList();

        static DiagCheck Configured(string name, bool configured, string purpose) =>
            new(name, configured ? "Healthy" : "Not configured",
                configured ? purpose : purpose + " Not used in this environment.", null, null);

        var services = new List<DiagCheck>
        {
            // Presence only: the vault's address is never echoed.
            Configured("Azure Key Vault", !string.IsNullOrWhiteSpace(configuration["KeyVault:Uri"]),
                "Holds the production secrets; read once at startup."),
            Configured("Application Insights",
                !string.IsNullOrWhiteSpace(configuration["ApplicationInsights:ConnectionString"])
                || !string.IsNullOrWhiteSpace(configuration["APPLICATIONINSIGHTS_CONNECTION_STRING"]),
                "Receives request telemetry and errors for troubleshooting."),
            new("Multiplayer hubs", "Healthy",
                "SignalR lobbies and matches; they run inside this server, so they are up whenever the API is.", null, null),
        };

        var overall = report.Status switch
        {
            HealthStatus.Unhealthy => "Unhealthy",
            HealthStatus.Degraded => "Degraded",
            _ => "Healthy",
        };

        return new DiagReport(
            overall,
            BuildVersion,
            environment.EnvironmentName,
            DateTimeOffset.UtcNow,
            Math.Round(Stopwatch.GetElapsedTime(started).TotalMilliseconds, 1),
            stores,
            services);
    }
}
