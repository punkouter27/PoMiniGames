using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoBrawl;

/// <summary>Configuration for the fighter dossiers (<c>PoMiniGames:PoBrawl:Dossier</c>).</summary>
public sealed class PoBrawlDossierOptions
{
    public const string SectionName = "PoMiniGames:PoBrawl:Dossier";

    /// <summary>
    /// When true (the default) the server enriches the static facts with Wikipedia's summary and
    /// portrait. Every test host pins it to false (TestBudgetGuard), so no test calls out.
    /// </summary>
    public bool FetchWikipedia { get; set; } = true;

    /// <summary>How long a fully enriched list is cached. Wikipedia text changes rarely.</summary>
    public int CacheHours { get; set; } = 24;
}

/// <summary>
/// Serves the PoBrawl fighter dossiers: the static facts in <see cref="PoBrawlDossiers"/>,
/// enriched once a day from the free Wikimedia REST API
/// (<c>/api/rest_v1/page/summary/{title}</c>). Wikipedia text is CC BY-SA, which is why the
/// card shows a "From Wikipedia" attribution link next to it.
/// </summary>
/// <remarks>
/// <para><b>Never throws.</b> A slow, failing or switched-off Wikipedia leaves a dossier on its
/// static text; the endpoint answers 200 either way.</para>
/// <para><b>Caching.</b> One enriched list per process, in <see cref="IMemoryCache"/>: a full
/// success is kept for <see cref="PoBrawlDossierOptions.CacheHours"/>, a partial one for
/// 15 minutes so a blip does not pin static text for a day. Concurrent first requests share one
/// refresh (16 calls a day, well inside Wikimedia's limits).</para>
/// <para><b>Bounded wait.</b> A request waits at most <see cref="FirstLoadWait"/> for that refresh;
/// past it, the static facts are served and the refresh carries on in the background to fill the
/// cache for the next caller. Waiting on it outright let a hanging Wikipedia hold the fighter select
/// for ~40 s (fifteen fetches, four at a time, each allowed its retries).</para>
/// </remarks>
public sealed class PoBrawlDossierService
{
    public const string HttpClientName = "PoBrawl.Wikipedia";

    /// <summary>
    /// Wikimedia's User-Agent policy asks for a descriptive agent with a way to reach the operator;
    /// the repository URL is that contact.
    /// </summary>
    public const string UserAgent = "PoMiniGames/1.0 (https://github.com/punkouter26/PoMiniGames)";

    /// <summary>Upper bound on the summary shown on a card.</summary>
    public const int MaxSummaryChars = 300;

    /// <summary>The longest a request waits on a Wikipedia refresh before serving the static facts.</summary>
    public static readonly TimeSpan FirstLoadWait = TimeSpan.FromSeconds(4);

    private const string CacheKey = "pobrawl:dossiers";
    private static readonly TimeSpan PartialCacheFor = TimeSpan.FromMinutes(15);

    private readonly IHttpClientFactory _httpFactory;
    private readonly IMemoryCache _cache;
    private readonly IOptionsMonitor<PoBrawlDossierOptions> _options;
    private readonly ILogger<PoBrawlDossierService> _logger;
    private readonly object _refreshLock = new();
    private Task<IReadOnlyList<PoBrawlDossierDto>>? _refresh;

    public PoBrawlDossierService(
        IHttpClientFactory httpFactory,
        IMemoryCache cache,
        IOptionsMonitor<PoBrawlDossierOptions> options,
        ILogger<PoBrawlDossierService> logger)
    {
        _httpFactory = httpFactory;
        _cache = cache;
        _options = options;
        _logger = logger;
    }

    /// <summary>All sixteen dossiers (fifteen presidents in ladder order, then BOB).</summary>
    public async Task<IReadOnlyList<PoBrawlDossierDto>> GetAllAsync(CancellationToken cancellationToken)
    {
        var options = _options.CurrentValue;
        if (!options.FetchWikipedia)
            return PoBrawlDossiers.StaticDtos();

        if (_cache.TryGetValue(CacheKey, out IReadOnlyList<PoBrawlDossierDto>? cached) && cached is not null)
            return cached;

        var refresh = StartRefresh(options);
        try
        {
            var first = await Task.WhenAny(refresh, Task.Delay(FirstLoadWait, cancellationToken));
            if (first == refresh)
                return await refresh;
        }
        catch (OperationCanceledException)
        {
            // The caller left; the refresh carries on for the next one.
        }
        return PoBrawlDossiers.StaticDtos();
    }

    /// <summary>The refresh in flight, or a new one. Never the request's token: it fills the cache for every later caller.</summary>
    private Task<IReadOnlyList<PoBrawlDossierDto>> StartRefresh(PoBrawlDossierOptions options)
    {
        lock (_refreshLock)
        {
            if (_refresh is { IsCompleted: false } running) return running;
            return _refresh = Task.Run(() => RefreshAsync(options));
        }
    }

