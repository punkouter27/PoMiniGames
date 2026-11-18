using System.Text.Json;

using Microsoft.JSInterop;

using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Ui;

/// <summary>
/// Global app settings shared by every game: master mute and
/// volume, haptics and reduced motion. Persisted as plain localStorage values
/// (<c>pominigames:muted</c>, <c>pominigames:volume</c>,
/// <c>pominigames:sfx-volume</c>, <c>pominigames:music-volume</c>,
/// <c>pominigames:haptics</c>, <c>pominigames:reduced-motion</c>) so JS modules (uiAudio.js,
/// audioBus.js, the index.html pre-paint motion script, game engines) can read
/// them directly without an interop round-trip.
/// </summary>
/// <remarks>
/// <para>
/// The setters sit behind <c>Features/Shared/Modals/SettingsSheet.razor</c>, a dialog rather
/// than a page, which also covers <c>pominigames:color-safe</c>. A fresh browser gets
/// the defaults below (unmuted, full volume, haptics on, motion
/// unreduced, standard palettes).
/// </para>
/// <para>
/// Volume and mute are enforced on the JS side — audioBus.js owns both the gain
/// node and the persisted keys — so their setters only call through; writing
/// the keys here as well would be a second writer that could disagree.
/// </para>
/// <para>
/// The FPS badge used to be gated here too (<c>pomini_showfps</c>, default off).
/// It is now unconditional in the top bar, so the flag is gone — see
/// Features/Shared/Shell/FpsCounter.razor. The "show game intros" flag went the same way:
/// the controls card now opens every 1-player game.
/// </para>
/// </remarks>
public sealed class SettingsService : IAsyncDisposable
{
    private const string MutedKey = "pominigames:muted";
    private const string VolumeKey = "pominigames:volume";
    private const string SfxVolumeKey = "pominigames:sfx-volume";
    private const string MusicVolumeKey = "pominigames:music-volume";
    private const string HapticsKey = "pominigames:haptics";
    private const string ReducedMotionKey = "pominigames:reduced-motion";
    private const string ColorSafeKey = "pominigames:color-safe";
    private const string RichAudioKey = "pominigames:rich-audio";
    private const string VoiceAnnouncerKey = "pominigames:voice-announcer";
    // Owned by wwwroot/js/platform/qualityTiers.js; read here only to show the current choice.
    private const string GraphicsKey = "pominigames:fx-tier";

    /// <summary>The graphics choices the sheet offers. "auto" lets the device decide.</summary>
    public static readonly string[] GraphicsTiers = ["auto", "low", "medium", "high"];

    private readonly Lazy<Task<IJSObjectReference>> _prefs;
    private bool _disposed;

    /// <summary>Raised after any setting changes so the sheet and game pages can react.</summary>
    public event Action? Changed;

    /// <summary>
    /// Raised to open the settings sheet. The sheet lives in MainLayout; anything that wants
    /// to offer a way in (the footer, the hub's action row) calls <see cref="RequestOpen"/>.
    /// </summary>
    public event Action? OpenRequested;

    public void RequestOpen() => OpenRequested?.Invoke();

    public SettingsService(IJSRuntime js)
    {
        _prefs = new Lazy<Task<IJSObjectReference>>(() =>
            js.InvokeAsync<IJSObjectReference>("import", "./js/platform/appPrefs.js").AsTask());
    }

    public bool Muted { get; private set; }

    /// <summary>Master output volume as a percentage, 0–100.</summary>
    public int Volume { get; private set; } = 100;

    /// <summary>Effects level (UI and game sounds) under the master, 0–100.</summary>
    public int SfxVolume { get; private set; } = 100;

    /// <summary>Adaptive music level, 0–100. Off by default: music is opt-in.</summary>
    public int MusicVolume { get; private set; }

    /// <summary>Whether vibration cues fire on devices that support them.</summary>
    public bool Haptics { get; private set; } = true;

