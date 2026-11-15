using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Http;

/// <summary>
/// Attaches the current play session to outbound score submissions.
/// </summary>
/// <remarks>
/// <para>
/// Placed between <c>TransientRetryHandler</c> and <c>AntiforgeryHandler</c> in the pipeline
/// (see Client/Program.cs, where the order is a documented contract). Inside the retry handler
/// so a replayed clone is re-stamped rather than going out bare — a retried submission that
/// dropped its session would read to the server as a submission with no session at all. Above
/// the antiforgery and credentials handlers because it neither makes a request of its own nor
/// cares about cookies; it only copies a string onto a header.
/// </para>
/// <para>
/// Deliberately not a per-call-site concern: six endpoints across five slices submit scores, and
/// every one of them would have to remember the header. A handler cannot forget.
/// </para>
/// </remarks>
public sealed class PlaySessionHandler : DelegatingHandler
{
    /// <summary>Must match <c>ScoreIntegrityGuard.SessionHeader</c> on the server.</summary>
    private const string SessionHeader = "X-Play-Session";

    /// <summary>The mint route itself. Stamping it would be circular and is meaningless.</summary>
    private const string MintPath = "/api/play/";

    private readonly PlaySessionStore _store;

    public PlaySessionHandler(PlaySessionStore store) => _store = store;

    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        if (ShouldStamp(request) && _store.Token is { Length: > 0 } token)
        {
            // Remove-then-add so a retried clone that already carries a header from the first
            // attempt does not end up with two values, which arrive server-side as a
            // comma-joined string and unprotect as garbage.
            request.Headers.Remove(SessionHeader);
            request.Headers.TryAddWithoutValidation(SessionHeader, token);
        }

        return base.SendAsync(request, cancellationToken);
    }

    private static bool ShouldStamp(HttpRequestMessage request)
    {
        // Reads never carry a session — there is nothing to verify about a GET, and stamping
        // every leaderboard poll would put the token in far more logs than necessary.
        if (request.Method == HttpMethod.Get || request.Method == HttpMethod.Head)
        {
            return false;
        }

        var path = request.RequestUri?.AbsolutePath;
        return path is not null
            && path.StartsWith("/api/", StringComparison.OrdinalIgnoreCase)
            && !path.StartsWith(MintPath, StringComparison.OrdinalIgnoreCase);
    }
}
