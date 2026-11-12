using System.Text;
using System.Text.Json;
using PoMiniGamesClient.Models;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Play;

/// <summary>
/// Everything an achievement rule reads, gathered from data the device already keeps.
/// Plain numbers, so the rules can be checked without a browser.
/// </summary>
public sealed record AchievementFacts
{
    /// <summary>Wins across every game's local record.</summary>
    public int Wins { get; init; }
    /// <summary>Longest current win streak in any one game or difficulty.</summary>
    public int Streak { get; init; }
    /// <summary>Highest adaptive ELO peak in a 1-player game played at least once.</summary>
    public int TopElo { get; init; }
    /// <summary>Distinct games with a recorded result or a session.</summary>
    public int GamesTried { get; init; }
    /// <summary>Game sessions started, all games together.</summary>
    public int Sessions { get; init; }
    /// <summary>Consecutive calendar days with at least one game session.</summary>
    public int DayStreak { get; init; }
    /// <summary>Presidents beaten in the current Brawl ladder run.</summary>
    public int BrawlRung { get; init; }
    /// <summary>Full Brawl ladder clears.</summary>
    public int BrawlClears { get; init; }
    /// <summary>Sessions of the two simulations (Ecosystem, Sand Playground).</summary>
    public int SimSessions { get; init; }
    /// <summary>The player's best rank on any all-time leaderboard seen this visit.</summary>
    public int? BestBoardRank { get; init; }
    /// <summary>Online wins, from the competitive card or the head-to-head history.</summary>
    public int OnlineWins { get; init; }
}

/// <summary>One badge: what it is called, how to earn it, and the rule that decides it.</summary>
public sealed record Achievement(string Id, string Icon, string Title, string Hint, Func<AchievementFacts, bool> IsMet);

/// <summary>
/// A small on-device achievements layer. Nothing new is tracked for it: every rule reads
/// numbers the games already keep (local W/L records and ratings, session counts, the
/// the Brawl ladder), plus two facts pages report when they have them
/// (a leaderboard rank, online wins). An unlock is sticky and lives in localStorage
/// <c>pominigames:achievements</c>, so it outlives the stat that earned it.
/// </summary>
/// <remarks>
/// Evaluated whenever a result is recorded (<see cref="GameStatsService.ResultRecorded"/>,
/// which every result path reaches) and when a game session starts. New unlocks announce
/// with a toast and the crystal ping. The very first evaluation on a device only seeds the
/// store: a returning player would otherwise get a burst of toasts for history they made
/// before achievements existed.
/// </remarks>
public sealed class AchievementService : IDisposable
{
    private const string StorageKey = "pominigames:achievements";

    // The games whose record is a single adaptive rating (see ProfilePage.Kinds).
    private static readonly HashSet<string> AdaptiveGames = new(StringComparer.OrdinalIgnoreCase)
    {
        "tictactoe", "connectfive", "pobrawl",
    };

    public static readonly IReadOnlyList<Achievement> All =
    [
        new("first-win", "🥇", "First win", "Win any match", f => f.Wins >= 1),
        new("wins-10", "🔟", "Ten wins", "Win 10 matches", f => f.Wins >= 10),
        new("wins-50", "🏅", "Fifty wins", "Win 50 matches", f => f.Wins >= 50),
        new("hot-streak", "🔥", "Hot streak", "Win 3 in a row in one game", f => f.Streak >= 3),
        new("rising-star", "📈", "Rising star", "Reach 1400 ELO in a 1-player game", f => f.TopElo >= 1400),
        new("explorer", "🧭", "Explorer", "Play 5 different games", f => f.GamesTried >= 5),
        new("globetrotter", "🗺️", "Globetrotter", "Play 10 different games", f => f.GamesTried >= 10),
        new("regular", "🎮", "Regular", "Start 25 game sessions", f => f.Sessions >= 25),
        new("three-days", "📅", "Three-day streak", "Play on 3 days in a row", f => f.DayStreak >= 3),
        new("contender", "🥊", "Contender", "Beat 5 presidents on the Brawl ladder", f => f.BrawlRung >= 5 || f.BrawlClears >= 1),
        new("ladder-champ", "🏆", "Ladder champ", "Beat the whole Brawl ladder", f => f.BrawlClears >= 1),
        new("podium", "🥉", "Podium", "Reach the top 3 on any leaderboard", f => f.BestBoardRank is <= 3),
        new("number-one", "👑", "Number one", "Top any leaderboard", f => f.BestBoardRank is 1),
        new("online-victor", "🌐", "Online victor", "Win an online match", f => f.OnlineWins >= 1),
        new("nature-watcher", "🌿", "Nature watcher", "Watch the Ecosystem or Sand Playground", f => f.SimSessions >= 1),
    ];

