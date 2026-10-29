using System.Collections.Concurrent;

namespace PoMiniGames.AI;

/// <summary>
/// Bound on how many model tokens one caller may spend per UTC day, across the whole AI surface.
/// </summary>
/// <remarks>
/// The only thing in front of the metered relay was a rate limit — 10 requests/second per
/// IP+identity partition, with no token accounting whatsoever. One browser tab left open could
/// therefore issue on the order of 36 000 calls an hour against a paid deployment and nothing in
/// the app would notice, let alone refuse. Rate limiting shapes burst; it does not bound spend.
/// </remarks>
public sealed class AiTokenBudgetOptions
{
    public const string SectionName = "PoMiniGames:AI:TokenBudget";

    /// <summary>
    /// Tokens one identity may spend per UTC day. 0 or negative disables the ceiling — which is
    /// a deliberate opt-out, not the default.
    /// </summary>
    public long DailyTokensPerIdentity { get; set; } = 250_000;

    /// <summary>
    /// How often accumulated spend is written through to <see cref="IAiTokenLedgerStore"/>.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Write-behind rather than write-through, because the alternative puts a Table Storage
    /// round-trip on the completion path of every model call — on the same host that already
    /// measured a 1-2 concurrent ceiling, which is not where latency should be spent.
    /// </para>
    /// <para>
    /// The cost of the choice is stated plainly: an ungraceful termination loses at most one
    /// interval's spend. On F1, where a recycle previously lost <em>every</em> identity's entire
    /// day, trading a whole day for 30 seconds is the point of the exercise.
    /// </para>
    /// </remarks>
    public TimeSpan FlushInterval { get; set; } = TimeSpan.FromSeconds(30);
}

/// <summary>
/// Tracks per-identity token spend for the current UTC day and refuses callers who have used
/// their allowance.
/// </summary>
/// <remarks>
/// <para>
/// The in-memory dictionary is a write-behind cache over <see cref="IAiTokenLedgerStore"/>, not
/// the record itself. An identity's row is read once per process per day (on its first call) and
/// its spend is flushed back periodically by <see cref="AiTokenBudgetFlushService"/>, so the
/// ceiling survives the host recycles that F1 cannot avoid. With the null store wired the class
/// behaves exactly as it did before — process-local and reset by a restart.
/// </para>
/// </remarks>
public sealed class AiTokenBudget
{
    private readonly ConcurrentDictionary<string, Ledger> _ledgers = new(StringComparer.Ordinal);
    private readonly Func<DateTimeOffset> _clock;
    private readonly long _dailyLimit;
    private readonly IAiTokenLedgerStore _store;

    public AiTokenBudget(
        Microsoft.Extensions.Options.IOptions<AiTokenBudgetOptions> options,
        IAiTokenLedgerStore store)
        : this(options.Value.DailyTokensPerIdentity, () => DateTimeOffset.UtcNow, store)
    {
    }

    /// <summary>Test/diagnostics constructor with an injectable clock and no durable store.</summary>
    public AiTokenBudget(long dailyTokensPerIdentity, Func<DateTimeOffset> clock)
        : this(dailyTokensPerIdentity, clock, NullAiTokenLedgerStore.Instance)
    {
    }

    /// <summary>Test/diagnostics constructor with an injectable clock and store.</summary>
    public AiTokenBudget(long dailyTokensPerIdentity, Func<DateTimeOffset> clock, IAiTokenLedgerStore store)
    {
        _dailyLimit = dailyTokensPerIdentity;
        _clock = clock;
        _store = store;
    }

    private sealed class Ledger
    {
        public DateOnly Day;

        /// <summary>Best-known total for <see cref="Day"/>: what the store held plus what we added.</summary>
        public long Spent;

        /// <summary>Spend added in this process that has not been written through yet.</summary>
        public long PendingFlush;

        /// <summary>False until this identity's row has been read for <see cref="Day"/>.</summary>
        public bool Hydrated;

        /// <summary>Serialises hydration so concurrent first calls issue one read, not N.</summary>
        public readonly SemaphoreSlim HydrationLock = new(1, 1);

        /// <summary>
        /// Set (under the ledger lock) when <see cref="FlushAsync"/> evicts a stale, fully-flushed
        /// ledger. A writer that fetched it just before the eviction sees this and takes a fresh one,
        /// so no spend lands on an entry that is no longer in the dictionary.
        /// </summary>
        public bool Retired;
    }

