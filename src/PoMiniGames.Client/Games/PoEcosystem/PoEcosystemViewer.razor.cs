using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Web;
using PoMiniGames.Shared.Games.PoEcosystem;
using PoMiniGamesClient.Games.PoEcosystem.Components;
using PoMiniGamesClient.Games.PoEcosystem.Models;
using PoMiniGamesClient.Games.PoEcosystem.Services;
using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Games.PoEcosystem;

/// <summary>
/// Hosts the engine and the HUD. All world state arrives through
/// <see cref="PoEcosystemInteropService"/> events; this component only decides what the
/// player sees. Re-renders are deliberately rationed — stats land twice a second, and the
/// 3D view is drawn by three.js, not by Blazor.
/// </summary>
public partial class PoEcosystemViewer : ComponentBase, IAsyncDisposable
{
    private const int LogCapacity = 200;
    private const int ThoughtCapacity = 60;
    private const string TourDoneKey = "poeco:tourDone";
    private const int TicksPerYear = 600;   // YEAR_SECONDS / TICK_SECONDS in sim/core/config.js

    /// <summary>The kiosk: a fresh island every time, never saved (the page's /demo route).</summary>
    [Parameter] public bool IsDemo { get; set; }

    /// <summary>A shared island's code from <c>?island=CODE</c>: boot straight into a visit of it.</summary>
    [Parameter] public string? VisitCode { get; set; }

    [Inject] private PoEcosystemInteropService Interop { get; set; } = default!;
    [Inject] private PoEcosystemApiClient Api { get; set; } = default!;
    [Inject] private BrowserViewport Viewport { get; set; } = default!;
    [Inject] private ToastService Toasts { get; set; } = default!;
    [Inject] private AuthStateService Auth { get; set; } = default!;
    [Inject] private UiFeedbackService Feedback { get; set; } = default!;
    [Inject] private NavigationManager Navigation { get; set; } = default!;

    // Shown while H is held, or pinned from the ⋯ menu. It used to appear by itself for the
    // first ten seconds of every visit, on top of the intro card and the tour.
    private static readonly (string Key, string What)[] KeyLegend =
    [
        ("WASD", "move"), ("Shift", "hurry"), ("Space/Ctrl", "rise/sink"), ("F", "float/walk"), ("E", "inspect"), ("T", "follow"),
        ("/", "find"), ("L", "lens"), ("C", "cinematic"), ("P", "pop out"), ("0–3", "speed"), ("Tab", "dashboard"),
    ];

    private readonly List<EcoEvent> _log = new(LogCapacity);
    private readonly List<EcoThought> _thoughts = [];
    private EcoStats? _stats;
    private EcoDetail? _detail;
    private InspectorPopover? _inspector;
    private EcoLineage? _lineage;
    private EcoSaveInfo? _resumePrompt;
    private EcoWorldMeta[] _worlds = [];
    private EcoSharedWorld[] _gallery = [];
    private string? _banner;
    private string? _error;
    private string? _cloudMessage;
    private string _seedInput = "";
    private bool _booted;
    private bool _dashboardOpen;
    private bool _lineageOpen;
    private bool _narrow;
    private bool _showKeys;
    private bool _sound = true;
    private bool _directorOn;
    private string _directorCaption = "";
    private bool _pipOn;
    private bool _cloudBusy;
    private bool _visiting;                 // a gallery world: read-only, never autosaved locally
    private int _selected = -1;
    private int _lastStanding = -1;
    private HashSet<int> _watched = [];
    private const string LegacyLegendKind = "legend";

    // ── finder, lenses, map layers, ambient, time machine, wagers, alerts ──
    private HudBar? _hudBar;
    private int _lens = EcoLens.None;
    private string _layer = "none";
    private bool _ambient;
    private bool _finderOpen;
    private IReadOnlyList<EcoFound> _found = [];
    private int _seed;                              // the running world's seed, as the sim has it
    private int _past = -1;                         // the decade being visited; -1 in the present
    private IReadOnlyList<EcoKeyframe> _keyframes = [];
    private string _dashTab = "island";
    private readonly Dictionary<int, string> _thumbs = [];
    private (string Code, string Name, int[][] Years)? _compare;
    private readonly EcoWagerBook _wagers = new();
    private readonly EcoAlertBook _alerts = new();

    /// <summary>A visit — a shared island or a past decade: it runs, and nothing is written into it or saved.</summary>
    private bool ReadOnly => _visiting || _past >= 0;

    private (string Id, string Label, string What) LayerInfo =>
        EcoMapLayer.All.FirstOrDefault(l => l.Id == _layer) is { Id: not null } l ? l : EcoMapLayer.All[0];

    // ── timeline, field notes, tour, viewing settings ──
    private EcoHistory? _history;
    private readonly EcoMilestoneTracker _milestones = new();
    private EcoSpeciesCard[] _cards = [];
    private bool _cardsRequested;
    private EcoSettings? _viewSettings;
    private string? _capturing;                     // the action whose key is being rebound
    private bool _tourActive;
    private int _tourStep;
    private bool _tourStepDone;

