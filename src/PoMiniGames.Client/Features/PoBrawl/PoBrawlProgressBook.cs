using System.Globalization;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Services.Play;

namespace PoMiniGamesClient.Features.PoBrawl;

/// <summary>
/// The one place the browser keeps a player's Brawl progress: the 1P ladder rung (and when it was
/// written), the fastest KO, the full-ladder clears, and the Cup titles. The 1P page, Brawl HQ,
/// the Cup and the achievements all read and write through here, so the storage keys and the
/// rules for folding in the signed-in copy (<see cref="PoBrawlProgressDto.Merge"/>, the server
/// store's own rule) live once.
/// </summary>
/// <remarks>
/// The keys are per display name and unchanged from before this class, so no saved run is lost.
/// The Cup titles are one flat "trump:2,obama:1" string: no reflection-based JSON in the trimmed build.
/// </remarks>
public static class PoBrawlProgressBook
{
    private const string TitlesKey = "pobrawl_cup_titles";

    private static string LadderKey(string player) => $"pobrawl_ladder_{player}";
    private static string LadderAtKey(string player) => $"pobrawl_ladder_at_{player}";
    private static string BestKoKey(string player) => $"pobrawl_bestko_{player}";
    private static string ClearsKey(string player) => $"pobrawl_clears_{player}";

    /// <summary>This browser's copy for <paramref name="player"/>; the rung is clamped onto the roster.</summary>
    public static PoBrawlProgressDto Load(string player) => new()
    {
        Rung = Math.Clamp(ReadInt(LadderKey(player)), 0, PoBrawlRoster.Count - 1),
        UpdatedAtUnixMs = long.TryParse(LocalStorageService.GetItem<string>(LadderAtKey(player)), out var at) ? at : 0,
        BestKoSeconds = double.TryParse(LocalStorageService.GetItem<string>(BestKoKey(player)), NumberStyles.Float,
            CultureInfo.InvariantCulture, out var ko) ? ko : 0,
        Clears = ReadInt(ClearsKey(player)),
    };

    /// <summary>
    /// Fold the signed-in copy (another device) into this browser's and store the result. With
    /// <paramref name="takeRung"/> false the local rung stands whatever its age — a fight already
    /// under way owns it — while the KO record and the clears still take the best of both.
    /// </summary>
    public static PoBrawlProgressDto Adopt(string player, PoBrawlProgressDto remote, bool takeRung = true)
    {
        var local = Load(player);
        var merged = PoBrawlProgressDto.Merge(local, remote);
        if (!takeRung)
        {
            merged.Rung = local.Rung;
            merged.UpdatedAtUnixMs = local.UpdatedAtUnixMs;
        }
        merged.Rung = Math.Clamp(merged.Rung, 0, PoBrawlRoster.Count - 1);
        Write(player, merged);
        return merged;
    }

    /// <summary>A new rung, stamped now: the timestamp is what lets the newer copy win on another device.</summary>
    public static PoBrawlProgressDto RecordRung(string player, int rung)
    {
        var progress = Load(player);
        progress.Rung = Math.Clamp(rung, 0, PoBrawlRoster.Count - 1);
        progress.UpdatedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        Write(player, progress);
        return progress;
    }

    /// <summary>Stores a KO time (rounded to the hundredth the boards show) and returns it.</summary>
    public static double RecordBestKo(string player, double seconds)
    {
        var rounded = Math.Round(seconds, 2);
        LocalStorageService.SetItem(BestKoKey(player), rounded.ToString(CultureInfo.InvariantCulture));
        return rounded;
    }

    /// <summary>One more full-ladder clear; returns the new count.</summary>
    public static int RecordClear(string player)
    {
        var clears = ReadInt(ClearsKey(player)) + 1;
        LocalStorageService.SetItem(ClearsKey(player), clears.ToString(CultureInfo.InvariantCulture));
        return clears;
    }

    /// <summary>Cup titles won in this browser, by fighter id (only roster fighters, only positive counts).</summary>
    public static Dictionary<string, int> LoadTitles()
    {
        var titles = new Dictionary<string, int>();
        foreach (var pair in (LocalStorageService.GetItem<string>(TitlesKey) ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = pair.Split(':');
            if (parts.Length == 2 && PoBrawlRoster.IsRateable(parts[0]) && int.TryParse(parts[1], out var n) && n > 0) titles[parts[0]] = n;
        }
        return titles;
    }

    /// <summary>One more Cup title for <paramref name="championId"/>; returns the updated table.</summary>
    public static Dictionary<string, int> RecordTitle(string championId)
    {
        var titles = LoadTitles();
        titles[championId] = titles.GetValueOrDefault(championId) + 1;
        LocalStorageService.SetItem(TitlesKey, string.Join(',', titles.Select(kv => $"{kv.Key}:{kv.Value}")));
        return titles;
    }

    private static void Write(string player, PoBrawlProgressDto progress)
    {
        LocalStorageService.SetItem(LadderKey(player), progress.Rung.ToString(CultureInfo.InvariantCulture));
        LocalStorageService.SetItem(LadderAtKey(player), progress.UpdatedAtUnixMs.ToString(CultureInfo.InvariantCulture));
        LocalStorageService.SetItem(BestKoKey(player), progress.BestKoSeconds.ToString(CultureInfo.InvariantCulture));
        LocalStorageService.SetItem(ClearsKey(player), progress.Clears.ToString(CultureInfo.InvariantCulture));
    }

    private static int ReadInt(string key) =>
        int.TryParse(LocalStorageService.GetItem<string>(key), out var n) ? n : 0;
}
