using FluentAssertions;
using PoMiniGames.Features.PoCoupleQuiz;

namespace PoMiniGames.Unit.Features.PoCoupleQuiz;

/// <summary>
/// The couple bank is about the two players' life together, dealt by topic. These pin the shape
/// the game relies on: every topic is stocked, a topic deals only its own questions, and no
/// question is a "who" question (the King's "me" is the partner's "you", so it could never match).
/// </summary>
public sealed class CoupleQuizQuestionBankTests
{
    [Fact]
    public void EveryTopicIsStocked_AndNoQuestionIsAWhoQuestion()
    {
        var all = CoupleQuizQuestionBank.All;
        foreach (var category in Enum.GetValues<QuestionCategory>())
        {
            all.Count(q => q.Category == category).Should().BeGreaterThanOrEqualTo(30, $"{category} needs enough for long sessions");
        }

        all.Select(q => q.Text).Should().OnlyHaveUniqueItems();
        all.Should().NotContain(q => q.Text.StartsWith("Who ", StringComparison.OrdinalIgnoreCase));
    }

    [Theory]
    [InlineData("DatesAndTrips")]
    [InlineData("justus")]
    public void Draw_DealsOnlyFromTheChosenTopic_UntilItIsAskedOut(string topic)
    {
        var category = Enum.Parse<QuestionCategory>(CoupleQuizQuestionBank.NormalizeTopic(topic));
        var asked = new HashSet<string>();
        var inTopic = CoupleQuizQuestionBank.All.Count(q => q.Category == category);

        for (var i = 0; i < inTopic; i++)
        {
            var q = CoupleQuizQuestionBank.Draw(asked, topic, new Random(i));
            q.Category.Should().Be(category);
            asked.Add(q.Text).Should().BeTrue("a question is not repeated before the topic runs out");
        }

        // Asked out: it keeps dealing from the same topic rather than running dry.
        CoupleQuizQuestionBank.Draw(asked, topic).Category.Should().Be(category);
    }

    [Theory]
    [InlineData("Everything", "Everything")]
    [InlineData("homelife", "HomeLife")]
    [InlineData("WorldTravel", "Everything")]   // the old trivia packs are gone
    [InlineData(null, "Everything")]
    public void NormalizeTopic_KnowsOnlyTheBankTopics(string? topic, string expected) =>
        CoupleQuizQuestionBank.NormalizeTopic(topic).Should().Be(expected);
}
