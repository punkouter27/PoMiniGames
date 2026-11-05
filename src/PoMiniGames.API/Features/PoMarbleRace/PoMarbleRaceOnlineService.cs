using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoMarbleRace;

/// <summary>
/// Quick-match queue, private race codes and pairing registry for online Marble Race.
/// Deliberately holds no race state: the host browser is the simulation (see
/// <c>PoMarbleRaceShared.cs</c>), so the server's whole job is to pair two connections, tell
/// each which role it has, and relay frames one way and steering the other. Process-local like
/// every other live registry in the host.
/// </summary>
/// <remarks>
/// A race seats exactly <see cref="MaxPlayers"/>: the host and one guest. Players meet by
/// quick-match (the first two to queue) or by a private code one creates and the other types
/// in. After a race either may ask for a rematch; the next race starts once both have.
/// </remarks>
public sealed class PoMarbleRaceOnlineService
{
    /// <summary>Pack slot the guest steers. Slot 0 is the host's red marble; slot 1 is recoloured white for the guest.</summary>
    public const int GuestMarbleIndex = 1;

    /// <summary>Seats per race. The relay is one-to-one (the host streams, one guest steers).</summary>
    public const int MaxPlayers = 2;

    // Unambiguous characters only: no I/O/0/1 to misread when a code is read out loud.
    private const string CodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    private const int CodeLength = 4;

    private readonly object _lock = new();
    private readonly List<Waiting> _queue = new();
    private readonly Dictionary<string, Waiting> _rooms = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, Race> _byConnection = new(StringComparer.Ordinal);

    public int WaitingCount { get { lock (_lock) return _queue.Count; } }

    /// <summary>
    /// Queue for a race. The first arrival becomes host (it runs the physics and its map
    /// choice is the course); the second completes the pair. Returns the pairing, or null
    /// while waiting or when the connection is already queued or seated.
    /// </summary>
    public Pairing? Enqueue(string connectionId, string principalId, string displayName, bool isGuest, int mapId)
    {
        lock (_lock)
        {
            if (IsBusy(connectionId)) return null;

            var arrival = new Waiting(connectionId, principalId, Features.Shared.PlayerNames.Sanitize(displayName), isGuest, mapId);
            if (_queue.Count == 0)
            {
                _queue.Add(arrival);
                return null;
            }

            var host = _queue[0];
            _queue.RemoveAt(0);
            return Seat(host, arrival, code: null);
        }
    }

    /// <summary>
    /// Open a private race. The caller hosts (its map is the course) and waits for a friend to
    /// join with the returned code. Null when the connection is already queued or seated.
    /// </summary>
    public string? CreateRoom(string connectionId, string principalId, string displayName, bool isGuest, int mapId)
    {
        lock (_lock)
        {
            if (IsBusy(connectionId)) return null;
            string code;
            do
            {
                code = string.Create(CodeLength, 0, static (span, _) =>
                {
                    for (var i = 0; i < span.Length; i++) span[i] = CodeAlphabet[Random.Shared.Next(CodeAlphabet.Length)];
                });
            }
            while (_rooms.ContainsKey(code) || _byConnection.Values.Any(r => r.Code == code));

            _rooms[code] = new Waiting(connectionId, principalId, Features.Shared.PlayerNames.Sanitize(displayName), isGuest, mapId);
            return code;
        }
    }

    /// <summary>
    /// Join a private race by its code. Returns the pairing, or why not: the code is unknown, it
    /// is the caller's own race, or that race already has its <see cref="MaxPlayers"/> players.
    /// </summary>
    public (Pairing? Pairing, string? Error) JoinRoom(string connectionId, string principalId, string displayName, bool isGuest, string? code)
    {
        lock (_lock)
        {
            var key = (code ?? "").Trim().ToUpperInvariant();
            if (_rooms.TryGetValue(key, out var host) && host.ConnectionId == connectionId)
            {
                return (null, "That's your own race code.");
            }
            if (IsBusy(connectionId)) return (null, "You're already in a race.");
            if (host is null)
            {
                var full = _byConnection.Values.Any(r => r.Code == key);
                return (null, full ? $"That race already has its {MaxPlayers} players." : "No race with that code.");
            }

            _rooms.Remove(key);
            var arrival = new Waiting(connectionId, principalId, Features.Shared.PlayerNames.Sanitize(displayName), isGuest, host.MapId);
            return (Seat(host, arrival, key), null);
        }
    }

