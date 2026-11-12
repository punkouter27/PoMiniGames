using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Features.Auth;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoBrawl.Online;

/// <summary>
/// Match hub for live PoBrawl 1v1 — the input relay of a rollback fight. Each connection joins its
/// match code's group and sends frame-stamped <see cref="PoBrawlMatchInput"/>s; the server stamps
/// each with the frame it actually applies it at and echoes it to the whole group at once as a
/// <c>matchInput</c> (<see cref="PoBrawlMatchInputEvent"/>). The pump adds 10 Hz <c>matchState</c>
/// snapshots (<see cref="PoBrawlMatchState"/>) and a single <see cref="PoBrawlMatchResult"/> per
/// corner on finish; <see cref="Ping"/> is the clients' clock sync.
/// </summary>
/// <remarks>
/// The group is keyed by the match CODE. A JoinMatch tells the whole group (so the corner that
/// arrived first learns the second is in and the countdown has started). Inputs are budgeted per
/// corner by the match itself (<see cref="PoBrawlMatchService.MaxInputsPerSecond"/>); a refused
/// one is simply not echoed.
/// </remarks>
public sealed class PoBrawlMatchHub : Hub
{
    private readonly PoBrawlMatchRegistry _registry;
    private readonly ILogger<PoBrawlMatchHub> _log;

    public PoBrawlMatchHub(PoBrawlMatchRegistry registry, ILogger<PoBrawlMatchHub> log)
    {
        _registry = registry;
        _log = log;
    }

    public static string MatchGroup(string code) => $"pobrawl-match-{code.ToUpperInvariant()}";

    /// <summary>
    /// A drop starts the corner's reconnect grace (see <see cref="PoBrawlMatchService.ReconnectGraceSeconds"/>);
    /// coming back — a SignalR auto-reconnect or a page refresh — is just another JoinMatch.
    /// </summary>
    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        await ReleaseAsync(_registry.MatchFor(Context.ConnectionId));
        _registry.UnbindConnection(Context.ConnectionId);
        await base.OnDisconnectedAsync(exception);
    }

    /// <summary>
    /// Join the fight on <paramref name="code"/>. A caller on the roster is pinned to their corner
    /// by claim identity (the lobby and match hubs allocate separate connection ids, so the lobby's
    /// id is no use here); anyone else spectates. Null when no fight is on that code. A seated
    /// caller arriving after the bell gets their result straight away.
    /// </summary>
    public async Task<PoBrawlMatchSnapshot?> JoinMatch(string code)
    {
        if (string.IsNullOrWhiteSpace(code)) return null;
        var match = _registry.Get(code.Trim());
        if (match is null) return null;

        var identity = RequestIdentity.Resolve(Context.User);
        // A reconnect on a live socket re-pins: drop the old binding first.
        await ReleaseAsync(_registry.MatchFor(Context.ConnectionId));
        var seated = match.RegisterConnectionByPrincipal(identity.UserId, Context.ConnectionId);
        _registry.BindConnection(Context.ConnectionId, match.GameCode);
        await Groups.AddToGroupAsync(Context.ConnectionId, MatchGroup(match.GameCode));
        _log.LogInformation("PoBrawl JoinMatch conn={Conn} code={Code} seated={Seated}", Context.ConnectionId, match.GameCode, seated);

        if (seated && match.FinishedAtUtc is not null)
        {
            await Clients.Caller.SendAsync("matchFinished", match.BuildResultFor(Context.ConnectionId));
        }
        else if (seated)
        {
            // While a corner is awaited the pump only ticks once a second; the arrival itself is
            // news (it starts the clock), so the group hears it now.
            await Clients.Group(MatchGroup(match.GameCode)).SendAsync("matchState", match.Snapshot());
        }
        return new PoBrawlMatchSnapshot
        {
            MatchId = match.MatchId,
            GameCode = match.GameCode,
            Player1 = new PoBrawlMatchPlayerInfo(match.Player1.DisplayName, match.Player1.Fighter.Id),
            Player2 = new PoBrawlMatchPlayerInfo(match.Player2.DisplayName, match.Player2.Fighter.Id),
            LocalSide = seated ? match.SideFor(Context.ConnectionId) : PoBrawlSide.Player1,
            IsSpectator = !seated,
        };
    }

    /// <summary>
    /// One input from the caller's corner. The match pins the side (a spectator's input is refused
    /// there) and picks the frame; the accepted input goes straight back out to the whole group.
    /// </summary>
    public async Task SubmitInput(PoBrawlMatchInput input)
    {
        var match = _registry.MatchFor(Context.ConnectionId);
        if (match?.SubmitInput(Context.ConnectionId, input) is not { } accepted) return;
        await Clients.Group(MatchGroup(match.GameCode)).SendAsync("matchInput", accepted);
    }

    /// <summary>Clock sync: where the caller's fight clock is. Null when the caller is in no fight.</summary>
    public PoBrawlMatchClock? Ping() => _registry.MatchFor(Context.ConnectionId)?.Clock();

    /// <summary>
    /// Explicit leave (client-initiated, not disconnect). Same as a drop: the corner's grace
    /// clock starts, and it forfeits if it does not come back.
    /// </summary>
    public async Task LeaveMatch()
    {
        await ReleaseAsync(_registry.MatchFor(Context.ConnectionId));
        var code = _registry.UnbindConnection(Context.ConnectionId);
        if (code is not null) await Groups.RemoveFromGroupAsync(Context.ConnectionId, MatchGroup(code));
    }

    /// <summary>Unpin this connection; if its corner is now empty, tell the match it let go of its keys.</summary>
    private async Task ReleaseAsync(PoBrawlMatchService? match)
    {
        if (match?.UnregisterConnection(Context.ConnectionId) is { } released)
        {
            await Clients.Group(MatchGroup(match.GameCode)).SendAsync("matchInput", released);
        }
    }
}
