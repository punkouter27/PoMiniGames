using System.Text.Json;

namespace PoMiniGamesClient.Features.PoCabinet;

/// <summary>
/// What the page reads from this browser before the engine is imported: the personal best per
/// track for the track list (records.js owns <c>pominigames:pocabinet-records-v1</c>; this only reads it)
/// and the stored paint job. Plain localStorage strings, parsed here.
/// </summary>
public static class PoCabinetPitWall
{
    public const string RecordsKey = "pominigames:pocabinet-records-v1";
    public const string PaintKey = "pominigames:pocabinet-paintshop-v1";

    /// <summary>Best lap per track id from records.js's store; unset or corrupt tracks are left out.</summary>
    public static Dictionary<string, double> ParseBestLaps(string? json)
    {
        var bests = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
        if (string.IsNullOrWhiteSpace(json)) return bests;
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return bests;
            foreach (var track in doc.RootElement.EnumerateObject())
            {
                if (track.Value.ValueKind == JsonValueKind.Object
                    && track.Value.TryGetProperty("bestLap", out var lap)
                    && lap.ValueKind == JsonValueKind.Number
                    && lap.GetDouble() is var seconds and > 0)
                {
                    bests[track.Name] = seconds;
                }
            }
        }
        catch (JsonException) { /* hand-edited or stale: no bests */ }
        return bests;
    }

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
}
