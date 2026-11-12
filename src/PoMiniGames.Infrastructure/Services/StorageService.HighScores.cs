using System.Text.Json;
using System.Runtime.CompilerServices;
using Azure;
using Azure.Data.Tables;
using Azure.Identity;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PoMiniGames.Domain.Models;
using PoMiniGames.Domain.Abstractions;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Domain.Services;
using PoMiniGames.Infrastructure.Storage;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Infrastructure.Services;

/// <summary>
/// The descriptor-driven high-score boards: one <see cref="HighScoreDescriptor{T}"/> per game
/// plus the single generic read/write flow every one of them shares.
/// </summary>
/// <remarks>
/// These boards are best-result ratchets expressible as a descriptor, whereas the PoBrawl
/// ladder and fighter Elo in StorageService.PoBrawl.cs are accumulators that a descriptor
/// cannot describe.
/// To add a leaderboard, add a descriptor here — declare RowKeyFields as immutable identity
/// fields only (usually the player, not the score) and use ShouldOverwrite so a worse later
/// run cannot clobber a better one.
/// </remarks>
public partial class StorageService
{
    // ── High scores ───────────────────────────────────────────────────────
    // Each game is one descriptor; the save/get flow below is shared by all of them.

    private static readonly HighScoreDescriptor<MarbleRaceHighScore> MarbleRaceScores = new(
        Table: MarbleRaceTable,
        Partition: MarbleRacePartition,
        Sanitize: e => e with
        {
            // One identity across boards: full display name (legacy rows hold initials).
            PlayerInitials = DisplayName24(e.PlayerInitials),
            UserId = e.UserId ?? "",
            BestScore = MarbleRaceScore.Clamp(e.BestScore),
            AchievedAtUtc = e.AchievedAtUtc == default ? DateTimeOffset.UtcNow : e.AchievedAtUtc,
        },
        ToFields: e => new Dictionary<string, object?>
        {
            ["PlayerInitials"] = e.PlayerInitials,
            ["UserId"] = e.UserId,
            ["IsGuest"] = e.IsGuest,
            ["BestScore"] = e.BestScore,
            // Stored as an ISO-8601 string, not a native DateTimeOffset: legacy rows wrote a
            // string, and a column holding both types breaks GetString on read.
            ["Date"] = e.AchievedAtUtc.ToString("yyyy-MM-ddTHH:mm:ssZ", System.Globalization.CultureInfo.InvariantCulture),
        },
        FromEntity: e => new MarbleRaceHighScore
        {
            PlayerInitials = e.GetString("PlayerInitials") ?? "",
            // Legacy rows predate identity columns: no UserId means it can't be attributed to a
            // real account, so it reads back as a guest row.
            UserId = e.GetString("UserId") ?? "",
            IsGuest = e.GetBoolean("IsGuest") ?? true,
            BestScore = e.GetInt32("BestScore") ?? 0,
            AchievedAtUtc = DateTimeOffset.TryParse(e.GetString("Date"), out var d) ? d : default,
        },
        // Identity is the player — (UserId, IsGuest) rather than the display name, so a guest
        // can't write onto a signed-in player's row by copying their name. Deliberately NOT
        // keyed on BestScore: the client submits on every new personal best, so a session that
        // scored 10 would post 1,2,3…10 and mint ten rows, letting one player fill a board that
        // ranks "highest score wins". One row per player, ratcheted by ShouldOverwrite below.
        RowKeyFields: ["PlayerInitials", "UserId", "IsGuest"],
        // Highest score wins, oldest first as the tiebreaker.
        Rank: s => s.OrderByDescending(x => x.BestScore).ThenBy(x => x.AchievedAtUtc))
    {
        // One row per player means every submission targets the same row, so a later, worse run
        // would otherwise erase a better one. Mirrors the PoBrawl ladder's ratchet.
        ShouldOverwrite = (existing, incoming) =>
            (incoming.TryGetValue("BestScore", out var v) ? v as int? ?? 0 : 0) > (existing.GetInt32("BestScore") ?? -1),
    };

