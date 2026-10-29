using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;
using PoMiniGamesClient.Components;
using PoMiniGamesClient.Models;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;
using PoBrawlFighter = PoMiniGames.Domain.Primitives.PoBrawlFighter;
using PoBrawlRoster = PoMiniGames.Domain.Primitives.PoBrawlRoster;

namespace PoMiniGamesClient.Games.PoBrawl;

/// <summary>
/// Code-behind for <see cref="PoBrawlPage"/>: the state, the engine interop and the match flow.
/// The markup and every render fragment (intro, select, HUD chips, the result card) stay in
/// PoBrawlPage.razor.
/// </summary>
public partial class PoBrawlPage
{
    /// <summary>Route mode segment. Parsed by <see cref="GameModes.Parse"/>, which
    /// owns every accepted spelling and legacy form — see GameMode.cs.</summary>
    [Parameter] public string? Mode { get; set; }
    /// <summary>Online: the fight's internal match code (from the lobby's start, or a refresh).</summary>
    [SupplyParameterFromQuery(Name = "code")] public string? CodeQuery { get; set; }

    // 1-player ladder: PoBrawlRoster.Fighters in ladder order — most recent president first,
    // marching back in time to FDR. Rung index doubles as the CPU difficulty level (index + 1
    // → 1-15, the full range ai.js LEVELS/MAX_RUNG defines). fighters.js CHARACTERS is the
    // one copy of these names kept in step by hand.
    private static readonly PoBrawlFighter[] Roster = [.. PoBrawlRoster.Fighters];

    private static readonly PoBrawlFighter Bob = PoBrawlRoster.Bob;

    // 2-player select can pick anyone, BOB included — he is deliberately not on the rateable
    // roster (see PoBrawlRoster), which is why he is prepended rather than sorted in.
    private static readonly PoBrawlFighter[] PickableRoster = [Bob, .. Roster];

    // Fixed rating per ladder rung for the ELO math: rung 1 (Trump) is a
    // pushover at 800; rung 15 (FDR) tops out near 2660. Beating an easy rung
    // when your rating is high earns almost nothing; losing to it costs a lot.
    private static int PresidentElo(int rung) => 800 + rung * 133;

    private string _playerName = "";
    private string _mode = "1p";

    // Outcome for the end-of-game cue. _winner is 1 for the local player and 2
    // for the opponent; only the 1P ladder has a "you" to win, so 2-player stays
    // Unknown (see GameOverModal.Outcome). Online reads the server's outcome.
    private GameResult OutcomeForCue => _mode == "online"
        ? _netResult is { Abandoned: true } ? GameResult.InProgress   // never fought: neutral, not a draw
        : _netResult?.Outcome switch
        {
            PoMiniGames.Shared.Games.PoBrawlOutcome.Win => GameResult.Win,
            PoMiniGames.Shared.Games.PoBrawlOutcome.Loss => GameResult.Loss,
            PoMiniGames.Shared.Games.PoBrawlOutcome.Draw => GameResult.Draw,
            _ => GameResult.InProgress,
        }
        : _mode != "1p"
        ? GameResult.InProgress
        : _winner == 1 ? GameResult.Win
        : _winner == 2 ? GameResult.Loss
        : GameResult.InProgress;


    // ── Intro/welcome gate ──
    // The fight does not start until the intro card is dismissed: OK in 1P, and in 2P once
    // both players lock in their fighter with their own keyboard halves (P1: A/D + F,
    // P2: ←/→ + K — mirroring the in-game keys).
    private bool _introDone;
    private int _p1Sel;       // cursor into PickableRoster for player 1
    private int _p2Sel = 1;   // player 2 starts one down so they don't overlap P1
    private bool _p1Locked;
    private bool _p2Locked;
    private bool BothLocked => _p1Locked && _p2Locked;
    private GameIntro.IntroMode _introMode =>
        _mode == "2p" ? GameIntro.IntroMode.TwoPlayer : GameIntro.IntroMode.OnePlayer;
    // The 60-second limit belongs in the objective: a player who does not know the clock is
    // a deadline reads a decision loss as the game ending arbitrarily.
    private string IntroObjective => _mode == "2p"
        ? "Two fighters enter — one round, 60 seconds. Each player picks below."
        : "KO inside 60 seconds — closest health at the bell is a draw.";
    // "fighting" | "result".
    private string _phase = "fighting";
    private string _p1Char = "trump";
    private string _p2Char = "biden";
    // The page only forwards the engine's pump to the HUD (OnHud) and keeps the danger
    // milestones for the live region.
    private PoBrawlHud? _hud;
    private PoBrawlNetMeter? _netMeter;   // online only: the signal pill (OnNetSignal)
    private int _winner;
    private double _lastKo;
    private double _bestKo;
    private bool _newRecord;

    // The shell's polite live region. Sparse milestones only — round start, the first
    // reading of each fighter in the red, training and the result — never the 4×/sec HUD
    // pump.
    private string _announcement = "";
    private bool _p1DangerAnnounced;
    private bool _p2DangerAnnounced;

    // 1P win–loss for the result's facts line (UpdateStats).
    private string _record = "0–0";
    private PlayerStats _stats = new();
    private readonly GameStatsService _gameStats = new();
    private DotNetObjectReference<PoBrawlPage>? _ref;

    // ── 1P presidents ladder + adaptive ELO (same system as ConnectFive) ──
    private int _ladder;                 // 0-based rung; Roster[_ladder] is the opponent
    private bool _champion;              // the last rung just fell: the result modal shows the ending card
    private AdaptiveRating _rating = new();
    private int _lastEloDelta;
    // Rung, fastest KO and clears are kept per player name by PoBrawlProgressBook.
    private int _clears;                 // full ladder clears, all time

    // ── Fight recap ───────────────────────────────────────────────────────
    // Accumulated across every rung of a 1P run (2P and online are one fight), because
    // the modal is only shown once, at the end of the run. Null until the first
    // OnMatchEnd carries a payload.
    private PoBrawlMatchRecap? _recap;
    // The most recent round alone — what the press conference talks about.
    private PoBrawlMatchRecap? _lastRecap;

    // 1P: the engine is running the training room. Bound straight to the intro card's
    // "Training first" box.
    private bool _training;

    // How long a 1P win holds on the result before rolling into the next rung: long enough
    // for the banner and the winner's fanfare to land.
    private const int LadderResultHoldMs = 1800;
    // The between-rungs hold when the campaign map plays: the batch flips, then the bus drives.
    private const int CampaignInterludeMs = 4200;
    // Rungs beaten while the campaign interlude is on screen; null otherwise.
    private int? _campaignBeaten;

    // ── Post-fight press conference (scripted, PoBrawlPressLines) ─────────
    private PoBrawlPressLine? _presser;
    // Bumped when a fight starts or restarts, training is entered or the page goes away, so a
    // pending ladder roll (the LadderResultHoldMs wait) can tell it has been superseded.
    private int _ladderRollGeneration;

