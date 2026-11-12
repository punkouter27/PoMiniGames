using System.Text.Json.Serialization;

namespace PoMiniGames.Shared.Dtos;

/// <summary>RFC 7807 ProblemDetails payload returned by API validation/error responses.</summary>
public sealed class ProblemDetailsDto
{
    [JsonPropertyName("title")]
    public string? Title { get; set; }

    [JsonPropertyName("detail")]
    public string? Detail { get; set; }

    [JsonPropertyName("status")]
    public int? Status { get; set; }

    [JsonPropertyName("errors")]
    public Dictionary<string, string[]>? Errors { get; set; }
}