    private readonly GameStatsService _stats;
    private readonly PlayerNameService _names;
    private readonly ToastService _toasts;
    private readonly UiFeedbackService _feedback;

    // Loaded on first use. A missing store means this device has never been evaluated.
    private Dictionary<string, string>? _unlocked;
    private bool _seeded;
    private string _lastDay = "";
    private int _dayStreak;

    // Reported by pages that fetch them; not stored, because the unlock they earn is.
    private int? _bestBoardRank;
    private int _onlineWins;

    public AchievementService(
        GameStatsService stats, PlayerNameService names, ToastService toasts, UiFeedbackService feedback)
    {
        _stats = stats;
        _names = names;
        _toasts = toasts;
        _feedback = feedback;
        _stats.ResultRecorded += OnResultRecorded;
    }

    public void Dispose() => _stats.ResultRecorded -= OnResultRecorded;

    /// <summary>True once the badge is earned on this device.</summary>
    public bool IsUnlocked(string id) => Unlocked.ContainsKey(id);

    /// <summary>How many of <see cref="All"/> are earned.</summary>
    public int UnlockedCount => All.Count(a => Unlocked.ContainsKey(a.Id));

    private Dictionary<string, string> Unlocked
    {
        get
        {
            if (_unlocked is null) Load();
            return _unlocked!;
        }
    }

    /// <summary>
    /// A game session started: count it, extend the day streak, and re-check. Called once
    /// per game page visit by <c>GameShell</c>.
    /// </summary>
    public void NoteSession(string gameKey)
    {
        _stats.RecordPlay(gameKey);
        TouchDay(DateTime.Now.Date);
        Evaluate();
    }

    /// <summary>The player's best rank on any all-time board, from a page that has the boards.</summary>
    public void NoteBoardRank(int rank)
    {
        if (rank < 1 || (_bestBoardRank is { } best && best <= rank)) return;
        _bestBoardRank = rank;
        Evaluate();
    }

    /// <summary>Online wins, from a page that has the competitive card or match history.</summary>
    public void NoteOnlineWins(int wins)
    {
        if (wins <= _onlineWins) return;
        _onlineWins = wins;
        Evaluate();
    }

    private void OnResultRecorded(string gameKey) => Evaluate();

    /// <summary>Re-check every rule against the current facts and announce anything new.</summary>
    public void Evaluate()
    {
        var facts = Gather();
        var fresh = All.Where(a => !Unlocked.ContainsKey(a.Id) && a.IsMet(facts)).ToList();
        var firstRun = !_seeded;
        if (fresh.Count == 0 && !firstRun) return;

        var stamp = DateTime.Now.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
        foreach (var a in fresh) _unlocked![a.Id] = stamp;
        _seeded = true;
        Save();

        // The first evaluation on a device only records what was already earned.
        if (firstRun || fresh.Count == 0) return;

        var message = fresh.Count == 1
            ? $"{fresh[0].Icon} Achievement unlocked: {fresh[0].Title}"
            : $"🏆 {fresh.Count} achievements unlocked: {string.Join(", ", fresh.Select(a => a.Title))}";
        _toasts.Show(message, ToastType.Info);
        _ = _feedback.AchievementPingAsync().AsTask();
    }

