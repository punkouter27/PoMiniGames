using Azure;
using Azure.Data.Tables;
using Azure.Identity;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Configuration;

namespace PoMiniGames.Infrastructure.HealthChecks;

/// <summary>
/// Optional health check for Azure Table Storage or Azurite-backed table endpoints.
/// Uses a short timeout so the health endpoint responds quickly when storage is unreachable.
/// </summary>
public sealed class AzureTableStorageHealthCheck : IHealthCheck
{
    private readonly IConfiguration _configuration;
    private static readonly TimeSpan s_timeout = TimeSpan.FromMilliseconds(500);

    public AzureTableStorageHealthCheck(IConfiguration configuration)
    {
        _configuration = configuration;
    }

    public async Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context,
        CancellationToken cancellationToken = default)
    {
        var tableName = _configuration["PoMiniGames:Storage:TableService:TableName"] ?? "pominigameshealth";
        var connectionString = _configuration["PoMiniGames:Storage:TableService:ConnectionString"];
        var endpoint = _configuration["PoMiniGames:Storage:TableService:Endpoint"];
        var accountName = _configuration["PoMiniGames:Storage:TableService:AccountName"];

        if (string.IsNullOrWhiteSpace(connectionString) && string.IsNullOrWhiteSpace(endpoint) && string.IsNullOrWhiteSpace(accountName))
        {
            return HealthCheckResult.Healthy("Table storage is not configured for this environment.");
        }

        try
        {
            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeoutCts.CancelAfter(s_timeout);

            TableServiceClient serviceClient;

            if (!string.IsNullOrWhiteSpace(connectionString))
            {
                serviceClient = new TableServiceClient(connectionString);
            }
            else
            {
                var serviceUri = !string.IsNullOrWhiteSpace(endpoint)
                    ? new Uri(endpoint)
                    : new Uri($"https://{accountName}.table.core.windows.net");
                serviceClient = new TableServiceClient(serviceUri, new DefaultAzureCredential());
            }

            var tableClient = serviceClient.GetTableClient(tableName);
            await tableClient.CreateIfNotExistsAsync(cancellationToken: timeoutCts.Token);

            await foreach (var _ in tableClient.QueryAsync<TableEntity>(
                filter: "PartitionKey eq '__healthcheck__'", maxPerPage: 1,
                cancellationToken: timeoutCts.Token))
            {
                break;
            }

            return HealthCheckResult.Healthy("Table storage is reachable.");
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return HealthCheckResult.Degraded("Table storage timed out (not reachable within 500ms).");
        }
        catch (Exception ex)
        {
            return HealthCheckResult.Degraded("Table storage is unavailable.", ex);
        }
    }
}
