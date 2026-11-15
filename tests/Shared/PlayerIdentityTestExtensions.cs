namespace PoMiniGames.TestUtilities;

/// <summary>
/// Identifies a test <see cref="HttpClient"/> the way the browser does: there is no sign-in,
/// only the <c>X-Player-Id</c> and <c>X-Player-Initials</c> headers the server turns into the
/// caller's identity (<c>UsePlayerIdentity</c>).
/// </summary>
public static class PlayerIdentityTestExtensions
{
    /// <summary>
    /// Sets (or replaces) the player id and initials on every request <paramref name="client"/>
    /// sends. Call before <c>ArmAntiforgeryAsync</c>: the token is bound to the identity.
    /// </summary>
    public static HttpClient AsPlayer(this HttpClient client, string playerId, string initials = "TST")
    {
        client.DefaultRequestHeaders.Remove("X-Player-Id");
        client.DefaultRequestHeaders.Remove("X-Player-Initials");
        client.DefaultRequestHeaders.Add("X-Player-Id", playerId);
        client.DefaultRequestHeaders.Add("X-Player-Initials", initials);
        return client;
    }

    /// <summary>A fresh, unique player id with the given prefix (ids allow letters, digits, '-' and '_').</summary>
    public static string NewPlayerId(string prefix) => $"{prefix}-{Guid.NewGuid():N}"[..Math.Min(64, prefix.Length + 33)];
}