    private AchievementFacts Gather()
    {
        var name = _names.GetPlayerName();
        int wins = 0, streak = 0, topElo = 0, tried = 0, sessions = 0, simSessions = 0;

        foreach (var game in GameCatalog.All)
        {
            var key = game.Key.Value;
            var plays = _stats.GetPlayCount(key);
            sessions += plays;
            if (key is "poecosystem" or "sandplayground") simSessions += plays;

            int played;
            if (AdaptiveGames.Contains(key))
            {
                var rating = _stats.GetAdaptiveRating(key, name);
                played = rating.TotalGames;
                wins += rating.Wins;
                streak = Math.Max(streak, rating.WinStreak);
                if (played > 0) topElo = Math.Max(topElo, rating.Peak);
            }
            else
            {
                var stats = _stats.GetStats(key, name);
                played = stats.TotalGames;
                wins += stats.TotalWins;
                streak = Math.Max(streak, Math.Max(stats.Easy.WinStreak, Math.Max(stats.Medium.WinStreak, stats.Hard.WinStreak)));
            }

            if (played > 0 || plays > 0) tried++;
        }

        var brawl = PoMiniGamesClient.Features.PoBrawl.PoBrawlProgressBook.Load(name);
        return new AchievementFacts
        {
            Wins = wins,
            Streak = streak,
            TopElo = topElo,
            GamesTried = tried,
            Sessions = sessions,
            DayStreak = _dayStreak,
            BrawlRung = brawl.Rung,
            BrawlClears = brawl.Clears,
            SimSessions = simSessions,
            BestBoardRank = _bestBoardRank,
            OnlineWins = _onlineWins,
        };
    }

    private void TouchDay(DateTime today)
    {
        _ = Unlocked; // load first
        var todayKey = today.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
        if (_lastDay == todayKey) return;
        _dayStreak = _lastDay == today.AddDays(-1).ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture) ? _dayStreak + 1 : 1;
        _lastDay = todayKey;
        Save();
    }

    // ── Persistence ─────────────────────────────────────────────────────────
    // Hand-rolled JSON (JsonDocument in, Utf8JsonWriter out): no reflection, so nothing
    // here needs a source-generated context to survive WASM trimming. Every failure falls
    // back to an empty store; achievements are a nicety, never a reason to throw.

    private void Load()
    {
        _unlocked = new Dictionary<string, string>(StringComparer.Ordinal);
        try
        {
            var raw = LocalStorageService.GetItem<string>(StorageKey);
            if (string.IsNullOrEmpty(raw)) return;
            using var doc = JsonDocument.Parse(raw);
            var root = doc.RootElement;
            _seeded = true;
            if (root.TryGetProperty("day", out var day)) _lastDay = day.GetString() ?? "";
            if (root.TryGetProperty("dayStreak", out var ds) && ds.TryGetInt32(out var n)) _dayStreak = n;
            if (root.TryGetProperty("unlocked", out var unlocked) && unlocked.ValueKind == JsonValueKind.Object)
            {
                foreach (var p in unlocked.EnumerateObject())
                {
                    _unlocked[p.Name] = p.Value.ValueKind == JsonValueKind.String ? p.Value.GetString() ?? "" : "";
                }
            }
        }
        catch
        {
            // Corrupt or unreadable: start over rather than fail the page.
        }
    }

    private void Save()
    {
        try
        {
            using var buffer = new MemoryStream();
            using (var w = new Utf8JsonWriter(buffer))
            {
                w.WriteStartObject();
                w.WriteNumber("v", 1);
                w.WriteString("day", _lastDay);
                w.WriteNumber("dayStreak", _dayStreak);
                w.WriteStartObject("unlocked");
                foreach (var (id, when) in Unlocked) w.WriteString(id, when);
                w.WriteEndObject();
                w.WriteEndObject();
            }
            LocalStorageService.SetItem(StorageKey, Encoding.UTF8.GetString(buffer.ToArray()));
        }
        catch
        {
            // Private mode or quota: the unlock still shows for this visit.
        }
    }
}
