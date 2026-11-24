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
    public const int SoloCarCount = 64;
    public const string DefaultTrackId = "circuit";
    public static readonly IReadOnlyList<string> Liveries = ["stripe", "dual", "carbon", "neon"];
    public static readonly IReadOnlyList<string> Difficulties = ["easy", "medium", "hard"];

    // Consolidated Grand Prix circuit combining all three signature styles:
    // stadium front straight & sweeper, desert wide hairpin with sand run-off, and neon S-chicane.
    public static IReadOnlyList<PoRacerTrackInfo> Tracks { get; } = Array.AsReadOnly(new[]
    {
        new PoRacerTrackInfo("circuit", "Grand Prix Circuit", "Stadium straights, desert sand hairpin, and fast neon S-chicanes in one circuit.",
            Gold: 17.5, Silver: 21.0, Bronze: 26.5,
            Knots: [
                // Sector 1: Grand Prix stadium straight & fast sweeper
                (0, 0), (450, 0), (900, 0), (1350, 0), (1720, 120), (1880, 360),
                // Sector 2: Desert Dustway wide hairpin (sand run-off on outer apex)
                (1850, 680), (1550, 920), (1120, 960),
                // Sector 3: Neon Skyline fast technical S-chicane
                (740, 820), (440, 600), (120, 820), (-220, 860),
                // Sector 4: Stadium return sweeper back to start/finish
                (-480, 640), (-520, 320), (-340, 80),
            ]),
    });

    public static PoRacerTrackInfo GetTrack(string? id) =>
        Tracks.FirstOrDefault(t => string.Equals(t.Id, id?.Trim(), StringComparison.OrdinalIgnoreCase)) ?? Tracks[0];
}

/// <summary>
/// The weather of the day on a Racer track: one draw per track and UTC day, so everyone who races
/// a track on the same day drives it in the same conditions. The server decides it (the sim turns
/// it into grip) and sends it with the track; the start card calls the same function to say what
/// is coming. The hash and the shares are the ones js/platform/weather.js has always used for the overlay
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
