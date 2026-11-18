using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoMarbleRace;

/// <summary>
/// Pairing registry for online Marble Race. Deliberately holds no race state: the host browser is
/// the simulation (see <c>PoMarbleRaceShared.cs</c>), so the server's whole job is to pair two
/// connections, tell each which role it has, and relay frames one way and steering the other.
/// Process-local like every other live registry in the host.
/// </summary>
/// <remarks>
/// Players meet in the shared lobby (<see cref="PoMarbleRaceLobbyService"/>); when its host starts,
/// the lobby <see cref="Expect"/>s a match under an internal code that no player ever sees, and both
/// browsers then <see cref="JoinMatch"/> on the race hub by it. The lobby host is the race host.
/// A race seats exactly <see cref="MaxPlayers"/>. A race is one race: another one starts from the
/// lobby (owner rule: the end card has one action, "Back to main menu").
/// </remarks>
public sealed class PoMarbleRaceOnlineService
{
    /// <summary>Pack slot the guest steers. Slot 0 is the host's red marble; slot 1 is recoloured white for the guest.</summary>
    public const int GuestMarbleIndex = 1;

    /// <summary>Seats per race. The relay is one-to-one (the host streams, one guest steers).</summary>
    public const int MaxPlayers = 2;

    /// <summary>An expected match nobody turned up for is dropped after this long.</summary>
    private static readonly TimeSpan MatchLifetime = TimeSpan.FromMinutes(2);

    private readonly object _lock = new();
    private readonly Dictionary<string, Match> _matches = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Race> _byConnection = new(StringComparer.Ordinal);

    /// <summary>Who the lobby seated: the player id that will claim the seat, and the name shown for it.</summary>
    public sealed record MatchSeat(string UserId, string DisplayName, bool IsGuest);

    /// <summary>
    /// The lobby host started: register the match under its internal <paramref name="code"/>.
    /// The race runs <paramref name="mapId"/> (the host's pick).
    /// </summary>
    public void Expect(string code, MatchSeat host, MatchSeat guest, int mapId)
    {
        lock (_lock)
        {
            var now = DateTime.UtcNow;
            foreach (var stale in _matches.Where(kv => now - kv.Value.CreatedUtc > MatchLifetime).Select(kv => kv.Key).ToList())
            {
                _matches.Remove(stale);
            }
            _matches[code] = new Match(
                new Waiting(null, host.UserId, Features.Shared.PlayerNames.Sanitize(host.DisplayName), host.IsGuest, mapId),
                new Waiting(null, guest.UserId, Features.Shared.PlayerNames.Sanitize(guest.DisplayName), guest.IsGuest, mapId),
                now);
        }
    }

    /// <summary>
    /// Take the seat <paramref name="principalId"/> was given for <paramref name="code"/>. Returns
    /// whether the caller was seated, and the pairing once the second seat is taken. Refused for an
    /// unknown code, a player the lobby did not seat, or a connection already in a race.
    /// </summary>
    public (bool Seated, Pairing? Pairing) JoinMatch(string connectionId, string principalId, string? code)
    {
        lock (_lock)
        {
            if (_byConnection.ContainsKey(connectionId)) return (false, null);
            if (code is null || !_matches.TryGetValue(code, out var match)) return (false, null);

            // The host seat first: two tabs sharing one player id still fill one seat each.
            if (match.Host.ConnectionId is null && match.Host.PrincipalId == principalId)
            {
                match.Host = match.Host with { ConnectionId = connectionId };
            }
            else if (match.Guest.ConnectionId is null && match.Guest.PrincipalId == principalId)
            {
                match.Guest = match.Guest with { ConnectionId = connectionId };
            }
            else
            {
                return (false, null);
            }

            if (match.Host.ConnectionId is null || match.Guest.ConnectionId is null) return (true, null);
            _matches.Remove(code);
            var race = new Race(Guid.NewGuid().ToString("N"), match.Host, match.Guest, Random.Shared.Next(1, int.MaxValue));
            _byConnection[match.Host.ConnectionId] = race;
            _byConnection[match.Guest.ConnectionId] = race;
            return (true, race.Pairing());
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
    /// Drop a connection from its race (and any match it was seated in). Returns the peer left
    /// behind, if any, so the hub can tell it. A race with one seat gone is over — there is no
    /// rejoin, because the host IS the simulation and a guest that comes back has no state to resume.
    /// </summary>
    public string? Remove(string connectionId)
    {
        lock (_lock)
        {
            foreach (var code in _matches.Where(kv => kv.Value.Host.ConnectionId == connectionId || kv.Value.Guest.ConnectionId == connectionId)
                         .Select(kv => kv.Key).ToList())
            {
                _matches.Remove(code);
            }
            if (!_byConnection.Remove(connectionId, out var race)) return null;
            var peer = race.Host.ConnectionId == connectionId ? race.Guest.ConnectionId : race.Host.ConnectionId;
            if (peer is not null) _byConnection.Remove(peer);
            return peer;
        }
    }

    public sealed record Pairing(string RaceId, string HostConnectionId, MarbleRaceStart HostStart, string GuestConnectionId, MarbleRaceStart GuestStart);

    private sealed record Waiting(string? ConnectionId, string PrincipalId, string DisplayName, bool IsGuest, int MapId);

    private sealed class Match
    {
        public Match(Waiting host, Waiting guest, DateTime createdUtc)
        {
            Host = host;
            Guest = guest;
            CreatedUtc = createdUtc;
        }

        public Waiting Host { get; set; }
        public Waiting Guest { get; set; }
        public DateTime CreatedUtc { get; }
    }

    private sealed class Race
    {
        public Race(string raceId, Waiting host, Waiting guest, int seed)
        {
            RaceId = raceId;
            Host = host;
            Guest = guest;
            Seed = seed;
        }

        public string RaceId { get; }
        public Waiting Host { get; }
        public Waiting Guest { get; }
        public int Seed { get; }

        public Pairing Pairing()
        {
            var host = new MarbleRaceSeat(Host.DisplayName, Host.IsGuest, MarbleRaceRole.Host, true);
            var guest = new MarbleRaceSeat(Guest.DisplayName, Guest.IsGuest, MarbleRaceRole.Guest, true);
            return new Pairing(
                RaceId,
                Host.ConnectionId!,
                new MarbleRaceStart(RaceId, MarbleRaceRole.Host, Seed, Host.MapId, GuestMarbleIndex, host, guest),
                Guest.ConnectionId!,
                new MarbleRaceStart(RaceId, MarbleRaceRole.Guest, Seed, Host.MapId, GuestMarbleIndex, host, guest));
        }
    }
}
