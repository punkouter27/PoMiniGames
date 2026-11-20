using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Features.Identity;
using PoMiniGames.Features.Shared.Lobby;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>
/// The PoCabinet lobby over the shared lobby hub, at <c>/pocabinet/lobby-hub</c>. Everything
/// ready/start is the shared surface (<c>Join</c>, <c>ToggleReady</c>, <c>StartGame</c>,
/// <c>LeaveLobby</c>, host-only <c>Kick(connectionId)</c>; <c>lobbyState</c> / <c>lobbyEvent</c> /
/// <c>gameStarted</c> / <c>kicked</c> broadcasts). What is Cabinet's own: the host's
/// <see cref="SetBots"/> (carried in the lobby state on every seat), the caller's
/// <see cref="SetColor"/>, and the start: the race is created under a fresh internal
/// code with the roster the start gate passed, and <c>gameStarted(code)</c> hands everyone to
/// <see cref="PoCabinetRaceHub"/>. The lobby reopens when the race ends
/// (<see cref="PoCabinetRaceRegistry"/>).
/// </summary>
public sealed class PoCabinetLobbyHub : LobbyHub<PoCabinetLobbyPlayer, PoCabinetLobbyService>
{
    private readonly PoCabinetRaceRegistry _races;

    public PoCabinetLobbyHub(PoCabinetLobbyService lobby, PoCabinetRaceRegistry races, ILogger<PoCabinetLobbyHub> log)
        : base(lobby, PoCabinetRaceRegistry.LobbyGroup, log)
    {
        _races = races;
    }

    protected override string StartingMessage => "Race starting...";

    protected override (LobbyState<PoCabinetLobbyPlayer> state, string message) OpenSeat(string displayName, bool isGuest)
    {
        var identity = RequestIdentity.Resolve(Context.User);
        if (string.IsNullOrEmpty(identity.UserId))
            throw new HubException("This connection carried no player id. Reload the page and try again.");
        var name = string.IsNullOrWhiteSpace(identity.DisplayName) ? displayName : identity.DisplayName;
        return Lobby.Open(Context.ConnectionId, name, isGuest, identity.UserId);
    }

    /// <summary>Host-only: how many AI drivers join the grid.</summary>
    public Task<bool> SetBots(int count) => MutateAsync(Lobby.SetBots(Context.ConnectionId, count));

    /// <summary>The caller's car paint (a paint-shop name or #rrggbb).</summary>
    public Task<bool> SetColor(string color) => MutateAsync(Lobby.SetColor(Context.ConnectionId, color));

    /// <summary>Creates the race now, from the roster the start gate passed, so the clients' later join cannot race it.</summary>
    protected override Task OnStartingAsync(IReadOnlyList<PoCabinetLobbyPlayer> roster)
    {
        var code = Lobby.BeginRace();
        try
        {
            _races.Create(code, Lobby.BuildGrid(roster));
        }
        catch (Exception ex)
        {
            Log.LogError(ex, "PoCabinet race {Code} could not be created", code);
            throw new HubException("The race could not be started. Try again.");
        }
        return Task.CompletedTask;
    }

    private async Task<bool> MutateAsync(bool changed)
    {
        if (!changed) return false;
        await BroadcastStateAsync();
        return true;
    }
}
