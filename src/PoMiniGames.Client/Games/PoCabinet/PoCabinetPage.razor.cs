using System.Text.Json;
using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Models;
using PoMiniGamesClient.Services.Play;

namespace PoMiniGamesClient.Games.PoCabinet;

/// <summary>
/// Code-behind for <see cref="PoCabinetPage"/>. The page lifecycle is:
/// <list type="number">
///   <item><b>Start</b> — the shared card: how to play and, in 1P, the track list. 1p/demo go
///         to <see cref="Phase.Loading"/>; multiplayer joins the one lobby (first in hosts; there
///         are no codes).</item>
///   <item><b>Lobby</b> — <see cref="PoCabinetLobby"/>; its <c>RaceStarting</c> hand-off calls
///         <see cref="BeginWireModeAsync"/> directly. (It used to navigate to this same page with
///         a query string, which Blazor treats as a parameter change on the live component —
///         <c>OnInitializedAsync</c> never re-ran, so no multiplayer race ever started.)</item>
///   <item><b>Loading → Racing</b> — mount the scene against the static world
///         (<see cref="PoCabinetTrackGeometry"/>, or the server's copy online), then hand the
///         frame loop to <c>js/pocabinet/race.js</c>: it simulates solo races, predicts the
///         local car online, renders every car and records the race.</item>
///   <item><b>Finished</b> — <see cref="PoCabinetResults"/> over the still-running scene, with
///         the telemetry chart.</item>
/// </list>
/// <para>
/// The page is the HUD, not the renderer: it receives a snapshot per tick (from race.js for
/// solo races, from the server for multiplayer) and derives lap timing, countdown beeps,
/// dialogue and the finish from it. Sector splits come from race.js (<see cref="OnSectorAsync"/>),
/// which knows the exact crossing instant. Cars, camera, minimap and engine audio are
/// race.js's job, per frame, with no interop round trip.
/// </para>
/// </summary>
public partial class PoCabinetPageBase : ComponentBase, IAsyncDisposable
{
    [Inject] private IJSRuntime JS { get; set; } = default!;
    [Inject] private PlayerNameService PlayerNameSvc { get; set; } = default!;
    [Inject] private GameResultService GameResults { get; set; } = default!;
    [Inject] private PoCabinetSession Session { get; set; } = default!;
    [Inject] private PoCabinetCareerState Career { get; set; } = default!;

    [Parameter] public string? ModeSegment { get; set; }

    protected enum Phase { Start, Lobby, Loading, Racing, Finished }

    // There is no 2P mode: a stale /pocabinet/2player link plays 1P.
    protected GameMode Mode => GameModes.Parse(ModeSegment) is var m && m == GameMode.TwoPlayer ? GameMode.OnePlayer : m;

    protected string _playerName = "Player";
    protected Phase _phase = Phase.Start;
    /// <summary>The stored settings are read: the opening card may render.</summary>
    protected bool _loaded;
    protected string? _trackId = PoCabinetCatalog.DefaultTrackId;
    protected string? _color = "Indigo";

    protected int _lap = 1;
    protected int _position = 1;
    /// <summary>+1 when the last place change was a gain, −1 a loss (drives the badge colour).</summary>
    private int _positionDelta;
    protected string PosBadgeKey => $"pos-{_position}";
    protected string PosBadgeClass => _positionDelta > 0 ? "pocabinet-posbadge--up" : _positionDelta < 0 ? "pocabinet-posbadge--down" : "";
    protected int _totalLaps = PoCabinetCatalog.TotalLaps;
    protected int _totalCars = PoCabinetCatalog.SoloCarCount;
    protected double _lapSeconds;
    /// <summary>The screen-reader channel (laps, places, radio lines, the finish).</summary>
    protected string? _liveAnnouncement;
    private long _placeAnnouncedAt;
    protected string? _status;
    private bool _pauseShown;

    protected PoCabinetTalk.Debrief? _debrief;

    protected PoCabinetUiSettings Settings { get; private set; } = new();

    protected bool _paused;
    protected int? _pingMs;
    protected int _countdownDisplay;
    protected bool _showGo;
    protected List<PoCabinetResults.Row>? _finalStandings;
    protected bool _isPersonalBest;
    protected double _previousBest = -1;
    /// <summary>Online: the local car is home but the server has not called the race yet.</summary>
    protected bool _awaitingFinal;

    /// <summary>This race's laps and sectors (the HUD, the pause card, the results).</summary>
    protected PoCabinetLapBook _laps = new();
    private int _lastCountdown = -1;
    private double _goUntilElapsed;

    protected PoCabinetRaceSnapshot? _lastSnapshot;

    // Telemetry (race.js owns the data; these are the view model).
    protected string? _telemetrySummary;
    protected bool _hasReferenceLap;
    private bool _telemetryDrawn;
    /// <summary>The player's car was wrecked: a DNF (no place, no stage credit).</summary>
    protected bool _dnf;
    /// <summary>What this race did for the campaign, decided when the result is recorded.</summary>
    private (string Text, bool Good)? _campaignNote;

    /// <summary>Only a 1P race pauses: the server owns online time, and the demo is a broadcast.</summary>
    protected bool Pausable => Mode == GameMode.OnePlayer && _phase == Phase.Racing;

    protected bool IsMultiplayerMode => Mode == GameMode.Multiplayer;

    protected bool IsSpectating => IsMultiplayerMode && _gameCode is not null && _localCarId is null;

    protected string PlayerColorHex => PoCabinetPaintShop.HexFor(_color);

    protected string TrackName => PoCabinetCatalog.GetTrack(_trackId).Name;

    protected string PingClass => (_pingMs ?? 999) switch
    {
        < 90 => "pocabinet-ping--good",
        < 220 => "pocabinet-ping--fair",
        _ => "pocabinet-ping--poor",
    };

    protected string Lede => Mode == GameMode.Demo
        ? $"A hundred cars race themselves, covered like TV: the director cuts to the closest battles. {RaceLength}."
        : IsMultiplayerMode
            ? $"Everyone who joins lands in one lobby — first in hosts and picks the track. {RaceLength}."
            : $"Pick a track and take on 99 rivals from the middle of the grid. {RaceLength}; a top-{PoCabinetCatalog.CampaignPassPlace} finish moves the campaign on.";

