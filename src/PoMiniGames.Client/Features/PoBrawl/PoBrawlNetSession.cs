using System.Diagnostics;
using Microsoft.AspNetCore.SignalR.Client;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Services.Http;

namespace PoMiniGamesClient.Features.PoBrawl;

/// <summary>
/// The client half of one online PoBrawl fight on the match hub: join (or re-join) the fight on a
/// code, send the local corner's frame-stamped inputs, keep the fight clock in sync, and surface
/// the confirmed inputs, the snapshots and the result. <see cref="PoBrawlPage"/> hosts it in online
/// mode and hands everything to the arena engine, whose rollback session
/// (wwwroot/js/pobrawl/rollbackSession.js) predicts the fight and re-simulates when the server disagrees.
/// </summary>
/// <remarks>
/// A reconnect — SignalR's automatic one, or a page refresh on <c>/pobrawl/online?code=…</c> —
/// is just <c>JoinMatch</c> again: the server re-pins the corner by claim identity and its
/// forfeit clock stops. A corner that stays away past the grace window forfeits.
/// </remarks>
public sealed class PoBrawlNetSession : IAsyncDisposable
{
    /// <summary>Ping cadence: quick samples while the clock estimate settles, then one a second.</summary>
    private static readonly TimeSpan FastPing = TimeSpan.FromMilliseconds(200);
    private static readonly TimeSpan SlowPing = TimeSpan.FromSeconds(1);
    private const int FastPings = 8;

    private readonly ApiEndpoints _endpoints;
    private readonly List<IDisposable> _subs = [];
    private readonly CancellationTokenSource _cts = new();
    private HubConnection? _hub;
    private Task? _pingLoop;

    public PoBrawlNetSession(ApiEndpoints endpoints) => _endpoints = endpoints;

    public string Code { get; private set; } = "";
    /// <summary>Who is fighting and which corner (if any) is ours. Replaced on every join.</summary>
    public PoBrawlMatchSnapshot? Snapshot { get; private set; }
    public PoBrawlMatchState? State { get; private set; }
    public HubConnectionState ConnectionState => _hub?.State ?? HubConnectionState.Disconnected;

    /// <summary>A (re-)join answered: a new snapshot, or null when no fight is on the code.</summary>
    public event Action<PoBrawlMatchSnapshot?>? Joined;
    public event Action<PoBrawlMatchState>? StateReceived;
    /// <summary>An input the server accepted (either corner's, ours included), with the frame it used.</summary>
    public event Action<PoBrawlMatchInputEvent>? InputReceived;
    /// <summary>A clock sample: the server's frame clock, and the round trip (ms) it took to learn it.</summary>
    public event Action<double, double>? ClockSampled;
    public event Action<PoBrawlMatchResult>? Finished;
    public event Action<HubConnectionState>? ConnectionChanged;

    public async Task<PoBrawlMatchSnapshot?> ConnectAsync(string code)
    {
        Code = code.Trim().ToUpperInvariant();
        _hub = HubConnectionFactory.Create(_endpoints.Hub("pobrawl/match-hub"));
        _subs.Add(_hub.On<PoBrawlMatchState>("matchState", s =>
        {
            // Snapshots of the fight we joined only.
            if (Snapshot is not null && s.MatchId != Snapshot.MatchId) return;
            State = s;
            StateReceived?.Invoke(s);
        }));
        _subs.Add(_hub.On<PoBrawlMatchInputEvent>("matchInput", e =>
        {
            if (Snapshot is not null && e.MatchId == Snapshot.MatchId) InputReceived?.Invoke(e);
        }));
        _subs.Add(_hub.On<PoBrawlMatchResult>("matchFinished", r =>
        {
            if (Snapshot is null || r.MatchId == Snapshot.MatchId) Finished?.Invoke(r);
        }));
        _hub.Reconnecting += _ => { ConnectionChanged?.Invoke(HubConnectionState.Reconnecting); return Task.CompletedTask; };
        _hub.Reconnected += async _ =>
        {
            ConnectionChanged?.Invoke(HubConnectionState.Connected);
            try { await JoinAsync(); } catch { /* the next reconnect or the forfeit clock settles it */ }
        };
        _hub.Closed += _ => { ConnectionChanged?.Invoke(HubConnectionState.Disconnected); return Task.CompletedTask; };
        await _hub.StartAsync();
        ConnectionChanged?.Invoke(_hub.State);
        var joined = await JoinAsync();
        _pingLoop ??= PingLoopAsync(_cts.Token);
        return joined;
    }

