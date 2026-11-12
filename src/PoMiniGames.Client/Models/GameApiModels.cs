using PoMiniGames.Shared.Dtos;

namespace PoMiniGamesClient.Models;

// ---------------------------------------------------------------------------
// PoFunQuiz
// ---------------------------------------------------------------------------

/// <summary>One ranked row on GET /api/funquiz/leaderboard. Mirrors the server's LeaderboardEntry.</summary>
public class FunQuizLeaderboardRow
{
    public string PlayerName { get; set; } = string.Empty;
    public int Score { get; set; }
    public int MaxStreak { get; set; }
    public string Category { get; set; } = "General";
    public DateTime DatePlayed { get; set; }
    public int Wins { get; set; }
    public int Losses { get; set; }
}

/// <summary>Body for POST /api/funquiz/leaderboard. The server overrides PlayerName
/// with the authenticated identity (email or anon-… marker); only Category + Score
/// are user-controllable. Score is clamped server-side to 0..10_000.</summary>
public class FunQuizLeaderboardSubmission
{
    public string Category { get; set; } = "General";
    public int Score { get; set; }
    public int MaxStreak { get; set; }
    public int Wins { get; set; }
    public int Losses { get; set; }
}

// Couple Quiz ranks on the shared PlayerStats board like the other win-rate games.
