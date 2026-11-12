using Serilog;
using Serilog.Events;
using Serilog.Exceptions;

namespace PoMiniGames.Infrastructure;

/// <summary>Configures Serilog structured logging for all environments.</summary>
internal static class LoggingExtensions
{
    public static WebApplicationBuilder AddPoMiniGamesLogging(this WebApplicationBuilder builder)
    {
        builder.Host.UseSerilog((context, services, configuration) =>
        {
            configuration
                .ReadFrom.Configuration(context.Configuration)
                .ReadFrom.Services(services)
                .Enrich.FromLogContext()
                .Enrich.WithExceptionDetails()
                .Enrich.WithEnvironmentName()
                .Enrich.WithMachineName()
                .Enrich.WithThreadId()
                .Enrich.WithProperty("Application", "PoMiniGames");

            if (context.HostingEnvironment.IsDevelopment() || context.HostingEnvironment.IsEnvironment("Test"))
            {
                var logsPath = Path.Combine(context.HostingEnvironment.ContentRootPath, "logs");
                Directory.CreateDirectory(logsPath);

                configuration
                    .WriteTo.File(
                        Path.Combine(logsPath, "pominigames-.log"),
                        formatProvider: System.Globalization.CultureInfo.InvariantCulture,
                        rollingInterval: RollingInterval.Day,
                        retainedFileCountLimit: 7,
                        shared: true,
                        flushToDiskInterval: TimeSpan.FromSeconds(1),
                        outputTemplate:
                            "[{Timestamp:yyyy-MM-dd HH:mm:ss.fff zzz} {Level:u3}] {Message:lj} {NewLine}{Exception}")
                    .WriteTo.Console(formatProvider: System.Globalization.CultureInfo.InvariantCulture, outputTemplate:
                        "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj} {NewLine}{Exception}");
            }
            else
            {
                // Console for container stdout capture.
                configuration.WriteTo.Console(formatProvider: System.Globalization.CultureInfo.InvariantCulture);
            }
        },
        // App Insights gets logs from ONE path: Serilog forwards every event to the registered
        // Microsoft.Extensions.Logging providers, and the only one left is OpenTelemetry's, added by
        // UseAzureMonitor (TelemetryExtensions clears the framework defaults so the console does not
        // print each line twice). No connection string means no OTel provider, so nothing is sent.
        writeToProviders: true);

        return builder;
    }

    public static IApplicationBuilder UsePoMiniGamesRequestLogging(this IApplicationBuilder app)
    {
        return app.UseSerilogRequestLogging(options =>
        {
            options.GetLevel = (httpContext, elapsed, ex) =>
            {
                if (ex is not null || httpContext.Response.StatusCode >= 500)
                {
                    return LogEventLevel.Error;
                }

                return LogEventLevel.Information;
            };

            options.EnrichDiagnosticContext = (diagnosticsContext, httpContext) =>
            {
                var userId = httpContext.User?.Identity?.IsAuthenticated == true
                    ? httpContext.User.Identity?.Name
                    : "anonymous";
                var correlationId = httpContext.TraceIdentifier;
                var sessionId = httpContext.Items[RequestLogContextMiddleware.SessionItemKey]?.ToString() ?? "none";

                diagnosticsContext.Set("UserId", userId ?? "anonymous");
                diagnosticsContext.Set("CorrelationId", correlationId);
                diagnosticsContext.Set("SessionId", sessionId);
                diagnosticsContext.Set("Environment", app.ApplicationServices
                    .GetRequiredService<IHostEnvironment>()
                    .EnvironmentName);
                diagnosticsContext.Set("RequestPath", httpContext.Request.Path.Value ?? string.Empty);
                diagnosticsContext.Set("RequestMethod", httpContext.Request.Method);
                diagnosticsContext.Set("StatusCode", httpContext.Response.StatusCode);
            };
        });
    }
}
