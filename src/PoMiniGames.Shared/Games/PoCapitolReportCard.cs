namespace PoMiniGames.Shared.Games;

/// <summary>
/// What the PoCapitol after-action recorder (<c>wwwroot/js/pocapitol/report.js</c>) hands the
/// report-card renderer: the attempt's summary plus three bounded series sampled over it.
/// Nothing here is stored or tied to a player; it is drawn once into a PNG.
/// </summary>
public sealed class PoCapitolReportCardRequest
{
    /// <summary>Longest series the server accepts; the client resamples to fit.</summary>
    public const int MaxSamples = 240;

    public string Outcome { get; set; } = string.Empty;
    /// <summary>"raider", "police" or "none".</summary>
    public string Role { get; set; } = "none";
    /// <summary>"solo" or "demo".</summary>
    public string Mode { get; set; } = "solo";
    public string Difficulty { get; set; } = string.Empty;
    /// <summary>The in-game clock at the end, e.g. "3:12 pm"; empty when unknown.</summary>
    public string Clock { get; set; } = string.Empty;
    public double Minutes { get; set; }
    public int Standing { get; set; }
    public int Police { get; set; }
    public int Casualties { get; set; }
    public double LowestIntegrity { get; set; } = 100;
    public double PeakPressure { get; set; }
    /// <summary>How many milestones were crossed.</summary>
    public int Milestones { get; set; }
    /// <summary>Police-line integrity, 0 to 100, over the attempt.</summary>
    public float[] Integrity { get; set; } = [];
    /// <summary>Crowd pressure on the line over the attempt (0 and up).</summary>
    public float[] Pressure { get; set; } = [];
    /// <summary>World z of the active police line over the attempt.</summary>
    public float[] FrontZ { get; set; } = [];
}
