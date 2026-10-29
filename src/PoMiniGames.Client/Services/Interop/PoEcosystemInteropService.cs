using System.Text.Json;
using Microsoft.JSInterop;
using PoMiniGames.Shared.Games.PoEcosystem;
using PoMiniGamesClient.Games.PoEcosystem.Models;

using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Interop;

/// <summary>
/// Bridge to <c>window.PoEcosystem</c> (wwwroot/js/poecosystem/index.js). A
/// <see cref="DotNetObjectReference{T}"/> is handed to the engine, its callbacks
/// are re-raised as C# events, and dispose swallows
/// <see cref="JSDisconnectedException"/> because the circuit may already be gone.
///
/// The engine is loaded through <c>engineLoader.js</c> (route-gated), so nothing here runs
/// until a page actually mounts the game.
/// </summary>
public sealed class PoEcosystemInteropService : IAsyncDisposable
{
    private readonly IJSRuntime _js;
    private DotNetObjectReference<PoEcosystemInteropService>? _self;
    private bool _started;

    public PoEcosystemInteropService(IJSRuntime js) => _js = js;

    public event Action<int, int, bool, string, int>? Ready;     // seed, tick, resumed, physics kind, visited year (-1 = the present)
    /// <summary>The finder's answer (living creatures, at most a dozen).</summary>
    public event Action<IReadOnlyList<EcoFound>>? Found;
    /// <summary>The time machine's decades changed, or the world moved between past and present.</summary>
    public event Action<EcoKeyframes>? KeyframesReceived;
    public event Action<EcoStats>? StatsReceived;
    public event Action<IReadOnlyList<EcoEvent>>? EventsReceived;
    public event Action<IReadOnlyList<EcoThought>>? ThoughtsReceived;   // island-wide thought feed
    public event Action<EcoDetail?>? DetailReceived;
    public event Action<int, EcoLineage?>? LineageReceived;      // handle, tree (null when forgotten)
    public event Action<int>? Picked;
    public event Action<int>? SpeedChanged;
    public event Action<string, string?>? ActionRequested;       // dashboard, escape, map, pointerLock…
    public event Action<bool, string>? DirectorChanged;          // on, caption
    public event Action<bool>? PipChanged;
    public event Action<int, string>? Saved;
    public event Action<string, string>? EngineError;
    /// <summary>The engine has a gzip'd snapshot ready for the cloud (slot, bytes).</summary>
    public event Action<string, byte[]>? SnapshotExported;
    /// <summary>The timeline grew (a landmark or a year row was added).</summary>
    public event Action<EcoHistory>? HistoryReceived;

    /// <summary>Is there a world in IndexedDB to resume?</summary>
    public async ValueTask<EcoSaveInfo> ProbeSaveAsync()
    {
        try
        {
            if (!await LoadEngineAsync()) return new EcoSaveInfo(false, 0, 0, 0, 0, null);
            var json = await _js.InvokeAsync<string?>("JSON.stringify", await _js.InvokeAsync<object>("PoEcosystem.probeSave"));
            if (string.IsNullOrWhiteSpace(json)) return new EcoSaveInfo(false, 0, 0, 0, 0, null);
            return JsonSerializer.Deserialize(json, EcoJsonContext.Default.EcoSaveInfo) ?? new EcoSaveInfo(false, 0, 0, 0, 0, null);
        }
        catch (JSException) { return new EcoSaveInfo(false, 0, 0, 0, 0, null); }
        catch (JSDisconnectedException) { return new EcoSaveInfo(false, 0, 0, 0, 0, null); }
    }

    /// <param name="ephemeral">Nothing this boot does is saved: a demo, or a visit to a shared island.
    /// The island this browser already holds is left as it was.</param>
    public async ValueTask<bool> StartAsync(string containerId, string? minimapId, string? seed, bool resume, bool lowEnd, bool demo = false, bool ephemeral = false)
    {
        if (!await LoadEngineAsync()) return false;
        _self ??= DotNetObjectReference.Create(this);
        var options = new Dictionary<string, object?>
        {
            ["seed"] = seed ?? string.Empty,
            ["resume"] = resume,
            ["lowEnd"] = lowEnd,
            ["minimapId"] = minimapId,
            ["demo"] = demo,
            ["ephemeral"] = ephemeral,
        };
        _lastPopHistory = [];
        _lastTraitHistory = null;
        _started = await _js.InvokeAsync<bool>("PoEcosystem.start", containerId, _self, options);
        return _started;
    }

