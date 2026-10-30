using System.Globalization;
using System.Text;

namespace PoMiniGames.Features.PoCoupleQuiz;

/// <summary>
/// Free, deterministic answer matching for PoCoupleQuiz: how close is a guess to the King's answer,
/// on a 0–1 scale, without calling a model.
/// </summary>
/// <remarks>
/// <para>
/// <b>Pipeline.</b> Both answers are normalized (case, accents, punctuation, articles and
/// possessives dropped, simple plurals folded), common synonyms are mapped onto one spelling
/// ("NYC" / "New York City", "puppy" / "dog", "3" / "three"), and then scored three ways — exact,
/// token-set overlap, and a typo-tolerant string similarity (Levenshtein blended with Jaro-Winkler).
/// The best of the three wins.
/// </para>
/// <para>
/// <b>Short words are strict.</b> One letter turns "cat" into "car" and "horse" into "house", so
/// the string score is damped for short answers. Those land in the ambiguous band
/// (<see cref="AmbiguousLow"/>–<see cref="AmbiguousHigh"/>) rather than scoring as a match — which is
/// exactly the band between a clear miss and a clear match.
/// </para>
/// </remarks>
public static class AnswerMatcher
{
    /// <summary>Free-only mode: a score at or above this counts as a match.</summary>
    public const float MatchThreshold = 0.6f;

    /// <summary>Below this the answers are clearly different.</summary>
    public const float AmbiguousLow = 0.4f;

    /// <summary>At or above this the answers clearly match.</summary>
    public const float AmbiguousHigh = 0.8f;

    /// <summary>True for a close call: neither a clear miss nor a clear match.</summary>
    public static bool IsAmbiguous(float score) => score >= AmbiguousLow && score < AmbiguousHigh;

    private static readonly HashSet<string> StopWords = new(StringComparer.Ordinal)
    {
        "a", "an", "the", "my", "our", "your", "his", "her", "their",
    };

    /// <summary>Each group's first entry is the canonical spelling.</summary>
    private static readonly string[][] SynonymGroups =
    [
        ["couch", "sofa"],
        ["soda", "pop", "soft drink", "fizzy drink"],
        ["movie", "film", "flick"],
        ["tv", "television", "telly"],
        ["car", "automobile"],
        ["phone", "cellphone", "cell phone", "mobile phone", "smartphone"],
        ["fries", "french fries"],
        ["dog", "puppy", "doggy", "pup"],
        ["cat", "kitten", "kitty"],
        ["mom", "mother", "mum", "mommy", "mama"],
        ["dad", "father", "daddy", "papa"],
        ["grandma", "grandmother", "nana", "granny"],
        ["grandpa", "grandfather", "granddad", "grandad"],
        ["usa", "united states", "united states of america", "america"],
        ["uk", "united kingdom", "great britain", "britain"],
        ["nyc", "new york city", "new york"],
        ["la", "los angeles"],
        ["bike", "bicycle"],
        ["burger", "hamburger"],
        ["sneakers", "trainers", "tennis shoes"],
        ["vacation", "holiday"],
        ["ice cream", "gelato"],
        ["pajamas", "pyjamas", "pjs"],
        ["running", "jogging", "run", "jog"],
        ["swimming", "swim"],
        ["hiking", "hike"],
        ["reading", "read", "books"],
        ["cooking", "cook"],
        ["baking", "bake"],
        ["gaming", "video games", "videogames"],
        ["candy", "sweets"],
        ["christmas", "xmas"],
        ["bbq", "barbecue", "barbeque"],
        ["mac and cheese", "mac n cheese", "macaroni and cheese", "macaroni cheese"],
        ["0", "zero"], ["1", "one"], ["2", "two"], ["3", "three"], ["4", "four"], ["5", "five"],
        ["6", "six"], ["7", "seven"], ["8", "eight"], ["9", "nine"], ["10", "ten"],
        ["11", "eleven"], ["12", "twelve"],
    ];