    // ── Pause (1P, training, 2P; never online). The engine owns the state (PoBrawl.setPaused)
    // and reports every change through OnPauseChanged. ──
    private bool _paused;
    private bool _focusResume;
    private ElementReference _resumeButton;
    private bool CanPause => _mode is "1p" or "2p";
    // Not between rungs: a restart there would re-fight the president just beaten, on a ladder
    // that has already moved up.
    private bool PauseAvailable => CanPause && _introDone && _phase == "fighting" && !_ladderRolling;
    private bool _ladderRolling;

    // ── Online (PoBrawlNetSession; the arena predicts the server's fight and rolls back) ──
    private PoBrawlNetSession? _net;
    private string _code = "";
    private string? _engineMatchId;   // the fight the running engine is showing
    private bool _netMissing;         // JoinMatch answered null: no fight on this code
    private bool _netConnectFailed;   // the hub never answered (network, auth): retryable
    private string? _netConnectError;
    // Corner state, cached at join. The live Snapshot can turn null underneath an open result
    // screen (a reconnect that answers null once the swept fight is gone), so name/side
    // readouts must not dereference it.
    private PoMiniGames.Shared.Games.PoBrawlSide? _localSide;
    private bool _isSpectator;
    private bool _everJoined;
    private PoMiniGames.Shared.Games.PoBrawlMatchResult? _netResult;
    private string? _netSubmittedFor; // match id whose result already went to the Elo board
    private string? _netNoticeShown;
    private string _p1Player = "";
    private string _p2Player = "";

    /// <summary>The fight is held at frame 0 until the second corner joins (not a warning).</summary>
    private bool NetWaiting => _net?.State is { Finished: false, WaitingForOpponent: true };

    /// <summary>What the network is doing to the fight, or null when nothing worth saying.</summary>
    private string? NetNotice
    {
        get
        {
            if (_net is null) return null;
            if (_net.ConnectionState == Microsoft.AspNetCore.SignalR.Client.HubConnectionState.Reconnecting) return "Reconnecting…";
            if (_net.ConnectionState == Microsoft.AspNetCore.SignalR.Client.HubConnectionState.Disconnected) return "Disconnected";
            // The other corner has not reached the hub yet: the server holds the clock at frame 0
            // and starts the countdown when they arrive. ForfeitInSeconds is their arrival time left.
            if (_net.State is { Finished: false, WaitingForOpponent: true } w)
            {
                var due = w.ForfeitInSeconds is { } arrive ? $" ({Math.Ceiling(arrive):0}s)" : "";
                var whom = _isSpectator ? (!w.Player1Connected ? _p1Player : _p2Player) : "your opponent";
                return $"Waiting for {whom}…{due}";
            }
            if (_net.State is { Finished: false, ForfeitInSeconds: { } left } s)
            {
                var who = !s.Player1Connected ? _p1Player : _p2Player;
                return $"{who} dropped — forfeit in {Math.Ceiling(left):0}s";
            }
            return null;
        }
    }

    /// <summary>
    /// Per-round scorecard reported by the engine alongside the result.
    /// </summary>
    /// <remarks>
    /// Bound from the JS object literal in <c>game.js _reportResult</c> — Blazor's interop
    /// serializer is camelCase, so <c>p1Hits</c> lands on <see cref="P1Hits"/>. Passing this
    /// as an object rather than eight more positional arguments is deliberate: interop fails
    /// silently on an arity mismatch (see the remarks on <see cref="OnHud"/>), whereas an
    /// unknown JSON property is simply ignored.
    /// </remarks>
    public sealed record PoBrawlMatchRecap(
        int P1Hits, int P2Hits,
        int P1Blocks, int P2Blocks,
        int P1BestCombo, int P2BestCombo,
        int P1BiggestHit, int P2BiggestHit);

    // Totals for counts, best-of for peaks — a "biggest hit" summed across rounds
    // would be a number that never happened.
    private static PoBrawlMatchRecap Accumulate(PoBrawlMatchRecap? a, PoBrawlMatchRecap b) =>
        a is null ? b : new PoBrawlMatchRecap(
            a.P1Hits + b.P1Hits, a.P2Hits + b.P2Hits,
            a.P1Blocks + b.P1Blocks, a.P2Blocks + b.P2Blocks,
            Math.Max(a.P1BestCombo, b.P1BestCombo), Math.Max(a.P2BestCombo, b.P2BestCombo),
            Math.Max(a.P1BiggestHit, b.P1BiggestHit), Math.Max(a.P2BiggestHit, b.P2BiggestHit));

    protected override void OnInitialized()
    {
        // /pobrawl/demo (the Cup), /pobrawl/multi (the lobby) and /pobrawl/hq are their own
        // pages' literal routes, so only 1P, 2P and online land here.
        _mode = GameModes.Parse(Mode) == GameMode.TwoPlayer ? "2p" : "1p";
        // /pobrawl/online?code=… — the lobby's fight. Not a GameModes slug: it is not a way to
        // START a game (that is /pobrawl/multi), only where a started one is played or watched.
        // The lobby page showed the intro card, so there is none here.
        if (string.Equals(Mode, "online", StringComparison.OrdinalIgnoreCase))
        {
            _mode = "online";
            _introDone = true;
            _code = (CodeQuery ?? "").Trim().ToUpperInvariant();
        }
        else if (!IsKnownMode(Mode))
        {
            // /pobrawl/bogus would play 1P on an address the mode switch does not recognise,
            // so the 1P/2P/Online/Demo tabs vanished. Same page, the canonical address.
            Nav.NavigateTo("/pobrawl" + new Uri(Nav.Uri).Query, replace: true);
        }
        LoadLocalProgress();
        // The name can still be settling (localStorage read, then the signed-in display name) —
        // and everything above is keyed by it. See OnPlayerNameChanged.
        PlayerNameService.StateChanged += OnPlayerNameChanged;
        // Same for the identity itself: under ?autoGuest=1 the guest session is still being
        // minted on first render, so the cloud-progress fetch below 403s. OnAuthSettled
        // re-runs the merge the moment auth flips to signed-in. See MergeRemoteProgressAsync.
        Auth.StateChanged += OnAuthSettled;

        if (_mode == "2p")
        {
            // Seed the HUD from the select cursors so the nameplates behind the
            // intro card match what the two columns are pointing at.
            _p1Char = PickableRoster[_p1Sel].Id;
            _p2Char = PickableRoster[_p2Sel].Id;
        }
        UpdateStats();
    }

    private static bool IsKnownMode(string? mode) =>
        string.IsNullOrEmpty(mode)
        || string.Equals(mode, GameModes.OnePlayerSlug, StringComparison.OrdinalIgnoreCase)
        || string.Equals(mode, GameModes.TwoPlayerSlug, StringComparison.OrdinalIgnoreCase);

    // One remote-progress merge per page life: first render when already signed in, otherwise
    // the moment the auto-guest identity settles (see OnAuthSettled).
    private bool _progressFetched;