    /// <summary>The shared seed of the day (UTC), so everyone can study the same island.</summary>
    private static string DailySeed => $"daily-{DateTime.UtcNow:yyyy-MM-dd}";

    protected override void OnInitialized()
    {
        Interop.Ready += OnReady;
        Interop.StatsReceived += OnStats;
        Interop.EventsReceived += OnEvents;
        Interop.ThoughtsReceived += OnThoughts;
        Interop.DetailReceived += OnDetail;
        Interop.LineageReceived += OnLineage;
        Interop.Picked += OnPicked;
        Interop.SpeedChanged += OnSpeedChanged;
        Interop.ActionRequested += OnAction;
        Interop.DirectorChanged += OnDirector;
        Interop.PipChanged += OnPip;
        Interop.EngineError += OnEngineError;
        Interop.SnapshotExported += OnSnapshotExported;
        Interop.HistoryReceived += OnHistory;
        Interop.Found += OnFound;
        Interop.KeyframesReceived += OnKeyframes;
    }

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (!firstRender)
        {
            // The stats histories cross interop only while a chart that reads them is open.
            await Interop.SetHistoryWantedAsync(HistoryOnScreen);
            return;
        }
        await Viewport.RefreshAsync();
        _narrow = Viewport.IsNarrow;

        // A demo always starts a fresh island and a share link goes straight to the visit,
        // so neither asks whether there is an island to resume.
        var visiting = !string.IsNullOrWhiteSpace(VisitCode);
        var save = IsDemo || visiting ? new EcoSaveInfo(false, 0, 0, 0, 0, null) : await Interop.ProbeSaveAsync();
        if (save.Exists) _resumePrompt = save;
        else
        {
            await BootAsync(resume: false);
            if (visiting) await VisitAsync(VisitCode!.Trim());
        }
        await InvokeAsync(StateHasChanged);
    }

    private async Task BootAsync(bool resume)
    {
        _resumePrompt = null;
        _booted = true;
        await InvokeAsync(StateHasChanged);   // the container must exist before the engine starts
        var ok = await Interop.StartAsync(
            containerId: "poeco-world",
            minimapId: "poeco-minimap",
            seed: string.IsNullOrWhiteSpace(_seedInput) ? null : _seedInput,
            resume: resume,
            lowEnd: _narrow,
            demo: IsDemo,
            // Neither a demo nor the island booted only to be replaced by a visit is saved:
            // the island this browser already holds stays exactly as it was left.
            ephemeral: IsDemo || !string.IsNullOrWhiteSpace(VisitCode));
        if (!ok) _error = "The island engine could not start. Your browser may not support WebGL2.";
        _sound = await Interop.SoundEnabledAsync();
        _viewSettings = await Interop.SettingsAsync();
        StartTourIfNew();
        await InvokeAsync(StateHasChanged);
    }

    // ── engine callbacks ─────────────────────────────────────────────────
    private void OnReady(int seed, int tick, bool resumed, string physics, int past)
    {
        _seedInput = seed.ToString();
        _seed = seed;
        _past = past;
        if (_returning) { _returning = false; _visiting = false; }
        _banner = null;
        _lastStanding = -1;
        _lineage = null;
        _lineageOpen = false;
        _history = null;
        _found = [];
        _compare = null;
        _selected = -1;
        _detail = null;
        _milestones.ResetWorld();
        _alerts.ResetWorld();
        _wagers.Open(seed);
        InvokeAsync(StateHasChanged);
    }

    private void OnFound(IReadOnlyList<EcoFound> results)
    {
        _found = results;
        if (_finderOpen) InvokeAsync(StateHasChanged);
    }

    private void OnKeyframes(EcoKeyframes frames)
    {
        _keyframes = frames.Frames;
        _past = frames.Past;
        InvokeAsync(StateHasChanged);
    }

    private void OnStats(EcoStats stats)
    {
        _stats = stats;
        _watched = stats.Watched is null ? [] : stats.Watched.Select(w => w.Handle).ToHashSet();
        var allAnimalsDead = stats.Counts.Length >= 3 && stats.Counts[0] == 0 && stats.Counts[1] == 0 && stats.Counts[2] == 0;
        if (stats.Silent) _banner = $"The island is silent — year {stats.Year}";
        else if (allAnimalsDead) _banner = $"Simulation ended: All animals have perished — year {stats.Year}";
        else if (stats.LastStanding >= 0 && stats.LastStanding != _lastStanding)
        {
            _lastStanding = stats.LastStanding;
            _banner = $"Last species standing: {EcoSpeciesInfo.PluralOf(stats.LastStanding)} — year {stats.Year}";
        }
        else if (stats.LastStanding < 0 && !stats.Silent && !allAnimalsDead) _banner = null;

        AnnounceNotes(_milestones.Observe(stats));

        // The viewer's own alerts are the one kind of island news that is still a toast:
        // they asked to be told.
        foreach (var rule in _alerts.Observe(stats))
        {
            Toasts.Show($"🔔 {rule.Describe()}", ToastType.Warning);
            _ = Feedback.CrystalPingAsync().AsTask();
        }
        RenderStats();
    }

    // "Stats land twice a second" is only true at 1×: the sim sends them every ten TICKS, so
    // at 4× they arrive eight times a second, and each one used to re-render the HUD and —
    // when it was open — every panel of the dashboard. The newest stats are always kept;
    // the render is what is rationed.
    private const int StatsRenderMs = 400;

    /// <summary>The timeline (Island tab) and evolution chart (Life tab) are the only readers of the stats histories.</summary>
    private bool HistoryOnScreen => _dashboardOpen && _dashTab is "island" or "life";
    private DateTime _statsRenderedAt = DateTime.MinValue;

    private void RenderStats()
    {
        var now = DateTime.UtcNow;
        if ((now - _statsRenderedAt).TotalMilliseconds < StatsRenderMs) return;
        _statsRenderedAt = now;
        InvokeAsync(StateHasChanged);
    }

    private void OnHistory(EcoHistory history)
    {
        // Islands saved while the paid Herald still wrote legends carry "legend" landmarks. The
        // kind has no colour or filter any more, so they are dropped here — chart, landmark log
        // and printed journal alike.
        _history = history.Landmarks.Any(l => l.Kind == LegacyLegendKind)
            ? history with { Landmarks = [.. history.Landmarks.Where(l => l.Kind != LegacyLegendKind)] }
            : history;
        if (!ReadOnly) foreach (var line in _wagers.Settle(history.Years)) Ticker($"🎲 {line}");
        if (_dashboardOpen) InvokeAsync(StateHasChanged);
    }

    /// <summary>
    /// The island's own news — a field note, a settled wager — as a quiet
    /// line under the status chip (render/chronicle.js), not toasts stacked in the corner on
    /// top of the chronicle card for the same moment.
    /// </summary>
    private void Ticker(string text) => _ = Interop.TickerAsync(text).AsTask();

    /// <summary>A field note was witnessed: a line on the ticker and a soft chime, never more.</summary>
    private void AnnounceNotes(List<EcoMilestones.Milestone> notes)
    {
        foreach (var m in notes)
        {
            Ticker($"{m.Icon} Field note: {m.Title} — {m.What}");
            _ = Feedback.CrystalPingAsync().AsTask();
        }
    }

    private void OnEvents(IReadOnlyList<EcoEvent> events)
    {
        _log.AddRange(events);
        if (_log.Count > LogCapacity) _log.RemoveRange(0, _log.Count - LogCapacity);
        foreach (var ev in events)
        {
            // The watch-list is what the viewer asked to hear about: a bookmarked creature
            // dying or breeding is a toast. A new age, an outbreak, a variety, an extinction
            // already get a chronicle card (render/chronicle.js) and are in the log and on
            // the timeline; toasting them as well said everything twice.
            if (ev.Kind == "death" && ev.Creature is { } dead && _watched.Contains(dead)) Toasts.Show(ev.Text, ToastType.Warning);
            else if (ev.Kind == "birth" && ((ev.Mother is { } m && _watched.Contains(m)) || (ev.Father is { } f && _watched.Contains(f)))) Toasts.Show(ev.Text, ToastType.Success);
        }
        AnnounceNotes(_milestones.Observe(events));
        // The log is only on screen inside the dashboard, and events arrive in bursts at 4×:
        // the same 400 ms ration as stats (toasts and the ticker are not rendered here).
        RenderStats();
    }

    private void OnThoughts(IReadOnlyList<EcoThought> thoughts)
    {
        _thoughts.AddRange(thoughts);
        if (_thoughts.Count > ThoughtCapacity) _thoughts.RemoveRange(0, _thoughts.Count - ThoughtCapacity);
        // The feed is only on screen inside the dashboard.
        if (_dashboardOpen) RenderStats();
    }

    private void OnDetail(EcoDetail? detail)
    {
        var appeared = (_detail is null) != (detail is null);
        _detail = detail;
        if (detail is not null) TourSignal("inspect");
        // The inspector is hidden behind the dashboard and during a director shot, and the
        // detail of a followed creature arrives up to sixteen times a second at 4×: with the
        // dashboard open, each of those re-rendered every panel in it for a popover nobody
        // could see.
        // A detail for the creature already on screen only re-renders the popover itself.
        if (appeared || _inspector is null) InvokeAsync(StateHasChanged);
        else if (detail is not null && !_dashboardOpen && !_directorOn) _inspector.Push(detail);
    }

    private void OnLineage(int handle, EcoLineage? tree)
    {
        _lineage = tree;
        if (tree is null) { _lineageOpen = false; Toasts.Show("Nothing is known about that creature's family."); }
        InvokeAsync(StateHasChanged);
    }

    // Named, not a lambda: the interop service outlives this component (scoped, and a WASM
    // scope is the whole app), so an unremovable handler would raise StateHasChanged on a
    // disposed component on the next visit.
    private void OnSpeedChanged(int speed) => InvokeAsync(StateHasChanged);

    private void OnPicked(int handle)
    {
        _selected = handle;
        if (handle < 0) _detail = null;
        // The family section follows the inspection: a new creature, its own tree.
        else if (_lineageOpen) _ = Interop.RequestLineageAsync(handle);
        InvokeAsync(StateHasChanged);
    }

    private static bool IsTrue(string? value) => string.Equals(value, "true", StringComparison.OrdinalIgnoreCase);

    private void OnAction(string action, string? value)
    {
        switch (action)
        {
            case "dashboard":
                _dashboardOpen = !_dashboardOpen;
                _finderOpen = false;
                if (_dashboardOpen) TourSignal("dashboard");
                break;
            case "escape":
                // One thing per press, innermost first.
                if ((DateTime.UtcNow - _dashboardClosedAt).TotalMilliseconds < 300) return;
                if (_hudBar?.CloseMenu() == true) return;
                if (_finderOpen) _finderOpen = false;
                else if (_dashboardOpen) _dashboardOpen = false;
                else if (_lineageOpen) _lineageOpen = false;
                else _detail = null;
                break;
            case "find": _finderOpen = !_dashboardOpen; break;
            case "lens": _ = CycleLensAsync(); return;
            case "keys": _showKeys = IsTrue(value); break;
            case "ambient": _ambient = IsTrue(value); break;
            case "tour": if (value is not null) TourSignal(value); break;
            case "contextLost": Toasts.Show("The graphics driver reset — restoring the view…", ToastType.Warning); break;
            case "contextRestored": Toasts.Show("View restored.", ToastType.Success); break;
            default: return;
        }
        InvokeAsync(StateHasChanged);
    }

    private void OnDirector(bool on, string caption)
    {
        if (on && !_directorOn) TourSignal("director");
        _directorOn = on;
        _directorCaption = caption;
        InvokeAsync(StateHasChanged);
    }

    private void OnPip(bool on)
    {
        _pipOn = on;
        InvokeAsync(StateHasChanged);
    }

    private void OnEngineError(string where, string message)
    {
        // Physics or model failures degrade the world; they never take the page down.
        if (where is "physics" or "cannon") return;
        if (where == "worker-crash")
        {
            Toasts.Show("The simulation stopped unexpectedly and was resumed from its last autosave.", ToastType.Warning);
            return;
        }
        // The time machine failing (a decade no longer kept, no island to return to) is a
        // message, not a broken engine: the world on screen is still running.
        if (where == "keyframe")
        {
            _returning = false;
            Toasts.Show(message, ToastType.Warning);
            return;
        }
        _error = $"{where}: {message}";
        InvokeAsync(StateHasChanged);
    }

    // ── UI actions ───────────────────────────────────────────────────────
    private Task SetSpeedAsync(int speed) => Interop.SetSpeedAsync(speed).AsTask();
    private Task InspectAsync() => Interop.SelectAsync(_selected).AsTask();
    private Task FollowAsync() => Interop.FollowAsync(_selected).AsTask();
    private Task ToggleSoundAsync(bool on)
    {
        _sound = on;
        return Interop.SetSoundAsync(on).AsTask();
    }
    private Task ExportTelemetryAsync() => Interop.ExportTelemetryAsync().AsTask();

    private Task ToggleDirectorAsync() => Interop.SetDirectorAsync(!_directorOn).AsTask();
    private Task TogglePipAsync() => Interop.TogglePipAsync().AsTask();
    private Task ToggleReelAsync() => Interop.ToggleReelAsync().AsTask();

    private Task ToggleAmbientAsync() => Interop.SetAmbientAsync(!_ambient).AsTask();
    private void ToggleKeys() => _showKeys = !_showKeys;

    // ── lenses · map layers · finder ─────────────────────────────────────
    private Task SetLensAsync(int lens)
    {
        _lens = lens;
        return Interop.SetLensAsync(lens).AsTask();
    }

    /// <summary>L steps through every lens and back to species colours.</summary>
    private async Task CycleLensAsync()
    {
        var at = Array.FindIndex(EcoLens.All, l => l.Id == _lens);
        await SetLensAsync(EcoLens.All[(at + 1) % EcoLens.All.Length].Id);
        await InvokeAsync(StateHasChanged);
    }

    private Task CycleLayerAsync()
    {
        var at = Array.FindIndex(EcoMapLayer.All, l => l.Id == _layer);
        _layer = EcoMapLayer.All[(at + 1) % EcoMapLayer.All.Length].Id;
        return Interop.SetLayerAsync(_layer).AsTask();
    }

    private void OpenFinder() => _finderOpen = true;

    private void CloseFinder()
    {
        _finderOpen = false;
        _ = Interop.RestoreLockAsync();
    }

    private Task FindAsync((string Text, string Sort) query) => Interop.FindAsync(query.Text, query.Sort).AsTask();

    /// <summary>A finder result: inspect it, put the camera on it and stay with it.</summary>
    private async Task PickFoundAsync(EcoFound found)
    {
        _finderOpen = false;
        _selected = found.Handle;
        await Interop.SelectAsync(found.Handle);
        await Interop.FlyToAsync(found.X, found.Z);
        await Interop.FollowAsync(found.Handle);
        await Interop.RestoreLockAsync();
    }

    private async Task PickTribeAsync(int tribeId)
    {
        _finderOpen = false;
        await FocusTribeByIdAsync(tribeId);
        await Interop.RestoreLockAsync();
    }

    private Task ToggleWatchAsync()
    {
        if (_detail is null) return Task.CompletedTask;
        return Interop.WatchAsync(_detail.Handle, !_detail.Watched).AsTask();
    }

    private Task UnwatchAsync(int handle) => Interop.WatchAsync(handle, false).AsTask();

    private Task RenameAsync(string name)
    {
        if (_detail is null || string.IsNullOrWhiteSpace(name)) return Task.CompletedTask;
        return Interop.RenameAsync(_detail.Handle, name.Trim()).AsTask();
    }

    /// <summary>The inspector's Family button: open the section (and ask for the tree), or close it.</summary>
    private Task ToggleFamilyAsync()
    {
        _lineageOpen = !_lineageOpen;
        return _lineageOpen && _detail is not null ? Interop.RequestLineageAsync(_detail.Handle).AsTask() : Task.CompletedTask;
    }

    /// <summary>A click on a relative or a watched creature inspects it and, with the family open, walks the tree there.</summary>
    private async Task SelectKinAsync(int handle)
    {
        if (handle < 0) return;
        _selected = handle;
        _dashboardOpen = false;
        await Interop.SelectAsync(handle);
        if (_lineageOpen) await Interop.RequestLineageAsync(handle);
    }

    /// <summary>A thought-feed click selects the thinker and leaves the dashboard so the
    /// inspector popover is visible (it is suppressed while the overlay is open).</summary>
    private async Task SelectThoughtAsync(int handle)
    {
        if (handle < 0) return;
        _selected = handle;
        _dashboardOpen = false;
        await Interop.SelectAsync(handle);
    }

    private async Task ClearSelectionAsync()
    {
        _selected = -1;
        _detail = null;
        _lineageOpen = false;
        await Interop.SelectAsync(-1);
    }

    private enum CameraPreset
    {
        IslandOverview,
        AmberClan,
        CobaltClan,
        VerdantClan
    }

    private async Task SetCameraPresetAsync(CameraPreset preset)
    {
        await Feedback.CueAsync("poecosystem", "godFinger");
        if (preset == CameraPreset.IslandOverview)
        {
            await Interop.SetCameraPoseAsync(100, 110, 200, -0.85, 0);
            return;
        }
        // Tribe ids are 0-based in the sim (Amber 0, Cobalt 1, Verdant 2).
        await FocusTribeByIdAsync((int)preset - 1);
    }

    /// <summary>
    /// Fly to a clan's actual camp. The clans are placed per seed (sim/tribe/tribeStore.js),
    /// so the camera reads their centre from the stats; the fixed poses this replaced sent
    /// every island's "Amber Clan" button to the same empty field, and mapped the sim's
    /// 0-based ids one clan off.
    /// </summary>
    private async Task FocusTribeByIdAsync(int tribeId)
    {
        var tribe = _stats?.Tribes?.FirstOrDefault(t => t.Id == tribeId);
        if (tribe is null) { await Interop.SetCameraPoseAsync(100, 110, 200, -0.85, 0); return; }
        await Interop.FlyToAsync(tribe.CenterX, tribe.CenterZ);
    }

    private Task FlyToTileAsync(int tile)
    {
        if (tile < 0) return Task.CompletedTask;
        const int size = 200;   // WORLD_SIZE in sim/core/config.js
        _dashboardOpen = false;
        return Interop.FlyToAsync(tile % size + 0.5, tile / size + 0.5).AsTask();
    }

    /// <summary>A clan picked from the dashboard: the overlay goes away so the camp can be seen.</summary>
    private Task FocusTribeFromDashboardAsync(int tribeId)
    {
        _dashboardOpen = false;
        return FocusTribeByIdAsync(tribeId);
    }

    // Esc in the dashboard reaches two listeners: the overlay's own (which closes it) and the
    // engine's window listener (the "escape" action). The second would go on to close the
    // family section or drop the inspected creature on the same key press.
    private DateTime _dashboardClosedAt = DateTime.MinValue;

    private async Task ToggleDashboard()
    {
        _dashboardOpen = !_dashboardOpen;
        if (_dashboardOpen)
        {
            _finderOpen = false;
            TourSignal("dashboard");
            await Feedback.GlassResonateAsync();
        }
        else
        {
            _dashboardClosedAt = DateTime.UtcNow;
            await Feedback.FluidRippleAsync();
            _ = Interop.RequestLockAsync();
        }
    }

    private async Task NewWorldAsync(string? seed)
    {
        _banner = null;
        _log.Clear();
        _dashboardOpen = false;
        _visiting = false;
        await Interop.NewWorldAsync(seed ?? _seedInput);
    }

    // ── cloud saves ──────────────────────────────────────────────────────
    private async Task RefreshCloudAsync(bool quiet = false)
    {
        if (_cloudBusy) return;
        _cloudBusy = true;
        await InvokeAsync(StateHasChanged);
        var worlds = Auth.IsAuthenticated ? Api.ListWorldsAsync() : Task.FromResult(Array.Empty<EcoWorldMeta>());
        var gallery = Api.GalleryAsync();
        await Task.WhenAll(worlds, gallery);
        _worlds = worlds.Result;
        _gallery = gallery.Result;
        if (!quiet) _cloudMessage = "Cloud refreshed.";
        _cloudBusy = false;
        await InvokeAsync(StateHasChanged);
    }

    private Task SaveToCloudAsync(string slot)
    {
        if (_stats is null || _cloudBusy) return Task.CompletedTask;
        _cloudBusy = true;
        _cloudMessage = "Packing the island…";
        // The engine answers on SnapshotExported with the gzip'd bytes.
        return Interop.ExportSnapshotAsync(slot).AsTask();
    }

    private void OnSnapshotExported(string slot, byte[] bytes) => _ = UploadAsync(slot, bytes);

    private async Task UploadAsync(string slot, byte[] bytes)
    {
        try
        {
            if (_stats is null) return;
            var name = $"Year {_stats.Year} · {_stats.Alive} alive";
            var saved = await Api.SaveWorldAsync(slot, name, int.TryParse(_seedInput, out var s) ? s : 0, _stats.Year, _stats.Tick, _stats.Counts, bytes);
            _cloudMessage = saved is null ? "The cloud did not accept the save. Sign in and try again." : $"Saved to slot {slot} ({bytes.Length / 1024} KB).";
            if (saved is not null) _worlds = await Api.ListWorldsAsync();
        }
        finally
        {
            _cloudBusy = false;
            await InvokeAsync(StateHasChanged);
        }
    }

    private async Task LoadFromCloudAsync(string slot)
    {
        if (_cloudBusy) return;
        _cloudBusy = true;
        _cloudMessage = "Fetching the island…";
        await InvokeAsync(StateHasChanged);
        var bytes = await Api.LoadWorldAsync(slot);
        if (bytes is null) _cloudMessage = "That world could not be fetched.";
        else
        {
            _log.Clear();
            _dashboardOpen = false;
            _visiting = false;
            await Interop.ImportSnapshotAsync(bytes, ephemeral: false);
            _cloudMessage = null;
        }
        _cloudBusy = false;
        await InvokeAsync(StateHasChanged);
    }

    private async Task DeleteFromCloudAsync(string slot)
    {
        if (_cloudBusy) return;
        _cloudBusy = true;
        var ok = await Api.DeleteWorldAsync(slot);
        _cloudMessage = ok ? $"Slot {slot} cleared." : "Could not delete that world.";
        if (ok) _worlds = await Api.ListWorldsAsync();
        _cloudBusy = false;
        await InvokeAsync(StateHasChanged);
    }

    private async Task ShareAsync(string slot, bool isPublic)
    {
        if (_cloudBusy) return;
        _cloudBusy = true;
        var meta = await Api.ShareWorldAsync(slot, isPublic);
        _cloudMessage = meta is null ? "Sharing failed." : isPublic ? "Shared: it is in the gallery, and 🔗 Link gives a link straight to it." : "No longer public.";
        if (meta is not null) { _worlds = await Api.ListWorldsAsync(); _gallery = await Api.GalleryAsync(); }
        _cloudBusy = false;
        await InvokeAsync(StateHasChanged);
    }

    /// <summary>
    /// A link that opens a shared island (<c>/poecosystem?island=CODE</c>), through the
    /// platform's share sheet where there is one and the clipboard where there is not.
    /// </summary>
    private async Task ShareLinkAsync(string code, string name)
    {
        var url = Navigation.ToAbsoluteUri($"poecosystem?island={Uri.EscapeDataString(code)}").ToString();
        var result = await Interop.ShareLinkAsync($"Ecosystem · {name}", "A living island — watch it without changing it.", url);
        _cloudMessage = result switch { "shared" => null, "copied" => "Link copied.", _ => $"Copy this link: {url}" };
        if (result == "copied") Toasts.Show("Link copied.", ToastType.Success);
        await InvokeAsync(StateHasChanged);
    }

    /// <summary>Boot someone else's island read-only: it runs, but never autosaves over the local world.</summary>
    private async Task VisitAsync(string code)
    {
        if (_cloudBusy) return;
        _cloudBusy = true;
        _cloudMessage = "Sailing over…";
        await InvokeAsync(StateHasChanged);
        var bytes = await Api.GalleryBytesAsync(code);
        if (bytes is null)
        {
            _cloudMessage = "That island is no longer shared.";
            // A share link that has gone stale: say so where it will be seen (the dashboard is shut).
            if (!_dashboardOpen) Toasts.Show("That island is no longer shared.", ToastType.Warning);
        }
        else
        {
            _log.Clear();
            _dashboardOpen = false;
            _visiting = true;
            await Interop.ImportSnapshotAsync(bytes, ephemeral: true);
            _cloudMessage = null;
        }
        _cloudBusy = false;
        await InvokeAsync(StateHasChanged);
    }

    /// <summary>
    /// Read a shared island's per-year history out of its snapshot (without booting it) and
    /// put it on a chart against the island on screen. A second click on the same row closes it.
    /// </summary>
    private async Task CompareAsync(EcoSharedWorld island)
    {
        if (_compare?.Code == island.Code) { _compare = null; return; }
        if (_cloudBusy) return;
        _cloudBusy = true;
        await InvokeAsync(StateHasChanged);
        var bytes = await Api.GalleryBytesAsync(island.Code);
        var peek = bytes is null ? null : await Interop.PeekHistoryAsync(bytes);
        _compare = peek is null ? null : (island.Code, island.Name, peek.Years);
        _cloudMessage = peek is null ? "That island's history could not be read." : null;
        _cloudBusy = false;
        await InvokeAsync(StateHasChanged);
    }

    /// <summary>Draw the maps the Worlds tab asked for, one per frame so the tab stays responsive.</summary>
    private async Task LoadThumbsAsync(int[] seeds)
    {
        var wanted = seeds.Where(s => _thumbs.TryAdd(s, "")).ToArray();   // claimed now: a re-render must not ask twice
        foreach (var seed in wanted)
        {
            _thumbs[seed] = await Interop.IslandThumbAsync(seed);
            await InvokeAsync(StateHasChanged);
            await Task.Yield();
        }
    }

    // ── the time machine · leaving a visit ───────────────────────────────
    private Task OpenKeyframeAsync(int year)
    {
        if (year == _past) return Task.CompletedTask;
        _log.Clear();
        _dashboardOpen = false;
        return Interop.OpenKeyframeAsync(year).AsTask();
    }

    /// <summary>Leave a past decade or a shared island for the island this browser holds.</summary>
    private Task ReturnHomeAsync()
    {
        _log.Clear();
        _dashboardOpen = false;
        _returning = true;      // the visit ends when the island answers (OnReady), not before
        return Interop.ReturnHomeAsync().AsTask();
    }

    private bool _returning;

    /// <summary>
    /// The field journal as a printable page: the timeline and the field notes. The engine builds it in a throwaway frame and calls the browser's print
    /// dialog — "Save as PDF" is the export.
    /// </summary>
    private Task PrintJournalAsync()
    {
        var stats = _stats;
        var counts = stats?.Counts is { Length: EcoSpeciesInfo.Count } c
            ? string.Join(" · ", Enumerable.Range(0, EcoSpeciesInfo.Count).Select(s => $"{c[s]} {EcoSpeciesInfo.PluralOf(s).ToLowerInvariant()}"))
            : "";
        var journal = new EcoJournalPrint(
            Title: $"Field journal — the {stats?.Tech?.Tribe ?? "island"} island",
            Subtitle: $"Seed {_seed} · year {stats?.Year ?? 0} · printed {DateTime.Now:d MMMM yyyy}",
            Counts: counts,
            Landmarks: (_history?.Landmarks ?? []).Select(l => $"Year {l.Year}: {l.Text}").ToArray(),
            Notes: EcoMilestones.All.Where(m => _milestones.Unlocked.ContainsKey(m.Id)).Select(m => $"{m.Title} — {m.What}").ToArray());
        return Interop.PrintJournalAsync(journal).AsTask();
    }

    // ── dashboard tabs · today's island ──────────────────────────────────
    private async Task OnDashboardTabAsync(string tab)
    {
        _dashTab = tab;    // the overlay is rebuilt each time it opens; this is what it reopens on
        if (tab == "island" && !_cardsRequested)
        {
            _cardsRequested = true;
            _cards = await Interop.SpeciesInfoAsync();
            await InvokeAsync(StateHasChanged);
        }
        // The cloud is asked when its tab is opened, not on every Tab press as it was.
        else if (tab == "worlds") await RefreshCloudAsync(quiet: true);
        else if (tab == "tribe") await LoadThumbsAsync([_seed]);
    }

    private Task TodaysIslandAsync()
    {
        _seedInput = DailySeed;
        Toasts.Show("Today's island: everyone watching it sees the same world unfold.");
        return NewWorldAsync(DailySeed);
    }

    // ── viewing settings ─────────────────────────────────────────────────
    private async Task SetQualityAsync(string tier) { await Interop.SetQualityAsync(tier); _viewSettings = await Interop.SettingsAsync(); }
    private async Task ResetBindingsAsync() { await Interop.ResetBindingsAsync(); _viewSettings = await Interop.SettingsAsync(); }

    private async Task RebindAsync(string action)
    {
        if (_capturing is not null) return;
        _capturing = action;
        await InvokeAsync(StateHasChanged);
        try
        {
            var code = await Interop.CaptureKeyAsync();
            if (!string.IsNullOrEmpty(code)) await Interop.SetBindingAsync(action, code);
            _viewSettings = await Interop.SettingsAsync();
        }
        finally
        {
            _capturing = null;
            await InvokeAsync(StateHasChanged);
        }
    }

    // ── first-visit tour ─────────────────────────────────────────────────
    private void StartTourIfNew()
    {
        string? done = null;
        try { done = LocalStorageService.GetItem<string>(TourDoneKey); } catch { /* storage off: show it */ }
        if (done == "1") return;
        _tourActive = true;
        _tourStep = 0;
        _tourStepDone = false;
        _ = Interop.HoldDirectorAsync(true);
    }

    private void TourSignal(string signal)
    {
        if (!_tourActive || TourOverlay.Steps[_tourStep].Signal != signal || _tourStepDone) return;
        _tourStepDone = true;
        InvokeAsync(StateHasChanged);
    }

    private async Task NextTourStepAsync()
    {
        if (_tourStep >= TourOverlay.Steps.Length - 1) { await EndTourAsync(); return; }
        _tourStep++;
        _tourStepDone = false;
        // The last step is the director: release the hold so pressing C (or waiting) works.
        if (TourOverlay.Steps[_tourStep].Signal == "director") await Interop.HoldDirectorAsync(false);
    }

    private async Task EndTourAsync()
    {
        _tourActive = false;
        try { LocalStorageService.SetItem(TourDoneKey, "1"); } catch { /* best effort */ }
        await Interop.HoldDirectorAsync(false);
    }

    private async Task ReplayTourAsync()
    {
        try { LocalStorageService.SetItem(TourDoneKey, "0"); } catch { /* best effort */ }
        _dashboardOpen = false;
        StartTourIfNew();
        await InvokeAsync(StateHasChanged);
    }

    // ── touch move pad ───────────────────────────────────────────────────
    private double _padX, _padY;

    private void TouchStart(TouchEventArgs e)
    {
        if (e.Touches.Length == 0) return;
        _padX = e.Touches[0].ClientX;
        _padY = e.Touches[0].ClientY;
    }

    private async Task TouchMove(TouchEventArgs e)
    {
        if (e.Touches.Length == 0) return;
        var dx = e.Touches[0].ClientX - _padX;
        var dy = e.Touches[0].ClientY - _padY;
        var len = Math.Max(1, Math.Sqrt(dx * dx + dy * dy));
        var scale = Math.Min(1, len / 60);
        await Interop.TouchMoveAsync(dx / len * scale, -dy / len * scale);
    }

    private Task TouchEnd(TouchEventArgs e) => Interop.TouchReleaseAsync().AsTask();

    // The counts come from a saved world, so a snapshot written by another schema could
    // carry a shorter array — checking the length keeps the resume prompt from throwing.
    private static string Counts(int[]? counts) =>
        counts is not { Length: EcoSpeciesInfo.Count } c ? "an empty island"
        : string.Join(", ", Enumerable.Range(0, EcoSpeciesInfo.Count).Select(s => $"{c[s]} {EcoSpeciesInfo.PluralOf(s).ToLowerInvariant()}"));

    private static string Ago(long savedAtMs)
    {
        var span = DateTimeOffset.UtcNow - DateTimeOffset.FromUnixTimeMilliseconds(savedAtMs);
        return span.TotalMinutes < 1 ? "moments ago"
            : span.TotalHours < 1 ? $"{(int)span.TotalMinutes} min ago"
            : span.TotalDays < 1 ? $"{(int)span.TotalHours} h ago"
            : $"{(int)span.TotalDays} d ago";
    }

    /// <summary>
    /// The minimap is the camera control: click near a tribe's camp to fly to it, anywhere
    /// else falls through to the island overview. The canvas is a 200×200 bitmap over the
    /// 200 m world shown at 180 CSS px (96 on narrow), so scale by the rendered width —
    /// poecosystem.css owns those two sizes; keep them in sync.
    /// </summary>
    private async Task MinimapClickAsync(MouseEventArgs e)
    {
        const double worldSize = 200;         // WORLD_SIZE in sim/core/config.js
        var cssWidth = _narrow ? 96 : 180;
        if (cssWidth <= 0) return;
        var worldX = Math.Clamp(e.OffsetX, 0, cssWidth) * worldSize / cssWidth;
        var worldZ = Math.Clamp(e.OffsetY, 0, cssWidth) * worldSize / cssWidth;

        // The clans' real camps (per seed), not fixed anchors.
        var nearest = (_stats?.Tribes ?? [])
            .Select(t => (t.Id, Dist: Math.Sqrt((t.CenterX - worldX) * (t.CenterX - worldX) + (t.CenterZ - worldZ) * (t.CenterZ - worldZ))))
            .OrderBy(c => c.Dist)
            .FirstOrDefault((Id: -1, Dist: double.MaxValue));
        await Feedback.CueAsync("poecosystem", "godFinger");
        if (nearest.Id >= 0 && nearest.Dist <= 40)
            await FocusTribeByIdAsync(nearest.Id);
        else
            await Interop.SetCameraPoseAsync(100, 110, 200, -0.85, 0);
    }

    public async ValueTask DisposeAsync()
    {
        Interop.Ready -= OnReady;
        Interop.StatsReceived -= OnStats;
        Interop.EventsReceived -= OnEvents;
        Interop.ThoughtsReceived -= OnThoughts;
        Interop.DetailReceived -= OnDetail;
        Interop.LineageReceived -= OnLineage;
        Interop.Picked -= OnPicked;
        Interop.SpeedChanged -= OnSpeedChanged;
        Interop.ActionRequested -= OnAction;
        Interop.DirectorChanged -= OnDirector;
        Interop.PipChanged -= OnPip;
        Interop.EngineError -= OnEngineError;
        Interop.SnapshotExported -= OnSnapshotExported;
        Interop.HistoryReceived -= OnHistory;
        Interop.Found -= OnFound;
        Interop.KeyframesReceived -= OnKeyframes;
        await Interop.DisposeAsync();
    }
}
