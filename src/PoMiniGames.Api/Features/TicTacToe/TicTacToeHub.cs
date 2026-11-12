using PoMiniGames.Features.Shared.TurnMatch;

namespace PoMiniGames.Features.TicTacToe;

/// <summary>
/// Online Tic-Tac-Toe (6×6, four in a row). The whole slice is this hub plus the
/// shared turn-match service it is registered with (<c>TicTacToeRules</c>); there
/// are no HTTP routes. See <see cref="TurnMatchHub{THub}"/> for the contract.
/// </summary>
public sealed class TicTacToeHub : TurnMatchHub<TicTacToeHub>
{
    public TicTacToeHub(TurnMatchService<TicTacToeHub> matches, ILogger<TicTacToeHub> log)
        : base(matches, log)
    {
    }
}
