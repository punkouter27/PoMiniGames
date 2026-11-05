using System.Text.Json.Serialization;

namespace PoMiniGamesClient.Games.PoMarbleRace;

/// <summary>
/// What the intro card offers, as reported by <c>PoMarbleRace.menu()</c> (wwwroot/js/pomarblerace/
/// index.js). The engine owns all of it — maps.js the track list, marbles.js the skins and
/// weights, localStorage the stats — so the page describes nothing itself.
/// </summary>
public sealed class MarbleMenu
{
    public MarbleMapOption[] Maps { get; set; } = [];
    public int DefaultMap { get; set; } = 2;
    public MarbleSkinOption[] Skins { get; set; } = [];
    public MarbleWeightOption[] Weights { get; set; } = [];
    public int Best { get; set; }
    public Dictionary<string, MarbleTrackStat> Stats { get; set; } = [];
    public string Skin { get; set; } = "swirl";
    public string Weight { get; set; } = "balanced";
    /// <summary>HUD colours (marbles.js paletteHex): the page keeps no copy of its own.</summary>
    public MarblePalette Palette { get; set; } = new();
    /// <summary>The Settings drawer's switches as saved (store.js prefs, ghost and mute).</summary>
    public MarblePrefs Prefs { get; set; } = new();
}

public sealed class MarblePrefs
{
    public bool GhostOn { get; set; } = true;
    public bool Muted { get; set; }
    public bool Announcer { get; set; }
    public bool PerfHud { get; set; }
    /// <summary>"full" or "lite".</summary>
    public string Effects { get; set; } = "full";
    public bool TutorialSeen { get; set; }
}

public sealed class MarblePalette
{
    public string Player { get; set; } = "#ef4444";
    public string Guest { get; set; } = "#f8fafc";
    /// <summary>Pack colours; marble i (i &gt;= 1) takes Pack[(i - 1) % Pack.Length].</summary>
    public string[] Pack { get; set; } = [];
}

public sealed class MarbleMapOption
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public string Blurb { get; set; } = "";
}

public sealed class MarbleSkinOption
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    /// <summary>Best run score that unlocks it.</summary>
    public int Need { get; set; }
}

public sealed class MarbleWeightOption
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Hint { get; set; } = "";
}

public sealed class MarbleTrackStat
{
    public int Races { get; set; }
    public int Top10 { get; set; }
    public int Wins { get; set; }
    public int BestPlace { get; set; }
    public double BestTime { get; set; }
}

/// <summary>Source-generated, so the menu survives the WASM trim without reflection metadata.</summary>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(MarbleMenu))]
internal sealed partial class MarbleMenuJsonContext : JsonSerializerContext;
