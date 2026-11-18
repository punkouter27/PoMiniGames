namespace PoMiniGamesClient.Services.Play;

/// <summary>
/// The one "the other player never showed" rule every online game shares. After the lobby's
/// Start, both clients claim their seats in the match by its internal code; when one of them
/// closed the tab in between, the other would wait forever. <see cref="WatchAsync"/> waits
/// <see cref="Timeout"/> and, if the match still has not begun, runs the page's way back to the
/// lobby (the server drops the stale reservation on its own).
/// </summary>
public static class MatchJoinGuard
{
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(20);

    /// <param name="stillWaiting">True while the match has not started (read after the wait).</param>
    /// <param name="onTimeout">What the page does instead: a toast and back to the lobby, say.</param>
    /// <param name="cancellationToken">Cancelled when the page goes away.</param>
    public static async Task WatchAsync(Func<bool> stillWaiting, Func<Task> onTimeout, CancellationToken cancellationToken = default)
    {
        try { await Task.Delay(Timeout, cancellationToken); }
        catch (OperationCanceledException) { return; }
        if (!cancellationToken.IsCancellationRequested && stillWaiting()) await onTimeout();
    }
}
