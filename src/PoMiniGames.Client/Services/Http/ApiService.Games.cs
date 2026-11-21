using System.Net;
using System.Net.Http.Json;
using PoMiniGames.Shared.Dtos;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Models;
using PoMiniGamesClient.Services.Play;

namespace PoMiniGamesClient.Services.Http;

/// <summary>Per-game API endpoints split out of <see cref="ApiService"/>.</summary>
public partial class ApiService
{
    // ── PoCapitol ─────────────────────────────────────────────────────────

    /// <summary>Renders the after-action report card; the 1200x630 PNG bytes, or null when the server refuses or is unreachable.</summary>
    public async Task<byte[]?> GetPoCapitolReportCardAsync(PoCapitolReportCardRequest request, CancellationToken ct = default)
    {
        try
        {
            using var response = await _http.PostAsJsonAsync(
                "/api/pocapitol/report-card", request, ApiJsonContext.Default.PoCapitolReportCardRequest, ct);
            return response.IsSuccessStatusCode ? await response.Content.ReadAsByteArrayAsync(ct) : null;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            return null;
        }
    }

    // ── PoMarbleRace ──────────────────────────────────────────────────────

    public Task<MarbleRaceHighScore[]?> GetMarbleRaceHighScoresAsync(int count = 10) =>
        GetOrDefaultAsync($"/api/marblerace/highscores?count={count}", ApiJsonContext.Default.MarbleRaceHighScoreArray);

    public Task<PoMiniGames.Domain.Models.MarbleRaceMapRecord[]?> GetMarbleRaceMapRecordsAsync() =>
        GetOrDefaultAsync("/api/marblerace/records", ApiJsonContext.Default.MarbleRaceMapRecordArray);

    public Task<PoMiniGames.Domain.Models.MarbleRaceMapRecord[]?> GetMarbleRaceDailyTimesAsync(int count = 10) =>
        GetOrDefaultAsync($"/api/marblerace/daily?count={count}", ApiJsonContext.Default.MarbleRaceMapRecordArray);

    public Task<ScoreSubmitResult<object>> SubmitMarbleRaceMapRecordAsync(MarbleRaceRecordRequest request) =>
        PostScoreAsync("/api/marblerace/records", request, ApiJsonContext.Default.MarbleRaceRecordRequest);

    public Task<ScoreSubmitResult<MarbleRaceHighScore>> SubmitMarbleRaceHighScoreAsync(MarbleRaceHighScoreRequest entry) =>
        PostScoreAsync(
            "/api/marblerace/highscores",
            entry,
            ApiJsonContext.Default.MarbleRaceHighScoreRequest,
            ApiJsonContext.Default.MarbleRaceHighScore);

    // ── PoCabinet & PoRacer ───────────────────────────────────────────────

    public Task<ScoreSubmitResult<object>> SubmitPoCabinetHighScoreAsync(PoCabinetHighScoreRequest entry) =>
        PostScoreAsync("/api/pocabinet/scores", entry, ApiJsonContext.Default.PoCabinetHighScoreRequest);

    public async Task<ScoreSubmitResult<PoRacerScoreDto>> SubmitPoRacerScoreAsync(
        PoRacerScoreDto entry, CancellationToken cancellationToken = default)
    {
        try
        {
            using var response = await _http.PostAsJsonAsync(
                "/api/poracer/scores", entry, ApiJsonContext.Default.PoRacerScoreDto, cancellationToken);
            if (response.IsSuccessStatusCode)
                return ScoreSubmitResult<PoRacerScoreDto>.Saved(entry);
            if (response.StatusCode is HttpStatusCode.RequestTimeout or HttpStatusCode.TooManyRequests or HttpStatusCode.Unauthorized)
                return ScoreSubmitResult<PoRacerScoreDto>.Unavailable(response.StatusCode);
            if ((int)response.StatusCode is >= 400 and < 500)
                return ScoreSubmitResult<PoRacerScoreDto>.Rejected(response.StatusCode);
            return ScoreSubmitResult<PoRacerScoreDto>.Unavailable(response.StatusCode);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException)
        {
            return ScoreSubmitResult<PoRacerScoreDto>.Unavailable(null);
        }
    }

    // ── PoVoxelStrike & PoMule ────────────────────────────────────────────

