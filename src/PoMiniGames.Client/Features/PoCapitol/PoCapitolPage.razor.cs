using System.Globalization;
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.JSInterop;
using PoMiniGamesClient.Models;
using Radzen;

namespace PoMiniGamesClient.Features.PoCapitol;

/// <summary>
/// PoCapitol's page state and engine bridge. The rules, the scene and the sound all live in the
/// JS engine (<c>wwwroot/js/pocapitol</c>); this class starts it, mirrors the few numbers the
/// shared shell shows, saves comfort settings and records one local result per solo attempt.
/// The markup and its render fragments are in <c>PoCapitolPage.razor</c>.
/// </summary>
public partial class PoCapitolPage : IAsyncDisposable
{
    [Parameter] public string? Mode { get; set; }

    private static RenderFragment TitleContent => GameCatalog.TitleFor(GameKeys.PoCapitol);

    private static readonly string[] Objectives =
        ["Pass the barricades", "Enter the Crypt", "Reach the Rotunda", "Enter Statuary Hall", "Cross Statuary Hall", "Reach the House chamber doors"];

    private static readonly string[] LineNames =
        ["Bike-rack barricade", "Crypt doors", "Rotunda doors", "Statuary Hall doorway", "House corridor"];

    // Approximate times from the public record (the Senate committees' June 2021 staff report
    // and the Congressional Record). Shown beside the fictional clock, never driven by it.
    private static readonly (int Minute, string Time, string Text)[] Timeline =
    [
        (12 * 60 + 50, "12:53 PM", "The crowd breaches the first barricade on the west side of the grounds."),
        (13 * 60 + 5, "1:05 PM", "The joint session of Congress convenes to count electoral votes."),
        (13 * 60 + 50, "1:50 PM", "A riot is declared as police lines on the west front are pressed."),
        (14 * 60 + 12, "2:12 PM", "The first people enter the building through a broken window."),
        (14 * 60 + 20, "2:20 PM", "The Senate and then the House go into recess; evacuations begin."),
        (14 * 60 + 45, "2:45 PM", "The chambers are being emptied. The House chamber doors are barricaded from inside."),
        (16 * 60 + 17, "4:17 PM", "A recorded message tells the crowd to go home."),
        (17 * 60 + 40, "5:40 PM", "Police report the interior of the building cleared."),
        (18 * 60, "6:00 PM", "The citywide curfew begins."),
    ];

