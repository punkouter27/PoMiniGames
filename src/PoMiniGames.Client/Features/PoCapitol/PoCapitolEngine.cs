using System.Diagnostics.CodeAnalysis;
using Microsoft.JSInterop;

namespace PoMiniGamesClient.Features.PoCapitol;

/// <summary>
/// The typed C# side of PoCapitol's three.js engine (<c>window.PoCapitol</c>, from
/// <c>wwwroot/js/pocapitol/index.js</c>). Every call the page makes goes through one method here
/// instead of a string at the call site, so a renamed engine function breaks in one place, the
/// argument types are checked by the compiler, and the page reads as what it does
/// (<c>Engine.StartAsync(...)</c>) rather than how it reaches the browser.
/// </summary>
/// <remarks>
/// A thin wrapper on purpose: it adds no state and no error handling of its own, so each caller
/// still decides what a failed call means for the page (a <see cref="JSException"/> from the
/// engine, or <see cref="JSDisconnectedException"/> once the browser is gone).
/// </remarks>
public sealed class PoCapitolEngine(IJSRuntime js)
{
    private const string Root = "PoCapitol.";

    /// <summary>What JSInterop's deserialiser needs kept on a result type in the trimmed build.</summary>
    private const DynamicallyAccessedMemberTypes JsonMembers =
        DynamicallyAccessedMemberTypes.PublicConstructors | DynamicallyAccessedMemberTypes.PublicFields | DynamicallyAccessedMemberTypes.PublicProperties;

    /// <summary>Loads the engine module through the platform loader; false if it could not be fetched.</summary>
    public ValueTask<bool> LoadAsync() => js.InvokeAsync<bool>("loadEngine", "pocapitol");

    /// <summary>Builds a map in the host element: <c>capitol</c> (the grounds scenario) or <c>house</c> (the scanned house).</summary>
    public ValueTask InitAsync(string hostId, DotNetObjectReference<PoCapitolPage> page, string map) => Void("init", hostId, page, map);

    /// <summary>The map picked on the start card last time (<c>capitol</c> unless a known other one was stored).</summary>
    public ValueTask<string> GetMapAsync() => Get<string>("getMap");

    /// <summary>Remembers the map for the next visit; returns the id actually stored.</summary>
    public ValueTask<string> SetMapAsync(string map) => Get<string>("setMap", map);

    /// <summary>The House map's end-card figures; null on the Capitol map.</summary>
    public ValueTask<PoCapitolPage.HouseSummaryDto?> GetHouseSummaryAsync() => Get<PoCapitolPage.HouseSummaryDto?>("getHouseSummary");

    public ValueTask StartAsync(string difficulty, bool demo, string role) => Void("start", difficulty, demo, role);

    public ValueTask PauseAsync(bool paused) => Void("pause", paused);

    public ValueTask DisposeEngineAsync() => Void("dispose");

    public ValueTask InitRadarAsync(string canvasId) => Void("initRadar", canvasId);

    public ValueTask<string> GetGraphicsAsync() => Get<string>("getGraphics");

    public ValueTask<string> SetGraphicsAsync(string mode) => Get<string>("setGraphics", mode);

    public ValueTask<string> GetWeatherAsync() => Get<string>("getWeather");

    public ValueTask<string> SetWeatherAsync(string mode) => Get<string>("setWeather", mode);

    public ValueTask<bool> ToggleUnitLatchAsync() => Get<bool>("toggleUnitLatch");

    public ValueTask ClearUnitInspectAsync() => Void("clearUnitInspect");

    public ValueTask<PoCapitolPage.PrefsDto> GetPrefsAsync() => Get<PoCapitolPage.PrefsDto>("getPrefs");

    public ValueTask<PoCapitolPage.PrefsDto> SetPrefsAsync(PoCapitolPage.PrefsPatch patch) => Get<PoCapitolPage.PrefsDto>("setPrefs", patch);

    public ValueTask<PoCapitolPage.PrefsDto> RebindKeyAsync(string action, string code) => Get<PoCapitolPage.PrefsDto>("rebindKey", action, code);

    public ValueTask<PoCapitolPage.ReportDto> GetReportViewAsync() => Get<PoCapitolPage.ReportDto>("getReportView");

    public ValueTask<PoCapitolPage.DebriefDto?> GetDebriefAsync() => Get<PoCapitolPage.DebriefDto?>("getDebrief");

    public ValueTask<PoCapitolPage.ProbeDto> ProbeDebriefAsync() => Get<PoCapitolPage.ProbeDto>("probeDebrief");

    public ValueTask DownloadAsync(string fileName, string text) => Void("download", fileName, text);

    /// <summary>Saves bytes the page already holds (the server-drawn report card) as a file.</summary>
    public ValueTask DownloadBytesAsync(string fileName, byte[] bytes, string contentType) => Void("downloadBytes", fileName, bytes, contentType);

    public ValueTask<bool> ExportPngAsync(string svgId, string fileName) => Get<bool>("exportPng", svgId, fileName);

    public ValueTask<bool> CopyTextAsync(string text) => Get<bool>("copyText", text);

    public ValueTask<string> GetDiagnosticsTextAsync() => Get<string>("getDiagnosticsText");

    /// <summary>The attempt's time series for the report card, in the shape the API takes.</summary>
    public ValueTask<TReport> GetReportCardAsync<[DynamicallyAccessedMembers(JsonMembers)] TReport>() => Get<TReport>("getReportCard");

    /// <summary>Draws the aftermath map (WebGPU, TSL) into a canvas; false if it could not start.</summary>
    public ValueTask<bool> ShowAftermathAsync(string canvasId) => Get<bool>("showAftermath", canvasId);

    public ValueTask HideAftermathAsync() => Void("hideAftermath");

    /// <summary>One order from the incident commander's panel; returns the radio's reply (empty if refused silently).</summary>
    public ValueTask<string> GiveOrderAsync(string order, int line) => Get<string>("giveOrder", order, line);

    /// <summary>Steps the analysis overlay (off, density, contagion); returns the new mode.</summary>
    public ValueTask<string> CycleOverlayAsync() => Get<string>("cycleOverlay");

    /// <summary>Draws the attempt over OpenStreetMap (MapLibre) in an element; false if it could not load.</summary>
    public ValueTask<bool> ShowStreetMapAsync(string containerId) => Get<bool>("showStreetMap", containerId);

    public ValueTask HideStreetMapAsync() => Void("hideStreetMap");

    /// <summary>The attempt as GeoJSON text (crowd heat, rooms, lines, milestones).</summary>
    public ValueTask<string> GetGeoJsonAsync() => Get<string>("getGeoJson");

    private ValueTask Void(string name, params object?[] args) => js.InvokeVoidAsync(Root + name, args);

    private ValueTask<T> Get<[DynamicallyAccessedMembers(JsonMembers)] T>(string name, params object?[] args) => js.InvokeAsync<T>(Root + name, args);
}