    // World record per PoMarbleRace map: the row IS the map (RowKey = MapId), and only a faster
    // finish replaces it — the same ratchet as the player boards, keyed on the map instead.
    private static readonly HighScoreDescriptor<MarbleRaceMapRecord> MarbleRaceRecords = new(
        Table: MarbleRaceRecordsTable,
        Partition: MarbleRacePartition,
        Sanitize: e => e with
        {
            PlayerName = DisplayName24(e.PlayerName),
            UserId = e.UserId ?? "",
            Seconds = Math.Clamp(e.Seconds, 0, 180),
            AchievedAtUtc = e.AchievedAtUtc == default ? DateTimeOffset.UtcNow : e.AchievedAtUtc,
        },
        ToFields: e => new Dictionary<string, object?>
        {
            ["MapId"] = e.MapId,
            ["Seconds"] = e.Seconds,
            ["PlayerName"] = e.PlayerName,
            ["UserId"] = e.UserId,
            ["IsGuest"] = e.IsGuest,
            ["Date"] = e.AchievedAtUtc.ToString("yyyy-MM-ddTHH:mm:ssZ", System.Globalization.CultureInfo.InvariantCulture),
        },
        FromEntity: e => new MarbleRaceMapRecord
        {
            MapId = e.GetInt32("MapId") ?? 0,
            Seconds = e.GetDouble("Seconds") ?? 0d,
            PlayerName = e.GetString("PlayerName") ?? "",
            UserId = e.GetString("UserId") ?? "",
            IsGuest = e.GetBoolean("IsGuest") ?? true,
            AchievedAtUtc = DateTimeOffset.TryParse(e.GetString("Date"), out var d) ? d : default,
        },
        RowKeyFields: ["MapId"],
        Rank: s => s.OrderBy(x => x.MapId))
    {
        // A record set before its course was rebuilt is replaced by any finish on the new course.
        ShouldOverwrite = (existing, incoming) =>
            IsStaleMarbleRaceRecord(existing.GetInt32("MapId") ?? 0,
                DateTimeOffset.TryParse(existing.GetString("Date"), System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AssumeUniversal, out var at) ? at : default)
            || (incoming.TryGetValue("Seconds", out var v) ? v as double? ?? double.MaxValue : double.MaxValue)
                < (existing.GetDouble("Seconds") ?? double.MaxValue),
    };

    // Slot → the moment its course last changed shape. 2026-11-05: Neon Chute (1) and Canyon Run (4)
    // were folded into Neon Canyon on slot 1, a longer course, so older slot-1 times no longer
    // compare and slot 4 has no course. Records from before are hidden and overwritten.
    private static readonly Dictionary<int, DateTimeOffset> MarbleRaceCourseSince = new()
    {
        [1] = new DateTimeOffset(2026, 11, 5, 0, 0, 0, TimeSpan.Zero),
        [4] = DateTimeOffset.MaxValue,
    };

    private static bool IsStaleMarbleRaceRecord(int mapId, DateTimeOffset achievedAt) =>
        MarbleRaceCourseSince.TryGetValue(mapId, out var since) && achievedAt < since;

    public async Task<List<MarbleRaceMapRecord>> GetMarbleRaceMapRecordsAsync() =>
        (await GetHighScoresAsync(MarbleRaceRecords, 50))
            .Where(r => !IsStaleMarbleRaceRecord(r.MapId, r.AchievedAtUtc))
            .ToList();

    public Task<MarbleRaceMapRecord> SaveMarbleRaceMapRecordAsync(MarbleRaceMapRecord entry) =>
        SaveHighScoreAsync(MarbleRaceRecords, entry);

