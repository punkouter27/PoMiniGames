// Wire shapes that are identical on both sides are the Domain types themselves, not
// hand-kept mirrors: a renamed server field then fails to compile here instead of
// deserializing as null. Aliased globally because PoMiniGames.Domain.Models also declares
// a PlayerStats, so importing that namespace wholesale is ambiguous with the client one.
global using GameLeaderboardDto = PoMiniGames.Domain.Models.GameLeaderboardDto;
global using LeaderboardEntryDto = PoMiniGames.Domain.Models.LeaderboardEntryDto;
global using MarbleRaceHighScore = PoMiniGames.Domain.Models.MarbleRaceHighScore;
global using PoBrawlDemoResultRequest = PoMiniGames.Domain.Models.PoBrawlDemoResultRequest;
global using PoBrawlHighScore = PoMiniGames.Domain.Models.PoBrawlHighScore;
global using PoBrawlLadderEntry = PoMiniGames.Domain.Models.PoBrawlLadderEntry;

namespace PoMiniGamesClient.Models;

public class DifficultyStats
{
    public int Wins { get; set; }
    public int Losses { get; set; }
    public int Draws { get; set; }
    public int TotalGames => Wins + Losses + Draws;
    public int WinStreak { get; set; }
    public double WinRate => TotalGames > 0 ? (double)Wins / TotalGames : 0;
    public int EloRating { get; set; } = 1000;
}

public class PlayerStats
{
    public string PlayerId { get; set; } = "";
    public string PlayerName { get; set; } = "";
    public DifficultyStats Easy { get; set; } = new();
    public DifficultyStats Medium { get; set; } = new();
    public DifficultyStats Hard { get; set; } = new();
    public int TotalWins => Easy.Wins + Medium.Wins + Hard.Wins;
    public int TotalLosses => Easy.Losses + Medium.Losses + Hard.Losses;
    public int TotalDraws => Easy.Draws + Medium.Draws + Hard.Draws;
    public int TotalGames => TotalWins + TotalLosses + TotalDraws;
    public double WinRate => TotalGames > 0 ? (double)TotalWins / TotalGames : 0;
}

public class StatItem
{
    public string Value { get; set; } = "";
    public string Label { get; set; } = "";
}

/// <summary>
/// Single adaptive skill rating for a 1-player game (e.g. Connect Five vs CPU).
/// Replaces the fixed Easy/Medium/Hard buckets: the CPU is matched to the
/// player's current <see cref="Elo"/> each game, so a win raises the rating (and
/// the next CPU is tougher) while a loss lowers it (next CPU is easier). Stored
/// locally per player.
/// </summary>
public class AdaptiveRating
{
    public const int StartingElo = 1200;

    public string PlayerName { get; set; } = "";
    public int Elo { get; set; } = StartingElo;
    public int Peak { get; set; } = StartingElo;
    public int Wins { get; set; }
    public int Losses { get; set; }
    public int Draws { get; set; }
    /// <summary>Current consecutive win streak (reset on loss/draw). Surfaced
    /// in the Profile alongside the Easy/Medium/Hard bucket streaks.</summary>
    public int WinStreak { get; set; }

    public int TotalGames => Wins + Losses + Draws;
    public double WinRate => TotalGames > 0 ? (double)Wins / TotalGames : 0;
}

public class WinResult
{
    public bool Won { get; set; }
    public List<(int Row, int Col)> Cells { get; set; } = new();
}

public class PlayerStatsDto
{
    public string Name { get; set; } = "";
    public string Game { get; set; } = "";
    public PlayerStats Stats { get; set; } = new();
}

/// <summary>
/// PoCabinet: a finished race for <c>POST /api/pocabinet/scores</c>. Identity (name, user id,
/// guest) is resolved server-side from the auth cookie, so the payload has no field an attacker
/// could vary to insert duplicate rows.
/// </summary>
/// <param name="Inputs">Solo lap proof: the base64 per-tick control log from
/// <c>PoCabinet.lapProof()</c>, which the server re-simulates to time the lap and place itself.
/// Null for a multiplayer race — the server's own sim already timed it.</param>
/// <param name="Wet">Solo lap proof: the race ran in rain (lower grip).</param>
public sealed record PoCabinetHighScoreRequest(
    string TrackId,
    double BestLapSeconds,
    int FinalPosition,
    string GameCode = "",
    string? Inputs = null,
    bool Wet = false);

// PoVoxelStrike board rows use PoMiniGames.Domain.Models.PoVoxelStrikeHighScore directly — the client
// references that assembly, so a hand-kept mirror only bought silent drift: a renamed
// server field still deserialized, just as null.

// Other boards follow the same rule: PoMiniGames.Domain.Models.PoVoxelStrikeHighScore
// directly. The submission below is a client mirror of the API slice's wire shape
// (PoVoxelStrikeRunRequest in Features/PoVoxelStrike) — identity and timestamp are
// server-derived, so there is no field here to forge them in.
public sealed record PoVoxelStrikeRunRequest(
    int Score, double SurvivalSeconds, int Kills, int BruteKills, int CrushKills, int VoxelsDestroyed,
    bool Won = false, string? Day = null);

// PoMule board rows use PoMiniGames.Domain.Models.PoMuleHighScore directly. This is the
// client mirror of the API slice's PoMuleRunRequest; Species is the roster index.
// Seed, Classic and Log let the server replay the match (PoMuleReplay); a client that sends no
// log is range-checked only.
public sealed record PoMuleRunRequest(int NetWorth, int Species, bool ColonySurvived,
    ulong? Seed = null, bool Classic = false, string? Log = null);


/// <summary>
/// Queued PlayerStats PUT for the offline score-sync pipeline: a stats snapshot
/// that failed to reach the server is parked and replayed by ScoreSyncService.
/// </summary>
public class PendingPlayerStats
{
    public string GameKey { get; set; } = "";
    public string PlayerName { get; set; } = "";
    public PlayerStats Stats { get; set; } = new();
}