    public Task<PoMiniGames.Domain.Models.PoVoxelStrikeHighScore[]?> GetPoVoxelStrikeHighScoresAsync(int count = 10, string? day = null) =>
        GetOrDefaultAsync(
            $"/api/povoxelstrike/highscores?count={count}{(day is null ? "" : $"&day={day}")}",
            ApiJsonContext.Default.PoVoxelStrikeHighScoreArray);

    public Task<ScoreSubmitResult<PoMiniGames.Domain.Models.PoVoxelStrikeHighScore>> SubmitPoVoxelStrikeRunAsync(
        PoVoxelStrikeRunRequest entry) =>
        PostScoreAsync(
            "/api/povoxelstrike/highscores",
            entry,
            ApiJsonContext.Default.PoVoxelStrikeRunRequest,
            ApiJsonContext.Default.PoVoxelStrikeHighScore);

    public Task<ScoreSubmitResult<PoMiniGames.Domain.Models.PoMuleHighScore>> SubmitPoMuleRunAsync(PoMuleRunRequest entry) =>
        PostScoreAsync(
            "/api/pomule/highscores",
            entry,
            ApiJsonContext.Default.PoMuleRunRequest,
            ApiJsonContext.Default.PoMuleHighScore);

    // ── PoBrawl ───────────────────────────────────────────────────────────

    public Task<PoBrawlHighScore[]?> GetPoBrawlHighScoresAsync(int count = 10) =>
        GetOrDefaultAsync($"/api/pobrawl/highscores?count={count}", ApiJsonContext.Default.PoBrawlHighScoreArray);

    public Task<ScoreSubmitResult<PoBrawlHighScore>> SubmitPoBrawlHighScoreAsync(PoBrawlHighScore entry)
    {
        if (string.IsNullOrEmpty(entry.Date))
            entry = entry with { Date = DateTime.UtcNow.ToString("O") };
        return PostScoreAsync(
            "/api/pobrawl/highscores",
            entry,
            ApiJsonContext.Default.PoBrawlHighScore,
            ApiJsonContext.Default.PoBrawlHighScore,
            retryAuthThrottle: true);
    }

    public async Task<PoBrawlLadderEntry?> SubmitPoBrawlLadderAsync(PoBrawlLadderEntry entry)
    {
        try
        {
            if (string.IsNullOrEmpty(entry.Date))
                entry = entry with { Date = DateTime.UtcNow.ToString("O") };
            using var response = await _http.PostAsJsonAsync("/api/pobrawl/ladder", entry, ApiJsonContext.Default.PoBrawlLadderEntry);
            return response.IsSuccessStatusCode ? await response.Content.ReadFromJsonAsync(ApiJsonContext.Default.PoBrawlLadderEntry) : null;
        }
        catch
        {
            return null;
        }
    }

    public Task<List<PoBrawlDossierDto>?> GetPoBrawlDossiersAsync() =>
        GetOrDefaultAsync("/api/pobrawl/dossier", ApiJsonContext.Default.ListPoBrawlDossierDto);

    public async Task<PoBrawlProgressDto?> GetPoBrawlProgressAsync()
    {
        try
        {
            var response = await _http.GetAsync("/api/pobrawl/progress");
            return response.IsSuccessStatusCode && response.StatusCode != HttpStatusCode.NoContent
                ? await response.Content.ReadFromJsonAsync(ApiJsonContext.Default.PoBrawlProgressDto)
                : null;
        }
        catch
        {
            return null;
        }
    }

    public async Task SavePoBrawlProgressAsync(PoBrawlProgressDto progress)
    {
        try
        {
            await _http.PutAsJsonAsync("/api/pobrawl/progress", progress, ApiJsonContext.Default.PoBrawlProgressDto);
        }
        catch
        {
            // Offline: the local copy stands, and the next save carries the rung.
        }
    }

