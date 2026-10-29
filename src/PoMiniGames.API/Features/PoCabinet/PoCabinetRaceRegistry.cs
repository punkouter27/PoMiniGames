using PoMiniGames.Features.Integrity;
using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Infrastructure;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>
/// Owns the running PoCabinet multiplayer race on this host (keyed by the race code
/// <see cref="PoCabinetLobbyService.Start"/> mints: one lobby, so at most one race at a time),
/// ticked at 30 Hz by one shared timer, broadcasting a snapshot to the race group after every
/// tick. The same timer sweeps the lobby's not-ready seats once a second
/// (<see cref="PoCabinetLobbyService.SweepUnready"/>).
///
/// <para>
/// <b>Inputs are queued, one consumed per tick.</b> Each client runs its own car on a fixed
/// 30 Hz step and sends one numbered input per step; the server applies them in order and
/// echoes the last applied number as <see cref="PoCabinetCarState.AckSeq"/>. That is what
/// lets the client replay only the inputs the server has not seen yet. When the network
/// delivers nothing, the last input repeats for up to half a second (jitter); after that the
/// car coasts, so a hidden tab or a dropped player is not driven flat out into the wall. A burst
/// is trimmed to three queued inputs so a lag spike cannot turn into permanent input delay.
/// </para>
/// <para>
/// Seats bind to the caller's claim id (<see cref="Join"/>), so a reconnect resumes the same
/// car. Anyone else who joins the group spectates: they get snapshots and no car. A player who
/// leaves (<see cref="LeaveRace"/>) forfeits: the car coasts, their later joins spectate, and a
/// race every human has left is called. When a race ends the result is broadcast as
/// <c>RaceFinished</c>, its connections leave the race group, and the lobby reopens for a
/// rematch. A race whose tick keeps throwing is called off (<c>RaceAborted</c>).
/// </para>
/// </summary>
public sealed class PoCabinetRaceRegistry : IAsyncDisposable
{
    private const int TickHz = 30;
    private const double CountdownSeconds = 3;
    private const int MaxQueuedInputs = 3;
    /// <summary>No input for this many ticks (half a second) and the car coasts.</summary>
    private const int StaleInputTicks = TickHz / 2;
    /// <summary>Consecutive failed ticks before the race is called off.</summary>
    private const int MaxTickFailures = 3;
    private static readonly TimeSpan AbandonAfter = TimeSpan.FromSeconds(45);
    private static readonly TimeSpan VerifiedLapLifetime = TimeSpan.FromHours(1);

    private readonly ConcurrentDictionary<string, RaceSession> _races = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, VerifiedLap> _verifiedLaps = new(StringComparer.Ordinal);
    /// <summary>Store writes still in flight per player, so a removal never overtakes its write.</summary>
    private readonly ConcurrentDictionary<string, Task> _lapSaves = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Binding> _connections = new(StringComparer.Ordinal);
    private readonly IHubContext<PoCabinetRaceHub> _raceHub;
    private readonly IHubContext<PoCabinetLobbyHub> _lobbyHub;
    private readonly PoCabinetLobbyService _lobbies;
    private readonly ILogger<PoCabinetRaceRegistry> _logger;
    private readonly TimeProvider _time;
    private readonly ITimer _timer;
    private readonly VerifiedResultStore? _store;
    private const string StoreGame = "pocabinet";
    private int _ticking;
    private long _timerTicks;
    private bool _disposed;

    public PoCabinetRaceRegistry(
        IHubContext<PoCabinetRaceHub> raceHub,
        IHubContext<PoCabinetLobbyHub> lobbyHub,
        PoCabinetLobbyService lobbies,
        ILogger<PoCabinetRaceRegistry> logger,
        TimeProvider? time = null,
        VerifiedResultStore? store = null)
    {
        _raceHub = raceHub;
        _lobbyHub = lobbyHub;
        _lobbies = lobbies;
        _logger = logger;
        _store = store;
        _time = time ?? TimeProvider.System;
        var period = TimeSpan.FromSeconds(1.0 / TickHz);
        _timer = _time.CreateTimer(_ => TickAll(), null, period, period);
    }

    public static string RaceGroup(string code) => $"race:{code.ToUpperInvariant()}";

    public const string LobbyGroup = "lobby:" + PoCabinetLobbyService.RaceId;

