namespace PoMiniGames.Features.Shared.TurnMatch;

/// <summary>
/// Online Tic-Tac-Toe (6×6, four in a row). There is no slice of its own: this hub
/// plus the shared turn-match service it is registered with (<c>TicTacToeRules</c>)
/// is the whole server surface, and there are no HTTP routes. See
/// <see cref="TurnMatchHub{THub}"/> for the contract.
/// </summary>
public sealed class TicTacToeHub : TurnMatchHub<TicTacToeHub>
{
    public TicTacToeHub(TurnMatchService<TicTacToeHub> matches, ILogger<TicTacToeHub> log)
        : base(matches, log)
    {
    }
}