    /// <summary>Join (or re-join) the fight on <see cref="Code"/>.</summary>
    public async Task<PoBrawlMatchSnapshot?> JoinAsync()
    {
        if (_hub is null) return null;
        var snapshot = await _hub.InvokeAsync<PoBrawlMatchSnapshot?>("JoinMatch", Code);
        Snapshot = snapshot;
        Joined?.Invoke(snapshot);
        return snapshot;
    }

    /// <summary>
    /// One local input from the arena's rollback session: the frame it applied it at, the held state
    /// (PoBrawlMatchAction 0–3, corner-relative), an attack press (0 or 4–6) and its sequence number.
    /// Fire-and-forget: the server answers everyone with a <c>matchInput</c>.
    /// </summary>
    public async Task SendInputAsync(long frame, int held, int press, long sequence)
    {
        if (_hub is not { State: HubConnectionState.Connected } || Snapshot is not { IsSpectator: false }) return;
        try
        {
            await _hub.SendAsync("SubmitInput", new PoBrawlMatchInput
            {
                ActorSide = Snapshot.LocalSide,
                Frame = frame,
                Held = (PoBrawlMatchAction)held,
                Press = (PoBrawlMatchAction)press,
                Sequence = sequence,
            });
        }
        catch
        {
            // Dropped mid-fight: the reconnect re-joins, and the server let go of the held keys.
        }
    }

    /// <summary>Clock sync: ping the hub, time the round trip, report both.</summary>
    private async Task PingLoopAsync(CancellationToken ct)
    {
        var sent = 0;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(sent < FastPings ? FastPing : SlowPing, ct);
                if (_hub is not { State: HubConnectionState.Connected } hub || Snapshot is null) continue;
                var started = Stopwatch.GetTimestamp();
                var clock = await hub.InvokeAsync<PoBrawlMatchClock?>("Ping", ct);
                var rttMs = Stopwatch.GetElapsedTime(started).TotalMilliseconds;
                sent++;
                if (clock is not null && clock.MatchId == Snapshot?.MatchId) ClockSampled?.Invoke(clock.ClockFrame, rttMs);
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch
            {
                // A ping lost to a reconnect: the next one carries on.
            }
        }
    }

    /// <summary>
    /// The part of a hub failure a page can show. A HubException arrives wrapped — "An unexpected
    /// error occurred invoking 'Join' on the server. HubException: Lobby is full — …" —
    /// so the part after the last marker is the server's text. Any other failure (transport, a
    /// non-HubException) gets the fallback.
    /// </summary>
    internal static string HubMessage(Exception ex, string fallback)
    {
        const string marker = "HubException: ";
        var i = ex.Message.LastIndexOf(marker, StringComparison.Ordinal);
        return i >= 0 ? ex.Message[(i + marker.Length)..] : fallback;
    }

    public async ValueTask DisposeAsync()
    {
        await _cts.CancelAsync();
        if (_pingLoop is not null)
        {
            try { await _pingLoop; } catch { /* cancelled */ }
        }
        _cts.Dispose();
        var hub = _hub;
        _hub = null;
        foreach (var s in _subs) s.Dispose();
        _subs.Clear();
        if (hub is null) return;
        try { await hub.InvokeAsync("LeaveMatch"); } catch { /* already gone */ }
        try { await hub.DisposeAsync(); } catch { /* already gone */ }
    }
}