    /// <summary>
    /// The user's own request for less motion. Independent of the OS
    /// <c>prefers-reduced-motion</c> setting, which always applies on its own —
    /// this being false never re-enables motion for someone whose OS asked to
    /// reduce it.
    /// </summary>
    public bool ReducedMotion { get; private set; }

    /// <summary>
    /// Colour-blind-safe palettes in the games that have one (PoEcosystem's charts,
    /// PoCabinet's minimap). Either this or the game's own setting turns it on.
    /// </summary>
    public bool ColorSafe { get; private set; }

    /// <summary>Graphics quality for every game: one of <see cref="GraphicsTiers"/>.</summary>
    public string Graphics { get; private set; } = "auto";

    /// <summary>Opt-in polyphonic FM/Tone.js synth &amp; hall reverb layer.</summary>
    public bool RichAudio { get; private set; }

    /// <summary>Opt-in Web Speech API play-by-play announcer and question reader.</summary>
    public bool VoiceAnnouncer { get; private set; }

    /// <summary>Read persisted values. Call once JS interop is available.</summary>
    public void Load()
    {
        try
        {
            Muted = LocalStorageService.GetItem<string>(MutedKey) == "1";
            Volume = ParseVolume(LocalStorageService.GetItem<string>(VolumeKey));
            SfxVolume = ParseVolume(LocalStorageService.GetItem<string>(SfxVolumeKey));
            MusicVolume = ParseVolume(LocalStorageService.GetItem<string>(MusicVolumeKey), fallback: 0);
            Haptics = LocalStorageService.GetItem<string>(HapticsKey) != "0";
            ReducedMotion = LocalStorageService.GetItem<string>(ReducedMotionKey) == "1";
            ColorSafe = LocalStorageService.GetItem<string>(ColorSafeKey) == "1";
            RichAudio = LocalStorageService.GetItem<string>(RichAudioKey) == "1";
            VoiceAnnouncer = LocalStorageService.GetItem<string>(VoiceAnnouncerKey) == "1";
            var tier = LocalStorageService.GetItem<string>(GraphicsKey);
            Graphics = GraphicsTiers.Contains(tier) ? tier! : "auto";
        }
        catch { /* pre-render — defaults stand */ }
    }

    /// <summary>
    /// Clamped to 0–100. A corrupt or missing value reads as full volume rather
    /// than 0, so a bad key never presents as broken audio. Music passes 0 as its
    /// fallback because it is off until the player raises it.
    /// </summary>
    private static int ParseVolume(string? raw, int fallback = 100) =>
        int.TryParse(raw, out var pct) ? Math.Clamp(pct, 0, 100) : fallback;

    public async Task SetMutedAsync(bool muted)
    {
        Muted = muted;
        Changed?.Invoke();
        await InvokeAsync("applyMuted", muted);
    }

    public async Task SetVolumeAsync(int percent)
    {
        Volume = Math.Clamp(percent, 0, 100);
        Changed?.Invoke();
        await InvokeAsync("applyVolume", Volume / 100.0);
    }

    public async Task SetSfxVolumeAsync(int percent)
    {
        SfxVolume = Math.Clamp(percent, 0, 100);
        Changed?.Invoke();
        await InvokeAsync("applySfxVolume", SfxVolume / 100.0);
    }

    public async Task SetMusicVolumeAsync(int percent)
    {
        MusicVolume = Math.Clamp(percent, 0, 100);
        Changed?.Invoke();
        await InvokeAsync("applyMusicVolume", MusicVolume / 100.0);
    }

    /// <summary>
    /// Haptics on or off. The key is read live by every JS haptics path; the interop call tells
    /// impactBus.js's gate at once, so a rumble already running stops.
    /// </summary>
    public async Task SetHapticsAsync(bool enabled)
    {
        Haptics = enabled;
        LocalStorageService.SetItem(HapticsKey, enabled ? "1" : "0");
        Changed?.Invoke();
        await InvokeAsync("applyHaptics", enabled);
    }