    private async Task<IReadOnlyList<PoBrawlDossierDto>> RefreshAsync(PoBrawlDossierOptions options)
    {
        try
        {
            if (_cache.TryGetValue(CacheKey, out IReadOnlyList<PoBrawlDossierDto>? cached) && cached is not null)
                return cached;

            // The HTTP client's resilience timeouts bound each fetch.
            var dossiers = PoBrawlDossiers.StaticDtos();
            var enriched = 0;
            await Parallel.ForEachAsync(dossiers, new ParallelOptions { MaxDegreeOfParallelism = 4 },
                async (dossier, ct) =>
                {
                    if (await TryEnrichAsync(dossier, ct))
                        Interlocked.Increment(ref enriched);
                });

            var wanted = dossiers.Count(d => !d.IsFictional);
            var lifetime = enriched == wanted ? TimeSpan.FromHours(Math.Max(1, options.CacheHours)) : PartialCacheFor;
            if (enriched < wanted)
                _logger.LogWarning("PoBrawl dossiers: Wikipedia enriched {Enriched} of {Wanted}; retrying in {Minutes} min",
                    enriched, wanted, PartialCacheFor.TotalMinutes);

            IReadOnlyList<PoBrawlDossierDto> result = dossiers;
            _cache.Set(CacheKey, result, lifetime);
            return result;
        }
        catch (Exception ex)
        {
            // Never throws (see the class remarks): an unexpected failure is the static text.
            _logger.LogWarning(ex, "PoBrawl dossiers: refresh failed; serving the static facts");
            return PoBrawlDossiers.StaticDtos();
        }
    }

    private async Task<bool> TryEnrichAsync(PoBrawlDossierDto dossier, CancellationToken cancellationToken)
    {
        var title = PoBrawlDossiers.Find(dossier.FighterId)?.WikipediaTitle;
        if (title is null) return false;

        try
        {
            var client = _httpFactory.CreateClient(HttpClientName);
            using var response = await client.GetAsync($"page/summary/{Uri.EscapeDataString(title)}", cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                _logger.LogInformation("PoBrawl dossier: Wikipedia answered {Status} for {Title}", (int)response.StatusCode, title);
                return false;
            }

            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
            using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
            var root = doc.RootElement;

            // A disambiguation page or an empty extract is not a summary of this president.
            if (root.TryGetProperty("type", out var type) && type.GetString() is "disambiguation")
                return false;
            var extract = root.TryGetProperty("extract", out var e) ? e.GetString() : null;
            if (string.IsNullOrWhiteSpace(extract))
                return false;

            dossier.Summary = TrimSummary(extract, MaxSummaryChars);
            dossier.FromWikipedia = true;

            if (root.TryGetProperty("thumbnail", out var thumb) &&
                thumb.TryGetProperty("source", out var source) &&
                IsHttps(source.GetString(), ".wikimedia.org"))
            {
                dossier.ThumbnailUrl = source.GetString();
            }

            if (root.TryGetProperty("content_urls", out var urls) &&
                urls.TryGetProperty("desktop", out var desktop) &&
                desktop.TryGetProperty("page", out var page) &&
                IsHttps(page.GetString(), "en.wikipedia.org"))
            {
                dossier.ArticleUrl = page.GetString();
            }

            return true;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException or InvalidOperationException
                                       or Polly.ExecutionRejectedException)
        {
            _logger.LogInformation("PoBrawl dossier: Wikipedia fetch for {Title} failed ({Error})", title, ex.GetType().Name);
            return false;
        }
    }

    // Only the hosts the card is meant to load from: the payload is third-party data. A host
    // starting with "." matches any subdomain (portraits come from thumb. or upload.wikimedia.org).
    private static bool IsHttps(string? url, string host) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri) &&
        uri.Scheme == Uri.UriSchemeHttps &&
        (host.StartsWith('.')
            ? uri.Host.EndsWith(host, StringComparison.OrdinalIgnoreCase)
            : string.Equals(uri.Host, host, StringComparison.OrdinalIgnoreCase));

    private static readonly string[] Abbreviations = ["Jr", "Sr", "St", "Mr", "Mrs", "Dr", "vs", "Gen", "Lt"];

    /// <summary>
    /// <paramref name="text"/> cut to its first <paramref name="maxSentences"/> sentences and at most
    /// <paramref name="max"/> characters, at a sentence end where one fits, else at a word with an
    /// ellipsis. Initials ("George W. Bush"), "U.S." and common abbreviations are not sentence ends.
    /// </summary>
    public static string TrimSummary(string text, int max, int maxSentences = 2)
    {
        text = text.Trim();

        var cut = -1;
        var sentences = 0;
        for (var i = 1; i < max && i + 1 < text.Length && sentences < maxSentences; i++)
        {
            if (text[i] is not ('.' or '!' or '?') || text[i + 1] != ' ') continue;
            if (text[i] == '.' && !IsSentenceEnd(text, i)) continue;
            cut = i;
            sentences++;
        }

        if (sentences == maxSentences)
            return text[..(cut + 1)];
        if (text.Length <= max)
            return text;

        // A sentence that fills less than a third of the budget reads like a fragment; cut at a word instead.
        if (cut >= max / 3)
            return text[..(cut + 1)];

        var space = text.LastIndexOf(' ', max - 1);
        return (space > 0 ? text[..space] : text[..(max - 1)]).TrimEnd(',', ';', ':', ' ') + "…";
    }

    private static bool IsSentenceEnd(string text, int dot)
    {
        var start = dot;
        while (start > 0 && char.IsLetter(text[start - 1])) start--;
        var word = text[start..dot];
        // A single capital ("W."), a dotted acronym ("U.S."), or a known abbreviation.
        if (word.Length == 1 && char.IsUpper(word[0])) return false;
        if (start > 0 && text[start - 1] == '.') return false;
        return !Abbreviations.Contains(word, StringComparer.Ordinal);
    }
}
