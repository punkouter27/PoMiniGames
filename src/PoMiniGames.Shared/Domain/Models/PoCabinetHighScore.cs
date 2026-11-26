namespace PoMiniGames.Domain.Models;

/// <summary>
/// A single PoCabinet high-score entry: a player's best lap of the circuit. The store keeps
/// one row per player in the circuit's own partition (<see cref="CircuitId"/>), so laps from
/// the tracks the game used to have never rank against it.
/// </summary>
public sealed class PoCabinetHighScore
{
    public string PlayerName { get; set; } = string.Empty;
    /// <summary>Server-populated from the auth cookie (sub/oid). Empty for guests.</summary>
    public string UserId { get; set; } = string.Empty;
    /// <summary>The one circuit's id (PoCabinetCatalog.DefaultTrackId, which Domain cannot see).</summary>
    public const string CircuitId = "grandprix";

    public string TrackId { get; set; } = CircuitId;
    /// <summary>Best completed lap in seconds.</summary>
    public double BestLapSeconds { get; set; }
    /// <summary>Final position in the race that produced the best lap (1..9).</summary>
    public int FinalPosition { get; set; }
    public bool IsGuest { get; set; }
    public string Date { get; set; } = string.Empty;
    /// <summary>Lobby / race code; diagnostic-only.</summary>
    public string GameCode { get; set; } = string.Empty;
}