    private static readonly HighScoreDescriptor<PoBrawlHighScore> PoBrawlScores = new(
        Table: PoBrawlTable,
        Partition: PoBrawlPartition,
        Sanitize: e => e with
        {
            // One identity across boards: full display name (legacy rows hold initials).
            PlayerInitials = DisplayName24(e.PlayerInitials),
            Character = SanitizeName(e.Character),
            Date = DefaultDate(e.Date),
        },
        ToFields: e => new Dictionary<string, object?>
        {
            ["PlayerInitials"] = e.PlayerInitials,
            ["KoTimeSeconds"] = e.KoTimeSeconds,
            ["Character"] = e.Character,
            ["Date"] = e.Date,
        },
        FromEntity: e => new PoBrawlHighScore
        {
            PlayerInitials = e.GetString("PlayerInitials") ?? "",
            KoTimeSeconds = e.GetDouble("KoTimeSeconds") ?? 0d,
            Character = e.GetString("Character") ?? "",
            Date = e.GetString("Date") ?? "",
        },
        // One row per player (the stored name is the claim name, moderated). Keyed on the time
        // as well, every KO minted a row, so one account could post a hundred and push every
        // other player off any read that ranks a bounded page of rows.
        RowKeyFields: ["PlayerInitials"],
        // Fastest KO wins, oldest first as the tiebreaker.
        Rank: s => s.OrderBy(x => x.KoTimeSeconds).ThenBy(x => x.Date))
    {
        // Best-result ratchet: a slower later KO must not erase a faster one.
        ShouldOverwrite = (existing, incoming) =>
            (incoming.TryGetValue("KoTimeSeconds", out var v) ? v as double? ?? double.MaxValue : double.MaxValue)
                < (existing.GetDouble("KoTimeSeconds") ?? double.MaxValue),
    };

    private static readonly HighScoreDescriptor<PoVoxelStrikeHighScore> PoVoxelStrikeScores = new(
        Table: PoVoxelStrikeTable,
        Partition: PoVoxelStrikePartition,
        Sanitize: e => e with
        {
            PlayerName = DisplayName24(e.PlayerName),
            UserId = e.UserId ?? "",
            Score = PoVoxelStrikeScore.Clamp(e.Score),
            SurvivalSeconds = Math.Clamp(e.SurvivalSeconds, 0, 14_400),
            Kills = Math.Max(0, e.Kills),
            BruteKills = Math.Max(0, e.BruteKills),
            CrushKills = Math.Max(0, e.CrushKills),
            VoxelsDestroyed = Math.Max(0, e.VoxelsDestroyed),
            AchievedAtUtc = e.AchievedAtUtc == default ? DateTimeOffset.UtcNow : e.AchievedAtUtc,
        },
        ToFields: e => new Dictionary<string, object?>
        {
            ["PlayerName"] = e.PlayerName,
            ["UserId"] = e.UserId,
            ["IsGuest"] = e.IsGuest,
            ["Score"] = e.Score,
            ["SurvivalSeconds"] = e.SurvivalSeconds,
            ["Kills"] = e.Kills,
            ["BruteKills"] = e.BruteKills,
            ["CrushKills"] = e.CrushKills,
            ["VoxelsDestroyed"] = e.VoxelsDestroyed,
            ["Won"] = e.Won,
            // ISO-8601 string, matching every sibling board's date convention.
            ["Date"] = e.AchievedAtUtc.ToString("yyyy-MM-ddTHH:mm:ssZ", System.Globalization.CultureInfo.InvariantCulture),
        },
        FromEntity: e => new PoVoxelStrikeHighScore
        {
            PlayerName = e.GetString("PlayerName") ?? "",
            UserId = e.GetString("UserId") ?? "",
            IsGuest = e.GetBoolean("IsGuest") ?? true,
            Score = e.GetInt32("Score") ?? 0,
            SurvivalSeconds = e.GetDouble("SurvivalSeconds") ?? 0d,
            Kills = e.GetInt32("Kills") ?? 0,
            BruteKills = e.GetInt32("BruteKills") ?? 0,
            CrushKills = e.GetInt32("CrushKills") ?? 0,
            VoxelsDestroyed = e.GetInt32("VoxelsDestroyed") ?? 0,
            Won = e.GetBoolean("Won") ?? false,
            AchievedAtUtc = DateTimeOffset.TryParse(e.GetString("Date"), out var d) ? d : default,
        },
        // Identity is the player (mirrors MarbleRaceScores): one row per (name, account,
        // guest-ness), never keyed on the score — every run submits, and score-keyed rows
        // would let one player fill the whole board.
        RowKeyFields: ["PlayerName", "UserId", "IsGuest"],
        Rank: s => s.OrderByDescending(x => x.Score).ThenBy(x => x.AchievedAtUtc))
    {
        // Best-result ratchet: a later, worse run must not erase a better one.
        ShouldOverwrite = (existing, incoming) =>
            (incoming.TryGetValue("Score", out var v) ? v as int? ?? 0 : 0) > (existing.GetInt32("Score") ?? -1),
    };

