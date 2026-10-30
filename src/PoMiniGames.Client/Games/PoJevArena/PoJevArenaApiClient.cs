using System.Net;
using System.Net.Http.Json;
using System.Text;
using PoMiniGames.Shared.Games.PoJevArena;

namespace PoMiniGamesClient.Games.PoJevArena;

/// <summary>A library write's outcome: the saved creature, or the server's stable error code.</summary>
public sealed record LibraryResult(ArenaCreature? Creature, string? Error)
{
    public bool Ok => Error is null;
}

/// <summary>
/// The arena's server surface. Uses the app's shared <see cref="HttpClient"/>, so the antiforgery
/// header and credentials ride along on every write (see Client/Program.cs for the handler order),
/// and every call is best-effort: null/empty/an error code on failure, never a throw through a render.
/// </summary>
public sealed class PoJevArenaApiClient(HttpClient http)
{
    private static readonly PoJevArenaJsonContext Json = PoJevArenaJsonContext.Default;

    public async Task<ArenaStatus?> StatusAsync(CancellationToken ct = default)
    {
        try { return await http.GetFromJsonAsync("/api/pojevarena/status", Json.ArenaStatus, ct); }
        catch { return null; }
    }

    /// <returns>The listing, or null when the library is unreachable (the page shows "offline").</returns>
    public async Task<ArenaCreature[]?> ListCreaturesAsync(string sort, string? query, CancellationToken ct = default)
    {
        try
        {
            var url = $"/api/pojevarena/creatures?sort={Uri.EscapeDataString(sort)}";
            if (!string.IsNullOrWhiteSpace(query)) url += $"&q={Uri.EscapeDataString(query.Trim())}";
            using var response = await http.GetAsync(url, ct);
            return response.IsSuccessStatusCode ? await response.Content.ReadFromJsonAsync(Json.ArenaCreatureArray, ct) ?? [] : null;
        }
        catch { return null; }
    }

    public Task<LibraryResult> CreateAsync(ArenaCreatureDraft draft, CancellationToken ct = default) =>
        WriteAsync(() => http.PostAsJsonAsync("/api/pojevarena/creatures", draft, Json.ArenaCreatureDraft, ct), ct);

    public Task<LibraryResult> UpdateAsync(string id, ArenaCreatureDraft draft, CancellationToken ct = default) =>
        WriteAsync(() => http.PutAsJsonAsync($"/api/pojevarena/creatures/{Uri.EscapeDataString(id)}", draft, Json.ArenaCreatureDraft, ct), ct);

    public async Task<string?> DeleteAsync(string id, CancellationToken ct = default)
    {
        try
        {
            using var response = await http.DeleteAsync($"/api/pojevarena/creatures/{Uri.EscapeDataString(id)}", ct);
            return response.IsSuccessStatusCode ? null : await ErrorCodeAsync(response, ct);
        }
        catch { return "network"; }
    }

    public async Task<(ArenaMatchTicket? Ticket, string? Error)> RegisterMatchAsync(ArenaMatchRequest request, CancellationToken ct = default)
    {
        try
        {
            using var response = await http.PostAsJsonAsync("/api/pojevarena/matches", request, Json.ArenaMatchRequest, ct);
            if (!response.IsSuccessStatusCode) return (null, await ErrorCodeAsync(response, ct));
            return (await response.Content.ReadFromJsonAsync(Json.ArenaMatchTicket, ct), null);
        }
        catch { return (null, "network"); }
    }

    /// <summary>
    /// The engine's decision round trip, JSON in and JSON out: the batch the JS scheduler built
    /// goes to the server as-is and the response comes back as-is. Failures become
    /// <c>{"error":"…"}</c>, the shape scheduler.js understands (it stops on account-level codes).
    /// </summary>
    public async Task<string> DecideRawAsync(string matchId, string batchJson, CancellationToken ct = default)
    {
        try
        {
            using var content = new StringContent(batchJson, Encoding.UTF8, "application/json");
            using var response = await http.PostAsync($"/api/pojevarena/matches/{Uri.EscapeDataString(matchId)}/decisions", content, ct);
            if (response.IsSuccessStatusCode) return await response.Content.ReadAsStringAsync(ct);

            var error = response.StatusCode switch
            {
                HttpStatusCode.TooManyRequests => "rate-limited",
                HttpStatusCode.NotFound => "match-expired",
                HttpStatusCode.ServiceUnavailable => "arena-unavailable",
                _ => $"http-{(int)response.StatusCode}",
            };
            return $$"""{"error":"{{error}}"}""";
        }
        catch (OperationCanceledException) { return """{"error":"cancelled"}"""; }
        catch { return """{"error":"network"}"""; }
    }

    public async Task<string?> ReportResultAsync(string matchId, ArenaMatchResult result, CancellationToken ct = default)
    {
        try
        {
            using var response = await http.PostAsJsonAsync(
                $"/api/pojevarena/matches/{Uri.EscapeDataString(matchId)}/result", result, Json.ArenaMatchResult, ct);
            return response.IsSuccessStatusCode ? null : await ErrorCodeAsync(response, ct);
        }
        catch { return "network"; }
    }

    private static async Task<LibraryResult> WriteAsync(Func<Task<HttpResponseMessage>> send, CancellationToken ct)
    {
        try
        {
            using var response = await send();
            if (!response.IsSuccessStatusCode) return new LibraryResult(null, await ErrorCodeAsync(response, ct));
            return new LibraryResult(await response.Content.ReadFromJsonAsync(Json.ArenaCreature, ct), null);
        }
        catch { return new LibraryResult(null, "network"); }
    }

    /// <summary>The server's problem <c>title</c> is the stable error code (e.g. <c>library-limit</c>, <c>budget</c>).</summary>
    private static async Task<string> ErrorCodeAsync(HttpResponseMessage response, CancellationToken ct)
    {
        try
        {
            var body = await response.Content.ReadAsStringAsync(ct);
            using var doc = System.Text.Json.JsonDocument.Parse(body);
            if (doc.RootElement.TryGetProperty("title", out var title) && title.GetString() is { Length: > 0 } code) return code;
        }
        catch
        {
            // Not a problem document; fall through to the status code.
        }
        return $"http-{(int)response.StatusCode}";
    }
}
