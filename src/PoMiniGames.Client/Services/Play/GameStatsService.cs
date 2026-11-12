#pragma warning disable CA1822 // Preserved as scoped service instance API for injected callers and tests.
using Microsoft.JSInterop;
using PoMiniGamesClient.Models;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;

using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Play;

public class GameStatsService
{
    private static readonly Dictionary<string, PlayerStats> _statsCache = new();
    private const string StorageKeyPrefix = "pominigames:stats:";
    private const string AdaptiveKeyPrefix = "pominigames:adaptive:";
    private const string LastGameKey = "pominigames:last-game";

    public PlayerStats GetStats(string gameKey, string playerName)
    {
        var cacheKey = $"{gameKey}_{playerName}";
        if (_statsCache.TryGetValue(cacheKey, out var cached))
            return cached;

        var storageKey = $"{StorageKeyPrefix}{gameKey}";
        var stored = LocalStorageService.GetItem(storageKey, ApiJsonContext.Default.PlayerStats);
        if (stored != null && stored.PlayerName == playerName)
        {
            _statsCache[cacheKey] = stored;
            return stored;
        }

        var newStats = new PlayerStats
        {
            PlayerId = GetOrCreatePlayerId(),
            PlayerName = playerName
        };
        _statsCache[cacheKey] = newStats;
        return newStats;
    }

    public DifficultyStats GetDifficultyBucket(PlayerStats stats, Difficulty difficulty)
    {
        return difficulty switch
        {
            Difficulty.Easy => stats.Easy,
            Difficulty.Medium => stats.Medium,
            Difficulty.Hard => stats.Hard,
            _ => stats.Medium
        };
    }

    public async Task<PlayerStats> RecordResult(string gameKey, string playerName, Difficulty difficulty, GameResult result)
    {
        var stats = GetStats(gameKey, playerName);
        var bucket = GetDifficultyBucket(stats, difficulty);

        switch (result)
        {
            case GameResult.Win:
                bucket.Wins++;
                bucket.WinStreak++;
                break;
            case GameResult.Loss:
                bucket.Losses++;
                bucket.WinStreak = 0;
                break;
            case GameResult.Draw:
                bucket.Draws++;
                bucket.WinStreak = 0;
                break;
        }

        bucket.EloRating = ComputeEloRating(bucket, difficulty);
        await SaveStats(gameKey, stats);
        ResultRecorded?.Invoke(gameKey);
        return stats;
    }

    /// <summary>
    /// Raised after any game's W/L/D result is written locally, by either rating path.
    /// Every result reaches one of the two, whether it came through GameResultService or a
    /// page that records on its own, so this is the one place "a result was recorded" is
    /// observable (achievements listen here).
    /// </summary>
    public event Action<string>? ResultRecorded;

    public async Task SaveStats(string gameKey, PlayerStats stats)
    {
        var cacheKey = $"{gameKey}_{stats.PlayerName}";
        _statsCache[cacheKey] = stats;
        var storageKey = $"{StorageKeyPrefix}{gameKey}";
        LocalStorageService.SetItem(storageKey, stats, ApiJsonContext.Default.PlayerStats);
    }

    // ── Adaptive single-rating ELO (e.g. Connect Five 1-player) ──────────────
    // A single skill rating per game. The CPU is matched to the player's current
    // ELO, so each game is a ~50/50 challenge that ramps up as the player wins.
    private const int AdaptiveK = 32;

    public AdaptiveRating GetAdaptiveRating(string gameKey, string playerName)
    {
        // Per-player slot: switching identities on the same browser (e.g. Guest ↔
        // Microsoft sign-in) must never wipe another player's accumulated rating —
        // the Guest's ELO keeps evolving across guest sessions no matter who else
        // played in between.
        var stored = LocalStorageService.GetItem(
            $"{AdaptiveKeyPrefix}{gameKey}_{playerName}", ApiJsonContext.Default.AdaptiveRating);
        if (stored != null && stored.PlayerName == playerName)
            return stored;

        // Legacy single-slot fallback (pre per-player keys). Adopt it when it
        // belongs to this player; the next recorded result re-saves it under the
        // per-player key above.
        var legacy = LocalStorageService.GetItem(
            $"{AdaptiveKeyPrefix}{gameKey}", ApiJsonContext.Default.AdaptiveRating);
        if (legacy != null && legacy.PlayerName == playerName)
            return legacy;

        return new AdaptiveRating
        {
            PlayerName = playerName,
            Elo = AdaptiveRating.StartingElo,
            Peak = AdaptiveRating.StartingElo
        };
    }