    /// <summary>The place that earns the fanfare and counts as a win: the podium in a
    /// multiplayer-sized field, the top ten of the 100-car solo field.</summary>
    private int FrontRunnerCut => _totalCars > PoCabinetCatalog.CarCount ? PoCabinetCatalog.SoloFrontRunners : 3;

    /// <summary>"3 laps" on a circuit; the Playground run is point-to-point, once.</summary>
    private string RaceLength => PoCabinetTrackGeometry.Get(_trackId).Laps is var laps && laps == 1
        ? "One run, start to finish"
        : $"{laps} laps";

    protected static RenderFragment TitleContent => GameCatalog.TitleFor(GameKeys.PoCabinet);

    protected PoCabinetDrawer? _drawer;

    /// <summary>What THIS race did for the campaign (1P, a stage track), as a results chip.
    /// It used to read the career instead, so a P90 on a stage cleared last week said "cleared ✓".</summary>
    protected (string Text, bool Good)? CampaignNote => Mode == GameMode.OnePlayer && !_awaitingFinal ? _campaignNote : null;

    /// <summary>The chip for a race on campaign stage <paramref name="stage"/>, from the career as it
    /// stood before the race was recorded.</summary>
    private static (string Text, bool Good)? StageNote(PoCabinetCareerDto career, int stage, int position, bool dnf)
    {
        var n = stage + 1;
        var cleared = career.CompletedStages.Contains(stage);
        if (dnf) return cleared ? null : ($"Wrecked — no credit for Stage {n}", false);
        var counts = stage == career.CurrentStageIndex || cleared;
        if (!counts) return ($"Stage {n} opens after Stage {career.CurrentStageIndex + 1}", false);
        if (position > PoCabinetCatalog.CampaignPassPlace)
            return cleared ? null : ($"Stage {n}: top {PoCabinetCatalog.CampaignPassPlace} needed to advance", false);
        var final = stage == PoCabinetCatalog.CampaignStages - 1;
        if (final && position <= PoCabinetCatalog.CampaignTrophyPlace) return ("🏆 Campaign won", true);
        if (final) return ($"Stage {n} cleared ✓ · a top {PoCabinetCatalog.CampaignTrophyPlace} wins the trophy", true);
        return cleared ? null : ($"Stage {n} cleared ✓", true);
    }

    private IJSObjectReference? _sceneHandle;
    private IJSObjectReference? _dialogueHandle;
    private IJSObjectReference? _minimapHandle;
    private IJSObjectReference? _envHandle;
    private string? _lastDialogueKey;
    /// <summary>Bumped by every teardown; keys the race section so a restart mounts on new canvases.</summary>
    protected int _raceSerial;
    private DotNetObjectReference<PoCabinetPageBase>? _selfRef;
    private string? _gameCode;
    private int? _localCarId;
    private PoCabinetStaticWorld? _world;
    private PoCabinetFinalResult? _finalResult;
    private bool _wiredSessionHandlers;
    private bool _mountStarted;
    private bool _submitted;
    private double _submittedBestLap;
    private bool _wreckAnnounced;
    /// <summary>The lap in progress has broken track limits; the last one did.</summary>
    protected bool _lapInvalid;
    protected bool _lastLapInvalid;
    private int _lastLapCount;
    private long _lastHudRender;
    private GameMode? _lastMode;

    protected override async Task OnInitializedAsync()
    {
        await Career.LoadAsync();
        _selfRef = DotNetObjectReference.Create(this);
        try
        {
            // Straight from localStorage: the settings are this page's (PoCabinetUiSettings),
            // and window.PoCabinet does not exist until the engine is imported at race start.
            Settings = PoCabinetUiSettings.FromJson(await JS.InvokeAsync<string?>("localStorage.getItem", PoCabinetUiSettings.StorageKey));
            // The paint shop's stored colour, so the first race is in it.
            if (PoCabinetPitWall.ParsePaint(await JS.InvokeAsync<string?>("localStorage.getItem", PoCabinetPitWall.PaintKey)) is { } color)
                _color = color;
        }
        catch { /* storage unavailable or corrupt — defaults are fine */ }
        _loaded = true;
    }

    /// <summary>The modal's cue: a win for a front-runner, a loss for a wreck, neutral otherwise
    /// (P40 of a hundred is not a defeat).</summary>
    protected GameResult ResultsOutcome => _phase != Phase.Finished || IsSpectating ? GameResult.InProgress
        : _dnf ? GameResult.Loss
        : _position <= FrontRunnerCut ? GameResult.Win
        : GameResult.InProgress;

    /// <summary>Back on the start card (the track list re-reads the best laps the race just set).</summary>
    private Task ReturnToStartAsync()
    {
        _phase = Phase.Start;
        return InvokeAsync(StateHasChanged);
    }

    protected Task OpenDrawerAsync() => _drawer?.OpenAsync() ?? Task.CompletedTask;

    /// <summary>
    /// A mode switch mid-race (same component, new route parameter) tears the race down.
    /// </summary>
    protected override async Task OnParametersSetAsync()
    {
        if (_lastMode is { } previous && previous != Mode && _phase != Phase.Start)
        {
            await TeardownRaceAsync();
            _phase = Phase.Start;
        }
        _lastMode = Mode;
    }

    /// <summary>
    /// Every mode mounts in two render passes: the Loading
    /// phase renders the race section (so the canvas exists), and only the NEXT pass mounts
    /// the engine into it. The Finished pass draws the telemetry chart once its canvas exists.
    /// </summary>
    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (_phase == Phase.Loading && !_mountStarted)
        {
            _mountStarted = true;
            try
            {
                if (IsMultiplayerMode && _gameCode is not null)
                    await JoinWireRaceAsync(_gameCode);
                else
                    await BeginSoloAsync();
            }
            finally
            {
                _mountStarted = false;
            }
        }

        if (_paused && !_pauseShown)
        {
            _pauseShown = true;
            await SafeJsAsync("PoCabinet.showModal", "pocabinetPause");
        }

