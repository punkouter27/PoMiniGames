using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;

namespace PoMiniGames.Features.PoCoupleQuiz;

/// <summary>
/// Generates live topic-pack questions for PoCoupleQuiz from free, keyless external APIs
/// (Datamuse, REST Countries, Gutendex), with in-memory caching and seamless fallback to
/// the static <see cref="CoupleQuizQuestionBank"/> when disabled or unreachable.
/// </summary>
public sealed class CoupleQuizExternalPackService
{
    public const string HttpClientName = "CoupleQuiz.External";

    public static readonly string[] AllowedTopicPacks =
    [
        "Classic",
        "WordSync",
        "WorldTravel",
        "BooksAndStories",
        "Mixed",
    ];

    private static readonly string[] WordSeeds =
    [
        "vacation", "breakfast", "midnight", "adventure", "coffee",
        "weekend", "nostalgia", "celebration", "rainstorm", "roadtrip",
    ];

    private static readonly TimeSpan CacheDuration = TimeSpan.FromMinutes(30);

    private readonly IHttpClientFactory _httpFactory;
    private readonly IMemoryCache _cache;
    private readonly IOptionsMonitor<CoupleQuizOptions> _options;
    private readonly ILogger<CoupleQuizExternalPackService> _logger;

    public CoupleQuizExternalPackService(
        IHttpClientFactory httpFactory,
        IMemoryCache cache,
        IOptionsMonitor<CoupleQuizOptions> options,
        ILogger<CoupleQuizExternalPackService> logger)
    {
        _httpFactory = httpFactory;
        _cache = cache;
        _options = options;
        _logger = logger;
    }

    public static bool IsValidPack(string? pack) =>
        !string.IsNullOrWhiteSpace(pack)
        && AllowedTopicPacks.Contains(pack, StringComparer.OrdinalIgnoreCase);

    public static string NormalizePack(string? pack) =>
        AllowedTopicPacks.FirstOrDefault(p => string.Equals(p, pack, StringComparison.OrdinalIgnoreCase))
        ?? "Classic";

    /// <summary>
    /// Draw a question for the requested <paramref name="topicPack"/>, avoiding anything in
    /// <paramref name="asked"/>. Never throws; falls back to the curated local bank on any error.
    /// </summary>
    public async Task<Question> DrawAsync(string topicPack, IReadOnlySet<string> asked, CancellationToken ct)
    {
        var pack = NormalizePack(topicPack);
        if (pack == "Classic" || !_options.CurrentValue.FetchExternalPacks)
        {
            return CoupleQuizQuestionBank.Draw(asked);
        }

        if (pack == "Mixed")
        {
            var choices = new[] { "Classic", "WordSync", "WorldTravel", "BooksAndStories" };
            pack = choices[Random.Shared.Next(choices.Length)];
            if (pack == "Classic") return CoupleQuizQuestionBank.Draw(asked);
        }

        IReadOnlyList<Question> pool = pack switch
        {
            "WordSync" => await GetWordSyncAsync(ct),
            "WorldTravel" => await GetWorldTravelAsync(ct),
            "BooksAndStories" => await GetBooksAndStoriesAsync(ct),
            _ => [],
        };

        var fresh = pool.Where(q => !asked.Contains(q.Text)).ToList();
        if (fresh.Count > 0)
        {
            return fresh[Random.Shared.Next(fresh.Count)];
        }

        if (pool.Count > 0)
        {
            return pool[Random.Shared.Next(pool.Count)];
        }

        return CoupleQuizQuestionBank.Draw(asked);
    }

