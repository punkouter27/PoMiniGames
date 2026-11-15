using PoMiniGames.Domain.Models;

namespace PoMiniGames.Domain.Abstractions;

/// <summary>
/// Unified storage abstraction for player stats and remaining per-game high score boards.
/// </summary>
public interface IStorageService
{
    // Player Stats
    IAsyncEnumerable<PlayerStatsDto> GetAllPlayerStatsAsync(CancellationToken cancellationToken = default);
    Task<PlayerStats?> GetPlayerStatsAsync(string game, string playerName);
    Task SavePlayerStatsAsync(string game, string playerName, PlayerStats stats);
    Task<List<(string Name, PlayerStats Stats)>> GetLeaderboardAsync(string game, int limit, string? difficulty = null);

    // `weekly` on a high-score read selects the current ISO week's board: every save to these
    // boards also lands in a per-week partition with the same one-best-row-per-player ratchet.

    // PoMarbleRace High Scores
    Task<List<MarbleRaceHighScore>> GetMarbleRaceHighScoresAsync(int limit = 10, bool weekly = false);
    Task<MarbleRaceHighScore> SaveMarbleRaceHighScoreAsync(MarbleRaceHighScore entry);

    // PoMarbleRace world records (fastest finish per map; one row per map)
    Task<List<MarbleRaceMapRecord>> GetMarbleRaceMapRecordsAsync();
    Task<MarbleRaceMapRecord> SaveMarbleRaceMapRecordAsync(MarbleRaceMapRecord entry);

    // PoMarbleRace Daily Canyon: one board per UTC day, each player's fastest finish that day.
    // `day` is a server-formatted yyyy-MM-dd (MarbleRaceDaily.TryDayKey).
    Task<List<MarbleRaceMapRecord>> GetMarbleRaceDailyTimesAsync(string day, int limit = 10);
    Task<MarbleRaceMapRecord> SaveMarbleRaceDailyTimeAsync(MarbleRaceMapRecord entry, string day);

    // PoBrawl High Scores (fastest KO)
    Task<List<PoBrawlHighScore>> GetPoBrawlHighScoresAsync(int limit = 10);
    Task<PoBrawlHighScore> SavePoBrawlHighScoreAsync(PoBrawlHighScore entry);

    // PoRacer High Scores (lowest race time wins)
    Task<List<PoRacerHighScore>> GetPoRacerHighScoresAsync(int limit = 10, string? trackId = null, bool weekly = false);
    Task<PoRacerHighScore> SavePoRacerHighScoreAsync(PoRacerHighScore entry);

    // PoBrawl presidents-ladder leaderboard (one row per player identity, best-ever progress)
    Task<List<PoBrawlLadderEntry>> GetPoBrawlLadderAsync(int limit = 10);

    /// <summary>
    /// Climbs <paramref name="userId"/>'s ladder row toward the claimed rung — at most one rung past
    /// what is stored, and never sooner than <paramref name="minRungInterval"/> after the last climb.
    /// Returns the row as stored afterwards and what the call did to it.
    /// </summary>
    Task<(PoBrawlLadderEntry Entry, PoBrawlLadderVerdict Verdict)> SavePoBrawlLadderAsync(
        string userId, PoBrawlLadderEntry entry, TimeSpan minRungInterval);

    // PoBrawl demo-mode fighter Elo (one row per fighter, head-to-head ratings)
    Task<List<PoBrawlFighterRating>> GetPoBrawlFighterRatingsAsync(int limit = 10);

    /// <summary>
    /// Records one CPU-vs-CPU demo match and moves both fighters' ratings. The server owns the
    /// Elo arithmetic — callers submit only who fought and who won.
    /// </summary>
    /// <param name="winnerFighterId">Winning fighter, or either side when <paramref name="isDraw"/>.</param>
    /// <param name="loserFighterId">Losing fighter, or the other side when <paramref name="isDraw"/>.</param>
    Task RecordPoBrawlDemoResultAsync(
        string winnerFighterId, string loserFighterId, bool isDraw);