    // The Daily Siege board is the same descriptor in a per-day partition: everyone storms
    // the one arena that day's seed builds, so the day IS the board. `day` reaches an OData
    // filter, so it must already be a server-formatted yyyy-MM-dd (the endpoint parses and
    // re-formats it; nothing else may pass a caller's string through).
    private static string? PoVoxelStrikeDayPartition(string? day) =>
        day is null ? null : $"{PoVoxelStrikePartition}_{day}";

    public Task<List<PoVoxelStrikeHighScore>> GetPoVoxelStrikeHighScoresAsync(int limit = 10, string? day = null, bool weekly = false) =>
        GetHighScoresAsync(PoVoxelStrikeScores, limit, partition: PoVoxelStrikeDayPartition(day), weekly: weekly && day is null);

    // A Daily Siege row is not also a weekly row: the weekly board mirrors the all-time one.
    public Task<PoVoxelStrikeHighScore> SavePoVoxelStrikeHighScoreAsync(PoVoxelStrikeHighScore entry, string? day = null) =>
        SaveHighScoreAsync(PoVoxelStrikeScores, entry, partition: PoVoxelStrikeDayPartition(day), weekly: day is null);

    private static readonly HighScoreDescriptor<PoMuleHighScore> PoMuleScores = new(
        Table: PoMuleTable,
        Partition: PoMulePartition,
        Sanitize: e => e with
        {
            PlayerName = DisplayName24(e.PlayerName),
            UserId = e.UserId ?? "",
            NetWorth = Math.Clamp(e.NetWorth, PoMuleHighScore.MinNetWorth, PoMuleHighScore.MaxNetWorth),
            Species = e.Species ?? "",
            AchievedAtUtc = e.AchievedAtUtc == default ? DateTimeOffset.UtcNow : e.AchievedAtUtc,
        },
        ToFields: e => new Dictionary<string, object?>
        {
            ["PlayerName"] = e.PlayerName,
            ["UserId"] = e.UserId,
            ["IsGuest"] = e.IsGuest,
            ["NetWorth"] = e.NetWorth,
            ["Species"] = e.Species,
            ["ColonySurvived"] = e.ColonySurvived,
            ["Date"] = e.AchievedAtUtc.ToString("yyyy-MM-ddTHH:mm:ssZ", System.Globalization.CultureInfo.InvariantCulture),
        },
        FromEntity: e => new PoMuleHighScore
        {
            PlayerName = e.GetString("PlayerName") ?? "",
            UserId = e.GetString("UserId") ?? "",
            IsGuest = e.GetBoolean("IsGuest") ?? true,
            NetWorth = e.GetInt32("NetWorth") ?? 0,
            Species = e.GetString("Species") ?? "",
            ColonySurvived = e.GetBoolean("ColonySurvived") ?? false,
            AchievedAtUtc = DateTimeOffset.TryParse(e.GetString("Date"), out var d) ? d : default,
        },
        // One row per player, never keyed on the score (same reasoning as PoVoxelStrikeScores).
        RowKeyFields: ["PlayerName", "UserId", "IsGuest"],
        Rank: s => s.OrderByDescending(x => x.NetWorth).ThenBy(x => x.AchievedAtUtc))
    {
        // Best-result ratchet: a later, poorer match must not erase a richer one.
        ShouldOverwrite = (existing, incoming) =>
            (incoming.TryGetValue("NetWorth", out var v) ? v as int? ?? 0 : 0) > (existing.GetInt32("NetWorth") ?? -1),
    };

