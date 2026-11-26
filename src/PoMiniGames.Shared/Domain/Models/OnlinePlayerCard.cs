using System.Globalization;

namespace PoMiniGames.Domain.Models;

/// <summary>
/// Competitive skill tier for online multiplayer games.
/// </summary>
public enum OnlineRankTier
{
    Bronze = 0,
    Silver = 1,
    Gold = 2,
    Platinum = 3,
    Diamond = 4,
    Master = 5
}

/// <summary>
/// Normalized player card payload for dynamic vector cards, profile showcases,
/// and online multiplayer match inspect.
/// </summary>
public sealed class PlayerCardDto
{
    public string DisplayName { get; set; } = "";
    public string UserId { get; set; } = "";
    public string AccountKind { get; set; } = "guest";
    public string Initials { get; set; } = "P";
    public int Mmr { get; set; } = OnlineMmrCalculator.SeedMmr;
    public int PeakMmr { get; set; } = OnlineMmrCalculator.SeedMmr;
    public OnlineRankTier Tier { get; set; } = OnlineRankTier.Silver;
    public string TierName { get; set; } = "Silver";
    public string TierColorHex { get; set; } = "#c0c0c0";
    public string TierIcon { get; set; } = "🥈";
    public double TierProgress { get; set; } = 0.5;
    public string? NextTierName { get; set; } = "Gold";
    public int? NextTierMinMmr { get; set; } = 1300;
    public int Wins { get; set; }
    public int Losses { get; set; }
    public int Draws { get; set; }
    public int TotalMatches { get; set; }
    public double WinRate { get; set; }
    public string SignatureGame { get; set; } = "poracer";
    public string SignatureGameTitle { get; set; } = "PoRacer";
    public string SignatureGameIcon { get; set; } = "🏎️";
    public List<string> RecentForm { get; set; } = [];
    public int CurrentStreak { get; set; }
    public DateTimeOffset MemberSinceUtc { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>
/// Pure deterministic calculation helpers for online matchmaking ratings (MMR),
/// skill tier progression, and competitive rank boundaries.
/// </summary>
public static class OnlineMmrCalculator
{
    public const int SeedMmr = 1200;
    public const int KFactor = 32;

    public static OnlineRankTier GetTier(int mmr) => mmr switch
    {
        < 1100 => OnlineRankTier.Bronze,
        < 1300 => OnlineRankTier.Silver,
        < 1500 => OnlineRankTier.Gold,
        < 1700 => OnlineRankTier.Platinum,
        < 1900 => OnlineRankTier.Diamond,
        _ => OnlineRankTier.Master
    };

    public static (string Name, string ColorHex, string Icon, int MinMmr, int MaxMmr) GetTierInfo(OnlineRankTier tier) => tier switch
    {
        OnlineRankTier.Bronze => ("Bronze", "#cd7f32", "🥉", 0, 1099),
        OnlineRankTier.Silver => ("Silver", "#c0c0c0", "🥈", 1100, 1299),
        OnlineRankTier.Gold => ("Gold", "#ffd700", "🥇", 1300, 1499),
        OnlineRankTier.Platinum => ("Platinum", "#00e5ff", "💠", 1500, 1699),
        OnlineRankTier.Diamond => ("Diamond", "#b967ff", "💎", 1700, 1899),
        OnlineRankTier.Master => ("Master", "#ff0055", "👑", 1900, 3000),
        _ => ("Unranked", "#888888", "⚪", 0, 0)
    };

    public static (double Progress, string? NextTierName, int? NextTierMinMmr) GetTierProgress(int mmr)
    {
        var tier = GetTier(mmr);
        var info = GetTierInfo(tier);

        if (tier == OnlineRankTier.Master)
        {
            return (1.0, null, null);
        }

        var nextTier = (OnlineRankTier)((int)tier + 1);
        var nextInfo = GetTierInfo(nextTier);

        int range = nextInfo.MinMmr - info.MinMmr;
        int current = mmr - info.MinMmr;
        double progress = range > 0 ? Math.Clamp((double)current / range, 0.0, 1.0) : 1.0;

        return (progress, nextInfo.Name, nextInfo.MinMmr);
    }

    public static int ComputeOutcomeDelta(int playerMmr, int opponentMmr, string outcome)
    {
        double expected = 1.0 / (1.0 + Math.Pow(10.0, (opponentMmr - playerMmr) / 400.0));
        double actual = outcome.Trim().ToLowerInvariant() switch
        {
            "win" => 1.0,
            "draw" => 0.5,
            _ => 0.0
        };

        int delta = (int)Math.Round(KFactor * (actual - expected));
        if (delta == 0 && actual == 1.0) delta = 1;
        if (delta == 0 && actual == 0.0) delta = -1;
        return delta;
    }

    public static string ResolveGameTitle(string gameKey) => (gameKey ?? "").Trim().ToLowerInvariant() switch
    {
        "poracer" => "PoRacer",
        "pobrawl" => "PoBrawl",
        "connectfive" => "Connect Five",
        "tictactoe" => "Tic-Tac-Toe",
        "pofunquiz" => "Fun Quiz",
        "pocouplequiz" => "Couple Quiz",
        "pomarblerace" => "Marble Race",
        "povoxelstrike" => "Voxel Strike",
        _ => CultureInfo.InvariantCulture.TextInfo.ToTitleCase(gameKey ?? "Game")
    };

    public static string ResolveGameIcon(string gameKey) => (gameKey ?? "").Trim().ToLowerInvariant() switch
    {
        "poracer" => "🏎️",
        "pobrawl" => "🥊",
        "connectfive" => "🔴",
        "tictactoe" => "❌",
        "pofunquiz" => "💡",
        "pocouplequiz" => "❤️",
        "pomarblerace" => "🔮",
        "povoxelstrike" => "🧱",
        _ => "🎮"
    };
}

