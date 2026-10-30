using System.Globalization;
using System.Text.Json;
using Blazored.LocalStorage;
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.JSInterop;
using PoMiniGames.Shared.Games.PoJevArena;
using PoMiniGamesClient.Components;
using PoMiniGamesClient.Models;
using PoMiniGamesClient.Services.Play;

namespace PoMiniGamesClient.Games.PoJevArena;

/// <summary>
/// The Jev Arena page: Dual Inspector layout (Blue column · centre · Red column), three phases —
/// Draft (library in the centre, the Factory as a drawer over it), Battle (the arena), Replay (the
/// arena + Black Box, or the Jev debrief). The engine (js/pojevarena) owns physics, rendering,
/// sound and the Black Box; this page owns the server conversation, rosters, squads, banners and
/// the per-side inspectors.
/// </summary>
public partial class PoJevArenaPage : ComponentBase, IAsyncDisposable
{
    private const string CanvasId = "jevArenaCanvas";
    private const string SquadsKey = "pojevarena.squads.v1";
    private const string AutoCameraKey = "pojevarena.autocam";
    private const int MaxSquads = 20;
    internal const string FilterAll = "all";
    /// <summary>How long the demo holds the draft screen before it deploys the match by itself.</summary>
    private const int DemoDraftSeconds = 30;

    private enum Phase { Intro, Draft, Battle, Replay }

    /// <summary>
    /// A legacy mode segment (<c>/pojevarena/1player</c>). The arena is demo-only now, so the
    /// segment changes nothing: every address runs the same self-playing demo.
    /// </summary>
    [Parameter] public string? ModeSegment { get; set; }

    [Inject] private IJSRuntime JS { get; set; } = default!;
    [Inject] private PoJevArenaApiClient Api { get; set; } = default!;
    [Inject] private ILocalStorageService Storage { get; set; } = default!;
    [Inject] private PlayerNameService PlayerNames { get; set; } = default!;

    private Phase _phase = Phase.Intro;
    private string _playerName = "";

    private ArenaStatus? _status;
    private List<ArenaCreature> _library = [];
    private bool _libraryOffline;
    private string _sort = "new";
    private string? _query;
    private string _filter = FilterAll;
    private List<ArenaSquad> _squads = [];

    private readonly ArenaCreature?[] _blue = new ArenaCreature?[PoJevArenaCatalog.TeamSize];
    private readonly ArenaCreature?[] _red = new ArenaCreature?[PoJevArenaCatalog.TeamSize];

    private bool _factoryOpen;
    private ArenaCreature? _editing;
    private ArenaCreature? _template;
    private ArenaCreature? _pendingDelete;

    private ArenaMatchTicket? _ticket;
    private bool _deploying, _pendingDeploy;
    private bool _deployRequested;
    private ArenaHudView? _hud;
    // The two bits of markup the 4 Hz HUD pump changes: the arena's glass strip and the brain chip.
    private HudRegion? _hudRegion;
    private HudRegion? _statusRegion;
    private ArenaInspectorView? _inspectBlue, _inspectRed;
    private ArenaMatchEndView? _result;
    private string? _resultNote;
    private ArenaBlackBoxView? _blackBox;
    private bool _showDebrief;
    private bool _autoCamera = true;
    private string _mobileTeam = "blue";
    private bool _statsOpen;
    private string? _error;
    private string? _toast;
    private DotNetObjectReference<PoJevArenaPage>? _self;
    private CancellationTokenSource? _demoLoop;

    private bool Drafting => _phase == Phase.Draft;
    private bool Configured => _status?.Configured == true;
    private bool ShowDebrief => _showDebrief && _phase == Phase.Replay && _result?.Debrief is not null;

    /// <summary>The one brain chip: the local brain is ready while drafting, this match's move count once it runs.</summary>
    private string StatusText => _status is null ? "Checking the arena…"
        : !_status.Configured ? "The arena is unavailable right now"
        : _hud is not null && !Drafting
            ? string.Create(CultureInfo.InvariantCulture, $"{_hud.Calls:N0} moves · local brain, free")
        : "Local brain ready · free";

    private string? Banner => _error ?? NoticeBanner ?? _toast;