    // ── PoBrawl online player Elo (one row per principal, head-to-head over SignalR) ──
    //
    // Deliberately separate from the demo fighter board — see PoBrawlPlayerRating's
    // remarks. The two share PairwiseEloCalculator for arithmetic but have nothing
    // else in common: different row key (principal vs fighter id), different display
    // name source, different sample population, different floor/seed policy.

    /// <summary>Top-ranked online players by head-to-head Elo.</summary>
    Task<List<PoBrawlPlayerRating>> GetPoBrawlPlayerRatingsAsync(int limit = 10);

    /// <summary>
    /// Records one online 1v1 match and moves both players' ratings. The Elo arithmetic
    /// runs through the same <see cref="Services.PairwiseEloCalculator"/> the demo board
    /// uses, so the two rating systems cannot drift in their definition of "win".
    /// </summary>
    /// <param name="winnerPrincipalId">Principal id of the winner; either side when <paramref name="isDraw"/>.</param>
    /// <param name="loserPrincipalId">Principal id of the loser; the other side when <paramref name="isDraw"/>.</param>
    /// <param name="winnerDisplayName">Display name for the winner's row (claim identity at submit time).</param>
    /// <param name="loserDisplayName">Display name for the loser's row.</param>
    /// <returns>True once both rows are written; false when storage is down or the pair-write failed
    /// (and was rolled back), so the caller can release its once-per-match claim and ask for a retry.</returns>
    Task<bool> RecordPoBrawlOnlineMatchAsync(
        string winnerPrincipalId, string loserPrincipalId,
        string winnerDisplayName, string loserDisplayName,
        bool isDraw);

    /// <summary>
    /// Computes or retrieves a player's dynamic online player card containing
    /// overall MMR, tier progression, win-rate, signature game, and recent form.
    /// </summary>
    Task<PlayerCardDto> GetPlayerCardAsync(
        string owner, string? displayName = null, bool isGuest = true, CancellationToken ct = default) =>
        Task.FromResult(new PlayerCardDto
        {
            DisplayName = displayName ?? owner,
            UserId = isGuest ? "" : owner,
            AccountKind = isGuest ? "guest" : "microsoft",
            Initials = string.IsNullOrWhiteSpace(displayName ?? owner) ? "P" : (displayName ?? owner).Substring(0, Math.Min(2, (displayName ?? owner).Length)).ToUpperInvariant()
        });

    /// <summary>Top-ranked online multiplayer players by global competitive MMR.</summary>
    Task<List<PlayerCardDto>> GetOnlineMmrLeaderboardAsync(int limit = 10, CancellationToken ct = default) =>
        Task.FromResult(new List<PlayerCardDto>());

    /// <summary>
    /// Bounded probe of the Table Storage backend. Returns <c>true</c> when the last attempt
    /// succeeded; <c>false</c> when storage is unreachable so the caller can render a
    /// "scores unavailable" state instead of letting an empty-list read mask the outage.
    /// </summary>
    bool IsStorageHealthy();

    // PoVoxelStrike High Scores (highest run score wins, one ratcheted row per player)
    // `day` (yyyy-MM-dd, server-formatted) selects that day's Daily Siege board instead.
    Task<List<PoVoxelStrikeHighScore>> GetPoVoxelStrikeHighScoresAsync(int limit = 10, string? day = null, bool weekly = false);
    Task<PoVoxelStrikeHighScore> SavePoVoxelStrikeHighScoreAsync(PoVoxelStrikeHighScore entry, string? day = null);

    // PoMule High Scores (highest end-of-match Net Worth wins, one ratcheted row per player)
    Task<List<PoMuleHighScore>> GetPoMuleHighScoresAsync(int limit = 10, bool weekly = false);
    Task<PoMuleHighScore> SavePoMuleHighScoreAsync(PoMuleHighScore entry);

    // PoCabinet High Scores (lowest best-lap wins, partitioned by TrackId)
    Task<List<PoCabinetHighScore>> GetPoCabinetHighScoresAsync(int limit = 10, string? trackId = null);
    Task<PoCabinetHighScore> SavePoCabinetHighScoreAsync(PoCabinetHighScore entry);
}