    /// <summary>
    /// 1P: pick up ladder progress saved from another device (GET /api/pobrawl/progress). The
    /// newer of the two copies wins the rung; the fastest KO and the clear count take the best.
    /// Never blocks the page — offline or signed out, the local copy simply stands.
    /// </summary>
    protected override async Task OnInitializedAsync()
    {
        if (_mode != "1p") return;
        if (!Auth.IsAuthenticated) return; // OnAuthSettled picks this up.
        _progressFetched = true;
        await MergeRemoteProgressAsync();
    }

    private void OnAuthSettled()
    {
        if (_mode != "1p" || _progressFetched || _introDone || !Auth.IsAuthenticated) return;
        _progressFetched = true;
        _ = InvokeAsync(async () =>
        {
            await MergeRemoteProgressAsync();
            StateHasChanged();
        });
    }

    private async Task MergeRemoteProgressAsync()
    {
        var remote = await ApiService.GetPoBrawlProgressAsync();
        if (remote is null) return;
        // Once the fight has started the running match owns the rung; the records still merge.
        var merged = PoBrawlProgressBook.Adopt(_playerName, remote, takeRung: !_introDone);
        if (!_introDone)
        {
            _ladder = merged.Rung;
            _p2Char = Roster[_ladder].Id;
        }
        _bestKo = merged.BestKoSeconds;
        _clears = merged.Clears;
        UpdateStats();
    }

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        // The engine boots only once the intro is dismissed (see OnIntroStartAsync)
        // so the fight never runs behind the welcome card. Just create the interop
        // handle here — InitEngine needs it.
        if (firstRender) _ref = DotNetObjectReference.Create(this);
        // 2P select: keep the live portraits (selectStage.js) on the cursors and locks.
        // After _ref: the first call awaits the engine module's load.
        if (_mode == "2p" && !_introDone) await SyncSelectStageAsync();
        // The pause card just opened: Resume takes focus, so Enter or Space resumes too (the
        // engine still reads Escape and P with a button focused).
        if (_focusResume && _paused && PauseAvailable)
        {
            _focusResume = false;
            try { await _resumeButton.FocusAsync(); } catch { /* not rendered yet */ }
        }
        if (!firstRender) return;