    // ── stats histories ──────────────────────────────────────────────────
    // popHistory / traitHistory are most of a stats message and only the dashboard's
    // timeline and evolution charts read them, so the engine sends them (as raw bytes) only
    // while one of those is on screen. In between, StatsReceived carries the last ones seen.
    private bool? _historyWanted;
    private int[] _lastPopHistory = [];
    private double[]? _lastTraitHistory;

    /// <summary>Ask the engine to include (or stop including) the stats histories. Deduped.</summary>
    public async ValueTask SetHistoryWantedAsync(bool on)
    {
        if (!_started || _historyWanted == on) return;
        _historyWanted = on;
        await SafeInvokeAsync("PoEcosystem.setHistoryWanted", on);
    }

    public ValueTask SetSpeedAsync(int speed) => SafeInvokeAsync("PoEcosystem.setSpeed", speed);
    public ValueTask SelectAsync(int handle) => SafeInvokeAsync("PoEcosystem.select", handle);
    public ValueTask FollowAsync(int handle) => SafeInvokeAsync("PoEcosystem.follow", handle);
    public ValueTask NewWorldAsync(string? seed) => SafeInvokeAsync("PoEcosystem.newWorld", seed ?? string.Empty);
    public ValueTask SaveNowAsync() => SafeInvokeAsync("PoEcosystem.saveNow");
    public ValueTask DebugAsync(string op) => SafeInvokeAsync("PoEcosystem.debug", op);
    public ValueTask ExportTelemetryAsync() => SafeInvokeAsync("PoEcosystem.exportTelemetry");
    public ValueTask SetSoundAsync(bool on) => SafeInvokeAsync("PoEcosystem.setSound", on);
    public ValueTask RequestLockAsync() => SafeInvokeAsync("PoEcosystem.requestLock");
    /// <summary>Back to free-look after the finder — only if the pointer was locked when it opened.</summary>
    public ValueTask RestoreLockAsync() => SafeInvokeAsync("PoEcosystem.restoreLock");
    public ValueTask ToggleFlyAsync() => SafeInvokeAsync("PoEcosystem.toggleFly");
    public ValueTask SetCameraPoseAsync(double x, double y, double z, double pitch, double yaw) =>
        SafeInvokeAsync("PoEcosystem.setPose", new { x, y, z, pitch, yaw });
    public ValueTask TouchMoveAsync(double x, double z) => SafeInvokeAsync("PoEcosystem.touchMove", x, z);
    public ValueTask TouchReleaseAsync() => SafeInvokeAsync("PoEcosystem.touchRelease");

    // ── lineage · watch-list · naming ────────────────────────────────────
    public ValueTask RequestLineageAsync(int handle) => SafeInvokeAsync("PoEcosystem.lineage", handle);
    public ValueTask RenameAsync(int handle, string name) => SafeInvokeAsync("PoEcosystem.rename", handle, name);
    public ValueTask WatchAsync(int handle, bool on) => SafeInvokeAsync("PoEcosystem.watch", handle, on);

    // ── lenses · director · pop-out ──────────────────────────────────────
    /// <summary>Colour every creature through a lens (<see cref="EcoLens"/>): a trait 0–4, hunger, health, thermal, kin, or -1 for species colours.</summary>
    public ValueTask SetLensAsync(int lens) => SafeInvokeAsync("PoEcosystem.setTint", lens);

