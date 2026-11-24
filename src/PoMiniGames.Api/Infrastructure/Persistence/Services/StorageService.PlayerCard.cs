using System.Text.RegularExpressions;
using Azure.Data.Tables;
using Microsoft.Extensions.Logging;
using PoMiniGames.Domain.Models;

namespace PoMiniGames.Infrastructure.Services;

public partial class StorageService
{
    private const string MatchHistoryTable = "MatchHistory";

    public async Task<PlayerCardDto> GetPlayerCardAsync(
        string owner, string? displayName = null, bool isGuest = true, CancellationToken ct = default)
    {
        var effectiveName = !string.IsNullOrWhiteSpace(displayName) ? displayName : owner;
        var initials = BuildInitials(effectiveName);

        var card = new PlayerCardDto
        {
            DisplayName = effectiveName,
            UserId = isGuest ? "" : owner,
            AccountKind = isGuest ? "guest" : "microsoft",
            Initials = initials,
            Mmr = OnlineMmrCalculator.SeedMmr,
            PeakMmr = OnlineMmrCalculator.SeedMmr,
            Tier = OnlineRankTier.Silver,
            TierName = "Silver",
            TierColorHex = "#c0c0c0",
            TierIcon = "🥈",
            TierProgress = 0.5,
            NextTierName = "Gold",
            NextTierMinMmr = 1300,
            Wins = 0,
            Losses = 0,
            Draws = 0,
            TotalMatches = 0,
            WinRate = 0.0,
            SignatureGame = "poracer",
            SignatureGameTitle = "PoRacer",
            SignatureGameIcon = "🏎️",
            RecentForm = [],
            CurrentStreak = 0,
            MemberSinceUtc = DateTimeOffset.UtcNow
        };

        if (!IsStorageAvailable())
        {
            return card;
        }

        try
        {
            var ownerKey = NormalizeOwnerKey(owner);
            var historyRows = new List<(string Game, string Outcome, DateTime PlayedAt)>();

            await foreach (var entity in Table(MatchHistoryTable).QueryAsync<TableEntity>(
                filter: $"PartitionKey eq '{ownerKey.Replace("'", "''")}'",
                maxPerPage: 500,
                cancellationToken: ct))
            {
                var mode = entity.GetString("Mode") ?? "";
                if (string.Equals(mode, "local-2p", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                var game = entity.GetString("Game") ?? "poracer";
                var outcome = (entity.GetString("Outcome") ?? "draw").Trim().ToLowerInvariant();
                var playedAt = entity.GetDateTime("PlayedAt") ?? entity.Timestamp?.UtcDateTime ?? DateTime.UtcNow;

                historyRows.Add((game, outcome, playedAt));
            }

            if (historyRows.Count == 0)
            {
                return card;
            }

            // Order chronologically to track MMR evolution
            var chrono = historyRows.OrderBy(r => r.PlayedAt).ToList();
            int mmr = OnlineMmrCalculator.SeedMmr;
            int peakMmr = mmr;
            int wins = 0, losses = 0, draws = 0;
            var gameWins = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            var gamePlayed = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);

            foreach (var match in chrono)
            {
                gamePlayed[match.Game] = gamePlayed.GetValueOrDefault(match.Game) + 1;

                if (match.Outcome == "win")
                {
                    wins++;
                    gameWins[match.Game] = gameWins.GetValueOrDefault(match.Game) + 1;
                    mmr += 16;
                }
                else if (match.Outcome == "loss")
                {
                    losses++;
                    mmr = Math.Max(0, mmr - 16);
                }
                else
                {
                    draws++;
                }

                peakMmr = Math.Max(peakMmr, mmr);
            }

            card.Mmr = mmr;
            card.PeakMmr = peakMmr;
            card.Wins = wins;
            card.Losses = losses;
            card.Draws = draws;
            card.TotalMatches = wins + losses + draws;
            card.WinRate = card.TotalMatches > 0 ? (double)wins / card.TotalMatches : 0.0;
            card.MemberSinceUtc = chrono.First().PlayedAt;

            // Signature Game
            var sig = gameWins.OrderByDescending(kv => kv.Value).FirstOrDefault().Key;
            if (string.IsNullOrEmpty(sig))
            {
                sig = gamePlayed.OrderByDescending(kv => kv.Value).FirstOrDefault().Key ?? "poracer";
            }
            card.SignatureGame = sig;
            card.SignatureGameTitle = OnlineMmrCalculator.ResolveGameTitle(sig);
            card.SignatureGameIcon = OnlineMmrCalculator.ResolveGameIcon(sig);

            // Recent 5-game form (most recent last for display)
            var recent5 = chrono.TakeLast(5).Select(r => r.Outcome).ToList();
            card.RecentForm = recent5;

            // Current streak (from most recent matches)
            int streak = 0;
            for (int i = chrono.Count - 1; i >= 0; i--)
            {
                var outc = chrono[i].Outcome;
                if (outc == "draw") break;
                if (streak == 0)
                {
                    streak = outc == "win" ? 1 : -1;
                }
                else if (streak > 0 && outc == "win")
                {
                    streak++;
                }
                else if (streak < 0 && outc == "loss")
                {
                    streak--;
                }
                else
                {
                    break;
                }
            }
            card.CurrentStreak = streak;

            // Tier info
            var tier = OnlineMmrCalculator.GetTier(mmr);
            var (name, color, icon, _, _) = OnlineMmrCalculator.GetTierInfo(tier);
            var (progress, nextName, nextMin) = OnlineMmrCalculator.GetTierProgress(mmr);

            card.Tier = tier;
            card.TierName = name;
            card.TierColorHex = color;
            card.TierIcon = icon;
            card.TierProgress = progress;
            card.NextTierName = nextName;
            card.NextTierMinMmr = nextMin;

            return card;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to load player card for owner {Owner}", owner);
            return card;
        }
    }

    public async Task<List<PlayerCardDto>> GetOnlineMmrLeaderboardAsync(int limit = 10, CancellationToken ct = default)
    {
        limit = Math.Clamp(limit, 1, 100);
        if (!IsStorageAvailable())
        {
            return [];
        }

        try
        {
            // Seed from PoBrawl live 1v1 ratings table + any known online player rows
            var brawlRatings = await GetPoBrawlPlayerRatingsAsync(limit);
            var list = new List<PlayerCardDto>();

            foreach (var b in brawlRatings)
            {
                var tier = OnlineMmrCalculator.GetTier(b.Elo);
                var (name, color, icon, _, _) = OnlineMmrCalculator.GetTierInfo(tier);
                var (progress, nextName, nextMin) = OnlineMmrCalculator.GetTierProgress(b.Elo);

                list.Add(new PlayerCardDto
                {
                    DisplayName = b.DisplayName,
                    UserId = b.PrincipalId,
                    AccountKind = "microsoft",
                    Initials = BuildInitials(b.DisplayName),
                    Mmr = b.Elo,
                    PeakMmr = b.Elo,
                    Tier = tier,
                    TierName = name,
                    TierColorHex = color,
                    TierIcon = icon,
                    TierProgress = progress,
                    NextTierName = nextName,
                    NextTierMinMmr = nextMin,
                    Wins = b.Wins,
                    Losses = b.Losses,
                    Draws = b.Draws,
                    TotalMatches = b.Matches,
                    WinRate = b.Matches > 0 ? (double)b.Wins / b.Matches : 0.0,
                    SignatureGame = "pobrawl",
                    SignatureGameTitle = "PoBrawl",
                    SignatureGameIcon = "🥊",
                    RecentForm = ["win"],
                    CurrentStreak = 1,
                    MemberSinceUtc = DateTimeOffset.UtcNow
                });
            }

            return list.OrderByDescending(c => c.Mmr).ThenByDescending(c => c.TotalMatches).Take(limit).ToList();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to query Online MMR leaderboard");
            return [];
        }
    }

    private static string NormalizeOwnerKey(string owner)
    {
        var s = (owner ?? string.Empty).Trim().ToLowerInvariant();
        s = Regex.Replace(s, @"[ -  /\\#?]", "_");
        if (string.IsNullOrEmpty(s)) s = "anonymous";
        return s.Length <= 200 ? s : s[..200];
    }

    private static string BuildInitials(string name)
    {
        if (string.IsNullOrWhiteSpace(name)) return "P";
        var parts = name.Split([' ', '-', '_'], StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 1)
        {
            // Three-letter arcade initials ("QAT") are the player's whole name here, so they are shown
            // whole; a longer single word is cut to its first two letters.
            return parts[0].Length <= 3 ? parts[0].ToUpperInvariant() : parts[0][..2].ToUpperInvariant();
        }
        return $"{char.ToUpperInvariant(parts[0][0])}{char.ToUpperInvariant(parts[^1][0])}";
    }
}