    private string? NoticeBanner
    {
        get
        {
            var notices = _hud?.Notices ?? [];
            if (notices.Contains("match-expired")) return "This match expired on the server (the host restarted). Units hold their orders; redeploy for a fresh match.";
            return null;
        }
    }

    private bool RostersFull => _blue.All(c => c is not null) && _red.All(c => c is not null);

    private bool CanDeploy => Configured && RostersFull && !_deploying;

    private string DeployHint =>
        !Configured ? "The arena is unavailable."
        : !RostersFull ? "Fill both teams to deploy."
        : "Free: the local brain makes every call.";

    /// <summary>What stands between the player and Deploy, next to the button; null when nothing does.</summary>
    private string? DeployNote
    {
        get
        {
            if (!Configured) return null;
            var missing = _blue.Count(c => c is null) + _red.Count(c => c is null);
            return missing > 0 ? $"{missing} to draft" : null;
        }
    }

    /// <summary>Library plus the presets, pinned first, narrowed by the search and the filter.</summary>
    private List<ArenaCreature> VisibleLibrary =>
    [
        .. PoJevArenaCatalog.Presets
            .Where(p => string.IsNullOrWhiteSpace(_query) || p.Name.Contains(_query, StringComparison.OrdinalIgnoreCase))
            .Where(Matches),
        .. _library.Where(Matches),
    ];

    private bool Matches(ArenaCreature c) => _filter switch
    {
        FilterAll => true,
        "mine" => c.IsMine,
        _ when _filter.StartsWith("ability:", StringComparison.Ordinal) => c.Abilities.Contains(_filter[8..]),
        _ when _filter.StartsWith("temper:", StringComparison.Ordinal) => c.Temperament == _filter[7..],
        _ => true,
    };

    private string ResultHeadline => _result is null ? "" : _result.Winner switch
    {
        "blue" => "Blue wins",
        "red" => "Red wins",
        _ => "Draw",
    };

    private string ResultDetail => _result is null ? "" : string.Create(CultureInfo.InvariantCulture,
        $"{(_result.Reason == "time" ? "time" : "wipe")} at {Clock(_result.DurationSeconds)}{(_result.Arena is null ? "" : " on " + _result.Arena)} · {_result.Decisions:N0} decisions · {_resultNote}");

    /// <summary>"Red-04 Boulder Brute · 2 KOs · 312 dmg": the engine's MVP, named from the frozen roster.</summary>
    private string? MvpLine
    {
        get
        {
            if (_result is not { Mvp: >= 0 and < PoJevArenaCatalog.TeamSize * 2 } r || _ticket is null) return null;
            var blue = r.Mvp < PoJevArenaCatalog.TeamSize;
            var slot = r.Mvp % PoJevArenaCatalog.TeamSize;
            var creature = (blue ? _ticket.Blue : _ticket.Red).ElementAtOrDefault(slot);
            var stats = r.Units?.FirstOrDefault(u => u.Slot == r.Mvp);
            var line = $"MVP {ArenaUnits.Label(blue, slot)} {creature?.Name}";
            if (stats is null) return line;
            line += string.Create(CultureInfo.InvariantCulture, $" · {stats.Kills} KO{(stats.Kills == 1 ? "" : "s")} · {stats.Damage:0} dmg");
            return stats.Healed >= 1 ? line + string.Create(CultureInfo.InvariantCulture, $" · {stats.Healed:0} healed") : line;
        }
    }

    private IEnumerable<ArenaMoment> Moments => _result?.Debrief is { } d ? d.Blue.Moments.Concat(d.Red.Moments) : [];

    private string BlueSharePct
    {
        get
        {
            var (b, r) = (_hud?.BlueHp ?? 1, _hud?.RedHp ?? 1);
            return (b + r <= 0 ? 50 : 100 * b / (b + r)).ToString("0.0", CultureInfo.InvariantCulture);
        }
    }

    private string HpShareLabel => string.Create(CultureInfo.InvariantCulture,
        $"Health: Blue {100 * (_hud?.BlueHp ?? 1):0}%, Red {100 * (_hud?.RedHp ?? 1):0}%");

    // ── Lifecycle ────────────────────────────────────────────────────────────