    private async Task<IReadOnlyList<Question>> GetWordSyncAsync(CancellationToken ct)
    {
        const string key = "pocouplequiz:pack:wordsync";
        if (_cache.TryGetValue(key, out IReadOnlyList<Question>? cached) && cached is { Count: > 0 })
            return cached;

        var list = new List<Question>();
        try
        {
            var client = _httpFactory.CreateClient(HttpClientName);
            var seed = WordSeeds[Random.Shared.Next(WordSeeds.Length)];
            using var resp = await client.GetAsync($"https://api.datamuse.com/words?rel_trg={Uri.EscapeDataString(seed)}&max=25", ct);
            if (resp.IsSuccessStatusCode)
            {
                await using var stream = await resp.Content.ReadAsStreamAsync(ct);
                using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
                foreach (var el in doc.RootElement.EnumerateArray())
                {
                    if (!el.TryGetProperty("word", out var wProp)) continue;
                    var word = wProp.GetString()?.Trim();
                    if (string.IsNullOrWhiteSpace(word) || word.Contains(' ')) continue;
                    list.Add(new Question
                    {
                        Text = $"Word Sync: first word that comes to mind when you hear \"{word}\"?",
                        Category = QuestionCategory.Preferences,
                    });
                }
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogDebug(ex, "Datamuse WordSync pack unavailable; falling back to bank.");
        }

        if (list.Count > 0) _cache.Set(key, (IReadOnlyList<Question>)list, CacheDuration);
        return list;
    }

    private async Task<IReadOnlyList<Question>> GetWorldTravelAsync(CancellationToken ct)
    {
        const string key = "pocouplequiz:pack:worldtravel";
        if (_cache.TryGetValue(key, out IReadOnlyList<Question>? cached) && cached is { Count: > 0 })
            return cached;

        var list = new List<Question>();
        try
        {
            var client = _httpFactory.CreateClient(HttpClientName);
            using var resp = await client.GetAsync("https://restcountries.com/v3.1/all?fields=name,region", ct);
            if (resp.IsSuccessStatusCode)
            {
                await using var stream = await resp.Content.ReadAsStreamAsync(ct);
                using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
                var countries = new List<(string Name, string Region)>();
                foreach (var el in doc.RootElement.EnumerateArray())
                {
                    var name = el.TryGetProperty("name", out var n) && n.TryGetProperty("common", out var c)
                        ? c.GetString() : null;
                    var region = el.TryGetProperty("region", out var r) ? r.GetString() : null;
                    if (!string.IsNullOrWhiteSpace(name) && !string.IsNullOrWhiteSpace(region))
                        countries.Add((name.Trim(), region.Trim()));
                }

                if (countries.Count >= 4)
                {
                    var shuffled = countries.OrderBy(_ => Random.Shared.Next()).Take(40).ToList();
                    for (var i = 0; i + 1 < shuffled.Count; i += 2)
                    {
                        var a = shuffled[i];
                        var b = shuffled[i + 1];
                        list.Add(new Question
                        {
                            Text = $"Dream getaway: would the King pick {a.Name} or {b.Name}?",
                            Category = QuestionCategory.Future,
                        });
                    }
                    foreach (var group in countries.GroupBy(c => c.Region).Where(g => g.Count() >= 4))
                    {
                        list.Add(new Question
                        {
                            Text = $"Name one country in {group.Key} the King wants to visit most.",
                            Category = QuestionCategory.Future,
                        });
                    }
                }
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogDebug(ex, "REST Countries WorldTravel pack unavailable; falling back to bank.");
        }

        if (list.Count > 0) _cache.Set(key, (IReadOnlyList<Question>)list, CacheDuration);
        return list;
    }

    private async Task<IReadOnlyList<Question>> GetBooksAndStoriesAsync(CancellationToken ct)
    {
        const string key = "pocouplequiz:pack:books";
        if (_cache.TryGetValue(key, out IReadOnlyList<Question>? cached) && cached is { Count: > 0 })
            return cached;

        var list = new List<Question>();
        try
        {
            var client = _httpFactory.CreateClient(HttpClientName);
            using var resp = await client.GetAsync("https://gutendex.com/books/?sort=popular", ct);
            if (resp.IsSuccessStatusCode)
            {
                await using var stream = await resp.Content.ReadAsStreamAsync(ct);
                using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
                if (doc.RootElement.TryGetProperty("results", out var results))
                {
                    var titles = new List<string>();
                    foreach (var el in results.EnumerateArray())
                    {
                        if (!el.TryGetProperty("title", out var tProp)) continue;
                        var title = tProp.GetString()?.Split(';')[0].Trim();
                        if (!string.IsNullOrWhiteSpace(title) && title.Length <= 42)
                            titles.Add(title);
                    }

                    for (var i = 0; i + 1 < titles.Count && list.Count < 24; i += 2)
                    {
                        list.Add(new Question
                        {
                            Text = $"Story night: \"{titles[i]}\" or \"{titles[i + 1]}\"?",
                            Category = QuestionCategory.Hobbies,
                        });
                    }
                }
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogDebug(ex, "Gutendex Books pack unavailable; falling back to bank.");
        }

        if (list.Count > 0) _cache.Set(key, (IReadOnlyList<Question>)list, CacheDuration);
        return list;
    }
}
