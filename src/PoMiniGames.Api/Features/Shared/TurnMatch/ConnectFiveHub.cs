namespace PoMiniGames.Features.Shared.TurnMatch;

/// <summary>
/// Online Connect Five. There is no slice of its own: this hub plus the shared
/// turn-match service it is registered with (<c>ConnectFiveRules</c>) is the whole
/// server surface, and there are no HTTP routes. See
/// <see cref="TurnMatchHub{THub}"/> for the contract.
/// </summary>
public sealed class ConnectFiveHub : TurnMatchHub<ConnectFiveHub>
{
    public ConnectFiveHub(TurnMatchService<ConnectFiveHub> matches, ILogger<ConnectFiveHub> log)
        : base(matches, log)
    {
    }
}