    /// <summary>Start a race for <paramref name="code"/>, replacing any finished one.</summary>
    public void Create(string code, string trackId, IReadOnlyList<PoCabinetDriver> drivers)
    {
        var sim = new PoCabinetSim(trackId, seed: Random.Shared.Next(), drivers)
        {
            CountdownSeconds = CountdownSeconds,
        };
        var session = new RaceSession(code, sim, _time.GetUtcNow());
        foreach (var d in drivers.Where(d => d.IsPlayer)) session.Queues[d.OwnerId] = new Queue<PoCabinetInput>();
        _races[code] = session;
        _logger.LogInformation("PoCabinet race {Code} created with {Count} cars on {Track}", code, drivers.Count, trackId);
    }

    /// <summary>
    /// The best lap this host's own sim timed for <paramref name="playerId"/> in their last
    /// finished race — the proof behind a multiplayer leaderboard submit. Read without spending
    /// it: the submit spends it with <see cref="ForgetVerifiedLapAsync"/> only once the score is
    /// stored, so a failed save (a 503 the client parks and retries) still finds it.
    /// <see cref="VerifiedResultStore"/> carries it across a host recycle between the finish
    /// and the submit; with storage down the lap is in memory only, and a recycle then loses it.
    /// </summary>
    public async Task<VerifiedLap?> PeekVerifiedLapAsync(string playerId, CancellationToken ct = default)
    {
        if (!_verifiedLaps.TryGetValue(playerId, out var lap) && _store is not null)
        {
            lap = await _store.FindAsync<VerifiedLap>(StoreGame, playerId, VerifiedLapLifetime, take: false, ct);
        }
        return lap is not null && _time.GetUtcNow() - lap.At < VerifiedLapLifetime ? lap : null;
    }

    /// <summary>
    /// Spend <paramref name="lap"/> after its score was stored: from memory (unless a newer race
    /// already replaced it) and from the store, after any write of it still in flight.
    /// </summary>
    public async Task ForgetVerifiedLapAsync(string playerId, VerifiedLap lap)
    {
        _verifiedLaps.TryRemove(new KeyValuePair<string, VerifiedLap>(playerId, lap));
        if (_store is null) return;
        // SaveAsync never throws (it logs), so this wait only orders the delete after the write.
        if (_lapSaves.TryGetValue(playerId, out var pending)) await pending;
        await _store.RemoveAsync(StoreGame, playerId);
    }

    /// <summary>
    /// Bind a connection to a race and return the join snapshot: current state plus the static
    /// world and, for a seated player, their car id. Null when no such race is running (it is
    /// over, or never existed). A player who left the race with <see cref="LeaveRace"/> comes
    /// back as a spectator.
    /// </summary>
    public PoCabinetRaceSnapshot? Join(string code, string connectionId, string playerId)
    {
        if (!_races.TryGetValue(code, out var session)) return null;
        // One connection follows one race: a binding to an older race goes first.
        if (_connections.TryGetValue(connectionId, out var old) && !string.Equals(old.Code, session.Code, StringComparison.OrdinalIgnoreCase))
            Leave(connectionId);
        lock (session.Gate)
        {
            int? carId = session.Forfeited.Contains(playerId) ? null : session.Sim.CarIdForOwner(playerId);
            var seated = carId is null ? null : playerId;
            _connections[connectionId] = new Binding(session.Code, seated);
            session.Connections[connectionId] = seated;
            session.LastSeen = _time.GetUtcNow();
            var snap = BuildSnapshot(session, dialogue: null);
            snap.Static = PoCabinetTrackGeometry.BuildStaticWorld(session.Sim.TrackId);
            snap.LocalCarId = carId;
            return snap;
        }
    }

    /// <summary>A connection closed: unbind it. A car with no connection left coasts until its player rejoins.</summary>
    public void Leave(string connectionId) => Unbind(connectionId, forfeit: false);

    /// <summary>
    /// The player chose to leave the race: unbind the connection and forfeit the car (it coasts,
    /// and a later join spectates). Returns the race code, so the hub can drop the connection
    /// from the race group; null when the connection was in no race.
    /// </summary>
    public string? LeaveRace(string connectionId) => Unbind(connectionId, forfeit: true);

