using System.Diagnostics;
using Microsoft.AspNetCore.SignalR;

namespace PoMiniGames.Features.PoBrawl.Online;

/// <summary>
/// Runs every live match's frame clock. Hosted as a singleton service so the fight survives the
/// hub connection that started it leaving. Each wake it catches every match's sim up to its
/// real-time clock, broadcasts a snapshot whenever a match crosses a snapshot frame (10 Hz), and
/// when a match finishes sends each corner its own result once, then leaves the match in the
/// registry for <see cref="PoBrawlMatchRegistry.FinishedLinger"/> (a late reconnect, the result
/// ingest) before sweeping it. While a corner is still awaited the clock is held, and the pump only
/// sends a once-a-second snapshot carrying the arrival countdown — or the abandon when it runs out.
/// </summary>
/// <remarks>
/// A Stopwatch catch-up loop, not a 16.7 ms PeriodicTimer: Windows timers tick at ~15.6 ms, so a
/// timer per frame would drift and bunch. Instead the loop wakes often, and the number of frames
/// to run comes from each match's Stopwatch clock (<see cref="PoBrawlMatchService.ClockFrame"/>) —
/// a late wake just runs two frames. Inputs are never late on the server's account: the frame
/// they land on is chosen against the frames actually simulated.
/// </remarks>
public sealed class PoBrawlMatchPump : BackgroundService
{
    private static readonly TimeSpan WakeInterval = TimeSpan.FromMilliseconds(4);

    private readonly PoBrawlMatchRegistry _registry;
    private readonly IHubContext<PoBrawlMatchHub> _hubContext;
    private readonly ILogger<PoBrawlMatchPump> _log;

    public PoBrawlMatchPump(
        PoBrawlMatchRegistry registry,
        IHubContext<PoBrawlMatchHub> hubContext,
        ILogger<PoBrawlMatchPump> log)
    {
        _registry = registry;
        _hubContext = hubContext;
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(WakeInterval);
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                var now = Stopwatch.GetTimestamp();
                foreach (var match in _registry.All)
                {
                    try
                    {
                        await PumpOnceAsync(match, now, stoppingToken);
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        _log.LogError(ex, "PoBrawl match pump failed for {Code}; continuing.", match.GameCode);
                    }
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Shutdown.
        }
    }

    private async Task PumpOnceAsync(PoBrawlMatchService match, long now, CancellationToken ct)
    {
        if (match.FinishedAtUtc is { } finishedAt)
        {
            if (DateTimeOffset.UtcNow - finishedAt > PoBrawlMatchRegistry.FinishedLinger) _registry.Remove(match);
            return;
        }
        var before = match.Frame;
        var waiting = match.IsWaiting;
        var ran = match.AdvanceToClock(now);
        var finished = match.FinishedAtUtc is not null;
        if (waiting && !finished)
        {
            // Held clock: one snapshot per whole second waited, so the corner that is here sees the
            // other's arrival countdown tick.
            var second = (long)(Stopwatch.GetElapsedTime(match.CreatedAt, now).TotalSeconds);
            if (match.TryMarkWaitingNotice(second))
            {
                await _hubContext.Clients.Group(PoBrawlMatchHub.MatchGroup(match.GameCode)).SendAsync("matchState", match.Snapshot(), ct);
            }
            return;
        }
        if (ran == 0 && !finished) return;
        var crossed = before / PoBrawlMatchService.SnapshotEveryFrames != (before + ran) / PoBrawlMatchService.SnapshotEveryFrames;
        if (!crossed && !finished) return;
        var snap = match.Snapshot();
        await _hubContext.Clients.Group(PoBrawlMatchHub.MatchGroup(match.GameCode)).SendAsync("matchState", snap, ct);
        if (finished)
        {
            _log.LogInformation("PoBrawl match {Code} finished: {Event}, winner {Winner}", match.GameCode, snap.LastEvent, snap.Winner);
            await BroadcastFinalResultsAsync(match, ct);
        }
    }

    /// <summary>
    /// Send each seated match-hub connection its own result (each client sees its own side as
    /// "local"). NOT the lobby roster's connection ids: those belong to the lobby hub and this
    /// context cannot address them (a result sent there would go nowhere). A corner that
    /// was away at the bell gets its copy from JoinMatch when it comes back.
    /// </summary>
    private async Task BroadcastFinalResultsAsync(PoBrawlMatchService match, CancellationToken ct)
    {
        foreach (var connectionId in match.ConnectionIds)
        {
            var result = match.BuildResultFor(connectionId);
            await _hubContext.Clients.Client(connectionId)
                .SendAsync("matchFinished", result, ct);
        }
    }
}
