using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Serialization.Metadata;
using PoMiniGames.Shared.Dtos;
using PoMiniGamesClient.Models;
using PoMiniGamesClient.Services.Play;

namespace PoMiniGamesClient.Services.Http;

/// <summary>
/// Platform-wide HTTP client with shared JSON helpers, offline resilience classification,
/// and core endpoints (health, account, player stats, leaderboards, match history, cards).
/// Game-specific score endpoints live in <c>ApiService.Games.cs</c>.
/// </summary>
public partial class ApiService
{
    private readonly HttpClient _http;
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(5);

    public ApiService(HttpClient http)
    {
        _http = http;
    }

    private async Task<T?> GetOrDefaultAsync<T>(string url, JsonTypeInfo<T> typeInfo, CancellationToken ct = default)
    {
        try
        {
            return await _http.GetFromJsonAsync(url, typeInfo, ct);
        }
        catch
        {
            return default;
        }
    }

    private async Task<ScoreSubmitResult<object>> PostScoreAsync<TBody>(
        string url, TBody body, JsonTypeInfo<TBody> bodyType, CancellationToken ct = default)
    {
        try
        {
            using var response = await _http.PostAsJsonAsync(url, body, bodyType, ct);
            if (response.IsSuccessStatusCode)
                return ScoreSubmitResult<object>.Saved(null);
            if ((int)response.StatusCode is >= 400 and < 500)
                return ScoreSubmitResult<object>.Rejected(response.StatusCode);
            return ScoreSubmitResult<object>.Unavailable(response.StatusCode);
        }
        catch
        {
            return ScoreSubmitResult<object>.Unavailable(null);
        }
    }

    private async Task<ScoreSubmitResult<TResult>> PostScoreAsync<TBody, TResult>(
        string url, TBody body, JsonTypeInfo<TBody> bodyType, JsonTypeInfo<TResult> resultType,
        bool retryAuthThrottle = false, CancellationToken ct = default) where TResult : class
    {
        try
        {
            using var response = await _http.PostAsJsonAsync(url, body, bodyType, ct);
            if (response.IsSuccessStatusCode)
            {
                var saved = await response.Content.ReadFromJsonAsync(resultType, ct);
                return ScoreSubmitResult<TResult>.Saved(saved);
            }

            if (retryAuthThrottle && response.StatusCode is HttpStatusCode.RequestTimeout
                    or HttpStatusCode.TooManyRequests or HttpStatusCode.Unauthorized)
            {
                return ScoreSubmitResult<TResult>.Unavailable(response.StatusCode);
            }

            if ((int)response.StatusCode is >= 400 and < 500)
                return ScoreSubmitResult<TResult>.Rejected(response.StatusCode);

            return ScoreSubmitResult<TResult>.Unavailable(response.StatusCode);
        }
        catch
        {
            return ScoreSubmitResult<TResult>.Unavailable(null);
        }
    }

    public async Task<bool> IsAvailableAsync()
    {
        try
        {
            using var cts = new CancellationTokenSource(Timeout);
            var response = await _http.GetAsync("/api/health/ping", cts.Token);
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    public Task<PlayerStatsDto?> GetPlayerStatsAsync(string game, string playerName) =>
        GetOrDefaultAsync($"/api/{game}/players/{Uri.EscapeDataString(playerName)}/stats", ApiJsonContext.Default.PlayerStatsDto);

    public async Task<(bool Ok, int Status)> SavePlayerStatsAsync(string game, string playerName, PlayerStats stats)
    {
        try
        {
            var response = await _http.PutAsJsonAsync(
                $"/api/{game}/players/{Uri.EscapeDataString(playerName)}/stats", stats, ApiJsonContext.Default.PlayerStats);
            return (response.IsSuccessStatusCode, (int)response.StatusCode);
        }
        catch
        {
            return (false, 0);
        }
    }

    // ── Account data (export / erase) ─────────────────────────────────────

    public async Task<string?> ExportAccountDataAsync()
    {
        try
        {
            var response = await _http.GetAsync("/api/account/export");
            return response.IsSuccessStatusCode
                ? await response.Content.ReadAsStringAsync()
                : null;
        }
        catch
        {
            return null;
        }
    }

    public async Task<AccountDeletionDto?> EraseAccountDataAsync()
    {
        try
        {
            var response = await _http.DeleteAsync("/api/account/data");
            return response.IsSuccessStatusCode
                ? await response.Content.ReadFromJsonAsync(ApiJsonContext.Default.AccountDeletionDto)
                : null;
        }
        catch
        {
            return null;
        }
    }

    // ── Leaderboards ──────────────────────────────────────────────────────

    public Task<GameLeaderboardDto[]?> GetAllLeaderboardsAsync(int limit = 5, bool weekly = false) =>
        GetOrDefaultAsync(
            $"/api/leaderboards?limit={limit}{(weekly ? "&period=week" : "")}",
            ApiJsonContext.Default.GameLeaderboardDtoArray);

    public Task<GameLeaderboardDto?> GetGameLeaderboardAsync(string game, int limit = 3, bool weekly = false) =>
        GetOrDefaultAsync(
            $"/api/leaderboards/{game}?limit={limit}{(weekly ? "&period=week" : "")}",
            ApiJsonContext.Default.GameLeaderboardDto);

    // ── Head-to-head match history ────────────────────────────────────────

    public async Task<bool> RecordMatchAsync(MatchRecordRequest request)
    {
        try
        {
            var response = await _http.PostAsJsonAsync("/api/matches", request, ApiJsonContext.Default.MatchRecordRequest);
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    public Task<MatchRecordDto[]?> GetMatchesAsync(string owner, int limit = 500) =>
        GetOrDefaultAsync(
            $"/api/matches?owner={Uri.EscapeDataString(owner)}&limit={limit}",
            ApiJsonContext.Default.MatchRecordDtoArray);

    // ── Player License Cards ──────────────────────────────────────────────

    public Task<PoMiniGames.Domain.Models.PlayerCardDto?> GetPlayerCardAsync(string? name = null) =>
        GetOrDefaultAsync(
            string.IsNullOrWhiteSpace(name) ? "/api/player/card" : $"/api/player/card?name={Uri.EscapeDataString(name)}",
            ApiJsonContext.Default.PlayerCardDto);

    public async Task<string?> GetPlayerCardSvgAsync(string? name = null)
    {
        try
        {
            var url = string.IsNullOrWhiteSpace(name)
                ? "/api/player/card/svg"
                : $"/api/player/card/svg?name={Uri.EscapeDataString(name)}";
            return await _http.GetStringAsync(url);
        }
        catch
        {
            return null;
        }
    }

    // ── Health Report ─────────────────────────────────────────────────────

    public async Task<(HealthReportDto? Report, string? Error)> GetHealthReportAsync(CancellationToken ct = default)
    {
        try
        {
            using var response = await _http.GetAsync("/api/health", ct);
            var report = await response.Content.ReadFromJsonAsync(
                ApiJsonContext.Default.HealthReportDto, ct);
            return (report, null);
        }
        catch (OperationCanceledException)
        {
            return (null, null);
        }
        catch (Exception ex)
        {
            return (null, ex.Message);
        }
    }
}
