namespace PoMiniGames.Shared.Games;

/// <summary>
/// One track: its copy, its medal laps (seconds, best lap of a race) and the spline knots.
/// Medals are set against measured laps (a scripted keyboard driver, time trial) and
/// the floor a car can physically do: the centerline flat out at 320 units/s is 16.0 / 17.5 /
/// 17.7 s on the three tracks, and an inside line beats that. Gold needs a mostly clean lap on
/// the inside line, silver is a tidy centerline lap, bronze is getting round with a few hits.
/// The knots live here, not in the API's track registry, so the server sim and the client's
/// track-card outline are drawn from the same sixteen-odd points.
/// </summary>
public sealed record PoRacerTrackInfo(
    string Id, string Name, string Description,
    double Gold, double Silver, double Bronze,
    IReadOnlyList<(double X, double Y)> Knots)
{
    /// <summary>"gold" / "silver" / "bronze" for a lap that earns one, otherwise null.</summary>
    public string? Medal(double lapSeconds) =>
        !double.IsFinite(lapSeconds) || lapSeconds <= 0 ? null
        : lapSeconds <= Gold ? "gold" : lapSeconds <= Silver ? "silver" : lapSeconds <= Bronze ? "bronze" : null;
}

public static class PoRacerCatalog
{
    public const int TotalLaps = 3;
    /// <summary>Online race seats (players and AI together).</summary>
    public const int CarCount = 8;
    /// <summary>Cars in a solo or spectator-demo race.</summary>
    public const int SoloCarCount = 100;
    public const string DefaultTrackId = "circuit";
    public static readonly IReadOnlyList<string> Liveries = ["stripe", "dual", "carbon", "neon"];
    public static readonly IReadOnlyList<string> Difficulties = ["easy", "medium", "hard"];

    // Medal laps, measured with boost pads, the drift payout and impact damage in play
    // (a keyboard-only scripted driver through the real page, time trial): clean laps come out at
    // 14.2-14.8 s on the oval, 17.3 on the figure-8 with four wall touches, 16.6-16.8 on the rally
    // stage. Gold is a mostly clean lap on an inside line, silver a tidy one, bronze a lap with a few hits.
    public static IReadOnlyList<PoRacerTrackInfo> Tracks { get; } = Array.AsReadOnly(new[]
    {
        // Classic stadium oval — two long straights joined by tight 180° hairpins.
        new PoRacerTrackInfo("circuit", "Grand Prix Circuit", "Classic asphalt with sweeping bends and high grip.",
            Gold: 15.0, Silver: 17.5, Bronze: 22.0,
            Knots: [(0, 0), (400, 0), (800, 0), (1200, 0), (1500, 80), (1650, 280), (1650, 500), (1500, 700),
                (1200, 780), (800, 780), (400, 780), (0, 780), (-300, 700), (-450, 500), (-450, 280), (-300, 80)]),
        // Figure-8 — a wide fast loop and a tight technical one sharing the crossing at (800, 400).
        new PoRacerTrackInfo("neonskyline", "Neon Skyline", "Neon city streets with fast chicanes.",
            Gold: 17.0, Silver: 20.5, Bronze: 26.5,
            Knots: [(800, 400), (1000, 150), (1400, -50), (1800, 100), (1950, 400), (1800, 700), (1400, 850), (1000, 700),
                (800, 400), (600, 600), (300, 800), (50, 650), (-50, 400), (50, 150), (300, 0), (600, 150)]),
        // L-shaped rally stage — a long front straight, a sweeper, a hairpin and a chicane.
        new PoRacerTrackInfo("desertdustway", "Desert Dustway", "Wide hairpins and loose sand that rewards careful drifting.",
            Gold: 17.0, Silver: 21.5, Bronze: 27.5,
            Knots: [(0, 0), (700, 0), (1400, 0), (1750, 200), (1850, 500), (1750, 800), (1200, 950), (600, 950),
                (100, 950), (-150, 800), (-300, 600), (-100, 400), (-300, 200), (-200, 50)]),
        // Switchbacks: four legs joined by hairpins, and a main straight along y = 0 that cuts
        // across all four of them at right angles (x = -480, -160, 160, 480). Seven turns and
        // four crossings. The knots are 130 units apart along that path, so the spline keeps
        // every hairpin's radius at about half the track width or more. The centerline flat out
        // is 21.1 s, which no car can do through the hairpins; the scripted keyboard driver's
        // time-trial lap through the real page is 29.2 s. Gold is a lap that takes the hairpins
        // tighter than that driver does, silver is about its lap with a few hits.
        new PoRacerTrackInfo("crossfire", "Crossfire Switchbacks", "Seven tight turns, and a main straight that cuts across all four legs.",
            Gold: 28.0, Silver: 32.0, Bronze: 40.0,
            Knots: [(-710, 0), (-580, 0), (-450, 0), (-320, 0), (-190, 0), (-60, 0), (70, 0), (200, 0), (330, 0), (460, 0),
                (590, 0), (720, 0), (850, -1), (956, -68), (973, -196), (888, -288), (760, -300), (630, -300),
                (515, -240), (480, -120), (480, 10), (480, 140), (479, 270), (415, 379), (293, 408), (184, 335),
                (160, 210), (160, 80), (160, -50), (160, -180), (149, -308), (61, -398), (-65, -396), (-152, -299),
                (-160, -170), (-160, -40), (-160, 90), (-160, 220), (-190, 343), (-298, 408), (-419, 376), (-479, 265),
                (-480, 130), (-480, 0), (-480, -130), (-522, -248), (-635, -300), (-765, -300), (-897, -284),
                (-975, -187), (-953, -64), (-845, -1)]),
    });

    public static PoRacerTrackInfo GetTrack(string? id) =>
        Tracks.FirstOrDefault(t => string.Equals(t.Id, id?.Trim(), StringComparison.OrdinalIgnoreCase)) ?? Tracks[0];
}

/// <summary>
/// The weather of the day on a Racer track: one draw per track and UTC day, so everyone who races
/// a track on the same day drives it in the same conditions. The server decides it (the sim turns
/// it into grip) and sends it with the track; the start card calls the same function to say what
/// is coming. The hash and the shares are the ones js/weather.js has always used for the overlay
/// (FNV-1a over <c>"trackId"yyyy-MM-dd</c>: 58% clear, 25% rain, 11% snow, 6% fog).
/// </summary>
public static class PoRacerWeather
{
    public const string Clear = "clear", Rain = "rain", Snow = "snow", Fog = "fog";

    public static string For(string trackId, DateOnly utcDay)
    {
        var seed = "\"" + trackId + "\"" + utcDay.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
        uint h = 2166136261;
        foreach (var ch in seed) { h ^= ch; unchecked { h *= 16777619; } }
        return (h % 100) switch { < 58 => Clear, < 83 => Rain, < 94 => Snow, _ => Fog };
    }

    public static string Today(string trackId) => For(trackId, DateOnly.FromDateTime(DateTime.UtcNow));

    /// <summary>Tyre grip, 1 = dry. Rain and snow cost braking, turn-in and traction; fog is only harder to see through.</summary>
    public static double Grip(string? weather) => weather switch { Rain => 0.90, Snow => 0.80, _ => 1.0 };

    /// <summary>What a driver is told, or null when there is nothing to say (a clear day).</summary>
    public static string? Note(string? weather) => weather switch
    {
        Rain => "Rain: longer braking, less grip",
        Snow => "Snow: very little grip",
        Fog => "Fog: full grip, harder to see",
        _ => null,
    };
}
