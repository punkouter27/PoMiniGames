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

    public ValueTask InitAsync(string hostId, DotNetObjectReference<PoCapitolPage> page) => Void("init", hostId, page);

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

    private ValueTask Void(string name, params object?[] args) => js.InvokeVoidAsync(Root + name, args);

    private ValueTask<T> Get<[DynamicallyAccessedMembers(JsonMembers)] T>(string name, params object?[] args) => js.InvokeAsync<T>(Root + name, args);
}