    // ── finder · map layers · ticker · ambient · time machine ──
    /// <summary>Ask the sim for living creatures matching <paramref name="text"/>; answered on <see cref="Found"/>.</summary>
    public ValueTask FindAsync(string text, string sort) => SafeInvokeAsync("PoEcosystem.find", text, sort);
    /// <summary>The minimap's data layer (<see cref="EcoMapLayer"/> ids).</summary>
    public ValueTask SetLayerAsync(string layer) => SafeInvokeAsync("PoEcosystem.setLayer", layer);
    /// <summary>A quiet line under the status chip — the island's news that is not worth a toast.</summary>
    public ValueTask TickerAsync(string text) => SafeInvokeAsync("PoEcosystem.ticker", text);
    /// <summary>Ambient mode: the director films, the HUD goes away, the screen stays awake.</summary>
    public ValueTask SetAmbientAsync(bool on) => SafeInvokeAsync("PoEcosystem.setAmbient", on);
    /// <summary>Open a kept decade of this island, read-only. The present is saved first.</summary>
    public ValueTask OpenKeyframeAsync(int year) => SafeInvokeAsync("PoEcosystem.openKeyframe", year);
    /// <summary>Leave a visit (a past decade, or a shared island) for the island saved in this browser.</summary>
    public ValueTask ReturnHomeAsync() => SafeInvokeAsync("PoEcosystem.returnHome");
    /// <summary>Play population rows ([rabbits, deer, wolves, humans] each) as chords.</summary>
    public ValueTask SonifyAsync(int[][] rows, int peak) =>
        SafeInvokeAsync("PoEcosystem.sonify", JsonSerializer.Serialize(rows, EcoJsonContext.Default.Int32ArrayArray), peak);
    /// <summary>Print the field journal (the engine builds the page in a throwaway frame).</summary>
    public ValueTask PrintJournalAsync(EcoJournalPrint journal) =>
        SafeInvokeAsync("PoEcosystem.printJournal", JsonSerializer.Serialize(journal, EcoJsonContext.Default.EcoJournalPrint));

    /// <summary>A map of the island a seed makes, as a data URL ("" when it cannot be drawn).</summary>
    public async ValueTask<string> IslandThumbAsync(int seed)
    {
        try { return await LoadEngineAsync() ? await _js.InvokeAsync<string>("PoEcosystem.islandThumb", seed) ?? "" : ""; }
        catch (JSException) { return ""; }
        catch (JSDisconnectedException) { return ""; }
    }

    /// <summary>The per-year rows inside a gzip'd snapshot, without booting it (the gallery's compare view).</summary>
    public async ValueTask<EcoIslandPeek?> PeekHistoryAsync(byte[] bytes)
    {
        try
        {
            if (!await LoadEngineAsync()) return null;
            var json = await _js.InvokeAsync<string?>("PoEcosystem.peekHistory", bytes);
            return string.IsNullOrWhiteSpace(json) ? null : Deserialize(json, EcoJsonContext.Default.EcoIslandPeek);
        }
        catch (JSException) { return null; }
        catch (JSDisconnectedException) { return null; }
    }

    /// <summary>Share a link through the platform's share sheet, else copy it: "shared", "copied" or "failed".</summary>
    public async ValueTask<string> ShareLinkAsync(string title, string text, string url)
    {
        try { return await LoadEngineAsync() ? await _js.InvokeAsync<string>("PoEcosystem.share", title, text, url) ?? "failed" : "failed"; }
        catch (JSException) { return "failed"; }
        catch (JSDisconnectedException) { return "failed"; }
    }
    public ValueTask SetDirectorAsync(bool on) => SafeInvokeAsync("PoEcosystem.setDirector", on);
    public ValueTask TogglePipAsync() => SafeInvokeAsync("PoEcosystem.togglePip");
    /// <summary>Open or close the Island Reel drawer (engine-owned DOM: clips, photos).</summary>
    public ValueTask ToggleReelAsync() => SafeInvokeAsync("PoEcosystem.toggleReel");

    // ── cloud saves ──────────────────────────────────────────────────────
    /// <summary>Ask the engine for a gzip'd snapshot; it answers through <see cref="SnapshotExported"/>.</summary>
    public ValueTask ExportSnapshotAsync(string slot) => SafeInvokeAsync("PoEcosystem.exportSnapshot", slot);
    /// <summary>Boot a world from gzip'd snapshot bytes. Ephemeral worlds never autosave over the local one.</summary>
    public ValueTask ImportSnapshotAsync(byte[] bytes, bool ephemeral) => SafeInvokeAsync("PoEcosystem.importSnapshot", bytes, ephemeral);

