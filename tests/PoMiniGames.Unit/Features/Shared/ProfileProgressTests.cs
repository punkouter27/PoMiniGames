using FluentAssertions;
using PoMiniGamesClient.Services.Play;

namespace PoMiniGames.Unit.Features.Shared;

/// <summary>
/// The two pure halves of the profile's progress: which game a page address counts a
/// session for (GameShell counts every game through it), and the achievement rules.
/// </summary>
public sealed class ProfileProgressTests
{
    [Theory]
    [InlineData("pomule/1player?autoGuest=1", "pomule")]
    [InlineData("/poecosystem/demo", "poecosystem")]
    [InlineData("sandplayground/1player", "sandplayground")]
    [InlineData("pocabinet/multi#lobby", "pocabinet")]
    // The route and the stat key differ for Fun Quiz: the stat key is what is counted.
    [InlineData("funquiz/1player", "pofunquiz")]
    [InlineData("couplequiz", "pocouplequiz")]
    [InlineData("profile", null)]
    [InlineData("", null)]
    public void PlayKeyForPath_ResolvesTheCatalogueGame(string path, string? expected) =>
        GameStatsService.PlayKeyForPath(path).Should().Be(expected);

    [Theory]
    [InlineData("first-win", nameof(AchievementFacts.Wins), 0, false)]
    [InlineData("first-win", nameof(AchievementFacts.Wins), 1, true)]
    [InlineData("wins-50", nameof(AchievementFacts.Wins), 49, false)]
    [InlineData("hot-streak", nameof(AchievementFacts.Streak), 3, true)]
    [InlineData("rising-star", nameof(AchievementFacts.TopElo), 1399, false)]
    [InlineData("explorer", nameof(AchievementFacts.GamesTried), 5, true)]
    [InlineData("three-days", nameof(AchievementFacts.DayStreak), 3, true)]
    [InlineData("contender", nameof(AchievementFacts.BrawlClears), 1, true)]
    [InlineData("podium", nameof(AchievementFacts.BestBoardRank), 3, true)]
    [InlineData("number-one", nameof(AchievementFacts.BestBoardRank), 2, false)]
    [InlineData("nature-watcher", nameof(AchievementFacts.SimSessions), 1, true)]
    public void Achievement_UnlocksExactlyAtItsThreshold(string id, string fact, int value, bool expected)
    {
        var facts = fact switch
        {
            nameof(AchievementFacts.Wins) => new AchievementFacts { Wins = value },
            nameof(AchievementFacts.Streak) => new AchievementFacts { Streak = value },
            nameof(AchievementFacts.TopElo) => new AchievementFacts { TopElo = value },
            nameof(AchievementFacts.GamesTried) => new AchievementFacts { GamesTried = value },
            nameof(AchievementFacts.DayStreak) => new AchievementFacts { DayStreak = value },
            nameof(AchievementFacts.BrawlClears) => new AchievementFacts { BrawlClears = value },
            nameof(AchievementFacts.BestBoardRank) => new AchievementFacts { BestBoardRank = value },
            nameof(AchievementFacts.SimSessions) => new AchievementFacts { SimSessions = value },
            _ => throw new ArgumentOutOfRangeException(nameof(fact)),
        };

        AchievementService.All.Single(a => a.Id == id).IsMet(facts).Should().Be(expected);

        // Nothing is earned from a blank slate, and every id is unique.
        AchievementService.All.Should().OnlyContain(a => !a.IsMet(new AchievementFacts()));
        AchievementService.All.Select(a => a.Id).Should().OnlyHaveUniqueItems();
    }
}