    public async Task<bool> SubmitPoBrawlDemoResultAsync(PoBrawlDemoResultRequest request)
    {
        try
        {
            using var response = await _http.PostAsJsonAsync(
                "/api/pobrawl/elo", request, ApiJsonContext.Default.PoBrawlDemoResultRequest);
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>One finished PoFighter tournament bout for the fighter Elo board.</summary>
    public async Task<bool> SubmitPoFighterBoutAsync(PoFighterBoutResultRequest request)
    {
        try
        {
            using var response = await _http.PostAsJsonAsync(
                "/api/pofighter/elo", request, ApiJsonContext.Default.PoFighterBoutResultRequest);
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>The PoFighter fighter Elo board (fighters that have fought), or empty offline.</summary>
    public async Task<PoFighterFighterRating[]> GetPoFighterRatingsAsync()
    {
        try
        {
            return await _http.GetFromJsonAsync("/api/pofighter/elo", ApiJsonContext.Default.PoFighterFighterRatingArray) ?? [];
        }
        catch
        {
            return [];
        }
    }

    /// <summary>A built-in fighter's last rated bouts, newest first (the dossier), or empty offline.</summary>
    public async Task<PoFighterBout[]> GetPoFighterBoutsAsync(string fighterId)
    {
        try
        {
            return await _http.GetFromJsonAsync($"/api/pofighter/elo/{Uri.EscapeDataString(fighterId)}/bouts",
                ApiJsonContext.Default.PoFighterBoutArray) ?? [];
        }
        catch
        {
            return [];
        }
    }

    public async Task<bool> SubmitPoBrawlOnlineMatchAsync(PoBrawlMatchResultDto result)
    {
        var deadline = DateTime.UtcNow + OnlineMatchRetryBudget;
        while (true)
        {
            TimeSpan wait;
            try
            {
                using var response = await _http.PostAsJsonAsync(
                    "/api/pobrawl/matches", result, ApiJsonContext.Default.PoBrawlMatchResultDto);
                if (response.IsSuccessStatusCode) return true;
                var status = (int)response.StatusCode;
                if (status is >= 400 and < 500 and not 408 and not 429) return false;
                wait = response.Headers.RetryAfter?.Delta ?? OnlineMatchRetryDefault;
            }
            catch
            {
                wait = OnlineMatchRetryDefault;
            }
            wait = TimeSpan.FromSeconds(Math.Clamp(wait.TotalSeconds, 1, 15));
            if (DateTime.UtcNow + wait > deadline) return false;
            await Task.Delay(wait);
        }
    }

    private static readonly TimeSpan OnlineMatchRetryBudget = TimeSpan.FromSeconds(80);
    private static readonly TimeSpan OnlineMatchRetryDefault = TimeSpan.FromSeconds(5);

    // ── PoFunQuiz ─────────────────────────────────────────────────────────

    public Task<FunQuizLeaderboardRow[]?> GetFunQuizLeaderboardAsync(string category, int top = 20) =>
        GetOrDefaultAsync(
            $"/api/funquiz/leaderboard?category={Uri.EscapeDataString(category)}&top={top}",
            ApiJsonContext.Default.FunQuizLeaderboardRowArray);

    public Task<ScoreSubmitResult<object>> SubmitFunQuizScoreAsync(FunQuizLeaderboardSubmission entry) =>
        PostScoreAsync("/api/funquiz/leaderboard", entry, ApiJsonContext.Default.FunQuizLeaderboardSubmission);

    public async Task<FunQuizQuestionsResult> GetFunQuizQuestionsAsync(string category, int count = 10, CancellationToken ct = default)
    {
        var url = $"/api/funquiz/quiz/questions?count={count}&category={Uri.EscapeDataString(category)}";
        using var response = await _http.GetAsync(url, ct);
        if ((int)response.StatusCode == 429)
        {
            var retry = 3;
            if (response.Headers.TryGetValues("Retry-After", out var vals)
                && int.TryParse(vals.FirstOrDefault(), out var secs) && secs > 0)
            {
                retry = secs;
            }
            return new FunQuizQuestionsResult([], 429, retry, "Rate limited");
        }
        if (!response.IsSuccessStatusCode)
        {
            var msg = await ProblemDetailsParser.ReadMessageAsync(response, $"HTTP {(int)response.StatusCode}", ct);
            return new FunQuizQuestionsResult([], (int)response.StatusCode, 0, msg);
        }
        var questions = await response.Content.ReadFromJsonAsync(ApiJsonContext.Default.ListQuizQuestion, ct);
        return new FunQuizQuestionsResult(questions ?? [], (int)response.StatusCode, 0, null);
    }
}

public sealed record FunQuizQuestionsResult(
    List<QuizQuestion> Questions,
    int StatusCode,
    int RetryAfterSeconds,
    string? ErrorMessage);
