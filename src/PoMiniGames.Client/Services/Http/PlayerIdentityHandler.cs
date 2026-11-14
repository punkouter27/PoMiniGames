using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using PoMiniGamesClient.Services.Play;

namespace PoMiniGamesClient.Services.Http;

/// <summary>
/// Stamps outgoing API requests with the player's persistent browser ID
/// (<c>X-Player-Id</c>) and 3-letter arcade initials (<c>X-Player-Initials</c>).
/// </summary>
public sealed class PlayerIdentityHandler : DelegatingHandler
{
    private readonly PlayerNameService _playerName;

    public PlayerIdentityHandler(PlayerNameService playerName)
    {
        _playerName = playerName;
    }

    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        if (!string.IsNullOrEmpty(_playerName.PlayerId))
        {
            request.Headers.Remove("X-Player-Id");
            request.Headers.Add("X-Player-Id", _playerName.PlayerId);
        }

        request.Headers.Remove("X-Player-Initials");
        request.Headers.Add("X-Player-Initials", _playerName.Initials);

        return base.SendAsync(request, cancellationToken);
    }
}
