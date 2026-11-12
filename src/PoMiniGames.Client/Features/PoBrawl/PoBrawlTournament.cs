using PoMiniGames.Domain.Primitives;
using PoMiniGames.Domain.Services;

namespace PoMiniGamesClient.Features.PoBrawl;

/// <summary>
/// One CPU-only, 16-slot, single-elimination Brawl tournament: the random draw, byes, the bouts,
/// who advances where, and every
/// fighter's Elo as the results come in.
/// </summary>
/// <remarks>
/// <para>
/// The Elo arithmetic is the server's own <see cref="PairwiseEloCalculator"/> with its default
/// <see cref="PairwiseEloOptions"/> (seed 1000, K 24, floor 100), so the numbers shown here
/// move the way the global "Brawl Demo" fighter board does when the page reports each bout to
/// <c>POST /api/pobrawl/elo</c>. Starting ratings come from that board when it can be read.
/// The server stays the authority for the board: this copy is what the bracket shows.
/// </para>
/// <para>
/// A bout is never a draw. The engine breaks a level bell in tournament mode
/// (game.js <c>_tournamentDecision</c>), because a knockout bracket cannot advance two fighters.
/// </para>
/// </remarks>
public sealed class PoBrawlTournament
{
    /// <summary>Slots in the bracket, including any BYEs needed to fill the field.</summary>
    public const int Size = 16;
    public const string ByeId = "bye";

    private static readonly PairwiseEloCalculator Elo = new(new PairwiseEloOptions());

    /// <summary>Rating for a fighter the board has never seen.</summary>
    public static int SeedElo => Elo.SeedElo;

    /// <summary>
    /// A winner who went in with an Elo expectation at or under this has pulled off an upset
    /// (about a 35-point underdog or worse). The page names it in the bracket news line.
    /// </summary>
    public const double UpsetBelow = 0.45;

    private readonly Dictionary<string, int> _startElo;
    private readonly Dictionary<string, int> _elo;
    private readonly Dictionary<string, (int Wins, int Losses)> _record = [];

    /// <summary>The actual fighters in the draw; BYE slots are excluded.</summary>
    public IReadOnlyList<PoBrawlFighter> Field { get; }

    /// <summary>All 16 opening-round slots in bracket order, including BYE entries.</summary>
    public IReadOnlyList<string> Entrants { get; }

    /// <summary>All 15 bracket bouts in play order: 8 opening round, 4 quarterfinals, 2 semifinals, final.</summary>
    public IReadOnlyList<Bout> Bouts { get; }

    private PoBrawlTournament(IReadOnlyList<string> entrants, IReadOnlyDictionary<string, int> ratings)
    {
        Entrants = entrants;
        Field = entrants.Where(id => id != ByeId)
            .Select(id => PoBrawlRoster.Find(id)!)
            .ToArray();
        _startElo = Field.ToDictionary(f => f.Id, f => ratings.TryGetValue(f.Id, out var r) ? r : SeedElo);
        _elo = new Dictionary<string, int>(_startElo);
        foreach (var f in Field) _record[f.Id] = (0, 0);

        var bouts = new List<Bout>(Size - 1);
        for (var i = 0; i < Size / 2; i++)
            bouts.Add(new Bout(i, Round.RoundOf16, i, entrants[i * 2], entrants[i * 2 + 1]));
        AddRound(bouts, Round.Quarterfinal, 8, 4);
        AddRound(bouts, Round.Semifinal, 12, 2);
        bouts.Add(new Bout(14, Round.Final, 0, null, null));
        Bouts = bouts;

        foreach (var bout in Bouts.Take(8).Where(b => b.P1Id == ByeId || b.P2Id == ByeId).ToArray())
            AdvanceBye(bout);
    }