    // ── camera ───────────────────────────────────────────────────────────
    public ValueTask FlyToAsync(double x, double z) => SafeInvokeAsync("PoEcosystem.flyTo", x, z);
    /// <summary>Keep the auto-director off while something (the tour) needs the camera still.</summary>
    public ValueTask HoldDirectorAsync(bool on) => SafeInvokeAsync("PoEcosystem.holdDirector", on);

    // ── viewing settings (engine-owned prefs) ────────────────────────────
    public async ValueTask<EcoSettings?> SettingsAsync()
    {
        if (!_started) return null;
        try
        {
            var json = await _js.InvokeAsync<string?>("JSON.stringify", await _js.InvokeAsync<object?>("PoEcosystem.settings"));
            return string.IsNullOrWhiteSpace(json) ? null : Deserialize(json, EcoJsonContext.Default.EcoSettings);
        }
        catch (JSException) { return null; }
        catch (JSDisconnectedException) { return null; }
    }

    public ValueTask SetQualityAsync(string tier) => SafeInvokeAsync("PoEcosystem.setQuality", tier);
    public ValueTask SetBindingAsync(string action, string code) => SafeInvokeAsync("PoEcosystem.setBinding", action, code);
    public ValueTask ResetBindingsAsync() => SafeInvokeAsync("PoEcosystem.resetBindings");

    /// <summary>The next key the player presses (KeyboardEvent.code), or null on Escape / timeout.</summary>
    public async ValueTask<string?> CaptureKeyAsync()
    {
        if (!_started) return null;
        try { return await _js.InvokeAsync<string?>("PoEcosystem.captureKey"); }
        catch (JSException) { return null; }
        catch (JSDisconnectedException) { return null; }
    }

    /// <summary>Field-guide cards for the four species (iNaturalist + Wikipedia, cached a week).</summary>
    public async ValueTask<EcoSpeciesCard[]> SpeciesInfoAsync()
    {
        try
        {
            if (!await LoadEngineAsync()) return [];
            var json = await _js.InvokeAsync<string?>("PoEcosystem.speciesInfo");
            return string.IsNullOrWhiteSpace(json) ? [] : Deserialize(json, EcoJsonContext.Default.EcoSpeciesCardArray) ?? [];
        }
        catch (JSException) { return []; }
        catch (JSDisconnectedException) { return []; }
    }

    /// <summary>Current ambience preference (engine-side, persisted in localStorage).</summary>
    public async ValueTask<bool> SoundEnabledAsync()
    {
        try { return await _js.InvokeAsync<bool>("PoEcosystem.soundEnabled"); }
        catch (JSException) { return true; }
        catch (JSDisconnectedException) { return true; }
    }

    // ── callbacks from the engine ────────────────────────────────────────
    [JSInvokable] public void OnReady(int seed, int tick, bool resumed, string physics, int past) => Ready?.Invoke(seed, tick, resumed, physics, past);

    [JSInvokable]
    public void OnFound(string json) => Found?.Invoke(Deserialize(json, EcoJsonContext.Default.EcoFoundArray) ?? []);

    [JSInvokable]
    public void OnKeyframes(string json)
    {
        var frames = Deserialize(json, EcoJsonContext.Default.EcoKeyframes);
        if (frames is not null) KeyframesReceived?.Invoke(frames);
    }

    /// <param name="popHistory">Int16 little-endian, [sample * 4 + species]; null when the page did not ask.</param>
    /// <param name="traitHistory">Float32 little-endian, [sample * 20 + species * 5 + trait]; null likewise.</param>
    [JSInvokable]
    public void OnStats(string json, byte[]? popHistory, byte[]? traitHistory)
    {
        var stats = Deserialize(json, EcoJsonContext.Default.EcoStats);
        if (stats is null) return;
        if (popHistory is not null) _lastPopHistory = DecodeInt16(popHistory);
        if (traitHistory is not null) _lastTraitHistory = DecodeFloat32(traitHistory);
        StatsReceived?.Invoke(stats with { PopHistory = _lastPopHistory, TraitHistory = _lastTraitHistory });
    }

