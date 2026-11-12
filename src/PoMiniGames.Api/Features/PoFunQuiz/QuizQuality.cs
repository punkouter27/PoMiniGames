using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace PoMiniGames.Features.PoFunQuiz;

/// <summary>
/// Quality gate and identity for a trivia question, shared by every source: the bundled bank and its tests.
/// </summary>
/// <remarks>
/// <para>
/// <b>Identity.</b> Two questions are the same question when their text matches after
/// <see cref="Normalize"/> — lowercase, punctuation stripped, articles dropped. Exact-text
/// comparison let "What is the capital of France?" and "What's the capital of France" both into one
/// pool, so a ten-question quiz could ask the same thing twice. <see cref="Hash"/> of the normalized
/// text is also the bank's row key, which is what makes inserting a duplicate a no-op.
/// </para>
/// <para>
/// <b>The checks</b> reject the cheap giveaways: fewer or more than four options, two options that
/// are the same answer, the answer printed in the question, and a correct option far longer than the
/// rest (the "most qualified answer is the right one" tell).
/// </para>
/// </remarks>
public static class QuizQuality
{
    /// <summary>The correct option may be at most this many times the others' average length.</summary>
    public const double MaxCorrectLengthRatio = 2.5;

    private static readonly HashSet<string> Articles = new(StringComparer.Ordinal) { "a", "an", "the" };

    /// <summary>Lowercase, accents and punctuation stripped, articles dropped, single-spaced.</summary>
    public static string Normalize(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return string.Empty;

        var sb = new StringBuilder(text.Length);
        foreach (var ch in text.Normalize(NormalizationForm.FormD))
        {
            if (CharUnicodeInfo.GetUnicodeCategory(ch) == UnicodeCategory.NonSpacingMark) continue;
            sb.Append(char.IsLetterOrDigit(ch) ? char.ToLowerInvariant(ch) : ' ');
        }

        var words = sb.ToString()
            .Split(' ', StringSplitOptions.RemoveEmptyEntries)
            .Where(w => !Articles.Contains(w));
        return string.Join(' ', words);
    }

    /// <summary>Stable 32-hex-char id of the normalized text. Safe as a Table Storage row key.</summary>
    public static string Hash(string? text) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(Normalize(text))))[..32];

    /// <summary>Null when the question is fit to serve, otherwise the reason it is not.</summary>
    public static string? Reject(string? text, IReadOnlyList<string>? options, int correctIndex)
    {
        if (string.IsNullOrWhiteSpace(text)) return "empty question";
        if (options is null || options.Count != 4) return "needs exactly four options";
        if (correctIndex < 0 || correctIndex >= options.Count) return "answer index out of range";

        var normalized = new string[options.Count];
        for (var i = 0; i < options.Count; i++)
        {
            normalized[i] = Normalize(options[i]);
            if (normalized[i].Length == 0) return "blank option";
        }
        if (normalized.Distinct(StringComparer.Ordinal).Count() != options.Count) return "options are not distinct";

        // Very short answers ("7", "Au") legitimately recur as words in a question, so only an
        // answer of three characters or more counts as given away.
        var answer = normalized[correctIndex];
        if (answer.Length >= 3 && ContainsPhrase(Normalize(text), answer)) return "answer appears in the question";

        var correctLength = options[correctIndex].Trim().Length;
        var othersAverage = options.Where((_, i) => i != correctIndex).Average(o => o.Trim().Length);
        if (correctLength > MaxCorrectLengthRatio * Math.Max(1.0, othersAverage))
            return "correct option is much longer than the others";

        return null;
    }

    private static bool ContainsPhrase(string haystack, string needle) =>
        $" {haystack} ".Contains($" {needle} ", StringComparison.Ordinal);
}
