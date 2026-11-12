using PoMiniGames.Features.Shared.TurnMatch;

namespace PoMiniGames.Features.ConnectFive;

/// <summary>
/// Online Connect Five. The whole slice is this hub plus the shared turn-match
/// service it is registered with (<c>ConnectFiveRules</c>); there are no HTTP
/// routes. See <see cref="TurnMatchHub{THub}"/> for the contract.
/// </summary>
public sealed class ConnectFiveHub : TurnMatchHub<ConnectFiveHub>
{
    public ConnectFiveHub(TurnMatchService<ConnectFiveHub> matches, ILogger<ConnectFiveHub> log)
        : base(matches, log)
    {
    }
}
