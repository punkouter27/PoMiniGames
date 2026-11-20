namespace PoMiniGamesClient.Features.PoCabinet;

/// <summary>
/// What the page reads from this browser before the engine is imported: the stored paint job.
/// Plain localStorage strings, parsed here.
/// </summary>
public static class PoCabinetPitWall
{
    public const string PaintKey = "pominigames:pocabinet-paintshop-v1";
    public const string LiveryKey = "pominigames:pocabinet-livery-v1";

    /// <summary>
    /// The paint shop's stored colour name, or null when unset. A store from before 2026-10-19
    /// holds "&lt;livery&gt;|&lt;color&gt;"; its colour is kept and the pattern dropped.
    /// </summary>
    public static string? ParsePaint(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var color = raw[(raw.LastIndexOf('|') + 1)..].Trim();
        return color.Length > 0 ? color : null;
    }

    /// <summary>The paint shop's stored livery pattern index (0..4), defaulting to 1 (Twin Stripes).</summary>
    public static int ParseLivery(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return 1;
        return int.TryParse(raw.Trim(), out var index) && index is >= 0 and <= 4 ? index : 1;
    }
}
