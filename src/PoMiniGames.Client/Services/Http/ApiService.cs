using PoMiniGames.Shared.Dtos;
using PoMiniGames.Shared.Games;
using System.Net.Http.Json;
// Alias, not a namespace import: PoMiniGamesClient.Models mirrors several other Domain
// types by name, so importing the namespace wholesale would make them all ambiguous.
using PoMiniGamesClient.Models;

using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Http;

public class ApiService
{
    private readonly HttpClient _http;
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(5);

    public ApiService(HttpClient http)
    {
        _http = http;
    }

    /// <summary>
    /// Attaches (or clears) the Microsoft access token as the default bearer for every
    /// subsequent API call, so authenticated endpoints work after MSAL sign-in.
    /// </summary>
    public void SetBearer(string? token)
    {
        HubConnectionFactory.BearerToken = string.IsNullOrEmpty(token) ? null : token;
        _http.DefaultRequestHeaders.Authorization = string.IsNullOrEmpty(token)
            ? null
            : new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
    }

    public async Task<bool> IsAvailableAsync()
    {
        try
        {
            using var cts = new CancellationTokenSource(Timeout);
            // /api/health/ping is the cheapest possible liveness probe — no JSON,
            // no health-check service, just "200 OK / pong". Kept as the platform's
            // off-line detection sentinel; for richer diagnostics use /api/health.
            var response = await _http.GetAsync("/api/health/ping", cts.Token);
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Single round-trip that returns the auth client config + (when a session
    /// cookie exists) the canonical user profile, so AuthGate can hydrate with one RTT.
    /// A bare try/catch returning null on every failure would conflate the
    /// ERR_ABORTED that fires when a navigation tears down the in-flight
    /// request with the X-Reauth header that signals a stale-cookie unprotect
    /// failure. Both surface as distinct exceptions so the caller can
    /// keep the previous user on a transient abort and force a fresh dev
    /// login on a reauth signal.
    /// </summary>
    public async Task<AuthHandshake?> GetAuthHandshakeAsync()
    {
        AuthHandshakeReauthRequiredException? reauth = null;
        try
        {
            using var response = await _http.GetAsync("/api/auth/handshake");
            if (response.Headers.TryGetValues("X-Reauth", out var reauthHeader)
                && reauthHeader.Any(v => v == "1"))
            {
                // The server's data-protection key ring was rebuilt; the
                // cookie we sent is no longer decryptable. The caller must
                // trigger a fresh dev-login so the user isn't stranded on
                // a stale identity.
                reauth = new AuthHandshakeReauthRequiredException("Auth cookie no longer decryptable");
            }
            if (reauth is not null) throw reauth;
            if (!response.IsSuccessStatusCode)
            {
                return null;
            }
            return await response.Content.ReadFromJsonAsync(ApiJsonContext.Default.AuthHandshake);
        }
        catch (HttpRequestException ex) when (ex.StatusCode is null)
        {
            // Transport-level failure (DNS, connection refused, aborted
            // navigation). Surface so the caller can keep the previous
            // identity and show a "Reconnecting…" hint.
            throw new AuthHandshakeUnavailableException("Auth handshake unreachable", ex);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Auth-side failure (5xx, schema drift, etc). Same surface as
            // before: clear state and let the caller re-hydrate.
            return null;
        }

    }

    /// <summary>
    /// Thrown when the auth handshake can't be reached at the transport layer
    /// (no HTTP response — e.g. aborted by navigation, DNS, connection refused).
    /// AuthStateService treats this as transient: keep the previous user rather
    /// than blanking the header on a navigation race.
    /// </summary>
    public sealed class AuthHandshakeUnavailableException : Exception
    {
        public AuthHandshakeUnavailableException(string message, Exception inner) : base(message, inner) { }
    }

    /// <summary>
    /// Thrown when the server responded 401 with <c>X-Reauth: 1</c>, meaning the
    /// data-protection key ring was rebuilt and the existing DevCookie can no
    /// longer be unprotected. AuthStateService treats this as a forced
    /// re-login: issue a fresh guest identity before continuing.
    /// </summary>
    public sealed class AuthHandshakeReauthRequiredException : Exception
    {
        public AuthHandshakeReauthRequiredException(string message) : base(message) { }
    }

    public async Task<AuthenticatedUserProfile?> DevLoginAsync(DevLoginRequest? request = null)
    {
        try
        {
            var response = await _http.PostAsJsonAsync("/api/auth/dev-login", request ?? new DevLoginRequest(), ApiJsonContext.Default.DevLoginRequest);
            return response.IsSuccessStatusCode ? await response.Content.ReadFromJsonAsync(ApiJsonContext.Default.AuthenticatedUserProfile) : null;
        }
        catch
        {
            return null;
        }
    }

    public async Task<AuthenticatedUserProfile?> DevBypassAsync(string? userName = null)
    {
        var name = string.IsNullOrWhiteSpace(userName) ? "Dev Admin" : userName;
        // Only the name is sent. The server suffixes it and derives the user id and email from
        // the suffixed form, so two guests never share an id. Pinning the id here ("dev-guest")
        // made every guest the same player: one profile, one row per board.
        return await DevLoginAsync(new DevLoginRequest { DisplayName = name });
    }

    public async Task<bool> DevLogoutAsync()
    {
        try
        {
            var response = await _http.PostAsync("/api/auth/dev-logout", null);
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    public async Task<AuthenticatedUserProfile?> GetAuthenticatedUserAsync(string? accessToken = null)
    {
        try
        {
            var request = new HttpRequestMessage(HttpMethod.Get, "/api/auth/me");
            if (!string.IsNullOrEmpty(accessToken))
                request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", accessToken);

            var response = await _http.SendAsync(request);
            return response.IsSuccessStatusCode ? await response.Content.ReadFromJsonAsync(ApiJsonContext.Default.AuthenticatedUserProfile) : null;
        }
        catch
        {
            return null;
        }
    }

    public async Task<PlayerStatsDto?> GetPlayerStatsAsync(string game, string playerName)
    {
        try
        {
            return await _http.GetFromJsonAsync(
                $"/api/{game}/players/{Uri.EscapeDataString(playerName)}/stats", ApiJsonContext.Default.PlayerStatsDto);
        }
        catch
        {
            return null;
        }
    }

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
    // Both are deliberately slow-path: they run a cross-table scan server-side, are rate
    // limited to 5/min, and are only ever triggered by an explicit click on the profile page.

    /// <summary>
    /// Downloads every row the platform stores about the signed-in caller, as raw JSON.
    /// </summary>
    /// <remarks>
    /// Returned as a string rather than a parsed object on purpose: the caller hands it straight
    /// to the browser to save, and parsing it into a typed shape here would mean registering the
    /// whole export schema with the source-generated context for no benefit — the client never
    /// reads a field of it.
    /// </remarks>
    public async Task<string?> ExportAccountDataAsync()
    {
        try
        {
            // No timeout: unlike the 5s probes above, this scans every board's partition and a
            // cold F1 instance can genuinely take longer than that to answer.
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

    /// <summary>
    /// Permanently erases the caller's stored rows. Returns the per-table counts, or null when
    /// the request did not reach the server — the distinction matters to the caller, which must
    /// not report "erased" for a call that never landed.
    /// </summary>
    public async Task<AccountDeletionDto?> EraseAccountDataAsync()
    {
        try
        {
            var response = await _http.DeleteAsync("/api/account/data");
            if (!response.IsSuccessStatusCode)
            {
                return null;
            }

            return await response.Content.ReadFromJsonAsync(ApiJsonContext.Default.AccountDeletionDto);
        }
        catch
        {
            return null;
        }
    }


    /// <summary>Normalized leaderboards for every game in one round-trip (home preview, /leaderboards hub).</summary>
    /// <param name="weekly">True for this ISO week's boards (only the high-score boards have one).</param>
    public async Task<GameLeaderboardDto[]?> GetAllLeaderboardsAsync(int limit = 5, bool weekly = false)
    {
        try
        {
            return await _http.GetFromJsonAsync(
                $"/api/leaderboards?limit={limit}{(weekly ? "&period=week" : "")}", ApiJsonContext.Default.GameLeaderboardDtoArray);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// One game's normalized leaderboard. Backs the top-3 board that the shared
    /// GameShell renders inside every end-of-game modal, so the unit and ordering
    /// come from the server rather than each game re-deriving them.
    /// Returns null when the game has no board (404) or the API is offline — the
    /// modal simply omits the section.
    /// </summary>
    public async Task<GameLeaderboardDto?> GetGameLeaderboardAsync(string game, int limit = 3, bool weekly = false)
    {
        try
        {
            return await _http.GetFromJsonAsync(
                $"/api/leaderboards/{game}?limit={limit}{(weekly ? "&period=week" : "")}", ApiJsonContext.Default.GameLeaderboardDto);
        }
        catch
        {
            return null;
        }
    }

    public async Task<MarbleRaceHighScore[]?> GetMarbleRaceHighScoresAsync(int count = 10)
    {
        try
        {
            return await _http.GetFromJsonAsync(
                // Route kept as /api/marblerace/ despite the game being PoMarbleRace
                // everywhere else. It is a live HTTP contract, and the PWA service worker
                // can serve a cached older client after a deploy — that client would call
                // the old path and 404. GameKey's alias table canonicalises the identifier
                // where it matters (leaderboards/stats); the URL is left alone deliberately.
                $"/api/marblerace/highscores?count={count}", ApiJsonContext.Default.MarbleRaceHighScoreArray);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>The fastest finish on each PoMarbleRace map (the track picker's world records).</summary>
    public async Task<PoMiniGames.Domain.Models.MarbleRaceMapRecord[]?> GetMarbleRaceMapRecordsAsync()
    {
        try
        {
            return await _http.GetFromJsonAsync("/api/marblerace/records", ApiJsonContext.Default.MarbleRaceMapRecordArray);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Offers one finish as a map record. Fire-and-forget by design: a record that fails to post is
    /// not parked for retry the way a run score is — the next good finish offers itself anyway.
    /// </summary>
    public async Task<ScoreSubmitResult<object>> SubmitMarbleRaceMapRecordAsync(MarbleRaceRecordRequest request)
    {
        try
        {
            using var response = await _http.PostAsJsonAsync("/api/marblerace/records", request, ApiJsonContext.Default.MarbleRaceRecordRequest);
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

    /// <summary>
    /// Submits a PoMarbleRace score. The outcome distinguishes "retry later" from "never retry":
    /// collapsing both into null meant a server that rejected every submission was indistinguishable
    /// from being offline, so scores were parked in the sync queue forever and the player was told
    /// they were offline while online.
    /// </summary>
    public async Task<ScoreSubmitResult<MarbleRaceHighScore>> SubmitMarbleRaceHighScoreAsync(MarbleRaceHighScoreRequest entry)
    {
        try
        {
            var response = await _http.PostAsJsonAsync(
                "/api/marblerace/highscores", entry, ApiJsonContext.Default.MarbleRaceHighScoreRequest);

            if (response.IsSuccessStatusCode)
            {
                var saved = await response.Content.ReadFromJsonAsync(ApiJsonContext.Default.MarbleRaceHighScore);
                return ScoreSubmitResult<MarbleRaceHighScore>.Saved(saved);
            }

            // 4xx: the payload itself is the problem, so replaying it just wedges the queue.
            if ((int)response.StatusCode is >= 400 and < 500)
                return ScoreSubmitResult<MarbleRaceHighScore>.Rejected(response.StatusCode);

            return ScoreSubmitResult<MarbleRaceHighScore>.Unavailable(response.StatusCode);
        }
        catch
        {
            // No response at all — genuinely offline/unreachable.
            return ScoreSubmitResult<MarbleRaceHighScore>.Unavailable(null);
        }
    }

    /// <summary>
    /// Submits a PoCabinet race result. Best-lap ratcheting on
    /// <c>POST /api/pocabinet/scores</c>; validations come back as 4xx when
    /// the payload is malformed, never as 5xx — replaying a 4xx would only
    /// replay the rejection, so a parked score only fires on genuine unavailability.
    /// </summary>
    public async Task<ScoreSubmitResult<object>> SubmitPoCabinetHighScoreAsync(PoCabinetHighScoreRequest entry)
    {
        try
        {
            // The stored row is not read back: the page already shows the result.
            var response = await _http.PostAsJsonAsync(
                "/api/pocabinet/scores", entry, ApiJsonContext.Default.PoCabinetHighScoreRequest);

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

    /// <param name="day">yyyy-MM-dd reads that day's Daily Siege board instead of the all-time one.</param>
    public async Task<PoMiniGames.Domain.Models.PoVoxelStrikeHighScore[]?> GetPoVoxelStrikeHighScoresAsync(int count = 10, string? day = null)
    {
        try
        {
            return await _http.GetFromJsonAsync(
                $"/api/povoxelstrike/highscores?count={count}{(day is null ? "" : $"&day={day}")}",
                ApiJsonContext.Default.PoVoxelStrikeHighScoreArray);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Submits a finished PoVoxelStrike run. Same outcome contract as the Marble submit
    /// above: Saved / Rejected (4xx — never retry) / Unavailable (park and replay).
    /// </summary>
    public async Task<ScoreSubmitResult<PoMiniGames.Domain.Models.PoVoxelStrikeHighScore>> SubmitPoVoxelStrikeRunAsync(
        PoVoxelStrikeRunRequest entry)
    {
        try
        {
            var response = await _http.PostAsJsonAsync(
                "/api/povoxelstrike/highscores", entry, ApiJsonContext.Default.PoVoxelStrikeRunRequest);

            if (response.IsSuccessStatusCode)
            {
                var saved = await response.Content.ReadFromJsonAsync(ApiJsonContext.Default.PoVoxelStrikeHighScore);
                return ScoreSubmitResult<PoMiniGames.Domain.Models.PoVoxelStrikeHighScore>.Saved(saved);
            }

            if ((int)response.StatusCode is >= 400 and < 500)
                return ScoreSubmitResult<PoMiniGames.Domain.Models.PoVoxelStrikeHighScore>.Rejected(response.StatusCode);

            return ScoreSubmitResult<PoMiniGames.Domain.Models.PoVoxelStrikeHighScore>.Unavailable(response.StatusCode);
        }
        catch
        {
            return ScoreSubmitResult<PoMiniGames.Domain.Models.PoVoxelStrikeHighScore>.Unavailable(null);
        }
    }

    /// <summary>
    /// Submits a finished PoMule match. Same outcome contract as the other boards:
    /// Saved / Rejected (4xx, never retry) / Unavailable (park and replay).
    /// </summary>
    public async Task<ScoreSubmitResult<PoMiniGames.Domain.Models.PoMuleHighScore>> SubmitPoMuleRunAsync(PoMuleRunRequest entry)
    {
        try
        {
            var response = await _http.PostAsJsonAsync("/api/pomule/highscores", entry, ApiJsonContext.Default.PoMuleRunRequest);

            if (response.IsSuccessStatusCode)
            {
                var saved = await response.Content.ReadFromJsonAsync(ApiJsonContext.Default.PoMuleHighScore);
                return ScoreSubmitResult<PoMiniGames.Domain.Models.PoMuleHighScore>.Saved(saved);
            }

            if ((int)response.StatusCode is >= 400 and < 500)
                return ScoreSubmitResult<PoMiniGames.Domain.Models.PoMuleHighScore>.Rejected(response.StatusCode);

            return ScoreSubmitResult<PoMiniGames.Domain.Models.PoMuleHighScore>.Unavailable(response.StatusCode);
        }
        catch
        {
            return ScoreSubmitResult<PoMiniGames.Domain.Models.PoMuleHighScore>.Unavailable(null);
        }
    }

    public async Task<PoBrawlHighScore[]?> GetPoBrawlHighScoresAsync(int count = 10)
    {
        try
        {
            return await _http.GetFromJsonAsync(
                $"/api/pobrawl/highscores?count={count}", ApiJsonContext.Default.PoBrawlHighScoreArray);
        }
        catch
        {
            return null;
        }
    }

    public async Task<ScoreSubmitResult<PoMiniGames.Shared.Games.PoRacerScoreDto>> SubmitPoRacerScoreAsync(
        PoMiniGames.Shared.Games.PoRacerScoreDto entry, CancellationToken cancellationToken = default)
    {
        try
        {
            using var response = await _http.PostAsJsonAsync("/api/poracer/scores", entry, ApiJsonContext.Default.PoRacerScoreDto, cancellationToken);
            if (response.IsSuccessStatusCode)
                return ScoreSubmitResult<PoMiniGames.Shared.Games.PoRacerScoreDto>.Saved(entry);
            if (response.StatusCode is System.Net.HttpStatusCode.RequestTimeout or System.Net.HttpStatusCode.TooManyRequests or System.Net.HttpStatusCode.Unauthorized)
                return ScoreSubmitResult<PoMiniGames.Shared.Games.PoRacerScoreDto>.Unavailable(response.StatusCode);
            if ((int)response.StatusCode is >= 400 and < 500)
                return ScoreSubmitResult<PoMiniGames.Shared.Games.PoRacerScoreDto>.Rejected(response.StatusCode);
            return ScoreSubmitResult<PoMiniGames.Shared.Games.PoRacerScoreDto>.Unavailable(response.StatusCode);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException)
        {
            return ScoreSubmitResult<PoMiniGames.Shared.Games.PoRacerScoreDto>.Unavailable(null);
        }
    }

    /// <summary>
    /// Submits a PoBrawl fastest KO. Same outcome contract as PoRacer: Saved / Rejected (a 4xx
    /// other than 401, 408 and 429 — never retry) / Unavailable (park and replay).
    /// </summary>
    public async Task<ScoreSubmitResult<PoBrawlHighScore>> SubmitPoBrawlHighScoreAsync(PoBrawlHighScore entry)
    {
        try
        {
            // Stamp once; preserve across resync so the deterministic RowKey stays stable (no duplicates).
            if (string.IsNullOrEmpty(entry.Date))
                entry = entry with { Date = DateTime.UtcNow.ToString("O") };
            using var response = await _http.PostAsJsonAsync("/api/pobrawl/highscores", entry, ApiJsonContext.Default.PoBrawlHighScore);
            if (response.IsSuccessStatusCode)
                return ScoreSubmitResult<PoBrawlHighScore>.Saved(await response.Content.ReadFromJsonAsync(ApiJsonContext.Default.PoBrawlHighScore));
            if (response.StatusCode is System.Net.HttpStatusCode.RequestTimeout or System.Net.HttpStatusCode.TooManyRequests or System.Net.HttpStatusCode.Unauthorized)
                return ScoreSubmitResult<PoBrawlHighScore>.Unavailable(response.StatusCode);
            if ((int)response.StatusCode is >= 400 and < 500)
                return ScoreSubmitResult<PoBrawlHighScore>.Rejected(response.StatusCode);
            return ScoreSubmitResult<PoBrawlHighScore>.Unavailable(response.StatusCode);
        }
        catch
        {
            return ScoreSubmitResult<PoBrawlHighScore>.Unavailable(null);
        }
    }

    // No GetPoBrawlLadderAsync. The ladder standings reach the UI through the unified
    // board (/api/leaderboards/pobrawl), which GameOverModal already renders as its
    // "Top 3 / Best rung" panel, so no dedicated reader exists here.

    /// <summary>
    /// Submits ladder progress. The server keeps one row per player with
    /// max-progress semantics, so a dropped submit self-heals on the next win —
    /// no offline resync queue needed. The 201 body is the STORED row, which can hold a lower
    /// rung than claimed (the server caps the climb); a 429 (<c>ladder_too_fast</c>) or 503 is
    /// just null. Neither is an error to the player: the local ladder stays authoritative for play.
    /// </summary>
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

    // ─── PoBrawl fighter dossiers ─────────────────────────────────────────

    /// <summary>Every fighter's dossier (anonymous), or null when the API is unreachable.</summary>
    public async Task<List<PoMiniGames.Shared.Games.PoBrawlDossierDto>?> GetPoBrawlDossiersAsync()
    {
        try
        {
            return await _http.GetFromJsonAsync("/api/pobrawl/dossier", ApiJsonContext.Default.ListPoBrawlDossierDto);
        }
        catch
        {
            return null;
        }
    }

    // ─── PoBrawl 1P ladder progress (cross-device) ───────────────────────

    /// <summary>The caller's saved ladder progress, or null (none saved, signed out, offline).</summary>
    public async Task<PoMiniGames.Shared.Games.PoBrawlProgressDto?> GetPoBrawlProgressAsync()
    {
        try
        {
            var response = await _http.GetAsync("/api/pobrawl/progress");
            return response.IsSuccessStatusCode && response.StatusCode != System.Net.HttpStatusCode.NoContent
                ? await response.Content.ReadFromJsonAsync(ApiJsonContext.Default.PoBrawlProgressDto)
                : null;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Save the caller's ladder progress. Fire-and-forget from the page: localStorage already
    /// holds the same numbers, so a failed write only costs the other device the newest rung.
    /// </summary>
    public async Task SavePoBrawlProgressAsync(PoMiniGames.Shared.Games.PoBrawlProgressDto progress)
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

    // ─── PoBrawl demo-mode fighter Elo ───────────────────────────────────

    /// <summary>
    /// Reports one finished CPU-vs-CPU demo match. True when the server took it (204). The
    /// board is read separately, through the unified /api/leaderboards/pobrawldemo route.
    /// </summary>
    /// <remarks>
    /// Deliberately <b>not</b> queued through the offline score-sync pipeline the player
    /// boards use. A rating is priced against the opponent's rating at the time of the
    /// match, so a demo result replayed an hour later would be scored against ratings that
    /// have since moved — a wrong number is worse here than a missing one. Attract-mode
    /// matches are also effectively unlimited, so dropping the ones that fail costs the
    /// board nothing but a little precision. That includes the server's 429s
    /// (<c>demo_too_fast</c>, <c>demo_daily_cap</c>): false; the tournament reports partial
    /// write failures in its closing summary.
    /// </remarks>
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

    // ─── PoBrawl online 1v1 ──────────────────────────────────────────────

    /// <summary>
    /// Reports a finished 1v1 fight to /api/pobrawl/matches. The server reads only the match id,
    /// records a MatchHistory row and applies the Elo swing once per match. True on success (204).
    /// A 503 (the Elo write failed; Retry-After: 5), a 408/429, another 5xx or a dead network is
    /// retried with the same body until <see cref="OnlineMatchRetryBudget"/> runs out — the server
    /// sweeps the finished fight after ~90 s, and a retried POST is idempotent. False on a
    /// rejection (other 4xx) or once the budget is spent.
    /// </summary>
    public async Task<bool> SubmitPoBrawlOnlineMatchAsync(PoMiniGames.Shared.Games.PoBrawlMatchResultDto result)
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

    // Inside the server's ~90 s hold on a finished fight, with room for the last request.
    private static readonly TimeSpan OnlineMatchRetryBudget = TimeSpan.FromSeconds(80);
    private static readonly TimeSpan OnlineMatchRetryDefault = TimeSpan.FromSeconds(5);

    // ─── Head-to-head match history ──────────────────────────────────────

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

    public async Task<MatchRecordDto[]?> GetMatchesAsync(string owner, int limit = 500)
    {
        try
        {
            return await _http.GetFromJsonAsync(
                $"/api/matches?owner={Uri.EscapeDataString(owner)}&limit={limit}", ApiJsonContext.Default.MatchRecordDtoArray);
        }
        catch
        {
            return null;
        }
    }

    // ─── PoFunQuiz leaderboard ───────────────────────────────────────────

    /// <summary>
    /// GET /api/funquiz/leaderboard?category=…&top=… — top scores for a single category.
    /// Returns an empty list when the user is signed out (the endpoint requires auth).
    /// </summary>
    public async Task<FunQuizLeaderboardRow[]?> GetFunQuizLeaderboardAsync(string category, int top = 20)
    {
        try
        {
            return await _http.GetFromJsonAsync(
                $"/api/funquiz/leaderboard?category={Uri.EscapeDataString(category)}&top={top}",
                ApiJsonContext.Default.FunQuizLeaderboardRowArray);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// POST /api/funquiz/leaderboard — submits a solo run. Server clamps Score to
    /// 0..10_000 and overrides PlayerName with the authenticated identity, so a
    /// spoof attempt from the client can't poison the board.
    /// </summary>
    public async Task<ScoreSubmitResult<object>> SubmitFunQuizScoreAsync(FunQuizLeaderboardSubmission entry)
    {
        try
        {
            var response = await _http.PostAsJsonAsync(
                "/api/funquiz/leaderboard", entry, ApiJsonContext.Default.FunQuizLeaderboardSubmission);
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

    /// <summary>
    /// GET /api/player/card — fetches a player's dynamic competitive license card.
    /// </summary>
    public async Task<PoMiniGames.Domain.Models.PlayerCardDto?> GetPlayerCardAsync(string? name = null)
    {
        try
        {
            var url = string.IsNullOrWhiteSpace(name)
                ? "/api/player/card"
                : $"/api/player/card?name={Uri.EscapeDataString(name)}";
            return await _http.GetFromJsonAsync(url, ApiJsonContext.Default.PlayerCardDto);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// GET /api/player/card/svg — fetches raw standalone SVG text for clipboard copy or download.
    /// </summary>
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

    /// <summary>GET /api/health — reads the JSON health report (including 503 degraded/unhealthy bodies).</summary>
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

    /// <summary>GET /api/funquiz/quiz/questions — fetches trivia questions preserving Retry-After throttling.</summary>
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
