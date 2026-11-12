using System.Net.Http.Json;
using System.Text.Json.Serialization;
using PoMiniGames.Shared.Games.PoEcosystem;

namespace PoMiniGamesClient.Features.PoEcosystem.Services;

/// <summary>
/// The island's server surface: cloud world slots, the public gallery, and the clans'
/// culture tables. Every call is best-effort and returns null/empty on failure — the engine
/// keeps running whatever the network does, and the dashboard says "could not reach the
/// cloud" rather than throwing through a render.
/// </summary>
/// <remarks>
/// Uses the app's shared <see cref="HttpClient"/>, so the antiforgery header and credentials
/// ride along on the PUT/POST/DELETE calls (see Client/Program.cs for the handler order).
/// Snapshot bytes travel as <c>application/gzip</c> bodies, never as JSON: a hundred-year
/// world is a megabyte compressed and would be several as base64.
/// </remarks>
public sealed class PoEcosystemApiClient
{
    private readonly HttpClient _http;

    public PoEcosystemApiClient(HttpClient http) => _http = http;

    public async Task<EcoWorldMeta[]> ListWorldsAsync(CancellationToken ct = default)
    {
        try { return await _http.GetFromJsonAsync("/api/ecosystem/worlds", EcoApiJsonContext.Default.EcoWorldMetaArray, ct) ?? []; }
        catch { return []; }
    }

    public async Task<EcoWorldMeta?> SaveWorldAsync(string slot, string name, int seed, int year, int tick, int[] counts, byte[] gzipBytes, CancellationToken ct = default)
    {
        try
        {
            var url = $"/api/ecosystem/worlds/{Uri.EscapeDataString(slot)}?name={Uri.EscapeDataString(name)}&seed={seed}&year={year}&tick={tick}&counts={string.Join(',', counts)}";
            using var content = new ByteArrayContent(gzipBytes);
            content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/gzip");
            using var response = await _http.PutAsync(url, content, ct);
            if (!response.IsSuccessStatusCode) return null;
            return await response.Content.ReadFromJsonAsync(EcoApiJsonContext.Default.EcoWorldMeta, ct);
        }
        catch { return null; }
    }

    public async Task<byte[]?> LoadWorldAsync(string slot, CancellationToken ct = default)
    {
        try
        {
            using var response = await _http.GetAsync($"/api/ecosystem/worlds/{Uri.EscapeDataString(slot)}/data", ct);
            return response.IsSuccessStatusCode ? await response.Content.ReadAsByteArrayAsync(ct) : null;
        }
        catch { return null; }
    }

    public async Task<bool> DeleteWorldAsync(string slot, CancellationToken ct = default)
    {
        try
        {
            using var response = await _http.DeleteAsync($"/api/ecosystem/worlds/{Uri.EscapeDataString(slot)}", ct);
            return response.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    public async Task<EcoWorldMeta?> ShareWorldAsync(string slot, bool isPublic, CancellationToken ct = default)
    {
        try
        {
            using var response = await _http.PostAsJsonAsync($"/api/ecosystem/worlds/{Uri.EscapeDataString(slot)}/share", new EcoShareRequest(isPublic), EcoApiJsonContext.Default.EcoShareRequest, ct);
            if (!response.IsSuccessStatusCode) return null;
            return await response.Content.ReadFromJsonAsync(EcoApiJsonContext.Default.EcoWorldMeta, ct);
        }
        catch { return null; }
    }

    public async Task<EcoSharedWorld[]> GalleryAsync(int top = 20, CancellationToken ct = default)
    {
        try { return await _http.GetFromJsonAsync($"/api/ecosystem/gallery?top={top}", EcoApiJsonContext.Default.EcoSharedWorldArray, ct) ?? []; }
        catch { return []; }
    }

    public async Task<byte[]?> GalleryBytesAsync(string code, CancellationToken ct = default)
    {
        try
        {
            using var response = await _http.GetAsync($"/api/ecosystem/gallery/{Uri.EscapeDataString(code)}/data", ct);
            return response.IsSuccessStatusCode ? await response.Content.ReadAsByteArrayAsync(ct) : null;
        }
        catch { return null; }
    }
}

[JsonSerializable(typeof(EcoWorldMeta))]
[JsonSerializable(typeof(EcoWorldMeta[]))]
[JsonSerializable(typeof(EcoSharedWorld[]))]
[JsonSerializable(typeof(EcoShareRequest))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, PropertyNameCaseInsensitive = true)]
internal sealed partial class EcoApiJsonContext : JsonSerializerContext;