    private static readonly string[] KeyChoices =
        ["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "KeyI", "KeyJ", "KeyK", "KeyL", "KeyF", "KeyR", "Space", "ShiftLeft", "ControlLeft", "KeyP"];

    private DotNetObjectReference<PoCapitolPage>? _reference;
    private ErrorBoundary? _errorBoundary;
    private string _status = "loading", _difficulty = "standard", _error = "", _message = "", _announcement = "";
    private string _resultWarning = "", _role = "raider", _outcome = "", _graphics = "auto", _graphicsLabel = "Auto";
    private string _weatherMode = "historical", _weatherCondition = "Jan 6 Archive · 42.4°F";
    private bool _radarExpanded = true, _radarNeedsInit = true;
    private TelemetryDto? _selectedTelemetry;
    private int _health = 100, _milestone;
    private double _elapsed;
    private bool _ready, _disposed, _recorded, _demo;
    private string? _mode;
    // The crowd's size comes from the engine with every update; this is only the value shown
    // before the first one arrives.
    private int _crowdTotal = 512;
    private int _activeRaiders = 512, _activePolice = 44, _totalPolice = 44, _subject, _lineIndex, _lineIntegrity = 100, _sheltering = 64, _grenades, _smoke;
    private PrefsDto _prefs = new();
    private ReportDto? _report;
    private DebriefDto? _debrief;
    private bool _debriefBusy;
    private string _probeStatus = "";
    private string _caption = "";
    private DateTime _captionStamp;

    private IEnumerable<(string Action, string Label, string Code)> KeyRows =>
    [
        ("forward", "Move forward", _prefs.forward),
        ("back", "Move back", _prefs.back),
        ("left", "Move left", _prefs.left),
        ("right", "Move right", _prefs.right),
        ("push", "Push / fire", _prefs.push),
        ("sprint", "Sprint", _prefs.sprint),
        ("pause", "Pause", _prefs.pause),
    ];

    private bool Playing => !_demo && _role != "observer";

    /// <summary>Only a solo player in the crowd carries the machine gun and the grenades.</summary>
    private bool Armed => !_demo && _role == "raider";

    private string Objective => _milestone < Objectives.Length ? Objectives[_milestone] : "Chamber doors reached";

    private string Clock => DateTime.Today.AddMinutes(12 * 60 + 50 + Math.Floor(_elapsed)).ToString("h:mm tt", CultureInfo.InvariantCulture);

    private (int Minute, string Time, string Text) OnTheDay =>
        Timeline.Last(entry => entry.Minute <= Math.Max(Timeline[0].Minute, 12 * 60 + 50 + (int)_elapsed));

    private string HudEyebrow => _role == "raider" || _demo ? $"OBJECTIVE {Math.Min(_milestone + 1, Objectives.Length)} / {Objectives.Length}"
        : _role == "police" ? "HOLD UNTIL THE 6:00 PM CURFEW" : "OBSERVING · CROWD PROGRESS";

    private string HudTitle => _role == "police" && !_demo
        ? (_lineIndex >= 0 ? $"Hold the {LineNames[_lineIndex].ToLowerInvariant()}" : "Fall back to the chamber doors") : Objective;

    private string RoleBrief => _role switch
    {
        "police" => "Stand in the line and push back. You win by keeping the crowd from the chamber doors until the curfew. Not saved to your stats.",
        "observer" => "Walk anywhere and watch. Nobody targets you, you cannot push, and nothing is saved.",
        _ => "Lean on a line with the crowd to tip it. You carry a machine gun, five concussion grenades and two smoke grenades. Reach the House chamber doors before the curfew.",
    };

    /// <summary>The one-line reminder in the Tab panel. It names the keys actually bound now.</summary>
    private string BottomHint
    {
        get
        {
            if (_demo) return $"AUTONOMOUS DEMO · {DescribeKey(_prefs.pause)} PAUSE";
            if (_message.Length > 0) return _message;
            var move = "Move, click scene to look";
            var pause = $"{DescribeKey(_prefs.pause)} pause";
            return _role switch
            {
                "observer" => $"{move} · {pause}",
                "police" => $"{move} · {DescribeKey(_prefs.push)} push · {pause}",
                _ => $"{move} · {DescribeKey(_prefs.push)} fire · G grenade · H smoke · {pause}",
            };
        }
    }

    private string ResultHeading => _outcome switch
    {
        "doors" => "The doors stayed shut.",
        "curfew" => "Six o'clock. Curfew.",
        "overcome" => _role == "police" ? "Pulled back from the line." : "Helped away.",
        "dispersed" => "The crowd is spent.",
        _ => "Attempt ended.",
    };

    private string ResultBody => _outcome switch
    {
        "doors" => "The crowd reached the House chamber doors and found them barricaded. The chamber behind them had been evacuated. "
            + (_role == "police" ? "The lines did not hold long enough." : "Nobody in this scenario gets in, as nobody did. Reaching the doors ends the game; it is not a historical victory."),
        "curfew" => _role == "police" ? "The lines held until the curfew and the building was cleared."
            : "The lines held. At 6:00 pm the curfew began and the building was cleared.",
        "overcome" => _role == "police" ? "You were worn down and pulled back behind the line. The scenario ends here."
            : "Batons, spray and gas wore you down, and street medics walked you back to the aid station. A new attempt starts outside.",
        "dispersed" => _demo ? "Every raider has been eliminated. The armed demo follows no record; it starts again shortly."
            : "Nobody in the crowd is still on their feet. The building is cleared.",
        _ => "The scenario has ended.",
    };

    private List<StatItem> ResultStats =>
    [
        new() { Label = "TIME OF DAY", Value = Clock },
        new() { Label = "MILESTONES", Value = $"{_milestone} / {Objectives.Length}" },
        new() { Label = "STILL STANDING", Value = $"{_activeRaiders} / {_crowdTotal}" },
    ];

    private GameResult ResultOutcome => _status switch
    {
        "completed" => GameResult.Win,
        "failed" => GameResult.Loss,
        _ => GameResult.InProgress,
    };

    private string ResultNote =>
        _role != "raider" ? "Police-line and observer attempts are not saved."
        : _resultWarning.Length > 0 ? _resultWarning
        : "Results stay in your local game stats. No public ranking and no score for harming anyone.";

    private IEnumerable<StatItem> DiagStats =>
    [
        new() { Label = "Status", Value = _status },
        new() { Label = "Role", Value = _role },
        new() { Label = "Objective", Value = $"{Math.Min(_milestone + 1, Objectives.Length)}/{Objectives.Length} · {HudTitle}" },
        new() { Label = "Clock", Value = $"{Clock} ({_elapsed:0.0}s)" },
        new() { Label = "Weather", Value = _weatherCondition },
        new() { Label = "Crowd", Value = $"{_activeRaiders} / {_crowdTotal} in crowd ({Math.Max(0, _crowdTotal - _activeRaiders)} down)" },
        new() { Label = "Police", Value = $"{_activePolice} / {_totalPolice} Capitol Police" },
        new() { Label = "Line", Value = _lineIndex >= 0 ? $"{LineNames[_lineIndex]} {_lineIntegrity}%" : "None" },
        new() { Label = "Sheltering", Value = _sheltering.ToString(CultureInfo.InvariantCulture) },
        new() { Label = "Tier", Value = _graphicsLabel },
        new() { Label = "Debrief", Value = DebriefMeta },
    ];

    /// <summary>
    /// What wrote the debrief and how it went: provider, pace, tokens, time, retries, and the
    /// reason when a local model was asked for and the built-in writer answered instead.
    /// </summary>
    private string DebriefMeta
    {
        get
        {
            if (_debriefBusy) return _prefs.debrief == "ollama" ? $"Local model {_prefs.debriefModel} is writing…" : "Writing…";
            if (_debrief is not { } d) return "Not written yet";
            if (d.provider == "rules")
            {
                return d.fallback
                    ? $"Built-in writer · local model did not answer after {d.retries + 1} tries ({d.error})"
                    : "Built-in writer · instant · stays on this device";
            }
            var retries = d.retries == 0 ? "no retries" : d.retries == 1 ? "1 retry" : $"{d.retries} retries";
            return string.Create(CultureInfo.InvariantCulture,
                $"Local model {d.model} · {d.tokensPerSecond:0.#} tokens/s · {d.tokens} tokens · {d.ms / 1000.0:0.0} s · {retries}");
        }
    }

    protected override async Task OnParametersSetAsync()
    {
        var mode = Mode ?? "";
        if (_mode == mode) return;
        _mode = mode;
        _demo = GameModes.Parse(Mode) == GameMode.Demo;
        if (_demo) Kiosk.SetCurrent("pocapitol-demo");
        if (_ready)
        {
            if (_demo) await StartAsync();
            else
            {
                try
                {
                    await JS.InvokeVoidAsync("PoCapitol.dispose");
                    await LoadAsync();
                }
                catch (JSException ex) { await OnEngineError(ex.Message); }
            }
        }
    }

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (firstRender) await LoadAsync();
        if (_radarNeedsInit && _radarExpanded)
        {
            _radarNeedsInit = false;
            try { await JS.InvokeVoidAsync("PoCapitol.initRadar", "pocapitol-radar"); }
            catch (JSException ex) { Logger.LogDebug(ex, "PoCapitol radar is not ready yet"); }
        }
    }