    public Task<List<PoMuleHighScore>> GetPoMuleHighScoresAsync(int limit = 10, bool weekly = false) =>
        GetHighScoresAsync(PoMuleScores, limit, weekly: weekly);

    public Task<PoMuleHighScore> SavePoMuleHighScoreAsync(PoMuleHighScore entry) =>
        SaveHighScoreAsync(PoMuleScores, entry, weekly: true);

    public Task<List<MarbleRaceHighScore>> GetMarbleRaceHighScoresAsync(int limit = 10, bool weekly = false) =>
        GetHighScoresAsync(MarbleRaceScores, limit, weekly: weekly);

    public Task<MarbleRaceHighScore> SaveMarbleRaceHighScoreAsync(MarbleRaceHighScore entry) =>
        SaveHighScoreAsync(MarbleRaceScores, entry, weekly: true);

    public Task<List<PoBrawlHighScore>> GetPoBrawlHighScoresAsync(int limit = 10) =>
        GetHighScoresAsync(PoBrawlScores, limit);

    public Task<PoBrawlHighScore> SavePoBrawlHighScoreAsync(PoBrawlHighScore entry) =>
        SaveHighScoreAsync(PoBrawlScores, entry);

    // ── PoRacer High Scores ───────────────────────────────────────────────
    // Server-side identity is authoritative: the client-supplied PlayerName
    // is replaced with the auth-cookie value before persistence. The row
    // is deduped by a hash of the immutable content (name + time + position +
    // minute-bucketed date) so retry-after-timeout collapses onto the same row.
    private static readonly HighScoreDescriptor<PoRacerHighScore> PoRacerScores = new(
        Table: PoRacerTable,
        Partition: PoRacerPartition,
        Sanitize: e => new PoRacerHighScore
        {
            PlayerName = SanitizeName(e.PlayerName),
            UserId = string.IsNullOrWhiteSpace(e.UserId) ? "" : e.UserId,
            TrackId = string.IsNullOrWhiteSpace(e.TrackId) ? "circuit" : e.TrackId.Trim().ToLowerInvariant(),
            TotalTimeSeconds = Math.Clamp(e.TotalTimeSeconds, 0.001, 3600),
            FinalPosition = Math.Clamp(e.FinalPosition, 1, PoRacerCatalog.SoloCarCount),
            IsGuest = e.IsGuest,
            Date = DefaultDate(e.Date),
            GameCode = SanitizeName(e.GameCode),
        },
        ToFields: e => new Dictionary<string, object?>
        {
            ["PlayerName"] = e.PlayerName,
            ["UserId"] = e.UserId,
            ["TrackId"] = e.TrackId,
            ["TotalTimeSeconds"] = e.TotalTimeSeconds,
            ["FinalPosition"] = e.FinalPosition,
            ["IsGuest"] = e.IsGuest,
            ["Date"] = e.Date,
            ["GameCode"] = e.GameCode,
        },
        FromEntity: e => new PoRacerHighScore
        {
            PlayerName = e.GetString("PlayerName") ?? "",
            UserId = e.GetString("UserId") ?? "",
            TrackId = e.GetString("TrackId") ?? "circuit",
            TotalTimeSeconds = e.GetDouble("TotalTimeSeconds") ?? 0d,
            FinalPosition = e.GetInt32("FinalPosition") ?? 0,
            IsGuest = e.GetBoolean("IsGuest") ?? false,
            Date = e.GetString("Date") ?? "",
            GameCode = e.GetString("GameCode") ?? "",
        },
        RowKeyFields: ["FinalPosition", "PlayerName", "TotalTimeSeconds", "UserId", "TrackId"],
        // Lowest race time wins; oldest submission breaks ties.
        Rank: s => s.OrderBy(x => x.TotalTimeSeconds).ThenBy(x => x.Date));

