namespace PoMiniGames.Domain.Models;

/// <summary>
/// Statistics for a specific difficulty level.
/// </summary>
public sealed class DifficultyStats
{
    public int Wins { get; set; }
    public int Losses { get; set; }
    public int Draws { get; set; }
    public int TotalGames { get; set; }
    public int WinStreak { get; set; }

    /// <summary>Computed win rate - no need to store.</summary>
    public double WinRate => TotalGames > 0 ? (double)Wins / TotalGames : 0;

    /// <summary>
    /// ELO-style performance rating for this difficulty tier. Computed server-side
    /// on every save and backfilled on leaderboard reads for legacy records.
    /// Starts at 1000; beats against harder AI tiers yield larger gains.
    /// </summary>
    public int EloRating { get; set; }
}

/// <summary>
/// Player statistics stored in Azure Table Storage.
/// </summary>
public sealed class PlayerStats
{
    public string PlayerId { get; set; } = string.Empty;
    public string PlayerName { get; set; } = string.Empty;
    public DifficultyStats Easy { get; set; } = new();
    public DifficultyStats Medium { get; set; } = new();
    public DifficultyStats Hard { get; set; } = new();

    // Aggregate computed properties
    public int TotalWins => Easy.Wins + Medium.Wins + Hard.Wins;
    public int TotalLosses => Easy.Losses + Medium.Losses + Hard.Losses;
    public int TotalDraws => Easy.Draws + Medium.Draws + Hard.Draws;
    public int TotalGames => Easy.TotalGames + Medium.TotalGames + Hard.TotalGames;
    public double WinRate => TotalGames > 0 ? (double)TotalWins / TotalGames : 0;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