    /// <summary>
    /// Apply one game's result to the adaptive rating using the standard ELO
    /// formula against <paramref name="cpuElo"/> (the rating of the CPU that was
    /// actually played this game), then persist. When the CPU was matched to the
    /// player's rating this yields ±<see cref="AdaptiveK"/>/2 per win/loss.
    /// </summary>
    public AdaptiveRating RecordAdaptiveResult(string gameKey, string playerName, int cpuElo, GameResult result)
    {
        var rating = GetAdaptiveRating(gameKey, playerName);

        var expected = 1.0 / (1.0 + Math.Pow(10, (cpuElo - rating.Elo) / 400.0));
        var score = result switch
        {
            GameResult.Win => 1.0,
            GameResult.Draw => 0.5,
            _ => 0.0
        };
        var newElo = (int)Math.Round(rating.Elo + AdaptiveK * (score - expected));
        rating.Elo = Math.Clamp(newElo, 100, 3000);
        rating.Peak = Math.Max(rating.Peak, rating.Elo);

        switch (result)
        {
            case GameResult.Win: rating.Wins++; rating.WinStreak++; break;
            case GameResult.Loss: rating.Losses++; rating.WinStreak = 0; break;
            case GameResult.Draw: rating.Draws++; rating.WinStreak = 0; break;
        }

        LocalStorageService.SetItem(
            $"{AdaptiveKeyPrefix}{gameKey}_{playerName}", rating, ApiJsonContext.Default.AdaptiveRating);
        ResultRecorded?.Invoke(gameKey);
        return rating;
    }

    // ── Play counts (games with no win condition) ────────────────────────────
    // Games with no outcome and no score (the simulations) carry neither a W/L record nor a leaderboard entry. A session count is
    // the only honest thing the profile can report for them — inventing a score
    // would be a new feature, not stats coverage.
    private const string PlayCountKeyPrefix = "pominigames:plays:";

    /// <remarks>
    /// Keyed by the stable player id, NOT the display name. The name is mutable and
    /// resolves late: it starts empty, is filled by an async localStorage read, and is
    /// then overwritten by <see cref="PlayerNameService.SetPlayerNameFromAuth"/> when a
    /// guest signs in. Keying on it meant a session recorded before any of those steps
    /// was filed under a name the profile never reads back — the count silently showed
    /// zero, and signing in orphaned whatever had accumulated.
    ///
    /// The id is created synchronously on first use and never changes, so it also
    /// removes the ordering hazard entirely: callers need not await anything.
    ///
    /// Trade-off: two identities used in the same browser share one counter. For a
    /// "times played" tally that is the better failure mode than losing the count on
    /// every sign-in.
    /// </remarks>
    private string PlayCountKey(string gameKey) =>
        $"{PlayCountKeyPrefix}{gameKey}_{GetOrCreatePlayerId()}";

    public int GetPlayCount(string gameKey)
    {
        var raw = LocalStorageService.GetItem<string>(PlayCountKey(gameKey));
        return int.TryParse(raw, out var n) && n > 0 ? n : 0;
    }

    /// <summary>
    /// Counts one *session* of a game, not one round — the profile tile reads "N sessions",
    /// so this runs once per game page visit (GameShell does it for every game; see
    /// <see cref="PlayKeyForPath"/>).
    /// </summary>
    public int RecordPlay(string gameKey)
    {
        var next = GetPlayCount(gameKey) + 1;
        LocalStorageService.SetItem(PlayCountKey(gameKey), next.ToString(System.Globalization.CultureInfo.InvariantCulture));
        return next;
    }

    /// <summary>
    /// The catalogue game a page address belongs to ("pomule/1player?autoGuest=1" →
    /// "pomule"), or null for an address that is not a game. Matched on the first path
    /// segment of each game's mode URLs, so it needs no list of its own — Fun Quiz lives at
    /// /funquiz but keeps its stats under "pofunquiz", and that is the key this returns.
    /// </summary>
    public static string? PlayKeyForPath(string relativePath)
    {
        static string FirstSegment(string path) =>
            path.TrimStart('/').Split('?', '#')[0].Split('/')[0];

        var segment = FirstSegment(relativePath);
        if (segment.Length == 0) return null;
        return GameCatalog.All
            .FirstOrDefault(g => g.Modes.Any(m => string.Equals(FirstSegment(m.Url), segment, StringComparison.OrdinalIgnoreCase)))
            ?.Key.Value;
    }

    // UX 10: Offline-First - Track last played game
    public GameCard? GetLastPlayedGame()
    {
        var lastGameKey = LocalStorageService.GetItem<string>(LastGameKey);
        if (string.IsNullOrEmpty(lastGameKey))
            return null;

        // Resolve title + URL from the canonical GameCatalog rather than a private
        // key→title map that had drifted from the product names (it still said
        // "TicTacToe4"). Unknown keys (e.g. a removed game lingering in
        // localStorage) fall back to the raw key so the card still renders.
        GameKey key = lastGameKey;
        var entry = GameCatalog.SinglePlayer
            .Concat(GameCatalog.LocalTwoPlayer)
            .Concat(GameCatalog.Multiplayer)
            .Concat(GameCatalog.Demo)
            .FirstOrDefault(g => g.Key.Equals(key));
        return entry is not null
            ? new GameCard(entry.Title, entry.Url)
            : new GameCard(lastGameKey, $"/{lastGameKey}");
    }