    public async Task SetReducedMotionAsync(bool reduce)
    {
        ReducedMotion = reduce;
        LocalStorageService.SetItem(ReducedMotionKey, reduce ? "1" : "0");
        Changed?.Invoke();
        await InvokeAsync("applyReducedMotion", reduce);
    }

    public async Task SetColorSafeAsync(bool on)
    {
        ColorSafe = on;
        LocalStorageService.SetItem(ColorSafeKey, on ? "1" : "0");
        Changed?.Invoke();
        await InvokeAsync("applyColorSafe", on);
    }

    public async Task SetGraphicsAsync(string tier)
    {
        if (!GraphicsTiers.Contains(tier)) return;
        Graphics = tier;
        Changed?.Invoke();
        await InvokeAsync("applyGraphicsTier", tier);
    }

    /// <summary>
    /// Apply a graphics tier for ten seconds without saving it, measuring its frame times
    /// meanwhile (framePacing.js). "auto" previews what the device read would pick. The
    /// Settings sheet then commits or cancels it based on what the player saw and on
    /// <see cref="GetGraphicsPreviewStatusAsync"/>.
    /// </summary>
    public async Task<bool> StartGraphicsPreviewAsync(string tier)
    {
        if (!GraphicsTiers.Contains(tier)) return false;
        try
        {
            var module = await _prefs.Value;
            return await module.InvokeAsync<bool>("startGraphicsPreview", tier);
        }
        catch
        {
            return false;
        }
    }

    public async Task<bool> CommitGraphicsPreviewAsync(string tier)
    {
        if (!GraphicsTiers.Contains(tier)) return false;
        try
        {
            var module = await _prefs.Value;
            var committed = await module.InvokeAsync<bool>("commitGraphicsPreview");
            if (committed)
            {
                Graphics = tier;
                // Auto is the absence of a choice: appPrefs.js has already cleared the key.
                if (tier != "auto") LocalStorageService.SetItem(GraphicsKey, tier);
                Changed?.Invoke();
            }
            return committed;
        }
        catch
        {
            return false;
        }
    }

