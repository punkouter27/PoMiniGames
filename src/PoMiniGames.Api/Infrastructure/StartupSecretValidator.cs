using Microsoft.Extensions.Hosting;
using PoMiniGames.Features.Auth;

namespace PoMiniGames.Infrastructure;

/// <summary>
/// Hosted service that runs once at startup and validates that the secrets required for every
/// consolidated game (PoCoupleQuiz, PoFunQuiz) are present. This is the fail-fast
/// guard so a misconfigured production deployment never silently serves mock/fallback data
/// to real players.
/// </summary>
/// <remarks>Validates platform-level secrets (Key Vault, Table Storage).</remarks>
public sealed class StartupSecretValidator : IHostedService
{
    private readonly IHostEnvironment _environment;
    private readonly IConfiguration _configuration;
    private readonly ILogger<StartupSecretValidator> _logger;

    public StartupSecretValidator(
        IHostEnvironment environment,
        IConfiguration configuration,
        ILogger<StartupSecretValidator> logger)
    {
        _environment = environment;
        _configuration = configuration;
        _logger = logger;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        // Test environment uses mock services (registered by feature-specific wiring) — skip.
        if (_environment.IsEnvironment("Test"))
        {
            _logger.StartupValidationSkippedForTest();
            return Task.CompletedTask;
        }

        var missing = new List<string>();

        if (_environment.IsProduction())
        {
            var kvUri = _configuration["PoMiniGames:KeyVault:Uri"] ?? _configuration["KeyVault:Uri"];
            if (string.IsNullOrWhiteSpace(kvUri))
            {
                missing.Add("PoMiniGames:KeyVault:Uri");
            }

            var storageEndpoint = _configuration["PoMiniGames:Storage:TableService:Endpoint"]
                ?? _configuration["PoMiniGames:Storage:TableService:ConnectionString"];
            if (string.IsNullOrWhiteSpace(storageEndpoint))
            {
                missing.Add("PoMiniGames:Storage:TableService:Endpoint");
            }
        }

        if (missing.Count == 0)
        {
            _logger.StartupValidationPassed(_environment.EnvironmentName);
            return Task.CompletedTask;
        }

        var joined = string.Join(", ", missing);
        var message = $"Required secrets are missing for environment '{_environment.EnvironmentName}': {joined}";

        if (_environment.IsProduction())
        {
            _logger.RequiredSecretsMissing(_environment.EnvironmentName, joined);
            throw new InvalidOperationException(message);
        }

        _logger.RequiredSecretsMissingNonProduction(_environment.EnvironmentName, joined);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
