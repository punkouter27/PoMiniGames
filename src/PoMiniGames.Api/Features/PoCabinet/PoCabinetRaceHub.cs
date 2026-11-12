using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Features.Auth;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>
/// SignalR hub for a running PoCabinet race, at <c>/pocabinet/race-hub</c>. After the lobby
/// hands off, each client calls <see cref="JoinRace"/> (seated players get their car id,
/// anyone else spectates), streams one numbered <see cref="PoCabinetInput"/> per 30 Hz tick
/// through <see cref="SubmitInput"/>, and receives <c>RaceSnapshot</c> every tick plus one
/// <c>RaceFinished</c> (or <c>RaceAborted(code)</c> when the server called the race off).
/// <see cref="LeaveRace"/> forfeits the car and leaves the group.
/// <see cref="PoCabinetRaceRegistry"/> runs the sim; this is a thin layer.
/// </summary>
public sealed class PoCabinetRaceHub(PoCabinetRaceRegistry registry) : Hub
{
    /// <summary>
    /// Join (or rejoin) the race <paramref name="gameCode"/>. Null when that race is over or
    /// never ran — a reconnect that missed the finish learns it here, without an error.
    /// </summary>
    public async Task<PoCabinetRaceSnapshot?> JoinRace(string gameCode)
    {
        var identity = RequestIdentity.Resolve(Context.User);
        if (string.IsNullOrEmpty(identity.UserId))
            throw new HubException("Sign in or continue as a guest to race.");
        if (string.IsNullOrEmpty(gameCode) || gameCode.Length > 32) return null;
        var snapshot = registry.Join(gameCode, Context.ConnectionId, identity.UserId);
        if (snapshot is null) return null;
        await Groups.AddToGroupAsync(Context.ConnectionId, PoCabinetRaceRegistry.RaceGroup(gameCode));
        return snapshot;
    }

    /// <summary>
    /// Leave the race on purpose: the caller's car (if they had one) is forfeited and coasts,
    /// and this connection stops receiving the race.
    /// </summary>
    public async Task LeaveRace()
    {
        if (registry.LeaveRace(Context.ConnectionId) is { } code)
            await Groups.RemoveFromGroupAsync(Context.ConnectionId, PoCabinetRaceRegistry.RaceGroup(code));
    }

    /// <summary>One tick of input. The connection's own binding (set by <see cref="JoinRace"/>)
    /// decides which car it drives, so it takes no game code.</summary>
    public Task SubmitInput(PoCabinetInput input)
    {
        registry.SubmitInput(Context.ConnectionId, input);
        return Task.CompletedTask;
    }

    /// <summary>
    /// Round-trip latency probe for the HUD's ping badge. Returns a value so the client's
    /// InvokeAsync genuinely waits for the reply. Takes no arguments — the client used to pass
    /// the game code, which SignalR rejected, so the badge never showed.
    /// </summary>
    public long Ping() => Environment.TickCount64;

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        registry.Leave(Context.ConnectionId);
        await base.OnDisconnectedAsync(exception);
    }
}