    public static string PoRacerTrackPartition(string? trackId) =>
        string.IsNullOrWhiteSpace(trackId) || trackId.Equals("circuit", StringComparison.OrdinalIgnoreCase)
            ? "poracer_circuit"
            : $"poracer_{trackId.Trim().ToLowerInvariant()}";

    public Task<List<PoRacerHighScore>> GetPoRacerHighScoresAsync(int limit = 10, string? trackId = null, bool weekly = false)
    {
        // The legacy bare "poracer" partition predates weekly rows, so a weekly read is only
        // ever the one track partition's current week.
        if (!weekly && (string.IsNullOrWhiteSpace(trackId) || trackId.Equals("circuit", StringComparison.OrdinalIgnoreCase)))
        {
            return GetHighScoresAsync(PoRacerScores, limit, partition: "poracer_circuit", customFilter: "PartitionKey eq 'poracer_circuit' or PartitionKey eq 'poracer'");
        }
        var partition = PoRacerTrackPartition(trackId);
        return GetHighScoresAsync(PoRacerScores, limit, partition: partition, weekly: weekly);
    }

    public Task<PoRacerHighScore> SavePoRacerHighScoreAsync(PoRacerHighScore entry)
    {
        var partition = PoRacerTrackPartition(entry.TrackId);
        return SaveHighScoreAsync(PoRacerScores, entry, partition: partition, requirePersistence: true, weekly: true);
    }

    // ── PoCabinet High Scores (T5) ────────────────────────────────────────────
    // TrackId partitions the leaderboard: Capitol best-lap never competes with
    // Mar-a-Lago best-lap. Identity-keyed on (player + track) — one row per
    // (player, track), ratcheted by ShouldOverwrite to only accept a faster lap.
    private static readonly HighScoreDescriptor<PoCabinetHighScore> PoCabinetScores = new(
        Table: PoCabinetTable,
        Partition: PoCabinetPartition,
        Sanitize: e => new PoCabinetHighScore
        {
            PlayerName = DisplayName24(e.PlayerName),
            UserId = string.IsNullOrWhiteSpace(e.UserId) ? "" : e.UserId,
            // An unknown track id defaults to "capitol"; the OpenAPI contract pins this
            // fallback. Future tracks added to the catalog
            // will fall through to default as well until the descriptor is updated.
            TrackId = string.IsNullOrWhiteSpace(e.TrackId) ? "capitol" : e.TrackId.Trim().ToLowerInvariant(),
            BestLapSeconds = double.IsFinite(e.BestLapSeconds) ? Math.Clamp(e.BestLapSeconds, 0.001, 3600) : 0,
            // 100, not PoCabinetCatalog.SoloCarCount (64): rows posted from the old 100-car field keep their place.
            FinalPosition = e.FinalPosition is >= 1 and <= 100 ? e.FinalPosition : 1,
            IsGuest = e.IsGuest,
            Date = DefaultDate(e.Date),
            GameCode = SanitizeName(e.GameCode),
        },
        ToFields: e => new Dictionary<string, object?>
        {
            ["PlayerName"] = e.PlayerName,
            ["UserId"] = e.UserId,
            ["TrackId"] = e.TrackId,
            ["BestLapSeconds"] = e.BestLapSeconds,
            ["FinalPosition"] = e.FinalPosition,
            ["IsGuest"] = e.IsGuest,
            ["Date"] = e.Date,
            ["GameCode"] = e.GameCode,
        },
        FromEntity: e => new PoCabinetHighScore
        {
            PlayerName = e.GetString("PlayerName") ?? "",
            UserId = e.GetString("UserId") ?? "",
            TrackId = e.GetString("TrackId") ?? "capitol",
            BestLapSeconds = e.GetDouble("BestLapSeconds") ?? 0d,
            FinalPosition = e.GetInt32("FinalPosition") ?? 0,
            IsGuest = e.GetBoolean("IsGuest") ?? false,
            Date = e.GetString("Date") ?? "",
            GameCode = e.GetString("GameCode") ?? "",
        },
        RowKeyFields: ["PlayerName", "UserId", "IsGuest", "TrackId"],
        // Fastest lap wins, oldest first as the tiebreaker (so the first 1:23.45 stays on top
        // when someone later matches it).
        Rank: s => s.OrderBy(x => x.BestLapSeconds).ThenBy(x => x.Date))
    {
        // One row per (player, track): only a strictly faster lap may replace the stored PB.
        ShouldOverwrite = (existing, incoming) =>
            (incoming.TryGetValue("BestLapSeconds", out var v) ? v as double? ?? double.MaxValue : double.MaxValue)
                < (existing.GetDouble("BestLapSeconds") ?? double.MaxValue),
    };

