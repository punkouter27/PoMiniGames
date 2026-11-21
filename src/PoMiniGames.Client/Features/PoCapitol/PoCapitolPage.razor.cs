using System.Globalization;
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.JSInterop;
using PoMiniGamesClient.Models;
using PoMiniGames.Shared.Games;
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
    private PoCapitolEngine? _engine;

    /// <summary>The engine, through its typed wrapper (<see cref="PoCapitolEngine"/>).</summary>
    private PoCapitolEngine Engine => _engine ??= new PoCapitolEngine(JS);
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
    private bool _debriefBusy, _cardBusy;
    private string _probeStatus = "";
    private string _caption = "";
    private DateTime _captionStamp;
    private CommandDto? _command;
    private string _mapState = "";
    private bool _orderBusy;
    // The end card's report tab (0 summary, 1 charts, 2 street map) and whether the aftermath
    // map has been drawn into its canvas yet: it is drawn the first time Charts is opened.
    private int _reportTab;
    private bool _aftermathShown;
    // When the last milestone and the last "on the day" entry changed (UTC), for the HUD toasts.
    private DateTime _milestoneAt = DateTime.MinValue, _dayAt = DateTime.MinValue;
    private string _dayShown = "";
    // The keycap waiting for a key, and the one that just swapped with it (both action ids).
    private string? _listening, _swapped;
    // The longest wait seen for each order since it was last ready: the cooldown sweep's 100%.
    private readonly Dictionary<string, int> _orderMax = [];
    private readonly ElementReference[] _roleRefs = new ElementReference[4];

    /// <summary>The start card's role cards: engine value, label, Material Symbols icon.</summary>
    private static readonly (string Value, string Label, string Icon)[] Roles =
    [
        ("raider", "In the crowd", "groups"),
        ("police", "Police line", "shield"),
        ("commander", "Commander", "military_tech"),
        ("observer", "Observer", "visibility"),
    ];

    /// <summary>A sparkline point (Radzen's series binds by property name).</summary>
    public sealed record SparkPoint(double X, double Y);

    /// <summary>The incident commander's orders, in panel order: engine name, button label, key.</summary>
    private static readonly (string Order, string Label, string Key, string Icon)[] Orders =
    [
        ("brace", "Brace", "B", "shield"),
        ("reinforce", "Reinforce", "R", "group_add"),
        ("relieve", "Rotate", "T", "autorenew"),
        ("gas", "Gas", "G", "air"),
        ("fallback", "Fall back", "F", "undo"),
    ];

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

    private bool Playing => !_demo && _role is not ("observer" or "commander");

    private bool Commanding => !_demo && _role == "commander";

    /// <summary>Only a solo player in the crowd carries the machine gun and the grenades.</summary>
    private bool Armed => !_demo && _role == "raider";

    private string Objective => _milestone < Objectives.Length ? Objectives[_milestone] : "Chamber doors reached";

    private string Clock => DateTime.Today.AddMinutes(12 * 60 + 50 + Math.Floor(_elapsed)).ToString("h:mm tt", CultureInfo.InvariantCulture);

    private (int Minute, string Time, string Text) OnTheDay =>
        Timeline.Last(entry => entry.Minute <= Math.Max(Timeline[0].Minute, 12 * 60 + 50 + (int)_elapsed));

    private string HudEyebrow => _role == "raider" || _demo ? $"OBJECTIVE {Math.Min(_milestone + 1, Objectives.Length)} / {Objectives.Length}"
        : _role == "police" ? "HOLD UNTIL THE 6:00 PM CURFEW"
        : _role == "commander" ? "INCIDENT COMMAND · HOLD UNTIL 6:00 PM" : "OBSERVING · CROWD PROGRESS";

    private string HudTitle => _role == "police" && !_demo
        ? (_lineIndex >= 0 ? $"Hold the {LineNames[_lineIndex].ToLowerInvariant()}" : "Fall back to the chamber doors")
        : Commanding ? (_command is { } c && c.selected >= 0 && c.selected < LineNames.Length ? $"Commanding the {LineNames[c.selected].ToLowerInvariant()}" : "Command all five lines")
        : Objective;

    private string RoleBrief => _role switch
    {
        "police" => "Stand in the line and push back. You win by keeping the crowd from the chamber doors until the curfew. Not saved to your stats.",
        "observer" => "Walk anywhere and watch. Nobody targets you, you cannot push, and nothing is saved.",
        "commander" => "Run all five lines from above. Brace a line, move officers up from behind, rotate a tired front rank, call gas, or order an orderly fall-back. You win if the crowd never reaches the chamber doors before the curfew. Not saved to your stats.",
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
                "commander" => $"1–5 pick a line · B brace · R reinforce · T rotate · G gas · F fall back · ← → swing · V overlay · {pause}",
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
            + (_role is "police" or "commander" ? "The lines did not hold long enough." : "Nobody in this scenario gets in, as nobody did. Reaching the doors ends the game; it is not a historical victory."),
        "curfew" => _role is "police" or "commander" ? "The lines held until the curfew and the building was cleared."
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
        _role != "raider" ? "Police-line, command and observer attempts are not saved."
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
                    await Engine.DisposeEngineAsync();
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
            try { await Engine.InitRadarAsync("pocapitol-radar"); }
            catch (JSException ex) { Logger.LogDebug(ex, "PoCapitol radar is not ready yet"); }
        }
    }

    private async Task LoadAsync()
    {
        _status = "loading";
        StateHasChanged();
        try
        {
            if (!await Engine.LoadAsync())
                throw new InvalidOperationException("The 3D assets could not be downloaded. Check your connection and retry.");
            _reference ??= DotNetObjectReference.Create(this);
            await Engine.InitAsync("pocapitol-scene", _reference);
            _graphics = await Engine.GetGraphicsAsync();
            _weatherMode = await Engine.GetWeatherAsync();
            _prefs = await Engine.GetPrefsAsync();
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
            await Engine.StartAsync(_difficulty, _demo, _role);
            _recorded = false;
            _report = null;
            _debrief = null;
            _caption = "";
            _command = null;
            _mapState = "";
            _reportTab = 0;
            _aftermathShown = false;
            _milestoneAt = _dayAt = DateTime.MinValue;
            _dayShown = "";
            _orderMax.Clear();
            _status = "active";
            _health = 100; _milestone = 0; _elapsed = 0; _message = ""; _resultWarning = ""; _outcome = "";
            _activeRaiders = _crowdTotal; _activePolice = 44; _totalPolice = 44; _subject = 0; _lineIndex = 0; _lineIntegrity = 100; _sheltering = 64;
            _announcement = "Scenario started. " + HudTitle;
        }
        catch (JSException ex) { await OnEngineError(ex.Message); }
    }

    private async Task PauseAsync(bool paused)
    {
        try { await Engine.PauseAsync(paused); }
        catch (JSException ex) { await OnEngineError(ex.Message); }
    }

    private async Task SetGraphicsAsync(string mode)
    {
        _graphics = mode;
        try { _graphicsLabel = await Engine.SetGraphicsAsync(mode); }
        catch (JSException ex) { await OnEngineError(ex.Message); }
    }

    private void RecoverFromError()
    {
        _errorBoundary?.Recover();
        _status = "loading";
        _ = LoadAsync();
    }

    /// <summary>A 0–100 reading's tone: good above half, a warning above a quarter, bad below.</summary>
    private static string ToneName(int value) => value > 50 ? "good" : value > 25 ? "warn" : "bad";

    /// <summary>The ring class for a 0–100 reading (pc-ring--good / --warn / --bad).</summary>
    private static string Tone(int value) => $"pc-ring--{ToneName(value)}";

    /// <summary>A HUD toast is shown for this long after the change that raised it.</summary>
    private static bool ToastLive(DateTime at) => (DateTime.UtcNow - at).TotalSeconds < 5;

    /// <summary>A comma-separated series from the engine as sparkline points (null when empty).</summary>
    private static List<SparkPoint>? Spark(string? csv)
    {
        if (string.IsNullOrEmpty(csv)) return null;
        var parts = csv.Split(',');
        var points = new List<SparkPoint>(parts.Length);
        for (var i = 0; i < parts.Length; i++)
        {
            if (double.TryParse(parts[i], NumberStyles.Float, CultureInfo.InvariantCulture, out var y)) points.Add(new SparkPoint(i, y));
        }
        return points;
    }

    /// <summary>The gamepad control for an action, shown beside its keycap.</summary>
    private static string PadGlyph(string action) => action switch
    {
        "forward" or "back" or "left" or "right" => "L-stick",
        "push" => "RT",
        "sprint" => "L3",
        "pause" => "Start",
        _ => "",
    };

    /// <summary>Arrow keys move between the role cards, as a radio group should.</summary>
    private async Task RoleKeyAsync(int index, KeyboardEventArgs e)
    {
        var step = e.Key switch { "ArrowRight" or "ArrowDown" => 1, "ArrowLeft" or "ArrowUp" => -1, _ => 0 };
        if (step == 0) return;
        var next = (index + step + Roles.Length) % Roles.Length;
        _role = Roles[next].Value;
        StateHasChanged();
        await Task.Yield();
        try { await _roleRefs[next].FocusAsync(); }
        catch (InvalidOperationException) { /* not rendered yet */ }
    }

    /// <summary>
    /// A keycap is listening: the next key pressed is the new binding (Esc cancels). Only codes
    /// the engine accepts (letters, digits and named keys) are taken.
    /// </summary>
    private async Task CaptureKeyAsync(string action, KeyboardEventArgs e)
    {
        if (_listening != action) return;
        if (e.Code is "Escape" or "Tab" || e.Key == "Escape")
        {
            _listening = null;
            return;
        }
        if (string.IsNullOrEmpty(e.Code) || e.Code.StartsWith("Arrow", StringComparison.Ordinal)) return;
        var before = KeyRows.ToDictionary(r => r.Action, r => r.Code);
        _listening = null;
        await SetKeyAsync(action, e.Code);
        // Whichever other action now holds this action's old key is the one that swapped.
        _swapped = KeyRows.FirstOrDefault(r => r.Action != action && before.TryGetValue(r.Action, out var was) && was != r.Code).Action;
        if (_swapped is not null) _ = ClearSwapAsync();
    }

    private async Task ClearSwapAsync()
    {
        await Task.Delay(1200);
        _swapped = null;
        if (!_disposed) await InvokeAsync(StateHasChanged);
    }

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
        if (milestone > _milestone && status == "active") _milestoneAt = DateTime.UtcNow;
        _health = health; _milestone = milestone; _elapsed = elapsed; _status = status; _message = message;
        _crowdTotal = crowdTotal; _activeRaiders = activeRaiders; _activePolice = activePolice; _subject = subject;
        _outcome = outcome; _totalPolice = totalPolice; _lineIndex = lineIndex; _lineIntegrity = lineIntegrity;
        _graphicsLabel = graphics; _sheltering = sheltering; _grenades = grenades; _smoke = smoke;
        // The historical record's next entry slides in once, when the clock passes it.
        if (status == "active" && OnTheDay.Time != _dayShown)
        {
            if (_dayShown.Length > 0 || elapsed > 1) _dayAt = DateTime.UtcNow;
            _dayShown = OnTheDay.Time;
        }
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

    /// <summary>The incident commander's board, five times a second while that role plays.</summary>
    [JSInvokable]
    public Task OnCommand(CommandDto? board)
    {
        if (_disposed || board is null) return Task.CompletedTask;
        _command = board;
        return InvokeAsync(StateHasChanged);
    }

    /// <summary>A setting changed from inside the scene (V cycles the overlay): mirror it.</summary>
    [JSInvokable]
    public Task OnPrefsChanged(PrefsDto? prefs)
    {
        if (_disposed || prefs is null) return Task.CompletedTask;
        _prefs = prefs;
        return InvokeAsync(StateHasChanged);
    }

    private async Task OrderAsync(string order, int line)
    {
        if (_orderBusy || !Commanding || _status != "active") return;
        _orderBusy = true;
        try
        {
            var reply = await Engine.GiveOrderAsync(order, line);
            if (_command is not null && reply.Length > 0) _command.reply = reply;
            if (reply.Length > 0) _announcement = reply;
        }
        catch (JSException ex) { Logger.LogDebug(ex, "PoCapitol order {Order} not given", order); }
        finally { _orderBusy = false; }
    }

    /// <summary>Seconds until an order can be given again, from the board (0 when ready).</summary>
    private int OrderWait(string order) => _command is not { } c ? 0 : order switch
    {
        "reinforce" => c.reinforceIn,
        "relieve" => c.relieveIn,
        "gas" => c.gasIn,
        _ => 0,
    };

    /// <summary>How much of an order's cooldown is left, 0–100, for the sweep round its button.</summary>
    private int OrderSweep(string order)
    {
        var wait = OrderWait(order);
        if (wait <= 0)
        {
            _orderMax.Remove(order);
            return 0;
        }
        if (!_orderMax.TryGetValue(order, out var max) || wait > max) _orderMax[order] = max = wait;
        return (int)Math.Round(100.0 * wait / Math.Max(1, max));
    }

    private static int[] Csv(string? value) =>
        string.IsNullOrEmpty(value) ? []
        : Array.ConvertAll(value.Split(','), part => int.TryParse(part, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) ? n : 0);

    /// <summary>The street map of the attempt (OpenStreetMap via MapLibre): only loaded when asked for.</summary>
    private async Task ShowStreetMapAsync()
    {
        if (_report is null || _mapState is "loading" or "live") return;
        _mapState = "loading";
        StateHasChanged();
        // The container is rendered by the state change above; give the render a turn before drawing into it.
        await Task.Yield();
        try { _mapState = await Engine.ShowStreetMapAsync("pocapitol-streetmap") ? "live" : "failed"; }
        catch (JSException ex)
        {
            Logger.LogDebug(ex, "PoCapitol street map unavailable");
            _mapState = "failed";
        }
        StateHasChanged();
    }

    /// <summary>
    /// A report tab opened. Charts draws the aftermath map into its canvas the first time; the
    /// street map loads its tiles only when its own tab is opened (that is the opt-in).
    /// </summary>
    private async Task OnReportTabAsync(int index)
    {
        _reportTab = index;
        if (index == 1 && !_aftermathShown)
        {
            _aftermathShown = true;
            await Task.Yield();
            await ShowAftermathAsync();
        }
        else if (index == 2 && _mapState is "" or "failed")
        {
            await ShowStreetMapAsync();
        }
    }

    /// <summary>The Export split button: its face saves the report card, its menu every other file.</summary>
    private async Task OnExportAsync(Radzen.Blazor.RadzenSplitButtonItem? item)
    {
        switch (item?.Value ?? "card")
        {
            case "chart": await ExportPngAsync(); break;
            case "csv": await ExportCsvAsync(); break;
            case "geojson": await ExportGeoJsonAsync(); break;
            case "copy": await CopySummaryAsync(); break;
            default: await SaveReportCardAsync(); break;
        }
    }

    private async Task ExportGeoJsonAsync()
    {
        if (_report is null) return;
        try
        {
            var json = await Engine.GetGeoJsonAsync();
            if (json.Length > 0) await Engine.DownloadAsync(ReportFileName("geojson"), json);
        }
        catch (JSException ex) { Logger.LogDebug(ex, "PoCapitol GeoJSON export unavailable"); }
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
            try { await Engine.DisposeEngineAsync(); }
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
            var isLatched = await Engine.ToggleUnitLatchAsync();
            if (_selectedTelemetry != null) _selectedTelemetry.latched = isLatched;
        }
        catch (JSException ex) { Logger.LogDebug(ex, "PoCapitol camera latch unavailable"); }
    }

    private async Task ClearInspectAsync()
    {
        _selectedTelemetry = null;
        try { await Engine.ClearUnitInspectAsync(); }
        catch (JSException ex) { Logger.LogDebug(ex, "PoCapitol inspector unavailable"); }
    }

    private async Task SetWeatherAsync(string mode)
    {
        _weatherMode = mode;
        try { _weatherCondition = await Engine.SetWeatherAsync(mode); }
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
        try { _prefs = await Engine.RebindKeyAsync(action, code); }
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
        string? motion = null, string? debrief = null, string? debriefModel = null, string? footage = null,
        string? score = null, string? hailer = null, string? overlay = null, string? hudSound = null)
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
        if (score is not null) _prefs.score = score;
        if (hailer is not null) _prefs.hailer = hailer;
        if (overlay is not null) _prefs.overlay = overlay;
        if (hudSound is not null) _prefs.hudSound = hudSound;
        if (debrief is not null)
        {
            _prefs.debrief = debrief;
            _probeStatus = "";
        }
        if (!string.IsNullOrEmpty(debriefModel)) _prefs.debriefModel = debriefModel;
        try
        {
            // Keys are not sent: they only change through rebindKey, which owns the swap rule.
            _prefs = await Engine.SetPrefsAsync(new PrefsPatch
            {
                sensitivity = _prefs.sensitivity,
                fov = _prefs.fov,
                captions = _prefs.captions,
                contrast = _prefs.contrast,
                // The radar's palette now follows the app-wide colour-safe setting.
                radar = "auto",
                director = _prefs.director,
                tracers = _prefs.tracers,
                motion = _prefs.motion,
                footage = _prefs.footage,
                debrief = _prefs.debrief,
                debriefModel = _prefs.debriefModel,
                score = _prefs.score,
                hailer = _prefs.hailer,
                overlay = _prefs.overlay,
                hudSound = _prefs.hudSound,
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
        try { _report = await Engine.GetReportViewAsync(); }
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
        try { _debrief = await Engine.GetDebriefAsync(); }
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
            var probe = await Engine.ProbeDebriefAsync();
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
        try { await Engine.DownloadAsync(ReportFileName("csv"), _report.csv); }
        catch (JSException ex) { Logger.LogDebug(ex, "PoCapitol CSV export unavailable"); }
    }

    private async Task ExportPngAsync()
    {
        if (_report is null) return;
        try { await Engine.ExportPngAsync("pocapitol-report-chart", ReportFileName("png")); }
        catch (JSException ex) { Logger.LogDebug(ex, "PoCapitol PNG export unavailable"); }
    }

    /// <summary>
    /// The aftermath map over the report (aftermath.js: WebGPU, TSL materials). The engine waits
    /// for the canvas (it appears when "More details" opens) and opens its frame only once it is
    /// drawing, so a browser that cannot draw it keeps the plain report.
    /// </summary>
    private async Task ShowAftermathAsync()
    {
        if (_disposed || _report is null) return;
        try { await Engine.ShowAftermathAsync("pocapitol-aftermath"); }
        catch (JSException ex) { Logger.LogDebug(ex, "PoCapitol aftermath map unavailable"); }
    }

    /// <summary>
    /// The shareable report card: the engine hands over the attempt's series, the API draws the
    /// card (SkiaSharp, POST /api/pocapitol/report-card) and the bytes are saved as a PNG.
    /// </summary>
    private async Task SaveReportCardAsync()
    {
        if (_report is null || _cardBusy) return;
        _cardBusy = true;
        try
        {
            var request = await Engine.GetReportCardAsync<PoCapitolReportCardRequest?>();
            var png = request is null ? null : await Api.GetPoCapitolReportCardAsync(request);
            if (png is { Length: > 0 }) await Engine.DownloadBytesAsync(ReportFileName("card.png"), png, "image/png");
            else Logger.LogWarning("PoCapitol report card could not be drawn");
        }
        catch (JSException ex) { Logger.LogDebug(ex, "PoCapitol report card unavailable"); }
        finally { _cardBusy = false; }
    }

    private async Task CopySummaryAsync()
    {
        if (_report is null) return;
        var text = _debrief is { text.Length: > 0 } d ? $"{_report.text}\n\n{d.text}" : _report.text;
        try { await Engine.CopyTextAsync(text); }
        catch (JSException ex) { Logger.LogDebug(ex, "PoCapitol clipboard unavailable"); }
    }

    private async Task CopyDiagnosticsAsync()
    {
        try
        {
            var text = await Engine.GetDiagnosticsTextAsync();
            await Engine.CopyTextAsync($"{text}\nDebrief {DebriefMeta}");
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
        public string score { get; set; } = "off";
        public string hailer { get; set; } = "off";
        public string overlay { get; set; } = "off";
        public string hudSound { get; set; } = "off";
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
        public string score { get; set; } = "";
        public string hailer { get; set; } = "";
        public string overlay { get; set; } = "";
        public string hudSound { get; set; } = "";
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
        public double peakDensity { get; set; }
        public string peakGrade { get; set; } = "A";
        public int riskSeconds { get; set; }
        public int riskEpisodes { get; set; }
        public double packedShare { get; set; }
        public double peakPushing { get; set; }
        public double peakTipped { get; set; }
        /// <summary>Orders the commander gave, or -1 when nobody was commanding.</summary>
        public int orders { get; set; } = -1;
        public int withdrawn { get; set; }
        public string sparkIntegrity { get; set; } = "";
        public string sparkPressure { get; set; } = "";
        public string sparkRaiders { get; set; } = "";
        public string sparkPolice { get; set; } = "";
        public string sparkCasualties { get; set; } = "";
    }

    /// <summary>
    /// The incident commander's board (index.js commandView). Per-line lists are comma-separated
    /// strings, front line first, so the record stays flat for the trimmed build.
    /// </summary>
    public sealed class CommandDto
    {
        public int selected { get; set; }
        public int gas { get; set; }
        public int issued { get; set; }
        public string reply { get; set; } = "";
        public int reinforceIn { get; set; }
        public int relieveIn { get; set; }
        public int gasIn { get; set; }
        public string braced { get; set; } = "";
        public string integrity { get; set; } = "";
        public string strain { get; set; } = "";
        public string officers { get; set; } = "";
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
