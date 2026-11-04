namespace PoMiniGames.Shared.Games;

/// <summary>
/// Display metadata for the themed PoCabinet tracks: the card's name, blurb, accent colour,
/// length and difficulty. Geometry (knots, width, atmosphere) lives next door in
/// <see cref="PoCabinetTrackGeometry"/>, keyed by the same ids. Track ids are lower-case,
/// kebab-friendly strings safe for URL paths.
/// </summary>
public sealed record PoCabinetTrackInfo(string Id, string Name, string Description, string Accent, int LengthKm, string Difficulty);

public static class PoCabinetCatalog
{
    /// <summary>Race laps on a circuit. Matches PoRacer's per-race length so leaderboard comparisons are
    /// apples-to-apples. A track can say otherwise (<see cref="PoCabinetTrackDefinition.Laps"/>): the
    /// point-to-point Playground run is 1.</summary>
    public const int TotalLaps = 3;

    /// <summary>Seats in a multiplayer race (players + AI officials). The per-tick snapshot is
    /// budgeted for this many cars, which is why online did not grow with the solo field.</summary>
    public const int CarCount = 8;

    /// <summary>Cars in a solo or demo race: 99 rivals and the player. The whole
    /// race runs in the browser, so only the lap verifier pays for it server-side.</summary>
    public const int SoloCarCount = 100;

    /// <summary>The player's grid slot in a solo race: mid-pack, quicker cars ahead and slower
    /// behind. Rival i takes slot i, or i + 1 from here back. Mirrors physics.js PLAYER_SLOT.</summary>
    public const int SoloPlayerSlot = 50;

    /// <summary>Solo places that mean something, now that "the podium" is 3 of 100 and the
    /// player starts 51st: the top ten earn the fanfare and count as a win, a top-quarter finish
    /// clears a campaign stage, and a top-ten finish in the final race wins the trophy. Set from
    /// headless runs in the real page with the throttle held and both driver aids on, which
    /// finished 4th-25th on the circuits and 15th on the Playground run: a stage takes a little
    /// more than that, the trophy takes driving.</summary>
    public const int SoloFrontRunners = 10;
    public const int CampaignPassPlace = 25;
    public const int CampaignTrophyPlace = 10;

    /// <summary>Default track when none is specified (matches the championship opening leg).</summary>
    public const string DefaultTrackId = "capitol";

    /// <summary>AI officials a multiplayer host can add to the grid.</summary>
    public const int MaxBots = 4;

    /// <summary>A multiplayer seat's paint when the player sent none.</summary>
    public const string DefaultSeatColor = "#3a7d44";

    /// <summary>The four AI officials, id and display name, in seat order. Their driving is
    /// PoCabinetPersonality.Roster on the server and physics.js OFFICIALS in the browser.</summary>
    public static IReadOnlyList<(string Id, string Name)> Officials { get; } =
    [
        ("sean-s", "Sean S."),
        ("steve-b", "Steve B."),
        ("bill-b", "Bill B."),
        ("mike-p", "Mike P."),
    ];

    /// <summary>An official's display name (the dialogue bubble, the grid); the id when unknown.</summary>
    public static string OfficialName(string? id)
    {
        foreach (var (officialId, name) in Officials)
        {
            if (officialId == id) return name;
        }
        return id ?? "";
    }

    public static IReadOnlyList<PoCabinetTrackInfo> Tracks { get; } = Array.AsReadOnly(new[]
    {
        new PoCabinetTrackInfo(
            "capitol",
            "Capitol Speedway",
            "Asphalt oval framed by marble columns and gold trim. Government-building backdrop.",
            "#d4af37", 3, "Easy"),
        new PoCabinetTrackInfo(
            "maralago",
            "Mar-a-Lago Grand Prix",
            "Palm-lined beachside course with golf-course greens and ocean mist.",
            "#2e7d4f", 4, "Medium"),
        new PoCabinetTrackInfo(
            "pressbriefing",
            "Press Briefing 500",
            "Podium-shaped stadium with press-box grandstands and klieg lights.",
            "#c0392b", 3, "Hard"),
        new PoCabinetTrackInfo(
            "playground",
            "Playground Marble Run",
            "Point-to-point down a giant play structure's marble run: off the top, round the banked turns, down the slide to the finish tray. One run.",
            "#f39c12", 3, "Medium"),
        new PoCabinetTrackInfo(
            "senate",
            "Senate Hill",
            "Autumn hill road course: a climb to a blind crest, a banked downhill hairpin, the esses, a filibuster chicane with raised kerbs and a split sweeper with a joker lane.",
            "#b3541e", 4, "Hard"),
        new PoCabinetTrackInfo(
            "bedroom",
            "Bedroom Floor GP",
            "Toy-car circuit on a scanned bedroom floor: past the drum kit and the closet, a banked ramp up onto the floor cushion, a drop off its end and an S round the office chair.",
            "#ff7a1a", 1, "Medium"),
    });

    /// <summary>The tracks that are campaign stages, in stage order (the first four of <see cref="Tracks"/>).</summary>
    public const int CampaignStages = 4;

    /// <summary>The campaign stage a track is (0-based), or -1 for a free race.</summary>
    public static int StageIndexOf(string? trackId)
    {
        for (int i = 0; i < CampaignStages; i++)
        {
            if (string.Equals(Tracks[i].Id, trackId, StringComparison.OrdinalIgnoreCase)) return i;
        }
        return -1;
    }

    public static PoCabinetTrackInfo GetTrack(string? id) =>
        PoCabinetDailyTrack.TryParse(id, out var day) ? Daily(day)
        : Tracks.FirstOrDefault(t => string.Equals(t.Id, id?.Trim(), StringComparison.OrdinalIgnoreCase)) ?? Tracks[0];

    /// <summary>A track a race may be run and a lap posted on: the fixed ones, and the daily
    /// circuit of yesterday, today or tomorrow (UTC).</summary>
    public static bool IsKnownTrack(string? id) =>
        Tracks.Any(t => string.Equals(t.Id, id?.Trim(), StringComparison.OrdinalIgnoreCase))
        || PoCabinetDailyTrack.IsCurrent(id, DateTime.UtcNow);

    /// <summary>The daily circuit's card: a new seeded layout each UTC day, the same for everyone.</summary>
    public static PoCabinetTrackInfo Daily(DateOnly day) => new(
        PoCabinetDailyTrack.IdFor(day),
        PoCabinetDailyTrack.NameFor(day),
        "Today's circuit, generated from the date: a new layout every day, the same hills, corners and run-off for every player, with its own leaderboard.",
        "#7b61ff", 3, "New every day");

    /// <summary>A lap or race time as the HUD, the cards and the results show it: m:ss.s.</summary>
    public static string FormatLap(double seconds)
    {
        if (double.IsNaN(seconds) || seconds < 0) return "0:00.0";
        var minutes = (int)(seconds / 60);
        return $"{minutes}:{seconds - minutes * 60:00.0}";
    }

    /// <summary>Today's daily circuit (UTC).</summary>
    public static PoCabinetTrackInfo Today(DateTime utcNow) => Daily(DateOnly.FromDateTime(utcNow));
}
