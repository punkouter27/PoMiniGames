using System.Globalization;
using PoMiniGames.Shared.Games;

namespace PoMiniGamesClient.Features.PoCabinet;

/// <summary>
/// The officials' radio lines and the "race engineer" debrief, both scripted and both run in the
/// browser: the radio pool is the hand-written <see cref="PoCabinetDialogue"/>, and the debrief
/// turns the race's numbers into tips by thresholds. No model and no server is called.
/// </summary>
public static class PoCabinetTalk
{
    // race.js's moment -> the pool it draws from: an official the player passes, an official
    // taking the lead, the finish.
    private static readonly (string Moment, DialogueKind Kind)[] Moments =
    [
        ("preRace", DialogueKind.PreRace),
        ("passed", DialogueKind.PositionChange),
        ("lead", DialogueKind.LapFinish),
        ("finish", DialogueKind.RaceFinish),
    ];

    /// <summary>Official id → race.js moment → lines, for <c>PoCabinet.setBanter</c>. Built once: the pools are constants.</summary>
    public static Dictionary<string, Dictionary<string, List<string>>> Banter { get; } =
        PoCabinetDialogue.Pools.ToDictionary(
            p => p.Key,
            p => Moments.ToDictionary(m => m.Moment, m => p.Value.GetValueOrDefault(m.Kind)?.ToList() ?? [], StringComparer.Ordinal),
            StringComparer.Ordinal);

    /// <summary>
    /// What the debrief is written from. <see cref="SectorDeltas"/> is seconds against the
    /// personal-best lap per third of the lap (+ = slower), empty without a reference lap;
    /// percentages are 0–100, and <see cref="WorstPointPct"/> is where on the lap the most time
    /// went (-1 = unknown). <see cref="Wrecked"/>: the player's car did not make the flag.
    /// </summary>
    public sealed record Facts(
        string TrackName, int Position, double[] SectorDeltas,
        int FullThrottlePct, int BrakePct, int SlowestKmh, int WorstPointPct, int WallHits, bool Wrecked = false);

    /// <summary>The race engineer's read: a satirical headline and up to three concrete tips.</summary>
    public sealed record Debrief(string Headline, IReadOnlyList<string> Tips);

    public static Debrief DebriefFor(Facts f)
    {
        var inv = CultureInfo.InvariantCulture;
        var tips = new List<string>();
        // A wreck comes first: no lap tip matters more than getting the car home. Most wrecks in
        // a hundred-car field are contact with other cars, which WallHits does not count.
        if (f.Wrecked)
            tips.Add("The car was wrecked: every hit adds up. Leave a car's width in the pack and lift when the cars ahead bunch up.");
        if (f.SectorDeltas is { Length: 3 } sectors)
        {
            var worst = Array.IndexOf(sectors, sectors.Max());
            var best = Array.IndexOf(sectors, sectors.Min());
            if (sectors[worst] > 0.05)
                tips.Add(string.Format(inv, "Sector {0} cost you {1:0.00} s against your best — that's where this lap is.", worst + 1, sectors[worst]));
            if (sectors[best] < -0.05)
                tips.Add(string.Format(inv, "Sector {0} was {1:0.00} s quicker than your best. Keep that line.", best + 1, -sectors[best]));
        }
        else if (f.WorstPointPct >= 0)
        {
            tips.Add(string.Format(inv, "Most time went about {0}% of the way round — look at your braking into that corner.", f.WorstPointPct));
        }
        if (f.WallHits > 0)
            tips.Add(string.Format(inv, "{0} barrier hit{1} cost you speed: a tidier line beats a braver one.", f.WallHits, f.WallHits == 1 ? "" : "s"));
        if (f.FullThrottlePct < 55)
            tips.Add(string.Format(inv, "Flat out only {0}% of the lap — get back on the gas earlier out of the corners.", f.FullThrottlePct));
        if (f.BrakePct > 18)
            tips.Add(string.Format(inv, "On the brakes {0}% of the lap: brake later and harder, then let go.", f.BrakePct));
        if (f.SlowestKmh is > 0 and < 90)
            tips.Add(string.Format(inv, "Your slowest corner dropped to {0} km/h — carry more speed through it.", f.SlowestKmh));
        if (tips.Count == 0) tips.Add("A clean race. Next step: move each braking point a car length later.");

        var headline = f.Wrecked
            ? $"WRECK AT {f.TrackName.ToUpperInvariant()}: CABINET ORDERS AN INQUIRY"
            : f.Position == 1
                ? $"OFFICIALS STUNNED AS CHALLENGER TAKES {f.TrackName.ToUpperInvariant()}"
                : $"P{f.Position} AT {f.TrackName.ToUpperInvariant()}: CABINET DEMANDS A RECOUNT";
        return new Debrief(headline, tips.Take(3).ToList());
    }
}
