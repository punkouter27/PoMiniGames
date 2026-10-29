using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;
using PoMiniGames.Shared.Games.PoMule;
using PoMiniGamesClient.Models;
using PoMiniGamesClient.Services;
using PoMiniGamesClient.Services.Play;
using Radzen;

namespace PoMiniGamesClient.Games.PoMule;

/// <summary>
/// PoMule's page: owns the match (<see cref="PoMuleMatch"/>, all rules in C#), hands the
/// renderer one snapshot per tick, and turns what the renderer reports back into engine calls.
/// </summary>
/// <remarks>
/// The renderer's frame loop is the only clock. It calls <see cref="OnTick"/>; nothing here
/// uses a timer, so a hidden tab or a phone held upright pauses the match for free. Every change
/// to the match goes through a <see cref="PoMuleMatch"/> method, never straight into its state,
/// because those methods write the action log the server replays to verify the score. The
/// canvas shows nearly everything (planet, store, auction, status); this page adds only the
/// start card, the role buttons, the standings and the demo speed buttons.
/// </remarks>
public partial class PoMulePage : IAsyncDisposable
{
    private enum Stage { Loading, Intro, Playing, Failed }

    // What walking into a stall inside the store does (mirrors js/pomule/world.js).
    private const int TownBuyMule = 0, TownPub = 5, TownAssay = 6;

    private static readonly int[] DemoSpeeds = [1, 2, 4, 8, 16];

    [Parameter] public string? Mode { get; set; }

    [Inject] private IJSRuntime JS { get; set; } = null!;
    [Inject] private PlayerNameService PlayerNameService { get; set; } = null!;
    [Inject] private GameResultService GameResults { get; set; } = null!;
    [Inject] private KioskCoordinator Kiosk { get; set; } = null!;
    [Inject] private PoMuleSaveStore Saves { get; set; } = null!;

    private DotNetObjectReference<PoMulePage>? _ref;
    private PoMuleMatch? _match;
    private MatchState? _saved;
    private List<PoMuleRow> _rows = [];
    private List<StatItem>? _endStats;
    private Stage _stage = Stage.Loading;
    private Species _species = Species.Humanoid;
    private GameResult _outcome = GameResult.InProgress;
    private string _playerName = "";
    private string? _announcement;
    private string _endLine = "";
    private string? _mode;
    private bool _demo;
    private bool _classic;
    private bool _radzenReady;
    private bool _finished;
    private bool _plotsDirty;
    private bool _disposed;
    private int _demoSpeed = 4;
    private Phase _shownPhase;
    private long _lastRender;

    protected override void OnInitialized() => _playerName = PlayerNameService.GetPlayerName();

