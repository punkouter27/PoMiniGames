using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Models;
// Alias, not a namespace import: PoMiniGamesClient.Models mirrors several other Domain
// types by name, so importing the namespace wholesale would make them all ambiguous.

using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Play;

/// <summary>
/// The single intake every game reports an outcome to. It owns "what happens when a game ends":
/// local stats are always recorded, and a server high score is submitted in the same awaited step
/// when one is supplied — so the two writes can no longer desync the way a fire-and-forget submit can.
/// </summary>
/// <remarks>
/// Pattern: a deep module over two adapters. Local stats (<see cref="GameStatsService"/>) and the
/// server board (<see cref="ApiService"/>) sit behind one interface, concentrating outcome handling
/// in one place instead of each game wiring both — or routing around one of them.
/// </remarks>
public sealed class GameResultService
{
    private readonly GameStatsService _stats;
    private readonly ApiService _api;
    private readonly ScoreSyncService _sync;
    private readonly UiFeedbackService _feedback;
    private readonly AuthStateService _auth;
    private readonly ToastService _toast;
    // Nudge a guest to sign in at most once per app session — a soft invitation,
    // not a nag after every round.
    private bool _guestNudgeShown;

    public GameResultService(
        GameStatsService stats,
        ApiService api,
        ScoreSyncService sync,
        UiFeedbackService feedback,
        AuthStateService auth,
        ToastService toast)
    {
        _stats = stats;
        _api = api;
        _sync = sync;
        _feedback = feedback;
        _auth = auth;
        _toast = toast;
    }

    /// <summary>
    /// A server submit didn't land, so the score was parked in the offline queue.
    /// Why it failed changes what the player should hear:
    /// <list type="bullet">
    /// <item>Guest (not signed in) — this isn't an error, it's the deferred-sign-in
    /// path. Nudge them to sign in so the parked score reaches the board; keep the
    /// audio soft.</item>
    /// <item>Signed-in — a genuine network hiccup. Buzz + reassure that it will sync.</item>
    /// </list>
    /// </summary>
    private async Task OnScoreParkedAsync()
    {
        if (!_auth.IsAuthenticated)
        {
            await _feedback.TapAsync();
            if (!_guestNudgeShown)
            {
                _guestNudgeShown = true;
                _toast.Show("Nice run! Sign in to save your score to the leaderboard.", ToastType.Info);
            }
        }
        else
        {
            await _feedback.ErrorAsync();
            _toast.Show("You're offline — your score will sync automatically.", ToastType.Warning);
        }
    }

    /// <summary>Records a local-only outcome (the common path for games without a server board).</summary>
    public Task<PlayerStats> RecordAsync(string gameKey, string playerName, Difficulty difficulty, GameResult result) =>
        _stats.RecordResult(gameKey, playerName, difficulty, result);

    /// <summary>
    /// Records the outcome locally AND pushes the updated stats to the server board, parking
    /// them in the offline queue if the write fails.
    /// </summary>
    /// <remarks>
    /// For win-rate games with no separate high-score payload. <see cref="RecordAsync"/> writes
    /// only to localStorage, so a game that used it and nothing else could never appear on its
    /// own leaderboard — which is exactly what happened to PoCoupleQuiz. This is
    /// <see cref="SubmitAdaptiveStatsAsync"/>'s flow without the adaptive-ELO mirroring, which
    /// only applies to games whose CPU is matched to the player's rating.
    /// </remarks>
    public async Task<PlayerStats> RecordAndSyncStatsAsync(
        string gameKey, string playerName, Difficulty difficulty, GameResult result)
    {
        var stats = await _stats.RecordResult(gameKey, playerName, difficulty, result);
        var (ok, _) = await _api.SavePlayerStatsAsync(gameKey, playerName, stats);
        if (!ok)
        {
            _sync.EnqueuePlayerStats(new PendingPlayerStats
            {
                GameKey = gameKey,
                PlayerName = playerName,
                Stats = stats,
            });
            await OnScoreParkedAsync();
        }
        return stats;
    }

    /// <summary>How a server high-score submit resolved; drives the shared feedback path.</summary>
    private enum SubmitOutcome
    {
        /// <summary>The board accepted the score.</summary>
        Saved,
        /// <summary>Unreachable or a server fault — the payload is good, so park it and let the
        /// queue replay it on reconnect. The leaderboard is the platform's North Star.</summary>
        Park,
        /// <summary>The server rejected this score outright; queueing it would only replay the
        /// rejection forever. Say so instead of promising a sync that can't happen.</summary>
        Rejected,
    }

