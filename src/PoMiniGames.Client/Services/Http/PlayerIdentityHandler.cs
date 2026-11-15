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

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        // The id is read from (or first written to) localStorage at startup. A request a page
        // fires during its first render would otherwise leave without it and be refused (401) by
        // the endpoints that need a player, so wait for that read; it is a few milliseconds once.
        if (!_playerName.IsInitialized)
        {
            await _playerName.Initialized.WaitAsync(cancellationToken);
        }

        if (!string.IsNullOrEmpty(_playerName.PlayerId))
        {
            request.Headers.Remove("X-Player-Id");
            request.Headers.Add("X-Player-Id", _playerName.PlayerId);
        }

        request.Headers.Remove("X-Player-Initials");
        request.Headers.Add("X-Player-Initials", _playerName.Initials);

        return await base.SendAsync(request, cancellationToken);
    }
}
