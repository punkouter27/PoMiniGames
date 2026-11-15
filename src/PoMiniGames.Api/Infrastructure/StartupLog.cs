namespace PoMiniGames.Infrastructure;

/// <summary>Source-generated log messages for host startup: the configuration check and storage bootstrap.</summary>
public static partial class StartupLog
{
    [LoggerMessage(EventId = 6104, Level = LogLevel.Information,
        Message = "Startup secret validation passed for {Environment}")]
    public static partial void StartupValidationPassed(this ILogger logger, string environment);

    [LoggerMessage(EventId = 6105, Level = LogLevel.Critical,
        Message = "Required secrets are missing for environment {Environment}: {Missing}. The application will NOT start.")]
    public static partial void RequiredSecretsMissing(this ILogger logger, string environment, string missing);

    [LoggerMessage(EventId = 6106, Level = LogLevel.Warning,
        Message = "Required secrets are missing for environment {Environment}: {Missing}. Continuing because non-Production environments are allowed to run with missing secrets.")]
    public static partial void RequiredSecretsMissingNonProduction(this ILogger logger, string environment, string missing);

    [LoggerMessage(EventId = 6107, Level = LogLevel.Information,
        Message = "Startup secret validation skipped in Test environment")]
    public static partial void StartupValidationSkippedForTest(this ILogger logger);

    [LoggerMessage(EventId = 6110, Level = LogLevel.Warning,
        Message = "StorageInitializer reported an error; per-game tables/containers will be retried lazily on first use")]
    public static partial void StorageInitializerError(this ILogger logger, Exception ex);
}
