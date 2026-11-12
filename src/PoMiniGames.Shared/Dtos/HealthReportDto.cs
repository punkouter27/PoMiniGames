namespace PoMiniGames.Shared.Dtos;

/// <summary>
/// Client-side view of the <c>GET /api/health</c> report.
/// </summary>
public sealed record HealthReportDto(string Status, IReadOnlyList<HealthCheckEntryDto> Checks)
{
    public IReadOnlyList<HealthCheckEntryDto> Checks { get; init; } = Checks ?? [];
}

/// <summary>One dependency's entry in the health report.</summary>
public sealed record HealthCheckEntryDto(
    string Name,
    string Status,
    string? Description,
    double Duration);