        // Not in the demo: drawing the chart also stores the lap as the track's reference
        // trace, and the autopilot's lap is nobody's personal best.
        if (_phase == Phase.Finished && !_telemetryDrawn && !IsSpectating && Mode != GameMode.Demo)
        {
            _telemetryDrawn = true;
            try
            {
                var res = await JS.InvokeAsync<JsonElement>("PoCabinet.showTelemetry", "pocabinetTelemetry");
                if (res.ValueKind == JsonValueKind.Object)
                {
                    _telemetrySummary = res.TryGetProperty("summary", out var s) ? s.GetString() : null;
                    _hasReferenceLap = res.TryGetProperty("hasReference", out var r) && r.ValueKind == JsonValueKind.True;
                    if (res.TryGetProperty("facts", out var facts) && facts.ValueKind == JsonValueKind.Object && _debrief is null) BuildDebrief(facts);
                }
            }
            catch { _telemetrySummary = null; }
            await InvokeAsync(StateHasChanged);
        }
    }

    protected Task OnTrackChanged(string trackId)
    {
        _trackId = trackId;
        return Task.CompletedTask;
    }

    protected async Task OnPaintChanged(string color)
    {
        _color = color;
        // In the lobby the seat already has a colour: re-joining is idempotent for a seated
        // player and carries the new one, which the server applies and broadcasts.
        if (_phase == Phase.Lobby && Session.MySeatId is not null)
        {
            try { await Session.JoinLobbyAsync(PlayerNameSvc.GetOrReadInitialName(), null, PlayerColorHex); }
            catch { /* best effort: the seat keeps its old colour */ }
        }
        await InvokeAsync(StateHasChanged);
    }

    /// <summary>The opening card's Start (or a demo card timing out): multiplayer joins the lobby; everything else races.</summary>
    protected async Task StartRaceAsync()
    {
        // A demo shows a different track each time it starts itself.
        if (Mode == GameMode.Demo)
        {
            // Today's daily circuit is in the draw too.
            int pick = Random.Shared.Next(PoCabinetCatalog.Tracks.Count + 1);
            _trackId = pick < PoCabinetCatalog.Tracks.Count ? PoCabinetCatalog.Tracks[pick].Id : PoCabinetCatalog.Today(DateTime.UtcNow).Id;
        }
        _playerName = PlayerNameSvc.GetOrReadInitialName();
        _status = null;
        // The race view renders first (its canvas is what the mount waits for); the audio
        // unlock shares the engine import BeginSoloAsync awaits anyway.
        _phase = IsMultiplayerMode ? Phase.Lobby : Phase.Loading;
        await InvokeAsync(StateHasChanged);
        await UnlockAudioAsync();
    }

    protected Task OnLobbyRaceStartingAsync((string Code, string TrackId) start)
    {
        _trackId = start.TrackId;
        return BeginWireModeAsync(start.Code);
    }

    protected Task LeaveLobbyAsync() => ReturnToStartAsync();

    /// <summary>Pause card's Restart and the results' Race again: the same track, a fresh grid.</summary>
    protected async Task RestartRaceAsync()
    {
        if (IsMultiplayerMode) return;
        await TeardownRaceAsync();
        _status = null;
        _phase = Phase.Loading;
        await InvokeAsync(StateHasChanged);
    }

    /// <summary>Online results: the lobby reopens after every race, so the rematch is there.</summary>
    protected async Task BackToLobbyAsync()
    {
        await TeardownRaceAsync();
        _status = null;
        _phase = Phase.Lobby;
        await InvokeAsync(StateHasChanged);
    }

    /// <summary>
    /// Web Audio needs a user gesture to unlock its context, and the Start click is it. The
    /// engine comes first: on a fresh visit nothing has imported it yet, and asking a
    /// window.PoCabinet that did not exist threw, silently, leaving the first race mute.
    /// </summary>
    private async Task UnlockAudioAsync()
    {
        try
        {
            await EnsureEngineAsync();
            await JS.InvokeVoidAsync("PoCabinet.initAudio");
        }
        catch { /* audio is a bonus, never a gate */ }
    }

    /// <summary>Mount the scene and start the in-browser race (1p, demo).</summary>
    private async Task BeginSoloAsync()
    {
        try
        {
            var trackId = _trackId ?? PoCabinetCatalog.DefaultTrackId;
            _gameCode = null;
            _localCarId = null;
            ResetTelemetry();
            _world = PoCabinetTrackGeometry.BuildStaticWorld(trackId);
            _totalLaps = _world.TotalLaps;
            await EnsureEngineAsync();
            await LoadStoredRecordsAsync(trackId);
            await MountSceneAsync(_world);
            _status = null;
            _phase = Phase.Racing;
            await InvokeAsync(StateHasChanged);
            await JS.InvokeVoidAsync("PoCabinet.startRace", _selfRef, _sceneHandle, _minimapHandle, new
            {
                mode = Mode == GameMode.Demo ? "demo" : "solo",
                world = _world,
                playerName = _playerName,
                color = PlayerColorHex,
                settings = Settings.ToJs(),
            });
            // The officials' scripted line pool, built in the browser (PoCabinetTalk).
            if (_phase is Phase.Racing) await SafeJsAsync("PoCabinet.setBanter", PoCabinetTalk.Banter);
        }
        catch (Exception ex)
        {
            try { await JS.InvokeVoidAsync("console.error", "pocabinet BeginSoloAsync failed: " + ex); } catch { }
            await TeardownRaceAsync();
            _status = $"Could not start the race: {ex.Message}";
            _phase = Phase.Start;
            await InvokeAsync(StateHasChanged);
        }
    }

    /// <summary>
    /// Enter a multiplayer race (from the lobby hand-off or its Watch button). Records state only; the hub join and mount wait for the Loading
    /// render in <see cref="OnAfterRenderAsync"/>, when the canvas exists.
    /// </summary>
    public Task BeginWireModeAsync(string gameCode)
    {
        _gameCode = gameCode;
        _localCarId = null;
        _phase = Phase.Loading;
        _status = null;
        _lobbyNotice = null;
        return InvokeAsync(StateHasChanged);
    }

    private async Task JoinWireRaceAsync(string gameCode)
    {
        try
        {
            ResetTelemetry();
            await EnsureEngineAsync();
            WireSessionHandlers();
            var snap = await Session.JoinRaceAsync(gameCode);
            _localCarId = snap.LocalCarId;
            _world = snap.Static ?? PoCabinetTrackGeometry.BuildStaticWorld(_trackId);
            _trackId = _world.TrackId;
            _totalLaps = _world.TotalLaps;
            await LoadStoredRecordsAsync(_world.TrackId);
            await MountSceneAsync(_world);
            await JS.InvokeVoidAsync("PoCabinet.startRace", _selfRef, _sceneHandle, _minimapHandle, new
            {
                mode = "net",
                world = _world,
                localCarId = snap.LocalCarId,
                initialSnapshot = snap,
                settings = Settings.ToJs(),
            });
            Session.StartPingLoop();
            _phase = Phase.Racing;
            ApplySnapshot(snap, forceRender: true);
        }
        catch (Exception ex)
        {
            try { await JS.InvokeVoidAsync("console.error", "pocabinet JoinWireRaceAsync failed: " + ex); } catch { }
            await TeardownRaceAsync();
            _status = $"Could not join the race: {ex.Message}";
            _phase = Session.Lobby is not null ? Phase.Lobby : Phase.Start;
            await InvokeAsync(StateHasChanged);
        }
    }

    private void WireSessionHandlers()
    {
        if (_wiredSessionHandlers) return;
        _wiredSessionHandlers = true;
        Session.SnapshotReceived += OnWireSnapshotAsync;
        Session.RaceFinished += OnWireRaceFinishedAsync;
        Session.StatusChanged += OnSessionStatusAsync;
        Session.RaceLost += OnWireRaceLostAsync;
        Session.PingMeasured += OnPingAsync;
    }

    private void UnwireSessionHandlers()
    {
        if (!_wiredSessionHandlers) return;
        _wiredSessionHandlers = false;
        Session.SnapshotReceived -= OnWireSnapshotAsync;
        Session.RaceFinished -= OnWireRaceFinishedAsync;
        Session.StatusChanged -= OnSessionStatusAsync;
        Session.RaceLost -= OnWireRaceLostAsync;
        Session.PingMeasured -= OnPingAsync;
    }

    private Task OnSessionStatusAsync(string? msg)
    {
        _status = msg;
        return InvokeAsync(StateHasChanged);
    }

    private Task OnPingAsync(double ms)
    {
        _pingMs = (int)Math.Round(ms);
        return InvokeAsync(StateHasChanged);
    }

    private Task OnWireSnapshotAsync(PoCabinetRaceSnapshot snap)
    {
        if (_phase is not (Phase.Racing or Phase.Finished) || !string.Equals(snap.GameCode, _gameCode, StringComparison.OrdinalIgnoreCase))
            return Task.CompletedTask;
        Fire("PoCabinet.pushServerSnapshot", snap);
        if (_phase == Phase.Racing) ApplySnapshot(snap);
        return Task.CompletedTask;
    }

    private async Task OnWireRaceFinishedAsync(PoCabinetFinalResult result)
    {
        if (!string.Equals(result.GameCode, _gameCode, StringComparison.OrdinalIgnoreCase)) return;
        _finalResult = result;
        _awaitingFinal = false;
        _finalStandings = result.Standings.Select(e => new PoCabinetResults.Row(
            e.Name,
            // The server calls the race once every human is home, so unfinished officials
            // were simply still lapping — "DNF" read as if they had crashed out.
            e.Finished && e.TotalTimeSeconds > 0 ? PoCabinetCatalog.FormatLap(e.TotalTimeSeconds) : e.Wrecked ? "wrecked · DNF" : e.IsPlayer ? "did not finish" : "AI official · still on track",
            e.CarId == _localCarId)).ToList();
        var mine = result.Standings.FirstOrDefault(e => e.CarId == _localCarId);
        if (mine is not null) _position = mine.Position;
        if (_phase == Phase.Racing) EnterFinished();
        if (mine is not null && mine.BestLapSeconds > 0) await SubmitFinalAsync(mine.BestLapSeconds);
        await InvokeAsync(StateHasChanged);
    }

    // ─── Online: losing the race, leaving it, a hidden tab ───────────────────

    /// <summary>Online: the race connection is gone for good — the race view shows this with a way out.</summary>
    protected string? _connectionLost;
    /// <summary>Online: a line for the lobby about how the last race ended (its finish was missed).</summary>
    protected string? _lobbyNotice;
    /// <summary>Online: the first tap on Leave race arms it; the second leaves.</summary>
    protected bool _confirmLeave;

    /// <summary>
    /// Online, the session says this client is out of the race. A lost connection keeps the
    /// view and offers Back to lobby / Quit. A race that ended unseen (it finished during a
    /// reconnect, or the server called it off) closes the view: the score is still submitted
    /// when the server may hold a verified lap — online submits carry no proof, the server
    /// uses the lap its own sim timed — and the lobby says what happened.
    /// </summary>
    private Task OnWireRaceLostAsync(PoCabinetRaceLoss loss) => InvokeAsync(async () =>
    {
        if (!loss.RaceOver)
        {
            if (_phase is Phase.Racing or Phase.Loading) _connectionLost = loss.Message;
            else _status = loss.Message;
            StateHasChanged();
            return;
        }
        var canSubmit = loss.MaySubmit && !IsSpectating && !_submitted;
        var lap = _laps.BestValidLap > 0 ? _laps.BestValidLap : _laps.BestLapSession;
        if (_phase == Phase.Finished)
        {
            // The results are up and waiting on a RaceFinished that will never come.
            _awaitingFinal = false;
            if (canSubmit && lap > 0) await SubmitFinalAsync(lap);
            _status = loss.Message + (_status is { Length: > 0 } saved ? " " + saved : "");
            StateHasChanged();
            return;
        }
        if (_phase is not (Phase.Racing or Phase.Loading)) return;
        _status = null;
        if (canSubmit && lap > 0) await SubmitFinalAsync(lap);
        var outcome = _status;
        await BackToLobbyAsync();
        _lobbyNotice = loss.Message + (outcome is { Length: > 0 } ? " " + outcome : "");
        StateHasChanged();
    });

    /// <summary>
    /// Online HUD: Leave race. A driver still racing taps twice (the first tap arms it for a
    /// few seconds); a spectator or a wrecked car leaves at once. The server forfeits the car
    /// (it coasts) and the lobby is where the next race starts.
    /// </summary>
    protected async Task LeaveWireRaceAsync()
    {
        if (!_confirmLeave && !IsSpectating && !_dnf)
        {
            _confirmLeave = true;
            var serial = _raceSerial;
            _ = Task.Delay(3000).ContinueWith(_ => InvokeAsync(() =>
            {
                if (serial != _raceSerial || !_confirmLeave) return;
                _confirmLeave = false;
                StateHasChanged();
            }), TaskScheduler.Default);
            return;
        }
        await BackToLobbyAsync();
    }

    /// <summary>Online, connection lost: give up the lobby seat too and go back to the start card.</summary>
    protected async Task QuitOnlineAsync()
    {
        await TeardownRaceAsync();
        await Session.LeaveLobbyAsync();
        await ReturnToStartAsync();
    }

    /// <summary>
    /// race.js, online: the tab was hidden. One hands-off input goes up so the car coasts at
    /// once (the server would cut a silent car to coasting after half a second anyway).
    /// </summary>
    [JSInvokable]
    public Task OnNetHiddenAsync() =>
        IsMultiplayerMode && _phase == Phase.Racing && !IsSpectating ? Session.SendNeutralInputAsync() : Task.CompletedTask;

    private async Task EnsureEngineAsync()
    {
        var ready = await JS.InvokeAsync<bool>("loadEngine", "pocabinet");
        if (!ready) throw new InvalidOperationException("pocabinet engine failed to load");
    }

    /// <summary>
    /// Mount the scene, dialogue bubble, minimap and environment against the static
    /// world. The environment resolves before race.js starts so its rain-grip factor is in
    /// place for the first solo tick.
    /// </summary>
    private async Task MountSceneAsync(PoCabinetStaticWorld world)
    {
        await TeardownSceneAsync();
        // IJSRuntime does not marshal ElementReference as a live DOM element, so the mounts
        // resolve their canvases by id.
        _sceneHandle = await JS.InvokeAsync<IJSObjectReference>("PoCabinet.mount", "pocabinetCanvas", world);
        _dialogueHandle = await JS.InvokeAsync<IJSObjectReference>("PoCabinet.mountDialogue", "pocabinetDialogueLayer");
        try { await JS.InvokeVoidAsync("PoCabinet.applySettings", _sceneHandle, Settings.ToJs()); }
        catch { /* settings are cosmetic */ }
        await MountMinimapAsync();
        await MountEnvironmentAsync();
    }

    private async Task MountEnvironmentAsync()
    {
        // Online races are dry on the server (and in prediction): rain there would only be paint.
        var weather = IsMultiplayerMode ? "clear" : Settings.Weather;
        try { _envHandle = await JS.InvokeAsync<IJSObjectReference>("PoCabinet.mountEnvironment", _sceneHandle, weather); }
        catch { _envHandle = null; }
    }

    private async Task MountMinimapAsync()
    {
        if (_world is null) return;
        try
        {
            if (_minimapHandle is not null) await JS.InvokeVoidAsync("PoCabinet.unmountMinimap", _minimapHandle);
            _minimapHandle = await JS.InvokeAsync<IJSObjectReference>("PoCabinet.mountMinimap",
                "pocabinetMinimap", _world, new { accent = _world.Atmosphere.AccentHex });
        }
        catch { _minimapHandle = null; }
    }

    /// <summary>
    /// race.js, solo modes, on the first tick and at the finish: the whole field as JSON, parsed
    /// with the source-generated <see cref="PoCabinetJsonContext"/> (the server pushes snapshots online).
    /// </summary>
    [JSInvokable]
    public Task OnSoloSnapshotJsonAsync(string json)
    {
        if (_phase != Phase.Racing || string.IsNullOrEmpty(json)) return Task.CompletedTask;
        var snap = System.Text.Json.JsonSerializer.Deserialize(json, PoCabinetJsonContext.Default.PoCabinetRaceSnapshot);
        if (snap is not null) ApplySnapshot(snap);
        return Task.CompletedTask;
    }

    // One snapshot and one local-car row, reused by every solo tick: the HUD only reads them.
    private readonly PoCabinetCarState _soloTickCar = new() { IsPlayer = true };
    private readonly PoCabinetDialogueEvent _soloTickLine = new();
    private PoCabinetRaceSnapshot? _soloTickSnap;

    /// <summary>
    /// race.js, solo modes, every other tick (~30 Hz): the local car as positional primitives, so
    /// the hot path marshals no nested object. Flags: 1 started, 2 lap invalid, 4 wrecked, 8 car finished.
    /// </summary>
    [JSInvokable]
    public Task OnSoloTickAsync(double elapsed, int countdown, int carId, int lap, int position, int flags,
        double bestLap, string? lineOfficialId, string? lineText, long lineTick)
    {
        if (_phase != Phase.Racing) return Task.CompletedTask;
        var car = _soloTickCar;
        car.Id = carId;
        car.Lap = lap;
        car.Position = position;
        car.LapInvalid = (flags & 2) != 0;
        car.Wrecked = (flags & 4) != 0;
        car.Finished = (flags & 8) != 0;
        PoCabinetDialogueEvent? line = null;
        if (!string.IsNullOrEmpty(lineText))
        {
            _soloTickLine.OfficialId = lineOfficialId ?? "";
            _soloTickLine.Text = lineText;
            _soloTickLine.RaceTick = lineTick;
            line = _soloTickLine;
        }
        var snap = _soloTickSnap ??= new PoCabinetRaceSnapshot { GameCode = "SOLO", Cars = new[] { car } };
        snap.ElapsedRaceTime = elapsed;
        snap.Started = (flags & 1) != 0;
        snap.CountdownSeconds = countdown;
        snap.Finished = false;
        snap.LocalCarId = carId;
        snap.LatestDialogue = line;
        snap.BestLapSeconds = bestLap > 0 ? bestLap : null;
        ApplySnapshot(snap);
        return Task.CompletedTask;
    }

    /// <summary>race.js, online: one numbered input per 30 Hz tick, forwarded to the race hub.</summary>
    [JSInvokable]
    public Task OnNetInputAsync(int seq, double throttle, double brake, double steer) =>
        Session.SendInputAsync(new PoCabinetInput { Seq = seq, Throttle = throttle, Brake = brake, Steer = steer });

    private PoCabinetCarState? FindLocal(PoCabinetRaceSnapshot snap)
    {
        var cars = snap.Cars ?? Array.Empty<PoCabinetCarState>();
        if (IsMultiplayerMode) return _localCarId is { } id ? cars.FirstOrDefault(c => c.Id == id) : null;
        return snap.LocalCarId is { } sid ? cars.FirstOrDefault(c => c.Id == sid) : cars.FirstOrDefault(c => c.IsPlayer);
    }

    private void ApplySnapshot(PoCabinetRaceSnapshot snap, bool forceRender = false)
    {
        _lastSnapshot = snap;

        // Countdown beeps; the 1 → 0 transition raises the GO ping and flashes "GO!".
        if (snap.CountdownSeconds != _lastCountdown)
        {
            var previous = _lastCountdown;
            _lastCountdown = snap.CountdownSeconds;
            if (snap.CountdownSeconds > 0)
            {
                _countdownDisplay = snap.CountdownSeconds;
                Fire("PoCabinet.countdownBeep", false);
            }
            else if (previous > 0)
            {
                _countdownDisplay = 0;
                _goUntilElapsed = snap.ElapsedRaceTime + 1.2;
                Fire("PoCabinet.countdownBeep", true);
            }
            forceRender = true;
        }
        _showGo = _goUntilElapsed > 0 && snap.ElapsedRaceTime <= _goUntilElapsed;

        var cars = snap.Cars ?? Array.Empty<PoCabinetCarState>();
        // Solo snapshots carry the whole field only on the first tick and at the finish
        // (race.js pushHud); in between there is one row, the local car's.
        _totalCars = Math.Max(_totalCars, cars.Count);
        var localCar = FindLocal(snap);
        if (localCar is not null)
        {
            if (_lastLapCount > 0 && localCar.Lap > _lastLapCount)
            {
                var lapTime = snap.ElapsedRaceTime - _laps.LastLapEnd;
                // A lap past track limits is timed but counts for nothing (race.js lapBookkeeping).
                var invalid = _lapInvalid;
                _laps.CloseLap(lapTime, snap.ElapsedRaceTime, invalid);
                _lastLapInvalid = invalid;
                if (lapTime > 0) Fire("PoCabinet.lapChime");
                if (localCar.Lap <= _totalLaps)
                    _liveAnnouncement = $"Lap {localCar.Lap} of {_totalLaps}. Last lap {PoCabinetCatalog.FormatLap(lapTime)}{(invalid ? ", deleted for track limits" : "")}.";
                _lapInvalid = false;
                forceRender = true;
            }
            if (localCar.LapInvalid && !_lapInvalid)
            {
                _lapInvalid = true;
                _liveAnnouncement = "Track limits: all four wheels off. This lap will not count.";
                forceRender = true;
            }
            _lastLapCount = localCar.Lap;
            _lap = localCar.Lap;
            if (localCar.Position != _position)
            {
                _positionDelta = Math.Sign(_position - localCar.Position);
                // Throttled: a side-by-side tussle flips places every tick.
                var nowMs = Environment.TickCount64;
                if (snap.Started && nowMs - _placeAnnouncedAt > 4000)
                {
                    _placeAnnouncedAt = nowMs;
                    _liveAnnouncement = $"Position {localCar.Position} of {_totalCars}.";
                }
            }
            _position = localCar.Position;
            _lapSeconds = snap.ElapsedRaceTime;
            if (localCar.Wrecked && !localCar.Finished && !_wreckAnnounced)
            {
                _wreckAnnounced = true;
                _dnf = Mode != GameMode.Demo;
                _liveAnnouncement = "Your car is wrecked. The engine is gone and your race is over.";
                forceRender = true;
            }
            if (snap.BestLapSeconds is { } reported) _laps.ReportBest(reported);
        }
        else if (cars.Count > 0)
        {
            // Spectating: the HUD follows the leader.
            var leader = cars.OrderBy(c => c.Position).First();
            _lap = leader.Lap;
            _position = leader.Position;
            _lapSeconds = snap.ElapsedRaceTime;
        }

        if (snap.LatestDialogue is { } d && !string.IsNullOrEmpty(d.Text))
        {
            var key = $"{d.OfficialId}|{d.RaceTick}";
            if (!string.Equals(key, _lastDialogueKey, StringComparison.Ordinal))
            {
                _lastDialogueKey = key;
                _liveAnnouncement = $"{d.Text}";
                if (_dialogueHandle is not null) Fire("PoCabinet.showDialogue", _dialogueHandle, PoCabinetCatalog.OfficialName(d.OfficialId), d.Text);
                forceRender = true;
            }
        }

        var localDone = IsMultiplayerMode ? localCar?.Finished == true : snap.Finished;
        if ((localDone || (IsMultiplayerMode && snap.Finished)) && _phase == Phase.Racing)
        {
            _finalStandings ??= cars.OrderBy(c => c.Position)
                .Select(c => new PoCabinetResults.Row(c.Name, StandingDetail(c, c.Id == localCar?.Id), c.Id == localCar?.Id))
                .ToList();
            _awaitingFinal = IsMultiplayerMode && _finalResult is null;
            EnterFinished();
            if (!IsMultiplayerMode) _ = InvokeAsync(() => SubmitFinalAsync(snap.BestLapSeconds ?? 0));
            forceRender = true;
        }

        var now = Environment.TickCount64;
        if (forceRender || now - _lastHudRender >= 66)
        {
            _lastHudRender = now;
            InvokeAsync(StateHasChanged);
        }
    }

    /// <summary>Who a solo car was, in a word or two: the AI drivers by their personality, and a wreck says so.</summary>
    private static string StandingDetail(PoCabinetCarState c, bool isLocal)
    {
        var who = isLocal ? "You" : c.IsPlayer ? "Player" : c.OfficialId == "field" ? "AI racer" : "AI official";
        if (!isLocal && !c.IsPlayer && !string.IsNullOrEmpty(c.Style)) who += $" · {c.Style}";
        return c.Wrecked && !c.Finished ? who + " · wrecked" : who;
    }

    private void EnterFinished()
    {
        _phase = Phase.Finished;
        _telemetryDrawn = false;
        _liveAnnouncement = IsSpectating ? "Race finished."
            : _dnf ? "Race over. Your car was wrecked: did not finish."
            : $"Race finished. Position {_position} of {_totalCars}.";
        Fire("PoCabinet.fanfare", _position <= FrontRunnerCut && !IsSpectating && !_dnf);
        if (Mode == GameMode.Demo) _ = LoopDemoAsync();
    }

    /// <summary>A demo has no result screen (nobody is there to leave it): hold on the finish, then race again.</summary>
    private async Task LoopDemoAsync()
    {
        await Task.Delay(8000);
        if (_disposed || _phase != Phase.Finished || Mode != GameMode.Demo) return;
        await TeardownRaceAsync();
        await StartRaceAsync();
    }

    /// <summary>
    /// Record the result: career progress (1P stage tracks), personal records (best lap +
    /// sectors) and the leaderboard submit. Runs once per race. The place, the DNF and the
    /// race are read BEFORE the first await: "Race again" during the slow server check used
    /// to reset <see cref="_position"/> under it, so the stage was recorded with the new
    /// race's P1. Nothing here touches the page once a newer race has started.
    /// </summary>
    private async Task SubmitFinalAsync(double lapSeconds)
    {
        if (_submitted || IsSpectating || Mode == GameMode.Demo) return;
        _submitted = true;
        _submittedBestLap = lapSeconds;
        var position = _position;
        var dnf = _dnf;
        var serial = _raceSerial;
        var trackId = _trackId ?? PoCabinetCatalog.DefaultTrackId;
        bool Current() => serial == _raceSerial && !_disposed;
        try
        {
            // Solo laps carry their input log; the server re-runs the race and stores the lap
            // time and place it computes (PoCabinetLapVerifier). Online laps need no proof — the
            // server timed them — and a solo submit without one is refused. Read first, while
            // race.js still holds THIS race.
            string? inputs = null;
            var wet = false;
            if (!IsMultiplayerMode && lapSeconds > 0)
            {
                try
                {
                    var proof = await JS.InvokeAsync<JsonElement>("PoCabinet.lapProof");
                    if (proof.TryGetProperty("inputs", out var i) && i.ValueKind == JsonValueKind.String) inputs = i.GetString();
                    wet = proof.TryGetProperty("wet", out var w) && w.ValueKind == JsonValueKind.True;
                }
                catch (JSException) { /* no proof → the server refuses the lap; local records still stand */ }
            }

            // The campaign first: it is local, needs a finish rather than a lap that counted
            // (every lap deleted for track limits still finished the race), and the results'
            // chip and Next stage should not wait on the network.
            if (Mode == GameMode.OnePlayer && PoCabinetCatalog.StageIndexOf(trackId) is var stage and >= 0)
            {
                _campaignNote = StageNote(Career.Current, stage, position, dnf);
                if (!dnf) await Career.RecordStageResultAsync(stage, position);
                if (Current()) await InvokeAsync(StateHasChanged);
            }

            try
            {
                var res = await JS.InvokeAsync<JsonElement>("PoCabinet.recordTrackResult", trackId, lapSeconds, _laps.BestSectors());
                if (Current() && res.ValueKind == JsonValueKind.Object)
                {
                    if (res.TryGetProperty("isPb", out var pb) && pb.ValueKind == JsonValueKind.True) _isPersonalBest = true;
                    if (res.TryGetProperty("previousBest", out var prev) && prev.ValueKind == JsonValueKind.Number) _previousBest = prev.GetDouble();
                }
            }
            catch { /* records are a bonus */ }

            var outcome = !dnf && position <= FrontRunnerCut ? GameResult.Win : GameResult.Loss;
            if (lapSeconds <= 0)
            {
                // The session still counts; there is just no lap for the board.
                await GameResults.RecordAndSubmitPoCabinetAsync(_playerName, outcome, null);
                if (Current())
                {
                    _status = dnf ? "Wrecked before a lap counted." : "Race finished, but no lap counted (track limits).";
                    await InvokeAsync(StateHasChanged);
                }
                return;
            }
            var req = new PoCabinetHighScoreRequest(
                TrackId: trackId,
                BestLapSeconds: lapSeconds,
                FinalPosition: Math.Clamp(position, 1, PoCabinetCatalog.SoloCarCount),
                GameCode: _gameCode ?? "SOLO",
                Inputs: inputs,
                Wet: wet);
            await GameResults.RecordAndSubmitPoCabinetAsync(_playerName, outcome, req);
            if (Current()) _status = dnf ? "Best lap saved. The race: DNF." : $"Race saved — position {position}/{_totalCars}.";
        }
        catch (Exception ex)
        {
            if (Current()) _status = $"Score submit failed: {ex.Message}";
        }
        if (Current()) await InvokeAsync(StateHasChanged);
    }

    /// <summary>
    /// The race engineer: the telemetry numbers (race.js) plus the result become the headline
    /// and tips, written right here in the browser (<see cref="PoCabinetTalk"/>). Demo races
    /// get none — nobody drove. The caller renders straight after.
    /// </summary>
    private void BuildDebrief(JsonElement facts)
    {
        if (Mode == GameMode.Demo) return;
        static int Int(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? (int)Math.Round(v.GetDouble()) : 0;
        var deltas = facts.TryGetProperty("sectorDeltas", out var d) && d.ValueKind == JsonValueKind.Array
            ? d.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.Number).Select(x => x.GetDouble()).Where(double.IsFinite).ToArray()
            : [];
        var worst = facts.TryGetProperty("worstPointPct", out var w) && w.ValueKind == JsonValueKind.Number ? (int)w.GetDouble() : -1;
        _debrief = PoCabinetTalk.DebriefFor(new PoCabinetTalk.Facts(
            TrackName, _position, deltas, Int(facts, "fullThrottlePct"), Int(facts, "brakePct"),
            Int(facts, "slowestKmh"), worst, Int(facts, "wallHits"), _dnf));
    }

    // ─── Telemetry: sectors, laps, personal records ──────────────────────────

    private void ResetTelemetry()
    {
        _laps = new PoCabinetLapBook();
        _lastCountdown = -1;
        _goUntilElapsed = 0;
        _showGo = false;
        _countdownDisplay = 0;
        _finalStandings = null;
        _finalResult = null;
        _awaitingFinal = false;
        _isPersonalBest = false;
        _previousBest = -1;
        _pingMs = null;
        _submitted = false;
        _submittedBestLap = 0;
        _wreckAnnounced = false;
        _lapInvalid = false;
        _lastLapInvalid = false;
        _lastLapCount = 0;
        _telemetryDrawn = false;
        _telemetrySummary = null;
        _hasReferenceLap = false;
        _lastDialogueKey = null;
        _liveAnnouncement = null;
        _placeAnnouncedAt = 0;
        _debrief = null;
        _dnf = false;
        _campaignNote = null;
        _lap = 1;
        _position = 1;
        _totalCars = 0;
        _lapSeconds = 0;
    }

    private async Task LoadStoredRecordsAsync(string trackId)
    {
        try { _laps.LoadStored(await JS.InvokeAsync<JsonElement>("PoCabinet.getRecords", trackId)); }
        catch { /* first race ever, or storage unavailable — no personal bests */ }
    }

    /// <summary>race.js, both modes: the local car crossed a sector boundary (<see cref="PoCabinetLapBook.Sector"/>).</summary>
    [JSInvokable]
    public Task OnSectorAsync(int sector, double seconds, double raceTime) =>
        _laps.Sector(sector, seconds, raceTime) ? InvokeAsync(StateHasChanged) : Task.CompletedTask;

    // ─── Camera, pause, leaving the race ─────────────────────────────────────

    protected Task CycleCameraAsync() => SafeJsAsync("PoCabinet.cycleCamera");

    [JSInvokable]
    public Task OnTogglePause() => TogglePauseAsync();

    protected async Task TogglePauseAsync()
    {
        if (!Pausable) return;
        if (_paused) await ResumeRaceAsync();
        else await PauseRaceAsync();
    }

    protected async Task PauseRaceAsync()
    {
        if (_paused || !Pausable) return;
        _paused = true;
        await SafeJsAsync("PoCabinet.pauseRace");
        await InvokeAsync(StateHasChanged);
    }

    protected async Task ResumeRaceAsync()
    {
        if (!_paused) return;
        _paused = false;
        _pauseShown = false;
        await SafeJsAsync("PoCabinet.resumeRace");
        await InvokeAsync(StateHasChanged);
    }

    protected async Task QuitToMenuAsync()
    {
        await TeardownRaceAsync();
        await ReturnToStartAsync();
    }

    /// <summary>Stop the race driver and unmount every engine handle; the canvas is about to leave the DOM.</summary>
    private async Task TeardownRaceAsync()
    {
        _paused = false;
        _pauseShown = false;
        await SafeJsAsync("PoCabinet.stopRace");
        await TeardownSceneAsync();
        // Online: the server forfeits a car still racing and drops us from the race group.
        if (_gameCode is not null) await Session.LeaveRaceAsync();
        _connectionLost = null;
        _confirmLeave = false;
        UnwireSessionHandlers();
        _gameCode = null;
        _localCarId = null;
        // The next race renders new canvases (the section's @key): this one's WebGL context is gone.
        _raceSerial++;
    }

    private async Task TeardownSceneAsync()
    {
        try
        {
            if (_envHandle is not null) await JS.InvokeVoidAsync("PoCabinet.unmountEnvironment", _envHandle);
            if (_minimapHandle is not null) await JS.InvokeVoidAsync("PoCabinet.unmountMinimap", _minimapHandle);
            if (_dialogueHandle is not null) await JS.InvokeVoidAsync("PoCabinet.unmountDialogue", _dialogueHandle);
            if (_sceneHandle is not null) await JS.InvokeVoidAsync("PoCabinet.unmount", _sceneHandle);
        }
        catch { /* engine may already be torn down */ }
        foreach (var h in new[] { _envHandle, _minimapHandle, _dialogueHandle, _sceneHandle })
        {
            if (h is null) continue;
            try { await h.DisposeAsync(); } catch { /* already gone */ }
        }
        _envHandle = _minimapHandle = _dialogueHandle = _sceneHandle = null;
    }

    // ─── Settings ────────────────────────────────────────────────────────────

    protected async Task OnSettingsChangedAsync()
    {
        try
        {
            await JS.InvokeVoidAsync("localStorage.setItem", PoCabinetUiSettings.StorageKey, Settings.ToJson());
            if (_sceneHandle is not null) await JS.InvokeVoidAsync("PoCabinet.applySettings", _sceneHandle, Settings.ToJs());
        }
        catch { /* cosmetic */ }
        // The weather is not re-mounted mid-race: the race holds its weather from the lights
        // (grip and the lap proof's wet flag), so a change is for the next race and says so.
        await InvokeAsync(StateHasChanged);
    }

    /// <summary>Fire-and-forget interop for cues that must never stall the HUD.</summary>
    private void Fire(string identifier, params object?[] args) => _ = SafeJsAsync(identifier, args);

    private async Task SafeJsAsync(string identifier, params object?[] args)
    {
        try { await JS.InvokeVoidAsync(identifier, args); }
        catch { /* engine torn down or interop unavailable — cues are best-effort */ }
    }

    private bool _disposed;

    public async ValueTask DisposeAsync()
    {
        _disposed = true;
        await TeardownRaceAsync();
        // The results modal's one button leaves the page, and the session outlives the page:
        // without this the seat stayed taken in the lobby. (The old "Back to start" button did it.)
        if (IsMultiplayerMode) await Session.LeaveLobbyAsync();
        _selfRef?.Dispose();
        GC.SuppressFinalize(this);
    }
}