    internal static int[] DecodeInt16(ReadOnlySpan<byte> bytes)
    {
        var src = System.Runtime.InteropServices.MemoryMarshal.Cast<byte, short>(bytes[..(bytes.Length & ~1)]);
        var dst = new int[src.Length];
        for (var i = 0; i < src.Length; i++) dst[i] = src[i];
        return dst;
    }

    internal static double[] DecodeFloat32(ReadOnlySpan<byte> bytes)
    {
        var src = System.Runtime.InteropServices.MemoryMarshal.Cast<byte, float>(bytes[..(bytes.Length & ~3)]);
        var dst = new double[src.Length];
        for (var i = 0; i < src.Length; i++) dst[i] = src[i];
        return dst;
    }

    [JSInvokable]
    public void OnEvents(string json)
    {
        var events = Deserialize(json, EcoJsonContext.Default.EcoEventArray);
        if (events is { Length: > 0 }) EventsReceived?.Invoke(events);
    }

    [JSInvokable]
    public void OnThoughts(string json)
    {
        var thoughts = Deserialize(json, EcoJsonContext.Default.EcoThoughtArray);
        if (thoughts is { Length: > 0 }) ThoughtsReceived?.Invoke(thoughts);
    }

    [JSInvokable]
    public void OnDetail(string? json) =>
        DetailReceived?.Invoke(string.IsNullOrEmpty(json) ? null : Deserialize(json, EcoJsonContext.Default.EcoDetail));

    [JSInvokable]
    public void OnLineage(int handle, string? json) =>
        LineageReceived?.Invoke(handle, string.IsNullOrEmpty(json) ? null : Deserialize(json, EcoJsonContext.Default.EcoLineage));

    [JSInvokable] public void OnPick(int handle) => Picked?.Invoke(handle);
    [JSInvokable] public void OnSpeed(int speed) => SpeedChanged?.Invoke(speed);
    [JSInvokable] public void OnAction(string action, string? value) => ActionRequested?.Invoke(action, value);
    [JSInvokable] public void OnDirector(bool on, string? caption) => DirectorChanged?.Invoke(on, caption ?? string.Empty);
    [JSInvokable] public void OnPip(bool on) => PipChanged?.Invoke(on);
    [JSInvokable] public void OnSaved(int tick, string reason) => Saved?.Invoke(tick, reason);
    [JSInvokable] public void OnEngineError(string where, string message) => EngineError?.Invoke(where, message);
    [JSInvokable] public void OnSnapshotBytes(string slot, byte[] bytes) => SnapshotExported?.Invoke(slot, bytes);

    [JSInvokable]
    public void OnHistory(string json)
    {
        var history = Deserialize(json, EcoJsonContext.Default.EcoHistory);
        if (history is not null) HistoryReceived?.Invoke(history);
    }

    private async ValueTask<bool> LoadEngineAsync()
    {
        try { return await _js.InvokeAsync<bool>("loadEngine", "poecosystem"); }
        catch (JSException) { return false; }
        catch (JSDisconnectedException) { return false; }
    }

    private async ValueTask SafeInvokeAsync(string identifier, params object?[] args)
    {
        if (!_started) return;
        try { await _js.InvokeVoidAsync(identifier, args); }
        catch (JSException) { /* the engine is gone or not started */ }
        catch (JSDisconnectedException) { /* circuit closed */ }
    }

    private static T? Deserialize<T>(string json, System.Text.Json.Serialization.Metadata.JsonTypeInfo<T> info)
    {
        try { return JsonSerializer.Deserialize(json, info); }
        catch (JsonException) { return default; }
    }

    public async ValueTask DisposeAsync()
    {
        if (_started)
        {
            try { await _js.InvokeVoidAsync("PoEcosystem.stop"); }
            catch (JSException) { /* ignore */ }
            catch (JSDisconnectedException) { /* ignore */ }
        }
        _self?.Dispose();
        _self = null;
        _started = false;
    }
}
