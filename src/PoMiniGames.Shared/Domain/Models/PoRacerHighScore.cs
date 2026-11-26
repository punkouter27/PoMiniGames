namespace PoMiniGames.Domain.Models;

/// <summary>
/// A single PoRacer high-score entry. Stored in Azure Table Storage via
/// <c>StorageService</c> using the same <c>HighScoreDescriptor</c> strategy
/// as MarbleRace and PoBrawl.
/// </summary>
public sealed class PoRacerHighScore
{
    public string PlayerName { get; set; } = string.Empty;
    /// <summary>Server-populated from the auth cookie (sub/oid). Empty for anonymous cookies.</summary>
    public string UserId { get; set; } = string.Empty;
    public string TrackId { get; set; } = "circuit";
    /// <summary>Best completed lap in seconds. Legacy storage column name is retained.</summary>
    public double TotalTimeSeconds { get; set; }
    public int FinalPosition { get; set; }
    public bool IsGuest { get; set; }
    public string Date { get; set; } = string.Empty;
    /// <summary>Lobby code the score came from. Diagnostic-only; not user-visible.</summary>
    public string GameCode { get; set; } = string.Empty;
}
