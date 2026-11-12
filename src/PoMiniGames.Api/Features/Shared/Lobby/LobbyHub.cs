using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.Shared.Lobby;

/// <summary>
/// Hub surface shared by every ready/start lobby: <c>Join</c>, <c>ToggleReady</c>,
/// <c>LeaveLobby</c>, <c>StartGame</c>, and the <c>lobbyState</c> / <c>lobbyEvent</c> /
/// <c>gameStarted</c> broadcasts the client's <c>LobbyClient</c> listens for. A game's hub
/// supplies how a seat is opened (its player record) and what happens the instant the
/// host starts — creating the race or session NOW, with the roster captured, rather than
/// on the clients' eventual join to the game hub, which a WebSocket reconnect could
/// otherwise race.
/// </summary>
public abstract class LobbyHub<TPlayer, TRoom> : Hub
    where TPlayer : class, ILobbyPlayer
    where TRoom : LobbyRoom<TPlayer>
{
    private readonly string _group;

    protected LobbyHub(TRoom lobby, string group, ILogger log)
    {
        Lobby = lobby;
        Log = log;
        _group = group;
    }

    protected TRoom Lobby { get; }
    protected ILogger Log { get; }

    /// <summary>Open the caller's seat. The game decides what its record carries (identity, fighter, seat number…).</summary>
    protected abstract (LobbyState<TPlayer> state, string message) OpenSeat(string displayName, bool isGuest);

    /// <summary>
    /// Runs after the host's start is accepted and before <c>gameStarted</c> is sent, with the
    /// roster the start gate passed. If it throws, the room is reset (<c>End</c>) so a failed
    /// start can never leave the lobby wedged on its started flag.
    /// </summary>
    protected abstract Task OnStartingAsync(IReadOnlyList<TPlayer> roster);

    /// <summary>Tells the room the game is on. Default: the whole lobby group, with the room's code.</summary>
    protected virtual Task SendGameStartedAsync(IReadOnlyList<TPlayer> roster) =>
        Clients.Group(_group).SendAsync("gameStarted", Lobby.GameCode);

    /// <summary>Toast text for the "starting" event, e.g. "Race starting…".</summary>
    protected abstract string StartingMessage { get; }

    /// <summary>Extra teardown on disconnect (drop race input, unbind a lockstep session).</summary>
    protected virtual Task OnDisconnectedCoreAsync() => Task.CompletedTask;

    public override async Task OnConnectedAsync()
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, _group);
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        await LeaveAndBroadcastAsync();
        await OnDisconnectedCoreAsync();
        await base.OnDisconnectedAsync(exception);
    }

    /// <summary>Join the global room. First arrival becomes host.</summary>
    public async Task<LobbyState<TPlayer>> Join(string displayName, bool isGuest)
    {
        var (state, msg) = OpenSeat(displayName, isGuest);
        Log.LogInformation("{Hub}: conn={Conn} joined as {Name}; players={Count}/{Max} host={Host}",
            GetType().Name, Context.ConnectionId, displayName, state.Players.Count, state.MaxPlayers, state.HostConnectionId);
        await BroadcastStateAsync();
        await BroadcastEventAsync("joined", msg);
        return state;
    }

    public async Task ToggleReady()
    {
        // The room flips under its own lock and reports the value it stored — announcing a
        // pre-toggle snapshot read outside the lock inverted every ready/not-ready toast.
        var (ok, _, msg) = Lobby.ToggleReady(Context.ConnectionId);
        if (!ok) return;
        await BroadcastStateAsync();
        await BroadcastEventAsync("ready", msg);
    }

    public Task LeaveLobby() => LeaveAndBroadcastAsync();

    public async Task StartGame()
    {
        // The roster is captured under the room lock in the same step that sets the started flag:
        // a seat leaving between the gate and the game's own read can no longer hand it a short one.
        var roster = Lobby.TryStartWithRoster(Context.ConnectionId);
        if (roster is null) return;
        try
        {
            await OnStartingAsync(roster);
        }
        catch
        {
            Lobby.End();
            await BroadcastStateAsync();
            throw;
        }
        await BroadcastEventAsync("starting", StartingMessage);
        await SendGameStartedAsync(roster);
    }

    protected Task BroadcastStateAsync() => Clients.Group(_group).SendAsync("lobbyState", Lobby.State);

    protected Task BroadcastEventAsync(string kind, string message) =>
        Clients.Group(_group).SendAsync("lobbyEvent", new LobbyEvent(kind, message, DateTimeOffset.UtcNow));

    /// <summary>Shared by the explicit Leave and the disconnect path so both stay identical.</summary>
    private async Task LeaveAndBroadcastAsync()
    {
        var (ok, msg) = Lobby.Leave(Context.ConnectionId);
        await BroadcastStateAsync();
        if (ok && !string.IsNullOrEmpty(msg))
        {
            await BroadcastEventAsync("left", msg);
        }
    }
}