    /// <summary>True when the ceiling is switched off entirely.</summary>
    public bool IsUnlimited => _dailyLimit <= 0;

    /// <summary>True when spend is written through to durable storage.</summary>
    public bool IsDurable => _store.IsDurable;

    /// <param name="Allowed">False when this identity has already spent its daily allowance.</param>
    /// <param name="Spent">Tokens spent so far today.</param>
    /// <param name="Limit">The daily ceiling in force.</param>
    /// <param name="ResetUtc">Start of the next UTC day, when the allowance returns.</param>
    public readonly record struct Verdict(bool Allowed, long Spent, long Limit, DateTimeOffset ResetUtc);

    /// <summary>
    /// Asks whether <paramref name="identity"/> may make another call, hydrating their durable
    /// total first if this process has not seen them today.
    /// </summary>
    /// <remarks>
    /// Checked <em>before</em> the call rather than reserving an estimate: a decision call's true
    /// cost is only known from the reply, and refusing on a guess would either over- or
    /// under-charge every caller.
    /// </remarks>
    public async Task<Verdict> CheckAsync(string identity, CancellationToken cancellationToken = default)
    {
        var now = _clock();
        var reset = ResetAfter(now);

        if (IsUnlimited)
            return new Verdict(true, 0, 0, reset);

        var today = DateOnly.FromDateTime(now.UtcDateTime);
        var ledger = _ledgers.GetOrAdd(identity, _ => new Ledger { Day = today });

        await HydrateAsync(ledger, identity, today, cancellationToken);

        long spent;
        lock (ledger)
        {
            spent = ledger.Day == today ? ledger.Spent : 0;
        }

        return new Verdict(spent < _dailyLimit, spent, _dailyLimit, reset);
    }

    /// <summary>
    /// Synchronous verdict from what this process already knows, with no durable read.
    /// </summary>
    /// <remarks>
    /// Kept for the diagnostics surface and for tests. A call path that can await should use
    /// <see cref="CheckAsync"/> — this overload cannot see spend that another process (or this one
    /// before its last restart) recorded, which is the gap the durable ledger exists to close.
    /// </remarks>
    public Verdict Check(string identity)
    {
        var now = _clock();
        var reset = ResetAfter(now);

        if (IsUnlimited)
            return new Verdict(true, 0, 0, reset);

        var spent = SpentToday(identity, now);
        return new Verdict(spent < _dailyLimit, spent, _dailyLimit, reset);
    }

    /// <summary>Adds the actual token cost of a completed call.</summary>
    /// <remarks>
    /// Stays synchronous and allocation-free on purpose: it runs on the completion path of every
    /// model call. The durable write is deferred to the flusher.
    /// </remarks>
    public void Record(string identity, long tokens)
    {
        if (IsUnlimited || tokens <= 0) return;

        var today = DateOnly.FromDateTime(_clock().UtcDateTime);
        while (true)
        {
            var ledger = _ledgers.GetOrAdd(identity, _ => new Ledger { Day = today });
            lock (ledger)
            {
                if (ledger.Retired) continue;
                RecordLocked(ledger, today, tokens);
                return;
            }
        }
    }

    private static void RecordLocked(Ledger ledger, DateOnly today, long tokens)
    {
        if (ledger.Day != today)
        {
            // A new UTC day: the old day's total is gone from this ledger, but any unflushed
            // delta still belongs to the day it was spent on, so it is flushed before the
            // rollover by the flusher. Anything left here is re-attributed to the new day
            // rather than dropped — over-charging the caller slightly is the safe direction.
            ledger.Day = today;
            ledger.Spent = 0;
            ledger.Hydrated = false;
        }
        ledger.Spent += tokens;
        ledger.PendingFlush += tokens;
    }

    /// <summary>Tokens spent by this identity so far today, as far as this process knows.</summary>
    public long SpentToday(string identity) => SpentToday(identity, _clock());