    private string? Unbind(string connectionId, bool forfeit)
    {
        if (!_connections.TryRemove(connectionId, out var binding)) return null;
        if (!_races.TryGetValue(binding.Code, out var session)) return binding.Code;
        lock (session.Gate)
        {
            session.Connections.Remove(connectionId);
            session.LastSeen = _time.GetUtcNow();
            if (binding.PlayerId is { } playerId)
            {
                if (forfeit) session.Forfeited.Add(playerId);
                // Nobody left at the wheel (or they walked away): stop applying their last input.
                if (forfeit || !session.Connections.ContainsValue(playerId))
                {
                    session.Applied.Remove(playerId);
                    if (session.Queues.TryGetValue(playerId, out var queue)) queue.Clear();
                }
            }
        }
        return binding.Code;
    }

    /// <summary>Queue one tick of input from a seated connection. Spectators, strangers and forfeited players are ignored.</summary>
    public void SubmitInput(string connectionId, PoCabinetInput input)
    {
        if (input is null) return;
        if (!_connections.TryGetValue(connectionId, out var binding) || binding.PlayerId is null) return;
        if (!_races.TryGetValue(binding.Code, out var session)) return;
        lock (session.Gate)
        {
            if (session.Forfeited.Contains(binding.PlayerId) || !session.Queues.TryGetValue(binding.PlayerId, out var queue)) return;
            queue.Enqueue(input);
            // A queue this deep is a burst after a stall — keep the newest few.
            while (queue.Count > MaxQueuedInputs * 2) queue.Dequeue();
            session.LastSeen = _time.GetUtcNow();
        }
    }

    private void TickAll()
    {
        if (_disposed || Interlocked.Exchange(ref _ticking, 1) == 1) return;
        try
        {
            foreach (var session in _races.Values)
            {
                try
                {
                    TickOne(session);
                    session.Failures = 0;
                }
                catch (Exception ex)
                {
                    session.Failures++;
                    _logger.LogError(ex, "PoCabinet tick for {Code} failed ({Failures} in a row)", session.Code, session.Failures);
                    if (session.Failures >= MaxTickFailures) SafeEnd(session, result: null, aborted: true);
                }
            }
            if (++_timerTicks % TickHz == 0) SweepLobby();
        }
        finally
        {
            Volatile.Write(ref _ticking, 0);
        }
    }

    private void TickOne(RaceSession session)
    {
        PoCabinetRaceSnapshot snapshot;
        PoCabinetFinalResult? result = null;
        bool abandoned;
        lock (session.Gate)
        {
            session.Ticks++;
            foreach (var (playerId, queue) in session.Queues)
            {
                while (queue.Count > MaxQueuedInputs) queue.Dequeue();
                if (queue.Count > 0)
                {
                    session.Applied[playerId] = queue.Dequeue();
                    session.LastInputTick[playerId] = session.Ticks;
                }
                else if (session.Ticks - session.LastInputTick.GetValueOrDefault(playerId) > StaleInputTicks)
                {
                    // Nothing for half a second: a hidden tab or a dropped player coasts.
                    session.Applied.Remove(playerId);
                }
            }
            session.Sim.Tick(1.0 / TickHz, session.Applied);
            snapshot = BuildSnapshot(session, session.Sim.TakeDialogue());
            abandoned = session.Connections.Count == 0 && _time.GetUtcNow() - session.LastSeen > AbandonAfter;
            // Every human has walked away: nobody is left to race for, so call it now.
            bool deserted = session.Queues.Count > 0 && session.Queues.Keys.All(session.Forfeited.Contains);
            if (session.Sim.IsFinished || deserted)
            {
                result = session.Sim.BuildResult(session.Code);
                StoreVerifiedLaps(session);
            }
        }

        _ = _raceHub.Clients.Group(RaceGroup(session.Code)).SendAsync("RaceSnapshot", snapshot);

        if (result is not null || abandoned) EndRace(session, result, aborted: false);
    }

