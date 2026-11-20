using FluentAssertions;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Features.PoBrawl;
using PoMiniGamesClient.Services.Play;

namespace PoMiniGames.Unit.Features.PoBrawl;

/// <summary>
/// Brawl feats: the stored text form only ever holds known ids with positive counts, a feat is
/// "new" exactly once, and every feat has an achievement that its id (and nothing else) unlocks.
/// </summary>
public sealed class PoBrawlFeatsTests
{
    [Fact]
    public void Parse_KeepsKnownIdsWithPositiveCounts_AndDropsEverythingElse()
    {
        var counts = PoBrawlFeats.Parse("flawless:3, comeback:1,made-up:9,showboat:0,combo-5:-2,no-kicks:x,quick-ko,,:4");

        counts.Should().BeEquivalentTo(new Dictionary<string, int> { ["flawless"] = 3, ["comeback"] = 1 });
        PoBrawlFeats.Parse(null).Should().BeEmpty();
        PoBrawlFeats.Parse("").Should().BeEmpty();
    }

    [Fact]
    public void Format_RoundTripsInCatalogueOrder()
    {
        var counts = new Dictionary<string, int> { ["showboat"] = 2, ["flawless"] = 1, ["comeback"] = 0 };

        var stored = PoBrawlFeats.Format(counts);

        stored.Should().Be("flawless:1,showboat:2");
        PoBrawlFeats.Parse(stored).Should().BeEquivalentTo(new Dictionary<string, int> { ["flawless"] = 1, ["showboat"] = 2 });
    }

    [Fact]
    public void Add_CountsEachKnownIdOncePerReport_AndReturnsOnlyFirstTimers()
    {
        var counts = new Dictionary<string, int> { ["flawless"] = 2 };

        var fresh = PoBrawlFeats.Add(counts, ["flawless", "comeback", "comeback", "not-a-feat"]);

        fresh.Should().Equal("comeback");
        counts.Should().BeEquivalentTo(new Dictionary<string, int> { ["flawless"] = 3, ["comeback"] = 1 });
        PoBrawlFeats.Add(counts, null).Should().BeEmpty();
    }

    [Fact]
    public void EveryFeat_HasItsOwnAchievement_UnlockedByItsIdAlone()
    {
        PoBrawlFeats.All.Select(f => f.Id).Should().OnlyHaveUniqueItems();
        AchievementService.All.Select(a => a.Id).Should().OnlyHaveUniqueItems();

        foreach (var feat in PoBrawlFeats.All)
        {
            var badge = AchievementService.All.Should().ContainSingle(a => a.Id == $"brawl-{feat.Id}").Subject;
            badge.Title.Should().Be(feat.Title);
            badge.IsMet(new AchievementFacts()).Should().BeFalse("nothing has been earned");
            badge.IsMet(new AchievementFacts { BrawlFeats = new HashSet<string> { feat.Id } }).Should().BeTrue();
            badge.IsMet(new AchievementFacts { BrawlFeats = PoBrawlFeats.All.Select(f => f.Id).Where(id => id != feat.Id).ToHashSet() })
                .Should().BeFalse("another feat's id must not unlock it");
        }
    }

    [Theory]
    [InlineData(0, 0, 0)]
    [InlineData(5, 0, 5)]
    [InlineData(2, 1, 16)]   // a cleared ladder is everyone, wherever the new run stands
    public void Beaten_IsEveryoneBelowTheRung_OrTheWholeRosterAfterAClear(int rung, int clears, int expected)
    {
        var beaten = PoBrawlProgressBook.Beaten(new PoBrawlProgressDto { Rung = rung, Clears = clears });

        beaten.Should().HaveCount(expected);
        beaten.Should().Equal(PoBrawlRoster.Fighters.Take(expected));
    }
}
