namespace PoMiniGamesClient.Services.Http;

/// <summary>Reading a failed hub call: did the server refuse it, and in what words?</summary>
public static class HubErrors
{
    private const string Marker = "HubException: ";

    /// <summary>
    /// The server's own sentence when the hub method threw a <c>HubException</c>, or null for any
    /// other failure (a dropped socket, a timeout). The SignalR client wraps the server's message
    /// ("An unexpected error occurred invoking 'Join' on the server. HubException: …"), so the
    /// part after the last marker is the server's text.
    /// </summary>
    public static string? Reason(Exception ex)
    {
        var i = ex.Message.LastIndexOf(Marker, StringComparison.Ordinal);
        return i >= 0 ? ex.Message[(i + Marker.Length)..] : null;
    }
}
