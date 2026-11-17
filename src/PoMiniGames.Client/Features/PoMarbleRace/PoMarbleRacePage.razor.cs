using System.Text.Json;
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.JSInterop;
using PoMiniGames.Shared.Dtos;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Features.PoMarbleRace.Services;
using PoMiniGamesClient.Features.Shared;
using PoMiniGamesClient.Models;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Features.PoMarbleRace;

// The page's state, engine bridge and online session. The markup and its render fragments
// stay in PoMarbleRacePage.razor.
public partial class PoMarbleRacePage
{
    /// <summary>Route mode segment, parsed by <see cref="GameModes.Parse"/>.</summary>
    [Parameter] public string? Mode { get; set; }

    private const int MarbleCount = 101;   // mirrors MARBLE_COUNT in marbles.js
    private const int PlayerIndex = 0;     // the red marble; mirrors PLAYER_INDEX in marbles.js
    private const int ScoreTop = 10;       // mirrors SCORE_TOP in game.js

    private string _playerName = "";
    private bool _demo;
    private string _phase = "pick";
    private int _score;
    private int _best;
    private int _streak;
    private int _myPlace = -1;
    private HudRegion? _hud;
    private int _myField = MarbleCount;
    private bool _lastWon;
    private int _lastPlace;
    private int _lastGained;
    private int _submittedBest;
    // One record per race: set when a result is taken, cleared when the next race sets up.
    private bool _raceRecorded;

    // ── Grand Prix (1P): every course in turn, points for the top 10 of each round, one table
    // across all of them. The table lives in the engine (grandprix.js); the page walks the rounds,
    // booting a new engine per course. ──
    private bool _gp;
    private int _gpRound = 1;          // 1-based
    private bool _gpDone;
    private int _gpGained, _gpPoints, _gpRank;
    private List<(int Index, int Points)> _gpTop = new();
    private MarbleMapOption[] GpOrder => _menu?.Maps.Where(m => !m.Daily).ToArray() ?? [];
    private int GpNextMapId => GpOrder is { Length: > 0 } o ? o[Math.Min(_gpRound, o.Length - 1)].Id : _mapId;
    private bool ShowGpInterim => _gp && !_gpDone && _phase == "result" && !_loading && _engineError is null;
    private const int GpRoundGapMs = 4500;

    // ── Daily Canyon: today's board (each player's fastest finish on today's course) ──
    private PoMiniGames.Domain.Models.MarbleRaceMapRecord[] _dailyBoard = [];
    private bool IsDailyMap(int id) => MapAt(id)?.Daily == true;

    // "Back on track": shown in the place chip for a moment after a respawn.
    private bool _respawned;
    private int _respawnSeq;

    private List<PodiumRow> _podium = new();
    private List<StatItem> _statItems = new();
    private PlayerStats _stats = new();
    private readonly GameStatsService _gameStats = new();
    private DotNetObjectReference<PoMarbleRacePage>? _ref;
    private bool _disposed;
    private bool _engineStarted;
    // True from engine boot until its first pick phase: an authored course has a model to fetch.
    private bool _loading;

    // The intro gates the engine: nothing boots (and no race clock runs) until it is dismissed.
    private bool _introDone;

    // ── Setup (intro card, 1P) ──
    // Everything offered here comes from the engine (PoMarbleRace.menu()); see MarbleMenu.cs.
    private MarbleMenu? _menu;
    private int _mapId = 2;                 // until the menu names its default
    private string _skin = "swirl";
    private string _weight = "balanced";

    // ── Online (host-authoritative relay over /pomarblerace/hub) ──
    // The host browser runs the physics and streams the pack; the guest renders the stream and
    // steers the white marble. See PoMarbleRaceShared.cs and the Online section of game.js.
    private enum OnlinePhase { Idle, Connecting, Searching, Racing, PeerLeft, Error }
    private bool _online;
    private PoMarbleRaceOnlineClient? _onlineClient;
    private OnlinePhase _onlinePhase = OnlinePhase.Idle;
    private MarbleRaceRole _onlineRole = MarbleRaceRole.Host;
    private string _opponentName = "Opponent";
    private string _hostName = "Host";
    private int _guestIndex = -1;
    private int _opponentPlace;
    private bool _onlineResultKnown;
    private Task _applyFrameInFlight = Task.CompletedTask;
    private QuickMatchPhase QuickPhase => _onlinePhase switch
    {
        OnlinePhase.Connecting => QuickMatchPhase.Connecting,
        OnlinePhase.Searching => QuickMatchPhase.Searching,
        OnlinePhase.PeerLeft => QuickMatchPhase.Over,
        OnlinePhase.Error => QuickMatchPhase.Error,
        _ => QuickMatchPhase.Idle,
    };
    private bool IsOnlineHost => _online && _onlinePhase == OnlinePhase.Racing && _onlineRole == MarbleRaceRole.Host;
    private bool IsOnlineGuest => _online && _onlinePhase == OnlinePhase.Racing && _onlineRole == MarbleRaceRole.Guest;

    // You are red unless you are the online guest; the other human is the other colour.
    private string MyColorWord => IsOnlineGuest ? "WHITE" : "RED";
    private string TheirColorWord => IsOnlineGuest ? "RED" : "WHITE";
    private string MyColorClass => IsOnlineGuest ? "mr-white" : "mr-red";

