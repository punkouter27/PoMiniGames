using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.Shared.Lobby;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoBrawl.Online;

/// <summary>
/// The PoBrawl 1v1 room over the shared lobby hub, plus a fighter pick: the first two people
/// to open the lobby are the fight. On start the match is created NOW, under a fresh match
/// code, with the roster the start gate captured.
/// </summary>
/// <remarks>
/// There is one shared room (like PoRacer), not rooms-by-code. The lobby resets the moment a
/// fight starts, so the next two arrivals can pair up while the first pair is still fighting.
/// Everyone who opens the lobby watches its state, but only the two seated connections are told
/// the fight started (and its code): a visitor who was refused a seat must never be pulled into
/// two strangers' match.
/// </remarks>
public sealed class PoBrawlLobbyHub : LobbyHub<PoBrawlLobbyPlayer, PoBrawlLobbyService>
{
    private readonly PoBrawlMatchRegistry _matches;

    /// <summary>The code OnStartingAsync minted, for SendGameStartedAsync in the same StartGame call.</summary>
    private string? _startedCode;

    public PoBrawlLobbyHub(PoBrawlLobbyService lobby, PoBrawlMatchRegistry matches, ILogger<PoBrawlLobbyHub> log)
        : base(lobby, "pobrawl-lobby", log)
    {
        _matches = matches;
    }

    protected override string StartingMessage => "Fight starting…";

    /// <summary>
    /// Server-canonical identity from the claims; the typed name is only a fallback for a nameless
    /// guest. A full or starting room refuses loudly, so the page shows why instead of a lobby
    /// the caller is not in.
    /// </summary>
    protected override (LobbyState<PoBrawlLobbyPlayer> state, string message) OpenSeat(string displayName, bool isGuest)
    {
        var identity = RequestIdentity.Resolve(Context.User);
        var name = !string.IsNullOrWhiteSpace(identity.DisplayName) ? identity.DisplayName : displayName;
        var (state, msg) = Lobby.Open(Context.ConnectionId, identity.UserId, name, identity.IsGuest || isGuest, PoBrawlRoster.Bob,
            out var evicted);
        // The evicted connection learns it from the lobbyState broadcast that follows the join.
        foreach (var gone in evicted)
        {
            Log.LogInformation("PoBrawl lobby: {Name} was idle past {Ms} ms and gave up the seat", gone, PoBrawlLobbyService.IdleSeatMs);
        }
        if (!state.Players.Any(p => p.ConnectionId == Context.ConnectionId))
        {
            throw new HubException($"{msg} — a fight is being set up, try again in a moment.");
        }
        return (state, msg);
    }

    protected override Task OnStartingAsync(IReadOnlyList<PoBrawlLobbyPlayer> roster)
    {
        // The gate guarantees two seats; checked anyway, because a short roster here would throw
        // inside the match constructor (Roster[1]) — the base hub then resets the room.
        if (roster.Count != PoBrawlLobbyService.Cap)
        {
            throw new HubException("Both corners must be seated to start the fight.");
        }
        _startedCode = Lobby.CreateMatchCode();
        _matches.Start(_startedCode, roster);
        // Clear the started flag and every ready flag at once: the players' lobby connections
        // close as they navigate to the fight, and the room must take the next pair.
        Lobby.End();
        return Task.CompletedTask;
    }

    /// <summary>The two fighters only — never the lobby group, which holds every visitor.</summary>
    protected override Task SendGameStartedAsync(IReadOnlyList<PoBrawlLobbyPlayer> roster) =>
        _startedCode is null
            ? Task.CompletedTask
            : Clients.Clients(roster.Select(p => p.ConnectionId).ToList()).SendAsync("gameStarted", _startedCode);

    /// <summary>Pick a fighter: any rateable president, or Bob (the 1P/2P avatar).</summary>
    public async Task PickFighter(string fighterId)
    {
        var fighter = PoBrawlRoster.Find(fighterId)
            ?? throw new HubException($"'{fighterId}' is not a PoBrawl fighter.");

        var (ok, msg) = Lobby.PickFighter(Context.ConnectionId, fighter);
        await BroadcastStateAsync();
        if (ok) await BroadcastEventAsync("pick", msg);
    }
}