    /// <summary>Multi-word phrases, longest first, mapped to their canonical token.</summary>
    private static readonly (string Phrase, string Token)[] Phrases;

    /// <summary>Single words (after plural folding) mapped to their canonical token.</summary>
    private static readonly Dictionary<string, string> Words = new(StringComparer.Ordinal);

    static AnswerMatcher()
    {
        var phrases = new List<(string, string)>();
        foreach (var group in SynonymGroups)
        {
            var canonical = group[0].Replace(' ', '_');
            foreach (var entry in group)
            {
                if (entry.Contains(' ')) phrases.Add((entry, canonical));
                else Words[Singularize(entry)] = canonical;
            }
            Words[canonical] = canonical;
        }
        Phrases = [.. phrases.OrderByDescending(p => p.Item1.Length)];
    }

    /// <summary>Similarity of two short answers in [0, 1]. 0 when either is blank.</summary>
    public static float Score(string? answer1, string? answer2)
    {
        if (string.IsNullOrWhiteSpace(answer1) || string.IsNullOrWhiteSpace(answer2)) return 0f;

        var a = Canonical(answer1);
        var b = Canonical(answer2);
        if (a.Count == 0 || b.Count == 0)
        {
            // Nothing left after normalizing (an answer of just "the"): fall back to plain equality.
            return string.Equals(answer1.Trim(), answer2.Trim(), StringComparison.OrdinalIgnoreCase) ? 1f : 0f;
        }

        var joinedA = string.Join(' ', a);
        var joinedB = string.Join(' ', b);
        if (joinedA == joinedB) return 1f;

        return (float)Math.Clamp(Math.Max(TokenScore(a, b), StringScore(joinedA, joinedB)), 0, 1);
    }

    /// <summary>Normalized, synonym-mapped, plural-folded tokens.</summary>
    internal static List<string> Canonical(string text)
    {
        var sb = new StringBuilder(text.Length);
        foreach (var ch in text.Replace("&", " and ").Normalize(NormalizationForm.FormD))
        {
            if (CharUnicodeInfo.GetUnicodeCategory(ch) == UnicodeCategory.NonSpacingMark) continue;
            if (ch == '\'' || ch == '’') continue; // "mom's" -> "moms", not "mom s"
            sb.Append(char.IsLetterOrDigit(ch) ? char.ToLowerInvariant(ch) : ' ');
        }

        var normalized = " " + string.Join(' ', sb.ToString().Split(' ', StringSplitOptions.RemoveEmptyEntries)) + " ";
        foreach (var (phrase, token) in Phrases)
        {
            normalized = normalized.Replace(" " + phrase + " ", " " + token + " ", StringComparison.Ordinal);
        }

        var tokens = new List<string>();
        foreach (var raw in normalized.Split(' ', StringSplitOptions.RemoveEmptyEntries))
        {
            if (StopWords.Contains(raw)) continue;
            var single = Singularize(raw);
            tokens.Add(Words.TryGetValue(single, out var canonical) ? canonical : single);
        }
        return tokens;
    }

    /// <summary>
    /// Folds simple English plurals. Not linguistics — only consistency matters, because both
    /// answers go through the same rules.
    /// </summary>
    internal static string Singularize(string word)
    {
        if (word.Length <= 3 || word.Contains('_')) return word;
        if (word.EndsWith("ies", StringComparison.Ordinal) && word.Length > 4) return word[..^3] + "y";
        if (word.EndsWith("sses", StringComparison.Ordinal) || word.EndsWith("xes", StringComparison.Ordinal)
            || word.EndsWith("ches", StringComparison.Ordinal) || word.EndsWith("shes", StringComparison.Ordinal)
            || word.EndsWith("zzes", StringComparison.Ordinal))
            return word[..^2];
        if (word.EndsWith("ss", StringComparison.Ordinal) || word.EndsWith("us", StringComparison.Ordinal)
            || word.EndsWith("is", StringComparison.Ordinal))
            return word;
        return word.EndsWith('s') ? word[..^1] : word;
    }

