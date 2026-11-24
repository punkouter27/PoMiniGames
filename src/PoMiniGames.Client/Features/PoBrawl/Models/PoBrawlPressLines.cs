using PoMiniGames.Domain.Primitives;
using PoMiniGames.Shared;
using PoMiniGames.Shared.Games;

namespace PoMiniGamesClient.Features.PoBrawl;

/// <summary>A line someone says, and who said it.</summary>
public sealed record PoBrawlPressLine(string Speaker, string Text);

/// <summary>
/// The ring announcer's introduction. Scripted and picked in the browser — no server call — and
/// stable for the same pairing.
/// </summary>
public static class PoBrawlPressLines
{
    /// <summary>Who reads the introduction.</summary>
    public const string Announcer = "Ring announcer";

    /// <summary>The PA introduction for a pairing, or null when either id is not a fighter.</summary>
    public static PoBrawlPressLine? Intro(string p1Id, string p2Id)
    {
        var left = PoBrawlRoster.NameOf(p1Id);
        var right = PoBrawlRoster.NameOf(p2Id);
        if (left is null || right is null) return null;
        string[] lines =
        [
            $"In the left corner, {left}! In the right corner, {right}! Sixty seconds a round — let's get ready to brawl!",
            $"Ladies and gentlemen, from the left, {left}! And from the right, the one and only {right}! Touch gloves and come out swinging!",
            $"Tonight's main event: {left} versus {right}! No recounts. Fighters, to your marks!",
        ];
        return new PoBrawlPressLine(Announcer, Pick(lines, $"{left}|{right}"));
    }

    /// <summary>The same pairing always picks the same line.</summary>
    private static string Pick(string[] lines, string key) => StableHash.Pick(lines, StableHash.Of(key));
}
