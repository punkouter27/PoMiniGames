using System.Collections.Concurrent;
using System.Security.Cryptography;
using PoMiniGames.Shared.Games.PoJevArena;

namespace PoMiniGames.Features.PoJevArena;

public enum ArenaResultGate
{
    Accepted,
    AlreadyReported,
    TooFewDecisions,
    Implausible,
}

/// <summary>
/// One registered match: the frozen rosters (so a mid-match library edit changes nothing and the
/// prompt names come from here, not the client), the owner, and how many decisions it has answered.
/// </summary>
public sealed class ArenaMatch(string matchId, string ownerId, ArenaRoster roster, ArenaMode mode, int seed, DateTimeOffset now)
{
    private int _decisions;
    private int _reported;
    private long _lastTouchedTicks = now.UtcTicks;

    public string MatchId { get; } = matchId;
    public string OwnerId { get; } = ownerId;
    public ArenaRoster Roster { get; } = roster;
    public ArenaMode Mode { get; } = mode;
    public int Seed { get; } = seed;
    public DateTimeOffset RegisteredAt { get; } = now;

    public int Decisions => Volatile.Read(ref _decisions);

    internal DateTimeOffset LastTouched => new(Interlocked.Read(ref _lastTouchedTicks), TimeSpan.Zero);

    internal void Touch(DateTimeOffset now) => Interlocked.Exchange(ref _lastTouchedTicks, now.UtcTicks);

    /// <summary>Counts answered decisions only — the work the result gate requires.</summary>
    public void RecordDecisions(int count) => Interlocked.Add(ref _decisions, count);

    /// <summary>
    /// One result per match, and only when the claim is plausible for a match that really ran:
    /// at least <see cref="ArenaMatchRegistry.MinResultSeconds"/> long, at least 80% of the claimed
    /// duration elapsed on the server's clock since registration (the sim runs in real time and
    /// pauses when hidden, so it can only be slower), and decisions in proportion to that
    /// duration. The winner itself is the client's word — the server does not re-simulate — so
    /// this does not make a result unforgeable; it makes forging one cost the same time and
    /// allowance as playing it, which keeps library win rates honest enough for a sort order.
    /// </summary>
    public ArenaResultGate TryClaimResult(double durationSeconds, DateTimeOffset now)
    {
        var needed = Math.Max(ArenaMatchRegistry.MinDecisionsForResult, (int)(durationSeconds * ArenaMatchRegistry.MinDecisionsPerSecond));
        if (Decisions < needed) return ArenaResultGate.TooFewDecisions;
        if (durationSeconds < ArenaMatchRegistry.MinResultSeconds
            || (now - RegisteredAt).TotalSeconds < durationSeconds * 0.8)
        {
            return ArenaResultGate.Implausible;
        }
        return Interlocked.Exchange(ref _reported, 1) == 0 ? ArenaResultGate.Accepted : ArenaResultGate.AlreadyReported;
    }

    /// <summary>Hands the claim back when the stats write failed, so the client's retry can land.</summary>
    public void ReleaseResultClaim() => Interlocked.Exchange(ref _reported, 0);
}

/// <summary>
/// Process-local registry of live matches with a sliding idle expiry. Process-local on purpose,
/// like every other lobby in the host: an F1 recycle forgets live matches, and the client then
/// sees 404 ("match expired — redeploy") rather than anything worse.
/// </summary>
public sealed class ArenaMatchRegistry(TimeProvider clock)
{
    public const int MinDecisionsForResult = 40;
    public const double MinDecisionsPerSecond = 4;
    public const double MinResultSeconds = 10;
    public static readonly TimeSpan IdleExpiry = TimeSpan.FromMinutes(15);

    /// <summary>Upper bound on live matches; the oldest idle ones are swept first.</summary>
    private const int MaxLiveMatches = 2_000;

    private readonly ConcurrentDictionary<string, ArenaMatch> _matches = new(StringComparer.Ordinal);

    public ArenaMatch Register(string ownerId, ArenaRoster roster, ArenaMode mode)
    {
        var now = clock.GetUtcNow();
        Sweep(now);

        var id = Convert.ToHexString(RandomNumberGenerator.GetBytes(8)).ToLowerInvariant();
        var match = new ArenaMatch(id, ownerId, roster, mode, RandomNumberGenerator.GetInt32(1, int.MaxValue), now);
        _matches[id] = match;
        return match;
    }

    /// <summary>
    /// The caller's live match, or null — for an unknown id, an expired one, and someone else's
    /// alike, so a match id reveals nothing to a caller who does not own it.
    /// </summary>
    public ArenaMatch? Find(string matchId, string ownerId)
    {
        if (!_matches.TryGetValue(matchId, out var match)) return null;

        var now = clock.GetUtcNow();
        if (now - match.LastTouched > IdleExpiry)
        {
            _matches.TryRemove(matchId, out _);
            return null;
        }

        if (!string.Equals(match.OwnerId, ownerId, StringComparison.Ordinal)) return null;

        match.Touch(now);
        return match;
    }

    private void Sweep(DateTimeOffset now)
    {
        foreach (var (id, match) in _matches)
        {
            if (now - match.LastTouched > IdleExpiry) _matches.TryRemove(id, out _);
        }

        if (_matches.Count < MaxLiveMatches) return;
        foreach (var stale in _matches.Values.OrderBy(m => m.LastTouched).Take(_matches.Count - MaxLiveMatches + 1))
        {
            _matches.TryRemove(stale.MatchId, out _);
        }
    }
}