    private bool ShowPrerace => _introDone && _phase == "pick" && !_demo
        && (!_online || _onlinePhase == OnlinePhase.Racing)
        && (_pickCountdown > 0 || _loading || IsOnlineGuest || _showTutorial);
    private bool ShowOnlineCard => _introDone && _online && _onlinePhase is not (OnlinePhase.Racing or OnlinePhase.Idle);
    private bool ShowPlace => _phase == "racing" && !_demo;
    private IEnumerable<MarbleMapOption> PickableMaps => (_menu?.Maps ?? []).Where(m => !_online || !m.Daily);
    private string StandingsLabel => ShowPlace ? $"Your position: {_myPlace} of {_myField}" : "Podium";

    // ── Engine health (item 32/33): a failed start is a retry card, the download a progress bar ──
    private ErrorBoundary? _boundary;
    private string? _engineError;
    private int _loadPct;
    private object? _lastOnlineStart;   // the online record the engine was booted with, for a reload
    private bool _rebootAfterRender;

    // ── Input device in use ('keys' | 'touch' | 'pad'), reported by gamepad.js ──
    private string _inputKind = "keys";

    private string SteerHint => _inputKind switch
    {
        "pad" => "Left stick or D-pad: hold to steer",
        "touch" => "Hold the ◀ ▶ pads at the bottom to steer",
        _ => "Hold ← → (or A / D) to steer",
    };

    // ── First-race tutorial (shown once; prefs.tutorialSeen) ──
    private bool _showTutorial;
    private (double X, double Y)? _tutorialAt;

    private static string Pct(double f) =>
        (Math.Clamp(f, 0, 1) * 100).ToString("0.##", System.Globalization.CultureInfo.InvariantCulture) + "%";

    // Colour is a pure function of the marble index; the engine hands its palette over with the
    // menu (marbles.js paletteHex), so there is no copy here to keep in step.
    private const string UnknownColor = "#94a3b8";

    private string ColorOf(int index)
    {
        var p = _menu?.Palette;
        if (p is null) return UnknownColor;
        if (index == PlayerIndex) return p.Player;
        if (_online && index == _guestIndex) return p.Guest;
        return p.Pack.Length > 0 ? p.Pack[(index - 1) % p.Pack.Length] : UnknownColor;
    }

    // Online: the two human marbles carry the humans' names; "You" follows the local role.
    private string RosterName(int index) =>
        index == PlayerIndex ? (IsOnlineGuest ? _hostName : "You")
        : _online && index == _guestIndex ? (IsOnlineGuest ? "You" : _opponentName)
        : $"Marble {index + 1}";

    private static RenderFragment TitleContent => GameCatalog.TitleFor(GameKeys.PoMarbleRace);

    private string IntroObjective => _demo
        ? "101 CPU marbles, one track. Top 10 scores — watch the pack work it out."
        : _online
            ? "Race another player through a pack of 101. One of you steers RED, the other WHITE — finish in the top 10 to score."
            : "You steer the one RED marble in a pack of 101. Finish in the top 10 to score.";


    // The track after this one in the menu's order, wrapping.
    private int NextMapId
    {
        get
        {
            var maps = _menu?.Maps;
            if (maps is null || maps.Length == 0) return _mapId;
            var i = Array.FindIndex(maps, m => m.Id == _mapId);
            return maps[(i + 1) % maps.Length].Id;
        }
    }

    /// <summary>Result sheet: the same track again, or the next one, straight from the modal.</summary>
    private async Task RaceAgainAsync(bool nextTrack)
    {
        if (_gp) StartGrandPrix();
        else if (nextTrack) _mapId = NextMapId;
        await StopEngineAsync();
        _phase = "pick";
        _podium.Clear();
        _myPlace = -1;
        _split = null;
        _pickCountdown = PickSeconds;
        await InvokeAsync(StateHasChanged);
        await BootEngineAsync(null);
    }

    // ── Grand Prix rounds ──

    private void StartGrandPrix()
    {
        _gpRound = 1;
        _gpDone = false;
        _gpGained = _gpPoints = _gpRank = 0;
        _gpTop.Clear();
        if (GpOrder is { Length: > 0 } order) _mapId = order[0].Id;
        else _gp = false;   // no menu, no order: race the one track instead
    }

