using PoMiniGames.Domain.Primitives;

namespace PoMiniGames.Shared.Games;

/// <summary>
/// One fighter's dossier card, as <c>GET /api/pobrawl/dossier</c> serves it. The static facts
/// (<see cref="PoBrawlDossiers"/>) are always filled; the server swaps in Wikipedia's summary,
/// portrait and canonical article link when it could reach the free Wikimedia REST API.
/// </summary>
public sealed class PoBrawlDossierDto
{
    /// <summary>Roster id (<see cref="PoBrawlRoster"/>), lowercase.</summary>
    public string FighterId { get; set; } = "";
    /// <summary>The roster display name ("Bush Sr.").</summary>
    public string Name { get; set; } = "";
    /// <summary>The full name ("George H. W. Bush").</summary>
    public string FullName { get; set; } = "";
    /// <summary>"41st President", "45th & 47th President", or BOB's fictional title.</summary>
    public string Office { get; set; } = "";
    /// <summary>Presidential number for ordering (the most recent one for a split term); 0 for BOB.</summary>
    public int Number { get; set; }
    /// <summary>Term years ("1989–1993").</summary>
    public string Term { get; set; } = "";
    public string Party { get; set; } = "";
    /// <summary>The in-game personality in one line (from <c>js/pobrawl/personalities.js</c>).</summary>
    public string FightingStyle { get; set; } = "";
    /// <summary>One or two sentences: Wikipedia's extract, or the static line when it was unreachable.</summary>
    public string Summary { get; set; } = "";
    /// <summary>Wikipedia portrait thumbnail (an https *.wikimedia.org image), or null.</summary>
    public string? ThumbnailUrl { get; set; }
    /// <summary>The Wikipedia article, or null for BOB.</summary>
    public string? ArticleUrl { get; set; }
    /// <summary>True when <see cref="Summary"/> is Wikipedia text, so the card must carry the CC BY-SA attribution.</summary>
    public bool FromWikipedia { get; set; }
    /// <summary>True for BOB: a made-up dossier, no article.</summary>
    public bool IsFictional { get; set; }
}

/// <summary>Static facts for one dossier. <see cref="WikipediaTitle"/> is null for BOB.</summary>
public sealed record PoBrawlDossierFacts(
    string FighterId,
    string FullName,
    string Office,
    int Number,
    string Term,
    string Party,
    string? WikipediaTitle,
    string FightingStyle,
    string Summary)
{
    /// <summary>The Wikipedia article URL for <see cref="WikipediaTitle"/>, or null.</summary>
    public string? ArticleUrl => WikipediaTitle is null ? null : $"https://en.wikipedia.org/wiki/{WikipediaTitle}";

    /// <summary>The dossier with static text only — what every surface shows without Wikipedia.</summary>
    public PoBrawlDossierDto ToDto() => new()
    {
        FighterId = FighterId,
        Name = PoBrawlRoster.NameOf(FighterId) ?? FighterId,
        FullName = FullName,
        Office = Office,
        Number = Number,
        Term = Term,
        Party = Party,
        FightingStyle = FightingStyle,
        Summary = Summary,
        ArticleUrl = ArticleUrl,
        IsFictional = WikipediaTitle is null,
    };
}

/// <summary>
/// The static dossier facts, keyed by <see cref="PoBrawlRoster"/> fighter id: all sixteen
/// presidents in ladder order, then BOB. Shared by the server (which enriches them from
/// Wikipedia) and the client (which falls back to them when the API is unreachable).
/// </summary>
/// <remarks>
/// The fighting-style lines restate <c>wwwroot/js/pobrawl/personalities.js</c> in words. The
/// engine never reads them, so a retuned personality only needs its line here touched when
/// the mechanic itself changes, not its numbers.
/// </remarks>
public static class PoBrawlDossiers
{
    private const string Rep = "Republican";
    private const string Dem = "Democratic";