    /// <summary>
    /// The one record-then-submit flow both per-game wrappers share: record the local
    /// outcome, submit the high score (when one was earned), and translate the submit
    /// outcome into feedback — saved chime, offline park + nudge, or a rejection toast.
    /// </summary>
    private async Task<PlayerStats> RecordAndSubmitCoreAsync(
        string gameKey, string playerName, GameResult result, bool hasHighScore,
        Func<Task<SubmitOutcome>> submitAsync, Action enqueueOffline)
    {
        var stats = await _stats.RecordResult(gameKey, playerName, Difficulty.Medium, result);
        if (!hasHighScore)
        {
            await _feedback.TapAsync();
            return stats;
        }

        switch (await submitAsync())
        {
            case SubmitOutcome.Saved:
                await _feedback.CompleteAsync();
                break;
            case SubmitOutcome.Park:
                enqueueOffline();
                await OnScoreParkedAsync();
                break;
            default:
                await _feedback.ErrorAsync();
                _toast.Show("That score couldn't be saved to the leaderboard.", ToastType.Error);
                break;
        }
        return stats;
    }

    /// <summary>
    /// Records the local outcome and, when <paramref name="highScore"/> is supplied, submits it to the
    /// server board in the same awaited call. One report, both writes, consistent ordering.
    /// </summary>
    public Task<PlayerStats> RecordAndSubmitMarbleRaceAsync(
        string playerName, GameResult result, MarbleRaceHighScoreRequest? highScore) =>
        RecordAndSubmitCoreAsync("pomarblerace", playerName, result, highScore is not null,
            async () =>
            {
                var submitted = await _api.SubmitMarbleRaceHighScoreAsync(highScore!);
                return submitted.IsSaved ? SubmitOutcome.Saved
                    : submitted.ShouldRetry ? SubmitOutcome.Park
                    : SubmitOutcome.Rejected;
            },
            () => _sync.EnqueueMarbleRace(highScore!));

    /// <summary>
    /// PoCabinet: per-track best-lap ratchet. Ties the
    /// finished-race flow through the same offline-resilient path as the
    /// other games so a player who finishes a race while offline still gets
    /// the run recorded later.
    /// </summary>
    public Task<PlayerStats> RecordAndSubmitPoCabinetAsync(
        string playerName, GameResult result, PoCabinetHighScoreRequest? highScore) =>
        RecordAndSubmitCoreAsync("pocabinet", playerName, result, highScore is not null,
            async () =>
            {
                var submitted = await _api.SubmitPoCabinetHighScoreAsync(highScore!);
                return submitted.IsSaved ? SubmitOutcome.Saved
                    : submitted.ShouldRetry ? SubmitOutcome.Park
                    : SubmitOutcome.Rejected;
            },
            () => _sync.EnqueuePoCabinet(highScore!));

    /// <summary>
    /// The single sync path for adaptive-ELO games (ConnectFive/TicTacToe): mirror the
    /// adaptive record into the legacy stats shape (Medium bucket carries the adaptive
    /// W/L/D and ELO), persist locally, and PUT to the server so the leaderboard shows
    /// this player. A failed PUT is parked in the offline queue and replayed on reconnect.
    /// </summary>
    public async Task SubmitAdaptiveStatsAsync(string gameKey, string playerName, AdaptiveRating rating)
    {
        var stats = _stats.GetStats(gameKey, playerName);
        stats.Medium.Wins = rating.Wins;
        stats.Medium.Losses = rating.Losses;
        stats.Medium.Draws = rating.Draws;
        stats.Medium.EloRating = rating.Elo;
        await _stats.SaveStats(gameKey, stats);
        var (ok, _) = await _api.SavePlayerStatsAsync(gameKey, playerName, stats);
        if (!ok)
        {
            _sync.EnqueuePlayerStats(new PendingPlayerStats
            {
                GameKey = gameKey,
                PlayerName = playerName,
                Stats = stats,
            });
        }
    }

