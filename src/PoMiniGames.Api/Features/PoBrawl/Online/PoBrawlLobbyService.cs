using PoMiniGames.Domain.Primitives;
using PoMiniGames.Features.Shared;
using PoMiniGames.Features.Shared.Lobby;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoBrawl.Online;

/// <summary>
/// The PoBrawl 1v1 room: the shared ready/start lobby capped at two, where BOTH seats
/// (host included) must be ready, and every seat carries a fighter pick. A player joins
/// with the 1P avatar and changes fighter through <see cref="PickFighter"/>; the match
/// service needs both fighters pinned before it can start a fight.
/// </summary>
/// <remarks>
/// <para>
/// One room for everyone, so two rules keep a single person from holding it. <b>One seat per
/// principal:</b> seats are keyed by connection, so the same player in a second tab used to take
/// the second seat and fight themselves; now the newer connection takes over the older one's seat.
/// <b>No parked seats:</b> a seat that has done nothing for <see cref="IdleSeatMs"/> since the room
/// filled (or since its own last action) is given up the next time someone needs it to get in —
/// except a ready guest, who is waiting on the host, not holding anybody up.
/// </para>
/// </remarks>
public sealed class PoBrawlLobbyService : LobbyRoom<PoBrawlLobbyPlayer>
{
    public const string GlobalCode = "BRAWL";

    /// <summary>Hard cap. PoBrawl is 1v1 only — a third arrival is rejected.</summary>
    public const int Cap = 2;

    /// <summary>How long a seat may sit without readying, picking or starting before it can be evicted.</summary>
    public const long IdleSeatMs = 120_000;

    private readonly TimeProvider _time;

    /// <summary>Connection id → when the seat last did something (or the room last filled). Guarded by the room lock.</summary>
    private readonly Dictionary<string, long> _lastActive = new(StringComparer.Ordinal);

    public PoBrawlLobbyService(TimeProvider? time = null) : base(GlobalCode, Cap, "Match already in progress")
    {
        _time = time ?? TimeProvider.System;
    }

    /// <summary>
    /// A fresh match code per start, carried to the two fighters in their <c>gameStarted</c> and on
    /// to the fight page as <c>?code=</c> — internal plumbing, never shown. Deliberately NOT stored
    /// on the room: <see cref="LobbyRoom{TPlayer}.State"/> goes to every lobby visitor, so a code kept
    /// there was a live fight's address handed to strangers.
    /// </summary>
    public string CreateMatchCode() => "multi-" + Guid.NewGuid().ToString("N");

    /// <summary>
    /// Seat the caller (see the remarks): their other connection's seat is taken over, and when the
    /// room is full, seats idle past <see cref="IdleSeatMs"/> make way. <paramref name="evicted"/>
    /// names whoever lost a seat to idling, for the lobby to announce.
    /// </summary>
    public (LobbyState<PoBrawlLobbyPlayer> state, string message) Open(
        string connectionId, string principalId, string displayName, bool isGuest, PoBrawlFighter fighter,
        out IReadOnlyList<string> evicted)
    {
        var gone = new List<string>();
        var result = WithLock(players =>
        {
            var now = _time.GetUtcNow().ToUnixTimeMilliseconds();
            var principal = PrincipalIds.Sanitize(principalId);

            // The same player on another connection (a second tab, or a refresh the server has not
            // noticed closing yet): this connection takes the seat over, fighter pick included.
            PoBrawlLobbyPlayer? takenOver = null;
            var started = IsStarted; // a refused join must not cost anyone their seat
            if (principal != "anon" && !started)
            {
                foreach (var other in players.Values.Where(p => p.ConnectionId != connectionId && p.PrincipalId == principal).ToList())
                {
                    takenOver = other;
                    Leave(other.ConnectionId);
                }
            }

            // Full room, newcomer at the door: seats that have sat on it make way.
            if (!started && players.Count >= Cap && !players.ContainsKey(connectionId))
            {
                var host = HostConnectionId;
                foreach (var idle in players.Values
                             .Where(p => now - _lastActive.GetValueOrDefault(p.ConnectionId, now) >= IdleSeatMs
                                         && !(p.IsReady && p.ConnectionId != host))
                             .ToList())
                {
                    gone.Add(idle.DisplayName);
                    Leave(idle.ConnectionId);
                }
            }

            var wasFull = players.Count >= Cap;
            var opened = OpenCore(connectionId, displayName, isGuest, (name, existing, _) =>
                // A re-join keeps the principal the seat was opened with, so two connections from
                // the same player never both count toward the cap.
                new PoBrawlLobbyPlayer(connectionId, existing?.PrincipalId ?? principal, name, isGuest,
                    existing?.IsReady ?? false, existing?.Fighter ?? takenOver?.Fighter ?? fighter));

            if (players.ContainsKey(connectionId))
            {
                _lastActive[connectionId] = now;
                // The room just filled: everyone's "you're up" clock starts now, so a host who was
                // waiting, ready, for an opponent is not idle the instant one arrives.
                if (!wasFull && players.Count >= Cap)
                {
                    foreach (var key in players.Keys) _lastActive[key] = now;
                }
            }
            return opened;
        });
        evicted = gone;
        return result;
    }

    /// <summary>
    /// <see cref="Open(string, string, string, bool, PoBrawlFighter, out IReadOnlyList{string})"/>
    /// without the eviction report.
    /// </summary>
    public (LobbyState<PoBrawlLobbyPlayer> state, string message) Open(
        string connectionId, string principalId, string displayName, bool isGuest, PoBrawlFighter fighter) =>
        Open(connectionId, principalId, displayName, isGuest, fighter, out _);

    /// <summary>Change fighter without re-joining. Any fighter is allowed for both seats; the match is unrated for Bob.</summary>
    public (bool ok, string message) PickFighter(string connectionId, PoBrawlFighter fighter) =>
        WithLock(players =>
        {
            if (!players.TryGetValue(connectionId, out var seat)) return (false, "Not in lobby");
            players[connectionId] = seat with { Fighter = fighter };
            OnSeatTouched(connectionId);
            return (true, $"{seat.DisplayName} picked {fighter.Name}");
        });

    protected override PoBrawlLobbyPlayer WithReady(PoBrawlLobbyPlayer player, bool ready) =>
        player with { IsReady = ready };

    protected override void OnSeatTouched(string connectionId) =>
        _lastActive[connectionId] = _time.GetUtcNow().ToUnixTimeMilliseconds();

    protected override void OnLeft(string connectionId) => _lastActive.Remove(connectionId);

    /// <summary>A fight needs both seats filled and both ready — the host readies up too.</summary>
    protected override bool CanStart(IReadOnlyList<PoBrawlLobbyPlayer> players, string hostConnectionId) =>
        players.Count == Cap && players.All(p => p.IsReady);
}
