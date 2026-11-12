using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Features.Auth;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>
/// SignalR hub for the PoCabinet multiplayer lobby, at <c>/pocabinet/lobby-hub</c>. There is
/// one lobby and no codes: <see cref="Join"/> seats the caller (the first arrival hosts), the
/// host picks the track and how many AI officials fill free seats, can <see cref="Kick"/> a seat
/// between races, and <see cref="TryStart"/> builds the grid and hands off to
/// <see cref="PoCabinetRaceHub"/> under a fresh race code. Every change is broadcast to the
/// lobby group as <c>LobbyState</c>; a freed seat's player gets <c>Kicked(reason)</c>, and a
/// rematch seat freed for not readying up in time is announced as <c>LobbyNotice(text)</c>.
///
/// <para>
/// Identity comes from the claims (<see cref="RequestIdentity"/>), never from the client: seats
/// are keyed by it and a signed-in player's claim name wins over whatever name they typed.
/// Hub endpoints require auth (<c>/negotiate</c> included), mapped in
/// <c>EndpointRouteExtensions</c>.
/// </para>
/// </summary>
public sealed class PoCabinetLobbyHub(PoCabinetLobbyService lobbies, PoCabinetRaceRegistry races, ILogger<PoCabinetLobbyHub> logger) : Hub
{
    /// <summary>
    /// Take a seat (the first arrival hosts, on <paramref name="trackId"/>). A caller who gets
    /// no seat — the race is running or all eight are taken — still joins the group and gets
    /// the view with a null <c>YourSeatId</c>, so their page can wait and retry on the next
    /// <c>LobbyState</c>.
    /// </summary>
    public async Task<PoCabinetLobbyView?> Join(string displayName, string? trackId, string? color)
    {
        var me = Caller(displayName);
        var seated = lobbies.Join(me.Id, me.Name, trackId, color, Context.ConnectionId) is not null;
        await Groups.AddToGroupAsync(Context.ConnectionId, PoCabinetRaceRegistry.LobbyGroup);
        if (seated) await BroadcastAsync();
        return lobbies.View(seated ? me.Id : null);
    }

    public Task<bool> ToggleReady() => MutateAsync(lobbies.ToggleReady);

    public Task<bool> SetTrack(string trackId) => MutateAsync(id => lobbies.SetTrack(id, trackId));

    public Task<bool> SetBots(int count) => MutateAsync(id => lobbies.SetBots(id, count));

    /// <summary>
    /// Host-only: start the race under the fresh code <see cref="PoCabinetLobbyService.Start"/>
    /// minted, and send everyone <c>RaceStarting(code, trackId)</c>. If the race cannot be
    /// created the lobby goes back to idle, so it is not stuck "in race" with no race.
    /// </summary>
    public async Task<bool> TryStart()
    {
        var me = Caller(null);
        var lobby = lobbies.Start(me.Id);
        if (lobby?.RaceCode is not { } code) return false;
        var trackId = lobby.TrackId;
        try
        {
            races.Create(code, trackId, lobbies.BuildGrid());
        }
        catch (Exception ex)
        {
            lobbies.AbortStart(code);
            await BroadcastAsync();
            logger.LogError(ex, "PoCabinet race {Code} could not be created", code);
            throw new HubException("The race could not be started. Try again.");
        }
        await BroadcastAsync();
        await Clients.Group(PoCabinetRaceRegistry.LobbyGroup).SendAsync("RaceStarting", code, trackId);
        return true;
    }

    /// <summary>
    /// Host-only, between races: free another player's seat. They are told with <c>Kicked</c>
    /// and leave the lobby group; everyone else gets the new <c>LobbyState</c>.
    /// </summary>
    public async Task<bool> Kick(string seatId)
    {
        var me = Caller(null);
        if (string.IsNullOrEmpty(seatId) || lobbies.Kick(me.Id, seatId) is not { } gone) return false;
        await races.AnnounceUnseatedAsync([gone], "The host removed you from the lobby.", notice: null);
        return true;
    }

    public async Task Leave()
    {
        var me = Caller(null);
        lobbies.Leave(me.Id);
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, PoCabinetRaceRegistry.LobbyGroup);
        await BroadcastAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        if (lobbies.DropConnection(Context.ConnectionId)) await BroadcastAsync();
        await base.OnDisconnectedAsync(exception);
    }

    private async Task<bool> MutateAsync(Func<string, bool> change)
    {
        var me = Caller(null);
        if (!change(me.Id)) return false;
        await BroadcastAsync();
        return true;
    }

    private Task BroadcastAsync()
    {
        var view = lobbies.View();
        return view is null
            ? Task.CompletedTask
            : Clients.Group(PoCabinetRaceRegistry.LobbyGroup).SendAsync("LobbyState", view);
    }

    private (string Id, string Name) Caller(string? requestedName)
    {
        var identity = RequestIdentity.Resolve(Context.User);
        if (string.IsNullOrEmpty(identity.UserId))
            throw new HubException("Sign in or continue as a guest to race.");
        var typed = SanitizeName(requestedName);
        var name = identity.IsAuthenticated && !string.IsNullOrWhiteSpace(identity.DisplayName)
            ? identity.DisplayName
            : typed ?? (string.IsNullOrWhiteSpace(identity.DisplayName) ? "Player" : identity.DisplayName);
        return (identity.UserId, name.Length > 24 ? name[..24] : name);
    }

    private static string? SanitizeName(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return null;
        var clean = new string(name.Where(ch => !char.IsControl(ch)).ToArray()).Trim();
        return clean.Length == 0 ? null : clean;
    }
}
