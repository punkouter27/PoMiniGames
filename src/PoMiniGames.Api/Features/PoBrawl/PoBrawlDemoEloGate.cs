using System.Collections.Concurrent;

namespace PoMiniGames.Features.PoBrawl;

/// <summary>
/// Bounds how far one identity can steer the demo fighter board (<c>POST /api/pobrawl/elo</c>).
/// The board rates CPU-vs-CPU bouts, so a submission names only who fought and who won — and
/// without this, anyone could post the same winner/loser pair as fast as the rate limiter let
/// them and walk a favourite president up the board.
/// </summary>
/// <remarks>
/// Two limits per identity: bouts at least <see cref="MinGap"/> apart (a demo bout, or a 4x
/// tournament bout with its between-bouts hold, is never quicker), and at most
/// <see cref="DailyCap"/> a UTC day — a handful of full eight-fighter cups. Process-local like
/// the other live-play state: a restart forgets the counts, which costs at most one more day's
/// allowance.
/// </remarks>
public sealed class PoBrawlDemoEloGate(TimeProvider? time = null)
{
    /// <summary>Shortest gap between two bouts from one identity.</summary>
    public static readonly TimeSpan MinGap = TimeSpan.FromSeconds(3);

    /// <summary>Bouts one identity may report per UTC day: five seven-bout cups and change.</summary>
    public const int DailyCap = 40;

    private readonly TimeProvider _time = time ?? TimeProvider.System;
    private readonly ConcurrentDictionary<string, Tally> _tallies = new(StringComparer.Ordinal);

    private sealed class Tally
    {
        public DateOnly Day;
        public int Count;
        public DateTimeOffset Last = DateTimeOffset.MinValue;
    }

    /// <summary>Why a bout was refused, or null when it may be recorded (and is now counted).</summary>
    public string? TryAdmit(string identity)
    {
        var now = _time.GetUtcNow();
        var today = DateOnly.FromDateTime(now.UtcDateTime);
        var tally = _tallies.GetOrAdd(identity, _ => new Tally());
        lock (tally)
        {
            if (tally.Day != today)
            {
                tally.Day = today;
                tally.Count = 0;
            }
            if (now - tally.Last < MinGap) return "demo_too_fast";
            if (tally.Count >= DailyCap) return "demo_daily_cap";
            tally.Count++;
            tally.Last = now;
        }

        // Yesterday's tallies are dead weight; drop them now and then rather than on a timer.
        if (_tallies.Count > 1_000)
        {
            foreach (var (key, stale) in _tallies)
            {
                if (stale.Day != today) _tallies.TryRemove(key, out _);
            }
        }
        return null;
    }
}