    /// <summary>
    /// Draw up to <see cref="Size"/> distinct fighters at random and fill the remaining slots
    /// with randomly placed BYEs. <paramref name="ratings"/> maps fighter id to a starting
    /// rating; anyone missing starts at <see cref="SeedElo"/>.
    /// </summary>
    public static PoBrawlTournament Draw(IReadOnlyList<PoBrawlFighter> roster, Random rng, IReadOnlyDictionary<string, int>? ratings = null)
    {
        ArgumentNullException.ThrowIfNull(roster);
        ArgumentNullException.ThrowIfNull(rng);
        var distinct = roster.DistinctBy(f => f.Id).ToArray();
        rng.Shuffle(distinct);
        if (distinct.Length == 0)
            throw new ArgumentException("A tournament needs at least one fighter.", nameof(roster));
        var entrants = distinct.Take(Size).Select(f => f.Id).ToList();
        while (entrants.Count < Size) entrants.Add(ByeId);
        var shuffledEntrants = entrants.ToArray();
        rng.Shuffle(shuffledEntrants);
        return new PoBrawlTournament(shuffledEntrants, ratings ?? new Dictionary<string, int>());
    }

    /// <summary>The next bout to fight, or null once the final is decided.</summary>
    public Bout? Current => Bouts.FirstOrDefault(b => b.WinnerId is null);

    /// <summary>The champion, once the final is decided.</summary>
    public string? ChampionId => Bouts[^1].WinnerId is { } winner && winner != ByeId ? winner : null;

    public bool IsComplete => ChampionId is not null;

    public int EloOf(string fighterId) => _elo.TryGetValue(fighterId, out var r) ? r : SeedElo;

    public int StartEloOf(string fighterId) => _startElo.TryGetValue(fighterId, out var r) ? r : SeedElo;

    /// <summary>
    /// The left corner's Elo expectation for <paramref name="bout"/> at the current ratings
    /// (<see cref="EloMath.ExpectedScore"/>, the board's own curve); 0.5 while the bout is unpaired.
    /// The engine reads it as the bout's upset potential.
    /// </summary>
    public double ExpectedP1(Bout bout)
    {
        ArgumentNullException.ThrowIfNull(bout);
        return bout.P1Id is null || bout.P2Id is null || bout.P1Id == ByeId || bout.P2Id == ByeId
            ? 0.5
            : EloMath.ExpectedScore(EloOf(bout.P1Id), EloOf(bout.P2Id));
    }

    public (int Wins, int Losses) RecordOf(string fighterId) => _record.TryGetValue(fighterId, out var r) ? r : (0, 0);

    /// <summary>Everyone in the draw, best rating now first: the closing standings.</summary>
    public IReadOnlyList<PoBrawlFighter> Standings =>
        [.. Field.OrderByDescending(f => f.Id == ChampionId)
                 .ThenByDescending(f => RecordOf(f.Id).Wins)
                 .ThenByDescending(f => EloOf(f.Id))];

    /// <summary>
    /// Record the result of <see cref="Current"/>: <paramref name="winnerSide"/> 1 is the bout's
    /// left corner (<see cref="Bout.P1Id"/>), 2 the right. Prices both fighters' Elo, then sends
    /// the winner on to their slot in the next round. Returns the bout it decided.
    /// </summary>
    public Bout RecordResult(int winnerSide, double elapsedSeconds, bool knockout)
    {
        if (winnerSide is not (1 or 2))
            throw new ArgumentOutOfRangeException(nameof(winnerSide), winnerSide, "A tournament bout has a winner: side 1 or 2.");
        var bout = Current ?? throw new InvalidOperationException("The tournament is already decided.");
        if (bout.P1Id is null || bout.P2Id is null || bout.P1Id == ByeId || bout.P2Id == ByeId)
            throw new InvalidOperationException($"Bout {bout.Index} has no pairing yet.");

        bout.P1Expected = ExpectedP1(bout);
        var (winner, loser) = winnerSide == 1 ? (bout.P1Id, bout.P2Id) : (bout.P2Id, bout.P1Id);
        var delta = Elo.Delta(_elo[winner], _elo[loser], isDraw: false);
        var winnerBefore = _elo[winner];
        var loserBefore = _elo[loser];
        _elo[winner] = Elo.ApplyDelta(winnerBefore, delta);
        _elo[loser] = Elo.ApplyDelta(loserBefore, -delta);
        _record[winner] = (_record[winner].Wins + 1, _record[winner].Losses);
        _record[loser] = (_record[loser].Wins, _record[loser].Losses + 1);

        bout.WinnerId = winner;
        bout.ElapsedSeconds = elapsedSeconds;
        bout.Knockout = knockout;
        bout.P1Delta = winnerSide == 1 ? _elo[winner] - winnerBefore : _elo[loser] - loserBefore;
        bout.P2Delta = winnerSide == 2 ? _elo[winner] - winnerBefore : _elo[loser] - loserBefore;

        Advance(bout, winner);
        return bout;
    }

