using PoMiniGames.Domain.Primitives;
using PoMiniGames.Shared;
using PoMiniGames.Shared.Games;

namespace PoMiniGamesClient.Features.PoBrawl;

/// <summary>A line someone says, and who said it.</summary>
public sealed record PoBrawlPressLine(string Speaker, string Text);

/// <summary>
/// The ring announcer's introduction and the post-fight press-conference line. Scripted and
/// picked in the browser — no server call — and stable for the same fight, so a replayed result
/// reads the same line.
/// </summary>
public static class PoBrawlPressLines
{
    /// <summary>Who reads the introduction.</summary>
    public const string Announcer = "Ring announcer";

    /// <summary>What the speaker did in the fight, from the speaker's own side.</summary>
    public sealed record Bout(
        string SpeakerId, string OpponentId, PoBrawlOutcome Outcome, bool Knockout,
        int Hits, int OpponentHits, int Blocks, int BestCombo, int BiggestHit, int Seconds);

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

    /// <summary>The speaker's press-conference line, or null when either id is not a fighter.</summary>
    public static PoBrawlPressLine? Press(Bout b)
    {
        var speaker = PoBrawlRoster.NameOf(b.SpeakerId);
        var opp = PoBrawlRoster.NameOf(b.OpponentId);
        if (speaker is null || opp is null) return null;
        var knockout = b.Knockout && b.Outcome != PoBrawlOutcome.Draw;
        // A count only makes it into a line when it reads right: no "0-hit combo", no
        // "1 clean shots", no "those 1 hits".
        string[] lines = (b.Outcome, knockout) switch
        {
            (PoBrawlOutcome.Win, true) =>
            [
                b.Hits > 0
                    ? $"{Count(b.Hits, "clean shot", "clean shots")} and {opp} is taking a nap. I'd call that a mandate."
                    : $"{opp} is taking a nap. I'd call that a mandate.",
                $"I said it would end early. {opp} didn't get the memo.",
                b.BestCombo >= 2
                    ? $"A {b.BestCombo}-hit combo. Frankly, the canvas owes me a thank-you note."
                    : "One punch at a time, and the canvas still owes me a thank-you note.",
            ],
            (PoBrawlOutcome.Win, false) =>
            [
                b.Hits > 0
                    ? $"The judges saw it, the crowd saw it. {Count(b.Hits, "hit doesn't", "hits don't")} lie."
                    : "The judges saw it, the crowd saw it. The scorecards don't lie.",
                $"{opp} is tough, I'll give them that. Just not sixty-seconds-of-me tough.",
            ],
            (PoBrawlOutcome.Loss, true) =>
            [
                "I'd like to see the replay. Then I'd like to never see it again.",
                b.OpponentHits > 0
                    ? $"{opp} got lucky. {Times(b.OpponentHits)}, apparently."
                    : $"{opp} got lucky, and I'd like to know how.",
            ],
            (PoBrawlOutcome.Loss, false) =>
            [
                b.OpponentHits switch
                {
                    <= 0 => "We lost the decision, not the argument. I want a recount.",
                    1 => "We lost the decision, not the argument. I want a recount of that one hit.",
                    var n => $"We lost the decision, not the argument. I want a recount of those {n} hits.",
                },
                "Sixty seconds wasn't enough. Give me sixty-one next time.",
            ],
            _ =>
            [
                $"A draw. {opp} and I finally agree on something: nobody won.",
                "Even on the cards. I'll take the rematch any day of the week.",
            ],
        };
        var fingerprint = $"{speaker}|{opp}|{b.Outcome}|{knockout}|{b.Hits}|{b.OpponentHits}|{b.Blocks}|{b.BestCombo}|{b.BiggestHit}|{b.Seconds}";
        return new PoBrawlPressLine(speaker, Pick(lines, fingerprint));
    }

    /// <summary>"1 clean shot", "3 clean shots".</summary>
    private static string Count(int n, string one, string many) => n == 1 ? $"1 {one}" : $"{n} {many}";

    /// <summary>"Once", "Twice", "5 times".</summary>
    private static string Times(int n) => n switch { 1 => "Once", 2 => "Twice", _ => $"{n} times" };

    /// <summary>The same fight always picks the same line.</summary>
    private static string Pick(string[] lines, string key) => StableHash.Pick(lines, StableHash.Of(key));
}