    public Task<List<PoCabinetHighScore>> GetPoCabinetHighScoresAsync(int limit = 10, string? trackId = null)
    {
        if (string.IsNullOrWhiteSpace(trackId))
        {
            return GetHighScoresAsync(PoCabinetScores, limit);
        }
        var partition = string.Equals(trackId, "capitol", StringComparison.OrdinalIgnoreCase)
            ? PoCabinetPartition
            : $"pocabinet_{trackId.Trim().ToLowerInvariant()}";
        return GetHighScoresAsync(PoCabinetScores, limit, partition: partition);
    }

    public Task<PoCabinetHighScore> SavePoCabinetHighScoreAsync(PoCabinetHighScore entry)
    {
        var partition = string.Equals(entry.TrackId, "capitol", StringComparison.OrdinalIgnoreCase)
            ? PoCabinetPartition
            : $"pocabinet_{entry.TrackId.Trim().ToLowerInvariant()}";
        return SaveHighScoreAsync(PoCabinetScores, entry, partition: partition, requirePersistence: true);
    }


    // ── Weekly boards ─────────────────────────────────────────────────────
    // An all-time board shows each player's best-EVER run, so after a while it stops moving
    // for anyone not already on it. Every save to a board with a weekly view also lands in a
    // sibling partition named for the ISO week ("{partition}-w2026-42"), with the same
    // descriptor, RowKey and ratchet: "this week" is the same board, reset every Monday.
    // Past weeks are simply never read again.

    /// <summary>The ISO-8601 week suffix a weekly partition carries, e.g. <c>-w2026-42</c>.</summary>
    public static string IsoWeekSuffix(DateTimeOffset at)
    {
        var utc = at.UtcDateTime;
        return $"-w{System.Globalization.ISOWeek.GetYear(utc):D4}-{System.Globalization.ISOWeek.GetWeekOfYear(utc):D2}";
    }

    private static string WeeklyPartition(string partition) => partition + IsoWeekSuffix(DateTimeOffset.UtcNow);

    // The one shared high-score read: scan the game's partition, rebuild entries, rank, take.
    // `weekly` reads the current ISO week's sibling partition instead (see Weekly boards).
    private async Task<List<T>> GetHighScoresAsync<T>(HighScoreDescriptor<T> descriptor, int limit, string? partition = null, string? customFilter = null, bool weekly = false)
    {
        // Storage is down: an empty board is the honest answer. There is no in-memory
        // shadow copy to read from any more (see the class header).
        if (!IsStorageAvailable()) return [];

        var scores = new List<T>();
        var filter = weekly
            ? $"PartitionKey eq '{WeeklyPartition(partition ?? descriptor.Partition)}'"
            : customFilter ?? $"PartitionKey eq '{partition ?? descriptor.Partition}'";
        try
        {
            await foreach (var e in Table(descriptor.Table).QueryAsync<TableEntity>(
                filter: filter,
                maxPerPage: 1000))
            {
                scores.Add(descriptor.FromEntity(e));
            }

            return descriptor.Rank(scores).Take(limit).ToList();
        }
        catch (Exception ex)
        {
            MarkUnavailable(ex);
            return [];
        }
    }