    private static void AddRound(List<Bout> bouts, Round round, int firstIndex, int count)
    {
        for (var i = 0; i < count; i++)
            bouts.Add(new Bout(firstIndex + i, round, i, null, null));
    }

    private void AdvanceBye(Bout bout)
    {
        var winner = bout.P1Id == ByeId ? bout.P2Id! : bout.P1Id!;
        bout.WinnerId = winner;
        Advance(bout, winner);
    }

    private void Advance(Bout bout, string winner)
    {
        if (bout.Round == Round.Final) return;
        var nextStart = bout.Round switch
        {
            Round.RoundOf16 => 8,
            Round.Quarterfinal => 12,
            _ => 14,
        };
        var next = Bouts[nextStart + bout.Slot / 2];
        if (bout.Slot % 2 == 0) next.P1Id = winner;
        else next.P2Id = winner;
        if (next.P1Id is not null && next.P2Id is not null && (next.P1Id == ByeId || next.P2Id == ByeId))
            AdvanceBye(next);
    }

    public enum Round { RoundOf16, Quarterfinal, Semifinal, Final }

    /// <summary>How many bouts a round holds.</summary>
    public static int BoutsIn(Round round) => round switch
    {
        Round.RoundOf16 => 8,
        Round.Quarterfinal => 4,
        Round.Semifinal => 2,
        _ => 1,
    };

    /// <summary>One bout of the bracket. Pairings fill in as the earlier round finishes.</summary>
    /// <param name="Index">0-14, play order.</param>
    /// <param name="Slot">Position inside its round, 0-based.</param>
    public sealed record Bout(int Index, Round Round, int Slot, string? P1Id, string? P2Id)
    {
        public string? P1Id { get; set; } = P1Id;
        public string? P2Id { get; set; } = P2Id;
        public string? WinnerId { get; set; }
        public bool IsBye => P1Id == ByeId || P2Id == ByeId;
        public double ElapsedSeconds { get; set; }
        public bool Knockout { get; set; }
        /// <summary>Elo the left corner gained (+) or lost (−) in this bout.</summary>
        public int P1Delta { get; set; }
        public int P2Delta { get; set; }
        /// <summary>The left corner's Elo expectation going in, stamped when the result is recorded.</summary>
        public double P1Expected { get; set; } = 0.5;

        /// <summary>True once decided for the corner the ratings said would lose (see <see cref="UpsetBelow"/>).</summary>
        public bool IsUpset => WinnerId is not null && !IsBye
            && (WinnerId == P1Id ? P1Expected : 1 - P1Expected) <= UpsetBelow;

        /// <summary>"Round of 16 2 of 8", "Quarterfinal 1 of 4", or "Final".</summary>
        public string Label => Round == Round.Final ? "Final" : $"{GetRoundName(Round)} {Slot + 1} of {BoutsIn(Round)}";

        private static string GetRoundName(Round round) => round switch
        {
            Round.RoundOf16 => "Round of 16",
            Round.Quarterfinal => "Quarterfinal",
            Round.Semifinal => "Semifinal",
            _ => "Final",
        };

        public string? LoserId => WinnerId is null ? null : WinnerId == P1Id ? P2Id : P1Id;
    }
}
