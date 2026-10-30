using System.Text.Json;
using FluentAssertions;
using PoMiniGames.Features.PoCoupleQuiz;
using PoMiniGames.Features.PoFunQuiz;
using FunCategory = PoMiniGames.Features.PoFunQuiz.QuestionCategory;

namespace PoMiniGames.Unit.Features.PoFunQuiz;

/// <summary>
/// The free question pipeline: the shared quality gate, and the question banks that ship with the
/// API (the bundled FunQuiz set and the curated CoupleQuiz bank).
/// </summary>
public sealed class QuizQualityTests
{
    [Theory]
    [InlineData("What is the capital of Australia?", "Sydney|Melbourne|Canberra|Perth", 2, true)]
    [InlineData("Which city hosts the Louvre?", "Paris|paris!|Rome|Berlin", 0, false)]            // two options are one answer
    [InlineData("Which planet, Mars, glows red?", "Venus|Mars|Jupiter|Saturn", 1, false)]         // answer printed in the question
    [InlineData("Who wrote Hamlet?", "Marlowe|Bacon|William Shakespeare, the Bard of Avon|Jonson", 2, false)] // giveaway length
    [InlineData("Pick one", "A1|B1|C1", 0, false)]                                                // three options
    [InlineData("How many continents are there?", "5|6|7|8", 2, true)]                            // short numeric answers are fine
    public void Reject_FlagsGiveawayQuestions_AndHashIgnoresCaseArticlesAndPunctuation(
        string text, string options, int correct, bool acceptable)
    {
        (QuizQuality.Reject(text, options.Split('|'), correct) is null).Should().Be(acceptable);

        // Identity is the normalized text: the same question reworded only in case, articles and
        // punctuation is one question.
        QuizQuality.Hash(text).Should().Be(QuizQuality.Hash("the " + text.ToUpperInvariant() + " !!"));
        QuizQuality.Hash(text).Should().HaveLength(32);
    }

    [Theory]
    [InlineData("funquiz", 150)]
    [InlineData("couplequiz", 1000)]
    [InlineData("deal", 7)]
    public void QuestionBanks_ShipEnoughValidQuestions(string bank, int minimum)
    {
        switch (bank)
        {
            case "deal":
                var pool = BundledQuizQuestions.For(FunCategory.Science);
                var hand = FunQuizQuestionService.Deal(pool, minimum);
                hand.Should().HaveCount(minimum);
                hand.Select(q => q.Text).Should().OnlyHaveUniqueItems();
                hand.Should().AllSatisfy(q => q.Options[q.CorrectOptionIndex].Should().NotBeNullOrEmpty());
                FunQuizQuestionService.Deal(pool, pool.Count + 50).Should().HaveCount(pool.Count, because: "a small bank deals what it has");
                CoupleQuizQuestionBank.Draw(new HashSet<string>()).Text.Should().NotBeNullOrWhiteSpace();
                break;

            case "funquiz":
                var bundled = BundledQuizQuestions.All.ToList();
                bundled.Should().HaveCountGreaterThanOrEqualTo(minimum);
                foreach (var category in Enum.GetValues<FunCategory>())
                    BundledQuizQuestions.For(category).Should().HaveCountGreaterThanOrEqualTo(15, because: $"{category} needs a real floor");
                bundled.Should().AllSatisfy(q => QuizQuality.Reject(q.Text, q.Options, q.CorrectOptionIndex).Should().BeNull(q.Text));
                bundled.Select(q => QuizQuality.Hash(q.Text)).Should().OnlyHaveUniqueItems();
                break;

            case "couplequiz":
                var curated = CoupleQuizQuestionBank.All;
                curated.Should().HaveCountGreaterThanOrEqualTo(minimum);
                curated.GroupBy(q => q.Category).Should().HaveCount(Enum.GetValues<PoMiniGames.Features.PoCoupleQuiz.QuestionCategory>().Length);
                curated.Should().AllSatisfy(q =>
                    q.Text.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length.Should().BeLessThan(16, q.Text));
                curated.Select(q => q.Text).Should().OnlyHaveUniqueItems();
                CoupleQuizQuestionBank.Draw(curated.Take(curated.Count - 1).Select(q => q.Text).ToHashSet())
                    .Text.Should().Be(curated[^1].Text, because: "a match never repeats a question while unasked ones remain");
                break;
        }
    }
}
