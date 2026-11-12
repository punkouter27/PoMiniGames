using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Features.Auth;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.Shared.TurnMatch;

/// <summary>
/// Hub surface shared by every two-seat turn game: quick-match queue, moves,
/// rematch and reconnect. State lives in <see cref="TurnMatchService{THub}"/>; this
/// class only resolves identity, relays rejected moves as <see cref="HubException"/>s
/// the client can toast, and fans results out to the per-match group. A game's hub
/// is an empty subclass so it gets its own route, its own service instance and its
/// own <see cref="IHubContext{THub}"/>.
/// </summary>
/// <remarks>
/// Client events: <c>matchStarted</c> (<see cref="TurnMatchStart"/>, sent to each seat
/// separately because it carries that seat's private token and side) and <c>state</c>
/// (<see cref="TurnMatchState"/>, sent to the match group).
/// </remarks>
public abstract class TurnMatchHub<THub> : Hub where THub : Hub
{
    private readonly TurnMatchService<THub> _matches;
    private readonly ILogger _log;

    protected TurnMatchHub(TurnMatchService<THub> matches, ILogger log)
    {
        _matches = matches;
        _log = log;
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        var state = _matches.Disconnected(Context.ConnectionId);
        if (state is not null)
        {
            await Clients.Group(_matches.GroupFor(state.MatchId)).SendAsync("state", state);
        }
        await base.OnDisconnectedAsync(exception);
    }

    /// <summary>
    /// Join the quick-match queue. Identity is server-canonical from the auth cookie;
    /// <paramref name="displayName"/> is only the fallback for a guest with no name claim.
    /// </summary>
    public async Task<TurnMatchQueueStatus> FindMatch(string displayName, bool isGuest)
    {
        var identity = RequestIdentity.Resolve(Context.User);
        var name = !string.IsNullOrWhiteSpace(identity.DisplayName) ? identity.DisplayName : displayName;
        var pairing = _matches.Enqueue(Context.ConnectionId, identity.UserId, name, identity.IsGuest || isGuest);
        if (pairing is null)
        {
            return new TurnMatchQueueStatus(Matched: false, Waiting: _matches.WaitingCount);
        }

        await AnnounceStartAsync(pairing);
        return new TurnMatchQueueStatus(Matched: true, Waiting: 0);
    }

    public Task CancelSearch()
    {
        _matches.Dequeue(Context.ConnectionId);
        return Task.CompletedTask;
    }

    /// <summary>
    /// Place a mark. A rejected move surfaces as a <see cref="HubException"/> with the
    /// reason. The new board is not returned — it reaches the caller through the same
    /// <c>state</c> broadcast as the opponent, so the client has one apply path.
    /// </summary>
    public async Task Place(int row, int col)
    {
        TurnMatchState state;
        try
        {
            state = _matches.Place(Context.ConnectionId, row, col);
        }
        catch (InvalidOperationException ex)
        {
            throw new HubException(ex.Message);
        }
        await Clients.Group(_matches.GroupFor(state.MatchId)).SendAsync("state", state);
    }

    public async Task RequestRematch()
    {
        (TurnMatchState state, TurnMatchService<THub>.Pairing? rematch) result;
        try
        {
            result = _matches.RequestRematch(Context.ConnectionId);
        }
        catch (InvalidOperationException ex)
        {
            throw new HubException(ex.Message);
        }

        if (result.rematch is { } pairing)
        {
            await AnnounceStartAsync(pairing);
            return;
        }
        await Clients.Group(_matches.GroupFor(result.state.MatchId)).SendAsync("state", result.state);
    }

    /// <summary>
    /// Re-bind this connection to the seat behind <paramref name="seatToken"/> after a
    /// reconnect. Null means the seat is gone and the client should queue again.
    /// </summary>
    public async Task<TurnMatchRejoinResult?> Rejoin(string seatToken)
    {
        var result = _matches.Rejoin(Context.ConnectionId, seatToken);
        if (result is null) return null;
        var group = _matches.GroupFor(result.State.MatchId);
        await Groups.AddToGroupAsync(Context.ConnectionId, group);
        await Clients.Group(group).SendAsync("state", result.State);
        return result;
    }

    public async Task Leave()
    {
        var state = _matches.Leave(Context.ConnectionId);
        if (state is null) return;
        var group = _matches.GroupFor(state.MatchId);
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, group);
        await Clients.Group(group).SendAsync("state", state);
    }

    /// <summary>
    /// Announce a (re)start: each seat gets its own private start record, then the
    /// shared board goes to the group. Group membership is (re)asserted here because
    /// the first pairing is the first time either connection has a match to belong to.
    /// </summary>
    private async Task AnnounceStartAsync(TurnMatchService<THub>.Pairing pairing)
    {
        var group = _matches.GroupFor(pairing.MatchId);
        foreach (var (connectionId, start) in pairing.Connections)
        {
            await Groups.AddToGroupAsync(connectionId, group);
            await Clients.Client(connectionId).SendAsync("matchStarted", start);
        }
        await Clients.Group(group).SendAsync("state", pairing.State);
        _log.LogInformation("{Hub}: match {MatchId} game {Game} started", typeof(THub).Name, pairing.MatchId, pairing.State.GameNumber);
    }
}
