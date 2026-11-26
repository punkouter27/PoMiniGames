namespace PoMiniGames.Domain.Models;

/// <summary>A single PoBrawl fastest-KO entry. Lower KO time is better.</summary>
public sealed record PoBrawlHighScore
{
    public string PlayerInitials { get; init; } = string.Empty;
    public double KoTimeSeconds { get; init; }
    public string Character { get; init; } = string.Empty;
    public string Date { get; init; } = string.Empty;
}
