using System.Globalization;
using System.Text.Json;

namespace PoMiniGamesClient.Features.PoCabinet;

/// <summary>
/// Player-tunable settings for PoCabinet, the settings panel's view model and the one owner of
/// their <c>localStorage</c> entry (<see cref="StorageKey"/>). The engine never reads the store:
/// the page hands it these values (<see cref="ToJs"/>). Both directions go through the
/// source-generated <see cref="PoCabinetJsonContext"/> (camelCase), so a property here IS its JS
/// key. The defaults are the simplest race: clear weather, a light steering assist, no extras.
/// </summary>
public sealed class PoCabinetUiSettings
{
    public const string StorageKey = "pominigames:pocabinet-settings-v1";

    // No volume, mute, reduced-motion or colour-safe here: those are the app's
    // settings, not Cabinet's, and the engine reads them from the app.
    /// <summary>The adaptive race score (pocabinet/music.js). On by default; an older store without the key reads as on.</summary>
    public bool Music { get; set; } = true;
    public double HudScale { get; set; } = 1;
    /// <summary>"clear" or "rain" (rain also lowers grip).</summary>
    public string Weather { get; set; } = "clear";
    public string TouchControls { get; set; } = "auto";
    public string SteerMode { get; set; } = "pad";
    public double SteerSensitivity { get; set; } = 1;
    /// <summary>"off", "light" or "strong": blend the steering toward the centre line.</summary>
    public string SteeringAssist { get; set; } = "light";
    public bool AutoBrake { get; set; }
    /// <summary>
    /// The scanned tracks (the bedroom, the court): "splat" draws the full Gaussian-splat scan (a
    /// 9.6 MB download, heavier on phones), "mesh" the lite mesh it collides with, and "auto" (the
    /// default) the full scan on a desktop but only its light 2.4 MB version on a phone, a slow
    /// link or a data-saving browser (models.js <c>roomPlan</c>). JS key <c>roomDetail</c>.
    /// </summary>
    public string RoomDetail { get; set; } = "auto";
    /// <summary>
    /// Opt-in hardware compute &amp; UI shader backend: "auto" (WebGPU WGSL when available with
    /// WebGL2 fallback), "webgpu", or "webgl" (force WebGL2 path). JS key <c>gpuCompute</c>.
    /// </summary>
    public string GpuCompute { get; set; } = "auto";

    /// <summary>Parse the stored JSON; defaults for anything missing or out of range, unknown keys ignored.</summary>
    public static PoCabinetUiSettings FromJson(string? json)
    {
        PoCabinetUiSettings s;
        try { s = string.IsNullOrWhiteSpace(json) ? new() : JsonSerializer.Deserialize(json, PoCabinetJsonContext.Default.PoCabinetUiSettings) ?? new(); }
        catch (JsonException) { s = new(); }
        var d = new PoCabinetUiSettings();
        // A stale or hand-edited store can never poison a session. ("auto" weather, live D.C.,
        // was removed 2026-10-19: it reads as clear.)
        s.Weather = OneOf(s.Weather, d.Weather, "clear", "rain");
        s.TouchControls = OneOf(s.TouchControls, d.TouchControls, "auto", "on", "off");
        s.SteerMode = OneOf(s.SteerMode, d.SteerMode, "pad", "tilt");
        s.SteeringAssist = OneOf(s.SteeringAssist, d.SteeringAssist, "off", "light", "strong");
        s.RoomDetail = OneOf(s.RoomDetail, d.RoomDetail, "auto", "splat", "mesh");
        s.GpuCompute = OneOf(s.GpuCompute, d.GpuCompute, "auto", "webgpu", "webgl");
        s.HudScale = Clamp(s.HudScale, 0.8, 1.3, d.HudScale);
        s.SteerSensitivity = Clamp(s.SteerSensitivity, 0.5, 1.5, d.SteerSensitivity);
        return s;
    }

    public string ToJson() => JsonSerializer.Serialize(this, PoCabinetJsonContext.Default.PoCabinetUiSettings);

    /// <summary>The camelCase shape <c>PoCabinet.applySettings</c> and <c>startRace</c> read.</summary>
    public JsonElement ToJs() => JsonSerializer.SerializeToElement(this, PoCabinetJsonContext.Default.PoCabinetUiSettings);

    /// <summary>HudScale formatted invariantly for the <c>--pocabinet-hud</c> CSS custom property.</summary>
    public string HudScaleCss => HudScale.ToString(CultureInfo.InvariantCulture);

    private static string OneOf(string? value, string fallback, params string[] allowed) =>
        value is not null && allowed.Contains(value) ? value : fallback;

    private static double Clamp(double value, double lo, double hi, double fallback) =>
        double.IsFinite(value) ? Math.Clamp(value, lo, hi) : fallback;
}