        if (_mode == "online")
        {
            await StartOnlineAsync();
            return;
        }
    }

    /// <summary>Everything this page keeps per player name: stats, Elo, the rung, the fastest KO, the clears.</summary>
    private void LoadLocalProgress()
    {
        _playerName = PlayerNameService.GetPlayerName();
        _stats = _gameStats.GetStats("pobrawl", _playerName);
        var progress = PoBrawlProgressBook.Load(_playerName);
        _bestKo = progress.BestKoSeconds;
        _clears = progress.Clears;
        if (_mode != "1p") return;
        _rating = _gameStats.GetAdaptiveRating("pobrawl", _playerName);
        _ladder = progress.Rung;
        _p1Char = Bob.Id;
        _p2Char = Roster[_ladder].Id;
    }

    /// <summary>
    /// The player name settled after OnInitialized read it. On a reload the page can initialise
    /// before the stored name (and then the signed-in display name) arrives, so the rung would be
    /// read under the wrong key. Re-read it — until the fight starts; after that the running
    /// match owns the numbers.
    /// </summary>
    private void OnPlayerNameChanged()
    {
        if (_introDone || PlayerNameService.GetPlayerName() == _playerName) return;
        _ = InvokeAsync(() =>
        {
            LoadLocalProgress();
            UpdateStats();
            StateHasChanged();
        });
    }

    // Routes the intro's key events to each player's selection column. Physical
    // key codes (KeyA, ArrowLeft…) so the mapping is layout-independent and
    // matches each player's in-game half of the keyboard.
    private void OnIntroKey(Microsoft.AspNetCore.Components.Web.KeyboardEventArgs e)
    {
        // A held key auto-repeats: it would race the cursor and flick a lock on and off.
        if (_mode != "2p" || _introDone || e.Repeat) return;
        var n = PickableRoster.Length;
        var wasLocked = BothLocked;
        // The grid is SelectColumns wide: across is ±1, down is ±SelectColumns (the in-game
        // circle keys, W/S and ↑/↓), all wrapping.
        switch (e.Code)
        {
            case "KeyA": if (!_p1Locked) _p1Sel = (_p1Sel - 1 + n) % n; break;
            case "KeyD": if (!_p1Locked) _p1Sel = (_p1Sel + 1) % n; break;
            case "KeyW": if (!_p1Locked) _p1Sel = (_p1Sel - SelectColumns + n) % n; break;
            case "KeyS": if (!_p1Locked) _p1Sel = (_p1Sel + SelectColumns) % n; break;
            case "KeyF": _p1Locked = !_p1Locked; break;
            case "ArrowLeft": if (!_p2Locked) _p2Sel = (_p2Sel - 1 + n) % n; break;
            case "ArrowRight": if (!_p2Locked) _p2Sel = (_p2Sel + 1) % n; break;
            case "ArrowUp": if (!_p2Locked) _p2Sel = (_p2Sel - SelectColumns + n) % n; break;
            case "ArrowDown": if (!_p2Locked) _p2Sel = (_p2Sel + SelectColumns) % n; break;
            case "KeyK": _p2Locked = !_p2Locked; break;
            default: return;
        }
        // The second lock → straight into the fight (no reaching for the mouse). Only on the
        // lock itself: a cursor key pressed once both are in must not replay the VS sting.
        if (BothLocked && !wasLocked) { _ = VersusThenStartAsync(); return; }
        StateHasChanged();
    }

    // Columns of the 2P select grid — the CSS (.pb-select-grid) draws the same four.
    private const int SelectColumns = 4;

    /// <summary>
    /// A tap on the grid picks AND locks for whoever is still choosing — player 1, then
    /// player 2 — so a pointer pair gets through in two taps. A player who wants another
    /// fighter unlocks from their side card and taps again.
    /// </summary>
    private void TapFighter(int idx)
    {
        // Both already in: the VS sting is running, and a tap changes nothing.
        if (_introDone || BothLocked) return;
        if (!_p1Locked) { _p1Sel = idx; _p1Locked = true; }
        else { _p2Sel = idx; _p2Locked = true; }
        if (BothLocked) _ = VersusThenStartAsync();
    }

    /// <summary>Pointer equivalent of the F and K lock-in keys.</summary>
    private void ToggleLock(int side)
    {
        if (_introDone) return;
        if (side == 1) _p1Locked = !_p1Locked; else _p2Locked = !_p2Locked;
        // Match the keyboard path: both sides ready starts the fight (a toggle can only make
        // BothLocked true by locking, so this never replays the sting).
        if (BothLocked) _ = VersusThenStartAsync();
    }

    // ── 2P select presentation (wwwroot/js/pobrawl/selectStage.js) ───────
    // The select's one WebGL canvas lives inside this element; see SelectContent.
    private const string SelectStageId = "pb-select-stage";
    private Task? _selectStageMount;
    private string? _selectStageSent;   // the cursor/lock state the stage last saw
    private bool _versusRunning;        // the VS sting is playing; a second both-locked waits on it

    private string SelectStageKey => $"{_p1Sel}|{_p2Sel}|{_p1Locked}|{_p2Locked}";

    /// <summary>
    /// Mounts the live portraits once (loading the engine module early, which the fight needs
    /// next anyway), then pushes each cursor/lock change. Primitives only — no interop DTO.
    /// Presentation: any failure leaves the plain glass tiles, which work on their own.
    /// </summary>
    private async Task SyncSelectStageAsync()
    {
        _selectStageMount ??= MountSelectStageAsync();
        await _selectStageMount;
        if (_introDone || SelectStageKey == _selectStageSent) return;
        _selectStageSent = SelectStageKey;
        try
        {
            await JSRuntime.InvokeVoidAsync("PoBrawl.select.update",
                PickableRoster[_p1Sel].Id, PickableRoster[_p2Sel].Id, _p1Locked, _p2Locked);
        }
        catch (Exception ex) { Console.Error.WriteLine($"[PoBrawl] select update failed: {ex.Message}"); }
    }

    private async Task MountSelectStageAsync()
    {
        try
        {
            if (!await JSRuntime.InvokeAsync<bool>("loadEngine", "pobrawl") || _introDone) return;
            _selectStageSent = SelectStageKey;
            await JSRuntime.InvokeAsync<bool>("PoBrawl.select.mount", SelectStageId,
                PickableRoster[_p1Sel].Id, PickableRoster[_p2Sel].Id, _p1Locked, _p2Locked);
        }
        catch (Exception ex) { Console.Error.WriteLine($"[PoBrawl] select stage failed: {ex.Message}"); }
    }

    /// <summary>
    /// Both corners locked: the second seal stamps, the VS sting plays and the slash crosses
    /// the screen (instant under reduced motion), then the fight starts — unless someone
    /// unlocked in the meantime. One sting at a time: a lock landing while it plays is picked
    /// up by the check at its end.
    /// </summary>
    private async Task VersusThenStartAsync()
    {
        if (_versusRunning) return;
        _versusRunning = true;
        StateHasChanged();
        try { await JSRuntime.InvokeVoidAsync("PoBrawl.select.versus", SelectStageId); }
        catch { /* no engine module: start straight away */ }
        finally { _versusRunning = false; }
        if (!BothLocked) return;
        await OnIntroStartAsync();
    }

    // The presidential seal stamped on a locked-in side card: a scalloped gold disc, a ring
    // of stars, a centre star. Built once; the colours are the emblem's own, theme-invariant.
    // Also stamped on a readied card in the online lobby.
    internal static readonly MarkupString SealSvg = new(BuildSealSvg());

    private static string BuildSealSvg()
    {
        var inv = System.Globalization.CultureInfo.InvariantCulture;
        var edge = new System.Text.StringBuilder();
        for (var i = 0; i < 48; i++)
        {
            var a = i * Math.PI / 24;
            var r = i % 2 == 0 ? 48 : 44.5;
            edge.Append(inv, $"{50 + r * Math.Sin(a):0.##},{50 - r * Math.Cos(a):0.##} ");
        }
        var stars = new System.Text.StringBuilder();
        for (var i = 0; i < 13; i++)
        {
            var a = i * 2 * Math.PI / 13;
            stars.Append(inv, $"<circle cx=\"{50 + 34 * Math.Sin(a):0.##}\" cy=\"{50 - 34 * Math.Cos(a):0.##}\" r=\"2.1\"/>");
        }
        var star = new System.Text.StringBuilder();
        for (var i = 0; i < 10; i++)
        {
            var a = i * Math.PI / 5;
            var r = i % 2 == 0 ? 17 : 7;
            star.Append(inv, $"{50 + r * Math.Sin(a):0.##},{46 - r * Math.Cos(a):0.##} ");
        }
        return "<svg viewBox=\"0 0 100 100\" focusable=\"false\">"
            + $"<polygon points=\"{edge}\" fill=\"#e9b923\" stroke=\"#8a5a06\" stroke-width=\"2\"/>"
            + "<circle cx=\"50\" cy=\"50\" r=\"39\" fill=\"#f6cf4a\" stroke=\"#8a5a06\" stroke-width=\"1.6\"/>"
            + "<circle cx=\"50\" cy=\"50\" r=\"29\" fill=\"none\" stroke=\"#8a5a06\" stroke-width=\"1.2\"/>"
            + $"<g fill=\"#8a5a06\">{stars}</g>"
            + $"<polygon points=\"{star}\" fill=\"#fff6cf\" stroke=\"#8a5a06\" stroke-width=\"1.4\"/>"
            + "<text x=\"50\" y=\"71\" text-anchor=\"middle\" font-size=\"10\" font-weight=\"900\" letter-spacing=\"1\" fill=\"#5c3a02\">READY</text>"
            + "</svg>";
    }

    // Dismisses the intro and boots the engine. Idempotent: the FIGHT button and
    // the both-players-locked path can both fire, but the fight starts once.
    private async Task OnIntroStartAsync()
    {
        if (_introDone) return;
        _introDone = true;

        if (_mode == "2p")
        {
            // The two intro columns decided these (per-half keys, or tap). The
            // cursors start one apart (Bob vs Trump), so Start without locking
            // still starts a legal, mirror-free fight.
            _p1Char = PickableRoster[_p1Sel].Id;
            _p2Char = PickableRoster[_p2Sel].Id;
            // Free the select's WebGL context before the arena asks for its own
            // (PoBrawl.init does it too; this covers an engine that fails to boot).
            if (_selectStageMount is not null)
            {
                try { await JSRuntime.InvokeVoidAsync("PoBrawl.select.unmount"); } catch { }
            }
        }
        // 1P keeps the ladder matchup chosen in OnInitialized (BOB vs the rung).
        if (_mode == "1p" && _training)
        {
            _announcement = $"Training room on — no clock, no KO. Fight {CharName(_p2Char)} when ready.";
        }

        StateHasChanged();
        await InitEngine();
    }

    /// <summary>Returns every HUD readout to its round-start value (engine boot and the next rung).</summary>
    private void ResetRoundHud()
    {
        _hud?.Reset();
    }

    private async Task InitEngine()
    {
        ResetRoundHud();
        _paused = false; // a fresh engine starts running
        // 1P difficulty is the ladder rung (1 = pushover Trump … 15 = brutal
        // FDR); 2P and online have no CPU, so the value is only a placeholder.
        object difficulty = _mode == "1p" ? _ladder + 1 : "medium";
        // Online: which corner is ours (0 = watching). The engine's rollback session drives both
        // corners and only reads the local keys for corner `localSide`.
        var localSide = _net?.Snapshot is { IsSpectator: false } snap
            ? (snap.LocalSide == PoMiniGames.Shared.Games.PoBrawlSide.Player1 ? 1 : 2)
            : 0;
        var introLine = IntroLine();
        try
        {
            // Route-gated engine load (wwwroot/js/engineLoader.js): it has to be pulled in
            // before the first interop call. Idempotent after the first await.
            if (!await JSRuntime.InvokeAsync<bool>("loadEngine", "pobrawl"))
            {
                Console.Error.WriteLine("[pobrawl] engine failed to load");
                return;
            }

            await JSRuntime.InvokeVoidAsync("PoBrawl.init", "pobrawl-container", _ref,
                new
                {
                    mode = _mode,
                    p1Character = _p1Char,
                    p2Character = _p2Char,
                    difficulty,
                    training = _training,
                    localSide,
                    introLine,
                });
            // Honour the global ⚙️ master-mute setting on every engine boot.
            if (Settings.Muted)
            {
                await JSRuntime.InvokeVoidAsync("PoBrawl.setMuted", true);
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[PoBrawl] JS init failed: {ex.Message}");
        }
    }

    // ── Online ───────────────────────────────────────────────────────────
    private async Task StartOnlineAsync()
    {
        if (string.IsNullOrEmpty(_code))
        {
            Nav.NavigateTo("/pobrawl/multi");
            return;
        }
        _net = new PoBrawlNetSession(Endpoints);
        _net.Joined += snap => InvokeAsync(() => OnNetJoinedAsync(snap));
        _net.StateReceived += OnNetState;
        _net.InputReceived += OnNetInputEvent;
        _net.ClockSampled += OnNetClock;
        _net.Finished += r => InvokeAsync(() => OnNetFinishedAsync(r));
        _net.ConnectionChanged += _ => InvokeAsync(StateHasChanged);
        try
        {
            await _net.ConnectAsync(_code);
        }
        catch (Exception ex)
        {
            // A missing fight is not an exception — JoinMatch answers null (OnNetJoinedAsync).
            // Anything thrown is the transport, the sign-in or the hub refusing: worth a retry.
            Console.Error.WriteLine($"[PoBrawl] online connect failed: {ex.Message}");
            _netConnectFailed = true;
            _netConnectError = PoBrawlNetSession.HubMessage(ex, "The fight server didn't answer. Check your connection and try again.");
            StateHasChanged();
        }
    }

    private async Task RetryConnectAsync()
    {
        _netConnectFailed = false;
        _netConnectError = null;
        if (_net is { } old)
        {
            _net = null;
            await old.DisposeAsync();
        }
        StateHasChanged();
        await StartOnlineAsync();
    }

    /// <summary>
    /// A (re-)join answered. A new fight boots the arena on its fighters; a reconnect to the
    /// fight already on screen just carries on.
    /// </summary>
    private async Task OnNetJoinedAsync(PoMiniGames.Shared.Games.PoBrawlMatchSnapshot? snap)
    {
        if (snap is null)
        {
            // A reconnect after the fight was swept is not "missing" — the result is already up.
            if (_engineMatchId is null) _netMissing = true;
            StateHasChanged();
            return;
        }
        _netMissing = false;
        _everJoined = true;
        _isSpectator = snap.IsSpectator;
        _localSide = snap.LocalSide;
        _p1Player = snap.Player1.DisplayName;
        _p2Player = snap.Player2.DisplayName;
        if (snap.MatchId == _engineMatchId) { StateHasChanged(); return; }

        _engineMatchId = snap.MatchId;
        _p1Char = snap.Player1.FighterId;
        _p2Char = snap.Player2.FighterId;
        _netResult = null;
        _recap = null;
        _lastRecap = null;
        _presser = null;
        ++_ladderRollGeneration;
        _winner = 0;
        _phase = "fighting";
        _announcement = snap.IsSpectator
            ? $"Watching {_p1Player} versus {_p2Player}."
            : $"Online fight — you are the {(snap.LocalSide == PoMiniGames.Shared.Games.PoBrawlSide.Player1 ? "left" : "right")} corner against {OpponentPlayer}.";
        StateHasChanged();
        await InitEngine();
    }

    /// <summary>A confirmed input (either corner's, ours echoed): straight to the arena's rollback session.</summary>
    private void OnNetInputEvent(PoMiniGames.Shared.Games.PoBrawlMatchInputEvent e) =>
        _ = JSRuntime.InvokeVoidAsync("PoBrawl.netInput", e).AsTask().ContinueWith(_ => { }, TaskScheduler.Default);

    /// <summary>A clock-sync sample: the server's frame clock and the round trip that measured it.</summary>
    private void OnNetClock(double clockFrame, double rttMs) =>
        _ = JSRuntime.InvokeVoidAsync("PoBrawl.netClock", clockFrame, rttMs).AsTask().ContinueWith(_ => { }, TaskScheduler.Default);

    /// <summary>Every server snapshot (~10 Hz): straight to the arena, off the render path.</summary>
    private void OnNetState(PoMiniGames.Shared.Games.PoBrawlMatchState s)
    {
        _ = JSRuntime.InvokeVoidAsync("PoBrawl.net", s).AsTask().ContinueWith(_ => { }, TaskScheduler.Default);
        // Re-render only when something the page shows changed: the network notice.
        var notice = NetNotice;
        if (notice != _netNoticeShown)
        {
            _netNoticeShown = notice;
            InvokeAsync(StateHasChanged);
        }
    }

    /// <summary>The server's result for our corner: the outcome the modal names, and the Elo write (once per fight).</summary>
    private async Task OnNetFinishedAsync(PoMiniGames.Shared.Games.PoBrawlMatchResult r)
    {
        _netResult = r;
        if (r.Abandoned)
        {
            // The opponent never arrived: no fight, no rating, nothing to report. The engine may
            // never reach a result of its own from a frozen clock, so the page ends it here.
            _phase = "result";
            _presser = null;
            _announcement = _isSpectator
                ? "The fight never started — a corner never showed up."
                : "Your opponent never showed up. No rating change.";
            StateHasChanged();
            return;
        }
        StateHasChanged();
        if (_netSubmittedFor == r.MatchId || _isSpectator || _net?.Snapshot is null) return;
        _netSubmittedFor = r.MatchId;
        // Retries a 503 (the Elo write) with the same body inside the server's hold on the fight.
        if (!await ApiService.SubmitPoBrawlOnlineMatchAsync(new PoMiniGames.Shared.Games.PoBrawlMatchResultDto { MatchId = r.MatchId }))
        {
            Toasts.Show("Couldn't record the match — Elo didn't update.", ToastType.Warning);
        }
    }

    /// <summary>
    /// netplay.js → one local input, already applied by the arena's rollback session on
    /// <paramref name="frame"/>: the held state (0–3, corner-relative) and an attack press (0 or 4–6).
    /// </summary>
    [JSInvokable]
    public Task OnNetInput(long frame, int held, int press, long sequence) =>
        _net?.SendInputAsync(frame, held, press, sequence) ?? Task.CompletedTask;

    /// <summary>
    /// netplay.js → the signal meter's numbers, at 2 Hz: the round trip (ms), rollbacks plus hard
    /// corrections per second, and the deepest rollback so far (frames). Only the meter re-renders.
    /// </summary>
    [JSInvokable]
    public void OnNetSignal(int rttMs, double rollbacksPerSecond, int maxDepth) =>
        _netMeter?.Update(rttMs, rollbacksPerSecond, maxDepth);

    // The LOCAL side is cached at join (see the field note on _localSide): the Snapshot can
    // be gone while the result screen is still up, and "who is my opponent" must survive it.
    private string OpponentPlayer => _localSide == PoMiniGames.Shared.Games.PoBrawlSide.Player2 ? _p1Player : _p2Player;

    /// <summary>The HUD nameplate: the president, and online the person driving them too.</summary>
    private string HudName(int side)
    {
        var fighter = CharName(side == 1 ? _p1Char : _p2Char);
        if (_mode != "online") return fighter;
        var player = side == 1 ? _p1Player : _p2Player;
        return string.IsNullOrEmpty(player) ? fighter : $"{player} · {fighter}";
    }

    // ── Ring introduction ────────────────────────────────────────────────
    /// <summary>
    /// The PA's introduction for the fight about to start, handed to the engine, which speaks
    /// and captions it under the VS splash. Local fights only.
    /// </summary>
    private string? IntroLine() =>
        _training || _mode == "online" ? null : PoBrawlPressLines.Intro(_p1Char, _p2Char)?.Text;

    // ── Training room (1P) ───────────────────────────────────────────────
    // Entered from the intro card; left by the bar's "Back to the ladder". Either direction
    // re-inits the engine (PoBrawl.init disposes the running game), so whatever was in
    // progress is abandoned: no result, no ladder change.
    private async Task LeaveTrainingAsync()
    {
        _training = false;
        _phase = "fighting";
        ++_ladderRollGeneration; // a pending ladder roll belongs to a fight that is gone
        // The room-to-fight flip is invisible in the arena itself — say it.
        _announcement = $"Back to the ladder — fighting {CharName(_p2Char)} for the rung.";
        await InitEngine();
    }

    private async Task ResetTrainingAsync()
    {
        try { await JSRuntime.InvokeVoidAsync("PoBrawl.training", "reset"); } catch { }
    }

    // ── Post-fight press conference ──────────────────────────────────────
    // Only called on the paths that SHOW the result modal.
    private async Task StartPresserAsync()
    {
        _presser = null;
        if (_lastRecap is not { } r) return;

        // 1P: the president at the podium (winner or loser, it is their press conference).
        // 2P: the winner, or player 1 on a draw.
        var speakerIsP2 = _mode == "1p" || _winner == 2;
        var speakerWon = _winner != 0 && (_winner == 2) == speakerIsP2;
        var outcome = _winner == 0 ? PoMiniGames.Shared.Games.PoBrawlOutcome.Draw
            : speakerWon ? PoMiniGames.Shared.Games.PoBrawlOutcome.Win
            : PoMiniGames.Shared.Games.PoBrawlOutcome.Loss;
        var reply = PoBrawlPressLines.Press(new PoBrawlPressLines.Bout(
            SpeakerId: speakerIsP2 ? _p2Char : _p1Char,
            OpponentId: speakerIsP2 ? _p1Char : _p2Char,
            Outcome: outcome,
            // The engine only reports a result before the 60 s bell on a knockout.
            Knockout: _winner != 0 && _lastKo < 59.9,
            Hits: speakerIsP2 ? r.P2Hits : r.P1Hits,
            OpponentHits: speakerIsP2 ? r.P1Hits : r.P2Hits,
            Blocks: speakerIsP2 ? r.P2Blocks : r.P1Blocks,
            BestCombo: speakerIsP2 ? r.P2BestCombo : r.P1BestCombo,
            BiggestHit: speakerIsP2 ? r.P2BiggestHit : r.P1BiggestHit,
            Seconds: (int)Math.Round(_lastKo)));
        _presser = reply;
        // The shell's live region reads it.
        if (reply is not null) _announcement = $"Press conference — {reply.Speaker}: {reply.Text}";
        await InvokeAsync(StateHasChanged);
    }

    /// <summary>
    /// HUD pump from the JS engine (<c>game.js _pushHud</c>, ~4×/sec).
    /// </summary>
    /// <remarks>
    /// <b>The parameter list is an exact arity contract with the engine — keep them in
    /// step.</b> <c>invokeMethodAsync</c> fails outright when the argument count does not
    /// match, and the engine's call is wrapped in <c>.catch(() =&gt; {})</c>, so a mismatch
    /// is silent: no console error, just a HUD that never updates. Changing this list means
    /// editing <c>game.js _pushHud</c> in the same commit.
    /// </remarks>
    [JSInvokable]
    public void OnHud(int p1Hp, int p2Hp, double elapsed, int[]? p1Regions, int[]? p2Regions,
        int p1Energy, int p2Energy)
    {
        // The pump re-renders the HUD component only (it skips identical pumps itself); the
        // page re-renders just for a new danger milestone, which is live-region text.
        _hud?.Update(p1Hp, p2Hp, elapsed, p1Regions, p2Regions, p1Energy, p2Energy);
        if (UpdateDangerAnnouncements(p1Hp, p2Hp)) InvokeAsync(StateHasChanged);
    }

    // The first reading of a fighter in the red is a milestone the shared live region
    // speaks; leaving the red re-arms it. Returns true when something new was said.
    private bool UpdateDangerAnnouncements(int p1Hp, int p2Hp)
    {
        var said = false;
        if (PoBrawlHud.InDanger(p1Hp))
        {
            if (!_p1DangerAnnounced)
            {
                _p1DangerAnnounced = true;
                _announcement = $"{CharName(_p1Char)} is in the red — health critical.";
                said = true;
            }
        }
        else
        {
            _p1DangerAnnounced = false;
        }

        if (PoBrawlHud.InDanger(p2Hp))
        {
            if (!_p2DangerAnnounced)
            {
                _p2DangerAnnounced = true;
                _announcement = $"{CharName(_p2Char)} is in the red — health critical.";
                said = true;
            }
        }
        else
        {
            _p2DangerAnnounced = false;
        }

        return said;
    }

    /// <summary>
    /// Engine → page on every spawn: whether this match is a training session (1P) — its own
    /// method, not an OnMatchStart argument, for the arity reason on OnHud.
    /// </summary>
    [JSInvokable]
    public void OnTrainingState(bool active)
    {
        _training = active;
        InvokeAsync(StateHasChanged);
    }

    /// <summary>Engine → page on every spawn: the resolved ids keep the HUD names on the
    /// fighters underneath them.</summary>
    [JSInvokable]
    public void OnMatchStart(string p1Char, string p2Char)
    {
        if (!string.IsNullOrEmpty(p1Char)) _p1Char = p1Char;
        if (!string.IsNullOrEmpty(p2Char)) _p2Char = p2Char;
        // Every respawn would otherwise be silent to a screen reader.
        _announcement = $"New fight — {CharName(_p1Char)} versus {CharName(_p2Char)}.";
        InvokeAsync(StateHasChanged);
    }

    /// <param name="winner">1 = left fighter, 2 = right fighter, 0 = draw.</param>
    /// <param name="elapsedSeconds">Round clock at the finish.</param>
    /// <param name="recap">
    /// This round's scorecard. Optional so a stale cached engine cannot break the call:
    /// unlike the positional arguments, a missing object binds to null instead of failing
    /// the whole invocation and silently swallowing the match result.
    /// </param>
    [JSInvokable]
    public async Task OnMatchEnd(int winner, double elapsedSeconds, PoBrawlMatchRecap? recap = null)
    {
        _winner = winner;
        _lastKo = elapsedSeconds;
        if (recap is not null) _recap = Accumulate(_recap, recap);
        _lastRecap = recap;
        _paused = false;

        // Online: the engine only presents the server's result (netplay.js ends the fight when
        // the server does). The outcome that counts — and the Elo write — arrive separately as
        // matchFinished (OnNetFinishedAsync).
        if (_mode == "online")
        {
            _phase = "result";
            // Abandoned (nobody fought): OnNetFinishedAsync already said so, and there is no presser.
            if (_netResult is { Abandoned: true })
            {
                await InvokeAsync(StateHasChanged);
                return;
            }
            _announcement = winner == 0
                ? "The bell — a draw."
                : $"{(winner == 1 ? _p1Player : _p2Player)} takes it with {CharName(winner == 1 ? _p1Char : _p2Char)}.";
            await InvokeAsync(StateHasChanged);
            if (!_isSpectator) _ = StartPresserAsync();
            return;
        }

        if (_mode == "2p")
        {
            _phase = "result";
            // Name the winner: the modal headline means nothing on a shared keyboard.
            _announcement = winner == 0
                ? "Round over — a draw at the bell."
                : $"Round over — {CharName(winner == 1 ? _p1Char : _p2Char)} takes it.";
            await InvokeAsync(StateHasChanged);
            _ = StartPresserAsync();
            return;
        }

        _gameStats.SaveLastPlayedGame("pobrawl");

        // A new fastest KO is submitted to the global board (session-debounced by _bestKo).
        PoBrawlHighScore? best = null;
        _newRecord = false;
        var won = winner == 1;
        // A KO, not a decision at the bell: a time-up win is not a "KO in 60.00s" record.
        if (won && elapsedSeconds > 0 && elapsedSeconds < 59.9 && (_bestKo == 0 || elapsedSeconds < _bestKo))
        {
            _bestKo = PoBrawlProgressBook.RecordBestKo(_playerName, elapsedSeconds);
            _newRecord = true;
            best = new PoBrawlHighScore
            {
                // One identity across boards: full display name, not initials.
                PlayerInitials = _playerName,
                KoTimeSeconds = Math.Round(elapsedSeconds, 2),
                Character = _p1Char,
                // Stamped here, once: the same entry is what gets parked and replayed.
                Date = DateTime.UtcNow.ToString("O"),
            };
        }

        var result = winner == 0 ? GameResult.Draw : (won ? GameResult.Win : GameResult.Loss);

        // Adaptive ELO (same system as ConnectFive): scored against the
        // beaten/losing president's fixed ladder rating, so early rungs are
        // worth little and Nixon is worth a lot.
        var before = _rating.Elo;
        _rating = _gameStats.RecordAdaptiveResult("pobrawl", _playerName, PresidentElo(_ladder), result);
        _lastEloDelta = _rating.Elo - before;

        // Ladder: a win with presidents still in line rolls straight into the
        // next fight — no modal. The shared end-of-game modal is reserved for
        // the run's *end*: a loss/draw (gauntlet over) or the full-ladder clear.
        var advanceToNext = false;
        if (won)
        {
            if (_ladder >= Roster.Length - 1)
            {
                _champion = true;   // cleared the last rung → triumphant end, show the modal
                _ladder = 0;
                _clears = PoBrawlProgressBook.RecordClear(_playerName);
            }
            else
            {
                _ladder++;
                advanceToNext = true;   // another CPU is queued → skip the modal
            }
            SaveLadder();

            // Global ladder board: presidents beaten this run (Roster.Length on a full clear —
            // _ladder has already wrapped to 0). The server keeps each player's best, so a
            // dropped submit self-heals on the next win — and the next rung never waits on it.
            _ = ApiService.SubmitPoBrawlLadderAsync(new PoBrawlLadderEntry
            {
                PlayerName = _playerName,
                PresidentsBeaten = _champion ? Roster.Length : _ladder,
                Elo = _rating.Elo,
            });
        }

        // The record and the fastest-KO submit run beside the roll, not in front of it: a slow
        // network must not hold the next rung. The result's W–L follows when they land.
        _ = RecordResultAsync(result, best);

        // The live region says the 1P result — including the roll-into-the-next-rung path,
        // which shows no modal at all.
        _announcement = won
            ? _champion
                ? $"You beat {CharName(_p2Char)} — the whole ladder is down. Champion!"
                : $"You beat {CharName(_p2Char)}. Next up: {Roster[_ladder].Name}. {PoBrawlCampaign.VotesAfter(_ladder)} of {PoBrawlCampaign.ToWin} electoral votes."
            : winner == 0
                ? $"Draw at the bell against {CharName(_p2Char)} — the rung holds."
                : $"Knocked out by {CharName(_p2Char)} — {_ladder} of {Roster.Length} rungs beaten.";

        if (advanceToNext)
        {
            _ladderRolling = true;
            try { await RollToNextRungAsync(); }
            finally { _ladderRolling = false; }
            return;
        }

        _phase = "result";
        await InvokeAsync(StateHasChanged);
        _ = StartPresserAsync();
    }

    /// <summary>
    /// A 1P win with presidents still in line: hold on the result, play the campaign interlude,
    /// then roll the engine into the next rung — no modal.
    /// </summary>
    private async Task RollToNextRungAsync()
    {
        // Hold on the result first (see LadderResultHoldMs). Leaving for training or
        // navigating away inside the hold supersedes this roll.
        // OnMatchEnd only fires once the engine is in 'result', after the KO cinematic, so the
        // hold starts straight away.
        var generation = _ladderRollGeneration;
        var nextP2 = Roster[_ladder].Id;
        _p2Char = nextP2;
        // The campaign-map interlude is part of the Full show; the Simple one just holds.
        if (PoBrawlShowPrefs.IsFull)
        {
            _campaignBeaten = _ladder;
            await InvokeAsync(StateHasChanged);
            await Task.Delay(Math.Max(LadderResultHoldMs, CampaignInterludeMs));
            if (_campaignBeaten == _ladder) _campaignBeaten = null;
        }
        else
        {
            await Task.Delay(LadderResultHoldMs);
        }
        if (generation != _ladderRollGeneration || _training)
        {
            await InvokeAsync(StateHasChanged);
            return;
        }

        // Stay in the fight: reset the HUD and roll the engine into the next president.
        // GameOver stays false, so no modal is shown.
        _p2Char = nextP2;
        _phase = "fighting";
        ResetRoundHud();
        await InvokeAsync(StateHasChanged);
        var introLine = IntroLine();
        try { await JSRuntime.InvokeVoidAsync("PoBrawl.next", _p2Char, _ladder + 1, introLine); }
        catch (Exception ex) { Console.Error.WriteLine($"[PoBrawl] next-match failed: {ex.Message}"); }
    }

    /// <summary>The local record, then the fastest-KO submit (parked offline by GameResultService).</summary>
    private async Task RecordResultAsync(GameResult result, PoBrawlHighScore? best)
    {
        try
        {
            _stats = await GameResults.RecordAndSubmitPoBrawlAsync(_playerName, result, best);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[PoBrawl] recording the result failed: {ex.Message}");
            return;
        }
        UpdateStats();
        await InvokeAsync(StateHasChanged);
    }

    private void UpdateStats()
    {
        var bucket = _gameStats.GetDifficultyBucket(_stats, Difficulty.Medium);
        _record = $"{bucket.Wins}–{bucket.Losses}";
    }

    // ── Pause ────────────────────────────────────────────────────────────
    /// <summary>
    /// Engine → page whenever the fight pauses or resumes: the pause button, Escape / P, the
    /// auto-pause when the tab or window loses focus, a restart.
    /// </summary>
    [JSInvokable]
    public void OnPauseChanged(bool paused)
    {
        if (!CanPause || _paused == paused) return;
        _paused = paused;
        _focusResume = paused;
        if (paused) _announcement = "Paused. Press Escape or P to resume.";
        InvokeAsync(StateHasChanged);
    }

    private async Task PauseAsync()
    {
        try { await JSRuntime.InvokeVoidAsync("PoBrawl.setPaused", true); }
        catch (Exception ex) { Console.Error.WriteLine($"[PoBrawl] pause failed: {ex.Message}"); }
    }

    // The card closes on the engine's OnPauseChanged(false), never here: Escape and P on the
    // open card reach the engine (data-pb-pause), and a page-side toggle would double it.
    private async Task ResumeAsync()
    {
        try { await JSRuntime.InvokeVoidAsync("PoBrawl.setPaused", false); }
        catch (Exception ex) { Console.Error.WriteLine($"[PoBrawl] resume failed: {ex.Message}"); }
    }

    /// <summary>The bout again from the countdown — same fighters, same rung (or a fresh training room).</summary>
    private async Task RestartFightAsync()
    {
        ResetRoundState();
        _announcement = $"Restart — {CharName(_p1Char)} versus {CharName(_p2Char)}.";
        await RestartEngineAsync();
    }

    private void QuitFight() => Nav.NavigateTo("/pobrawl", forceLoad: true);

    /// <summary>Returns the page to a bout about to start: no result, no pause, a fresh HUD.</summary>
    private void ResetRoundState()
    {
        ++_ladderRollGeneration; // a pending ladder roll belongs to a bout that is gone
        _phase = "fighting";
        _winner = 0;
        _paused = false;
        _campaignBeaten = null;
        _p1DangerAnnounced = _p2DangerAnnounced = false;
        ResetRoundHud();
    }

    /// <summary>PoBrawl.restart keeps the engine; an engine without it gets a fresh boot instead.</summary>
    private async Task RestartEngineAsync()
    {
        try
        {
            await JSRuntime.InvokeVoidAsync("PoBrawl.restart");
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[PoBrawl] restart failed, re-initialising: {ex.Message}");
            await InitEngine();
        }
    }

    private string ResultLine()
    {
        if (_mode == "online")
        {
            // Not a win: the fight never happened, and the server moved no rating.
            if (_netResult is { Abandoned: true })
            {
                return _isSpectator
                    ? "🚪 The fight never started — a corner never showed up."
                    : "🚪 Your opponent never showed up — no rating change.";
            }
            var how = _netResult?.Forfeit == true ? " by forfeit"
                : _net?.State?.LastEvent == "ko" ? " by knockout"
                : " on the cards";
            if (_netResult is { } r && !_isSpectator)
            {
                return r.Outcome switch
                {
                    PoMiniGames.Shared.Games.PoBrawlOutcome.Win => $"🏆 You beat {OpponentPlayer}{how}!",
                    PoMiniGames.Shared.Games.PoBrawlOutcome.Loss => $"💀 {OpponentPlayer} beat you{how}.",
                    _ => "🤝 Dead even at the bell — a draw.",
                };
            }
            if (_winner == 0) return "🤝 Dead even at the bell — a draw.";
            return $"🏆 {(_winner == 1 ? _p1Player : _p2Player)} wins{how} with {CharName(_winner == 1 ? _p1Char : _p2Char)}!";
        }

        if (_mode == "2p")
        {
            if (_winner == 0) return "🤝 Too close to call — draw!";
            return $"🏆 {CharName(_winner == 1 ? _p1Char : _p2Char)} wins — Player {_winner}!";
        }

        // A 1P draw ends the run without advancing the ladder: the rung is not cleared.
        if (_winner == 0) return $"🤝 Too close to call — {CharName(_p2Char)} holds the rung.";
        return _winner == 1
            ? $"🏆 BOB knocked out {CharName(_p2Char)}!"
            : $"💀 {CharName(_p2Char)} beat BOB.";
    }

    private static string CharName(string id) =>
        PickableRoster.FirstOrDefault(r => r.Id == id)?.Name ?? id;

    private static int LadderRungOf(string presidentId)
    {
        var idx = Array.FindIndex(Roster, r => r.Id == presidentId);
        return idx < 0 ? 0 : idx;
    }

    /// <summary>
    /// Persist the rung here and, signed in, on the server (PUT /api/pobrawl/progress) so the run
    /// follows the player to another device. The timestamp is what lets the newer copy win on load.
    /// </summary>
    private void SaveLadder()
    {
        var progress = PoBrawlProgressBook.RecordRung(_playerName, _ladder);
        if (!Auth.IsAuthenticated) return;
        _ = ApiService.SavePoBrawlProgressAsync(progress);
    }

    public async ValueTask DisposeAsync()
    {
        // A ladder roll still in its hold must not call PoBrawl.next on whatever engine the next
        // page boots (the Cup shares the PoBrawl global).
        ++_ladderRollGeneration;
        PlayerNameService.StateChanged -= OnPlayerNameChanged;
        Auth.StateChanged -= OnAuthSettled;
        try { await JSRuntime.InvokeVoidAsync("PoBrawl.destroy"); } catch { }
        // Leaving the page mid-fight is a drop: the server's reconnect grace starts now.
        if (_net is not null) await _net.DisposeAsync();
        _ref?.Dispose();
    }
}