    protected override async Task OnParametersSetAsync()
    {
        // Blazor reuses this component between /pomule/1player and /pomule/demo.
        if (_mode == (Mode ?? "")) return;
        var first = _mode is null;
        _mode = Mode ?? "";
        _demo = GameModes.Parse(Mode) == GameMode.Demo;
        if (!first) await ResetAsync();
    }

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (firstRender) await LoadAsync();
    }

    private async Task LoadAsync()
    {
        try
        {
            if (!await JS.InvokeAsync<bool>("loadEngine", "pomule")) throw new InvalidOperationException("engine");
            _radzenReady = await JS.InvokeAsync<bool>("PoMule.ensureRadzen");
            _saved = _demo ? null : await Saves.LoadAsync();
            _stage = Stage.Intro;
        }
        catch (Exception ex) when (ex is JSException or InvalidOperationException)
        {
            _stage = Stage.Failed;
        }
        StateHasChanged();
    }

    private Task RetryAsync()
    {
        _stage = Stage.Loading;
        return LoadAsync();
    }

    private async Task ResetAsync()
    {
        await StopEngineAsync();
        _match = null;
        _finished = false;
        _outcome = GameResult.InProgress;
        _saved = _demo ? null : await Saves.LoadAsync();
        _stage = Stage.Intro;
    }

    private Task StartNewAsync() =>
        BeginAsync(PoMuleMatch.New((ulong)Random.Shared.NextInt64(1, long.MaxValue), _demo ? null : _species, fast: _demo, classic: _classic && !_demo));

    // The start card's OK: the saved match when "Continue" is ticked (the default), else a new one.
    private Task StartAsync() => _resume && _saved is { } saved ? BeginAsync(new PoMuleMatch(saved)) : StartNewAsync();

    private bool _resume = true;

    private async Task BeginAsync(PoMuleMatch match)
    {
        _match = match;
        _saved = null;
        _finished = false;
        _outcome = GameResult.InProgress;
        _shownPhase = match.State.Phase;
        if (!_demo) match.State.Players[0].Name = string.IsNullOrWhiteSpace(_playerName) ? "You" : _playerName;
        _rows = PoMuleUi.Rows(match.State);
        _stage = Stage.Playing;
        StateHasChanged();

        _ref ??= DotNetObjectReference.Create(this);
        var plots = match.State.Map.Plots;
        await JS.InvokeVoidAsync("PoMule.start", "pomule-canvas", _ref, new
        {
            terrain = plots.Select(p => (int)p.Terrain).ToArray(),
            peaks = plots.Select(p => (int)p.Peaks).ToArray(),
            species = match.State.Players.Select(p => (int)p.Species).ToArray(),
            // What each colonist's species does on the map; -1 under classic rules, where none does anything.
            traits = match.State.Players.Select(p => match.State.Classic ? -1 : (int)p.Species).ToArray(),
            colors = PoMuleUi.SeatColors,
            names = match.State.Players.Select(p => p.Name).ToArray(),
            human = !_demo,
            speed = _demo ? _demoSpeed : 1,
            snapshot = match.Snapshot(),
        });
        await PushPlotsAsync();
    }

    // ── Renderer → engine ──

    /// <summary>The renderer's clock: advance the match and hand back what to draw.</summary>
    [JSInvokable]
    public double[] OnTick(int ticks)
    {
        if (_match is not { } match) return [];
        var state = match.State;
        var monthStarted = match.Advance(ticks);

        foreach (var notice in match.Notices) Announce(notice);

        if (state.Phase == Phase.Finished)
        {
            if (!_finished) _ = FinishAsync();
        }
        else if (monthStarted && !_demo)
        {
            _ = Saves.SaveAsync(state);
        }

        if (state.Phase != _shownPhase)
        {
            _shownPhase = state.Phase;
            _announcement = $"Month {state.Month}, {PoMuleUi.PhaseName(state.Phase)}.";
            _plotsDirty = true;
            if (state.Phase == Phase.Standings && _luck is { } luck)
            {
                Say(luck, seconds: 6);
                _luck = null;
            }
            // The renderer counts production up plot by plot, and marks where an event struck.
            if (state.Phase == Phase.Production && match.Report is { } report)
            {
                _ = JS.InvokeVoidAsync("PoMule.production", report.PlotOutput);
                _ = JS.InvokeVoidAsync("PoMule.eventAt", state.EventPlot >= 0 ? state.EventPlot : report.PestPlot);
            }
        }
        if (_plotsDirty) _ = PushPlotsAsync();

        // The Blazor parts (standings, bid card) redraw on a phase change, else four times a second.
        var now = Environment.TickCount64;
        if (now - _lastRender > 250 || _plotsDirty)
        {
            _lastRender = now;
            _rows = PoMuleUi.Rows(state);
            StateHasChanged();
        }
        return match.Snapshot();
    }

    /// <summary>Puts what just happened on the canvas's orange message line.</summary>
    private void Announce(Notice notice)
    {
        var state = _match!.State;
        var who = notice.Seat >= 0 ? state.Players[notice.Seat].Name : "";
        switch (notice.Kind)
        {
            case NoticeKind.LandGranted:
                _plotsDirty = true;
                if (notice.Seat == 0 && !_demo) Say("The plot is yours.", "claim");
                break;
            case NoticeKind.AuctionWon:
                _plotsDirty = true;
                Say($"{who} buys the plot for ${notice.B}.", "buy");
                break;
            case NoticeKind.MuleRanAway:
                _ = JS.InvokeVoidAsync("PoMule.runaway", notice.Seat);
                Say(notice.Seat == 0 && !_demo ? "Your M.U.L.E. ran away!" : $"{who}'s M.U.L.E. ran away!");
                break;
            case NoticeKind.PubVisit when notice.Seat == 0 && !_demo:
                Say($"You win ${notice.A} gambling at the pub.", "buy");
                break;
            case NoticeKind.Traded:
                _ = JS.InvokeVoidAsync("PoMule.trade", notice.Seat, notice.A, notice.B);
                break;
            case NoticeKind.ColonyEvent when (ColonyEvent)notice.A != ColonyEvent.None:
                Say($"{PoMuleEvents.Headline((ColonyEvent)notice.A)}! {PoMuleEvents.Detail((ColonyEvent)notice.A)}", "refuse", seconds: 6);
                break;
            case NoticeKind.Luck:
                // Shown after the colony event has had its moment, in the standings pause.
                _luck = PoMuleEvents.LuckText((LuckKind)notice.A, who, notice.B);
                break;
            case NoticeKind.WampusCaught:
                Say(notice.Seat == 0 && !_demo ? $"You caught the wampus! It pays ${notice.A}." : $"{who} caught the wampus.", "wampus");
                break;
        }
    }

    private string? _luck;

    private void Say(string text, string sound = "", int seconds = 4)
    {
        if (_disposed) return;
        _ = JS.InvokeVoidAsync("PoMule.say", text, seconds, sound);
    }

    [JSInvokable]
    public void OnLandPick(int plot)
    {
        if (_match is { State: { Phase: Phase.Land } state } match && plot >= 0 && plot < state.Owner.Length)
            match.PickLand(plot);
    }

    [JSInvokable]
    public void OnArrive(int seat)
    {
        if (_match is null || seat is < 0 or >= PoMuleTuning.Seats) return;
        Report(() => _match.Arrive(seat));
        _plotsDirty = true;
    }

    [JSInvokable]
    public void OnBump(int seat)
    {
        if (_match is null || seat is < 0 or >= PoMuleTuning.Seats) return;
        Report(() => _match.Bump(seat, dashing: true));
    }

    [JSInvokable]
    public void OnWampus()
    {
        if (!_demo && _match is not null) Report(() => _match.CatchWampus(0));
    }

    /// <summary>Runs an engine call and announces only the notices that call added.</summary>
    private void Report(Action call)
    {
        var seen = _match!.Notices.Count;
        call();
        foreach (var notice in _match.Notices.Skip(seen).ToList()) Announce(notice);
    }

    /// <summary>The player walked into a stall inside the store.</summary>
    [JSInvokable]
    public void OnTown(int stall)
    {
        if (_demo || _match?.State is not { Phase: Phase.Development } state) return;
        var me = state.Players[0];
        switch (stall)
        {
            case TownBuyMule:
                if (me.HasMule) Say("You already have a M.U.L.E. in tow.");
                else if (Check(_match.BuyMule())) Say($"One M.U.L.E. for ${state.Store.MulePrice}. Now outfit it.", "buy");
                break;
            case >= 1 and <= 4:
                var good = (Good)(stall - 1);
                if (!me.HasMule) Say("Get a M.U.L.E. from the corral first.", "refuse");
                else if (Check(_match.Outfit(good))) Say($"Outfitted for {PoMuleUi.GoodNames[stall - 1]}. Take it to your plot.", "buy");
                break;
            case TownPub:
                Report(() => _match.HumanPub());
                break;
            case TownAssay:
                if (_match.VisitAssay() == Outcome.Ok) Say("Assay kit in hand. Press the button on any plot.", "buy");
                break;
        }
    }

    /// <summary>The player pressed the button out on the map: install the towed M.U.L.E., or survey.</summary>
    [JSInvokable]
    public void OnPlotAction(int plot)
    {
        if (_demo || _match?.State is not { Phase: Phase.Development } state || plot < 0 || plot >= state.Owner.Length) return;
        var me = state.Players[0];
        if (me.HasMule)
        {
            if (me.Outfit < 0) { Say("Outfit your M.U.L.E. in town first.", "refuse"); return; }
            var outcome = _match.Install(plot);
            if (outcome == Outcome.Runaway) Announce(new Notice(NoticeKind.MuleRanAway, 0));
            else if (outcome == Outcome.Ok) Say("M.U.L.E. installed.", "claim");
        }
        else if (me.HoldsAssay && _match.Survey(plot) == Outcome.Ok)
        {
            Say($"Crystite level here: {state.Map.Plots[plot].Crystite} of 4.", "claim");
        }
        _plotsDirty = true;
    }

    private bool Check(Outcome outcome)
    {
        switch (outcome)
        {
            case Outcome.NoCash: Say("You cannot afford that.", "refuse"); break;
            case Outcome.SoldOut: Say("The corral is empty. The Store needs Smithore.", "refuse"); break;
            case Outcome.NotAllowed: Say("Not now.", "refuse"); break;
        }
        return outcome == Outcome.Ok;
    }

    [JSInvokable]
    public void OnMarketInput(int direction)
    {
        if (_match is not null) _match.HumanMarketInput = Math.Sign(direction);
    }

    [JSInvokable]
    public void OnSkip() => SkipStandings();

    // ── The page's own buttons ──

    private void SkipStandings()
    {
        if (!_demo && _match is { State.Phase: Phase.Standings } match) match.SkipStandings();
    }

    private void SetRole(sbyte role)
    {
        if (!_demo && _match is { State: { Phase: Phase.Market, MarketGood: >= 0 } } match)
            match.SetRole(role);
    }

    private ButtonStyle RoleStyle(sbyte role) =>
        _match?.State.LaneRole[0] == role ? ButtonStyle.Warning : ButtonStyle.Secondary;

    private async Task SetDemoSpeedAsync(int speed)
    {
        _demoSpeed = speed;
        try { await JS.InvokeVoidAsync("PoMule.setSpeed", speed); }
        catch (JSException) { }
    }

    // ── Engine → renderer ──

    private async Task PushPlotsAsync()
    {
        if (_match is not { } match || _disposed) return;
        _plotsDirty = false;
        var state = match.State;
        var crystite = new int[state.Owner.Length];
        for (var i = 0; i < crystite.Length; i++)
        {
            // A demo shows only what has been assayed; a player also sees what their species can.
            var visible = _demo ? state.Assayed[i] : PoMuleDevelopment.CanSeeCrystite(state, 0, i);
            crystite[i] = visible ? state.Map.Plots[i].Crystite : 0;
        }
        try
        {
            await JS.InvokeVoidAsync("PoMule.setPlots",
                state.Map.Plots.Select(p => (int)p.Terrain).ToArray(),
                state.Owner.Select(o => (int)o).ToArray(),
                state.Installed.Select(o => (int)o).ToArray(),
                crystite);
        }
        catch (JSException) { /* the page is going away */ }
        catch (JSDisconnectedException) { }
    }

    private async Task FinishAsync()
    {
        _finished = true;
        var state = _match!.State;
        _rows = PoMuleUi.Rows(state);
        var survived = PoMuleScoring.ColonySurvives(_rows.Sum(r => r.NetWorth), state.CrisisMonths);
        Say(survived ? "The colony survived and will prosper." : "The colony failed. The Federation is displeased.", survived ? "wampus" : "refuse", seconds: 60);
        StateHasChanged();

        if (_demo)
        {
            Kiosk.MarkFinished();
            // Outside the reel a demo keeps going: show the result, then play another.
            await Task.Delay(10000);
            if (!_disposed && _demo && _finished && !Kiosk.IsActive) await StartNewAsync();
            return;
        }

        await Saves.ClearAsync();
        var mine = _rows.First(r => r.Seat == 0);
        _outcome = mine.Rank == 1 ? GameResult.Win : GameResult.Loss;
        _endLine = (mine.Rank == 1 ? "You are First Founder" : $"You finished {Ordinal(mine.Rank)} of 8")
            + (survived ? ", and the colony survives." : ", but the colony collapsed.");
        _endStats =
        [
            new StatItem { Value = mine.NetWorth.ToString("N0"), Label = "Net Worth" },
            new StatItem { Value = $"{mine.Rank}/8", Label = "Place" },
            new StatItem { Value = mine.Plots.ToString(), Label = "Plots" },
            new StatItem { Value = survived ? "Survived" : "Collapsed", Label = "Colony" },
        ];
        StateHasChanged();

        try
        {
            // The seed and the action log let the server replay the match and keep its own Net
            // Worth. A match resumed from a save older than the log goes without (range-checked only).
            var recorded = state.Recorded;
            await GameResults.RecordAndSubmitPoMuleAsync(_playerName, _outcome,
                new PoMuleRunRequest(Math.Clamp(mine.NetWorth, 0, PoMiniGames.Domain.Models.PoMuleHighScore.MaxNetWorth), (int)state.Players[0].Species, survived,
                    recorded ? state.Seed : null, state.Classic, recorded ? _match.ActionLog : null));
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[PoMule] score submit failed: {ex.Message}");
        }
    }

    private static string Ordinal(int n) => n switch { 1 => "1st", 2 => "2nd", 3 => "3rd", _ => $"{n}th" };

    private async Task StopEngineAsync()
    {
        try { await JS.InvokeVoidAsync("PoMule.stop"); }
        catch (JSException) { }
        catch (JSDisconnectedException) { }
    }

    public async ValueTask DisposeAsync()
    {
        _disposed = true;
        // A match abandoned mid-month resumes from the last month start; nothing to save here.
        await StopEngineAsync();
        try { await JS.InvokeVoidAsync("PoMule.removeRadzen"); }
        catch (JSException) { }
        catch (JSDisconnectedException) { }
        _ref?.Dispose();
        GC.SuppressFinalize(this);
    }
}