    /// <summary>
    /// A Grand Prix round resolved (results.js _resolveGrandPrix). <paramref name="rank"/> and
    /// <paramref name="points"/> are yours across the rounds so far; the top of the table rides
    /// along as parallel arrays of marble index and points.
    /// </summary>
    [JSInvokable]
    public async Task OnGrandPrix(int round, int rounds, int place, int gained, int points, int rank,
                                  int mapId, double myTime, int[] topIndices, int[] topPoints)
    {
        if (_raceRecorded || !_gp) return;
        _raceRecorded = true;
        _lastPlace = place;
        _lastWon = gained > 0;
        _lastGained = gained;
        _gpGained = gained;
        _gpPoints = points;
        _gpRank = rank;
        _gpTop = topIndices.Select((ix, i) => (Index: ix, Points: i < topPoints.Length ? topPoints[i] : 0)).ToList();
        _phase = "result";
        _gameStats.SaveLastPlayedGame("pomarblerace");
        UpdateStats();
        await InvokeAsync(StateHasChanged);

        if (place > 0 && myTime > 0)
        {
            await GameResults.SubmitMarbleRaceMapRecordAsync(new MarbleRaceRecordRequest(mapId, myTime));
        }

        if (round >= rounds)
        {
            // One local result for the whole Grand Prix: a podium overall is the win.
            _gpDone = true;
            _stats = await GameResults.RecordAndSubmitMarbleRaceAsync(
                _playerName, rank is >= 1 and <= 3 ? GameResult.Win : GameResult.Loss, null);
            UpdateStats();
            await InvokeAsync(StateHasChanged);
            return;
        }

        // On to the next course once the round's result has been read.
        await Task.Delay(GpRoundGapMs);
        if (_disposed || !_gp || _gpDone || _gpRound != round || _phase != "result") return;
        _gpRound = round + 1;
        _mapId = GpOrder is { Length: > 0 } order ? order[Math.Min(round, order.Length - 1)].Id : _mapId;
        await StopEngineAsync();
        _phase = "pick";
        _podium.Clear();
        _myPlace = -1;
        _split = null;
        _pickCountdown = PickSeconds;
        await InvokeAsync(StateHasChanged);
        await BootEngineAsync(null);
    }

    /// <summary>Your marble left the course and was put back (course.js _respawn).</summary>
    [JSInvokable]
    public async Task OnRespawn(int count)
    {
        var seq = ++_respawnSeq;
        _respawned = true;
        await InvokeAsync(StateHasChanged);
        await Task.Delay(2500);
        if (seq != _respawnSeq) return;
        _respawned = false;
        await InvokeAsync(StateHasChanged);
    }

    private async Task LoadDailyBoardAsync()
    {
        if (await ApiService.GetMarbleRaceDailyTimesAsync() is { } board) _dailyBoard = board;
    }

    // ── Rematch + series (online) ──
    // Each finished race scores the series for whoever placed better (a non-finish loses to any
    // finish; two non-finishes score nobody). A rematch needs both players to ask.
    private int _seriesMine, _seriesTheirs;
    private (bool Mine, bool Theirs) _rematch;

    private void ScoreSeries(int myPlace, int theirPlace)
    {
        var mine = myPlace > 0 ? myPlace : int.MaxValue;
        var theirs = theirPlace > 0 ? theirPlace : int.MaxValue;
        if (mine < theirs) _seriesMine++;
        else if (theirs < mine) _seriesTheirs++;
    }

    private async Task RequestRematchAsync()
    {
        if (_onlineClient is null) return;
        _rematch.Mine = true;
        await _onlineClient.RequestRematchAsync();
    }

    private void OnRematchChanged(MarbleRaceRematch r)
    {
        _ = InvokeAsync(async () =>
        {
            var host = _onlineRole == MarbleRaceRole.Host;
            if (r.Agreed)
            {
                _rematch = (false, false);
                _onlineResultKnown = false;
                _podium.Clear();
                // The host's engine rolls the next race; its pick phase reaches the guest by relay.
                if (host) { try { await JSRuntime.InvokeVoidAsync("PoMarbleRace.rematch"); } catch { } }
                else _phase = "pick";
            }
            else
            {
                _rematch = host ? (r.HostWants, r.GuestWants) : (r.GuestWants, r.HostWants);
            }
            StateHasChanged();
        });
    }

    private async Task CopyRoomCodeAsync()
    {
        if (_roomCode is null) return;
        try
        {
            await JSRuntime.InvokeVoidAsync("navigator.clipboard.writeText", _roomCode);
            ToastService.Show("Race code copied.", ToastType.Success);
        }
        catch { ToastService.Show($"Your code is {_roomCode}.", ToastType.Info); }
    }

