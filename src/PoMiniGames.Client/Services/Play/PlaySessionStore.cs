using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Play;

/// <summary>
/// Holds the play session the client is currently carrying, and nothing else.
/// </summary>
/// <remarks>
/// <para>
/// This exists as its own type purely to break a dependency cycle.
/// <see cref="PlaySessionHandler"/> sits inside the <see cref="HttpClient"/> pipeline and needs
/// to read the token; <see cref="PlaySessionService"/> needs an <see cref="HttpClient"/> to mint
/// one. Putting the state in a third object with no dependencies at all lets the handler depend
/// on the state instead of on the minter, so the graph stays acyclic and the HttpClient factory
/// can resolve the handler while it is still building the client.
/// </para>
/// <para>
/// Only one session is held, not one per game. A score is submitted from the page that produced
/// it, so the session for the game currently open is the only one that can be redeemed — and
/// keeping a map would mean handing the server a stale session from a game the player left, which
/// reads as a WrongGame rejection rather than as no session at all.
/// </para>
/// </remarks>
public sealed class PlaySessionStore
{
    /// <summary>Game key the current token was minted for, or null when there is no session.</summary>
    public string? GameKey { get; private set; }

    /// <summary>The opaque token, or null. Never inspected client-side — the server owns its meaning.</summary>
    public string? Token { get; private set; }

    /// <summary>When the server said this token stops being redeemable.</summary>
    public DateTimeOffset ExpiresAtUtc { get; private set; }

    /// <summary>True when a token is held and has not passed its stated expiry.</summary>
    public bool IsLive => !string.IsNullOrEmpty(Token) && DateTimeOffset.UtcNow < ExpiresAtUtc;

    public void Set(string gameKey, string token, DateTimeOffset expiresAtUtc)
    {
        GameKey = gameKey;
        Token = token;
        ExpiresAtUtc = expiresAtUtc;
    }

    /// <summary>
    /// Drops the session. Called when the player leaves every game route, so a submission fired
    /// from the home page (an offline replay, say) carries no session rather than a misleading one.
    /// </summary>
    public void Clear()
    {
        GameKey = null;
        Token = null;
        ExpiresAtUtc = default;
    }
}