    // The one shared high-score write: normalise, map to a row, upsert idempotently.
    // The RowKey is derived deterministically from the row's content so a duplicate
    // HTTP request or a retry-after-timeout collapses onto the same row instead of
    // inflating the leaderboard with a second identical entry. Ranking is done in
    // memory (see GetHighScoresAsync), so RowKey ordering is irrelevant to correctness.
    // `weekly` also writes the row into the current ISO week's partition (see Weekly boards).
    private async Task<T> SaveHighScoreAsync<T>(HighScoreDescriptor<T> descriptor, T entry, string? partition = null, bool requirePersistence = false, bool weekly = false)
    {
        // Always sanitize first so the caller still gets a normalised entry back even when
        // storage is down — the endpoint's 201 Created response shape stays unchanged.
        var sanitized = descriptor.Sanitize(entry);

        // Storage is down: the write does not land. The sanitized entry still goes back so
        // the endpoint's response shape is unchanged, and the client's PendingScoreStore
        // holds the score in localStorage until ScoreSyncService can flush it for real.
        if (!IsStorageAvailable())
        {
            if (requirePersistence) throw new IOException("Score storage is unavailable.");
            return sanitized;
        }

        var fields = descriptor.ToFields(sanitized);

        // Hash the row's identity fields only (submitter,
        // score, game-specific measurements). Including timestamps here would mean two
        // near-simultaneous submissions of the same score produce two distinct rows — a
        // duplicate the leaderboard then has to dedupe at read time, and a vector for cheap
        // score-flooding via bursty retries.
        var rowKey = DeterministicRowKey(fields, descriptor.RowKeyFields);
        var effectivePartition = partition ?? descriptor.Partition;

        try
        {
            await UpsertHighScoreRowAsync(descriptor, effectivePartition, rowKey, fields);
        }
        catch (Exception ex)
        {
            MarkUnavailable(ex);
            if (requirePersistence) throw new IOException("Score storage is unavailable.", ex);
            // Returning the sanitized entry keeps the response shape stable so the client
            // doesn't have to special-case "Azurite down" — the write did not land, and the
            // client's PendingScoreStore is what holds the score until it does.
            return sanitized;
        }

        if (weekly)
        {
            // Best-effort: the all-time row above is the score of record, so a weekly write
            // that fails must neither fail the submit nor make the client retry it.
            try
            {
                await UpsertHighScoreRowAsync(descriptor, WeeklyPartition(effectivePartition), rowKey, fields);
            }
            catch (Exception ex)
            {
                MarkUnavailable(ex);
            }
        }
        return sanitized;
    }

    // Concurrency-safe upsert: read existing, merge, write with ETag. Bounded retry on
    // 412/409 (see TableConcurrency). The descriptor's ratchet can veto a worse row.
    private Task UpsertHighScoreRowAsync<T>(
        HighScoreDescriptor<T> descriptor, string partition, string rowKey, IDictionary<string, object?> fields) =>
        TableConcurrency.UpdateWithRetryAsync<TableEntity>(
            Table(descriptor.Table),
            partitionKey: partition,
            rowKey: rowKey,
            factory: () => new TableEntity(partition, rowKey),
            mutate: e =>
            {
                if (descriptor.ShouldOverwrite is not null && !descriptor.ShouldOverwrite(e, fields))
                {
                    return false;
                }

                var changed = false;
                foreach (var (key, value) in fields)
                {
                    if (!e.TryGetValue(key, out var existing) || !Equals(existing, value))
                    {
                        e[key] = value;
                        changed = true;
                    }
                }
                return changed;
            });

    // Stable content hash over the row's identity fields → idempotent, retry-safe RowKey.
    // Sorted ordinal so a descriptor's RowKeyFields order can never affect the hash.
    private static string DeterministicRowKey(IDictionary<string, object?> fields, IReadOnlyList<string> rowKeyFields)
    {
        var canonical = string.Join("", rowKeyFields
            .OrderBy(s => s, StringComparer.Ordinal)
            .Select(k => fields.TryGetValue(k, out var v) ? $"{k}={Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture)}" : $"{k}="));
        var hash = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(canonical));
        return Convert.ToHexStringLower(hash);
    }
}
