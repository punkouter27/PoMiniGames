using System.Net.Http.Json;

namespace PoMiniGamesClient.Services.Http;

/// <summary>Parses RFC 7807 ProblemDetails / validation responses using source-generated JSON.</summary>
public static class ProblemDetailsParser
{
    public static async Task<string> ReadMessageAsync(HttpResponseMessage response, string fallback, CancellationToken ct = default)
    {
        try
        {
            var problem = await response.Content.ReadFromJsonAsync(ApiJsonContext.Default.ProblemDetailsDto, ct);
            if (problem?.Errors is { Count: > 0 })
            {
                var first = problem.Errors.SelectMany(kv => kv.Value).FirstOrDefault(m => !string.IsNullOrWhiteSpace(m));
                if (!string.IsNullOrWhiteSpace(first))
                {
                    return first;
                }
            }
            if (!string.IsNullOrWhiteSpace(problem?.Detail))
            {
                return problem.Detail;
            }
            if (!string.IsNullOrWhiteSpace(problem?.Title))
            {
                return problem.Title;
            }
        }
        catch
        {
            // Non-JSON error body
        }

        return fallback;
    }
}