    private async Task LoadAsync()
    {
        _status = "loading";
        StateHasChanged();
        try
        {
            if (!await JS.InvokeAsync<bool>("loadEngine", "pocapitol"))
                throw new InvalidOperationException("The 3D assets could not be downloaded. Check your connection and retry.");
            _reference ??= DotNetObjectReference.Create(this);
            await JS.InvokeVoidAsync("PoCapitol.init", "pocapitol-scene", _reference);
            _graphics = await JS.InvokeAsync<string>("PoCapitol.getGraphics");
            _weatherMode = await JS.InvokeAsync<string>("PoCapitol.getWeather");
            _prefs = await JS.InvokeAsync<PrefsDto>("PoCapitol.getPrefs");
            _ready = true;
            _status = "intro";
            if (_demo) await StartAsync();
        }
        catch (Exception ex) when (ex is JSException or InvalidOperationException)
        {
            // The route changed while the engine was downloading: its container is gone
            // and there is nothing left to initialise. That is a navigation, not a page
            // failure, so it must not be logged — the link audit (and a player reading
            // the console) treats a logged init error as a broken page.
            if (ex.Message.Contains("scene container was not found", StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            Logger.LogError(ex, "PoCapitol could not initialize");
            _error = "The 3D scene is unavailable. Check your connection and browser graphics support, then retry.";
            _status = "error";
        }
        StateHasChanged();
    }

    private async Task StartAsync()
    {
        try
        {
            await JS.InvokeVoidAsync("PoCapitol.start", _difficulty, _demo, _role);
            _recorded = false;
            _report = null;
            _debrief = null;
            _caption = "";
            _status = "active";
            _health = 100; _milestone = 0; _elapsed = 0; _message = ""; _resultWarning = ""; _outcome = "";
            _activeRaiders = _crowdTotal; _activePolice = 44; _totalPolice = 44; _subject = 0; _lineIndex = 0; _lineIntegrity = 100; _sheltering = 64;
            _announcement = "Scenario started. " + HudTitle;
        }
        catch (JSException ex) { await OnEngineError(ex.Message); }
    }

    private async Task PauseAsync(bool paused)
    {
        try { await JS.InvokeVoidAsync("PoCapitol.pause", paused); }
        catch (JSException ex) { await OnEngineError(ex.Message); }
    }

    private async Task SetGraphicsAsync(string mode)
    {
        _graphics = mode;
        try { _graphicsLabel = await JS.InvokeAsync<string>("PoCapitol.setGraphics", mode); }
        catch (JSException ex) { await OnEngineError(ex.Message); }
    }

    private void RecoverFromError()
    {
        _errorBoundary?.Recover();
        _status = "loading";
        _ = LoadAsync();
    }

    private static ProgressBarStyle GetHealthProgressStyle(int health) =>
        health > 50 ? ProgressBarStyle.Success : health > 25 ? ProgressBarStyle.Warning : ProgressBarStyle.Danger;

    private static ProgressBarStyle GetLineProgressStyle(int integrity) =>
        integrity > 50 ? ProgressBarStyle.Info : integrity > 25 ? ProgressBarStyle.Warning : ProgressBarStyle.Danger;

    [JSInvokable]
    public async Task OnUpdate(int health, int milestone, double elapsed, string status, int crowdTotal, string message,
        int activeRaiders, int activePolice, int subject, bool demo, string outcome, int totalPolice, int lineIndex,
        int lineIntegrity, string graphics, int sheltering, int grenades = 0, int smoke = 0)
    {
        if (_disposed || demo != _demo) return;
        var previousStatus = _status;
        var changed = _milestone != milestone || _status != status || _lineIndex != lineIndex;
        var lineBroke = lineIndex != _lineIndex && _lineIndex >= 0 && status == "active";
        var ended = status is "completed" or "failed";
        _health = health; _milestone = milestone; _elapsed = elapsed; _status = status; _message = message;
        _crowdTotal = crowdTotal; _activeRaiders = activeRaiders; _activePolice = activePolice; _subject = subject;
        _outcome = outcome; _totalPolice = totalPolice; _lineIndex = lineIndex; _lineIntegrity = lineIntegrity;
        _graphicsLabel = graphics; _sheltering = sheltering; _grenades = grenades; _smoke = smoke;
        // Each attempt that ends refreshes the report, including the demo's repeated runs.
        if (ended && previousStatus is not ("completed" or "failed")) _ = LoadReportAsync();
        if (changed) _announcement = status != "active" ? $"Scenario {status}. {ResultHeading}"
            : lineBroke ? $"A police line has given way. {HudTitle}" : HudTitle;
        if (_role == "raider" && !_demo && !_recorded && ended)
        {
            _recorded = true;
            try
            {
                await Results.RecordAsync("pocapitol", PlayerNames.GetPlayerName(),
                    _difficulty == "story" ? Difficulty.Easy : Difficulty.Medium,
                    status == "completed" ? GameResult.Win : GameResult.Loss);
            }
            catch (JSException ex)
            {
                Logger.LogError(ex, "PoCapitol local result could not be saved");
                _resultWarning = "Your result could not be saved locally.";
            }
        }
        await InvokeAsync(StateHasChanged);
    }

    [JSInvokable]
    public Task OnEngineError(string detail)
    {
        if (_disposed) return Task.CompletedTask;
        Logger.LogError("PoCapitol engine error: {Detail}", detail);
        _status = "error";
        _error = "The scenario stopped unexpectedly. Retry to start a fresh attempt, or return to all games.";
        return InvokeAsync(StateHasChanged);
    }

    [JSInvokable]
    public Task OnTelemetryUpdate(TelemetryDto? telemetry)
    {
        if (_disposed) return Task.CompletedTask;
        _selectedTelemetry = telemetry;
        return InvokeAsync(StateHasChanged);
    }

    [JSInvokable]
    public Task OnWeatherUpdate(string condition)
    {
        if (_disposed) return Task.CompletedTask;
        _weatherCondition = condition;
        return InvokeAsync(StateHasChanged);
    }

    /// <summary>Spoken radio arrives as a caption when the player has asked for them.</summary>
    [JSInvokable]
    public Task OnCaption(string text)
    {
        if (_disposed || !_prefs.captions || string.IsNullOrWhiteSpace(text)) return Task.CompletedTask;
        _caption = text;
        var stamp = _captionStamp = DateTime.UtcNow;
        _ = ClearCaptionAsync(stamp);
        return InvokeAsync(StateHasChanged);
    }

    private async Task ClearCaptionAsync(DateTime stamp)
    {
        await Task.Delay(6000);
        if (_disposed || _captionStamp != stamp) return;
        _caption = "";
        await InvokeAsync(StateHasChanged);
    }

    public async ValueTask DisposeAsync()
    {
        _disposed = true;
        if (_ready)
        {
            try { await JS.InvokeVoidAsync("PoCapitol.dispose"); }
            catch (JSDisconnectedException ex) { Logger.LogDebug(ex, "PoCapitol browser disconnected during disposal"); }
        }
        _reference?.Dispose();
        GC.SuppressFinalize(this);
    }

    private void ToggleRadar()
    {
        _radarExpanded = !_radarExpanded;
        if (_radarExpanded) _radarNeedsInit = true;
    }

    private async Task ToggleLatchAsync()
    {
        try
        {
            var isLatched = await JS.InvokeAsync<bool>("PoCapitol.toggleUnitLatch");
            if (_selectedTelemetry != null) _selectedTelemetry.latched = isLatched;
        }
        catch (JSException ex) { Logger.LogDebug(ex, "PoCapitol camera latch unavailable"); }
    }

    private async Task ClearInspectAsync()
    {
        _selectedTelemetry = null;
        try { await JS.InvokeVoidAsync("PoCapitol.clearUnitInspect"); }
        catch (JSException ex) { Logger.LogDebug(ex, "PoCapitol inspector unavailable"); }
    }

    private async Task SetWeatherAsync(string mode)
    {
        _weatherMode = mode;
        try { _weatherCondition = await JS.InvokeAsync<string>("PoCapitol.setWeather", mode); }
        catch (JSException ex) { Logger.LogDebug(ex, "PoCapitol weather unavailable"); }
    }

    private async Task OnSensitivityChanged(ChangeEventArgs e)
    {
        if (double.TryParse(e.Value?.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var value))
        {
            await SavePrefsAsync(sensitivity: value);
        }
    }

    private async Task OnFovChanged(ChangeEventArgs e)
    {
        if (int.TryParse(e.Value?.ToString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var value))
        {
            await SavePrefsAsync(fov: value);
        }
    }

    private Task OnDebriefModelChanged(ChangeEventArgs e) => SavePrefsAsync(debriefModel: e.Value?.ToString()?.Trim());

    /// <summary>
    /// Bind a key. The engine owns the rule that one key does one thing: if the key is already
    /// in use the two actions swap, and the map that comes back is what the rows then show.
    /// </summary>
    private async Task SetKeyAsync(string action, object? value)
    {
        if (value?.ToString() is not { Length: > 0 } code) return;
        try { _prefs = await JS.InvokeAsync<PrefsDto>("PoCapitol.rebindKey", action, code); }
        catch (JSException ex) { Logger.LogWarning(ex, "PoCapitol could not rebind {Action}", action); }
    }

    private static string DescribeKey(string code) => code switch
    {
        "Space" => "Space",
        "ShiftLeft" => "Shift",
        "ControlLeft" => "Ctrl",
        _ => code.StartsWith("Key", StringComparison.Ordinal) ? code[3..] : code,
    };

    /// <summary>
    /// Save one or more comfort settings. Values are echoed back from the engine sanitised, so
    /// a slider that leaves the allowed range snaps to the clamped value rather than drifting.
    /// </summary>
    private async Task SavePrefsAsync(double? sensitivity = null, int? fov = null, bool? captions = null,
        string? contrast = null, string? radar = null, bool? director = null, string? tracers = null,
        string? motion = null, string? debrief = null, string? debriefModel = null, string? footage = null)
    {
        if (sensitivity is not null) _prefs.sensitivity = sensitivity.Value;
        if (fov is not null) _prefs.fov = fov.Value;
        if (captions is not null)
        {
            _prefs.captions = captions.Value;
            if (!_prefs.captions) _caption = "";
        }
        if (contrast is not null) _prefs.contrast = contrast;
        if (radar is not null) _prefs.radar = radar;
        if (director is not null) _prefs.director = director.Value;
        if (tracers is not null) _prefs.tracers = tracers;
        if (motion is not null) _prefs.motion = motion;
        if (footage is not null) _prefs.footage = footage;
        if (debrief is not null)
        {
            _prefs.debrief = debrief;
            _probeStatus = "";
        }
        if (!string.IsNullOrEmpty(debriefModel)) _prefs.debriefModel = debriefModel;
        try
        {
            // Keys are not sent: they only change through rebindKey, which owns the swap rule.
            _prefs = await JS.InvokeAsync<PrefsDto>("PoCapitol.setPrefs", new PrefsPatch
            {
                sensitivity = _prefs.sensitivity,
                fov = _prefs.fov,
                captions = _prefs.captions,
                contrast = _prefs.contrast,
                radar = _prefs.radar,
                director = _prefs.director,
                tracers = _prefs.tracers,
                motion = _prefs.motion,
                footage = _prefs.footage,
                debrief = _prefs.debrief,
                debriefModel = _prefs.debriefModel,
            });
        }
        catch (JSException ex)
        {
            // A comfort setting is not worth ending the scenario for: keep the local value and move on.
            Logger.LogWarning(ex, "PoCapitol could not persist comfort settings");
        }
        StateHasChanged();
    }

    private async Task LoadReportAsync()
    {
        try { _report = await JS.InvokeAsync<ReportDto>("PoCapitol.getReportView"); }
        catch (JSException ex) { Logger.LogDebug(ex, "PoCapitol report unavailable"); }
        await InvokeAsync(StateHasChanged);
        await LoadDebriefAsync();
    }

    /// <summary>
    /// Ask the engine's router to write the debrief. It always resolves: a local model that is
    /// missing or slow falls back to the built-in writer and says so in the result.
    /// </summary>
    private async Task LoadDebriefAsync()
    {
        if (_disposed || _report is null) return;
        _debriefBusy = true;
        await InvokeAsync(StateHasChanged);
        try { _debrief = await JS.InvokeAsync<DebriefDto?>("PoCapitol.getDebrief"); }
        catch (JSException ex) { Logger.LogDebug(ex, "PoCapitol debrief unavailable"); }
        finally { _debriefBusy = false; }
        if (!_disposed) await InvokeAsync(StateHasChanged);
    }

    private async Task ProbeDebriefAsync()
    {
        _probeStatus = "Checking…";
        StateHasChanged();
        try
        {
            var probe = await JS.InvokeAsync<ProbeDto>("PoCapitol.probeDebrief");
            var installed = probe.models.Split(", ", StringSplitOptions.RemoveEmptyEntries);
            if (!probe.available)
            {
                _probeStatus = "No local model answered at localhost:11434. The built-in writer will be used.";
            }
            else if (installed.Length == 0)
            {
                _probeStatus = "Connected, but no models are installed.";
            }
            else if (Array.Exists(installed, name => name == _prefs.debriefModel || name == $"{_prefs.debriefModel}:latest"))
            {
                _probeStatus = $"Connected. Models: {probe.models}";
            }
            else
            {
                // The model named here is not installed, so a debrief would only ever fall back.
                // Use one that is, and say so.
                var missing = _prefs.debriefModel;
                await SavePrefsAsync(debriefModel: installed[0]);
                _probeStatus = $"Connected. {missing} is not installed, so {_prefs.debriefModel} will be used. Models: {probe.models}";
            }
        }
        catch (JSException ex)
        {
            Logger.LogDebug(ex, "PoCapitol debrief probe unavailable");
            _probeStatus = "The check could not run in this browser.";
        }
        StateHasChanged();
    }

    private string ReportFileName(string extension) =>
        string.Create(CultureInfo.InvariantCulture,
            $"pocapitol-{DateTime.Now:yyyyMMdd-HHmm}-{(_report is { mode.Length: > 0 } r ? r.mode : "attempt")}.{extension}");

    private async Task ExportCsvAsync()
    {
        if (_report is null) return;
        try { await JS.InvokeVoidAsync("PoCapitol.download", ReportFileName("csv"), _report.csv); }
        catch (JSException ex) { Logger.LogDebug(ex, "PoCapitol CSV export unavailable"); }
    }

    private async Task ExportPngAsync()
    {
        if (_report is null) return;
        try { await JS.InvokeAsync<bool>("PoCapitol.exportPng", "pocapitol-report-chart", ReportFileName("png")); }
        catch (JSException ex) { Logger.LogDebug(ex, "PoCapitol PNG export unavailable"); }
    }

    private async Task CopySummaryAsync()
    {
        if (_report is null) return;
        var text = _debrief is { text.Length: > 0 } d ? $"{_report.text}\n\n{d.text}" : _report.text;
        try { await JS.InvokeAsync<bool>("PoCapitol.copyText", text); }
        catch (JSException ex) { Logger.LogDebug(ex, "PoCapitol clipboard unavailable"); }
    }

    private async Task CopyDiagnosticsAsync()
    {
        try
        {
            var text = await JS.InvokeAsync<string>("PoCapitol.getDiagnosticsText");
            await JS.InvokeAsync<bool>("PoCapitol.copyText", $"{text}\nDebrief {DebriefMeta}");
        }
        catch (JSException ex) { Logger.LogDebug(ex, "PoCapitol diagnostics unavailable"); }
    }

    // The engine's records. Lower-case members match the JS objects one to one, and every
    // record is flat so the trimmed WASM build never needs nested deserialisation.
#pragma warning disable IDE1006 // Naming: these mirror JS property names.

    public sealed class PrefsDto
    {
        public double sensitivity { get; set; } = 1;
        public int fov { get; set; } = 62;
        public bool captions { get; set; }
        public string contrast { get; set; } = "normal";
        public string radar { get; set; } = "auto";
        public bool director { get; set; } = true;
        public string tracers { get; set; } = "luminous";
        public string motion { get; set; } = "full";
        public string footage { get; set; } = "light";
        public string debrief { get; set; } = "rules";
        public string debriefModel { get; set; } = "llama3.2";
        public string forward { get; set; } = "KeyW";
        public string back { get; set; } = "KeyS";
        public string left { get; set; } = "KeyA";
        public string right { get; set; } = "KeyD";
        public string push { get; set; } = "Space";
        public string sprint { get; set; } = "ShiftLeft";
        public string pause { get; set; } = "KeyP";
    }

    /// <summary>What the page may change through <c>setPrefs</c>: everything but the key map.</summary>
    public sealed class PrefsPatch
    {
        public double sensitivity { get; set; }
        public int fov { get; set; }
        public bool captions { get; set; }
        public string contrast { get; set; } = "";
        public string radar { get; set; } = "";
        public bool director { get; set; }
        public string tracers { get; set; } = "";
        public string motion { get; set; } = "";
        public string footage { get; set; } = "";
        public string debrief { get; set; } = "";
        public string debriefModel { get; set; } = "";
    }

    public sealed class ReportDto
    {
        public string svg { get; set; } = "";
        public string csv { get; set; } = "";
        public string text { get; set; } = "";
        public string mode { get; set; } = "";
        public string role { get; set; } = "";
        public string difficulty { get; set; } = "";
        public string outcome { get; set; } = "";
        public string status { get; set; } = "";
        public string clock { get; set; } = "";
        public int standing { get; set; }
        public int police { get; set; }
        public int casualties { get; set; }
        public int immediate { get; set; }
        public int lowestIntegrity { get; set; }
        public double peakPressure { get; set; }
        public double firstBreak { get; set; } = -1;
        public int milestones { get; set; }
        public int minutes { get; set; }
    }

    /// <summary>The debrief and the telemetry of whatever wrote it.</summary>
    public sealed class DebriefDto
    {
        public string text { get; set; } = "";
        public string provider { get; set; } = "rules";
        public string model { get; set; } = "";
        public int ms { get; set; }
        public int tokens { get; set; }
        public double tokensPerSecond { get; set; }
        public int retries { get; set; }
        public bool fallback { get; set; }
        public string error { get; set; } = "";
    }

    public sealed class ProbeDto
    {
        public bool available { get; set; }
        public string models { get; set; } = "";
        public string error { get; set; } = "";
    }

    public sealed class TelemetryDto
    {
        public int id { get; set; }
        public string faction { get; set; } = "";
        public string name { get; set; } = "";
        public string role { get; set; } = "";
        public string gear { get; set; } = "";
        public int health { get; set; }
        public int stamina { get; set; }
        public int mass { get; set; }
        public string status { get; set; } = "";
        public string? lineAssignment { get; set; }
        public string? milestone { get; set; }
        public int crowding { get; set; }
        public double density { get; set; }
        public double x { get; set; }
        public double z { get; set; }
        public bool latched { get; set; }
        public int harmHits { get; set; }
        public int harmSeverity { get; set; }
        public int harmLossMl { get; set; }
        public int harmHemorrhage { get; set; }
        public string harmTriage { get; set; } = "";
    }

#pragma warning restore IDE1006
}