    /// <summary>Records the PoVoxelStrike run locally and submits it to the board together.</summary>
    /// <remarks>Every finished run submits — the server descriptor ratchets to the player's
    /// best, so a lower score is an accepted no-op rather than a rejection.
    /// <paramref name="onNewBest"/> fires only on a confirmed server save whose stored row
    /// carries this run's score — i.e. the ratchet advanced. A parked (offline) submit never
    /// fires it: no confirmation, no badge.</remarks>
    public Task<PlayerStats> RecordAndSubmitPoVoxelStrikeAsync(
        string playerName, GameResult result, PoVoxelStrikeRunRequest? run,
        Action<bool>? onNewBest = null) =>
        RecordAndSubmitCoreAsync("povoxelstrike", playerName, result, run is not null,
            async () =>
            {
                var submitted = await _api.SubmitPoVoxelStrikeRunAsync(run!);
                if (submitted.IsSaved)
                {
                    onNewBest?.Invoke(submitted.Value is { } saved && saved.Score == run!.Score);
                    return SubmitOutcome.Saved;
                }
                return submitted.ShouldRetry ? SubmitOutcome.Park : SubmitOutcome.Rejected;
            },
            () => _sync.EnqueuePoVoxelStrike(run!));

    /// <summary>
    /// Records a finished PoMule match locally and posts its Net Worth. Offline or a server
    /// error parks the score for later.
    /// </summary>
    public Task<PlayerStats> RecordAndSubmitPoMuleAsync(string playerName, GameResult result, PoMuleRunRequest run) =>
        RecordAndSubmitCoreAsync("pomule", playerName, result, true,
            async () =>
            {
                var submitted = await _api.SubmitPoMuleRunAsync(run);
                if (submitted.IsSaved) return SubmitOutcome.Saved;
                return submitted.ShouldRetry ? SubmitOutcome.Park : SubmitOutcome.Rejected;
            },
            () => _sync.EnqueuePoMule(run));

    /// <summary>
    /// PoMarbleRace: submits the per-map best-time record. It has no feedback of its own (the
    /// race's high-score submit carries the chime/toast); a retriable failure is parked.
    /// </summary>
    public async Task SubmitMarbleRaceMapRecordAsync(MarbleRaceRecordRequest record)
    {
        var submitted = await _api.SubmitMarbleRaceMapRecordAsync(record);
        if (!submitted.IsSaved && submitted.ShouldRetry) _sync.EnqueueMarbleRaceMapRecord(record);
    }

    /// <summary>
    /// PoFunQuiz solo: records the local outcome and submits the run to the category board in
    /// one awaited call; an offline or server failure parks it in the retry queue.
    /// </summary>
    public Task<PlayerStats> RecordAndSubmitFunQuizAsync(
        string playerName, GameResult result, FunQuizLeaderboardSubmission submission) =>
        RecordAndSubmitCoreAsync("pofunquiz", playerName, result, true,
            async () =>
            {
                var submitted = await _api.SubmitFunQuizScoreAsync(submission);
                if (submitted.IsSaved) return SubmitOutcome.Saved;
                return submitted.ShouldRetry ? SubmitOutcome.Park : SubmitOutcome.Rejected;
            },
            () => _sync.EnqueueFunQuiz(submission));

    /// <summary>
    /// PoRacer: submits the best lap of a finished race. The local win/loss is recorded
    /// separately through <see cref="RecordAsync"/> because a time trial moves no record but
    /// still submits a lap. A retriable failure (or leaving the page mid-submit) parks the lap
    /// in the offline queue. Returns "Saved", "Queued" or "Rejected" for the results card.
    /// </summary>
    public async Task<string> SubmitPoRacerLapAsync(PoRacerScoreDto score, CancellationToken cancellationToken)
    {
        try
        {
            var submitted = await _api.SubmitPoRacerScoreAsync(score, cancellationToken);
            if (submitted.IsSaved) return "Saved";
            if (!submitted.ShouldRetry) return "Rejected";
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // Left the page mid-submit: park it quietly, no nudge for a page that is gone.
            _sync.EnqueuePoRacer(score);
            return "Queued";
        }
        _sync.EnqueuePoRacer(score);
        return "Queued";
    }

    /// <summary>Records the PoBrawl outcome locally and submits the fastest-KO score together.</summary>
    public Task<PlayerStats> RecordAndSubmitPoBrawlAsync(
        string playerName, GameResult result, PoBrawlHighScore? highScore) =>
        RecordAndSubmitCoreAsync("pobrawl", playerName, result, highScore is not null,
            async () =>
            {
                var submitted = await _api.SubmitPoBrawlHighScoreAsync(highScore!);
                return submitted.IsSaved ? SubmitOutcome.Saved
                    : submitted.ShouldRetry ? SubmitOutcome.Park
                    : SubmitOutcome.Rejected;
            },
            () => _sync.EnqueuePoBrawl(highScore!));
}