    public static readonly IReadOnlyList<PoBrawlDossierFacts> All =
    [
        P("trump", "Donald Trump", "45th & 47th President", 47, "2017–2021, 2025–", Rep, "Donald_Trump",
            "The Wall: a volume puncher who stalks forward and never backs off, mixing heavy haymakers into the jabs. Every KO stacks more damage."),
        P("biden", "Joe Biden", "46th President", 46, "2021–2025", Dem, "Joe_Biden",
            "The Big Guy: winds up the longest charge in the roster. Let it land and your feet slow to a shuffle."),
        P("obama", "Barack Obama", "44th President", 44, "2009–2017", Dem, "Barack_Obama",
            "No-Drama counter-puncher: circles the perimeter, slips about a fifth of your shots and answers with a jab-kick string."),
        P("bush", "George W. Bush", "43rd President", 43, "2001–2009", Rep, "George_W._Bush",
            "Decider Mode: push him under 40% and he freezes, then comes back harder and faster for the rest of the round."),
        P("clinton", "Bill Clinton", "42nd President", 42, "1993–2001", Dem, "Bill_Clinton",
            "Sax Solo: slow, swaying wind-ups, but every hit he lands chains into an elbow flurry that grows with your misses."),
        P("bushsr", "George H. W. Bush", "41st President", 41, "1989–1993", Rep, "George_H._W._Bush",
            "Read My Lips: a patient counter-fighter. He baits with a jab, guards, and punishes the swing you should not have thrown."),
        P("reagan", "Ronald Reagan", "40th President", 40, "1981–1989", Rep, "Ronald_Reagan",
            "Morning in America: plants his feet and invites the swing. Once a round his guard throws damage back, and he surges when nearly out."),
        P("carter", "Jimmy Carter", "39th President", 39, "1977–1981", Dem, "Jimmy_Carter",
            "Malaise Speech: metronome footwork and accelerating jab ladders. The first time he drops under 30% he is briefly untouchable."),
        P("ford", "Gerald Ford", "38th President", 38, "1974–1977", Rep, "Gerald_Ford",
            "Ford Stumble: barges in with wild kicks and trips over his own feet. Hit him mid-stumble and he hits back twice as hard."),
        P("nixon", "Richard Nixon", "37th President", 37, "1969–1974", Rep, "Richard_Nixon",
            "Tricky Dick: sidles in sideways and fakes a retreat. A quarter of his shots cut through your guard, and some leave you seeing stars."),
        P("lbj", "Lyndon B. Johnson", "36th President", 36, "1963–1969", Dem, "Lyndon_B._Johnson",
            "The Johnson Treatment: relentless walk-down pressure. Every swing you miss loads his next one with extra knockback."),
        P("jfk", "John F. Kennedy", "35th President", 35, "1961–1963", Dem, "John_F._Kennedy",
            "Camelot Glint: a moment of invulnerability early in the round, a burst of speed when hurt, and every fourth landed swing hits harder."),
        P("eisenhower", "Dwight D. Eisenhower", "34th President", 34, "1953–1961", Rep, "Dwight_D._Eisenhower",
            "Operation Overlord: big telegraphed wind-ups with lightning-quick strikes behind a sturdy guard. Block the coil and he is open."),
        P("truman", "Harry S. Truman", "33rd President", 33, "1945–1953", Dem, "Harry_S._Truman",
            "The Buck Stops Here: walks straight in and gets stronger with every hit he takes. His signature move cashes the whole stack."),
        P("fdr", "Franklin D. Roosevelt", "32nd President", 32, "1933–1945", Dem, "Franklin_D._Roosevelt",
            "Fireside Chat: fast out of the gate, holds the centre and pivots you around it, slipping shots on a steady beat before a late surge."),
        P("hoover", "Herbert Hoover", "31st President", 31, "1929–1933", Rep, "Herbert_Hoover",
            "The Great Engineer: a measured counter-fighter who guards, studies your approach and answers with deliberate combinations."),
        new(PoBrawlRoster.Bob.Id, "Bob from Accounts", "Your fighter", 0, "Mon–Fri, 9 to 5", "Independent", null,
            "No gimmicks: plain punches and kicks, a block and whatever you make of them. The everyman climbing the ladder.",
            "BOB answered a memo about a \"leadership retreat\" and ended up in a ring with fifteen presidents. " +
            "No title, no super PAC: just a lanyard, a jab honed on the office stapler and a lot of unused vacation days."),
    ];

    private static readonly Dictionary<string, PoBrawlDossierFacts> ById =
        All.ToDictionary(f => f.FighterId, StringComparer.OrdinalIgnoreCase);

    /// <summary>The facts for <paramref name="fighterId"/> (any casing), or null.</summary>
    public static PoBrawlDossierFacts? Find(string? fighterId) =>
        fighterId is not null && ById.TryGetValue(fighterId, out var facts) ? facts : null;

    /// <summary>Every dossier with static text only.</summary>
    public static List<PoBrawlDossierDto> StaticDtos() => [.. All.Select(f => f.ToDto())];

    // A president's static summary is built from the facts, so it can never disagree with them.
    private static PoBrawlDossierFacts P(
        string id, string fullName, string office, int number, string term, string party, string title, string style) =>
        new(id, fullName, office, number, term, party, title, style,
            $"{fullName} served as the {office[..office.LastIndexOf(' ')].Replace("&", "and")} president of the United States ({term}{(term.EndsWith('–') ? "present" : "")}), for the {party} Party.");
}