    public void SaveLastPlayedGame(string gameKey)
    {
        LocalStorageService.SetItem(LastGameKey, gameKey);
    }

    public record GameCard(string Title, string Url);

    private int ComputeEloRating(DifficultyStats ds, Difficulty difficulty)
    {
        var aiElo = difficulty switch
        {
            Difficulty.Easy => 800,
            Difficulty.Medium => 1200,
            Difficulty.Hard => 1600,
            _ => 1200
        };

        if (ds.TotalGames == 0) return 1000;

        var K = 32;
        var expected = 1.0 / (1.0 + Math.Pow(10, (aiElo - 1000) / 400.0));
        var elo = 1000
            + ds.Wins * K * (1.0 - expected)
            + ds.Draws * K * (0.5 - expected)
            + ds.Losses * K * (0.0 - expected);

        return Math.Max(0, (int)Math.Round(elo));
    }

    private string GetOrCreatePlayerId()
    {
        const string StorageKey = "pominigames:player-id";
        var playerId = LocalStorageService.GetItem<string>(StorageKey);
        if (string.IsNullOrEmpty(playerId))
        {
            playerId = $"po_{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}_{Guid.NewGuid().ToString("N")[..7]}";
            LocalStorageService.SetItem(StorageKey, playerId);
        }
        return playerId;
    }
}

public static class LocalStorageService
{
    private static IJSRuntime? _jsRuntime;

    public static void SetJSRuntime(IJSRuntime jsRuntime)
    {
        _jsRuntime = jsRuntime;
    }

    /// <summary>
    /// Read a value straight from localStorage. On Blazor WASM this must use the
    /// synchronous <see cref="IJSInProcessRuntime"/>: blocking on InvokeAsync(...).Result
    /// on the WASM UI thread can throw, which previously surfaced as silently-empty
    /// history (e.g. the PoClick stats page reporting "Session Not Found").
    /// </summary>
    // Only plain strings cross the JS boundary here (localStorage stores strings),
    // so the trimmer warning about reflection-based JSON marshalling does not apply.
    [System.Diagnostics.CodeAnalysis.UnconditionalSuppressMessage(
        "Trimming", "IL2026",
        Justification = "Only string values are read from localStorage; no reflection-based JSON marshalling.")]
    private static string? RawGet(string key)
    {
        if (_jsRuntime is IJSInProcessRuntime inProcess)
            return inProcess.Invoke<string?>("window.localStorage.getItem", key);

        // Fallback for non-WASM hosts (prerender/tests) where in-process isn't available.
        return _jsRuntime?.InvokeAsync<string?>("window.localStorage.getItem", key).AsTask().GetAwaiter().GetResult();
    }

    [System.Diagnostics.CodeAnalysis.UnconditionalSuppressMessage(
        "Trimming", "IL2026",
        Justification = "Only string values are written to localStorage; no reflection-based JSON marshalling.")]
    private static void RawSet(string key, string value)
    {
        if (_jsRuntime is IJSInProcessRuntime inProcess)
        {
            // Synchronous invoke guarantees the write is committed before we return,
            // so a subsequent read (e.g. navigating to the stats page) sees it.
            inProcess.InvokeVoid("window.localStorage.setItem", key, value);
            return;
        }

        _ = _jsRuntime?.InvokeVoidAsync("window.localStorage.setItem", key, value).AsTask();
    }

    public static T? GetItem<T>(string key, JsonTypeInfo<T>? typeInfo = null)
    {
        if (_jsRuntime == null) return default;
        try
        {
            if (typeof(T) == typeof(string))
            {
                var raw = RawGet(key);
                if (raw is null) return default;
                // If the stored value is a JSON-encoded string (e.g. "\"CalmTiger42\""), decode it
                if (raw.Length >= 2 && raw[0] == '"' && raw[^1] == '"')
                {
                    try { return (T)(object)JsonDocument.Parse(raw).RootElement.GetString()!; }
                    catch { /* fall through to raw */ }
                }
                return (T)(object)raw;
            }
            if (typeInfo is null) return default;
            var rawJson = RawGet(key);
            if (rawJson is null) return default;
            return JsonSerializer.Deserialize(rawJson, typeInfo);
        }
        catch
        {
            return default;
        }
    }

    public static void SetItem<T>(string key, T value, JsonTypeInfo<T>? typeInfo = null)
    {
        if (_jsRuntime == null) return;
        try
        {
            if (value is string s)
            {
                RawSet(key, s);
            }
            else if (typeInfo is not null)
            {
                var json = JsonSerializer.Serialize(value, typeInfo);
                RawSet(key, json);
            }
        }
        catch { }
    }
}