    /// <summary>
    /// Token-set overlap. One answer wholly contained in the other ("pizza" in "pepperoni pizza")
    /// scores a confident 0.8; otherwise Jaccard. Long tokens may differ by a typo.
    /// </summary>
    private static double TokenScore(List<string> a, List<string> b)
    {
        var setA = a.Distinct(StringComparer.Ordinal).ToList();
        var setB = b.Distinct(StringComparer.Ordinal).ToList();
        var (small, large) = setA.Count <= setB.Count ? (setA, setB) : (setB, setA);

        var matches = small.Count(t => large.Any(u => TokensMatch(t, u)));
        if (matches == 0) return 0;

        var jaccard = (double)matches / (setA.Count + setB.Count - matches);
        return matches == small.Count ? Math.Max(AmbiguousHigh, jaccard) : jaccard;
    }

    private static bool TokensMatch(string x, string y) =>
        x == y || (x.Length >= 7 && y.Length >= 7 && LevenshteinRatio(x, y) >= 0.85);

    /// <summary>Typo tolerance over the whole answer, damped for short answers.</summary>
    private static double StringScore(string a, string b)
    {
        var maxLength = Math.Max(a.Length, b.Length);
        var raw = (0.7 * LevenshteinRatio(a, b)) + (0.3 * JaroWinkler(a, b));
        var damping = maxLength <= 5 ? 0.55 : maxLength <= 7 ? 0.7 : 1.0;
        return raw * damping;
    }

    /// <summary>1 − edit distance / longer length.</summary>
    internal static double LevenshteinRatio(string a, string b)
    {
        if (a.Length == 0 && b.Length == 0) return 1;
        var previous = new int[b.Length + 1];
        var current = new int[b.Length + 1];
        for (var j = 0; j <= b.Length; j++) previous[j] = j;

        for (var i = 1; i <= a.Length; i++)
        {
            current[0] = i;
            for (var j = 1; j <= b.Length; j++)
            {
                var cost = a[i - 1] == b[j - 1] ? 0 : 1;
                current[j] = Math.Min(Math.Min(current[j - 1] + 1, previous[j] + 1), previous[j - 1] + cost);
            }
            (previous, current) = (current, previous);
        }

        return 1.0 - ((double)previous[b.Length] / Math.Max(a.Length, b.Length));
    }

    /// <summary>Jaro-Winkler similarity with the standard 0.1 prefix scale (up to four characters).</summary>
    internal static double JaroWinkler(string a, string b)
    {
        if (a.Length == 0 || b.Length == 0) return a.Length == b.Length ? 1 : 0;

        var window = Math.Max(0, (Math.Max(a.Length, b.Length) / 2) - 1);
        var aMatched = new bool[a.Length];
        var bMatched = new bool[b.Length];
        var matches = 0;

        for (var i = 0; i < a.Length; i++)
        {
            var start = Math.Max(0, i - window);
            var end = Math.Min(b.Length - 1, i + window);
            for (var j = start; j <= end; j++)
            {
                if (bMatched[j] || a[i] != b[j]) continue;
                aMatched[i] = bMatched[j] = true;
                matches++;
                break;
            }
        }
        if (matches == 0) return 0;

        var transpositions = 0;
        var k = 0;
        for (var i = 0; i < a.Length; i++)
        {
            if (!aMatched[i]) continue;
            while (!bMatched[k]) k++;
            if (a[i] != b[k]) transpositions++;
            k++;
        }

        var m = (double)matches;
        var jaro = ((m / a.Length) + (m / b.Length) + ((m - (transpositions / 2.0)) / m)) / 3.0;

        var prefix = 0;
        while (prefix < Math.Min(4, Math.Min(a.Length, b.Length)) && a[prefix] == b[prefix]) prefix++;
        return jaro + (prefix * 0.1 * (1 - jaro));
    }
}
