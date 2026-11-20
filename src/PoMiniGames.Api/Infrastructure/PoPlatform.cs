using System.Diagnostics;
using System.Reflection;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;

namespace PoMiniGames.Infrastructure;

/// <summary>
/// This app's platform conventions (Po web standard, AGENTS.md): app name, App Insights key spellings, cookie
/// names, the build version and the <c>/health/live</c> probe. This repo owns the file; change it freely.
/// </summary>
public static class PoPlatform
{
    /// <summary>This app's name, used as the log property, the cookie stem and the liveness label.</summary>
    public const string AppName = "PoMiniGames";

    /// <summary>
    /// Serilog property carrying the app identity.
    /// </summary>
    public const string ApplicationProperty = "Application";

    /// <summary>
    /// Resolves the Application Insights connection string, accepting every spelling that was in
    /// in use, so an existing deployment keeps working while the App Settings are migrated to the
    /// canonical key.
    /// </summary>
    /// <remarks>
    /// Canonical: <c>ApplicationInsights:ConnectionString</c> (App Setting
    /// <c>ApplicationInsights__ConnectionString</c>). The bare environment-variable spelling is the
    /// one the Azure Monitor SDK reads on its own; it is accepted here so a manually-configured app
    /// resolves identically to a bicep-configured one. An instrumentation key is upgraded to a
    /// connection string rather than ignored.
    /// </remarks>
    public static string? ResolveAppInsightsConnectionString(IConfiguration configuration)
    {
        var connectionString =
            configuration["ApplicationInsights:ConnectionString"]
            ?? configuration["APPLICATIONINSIGHTS_CONNECTION_STRING"];

        if (!string.IsNullOrWhiteSpace(connectionString))
        {
            return connectionString;
        }

        var instrumentationKey =
            configuration["ApplicationInsights:InstrumentationKey"]
            ?? configuration["APPINSIGHTS_INSTRUMENTATIONKEY"];

        return string.IsNullOrWhiteSpace(instrumentationKey)
            ? null
            : $"InstrumentationKey={instrumentationKey}";
    }

    /// <summary>
    /// Session cookie name. The <c>__Host-</c> prefix is a browser-enforced control: the cookie is
    /// locked to this exact host, must be Secure, and must have Path=/ - it cannot be overwritten by
    /// a subdomain or a network attacker.
    /// </summary>
    /// <param name="secure">
    /// Whether the cookie will actually be issued Secure. The prefix is REJECTED outright over plain
    /// HTTP, so applying it unconditionally would silently drop the session on every local http://
    /// run and every Playwright suite. Pass the same condition used for <c>Cookie.SecurePolicy</c>.
    /// </param>
    public static string SessionCookieName(bool secure) =>
        secure ? $"__Host-{AppName}.Auth" : $"{AppName}.Auth";

    /// <summary>Antiforgery cookie name, following the same prefix rule.</summary>
    public static string AntiforgeryCookieName(bool secure) =>
        secure ? $"__Host-{AppName}.Antiforgery" : $"{AppName}.Antiforgery";

    /// <summary>The build version, UTC yyMMdd: the one <c>BuildVersion</c> assembly metadata key (Directory.Build.props).</summary>
    public static string Version { get; } =
        typeof(PoPlatform).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
            .FirstOrDefault(a => a.Key == "BuildVersion")?.Value
        ?? "dev";

    /// <summary>
    /// Maps <c>/health/live</c>: the dependency-free liveness probe (the deploy checks its <c>X-Commit</c> header).
    /// </summary>
    /// <remarks>
    /// Separate from <c>/health</c> on purpose. <c>/health</c> is a DEEP probe whose payload is
    /// app-specific (it names that app's own dependencies) and expensive to poll. This one touches
    /// nothing and cannot fail on a dependency outage.
    /// </remarks>
    public static IEndpointRouteBuilder MapPoLiveness(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/health/live", () => Results.Ok(new
        {
            status = "ok",
            app = AppName,
            version = Version,
            utc = DateTimeOffset.UtcNow,
        }))
        .WithName("PoLiveness")
        .WithTags("Health")
        .AllowAnonymous();

        return endpoints;
    }

    /// <summary>Stamps the person's id onto the current activity, if there is one.</summary>
    /// <remarks>
    /// The Azure Monitor exporter maps <c>enduser.id</c> onto <c>user_AuthenticatedId</c>, which is
    /// what makes every request, dependency and exception in the operation attributable to a person
    /// rather than only the first-visit record.
    /// </remarks>
    public static void TagEndUser(string? userId)
    {
        if (!string.IsNullOrWhiteSpace(userId))
        {
            Activity.Current?.SetTag("enduser.id", userId);
        }
    }
}