    protected override async Task OnInitializedAsync()
    {
        _playerName = PlayerNames.GetPlayerName();
        _self = DotNetObjectReference.Create(this);
        await Task.WhenAll(LoadStatusAsync(), LoadLibraryAsync(), LoadPrefsAsync());
    }

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (!_pendingDeploy || _ticket is null) return;
        _pendingDeploy = false;
        try
        {
            if (!await JS.InvokeAsync<bool>("loadEngine", "pojevarena"))
            {
                _error = "The arena engine failed to load. Reload the page to try again.";
                StateHasChanged();
                return;
            }

            var ticketJson = JsonSerializer.Serialize(_ticket, PoJevArenaJsonContext.Default.ArenaMatchTicket);
            var abilitiesJson = JsonSerializer.Serialize(PoJevArenaCatalog.Abilities, PoJevArenaJsonContext.Default.ArenaAbilityArray);
            var options = $$"""{"autoCamera":{{(_autoCamera ? "true" : "false")}}}""";
            await JS.InvokeAsync<bool>("PoJevArena.deploy", CanvasId, _self, ticketJson, abilitiesJson, options);
        }
        catch (JSException ex)
        {
            _error = "The arena failed to start: " + ex.Message;
            StateHasChanged();
        }
    }

    public async ValueTask DisposeAsync()
    {
        _demoLoop?.Cancel();
        await StopEngineAsync();
        _self?.Dispose();
    }

    private async Task StartAsync()
    {
        _phase = Phase.Draft;
        await RunDemoAsync();
    }

    // ── Server state ─────────────────────────────────────────────────────────

    private async Task LoadStatusAsync() => _status = await Api.StatusAsync();

    private async Task LoadLibraryAsync()
    {
        // Null means the server could not reach storage (a 503), which is not the same as an empty library.
        var items = await Api.ListCreaturesAsync(_sort, _query);
        _libraryOffline = items is null;
        _library = [.. items ?? []];
    }

    private async Task OnSortAsync(string? sort)
    {
        _sort = sort is "used" or "rating" ? sort : "new";
        await LoadLibraryAsync();
    }

    private async Task OnQueryAsync(string? query)
    {
        _query = string.IsNullOrWhiteSpace(query) ? null : query.Trim();
        await LoadLibraryAsync();
    }

    // ── Drafting ─────────────────────────────────────────────────────────────

    private ArenaCreature?[] TeamOf(string team) => team == "blue" ? _blue : _red;

    private void DraftAsync((ArenaCreature Creature, string Team) pick)
    {
        if (!Drafting) return;
        var team = TeamOf(pick.Team);
        var free = Array.IndexOf(team, null);
        if (free < 0) { _toast = $"{(pick.Team == "blue" ? "Blue" : "Red")} is full. Click a slot to free it."; return; }

        team[free] = pick.Creature;
        _toast = null;
    }

    private async Task OnSlotAsync(string team, int slot)
    {
        if (Drafting)
        {
            TeamOf(team)[slot] = null;
            return;
        }

        var index = (team == "blue" ? 0 : PoJevArenaCatalog.TeamSize) + slot;
        await SafeJsAsync("PoJevArena.select", index);
    }

    private void ClearTeam(string team) => Array.Clear(TeamOf(team));

    /// <summary>Fills a side's empty slots with random picks from the presets and the loaded library.</summary>
    private void FillAsync(string team)
    {
        var slots = TeamOf(team);
        ArenaCreature[] pool = [.. PoJevArenaCatalog.Presets, .. _library];
        for (var i = 0; i < slots.Length; i++) slots[i] ??= pool[Random.Shared.Next(pool.Length)];
    }

    private void CopyBlueAsync() => Array.Copy(_blue, _red, _red.Length);

    // ── Squads (localStorage) ────────────────────────────────────────────────

    private async Task SaveSquadAsync(string team, string name)
    {
        name = name.Trim();
        if (name.Length == 0) return;
        _squads.RemoveAll(s => s.Name.Equals(name, StringComparison.OrdinalIgnoreCase));
        _squads.Insert(0, new ArenaSquad(name, [.. TeamOf(team)]));
        if (_squads.Count > MaxSquads) _squads.RemoveRange(MaxSquads, _squads.Count - MaxSquads);
        _toast = $"Saved squad \"{name}\".";
        await SaveSquadsAsync();
    }

    private void LoadSquadAsync(string team, string name)
    {
        if (_squads.Find(s => s.Name == name) is not { } squad) return;
        var fresh = FreshCreatures();
        var slots = TeamOf(team);
        for (var i = 0; i < slots.Length; i++)
        {
            var c = squad.Slots.ElementAtOrDefault(i);
            slots[i] = c is null ? null : fresh.GetValueOrDefault(c.Id) ?? c;
        }
    }

    private async Task DeleteSquadAsync(string name)
    {
        _squads.RemoveAll(s => s.Name == name);
        await SaveSquadsAsync();
    }

    private async Task SaveSquadsAsync()
    {
        try { await Storage.SetItemAsStringAsync(SquadsKey, JsonSerializer.Serialize(_squads, ArenaUiJsonContext.Default.ListArenaSquad)); }
        catch { /* storage blocked: squads just don't persist */ }
    }

    // ── Factory & library writes ─────────────────────────────────────────────

    private void NewCreature() { _editing = null; _template = null; _factoryOpen = true; }

    private void Edit(ArenaCreature creature) { _editing = creature; _template = null; _factoryOpen = true; }

    /// <summary>Any library card (or preset) opens the Factory pre-filled as a new creature of your own.</summary>
    private void Fork(ArenaCreature creature) { _editing = null; _template = creature; _factoryOpen = true; }

    private void CloseFactory() { _factoryOpen = false; _editing = null; _template = null; }

    private void OnDrawerKey(KeyboardEventArgs e)
    {
        if (e.Key == "Escape") CloseFactory();
    }

    private async Task OnCreatureSavedAsync(ArenaCreature saved)
    {
        CloseFactory();
        _toast = $"Saved {saved.Name} to the public library.";
        await LoadLibraryAsync();
    }

    private void AskDelete(ArenaCreature creature) => _pendingDelete = creature;

    private async Task ConfirmDeleteAsync()
    {
        if (_pendingDelete is not { } doomed) return;
        _pendingDelete = null;
        var error = await Api.DeleteAsync(doomed.Id);
        _toast = error is null ? $"Deleted {doomed.Name}." : "Couldn't delete that creature right now.";
        if (error is null)
        {
            for (var i = 0; i < PoJevArenaCatalog.TeamSize; i++)
            {
                if (_blue[i]?.Id == doomed.Id) _blue[i] = null;
                if (_red[i]?.Id == doomed.Id) _red[i] = null;
            }
            await LoadLibraryAsync();
        }
    }

    // ── Squads and prefs in localStorage ─────────────────────────────────────

    private Dictionary<string, ArenaCreature> FreshCreatures() =>
        PoJevArenaCatalog.Presets.Concat(_library).DistinctBy(c => c.Id).ToDictionary(c => c.Id);

    private async Task LoadPrefsAsync()
    {
        try
        {
            _autoCamera = await Storage.GetItemAsStringAsync(AutoCameraKey) != "0";
            var raw = await Storage.GetItemAsStringAsync(SquadsKey);
            if (!string.IsNullOrEmpty(raw)) _squads = JsonSerializer.Deserialize(raw, ArenaUiJsonContext.Default.ListArenaSquad) ?? [];
        }
        catch { /* storage blocked or a corrupt entry: defaults */ }
    }

    private async Task ToggleCameraAsync()
    {
        _autoCamera = !_autoCamera;
        await SafeJsAsync("PoJevArena.setAutoCamera", _autoCamera);
        try { await Storage.SetItemAsStringAsync(AutoCameraKey, _autoCamera ? "1" : "0"); }
        catch { /* not remembered, still applied */ }
    }

    // ── Battle ───────────────────────────────────────────────────────────────

    /// <summary>
    /// The visitor pressed Deploy on the draft screen. The demo owns the deploy, so the
    /// request is recorded and the demo's loop starts the match on its next tick.
    /// </summary>
    private void RequestDeploy() => _deployRequested = true;

    /// <returns>True when the match was registered and the arena is about to mount.</returns>
    private async Task<bool> DeployAsync()
    {
        _deploying = true;
        _error = null;
        _toast = null;
        var (ticket, error) = await Api.RegisterMatchAsync(new ArenaMatchRequest(
            ArenaMode.Demo,
            _blue.Select(c => c!.Id).ToArray(),
            _red.Select(c => c!.Id).ToArray()));
        _deploying = false;

        if (ticket is null)
        {
            _error = error switch
            {
                "unknown-creature" => "A creature in your roster no longer exists. Replace it and deploy again.",
                "library-offline" => "The creature library is unreachable right now.",
                _ => "Couldn't start the match. Try again in a moment.",
            };
            return false;
        }

        _ticket = ticket;
        _result = null;
        _resultNote = null;
        _hud = null;
        _blackBox = null;
        _inspectBlue = _inspectRed = null;
        _factoryOpen = false;
        _statsOpen = false;
        _phase = Phase.Battle;
        _pendingDeploy = true;
        return true;
    }

    private async Task StopEngineAsync() => await SafeJsAsync("PoJevArena.stop");

    private Task ShareClipAsync() => SafeJsAsync("PoJevArena.shareClip");

    // ── Engine callbacks ─────────────────────────────────────────────────────

    /// <summary>The engine's only road to the server, so every Jev batch rides the app HttpClient.</summary>
    [JSInvokable]
    public Task<string> DecideAsync(string batchJson) =>
        _ticket is null ? Task.FromResult("""{"error":"match-expired"}""") : Api.DecideRawAsync(_ticket.MatchId, batchJson);

    [JSInvokable]
    public Task OnHud(string json)
    {
        var hadHud = _hud is not null;
        var banner = NoticeBanner;
        _hud = JsonSerializer.Deserialize(json, ArenaUiJsonContext.Default.ArenaHudView);
        // The pump re-renders its two regions; the page only when the HUD appears or goes, or
        // a notice changes the banner.
        if (_hudRegion is null || _statusRegion is null || hadHud != (_hud is not null) || banner != NoticeBanner)
            return InvokeAsync(StateHasChanged);
        _hudRegion.Refresh();
        _statusRegion.Refresh();
        return Task.CompletedTask;
    }

    [JSInvokable]
    public Task OnInspector(string json)
    {
        var view = JsonSerializer.Deserialize(json, ArenaUiJsonContext.Default.ArenaInspectorView);
        if (view?.Team == "blue") _inspectBlue = view;
        else if (view?.Team == "red") _inspectRed = view;
        return InvokeAsync(StateHasChanged);
    }

    /// <summary>A unit was clicked in the arena: the phone layout's single inspector follows its side.</summary>
    [JSInvokable]
    public Task OnSelected(string team)
    {
        if (team is "blue" or "red") _mobileTeam = team;
        return InvokeAsync(StateHasChanged);
    }

    /// <summary>Tab held (true) or released (false) during the live match: the stat HUD over the arena.</summary>
    [JSInvokable]
    public Task OnStats(bool open)
    {
        _statsOpen = open;
        return InvokeAsync(StateHasChanged);
    }

    [JSInvokable]
    public Task OnBlackBox(string json)
    {
        _blackBox = JsonSerializer.Deserialize(json, ArenaUiJsonContext.Default.ArenaBlackBoxView);
        return InvokeAsync(StateHasChanged);
    }

    [JSInvokable]
    public async Task OnMatchEnded(string json)
    {
        _result = JsonSerializer.Deserialize(json, ArenaUiJsonContext.Default.ArenaMatchEndView);
        _phase = Phase.Replay;
        // The demo goes straight to its highlight replay: the debrief is a player's read-out.
        _showDebrief = false;
        _resultNote = "recording…";
        await InvokeAsync(StateHasChanged);

        if (_result is not null && _ticket is not null)
        {
            var error = await Api.ReportResultAsync(_ticket.MatchId,
                new ArenaMatchResult(_result.Winner, _result.DurationSeconds, _result.Units, _result.Mvp));
            _resultNote = error switch
            {
                null => "creature records updated",
                "too-few-decisions" => "too short to count toward records",
                "match-expired" => "stats not recorded (match expired)",
                _ => "stats not recorded",
            };
        }
        await LoadStatusAsync();
        await InvokeAsync(StateHasChanged);
    }

    private async Task OnBlackBoxCommandAsync((string Command, double Value) cmd)
    {
        switch (cmd.Command)
        {
            case "scrub": await SafeJsAsync("PoJevArena.scrub", (int)cmd.Value); break;
            case "step": await SafeJsAsync("PoJevArena.step", (int)cmd.Value); break;
            case "play": await SafeJsAsync("PoJevArena.play"); break;
            case "pause": await SafeJsAsync("PoJevArena.pause"); break;
            case "speed": await SafeJsAsync("PoJevArena.setSpeed", cmd.Value); break;
            case "prevDecision": await SafeJsAsync("PoJevArena.jumpDecision", -1); break;
            case "nextDecision": await SafeJsAsync("PoJevArena.jumpDecision", 1); break;
        }
    }

    /// <summary>Debrief "Jump": switch to the Black Box on that frame with that creature in its side's inspector.</summary>
    private async Task JumpToMomentAsync(ArenaMoment moment)
    {
        _showDebrief = false;
        _mobileTeam = moment.UnitIndex < PoJevArenaCatalog.TeamSize ? "blue" : "red";
        await SafeJsAsync("PoJevArena.jumpTo", moment.Frame, moment.UnitIndex);
    }

    // ── Demo ─────────────────────────────────────────────────────────────────

    /// <summary>
    /// Preset squads plus up to six random library creatures per side, fight, show the result,
    /// replay the last 20 s from the Black Box, repeat.
    /// </summary>
    private async Task RunDemoAsync()
    {
        _demoLoop?.Cancel();
        _demoLoop = new CancellationTokenSource();
        var ct = _demoLoop.Token;
        var rng = new Random();

        while (!ct.IsCancellationRequested)
        {
            await LoadStatusAsync();
            if (!Configured) { _error = "The arena is unavailable right now, so the demo can't run."; return; }

            FillDemoTeam(_blue, rng);
            FillDemoTeam(_red, rng);
            _deployRequested = false;
            await InvokeAsync(StateHasChanged);

            // The draft screen is the showcase: both squads are on show, and a visitor may
            // take the match and deploy it now. Left alone, the demo deploys by itself.
            var draftDeadline = DateTime.UtcNow.AddSeconds(DemoDraftSeconds);
            while (!ct.IsCancellationRequested && !_deployRequested && DateTime.UtcNow < draftDeadline)
                await Delay(250, ct);
            if (ct.IsCancellationRequested) return;

            if (!await DeployAsync()) return;
            await InvokeAsync(StateHasChanged);

            // Wait for the whistle (the engine calls OnMatchEnded), with a hard ceiling past 3:00.
            var deadline = DateTime.UtcNow.AddMinutes(4);
            while (_result is null && DateTime.UtcNow < deadline && !ct.IsCancellationRequested) await Delay(500, ct);
            if (ct.IsCancellationRequested) return;

            await Delay(8_000, ct);
            var frames = _blackBox?.Frames ?? 0;
            await SafeJsAsync("PoJevArena.scrub", Math.Max(0, frames - 20 * 60));
            await SafeJsAsync("PoJevArena.play");
            await Delay(20_000, ct);
            await StopEngineAsync();
        }
    }

    /// <summary>Up to six random library creatures, the rest random presets, in shuffled slots.</summary>
    private void FillDemoTeam(ArenaCreature?[] team, Random rng)
    {
        var picks = _library.OrderBy(_ => rng.Next()).Take(6).ToList();
        while (picks.Count < team.Length) picks.Add(PoJevArenaCatalog.Presets[rng.Next(PoJevArenaCatalog.Presets.Length)]);
        var shuffled = picks.OrderBy(_ => rng.Next()).ToArray();
        Array.Copy(shuffled, team, team.Length);
    }

    private static async Task Delay(int ms, CancellationToken ct)
    {
        try { await Task.Delay(ms, ct); }
        catch (OperationCanceledException) { }
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private async Task SafeJsAsync(string identifier, params object?[] args)
    {
        try { await JS.InvokeVoidAsync(identifier, args); }
        catch (JSException) { }
        catch (JSDisconnectedException) { }
        catch (InvalidOperationException) { /* prerender / disposed circuit */ }
    }

    /// <summary>Blazor renders a bool attribute as present-or-absent; aria-pressed needs the literal words.</summary>
    private static string Pressed(bool on) => on ? "true" : "false";

    private static string Clock(double seconds)
    {
        var t = TimeSpan.FromSeconds(Math.Max(0, seconds));
        return t.ToString(@"m\:ss", CultureInfo.InvariantCulture);
    }
}
