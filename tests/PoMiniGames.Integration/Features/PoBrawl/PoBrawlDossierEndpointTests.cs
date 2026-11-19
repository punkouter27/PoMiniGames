using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Features.PoBrawl;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Integration;

/// <summary>
/// <c>GET /api/pobrawl/dossier</c> with Wikipedia fetching off (the test host pins
/// <c>PoMiniGames:PoBrawl:Dossier:FetchWikipedia</c> to false): anonymous, 200, sixteen static
/// dossiers in ladder order then BOB. Also pins the summary trimmer the Wikipedia path uses.
/// One method on purpose — the Integration tier has a ceiling.
/// </summary>
public sealed class PoBrawlDossierEndpointTests : IClassFixture<TestWebApplicationFactory>
{
    private readonly TestWebApplicationFactory _factory;

    public PoBrawlDossierEndpointTests(TestWebApplicationFactory factory) => _factory = factory;

    [Fact]
    public async Task Dossier_IsAnonymous_AndServesStaticFactsForEveryFighter_WhenFetchIsOff()
    {
        using var client = _factory.CreateClient();

        var response = await client.GetAsync("/api/pobrawl/dossier");
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var dossiers = await response.Content.ReadFromJsonAsync<List<PoBrawlDossierDto>>();

        dossiers.Should().NotBeNull().And.HaveCount(PoBrawlRoster.Count + 1);
        dossiers!.Select(d => d.FighterId).Should().Equal(
            PoBrawlRoster.Fighters.Select(f => f.Id).Append(PoBrawlRoster.Bob.Id));
        dossiers.Should().OnlyContain(d =>
            d.FullName.Length > 0 && d.Term.Length > 0 && d.Party.Length > 0 &&
            d.FightingStyle.Length > 0 && d.Summary.Length > 0 && !d.FromWikipedia && d.ThumbnailUrl == null);

        var presidents = dossiers.Where(d => !d.IsFictional).ToList();
        presidents.Should().HaveCount(PoBrawlRoster.Count)
            .And.OnlyContain(d => d.Number > 0 && d.ArticleUrl!.StartsWith("https://en.wikipedia.org/wiki/"));
        dossiers.Single(d => d.FighterId == "fdr").Office.Should().Be("32nd President");
        dossiers.Single(d => d.IsFictional).FighterId.Should().Be(PoBrawlRoster.Bob.Id);

        // The trimmer cuts at a sentence end, never at an initial or "U.S.".
        var text = "George W. Bush is an American politician who served as the 43rd president of the U.S. from 2001 to 2009. " +
                   new string('x', 400);
        PoBrawlDossierService.TrimSummary(text, 300).Should()
            .Be("George W. Bush is an American politician who served as the 43rd president of the U.S. from 2001 to 2009.");
        PoBrawlDossierService.TrimSummary("Short.", 300).Should().Be("Short.");
        PoBrawlDossierService.TrimSummary("Ada is first. Bob Jr. is second. Cy is third.", 300).Should()
            .Be("Ada is first. Bob Jr. is second.");
        var words = PoBrawlDossierService.TrimSummary(string.Join(' ', Enumerable.Repeat("word", 100)), 50);
        words.Should().EndWith("…");
        words.Length.Should().BeLessThanOrEqualTo(50);
    }
}