    protected override void OnInitialized()
    {
        var mode = GameModes.Parse(Mode);
        _demo = mode == GameMode.Demo;
        _online = mode == GameMode.Multiplayer;
        _playerName = PlayerNameService.GetPlayerName();
        _stats = _gameStats.GetStats("pomarblerace", _playerName);
        UpdateStats();
    }

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (_disposed) return;
        // Every mode loads it: online picks a track too, and the HUD's colours come with it.
        if (firstRender)
        {
            await LoadMenuAsync();
            if (_disposed) return;
            _ref ??= DotNetObjectReference.Create(this);
            await TryJsAsync("PoMarbleRace.watchInput", _ref);
        }
        // "Reload engine": the boundary has re-rendered the canvas host, so the engine has a
        // container to mount into again.
        if (_rebootAfterRender)
        {
            _rebootAfterRender = false;
            await BootEngineAsync(_online ? _lastOnlineStart : null);
        }
    }

    /// <summary>Retry card (engine start failure or a render fault): reset and boot again.</summary>
    private async Task ReloadEngineAsync()
    {
        _engineError = null;
        await StopEngineAsync();
        _phase = "pick";
        _podium.Clear();
        _pickCountdown = PickSeconds;
        _rebootAfterRender = true;
        _boundary?.Recover();
        await InvokeAsync(StateHasChanged);
    }

    /// <summary>Track download progress, whole percent (index.js start()).</summary>
    [JSInvokable]
    public Task OnLoadProgress(int pct)
    {
        _loadPct = Math.Clamp(pct, 0, 100);
        return InvokeAsync(StateHasChanged);
    }

    /// <summary>The input device last used: 'keys', 'touch' or 'pad' (gamepad.js).</summary>
    [JSInvokable]
    public Task OnInputKind(string kind)
    {
        _inputKind = kind is "touch" or "pad" ? kind : "keys";
        return InvokeAsync(StateHasChanged);
    }

    [JSInvokable]
    public Task OnMuted(bool muted)
    {
        (_menu ??= new MarbleMenu()).Prefs.Muted = muted;
        return InvokeAsync(StateHasChanged);
    }

    private async Task ShowTutorialAsync()
    {
        _showTutorial = true;
        _tutorialAt = null;
        await InvokeAsync(StateHasChanged);
        // Let the start-gate camera settle before asking where the red marble sits on screen.
        await Task.Delay(600);
        try
        {
            var at = await JSRuntime.InvokeAsync<string>("PoMarbleRace.playerScreenPos");
            var parts = (at ?? "").Split(',');
            if (parts.Length == 2
                && double.TryParse(parts[0], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var x)
                && double.TryParse(parts[1], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var y))
            {
                _tutorialAt = (x, y);
            }
        }
        catch (JSException) { }
        await InvokeAsync(StateHasChanged);
    }

    private async Task DismissTutorialAsync()
    {
        _showTutorial = false;
        _tutorialAt = null;
        (_menu ??= new MarbleMenu()).Prefs.TutorialSeen = true;
        await TryJsAsync("PoMarbleRace.setPref", "tutorialSeen", true);
        if (_phase == "pick" && _engineStarted)
        {
            StopPickCountdown();
            await Pick(PlayerIndex);
        }
    }

    /// <summary>
    /// Pull the setup menu from the engine. Loading the engine here (while the intro card is being
    /// read) is also a prefetch: by the time the player presses Race, three.js is already in.
    /// </summary>
    private async Task LoadMenuAsync()
    {
        try
        {
            var recordsTask = ApiService.GetMarbleRaceMapRecordsAsync();
            var dailyTask = LoadDailyBoardAsync();
            if (!await JSRuntime.InvokeAsync<bool>("loadEngine", "pomarblerace")) return;
            var json = await JSRuntime.InvokeAsync<string>("PoMarbleRace.menu");
            if (await recordsTask is { } recs) _records = recs.GroupBy(r => r.MapId).ToDictionary(g => g.Key, g => g.MinBy(r => r.Seconds)!);
            await dailyTask;
            if (_disposed) return;
            var menu = JsonSerializer.Deserialize(json, MarbleMenuJsonContext.Default.MarbleMenu);
            if (menu is null) return;
            if (_menu is null)
            {
                _skin = menu.Skin;
                _weight = menu.Weight;
                if (menu.Maps.All(m => m.Id != _mapId)) _mapId = menu.DefaultMap;
            }
            _menu = menu;
            // Online never races the daily course (the server deals the seed there).
            if (_online && IsDailyMap(_mapId)) _mapId = menu.DefaultMap;
            await InvokeAsync(StateHasChanged);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[PoMarbleRace] menu failed: {ex.Message}");
        }
    }

    private async Task OnIntroStartAsync()
    {
        _introDone = true;
        // Seed the countdown BEFORE awaiting JS so the pill never flashes "Go in 0".
        _phase = "pick";
        _pickCountdown = PickSeconds;
        await InvokeAsync(StateHasChanged);

        if (_online)
        {
            // The engine boots once a pair forms (OnRaceStarted) — it needs the dealt seed.
            await StartOnlineAsync();
            return;
        }

        if (_gp && !_demo) StartGrandPrix();
        else _gp = false;

        if (_engineStarted)
        {
            // The engine was already up (demo re-cycle) — just kick it.
            try { await JSRuntime.InvokeVoidAsync("PoMarbleRace.resume"); }
            catch (Exception ex) { Console.Error.WriteLine($"[PoMarbleRace] resume failed: {ex.Message}"); }
            return;
        }
        await BootEngineAsync(null);
    }

    /// <summary>
    /// Change track: tear the engine down and reopen the intro card. A map is chosen at build
    /// time, so a new one means a new engine — and a new run, exactly as switching always did.
    /// </summary>
    private async Task ChangeTrackAsync()
    {
        StopPickCountdown();
        await StopEngineAsync();
        _introDone = false;
        _phase = "pick";
        _podium.Clear();
        await LoadMenuAsync();   // the card's per-track stats have moved on since it last opened
        await InvokeAsync(StateHasChanged);
    }

    /// <summary>
    /// Load and start the engine. <paramref name="online"/> is null for a local game, else the
    /// role/seed/guest-slot record game.js reads (see its Online section).
    /// </summary>
    private async Task BootEngineAsync(object? online)
    {
        if (_disposed) return;
        _engineStarted = true;
        _loading = true;
        _loadPct = 0;
        _engineError = null;
        _lastOnlineStart = online;
        _ref ??= DotNetObjectReference.Create(this);
        try
        {
            // Route-gated engine load (wwwroot/js/platform/engineLoader.js); idempotent after the first.
            if (!await JSRuntime.InvokeAsync<bool>("loadEngine", "pomarblerace"))
            {
                Console.Error.WriteLine("[pomarblerace] engine failed to load");
                FailEngine("The race engine didn't download. Check your connection and try again.");
                return;
            }

            // Null when the menu never loaded (an auto-skipped intro can beat it): the engine then
            // uses the last pick it saved itself.
            if (_disposed) return;
            object? marble = _menu is null || _demo || _online ? null : new { skin = _skin, weight = _weight };
            object? opts = _gp && online is null ? new { gp = new { round = _gpRound, rounds = GpOrder.Length } } : null;
            _raceRecorded = false;
            await JSRuntime.InvokeVoidAsync("PoMarbleRace.start", "marble-race-container", _ref, _demo, _mapId, online, marble, opts);
            if (_disposed) return;
            await JSRuntime.InvokeVoidAsync("PoMarbleRace.resume");
        }
        catch (JSException ex)
        {
            Console.Error.WriteLine($"[PoMarbleRace] JS init failed: {ex.Message}");
            // index.js throws a player-facing sentence for a failed course download; keep its
            // first line (the rest is the JS stack).
            var line = ex.Message.Split('\n', 2)[0].Trim();
            FailEngine(line.StartsWith("Couldn't", StringComparison.Ordinal) ? line : "The race engine failed to start.");
        }
        catch (Exception ex) when (ex is not OperationCanceledException and not JSDisconnectedException)
        {
            Console.Error.WriteLine($"[PoMarbleRace] JS init failed: {ex.Message}");
            FailEngine("The race engine failed to start.");
        }
    }

    private void FailEngine(string message)
    {
        _engineStarted = false;
        _loading = false;
        _engineError = message;
        StateHasChanged();
    }

    // ── Online session ──

    private async Task StartOnlineAsync()
    {
        _onlinePhase = OnlinePhase.Connecting;
        await InvokeAsync(StateHasChanged);
        try
        {
            await PlayerNameService.InitializeAsync();
            _playerName = PlayerNameService.GetPlayerName();
            if (_onlineClient is null)
            {
                _onlineClient = new PoMarbleRaceOnlineClient(Endpoints);
                _onlineClient.RaceStarted += OnRaceStarted;
                _onlineClient.FrameReceived += OnFrameReceived;
                _onlineClient.PhaseReceived += OnPhaseReceived;
                _onlineClient.PodiumReceived += OnPodiumReceived;
                _onlineClient.ResultReceived += OnResultReceived;
                _onlineClient.GuestSteerReceived += OnGuestSteerReceived;
                _onlineClient.RematchChanged += OnRematchChanged;
                _onlineClient.PeerLeft += OnPeerLeft;
                _onlineClient.ConnectionChanged += OnOnlineConnection;
            }
            await _onlineClient.ConnectAsync();
            await FindOpponentAsync();
        }
        catch (Exception)
        {
            _onlinePhase = OnlinePhase.Error;
            ToastService.Show("Couldn't reach the game server.", ToastType.Error);
            await InvokeAsync(StateHasChanged);
        }
    }

    private async Task RetryOnlineAsync()
    {
        await TearDownOnlineAsync();
        await StartOnlineAsync();
    }

    private async Task FindOpponentAsync()
    {
        if (_onlineClient is null) return;
        await StopEngineAsync();
        _onlinePhase = OnlinePhase.Searching;
        _onlineResultKnown = false;
        _phase = "pick";
        _podium.Clear();
        await InvokeAsync(StateHasChanged);
        _roomCode = null;
        _seriesMine = _seriesTheirs = 0;
        _rematch = (false, false);
        await InvokeAsync(StateHasChanged);
        // raceStarted may fire before these return (the server pairs inside the call), so the
        // phase is only ever advanced by the event, never here.
        // The hub still takes a "guest" flag from before players had ids; every player has one now.
        const bool guest = false;
        switch (_onlineHow)
        {
            case OnlineHow.CreateRoom:
                var room = await _onlineClient.CreateRoomAsync(_playerName, guest, _mapId);
                if (_onlinePhase == OnlinePhase.Searching) _roomCode = room?.Code;
                break;
            case OnlineHow.JoinRoom:
                var join = await _onlineClient.JoinRoomAsync(_joinCode, _playerName, guest);
                if (!join.Joined)
                {
                    ToastService.Show(join.Error ?? "Couldn't join that race.", ToastType.Warning);
                    // Back to the setup card so the code can be fixed.
                    await TearDownOnlineAsync();
                    _onlinePhase = OnlinePhase.Idle;
                    _introDone = false;
                }
                break;
            default:
                await _onlineClient.FindRaceAsync(_playerName, guest, _mapId);
                break;
        }
        await InvokeAsync(StateHasChanged);
    }

    private async Task FindOpponentSafeAsync()
    {
        try { await FindOpponentAsync(); }
        catch (Exception)
        {
            _onlinePhase = OnlinePhase.Error;
            await InvokeAsync(StateHasChanged);
        }
    }

    private void OnRaceStarted(MarbleRaceStart start)
    {
        _ = InvokeAsync(async () =>
        {
            _onlineRole = start.YourRole;
            _hostName = start.Host.DisplayName;
            _opponentName = start.YourRole == MarbleRaceRole.Host ? start.Guest.DisplayName : start.Host.DisplayName;
            _guestIndex = start.GuestMarbleIndex;
            _mapId = start.MapId;
            _roomCode = null;
            _onlinePhase = OnlinePhase.Racing;
            _onlineResultKnown = false;
            _phase = "pick";
            _pickCountdown = PickSeconds;
            StateHasChanged();
            await BootEngineAsync(new
            {
                role = start.YourRole == MarbleRaceRole.Host ? "host" : "guest",
                seed = start.Seed,
                guestIndex = start.GuestMarbleIndex,
            });
        });
    }

    // Guest: hand the host's snapshot to the engine. One-deep: a frame that arrives while the
    // previous interop call is still in flight is dropped, not queued — a late frame is worse
    // than a missing one when the next is 66 ms away.
    private void OnFrameReceived(MarbleRaceFrame f)
    {
        if (!IsOnlineGuest || !_engineStarted || !_applyFrameInFlight.IsCompleted) return;
        _applyFrameInFlight = ApplyFrameAsync(f);
    }

    private async Task ApplyFrameAsync(MarbleRaceFrame f)
    {
        try
        {
            await JSRuntime.InvokeVoidAsync("PoMarbleRace.applyFrame",
                f.Tick, f.Clock, f.Phase, f.Positions, f.Flags, f.GuestPlace, f.Field);
        }
        catch { /* engine torn down mid-frame */ }
    }

    private void OnPhaseReceived(MarbleRacePhase phase)
    {
        if (!IsOnlineGuest || phase.Phase != "pick") return;
        // The host has moved on to the next race; rebuild on its seed. The engine's own
        // OnPhase("pick") callback then resets the HUD exactly as it does for the host.
        _ = InvokeAsync(async () =>
        {
            try { await JSRuntime.InvokeVoidAsync("PoMarbleRace.nextTrack", phase.Seed); } catch { }
        });
    }

    private void OnPodiumReceived(MarbleRacePodium podium)
    {
        if (!IsOnlineGuest) return;
        _ = InvokeAsync(() => OnPodium(podium.Indices, podium.Times, podium.Gaps));
    }

    private void OnResultReceived(MarbleRaceResult result)
    {
        if (!IsOnlineGuest) return;
        _ = InvokeAsync(async () =>
        {
            if (_raceRecorded) return;
            _raceRecorded = true;
            _lastWon = result.GuestWon;
            _lastPlace = result.GuestPlace;
            _lastGained = 0;
            _opponentPlace = result.HostPlace;
            _onlineResultKnown = true;
            ScoreSeries(result.GuestPlace, result.HostPlace);
            _phase = "result";
            try { await JSRuntime.InvokeVoidAsync("PoMarbleRace.guestResult", result.GuestWon); } catch { }
            // A win/loss for the local record; the run/score/high-score system stays the host's.
            _gameStats.SaveLastPlayedGame("pomarblerace");
            _stats = await GameResults.RecordAndSubmitMarbleRaceAsync(
                _playerName, result.GuestWon ? GameResult.Win : GameResult.Loss, null);
            UpdateStats();
            StateHasChanged();
        });
    }

    private void OnGuestSteerReceived(int dir)
    {
        if (!IsOnlineHost || !_engineStarted) return;
        _ = InvokeAsync(async () =>
        {
            try { await JSRuntime.InvokeVoidAsync("PoMarbleRace.setGuestSteer", dir); } catch { }
        });
    }

    private void OnPeerLeft()
    {
        _ = InvokeAsync(async () =>
        {
            if (_onlinePhase is OnlinePhase.Idle or OnlinePhase.Error) return;
            ToastService.Show($"{_opponentName} left the race.", ToastType.Warning);
            await StopEngineAsync();
            _onlinePhase = OnlinePhase.PeerLeft;
            _phase = "pick";
            StateHasChanged();
        });
    }

    private void OnOnlineConnection(HubConnectionState state)
    {
        if (state != HubConnectionState.Disconnected) return;
        _ = InvokeAsync(async () =>
        {
            if (_onlinePhase is OnlinePhase.Idle or OnlinePhase.Error) return;
            await StopEngineAsync();
            _onlinePhase = OnlinePhase.Error;
            _phase = "pick";
            StateHasChanged();
        });
    }

    // Host: the engine's snapshot for the guest. Fire-and-forget; the client drops a frame when
    // the previous one is still on the wire.
    [JSInvokable]
    public void OnHostFrame(int tick, double clock, string phase, byte[] positions, byte[] flags,
                            int guestPlace, int field)
    {
        if (!IsOnlineHost) return;
        _onlineClient?.SendFrame(new MarbleRaceFrame
        {
            Tick = tick,
            Clock = clock,
            Phase = phase,
            Positions = positions,
            Flags = flags,
            GuestPlace = guestPlace,
            Field = field,
        });
    }

    // Guest: the engine's net steering direction (sent on change only, see game.js setSteer).
    [JSInvokable]
    public Task OnSteer(int dir) =>
        IsOnlineGuest && _onlineClient is not null ? _onlineClient.SteerAsync(dir) : Task.CompletedTask;

    // Host: the guest marble's standing, resolved alongside OnRaceResult. Relayed as one record
    // with the host's own result so the guest's summary can show both.
    [JSInvokable]
    public async Task OnGuestResult(bool won, int place)
    {
        _opponentPlace = place;
        _onlineResultKnown = true;
        if (IsOnlineHost) ScoreSeries(_lastPlace, place);
        if (IsOnlineHost && _onlineClient is not null)
        {
            await _onlineClient.SendResultAsync(new MarbleRaceResult(_lastWon, _lastPlace, won, place));
        }
        await InvokeAsync(StateHasChanged);
    }

    private void LeaveOnline() => Navigation.NavigateTo("/");

    private async Task StopEngineAsync()
    {
        StopPickCountdown();
        _showTutorial = false;
        _tutorialAt = null;
        if (!_engineStarted) return;
        _engineStarted = false;
        try { await JSRuntime.InvokeVoidAsync("PoMarbleRace.stop"); } catch { }
    }

    private async Task TearDownOnlineAsync()
    {
        var online = _onlineClient;
        if (online is null) return;
        _onlineClient = null;
        online.RaceStarted -= OnRaceStarted;
        online.FrameReceived -= OnFrameReceived;
        online.PhaseReceived -= OnPhaseReceived;
        online.PodiumReceived -= OnPodiumReceived;
        online.ResultReceived -= OnResultReceived;
        online.GuestSteerReceived -= OnGuestSteerReceived;
        online.RematchChanged -= OnRematchChanged;
        online.PeerLeft -= OnPeerLeft;
        online.ConnectionChanged -= OnOnlineConnection;
        await online.LeaveAsync();
        await online.DisposeAsync();
    }

    // ── Start countdown ──
    // Three seconds: the track and marble were chosen on the intro card, so this is only a "get
    // ready" beat. Cancellation rather than a System.Timers.Timer so the loop runs on the
    // component's own context and cannot race Stop/Dispose.
    private const int PickSeconds = 3;
    private const int TutorialPickSeconds = 8;
    private int _pickCountdown;
    private CancellationTokenSource? _pickCts;

    private void StartPickCountdown(int seconds = PickSeconds)
    {
        StopPickCountdown();
        _pickCountdown = seconds;
        var cts = new CancellationTokenSource();
        _pickCts = cts;
        _ = RunPickCountdownAsync(cts.Token);
    }

    private async Task RunPickCountdownAsync(CancellationToken ct)
    {
        try
        {
            using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
            while (_pickCountdown > 0 && await timer.WaitForNextTickAsync(ct))
            {
                _pickCountdown--;
                await Beep(final: _pickCountdown == 0);
                await InvokeAsync(StateHasChanged);
            }

            if (!ct.IsCancellationRequested) await Pick(PlayerIndex);
        }
        catch (OperationCanceledException)
        {
            // The phase moved on, the player changed track, or they left the page.
        }
    }

    private async Task Beep(bool final)
    {
        try { await JSRuntime.InvokeVoidAsync("PoMarbleRace.beep", final); } catch { }
    }

    private void StopPickCountdown()
    {
        var cts = _pickCts;
        _pickCts = null;
        if (cts is null) return;
        cts.Cancel();
        cts.Dispose();
    }

    private async Task Pick(int index)
    {
        StopPickCountdown();
        try { await JSRuntime.InvokeVoidAsync("PoMarbleRace.pick", index); } catch { }
    }

    // Hold-to-steer for the on-screen pads: dir -1 left / +1 right, active = pointer down.
    private async Task Steer(int dir, bool active)
    {
        try { await JSRuntime.InvokeVoidAsync("PoMarbleRace.setSteer", dir, active); } catch { }
    }

    // `chosen` stays in the signature (positional interop contract) but nothing here reads it.
    [JSInvokable]
    public async Task OnPhase(string phase, int chosen, int score, int best, int streak, int seed)
    {
        _phase = phase;
        _score = score;
        _best = best;
        _streak = streak;
        if (phase == "pick")
        {
            _raceRecorded = false;
            _loading = false;
            _myPlace = -1;
            _podium.Clear();   // hide the previous race's podium as the next race sets up

            // Demo auto-picks on the JS side, and an online guest starts when the host does. A first
            // solo race gives extra countdown headroom alongside the non-blocking tutorial tip.
            if (!_demo && !_online && _menu is { Prefs.TutorialSeen: false })
            {
                StartPickCountdown(TutorialPickSeconds);
                _ = ShowTutorialAsync();
            }
            else if (!_demo && !IsOnlineGuest) StartPickCountdown();
        }
        else
        {
            StopPickCountdown();
        }
        // Online host: the guest follows the host's phases; on "pick" the seed is what lets it
        // build the same next course.
        if (IsOnlineHost && _onlineClient is not null)
        {
            _ = _onlineClient.SendPhaseAsync(new MarbleRacePhase(phase, seed));
        }
        await InvokeAsync(StateHasChanged);
    }

    /// <param name="indices">Marble indices, in finishing order.</param>
    [JSInvokable]
    public async Task OnPodium(int[] indices, double[] times, double[] gaps)
    {
        var rows = new List<PodiumRow>(indices.Length);
        for (var i = 0; i < indices.Length; i++)
        {
            rows.Add(new PodiumRow(i + 1, ColorOf(indices[i]), RosterName(indices[i]), At(times, i), At(gaps, i)));
        }
        _podium = rows;
        if (IsOnlineHost && _onlineClient is not null)
        {
            _ = _onlineClient.SendPodiumAsync(new MarbleRacePodium(indices, times, gaps));
        }
        await InvokeAsync(StateHasChanged);
    }


    // ── Sector splits (checkpoint arches) ──
    private sealed record SectorSplit(int Sector, int Count, double Time, double Best);
    private SectorSplit? _split;
    private const int SplitShowMs = 3500;

    /// <summary>
    /// Your marble passed checkpoint <paramref name="sector"/> of <paramref name="count"/> (the
    /// last one is the line). <paramref name="best"/> is this map's best for that sector before
    /// this run, 0 when there is none.
    /// </summary>
    [JSInvokable]
    public async Task OnSector(int sector, int count, double time, double best)
    {
        var split = new SectorSplit(sector, count, time, best);
        _split = split;
        await InvokeAsync(StateHasChanged);
        await Task.Delay(SplitShowMs);
        // Only clear it if no later split replaced it meanwhile.
        if (ReferenceEquals(_split, split))
        {
            _split = null;
            await InvokeAsync(StateHasChanged);
        }
    }

    /// <summary>The HUD tick: your place and the size of the field still racing.</summary>
    [JSInvokable]
    public async Task OnRaceTick(int myPlace, int myField)
    {
        _myPlace = myPlace;
        _myField = myField > 0 ? myField : MarbleCount;
        if (_hud is { } hud) hud.Refresh();
        else await InvokeAsync(StateHasChanged);
    }

    private static double At(double[] values, int i) => i < values.Length ? values[i] : 0;

    /// <param name="runPlaces">The current run's races (parallel arrays, all empty after a miss);
    /// sent with a board submission so the server can recompute the total.</param>
    [JSInvokable]
    /// <param name="myTime">Your own finish time this race, 0 when you did not finish; offered to
    /// the server as the map's world record (it keeps only the fastest).</param>
    /// <param name="day">The UTC day (yyyy-MM-dd) of the Daily Canyon that was raced, "" on any
    /// other map; a daily finish goes on that day's board.</param>
    public async Task OnRaceResult(bool won, int place, int score, int gained, int streak, int best,
                                   int mapId, int[] runPlaces, double[] runTimes, double[] runLeads, double myTime,
                                   string day)
    {
        // A repeated callback for the same race must not record (or submit) it twice.
        if (_raceRecorded) return;
        _raceRecorded = true;
        _lastWon = won;
        _lastPlace = place;
        _lastGained = gained;
        _score = score;
        _streak = streak;
        _best = best;
        _phase = "result";

        if (!_demo)
        {
            _gameStats.SaveLastPlayedGame("pomarblerace");

            // Submit whenever this run beats what this visit has already sent; the board keeps
            // the better score. Identity is resolved server-side from the auth cookie.
            MarbleRaceHighScoreRequest? request = null;
            if (won && score > _submittedBest)
            {
                _submittedBest = score;
                var races = new MarbleRaceRunRace[runPlaces.Length];
                for (var i = 0; i < races.Length; i++)
                {
                    races[i] = new MarbleRaceRunRace(runPlaces[i], At(runTimes, i), At(runLeads, i));
                }
                request = new MarbleRaceHighScoreRequest(score, mapId, races);
            }

            if (place > 0 && myTime > 0)
            {
                await GameResults.SubmitMarbleRaceMapRecordAsync(
                    new MarbleRaceRecordRequest(mapId, myTime, string.IsNullOrEmpty(day) ? null : day));
                // The board with this finish on it, for the result sheet and the track card.
                if (!string.IsNullOrEmpty(day)) await LoadDailyBoardAsync();
            }

            // One intake records local stats and submits the high score together — no desync.
            _stats = await GameResults.RecordAndSubmitMarbleRaceAsync(
                _playerName, won ? GameResult.Win : GameResult.Loss, request);
            UpdateStats();
        }
        await InvokeAsync(StateHasChanged);
        // In the kiosk, the result stays visible until this demo's 60-second dwell expires.
    }

    private void UpdateStats()
    {
        var bucket = _gameStats.GetDifficultyBucket(_stats, Difficulty.Medium);
        _statItems = _gp
            ? GameStatsPanel.Build(bucket, includeDraws: false, includeElo: true,
                ("Round", $"{_gpRound}/{Math.Max(1, GpOrder.Length)}"),
                ("GP points", _gpPoints.ToString(System.Globalization.CultureInfo.InvariantCulture)))
            : GameStatsPanel.Build(bucket, includeDraws: false, includeElo: true,
                ("Run", _score.ToString(System.Globalization.CultureInfo.InvariantCulture)),
                ("Best", _best.ToString(System.Globalization.CultureInfo.InvariantCulture)));
    }

    private static string Ordinal(int n) => (n % 100) switch
    {
        11 or 12 or 13 => $"{n}th",
        _ => (n % 10) switch { 1 => $"{n}st", 2 => $"{n}nd", 3 => $"{n}rd", _ => $"{n}th" },
    };

    public async ValueTask DisposeAsync()
    {
        GC.SuppressFinalize(this);
        _disposed = true;
        // Online: tell the peer we left and drop the hub before the engine goes.
        await TearDownOnlineAsync();
        // Before the JS ref goes away — a pending tick would otherwise Pick() through a disposed ref.
        StopPickCountdown();
        try { await JSRuntime.InvokeVoidAsync("PoMarbleRace.unwatchInput"); } catch { }
        try { await JSRuntime.InvokeVoidAsync("PoMarbleRace.stop"); } catch { }
        _ref?.Dispose();
    }

    private sealed record PodiumRow(int Place, string Color, string Name, double Time, double Gap);
}