    /// <summary>
    /// Record that this seat wants a rematch. Returns the handshake to send both seats, or null
    /// when the caller is not in a race. When it comes back Agreed, both wants are cleared.
    /// </summary>
    public RematchUpdate? RequestRematch(string connectionId)
    {
        lock (_lock)
        {
            if (!_byConnection.TryGetValue(connectionId, out var race)) return null;
            if (race.Host.ConnectionId == connectionId) race.HostWantsRematch = true;
            else race.GuestWantsRematch = true;

            var agreed = race.HostWantsRematch && race.GuestWantsRematch;
            var state = new MarbleRaceRematch(race.HostWantsRematch, race.GuestWantsRematch, agreed);
            if (agreed) race.HostWantsRematch = race.GuestWantsRematch = false;
            return new RematchUpdate(state, race.Host.ConnectionId, race.Guest.ConnectionId);
        }
    }

    /// <summary>Leave the quick-match queue and close any private race this connection opened.</summary>
    public void Dequeue(string connectionId)
    {
        lock (_lock)
        {
            _queue.RemoveAll(w => w.ConnectionId == connectionId);
            RemoveRoomsOf(connectionId);
        }
    }

    /// <summary>The other seat's connection id, or null when the caller is not in a race.</summary>
    public string? PeerOf(string connectionId)
    {
        lock (_lock)
        {
            if (!_byConnection.TryGetValue(connectionId, out var race)) return null;
            return race.Host.ConnectionId == connectionId ? race.Guest.ConnectionId : race.Host.ConnectionId;
        }
    }

    public MarbleRaceRole? RoleOf(string connectionId)
    {
        lock (_lock)
        {
            if (!_byConnection.TryGetValue(connectionId, out var race)) return null;
            return race.Host.ConnectionId == connectionId ? MarbleRaceRole.Host : MarbleRaceRole.Guest;
        }
    }

    /// <summary>
    /// Drop a connection from the queue, its private race code and its race. Returns the peer
    /// left behind, if any, so the hub can tell it. A race with one seat gone is over — there is
    /// no rejoin, because the host IS the simulation and a guest that comes back has no state to
    /// resume.
    /// </summary>
    public string? Remove(string connectionId)
    {
        lock (_lock)
        {
            _queue.RemoveAll(w => w.ConnectionId == connectionId);
            RemoveRoomsOf(connectionId);
            if (!_byConnection.Remove(connectionId, out var race)) return null;
            var peer = race.Host.ConnectionId == connectionId ? race.Guest.ConnectionId : race.Host.ConnectionId;
            _byConnection.Remove(peer);
            return peer;
        }
    }

    // Caller holds _lock.
    private bool IsBusy(string connectionId) =>
        _byConnection.ContainsKey(connectionId)
        || _queue.Any(w => w.ConnectionId == connectionId)
        || _rooms.Values.Any(w => w.ConnectionId == connectionId);

    // Caller holds _lock.
    private void RemoveRoomsOf(string connectionId)
    {
        foreach (var code in _rooms.Where(kv => kv.Value.ConnectionId == connectionId).Select(kv => kv.Key).ToList())
        {
            _rooms.Remove(code);
        }
    }

    // Caller holds _lock.
    private Pairing Seat(Waiting host, Waiting guest, string? code)
    {
        var race = new Race(Guid.NewGuid().ToString("N"), host, guest, Random.Shared.Next(1, int.MaxValue), code);
        _byConnection[host.ConnectionId] = race;
        _byConnection[guest.ConnectionId] = race;
        return race.Pairing();
    }

    public sealed record Pairing(string RaceId, string HostConnectionId, MarbleRaceStart HostStart, string GuestConnectionId, MarbleRaceStart GuestStart);

    public sealed record RematchUpdate(MarbleRaceRematch State, string HostConnectionId, string GuestConnectionId);

    private sealed record Waiting(string ConnectionId, string PrincipalId, string DisplayName, bool IsGuest, int MapId);

    private sealed class Race
    {
        public Race(string raceId, Waiting host, Waiting guest, int seed, string? code)
        {
            RaceId = raceId;
            Host = host;
            Guest = guest;
            Seed = seed;
            Code = code;
        }

        public string RaceId { get; }
        public Waiting Host { get; }
        public Waiting Guest { get; }
        public int Seed { get; }
        /// <summary>The private code it was joined by; null for a quick-match.</summary>
        public string? Code { get; }
        public bool HostWantsRematch { get; set; }
        public bool GuestWantsRematch { get; set; }

        public Pairing Pairing()
        {
            var host = new MarbleRaceSeat(Host.DisplayName, Host.IsGuest, MarbleRaceRole.Host, true);
            var guest = new MarbleRaceSeat(Guest.DisplayName, Guest.IsGuest, MarbleRaceRole.Guest, true);
            return new Pairing(
                RaceId,
                Host.ConnectionId,
                new MarbleRaceStart(RaceId, MarbleRaceRole.Host, Seed, Host.MapId, GuestMarbleIndex, host, guest),
                Guest.ConnectionId,
                new MarbleRaceStart(RaceId, MarbleRaceRole.Guest, Seed, Host.MapId, GuestMarbleIndex, host, guest));
        }
    }
}