    public async Task<bool> CancelGraphicsPreviewAsync()
    {
        try
        {
            var module = await _prefs.Value;
            return await module.InvokeAsync<bool>("cancelGraphicsPreview");
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// The live (or last finished) preview measurement. Read as a <see cref="JsonElement"/>
    /// and picked apart by hand, so the trimmed WASM build needs no serializer metadata.
    /// </summary>
    public async Task<GraphicsPreviewStatus> GetGraphicsPreviewStatusAsync()
    {
        try
        {
            var module = await _prefs.Value;
            var json = await module.InvokeAsync<JsonElement>("graphicsPreviewStatus");
            return GraphicsPreviewStatus.From(json);
        }
        catch
        {
            return GraphicsPreviewStatus.None;
        }
    }

    /// <summary>
    /// Raised when the stutter watch put a lighter tier back after the player chose a heavier
    /// one: (from, to). The sheet re-renders through <see cref="Changed"/>; this is for a toast.
    /// </summary>
    public event Action<string, string>? GraphicsRolledBack;

    private DotNetObjectReference<SettingsService>? _selfRef;

    /// <summary>Called by framePacing.js (through appPrefs.js) after a stutter rollback.</summary>
    [JSInvokable]
    public void OnGraphicsRolledBack(string from, string to)
    {
        if (!GraphicsTiers.Contains(to)) return;
        Graphics = to;
        Changed?.Invoke();
        GraphicsRolledBack?.Invoke(from, to);
    }

    public async Task SetRichAudioAsync(bool on)
    {
        RichAudio = on;
        LocalStorageService.SetItem(RichAudioKey, on ? "1" : "0");
        Changed?.Invoke();
        await InvokeAsync("applyRichAudio", on);
    }

    public async Task SetVoiceAnnouncerAsync(bool on)
    {
        VoiceAnnouncer = on;
        LocalStorageService.SetItem(VoiceAnnouncerKey, on ? "1" : "0");
        Changed?.Invoke();
        await InvokeAsync("applyVoiceAnnouncer", on);
    }

    /// <summary>
    /// True when the OS itself asks for reduced motion, in which case the app is
    /// already calmer regardless of <see cref="ReducedMotion"/>. Used only to
    /// explain that in the settings sheet.
    /// </summary>
    public async Task<bool> OsPrefersReducedMotionAsync()
    {
        if (_disposed) return false;
        try
        {
            var module = await _prefs.Value;
            return await module.InvokeAsync<bool>("prefersReducedMotion");
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Push the persisted values into the DOM and audio graph. Call once after
    /// first render: the pre-paint script in index.html has already stamped motion
    /// and colour-safe palettes; this wires up the live listeners.
    /// </summary>
    public async Task ApplyAsync()
    {
        if (ReducedMotion) await InvokeAsync("applyReducedMotion", true);
        _selfRef ??= DotNetObjectReference.Create(this);
        await InvokeAsync("registerGraphicsRollback", _selfRef);
        // Volume and mute are not re-pushed here: audioBus.js reads both keys
        // itself when it builds the graph, which it may already have done. Re-
        // sending them would only risk constructing an AudioContext before the
        // first user gesture, which mobile autoplay policy rejects.
    }

    /// <summary>
    /// Best-effort interop. Preferences are an enhancement layered on top of a
    /// working app — a browser that cannot load the module keeps the defaults
    /// rather than failing a user action.
    /// </summary>
    private async Task InvokeAsync(string fn, object arg)
    {
        if (_disposed) return;
        try
        {
            var module = await _prefs.Value;
            await module.InvokeVoidAsync(fn, arg);
        }
        catch
        {
            // Best-effort — never throw from a settings path.
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;
        _selfRef?.Dispose();
        if (_prefs.IsValueCreated)
        {
            try
            {
                var module = await _prefs.Value;
                await module.DisposeAsync();
            }
            catch { /* module never loaded — fine */ }
        }
    }
}

/// <summary>
/// A graphics preview's state and measurement, from appPrefs.js <c>graphicsPreviewStatus</c>.
/// </summary>
/// <param name="Active">A preview is applied right now.</param>
/// <param name="RemainingMs">Time left in the preview.</param>
/// <param name="Tier">The tier being (or last) measured; "auto" previews resolve to a real tier.</param>
/// <param name="P95Ms">95th-percentile frame time, the deck's success metric.</param>
/// <param name="Fps">Mean frames per second over the measured frames.</param>
/// <param name="Verdict">smooth | ok | stutter | unknown.</param>
/// <param name="Recommend">The tier framePacing.js recommends after this measurement.</param>
/// <param name="Reason">One sentence explaining the recommendation.</param>
public sealed record GraphicsPreviewStatus(
    bool Active, int RemainingMs, string? Tier, double P95Ms, double Fps, string Verdict, string? Recommend, string? Reason)
{
    public static readonly GraphicsPreviewStatus None = new(false, 0, null, 0, 0, "unknown", null, null);

    /// <summary>A measurement exists (live or finished).</summary>
    public bool HasResult => Verdict != "unknown" && P95Ms > 0;

    public static GraphicsPreviewStatus From(JsonElement json)
    {
        if (json.ValueKind != JsonValueKind.Object) return None;
        var active = json.TryGetProperty("active", out var a) && a.ValueKind == JsonValueKind.True;
        var remaining = json.TryGetProperty("remainingMs", out var r) && r.TryGetDouble(out var rd) ? (int)rd : 0;
        if (!json.TryGetProperty("result", out var res) || res.ValueKind != JsonValueKind.Object)
            return None with { Active = active, RemainingMs = remaining };
        return new GraphicsPreviewStatus(
            active,
            remaining,
            Str(res, "tier"),
            Num(res, "p95"),
            Num(res, "fps"),
            Str(res, "verdict") ?? "unknown",
            Str(res, "recommend"),
            Str(res, "reason"));
    }

    private static string? Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static double Num(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.TryGetDouble(out var d) ? d : 0;
}
