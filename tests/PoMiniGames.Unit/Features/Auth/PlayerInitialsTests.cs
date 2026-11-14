using FluentAssertions;
using PoMiniGamesClient.Services.Play;

namespace PoMiniGames.Unit.Features.Auth;

public class PlayerInitialsTests
{
    [Theory]
    [InlineData("abc", "ABC")]
    [InlineData("XYZ", "XYZ")]
    [InlineData("a1b2c3", "ABC")]
    [InlineData("  p o m  ", "POM")]
    [InlineData("abcd", "ABC")]
    public void NormalizeInitials_ValidThreeLetters_ReturnsUppercaseThreeLetters(string input, string expected)
    {
        PlayerNameService.NormalizeInitials(input).Should().Be(expected);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("ab")]
    [InlineData("123")]
    [InlineData("a1")]
    public void NormalizeInitials_FewerThanThreeLetters_ReturnsThreeBlankSpaces(string? input)
    {
        PlayerNameService.NormalizeInitials(input).Should().Be("   ");
    }
}