    /// <summary>Record each human's best lap from the finished sim (memory now, the store in the background).</summary>
    private void StoreVerifiedLaps(RaceSession session)
    {
        var now = _time.GetUtcNow();
        foreach (var car in session.Sim.SnapshotCars())
        {
            if (!car.IsPlayer || car.BestLapSeconds <= 0) continue;
            var owner = car.OwnerId;
            var timed = new VerifiedLap(session.Sim.TrackId, car.BestLapSeconds, now, car.Position);
            _verifiedLaps[owner] = timed;
            if (_store is null) continue;
            // Not awaited: this is the 30 Hz tick, and the store logs its own failures. Tracked,
            // so a fast submit's removal waits for this write instead of racing it.
            var save = _store.SaveAsync(StoreGame, owner, timed);
            _lapSaves[owner] = save;
            _ = save.ContinueWith(t => _lapSaves.TryRemove(new KeyValuePair<string, Task>(owner, t)), TaskScheduler.Default);
        }
        foreach (var (id, lap) in _verifiedLaps)
        {
            if (now - lap.At >= VerifiedLapLifetime) _verifiedLaps.TryRemove(id, out _);
        }
    }

    private void SafeEnd(RaceSession session, PoCabinetFinalResult? result, bool aborted)
    {
        try
        {
            EndRace(session, result, aborted);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "PoCabinet race {Code} could not be ended cleanly", session.Code);
        }
    }

    /// <summary>
    /// Retire the race: unbind its connections, tell them how it ended (<c>RaceFinished</c>, or
    /// <c>RaceAborted</c> when it was called off), drop them from the race group, and reopen
    /// the lobby.
    /// </summary>
    private void EndRace(RaceSession session, PoCabinetFinalResult? result, bool aborted)
    {
        if (!_races.TryRemove(new KeyValuePair<string, RaceSession>(session.Code, session))) return;
        var members = new List<string>();
        foreach (var (connectionId, binding) in _connections)
        {
            if (string.Equals(binding.Code, session.Code, StringComparison.OrdinalIgnoreCase) && _connections.TryRemove(connectionId, out _))
                members.Add(connectionId);
        }
        if (result is not null) _logger.LogInformation("PoCabinet race {Code} finished", session.Code);
        else if (aborted) _logger.LogWarning("PoCabinet race {Code} called off after repeated tick failures", session.Code);
        else _logger.LogInformation("PoCabinet race {Code} abandoned", session.Code);
        _ = CloseGroupAsync(session.Code, members, result, aborted);

        _lobbies.MarkRaceFinished(session.Code);
        BroadcastLobby();
    }

    /// <summary>The last word to the race group, then empty it, so a results screen left open
    /// is not fed the next race.</summary>
    private async Task CloseGroupAsync(string code, List<string> members, PoCabinetFinalResult? result, bool aborted)
    {
        var groupName = RaceGroup(code);
        try
        {
            var group = _raceHub.Clients.Group(groupName);
            if (result is not null) await group.SendAsync("RaceFinished", result);
            else if (aborted) await group.SendAsync("RaceAborted", code);
            foreach (var connectionId in members) await _raceHub.Groups.RemoveFromGroupAsync(connectionId, groupName);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "PoCabinet race {Code}: closing the race group failed", code);
        }
    }

    /// <summary>Once a second: free rematch seats left not ready too long, and say so.</summary>
    private void SweepLobby()
    {
        try
        {
            var gone = _lobbies.SweepUnready();
            if (gone.Count == 0) return;
            _ = AnnounceUnseatedAsync(gone,
                $"Your seat was freed: you didn't ready up within {PoCabinetLobbyService.ReadyTimeout.TotalSeconds:0} seconds.",
                $"{string.Join(", ", gone.Select(g => g.DisplayName))} didn't ready up in time and gave up the seat.");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "PoCabinet lobby sweep failed");
        }
    }

    /// <summary>
    /// Tell unseated players (<c>Kicked</c>, with why) and drop their connections from the lobby
    /// group, then broadcast the new roster and, when given, a <c>LobbyNotice</c> to everyone left.
    /// </summary>
    public async Task AnnounceUnseatedAsync(IReadOnlyList<PoCabinetLobbyService.Unseated> gone, string reason, string? notice)
    {
        try
        {
            foreach (var player in gone)
            {
                if (player.ConnectionIds.Count == 0) continue;
                await _lobbyHub.Clients.Clients(player.ConnectionIds).SendAsync("Kicked", reason);
                foreach (var connectionId in player.ConnectionIds) await _lobbyHub.Groups.RemoveFromGroupAsync(connectionId, LobbyGroup);
            }
            BroadcastLobby();
            if (notice is not null) await _lobbyHub.Clients.Group(LobbyGroup).SendAsync("LobbyNotice", notice);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "PoCabinet: telling the lobby about a freed seat failed");
        }
    }

    private void BroadcastLobby()
    {
        var view = _lobbies.View();
        if (view is not null) _ = _lobbyHub.Clients.Group(LobbyGroup).SendAsync("LobbyState", view);
    }

    private static PoCabinetRaceSnapshot BuildSnapshot(RaceSession session, PoCabinetDialogueEvent? dialogue)
    {
        var sim = session.Sim;
        // Rounded on purpose: 30 Hz × 8 cars of full-precision doubles blew the 2 KB frame
        // budget in practice, and a hundredth of a unit is far below one pixel.
        var cars = sim.SnapshotCars().Select(c => new PoCabinetCarState
        {
            Id = c.Id,
            Name = c.Name,
            OfficialId = c.OfficialId,
            Color = c.Color,
            X = Math.Round(c.X, 2),
            Y = Math.Round(c.Y, 2),
            Heading = Math.Round(c.Heading, 4),
            SpeedKmh = Math.Round(c.Speed * PoCabinetPhysics.KmhPerUnit, 1),
            Lap = c.Lap,
            LapProgress = Math.Round(LapFraction(c.Distance, sim.Track.Length), 4),
            Position = c.Position,
            IsPlayer = c.IsPlayer,
            Finished = c.Finished,
            Damage = Math.Round(c.Damage, 3),
            Engine = Math.Round(c.Engine, 3),
            Pull = Math.Round(c.Pull, 3),
            Wrecked = c.Wrecked,
            LapInvalid = c.LapInvalid,
            AckSeq = c.AckSeq,
        }).ToList();

        return new PoCabinetRaceSnapshot
        {
            GameCode = session.Code,
            ServerTimeMs = (long)Math.Round((sim.ElapsedRaceTime + sim.CountdownSeconds) * 1000),
            ElapsedRaceTime = Math.Round(Math.Max(0, sim.ElapsedRaceTime), 3),
            Started = sim.Started,
            CountdownSeconds = sim.CountdownRemaining,
            Finished = sim.IsFinished,
            Cars = cars,
            LatestDialogue = dialogue,
        };
    }

    /// <summary>Fraction of the current lap in [0, 1); the grid (negative distance) reads as the end of a lap.</summary>
    private static double LapFraction(double distance, double length)
    {
        double f = distance / length % 1;
        return f < 0 ? f + 1 : f;
    }

    public ValueTask DisposeAsync()
    {
        if (_disposed) return ValueTask.CompletedTask;
        _disposed = true;
        _timer.Dispose();
        _races.Clear();
        _connections.Clear();
        return ValueTask.CompletedTask;
    }

    private sealed record Binding(string Code, string? PlayerId);

    /// <summary>A lap this host's sim timed, and where the driver finished (0 = not recorded: a
    /// lap stored by an older build).</summary>
    public sealed record VerifiedLap(string TrackId, double BestLapSeconds, DateTimeOffset At, int Position = 0);

    private sealed class RaceSession(string code, PoCabinetSim sim, DateTimeOffset createdAt)
    {
        public string Code { get; } = code;
        public PoCabinetSim Sim { get; } = sim;
        public object Gate { get; } = new();
        public Dictionary<string, Queue<PoCabinetInput>> Queues { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, PoCabinetInput> Applied { get; } = new(StringComparer.Ordinal);
        /// <summary>The tick each player's last input was applied on (stale-input coasting).</summary>
        public Dictionary<string, long> LastInputTick { get; } = new(StringComparer.Ordinal);
        /// <summary>Players who left the race on purpose: their cars coast and their joins spectate.</summary>
        public HashSet<string> Forfeited { get; } = new(StringComparer.Ordinal);
        /// <summary>Bound connections → the seated player id (null = spectator). Its count is what the abandon timer reads.</summary>
        public Dictionary<string, string?> Connections { get; } = new(StringComparer.Ordinal);
        public long Ticks { get; set; }
        /// <summary>Consecutive ticks that threw (timer thread only).</summary>
        public int Failures { get; set; }
        public DateTimeOffset LastSeen { get; set; } = createdAt;
    }
}
