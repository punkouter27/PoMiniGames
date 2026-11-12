using System.Text.RegularExpressions;
using FluentAssertions;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Features.PoBrawl;

namespace PoMiniGames.Unit.Features.PoBrawl;

/// <summary>
/// The press-conference lines read right at the counts where they used to break ("1 clean
/// shots", "a 0-hit combo", "those 1 hits"), and Bob is named like any president.
/// </summary>
public sealed class PoBrawlPressLinesTests
{
    // Never: a "1" with a plural noun, a 0/1-hit combo, or a bare zero count.
    private static readonly Regex Broken = new(@"\b1 (clean shots|hits|times)\b|\b[01]-hit\b|\bthose [01] hits\b|\b0 (clean|hits?|times)\b");

    [Theory]
    [InlineData("bob", "trump", PoBrawlOutcome.Win, true, 1, 0, 1, "BOB", "1 clean shot and")]
    [InlineData("trump", "obama", PoBrawlOutcome.Win, true, 0, 0, 0, "Trump", "One punch at a time")]
    [InlineData("obama", "bush", PoBrawlOutcome.Win, false, 1, 0, 1, "Obama", "1 hit doesn't lie")]
    [InlineData("fdr", "bob", PoBrawlOutcome.Loss, true, 0, 1, 1, "FDR", "Once, apparently")]
    [InlineData("jfk", "lbj", PoBrawlOutcome.Loss, false, 3, 1, 2, "JFK", "recount of that one hit")]
    [InlineData("jfk", "lbj", PoBrawlOutcome.Loss, false, 3, 7, 2, "JFK", "recount of those 7 hits")]
    public void PressLine_ReadsRightAtEveryCount(
        string speakerId, string opponentId, PoBrawlOutcome outcome, bool knockout,
        int hits, int opponentHits, int bestCombo, string speaker, string expected)
    {
        // The line is picked by a hash of the fight, so walk the clock to see every line in the pool.
        var said = Enumerable.Range(1, 60)
            .Select(s => PoBrawlPressLines.Press(new PoBrawlPressLines.Bout(
                speakerId, opponentId, outcome, knockout, hits, opponentHits, 0, bestCombo, 10, s)))
            .ToList();

        said.Should().OnlyContain(l => l != null && l.Speaker == speaker);
        said.Select(l => l!.Text).Should().NotContain(t => Broken.IsMatch(t))
            .And.Contain(t => t.Contains(expected, StringComparison.Ordinal));
        PoBrawlPressLines.Press(new PoBrawlPressLines.Bout("nobody", opponentId, outcome, knockout, hits, opponentHits, 0, bestCombo, 10, 1))
            .Should().BeNull();
    }
}