    /// <summary>
    /// Writes every accumulated delta through to the durable store. A failed write puts its delta
    /// back so the next flush retries it rather than losing the spend.
    /// </summary>
    public async Task FlushAsync(CancellationToken cancellationToken = default)
    {
        if (!_store.IsDurable || IsUnlimited) return;

        var today = DateOnly.FromDateTime(_clock().UtcDateTime);
        foreach (var (identity, ledger) in _ledgers)
        {
            // Evict a ledger left over from an earlier UTC day once nothing is waiting to be
            // written: without this the dictionary grows by every identity that ever called.
            // Retired is set under the ledger lock so a concurrent Record re-fetches instead of
            // charging the evicted entry; the conditional remove only drops this exact instance.
            lock (ledger)
            {
                if (ledger.Day < today && ledger.PendingFlush == 0)
                {
                    ledger.Retired = true;
                    _ledgers.TryRemove(new KeyValuePair<string, Ledger>(identity, ledger));
                    continue;
                }
            }

            long delta;
            DateOnly day;
            lock (ledger)
            {
                delta = ledger.PendingFlush;
                day = ledger.Day;
                ledger.PendingFlush = 0;
            }

            if (delta <= 0) continue;

            try
            {
                await _store.IncrementAsync(day, identity, delta, cancellationToken);
            }
            catch
            {
                // Put it back. The store already logged the reason; re-queuing here is what makes
                // a transient storage blip a deferral instead of free tokens.
                lock (ledger)
                {
                    ledger.PendingFlush += delta;
                }
            }
        }
    }

    private async Task HydrateAsync(
        Ledger ledger, string identity, DateOnly today, CancellationToken cancellationToken)
    {
        if (!_store.IsDurable) return;

        lock (ledger)
        {
            if (ledger.Hydrated && ledger.Day == today) return;
        }

        await ledger.HydrationLock.WaitAsync(cancellationToken);
        try
        {
            lock (ledger)
            {
                if (ledger.Hydrated && ledger.Day == today) return;
            }

            var stored = await _store.LoadAsync(today, identity, cancellationToken);

            lock (ledger)
            {
                if (ledger.Day != today)
                {
                    ledger.Day = today;
                    ledger.Spent = 0;
                }

                // The stored total already contains everything this process has flushed, so adding
                // it to the local total would double-count. What it does NOT contain is the
                // unflushed delta, which is exactly what has to survive the hydration.
                ledger.Spent = stored + ledger.PendingFlush;
                ledger.Hydrated = true;
            }
        }
        finally
        {
            ledger.HydrationLock.Release();
        }
    }

    private static DateTimeOffset ResetAfter(DateTimeOffset now)
        => new(now.UtcDateTime.Date.AddDays(1), TimeSpan.Zero);

    private long SpentToday(string identity, DateTimeOffset now)
    {
        if (!_ledgers.TryGetValue(identity, out var ledger)) return 0;
        var today = DateOnly.FromDateTime(now.UtcDateTime);
        lock (ledger)
        {
            return ledger.Day == today ? ledger.Spent : 0;
        }
    }
}

/// <summary>
/// Writes accumulated AI spend through to the durable ledger on an interval, and once more on
/// shutdown so a graceful stop loses nothing at all.
/// </summary>
public sealed class AiTokenBudgetFlushService : BackgroundService
{
    private readonly AiTokenBudget _budget;
    private readonly TimeSpan _interval;
    private readonly ILogger<AiTokenBudgetFlushService> _logger;

    public AiTokenBudgetFlushService(
        AiTokenBudget budget,
        Microsoft.Extensions.Options.IOptions<AiTokenBudgetOptions> options,
        ILogger<AiTokenBudgetFlushService> logger)
    {
        _budget = budget;
        _logger = logger;
        var configured = options.Value.FlushInterval;
        // A zero or negative interval would spin; a very long one makes the durability claim
        // hollow. Clamp rather than throw — a bad config value should not fail host startup.
        _interval = configured < TimeSpan.FromSeconds(5) ? TimeSpan.FromSeconds(30)
            : configured > TimeSpan.FromMinutes(10) ? TimeSpan.FromMinutes(10)
            : configured;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_budget.IsDurable)
        {
            _logger.LogInformation(
                "AI token budget is running in-memory only (no durable ledger store); a host restart resets every allowance.");
            return;
        }

        using var timer = new PeriodicTimer(_interval);
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                await _budget.FlushAsync(stoppingToken);
            }
        }
        catch (OperationCanceledException)
        {
            // Shutdown — the final flush happens in StopAsync.
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        await base.StopAsync(cancellationToken);
        try
        {
            // CancellationToken.None on purpose: the host's shutdown token is already cancelled by
            // the time StopAsync runs, and passing it would cancel the very write that makes a
            // graceful stop lossless.
            await _budget.FlushAsync(CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Final AI token budget flush failed; up to one interval of spend was not persisted.");
        }
    }
}
